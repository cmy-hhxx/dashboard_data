"""Unified CLI & programmatic writer adapters for AIME pipeline stages -> PG 16 + Multi-Frame Zstd.

Subcommands:
  - ingest-inputs   (Step 1 slim_publish -> eval_inputs + eval_input/<model>/<YYYY>/<MMDD>/part_*.jsonl.zst)
  - export-pending  (Step 2 eval_harness -> claim via FOR UPDATE SKIP LOCKED + export raw JSONL batch)
  - commit-outputs  (Step 2 eval_harness -> eval_outputs + eval_problems + attribution/compact .jsonl.zst)
  - sync-human-read (Step 2.5 bridge from external human_read/ mirror -> delta-only human_read_part_*.jsonl.zst)
  - publish-cluster (Step 3 cluster -> cluster_tree/<model>/v<ver>_<date>/ + current + eval_problems binding)
  - sync-kyc        (user_rules.json + user_kyc/kyc.sqlite3 -> PG users table)
  - reconcile       (reconcile_tails + refresh materialized views)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from psycopg.types.json import Jsonb

from .config import load_config
from .core import DataCore, emit_trace_changes
from .db import connect_direct, get_or_init_db_epoch
from .etl.migrate_cluster import DELIVERABLE_FILES, _flatten_cluster_nodes
from .etl.migrate_users import migrate_users
from .models import clean_str, parse_timestamp, split_cluster_code
from .reconcile import reconcile_tails
from .zst_pack import json_loads_bytes, pread_json

MODEL_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


def cmd_ingest_inputs(args: argparse.Namespace) -> dict[str, Any]:
    cfg = load_config(role="rw", data_root=args.data_root)
    src = Path(args.file)
    inserted = dedup = errors = 0
    with DataCore(cfg, min_pool=1, max_pool=4) as dc:
        with src.open("rb", buffering=4 << 20) as fh:
            for raw in fh:
                if not raw.strip():
                    continue
                try:
                    rec = json_loads_bytes(raw)
                    res = dc.ingest_daily_input(rec, args.model, source=args.source, fallback_day=args.fallback_day)
                    if res.get("deduplicated"):
                        dedup += 1
                    else:
                        inserted += 1
                except Exception:  # noqa: BLE001
                    errors += 1
    return {"cmd": "ingest-inputs", "model": args.model, "inserted": inserted, "deduplicated": dedup, "errors": errors}


def cmd_export_pending(args: argparse.Namespace) -> dict[str, Any]:
    cfg = load_config(role="rw", data_root=args.data_root)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    exported = 0
    with DataCore(cfg, min_pool=1, max_pool=4) as dc:
        claimed = dc.claim_pending_inputs(args.model, args.worker, limit=args.limit, lease_seconds=args.lease_seconds)
        if claimed:
            fids = sorted({int(c["input_file_id"]) for c in claimed if c.get("input_file_id") is not None})
            with dc.db.connection() as conn:
                fmap = {
                    int(r["file_id"]): r["rel_path"]
                    for r in conn.execute("SELECT file_id, rel_path FROM public.pack_files WHERE file_id = ANY(%s)", (fids,)).fetchall()
                }
            with out_path.open("wb") as out_fh:
                for c in claimed:
                    rel = fmap.get(int(c["input_file_id"])) if c.get("input_file_id") is not None else None
                    if not rel or not c.get("input_len"):
                        continue
                    doc = pread_json(cfg.data_root / rel, int(c["input_offset"]), int(c["input_len"]))
                    out_fh.write((json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
                    exported += 1
    return {"cmd": "export-pending", "model": args.model, "worker": args.worker, "claimed": len(claimed), "exported": exported, "out": str(out_path)}


def cmd_commit_outputs(args: argparse.Namespace) -> dict[str, Any]:
    cfg = load_config(role="rw", data_root=args.data_root)
    comp_by_tid: dict[str, dict[str, Any]] = {}
    if args.compact and Path(args.compact).is_file():
        with Path(args.compact).open("rb", buffering=4 << 20) as fh:
            for raw in fh:
                if not raw.strip():
                    continue
                try:
                    c = json_loads_bytes(raw)
                except ValueError:
                    continue
                smeta = c.get("session_meta") if isinstance(c.get("session_meta"), dict) else {}
                tm = c.get("trace_meta")
                tids = []
                if isinstance(tm, list):
                    tids.extend(clean_str(x.get("trace_id")) for x in tm if isinstance(x, dict))
                elif isinstance(tm, dict):
                    tids.append(clean_str(tm.get("trace_id")))
                tids.extend([clean_str(smeta.get("trace_id")), clean_str(c.get("trace_id"))])
                for t in tids:
                    if t:
                        comp_by_tid[t] = c

    committed = errors = 0
    with DataCore(cfg, min_pool=1, max_pool=4) as dc:
        with Path(args.attr).open("rb", buffering=4 << 20) as fh:
            for raw in fh:
                if not raw.strip():
                    continue
                try:
                    attr = json_loads_bytes(raw)
                    t0 = (attr.get("turns") or [{}])[0]
                    tid = clean_str((t0.get("meta") or {}).get("trace_id")) if isinstance(t0, dict) else None
                    comp = comp_by_tid.get(tid) if tid else None
                    oids = dc.commit_daily_output(
                        attr,
                        args.model,
                        compact_record=comp,
                        evaluator_version=args.evaluator_version,
                        judge_model=args.judge_model,
                    )
                    committed += len(oids)
                except Exception:  # noqa: BLE001
                    errors += 1
    return {"cmd": "commit-outputs", "model": args.model, "committed": committed, "errors": errors}


def cmd_sync_human_read(args: argparse.Namespace) -> dict[str, Any]:
    """Incrementally ingest any new ok records from legacy `human_read/.state/state.sqlite3` into PG."""
    cfg = load_config(role="rw", data_root=args.data_root)
    hr_root = Path(args.legacy_dir)
    db_path = hr_root / ".state" / "state.sqlite3"
    if not db_path.is_file():
        return {"cmd": "sync-human-read", "skipped": True, "reason": f"missing {db_path}"}

    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=15.0)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            """
            SELECT rel_path, kind, record_key, source_hash, out_offset, out_bytes, updated_at_ns
            FROM records
            WHERE status = 'ok' AND kind IN ('attribution', 'compact')
              AND out_offset >= 0 AND out_bytes > 0
            ORDER BY updated_at_ns ASC
            """
        ).fetchall()
    finally:
        con.close()

    with DataCore(cfg, min_pool=1, max_pool=4) as dc:
        with dc.db.connection() as conn:
            existing: set[tuple[int, str]] = {
                (int(r["output_id"]), r["target_kind"])
                for r in conn.execute("SELECT output_id, target_kind FROM public.human_read_overlays WHERE status='done'").fetchall()
            }
            out_by_mt: dict[tuple[str, str], int] = {
                (r["model"], r["trace_id"]): int(r["output_id"])
                for r in conn.execute("SELECT output_id, model, trace_id FROM public.eval_outputs WHERE is_latest").fetchall()
            }

        added = skipped = unmatched = errors = 0
        fds: dict[str, int] = {}
        try:
            for r in rows:
                rel = str(r["rel_path"] or "")
                kind = str(r["kind"])
                if not rel.startswith("0_daily_eval/"):
                    skipped += 1
                    continue
                parts = rel.split("/")
                model = parts[1] if len(parts) > 1 and parts[1] in ("aime_expert", "aime_fast") else ""
                if not model:
                    skipped += 1
                    continue
                # Extract trace_id quickly from record_key (`tid:<id1>,<id2>|...`)
                rkey = str(r["record_key"] or "")
                cand_tids: list[str] = []
                if rkey.startswith("tid:"):
                    cand_tids = [t.strip() for t in rkey[4:].split("|", 1)[0].split(",") if t.strip()]
                oid = next((out_by_mt[(model, t)] for t in cand_tids if (model, t) in out_by_mt), None)
                if oid is not None and (oid, kind) in existing:
                    skipped += 1
                    continue
                # Read mirrored record via pread
                target = hr_root / rel
                if not target.is_file():
                    errors += 1
                    continue
                fd = fds.get(rel)
                if fd is None:
                    fd = os.open(str(target), os.O_RDONLY)
                    fds[rel] = fd
                try:
                    raw = os.pread(fd, int(r["out_bytes"]), int(r["out_offset"]))
                    rec = json_loads_bytes(raw)
                except Exception:  # noqa: BLE001
                    errors += 1
                    continue
                if oid is None:
                    for t in rec.get("turns") or []:
                        if isinstance(t, dict) and isinstance(t.get("meta"), dict):
                            tid = clean_str(t["meta"].get("trace_id"))
                            if tid and (model, tid) in out_by_mt:
                                oid = out_by_mt[(model, tid)]
                                break
                if oid is None:
                    unmatched += 1
                    continue
                if (oid, kind) in existing:
                    skipped += 1
                    continue
                if not args.dry_run:
                    dc.commit_human_read_overlay(output_id=oid, hr_record=rec, target_kind=kind)
                existing.add((oid, kind))
                added += 1
        finally:
            for fd in fds.values():
                try:
                    os.close(fd)
                except OSError:
                    pass
    return {"cmd": "sync-human-read", "scanned": len(rows), "added": added, "skipped": skipped, "unmatched": unmatched, "errors": errors, "dry_run": args.dry_run}


def cmd_publish_cluster(args: argparse.Namespace) -> dict[str, Any]:
    """Publish one model's cluster output dir into versioned `cluster_tree/` + PG + `eval_problems`."""
    cfg = load_config(role="rw", data_root=args.data_root)
    src_dir = Path(args.cluster_dir)
    model = str(args.model or "").strip()
    if not MODEL_NAME_RE.match(model):
        raise ValueError(f"Invalid --model={model!r}; expected ^[A-Za-z0-9_.-]+$")
    skip_bind = bool(getattr(args, "skip_bind", False))

    tree_file = src_dir / "cluster_tree.json"
    if not tree_file.is_file():
        raise FileNotFoundError(f"Missing {tree_file}")
    tree_doc = json.loads(tree_file.read_text(encoding="utf-8"))
    meta = tree_doc.get("meta") or {}
    verify_doc = json.loads((src_dir / "verify.json").read_text(encoding="utf-8")) if (src_dir / "verify.json").is_file() else {}
    manifest_doc = json.loads((src_dir / "MANIFEST.json").read_text(encoding="utf-8")) if (src_dir / "MANIFEST.json").is_file() else {}

    pv = manifest_doc.get("pipeline_version")
    version = str(meta.get("pipeline_version") or (pv.get("version") if isinstance(pv, dict) else pv) or "unknown")
    tax_desc = pv.get("taxonomy") if isinstance(pv, dict) else None
    gen_dt = parse_timestamp(meta.get("generated_at")) or datetime.fromtimestamp(tree_file.stat().st_mtime, tz=timezone.utc)
    release_tag = args.release_tag or f"v{version}_{gen_dt.strftime('%Y%m%d')}"
    artifact_rel_dir = f"cluster_tree/{model}/{release_tag}"
    dst_dir = cfg.data_root / artifact_rel_dir
    dst_dir.mkdir(parents=True, exist_ok=True)
    for fn in DELIVERABLE_FILES:
        if (src_dir / fn).is_file():
            shutil.copy2(src_dir / fn, dst_dir / fn)

    cur_link = cfg.data_root / "cluster_tree" / model / "current"
    tmp_link = cfg.data_root / "cluster_tree" / model / f".current.{os.getpid()}"
    if tmp_link.is_symlink() or tmp_link.exists():
        tmp_link.unlink()
    os.symlink(release_tag, tmp_link)
    os.replace(tmp_link, cur_link)

    nodes = _flatten_cluster_nodes(tree_doc)
    bound = 0
    changes_emitted = 0
    with connect_direct(cfg, autocommit=False, app_name="publish_cluster") as conn:
        conn.execute("UPDATE public.cluster_trees SET is_current = FALSE WHERE product=%s AND model=%s AND is_current", (cfg.product, model))
        trow = conn.execute(
            """
            INSERT INTO public.cluster_trees(
                product, model, version, release_tag, taxonomy_desc, is_current, total_items, total_traces,
                total_sessions, leaf_count, verify_errors, verify_mismatch, edge_flagged,
                data_cutoff, artifact_rel_dir, generated_at, extra
            )
            VALUES (%s,%s,%s,%s,%s,TRUE,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (product, model, release_tag) DO UPDATE SET
                version          = EXCLUDED.version,
                taxonomy_desc    = COALESCE(EXCLUDED.taxonomy_desc, public.cluster_trees.taxonomy_desc),
                is_current       = TRUE,
                total_items      = EXCLUDED.total_items,
                total_traces     = EXCLUDED.total_traces,
                total_sessions   = EXCLUDED.total_sessions,
                leaf_count       = EXCLUDED.leaf_count,
                verify_errors    = EXCLUDED.verify_errors,
                verify_mismatch  = EXCLUDED.verify_mismatch,
                edge_flagged     = EXCLUDED.edge_flagged,
                data_cutoff      = EXCLUDED.data_cutoff,
                artifact_rel_dir = EXCLUDED.artifact_rel_dir,
                generated_at     = EXCLUDED.generated_at,
                extra            = EXCLUDED.extra
            RETURNING tree_id
            """,
            (
                cfg.product, model, version, release_tag, tax_desc,
                int(meta.get("total_items") or verify_doc.get("total") or 0),
                int(meta.get("total_traces") or 0), int(meta.get("total_sessions") or 0),
                int(verify_doc.get("leaves") or 0), int(verify_doc.get("errors") or 0),
                int(verify_doc.get("locator_mismatch") or 0), int(meta.get("edge_flagged") or 0),
                clean_str(meta.get("data_cutoff")), artifact_rel_dir, gen_dt,
                Jsonb({"mechanism_rollup": tree_doc.get("mechanism_rollup"), "tag_rollup": tree_doc.get("tag_rollup")}),
            ),
        ).fetchone()
        tree_id = int(trow["tree_id"])
        conn.execute("DELETE FROM public.cluster_nodes WHERE tree_id = %s", (tree_id,))
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO public.cluster_nodes(
                    tree_id, code, parent_code, level, sort_order,
                    name_zh, name_en, plain_desc, definition, include_rule, exclude_rule,
                    legacy_code, mechanism, item_count, trace_count, session_count,
                    share, severity_dist, components, tags
                )
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                [
                    (
                        tree_id, n["code"], n["parent_code"], n["level"], n["sort_order"],
                        n["name_zh"], n["name_en"], n["plain_desc"], n["definition"],
                        n["include_rule"], n["exclude_rule"], n["legacy_code"], n["mechanism"],
                        n["item_count"], n["trace_count"], n["session_count"], n["share"],
                        Jsonb(n["severity_dist"]), n["components"], n["tags"],
                    )
                    for n in nodes
                ],
            )
        idx_path = src_dir / "item_index.jsonl"
        if not skip_bind and idx_path.is_file():
            conn.execute(
                """
                CREATE TEMP TABLE _stage_cl (
                    trace_id TEXT NOT NULL, scope TEXT NOT NULL, turn_index INTEGER NOT NULL,
                    problem_index INTEGER NOT NULL, cluster_code TEXT NOT NULL,
                    l1_stage TEXT, l2_mechanism TEXT, l3_leaf TEXT, l4_subleaf TEXT,
                    is_edge BOOLEAN NOT NULL, tags TEXT[] NOT NULL
                ) ON COMMIT DROP
                """
            )
            seen: dict[tuple[str, str, int, int], tuple[Any, ...]] = {}
            with idx_path.open("rb", buffering=4 << 20) as fh:
                for raw in fh:
                    if not raw.strip():
                        continue
                    try:
                        it = json_loads_bytes(raw)
                    except ValueError:
                        continue
                    code, tid = clean_str(it.get("path")), clean_str(it.get("trace_id"))
                    if not code or not tid:
                        continue
                    scope = clean_str(it.get("scope")) or ("session" if str(it.get("json_path") or "").startswith("session_problem") else "turn")
                    tidx, pidx = int(it.get("turn_index") or 0), int(it.get("problem_index") or 0)
                    l1, l2, l3, l4 = split_cluster_code(code)
                    seen[(tid, scope, tidx, pidx)] = (
                        tid, scope, tidx, pidx, code, l1, l2, l3, l4,
                        bool(it.get("edge")), [str(t) for t in (it.get("tags") or []) if t],
                    )
            with conn.cursor().copy(
                "COPY _stage_cl(trace_id, scope, turn_index, problem_index, cluster_code, l1_stage, l2_mechanism, l3_leaf, l4_subleaf, is_edge, tags) FROM STDIN"
            ) as cp:
                for rec in seen.values():
                    cp.write_row(rec)
            conn.execute("CREATE INDEX ON _stage_cl (trace_id, scope, turn_index, problem_index)")
            rows = conn.execute(
                """
                UPDATE public.eval_problems p
                SET cluster_tree_id = %s,
                    cluster_version = %s,
                    cluster_code = s.cluster_code,
                    l1_stage = s.l1_stage,
                    l2_mechanism = s.l2_mechanism,
                    l3_leaf = s.l3_leaf,
                    l4_subleaf = s.l4_subleaf,
                    is_edge = s.is_edge,
                    tags = s.tags,
                    clustered_at = %s
                FROM _stage_cl s
                JOIN public.eval_outputs o
                    ON o.is_latest = TRUE AND o.model = %s AND o.trace_id = s.trace_id
                WHERE p.output_id = o.output_id
                  AND p.scope = s.scope
                  AND p.turn_index = s.turn_index
                  AND p.problem_index = s.problem_index
                  AND (
                      p.cluster_code IS DISTINCT FROM s.cluster_code
                      OR p.is_edge IS DISTINCT FROM s.is_edge
                      OR p.tags IS DISTINCT FROM s.tags
                  )
                RETURNING p.output_id
                """,
                (tree_id, version, gen_dt, model),
            ).fetchall()
            bound = len(rows)
            if rows:
                db_epoch = get_or_init_db_epoch(conn, cfg.db_epoch)
                output_ids = sorted({int(r["output_id"]) for r in rows})
                changes_emitted = emit_trace_changes(conn, db_epoch, output_ids)
        conn.commit()
    return {
        "cmd": "publish-cluster",
        "model": model,
        "tree_id": tree_id,
        "release_tag": release_tag,
        "nodes": len(nodes),
        "bound": bound,
        "changes_emitted": changes_emitted,
    }


def cmd_sync_kyc(args: argparse.Namespace) -> dict[str, Any]:
    cfg = load_config(role="rw", data_root=args.data_root)
    legacy_root = Path(args.legacy_root) if args.legacy_root else cfg.data_root.parent
    return {"cmd": "sync-kyc", **migrate_users(cfg, legacy_root)}


def cmd_reconcile(args: argparse.Namespace) -> dict[str, Any]:
    cfg = load_config(role="rw", data_root=args.data_root)
    with DataCore(cfg, min_pool=1, max_pool=4) as dc:
        rec = reconcile_tails(dc)
        if not args.no_refresh_views:
            dc.refresh_stats_views(concurrently=True)
    return {"cmd": "reconcile", **rec}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="AIME PG 16 + Multi-Frame Zstd writer CLI")
    ap.add_argument("--data-root", default=None)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("ingest-inputs")
    p1.add_argument("--model", required=True, choices=["aime_expert", "aime_fast"])
    p1.add_argument("--file", required=True)
    p1.add_argument("--source", default="prelaunch")
    p1.add_argument("--fallback-day", default=None)
    p1.set_defaults(func=cmd_ingest_inputs)

    p2 = sub.add_parser("export-pending")
    p2.add_argument("--model", required=True, choices=["aime_expert", "aime_fast"])
    p2.add_argument("--worker", required=True)
    p2.add_argument("--limit", type=int, default=50)
    p2.add_argument("--lease-seconds", type=int, default=900)
    p2.add_argument("--out", required=True)
    p2.set_defaults(func=cmd_export_pending)

    p3 = sub.add_parser("commit-outputs")
    p3.add_argument("--model", required=True, choices=["aime_expert", "aime_fast"])
    p3.add_argument("--attr", required=True)
    p3.add_argument("--compact", default=None)
    p3.add_argument("--evaluator-version", default="v1")
    p3.add_argument("--judge-model", default=None)
    p3.set_defaults(func=cmd_commit_outputs)

    p4 = sub.add_parser("sync-human-read")
    p4.add_argument("--legacy-dir", required=True)
    p4.add_argument("--dry-run", action="store_true")
    p4.set_defaults(func=cmd_sync_human_read)

    p5 = sub.add_parser("publish-cluster")
    p5.add_argument("--model", required=True)
    p5.add_argument("--cluster-dir", required=True)
    p5.add_argument("--release-tag", default=None)
    p5.add_argument("--skip-bind", action="store_true")
    p5.set_defaults(func=cmd_publish_cluster)

    p6 = sub.add_parser("sync-kyc")
    p6.add_argument("--legacy-root", default=None)
    p6.set_defaults(func=cmd_sync_kyc)

    p7 = sub.add_parser("reconcile")
    p7.add_argument("--no-refresh-views", action="store_true")
    p7.set_defaults(func=cmd_reconcile)

    args = ap.parse_args(argv)
    t0 = time.monotonic()
    res = args.func(args)
    res["seconds"] = round(time.monotonic() - t0, 2)
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
