"""ETL Stage 5: Migrate historical AB test rounds (1106 & 1112) into multi-candidate AB schema
and `/mnt/aime_eval_ssd/aime_pg_database/ab_test/<model>/<YYYY>/version_<YYYYMMDD>/candidate_model_N/`.

Mapping (per approved design):
- `agent_before_opt` -> `candidate_idx=1, candidate_key='candidate_model_1', is_baseline=TRUE, source_mode='live'`
- `agent_after_opt`  -> `candidate_idx=2, candidate_key='candidate_model_2', is_baseline=FALSE, source_mode='live'`
- `gpt_answer/`      -> `candidate_idx=3, candidate_key='candidate_model_3', is_baseline=FALSE, source_mode='answer_only'`
- `verify/verify.jsonl` -> stored in `ab_targets.extra.verify` (and preserved read-only in round dir)
"""

from __future__ import annotations

import csv
import json
import re
import shutil
from datetime import date
from pathlib import Path
from typing import Any

from psycopg.types.json import Jsonb

from ..config import DataCoreConfig
from ..db import connect_direct
from ..models import (
    clean_str,
    extract_attribution_fields,
    extract_human_read_delta,
    parse_severity,
    parse_timestamp,
    split_cluster_code,
    to_int_or_none,
)
from ..zst_pack import BulkPackWriter, ab_candidate_rel_path, json_loads_bytes

ROUND_DIR_RE = re.compile(r"^version_(?P<ver>\d{8})_(?P<model>aime_expert|aime_fast)(?:_(?P<tag>.+))?$")
CASE_EQ_RE = re.compile(r"(?:^|_)eq_(\d+)$")
CLUSTER_DELIVERABLES = (
    "cluster_tree.json",
    "cluster_tree.txt",
    "cluster_brief.md",
    "cluster_summary.md",
    "cluster_matrix.png",
    "leaves.tsv",
    "syndrome.md",
    "syndrome.json",
    "verify.json",
    "MANIFEST.json",
)


def _load_item_index_map(
    path: Path,
) -> tuple[dict[tuple[str, str, int, int], tuple[str, bool]], dict[tuple[str, str], tuple[str, bool]]]:
    """Map `(ident, scope, turn_index, problem_index)` and `(ident, label)` -> `(cluster_code, is_edge)`.

    Indexes under ALL available identifiers (`trace_id`, `retest_trace_id`, `session_id`)
    so both `before` and `after` AB candidates achieve 100% cluster binding.
    """
    by_pos: dict[tuple[str, str, int, int], tuple[str, bool]] = {}
    by_lbl: dict[tuple[str, str], tuple[str, bool]] = {}
    if not path.is_file():
        return by_pos, by_lbl
    with path.open("rb", buffering=4 << 20) as fh:
        for raw in fh:
            if not raw.strip():
                continue
            try:
                it = json_loads_bytes(raw)
            except ValueError:
                continue
            code = clean_str(it.get("path"))
            if not code:
                continue
            val = (code, bool(it.get("edge")))
            jp = str(it.get("json_path") or "")
            scope = "session" if jp.startswith("session_problem") else "turn"
            tidx = int(it.get("turn_index") or 0)
            pidx = int(it.get("problem_index") or 0)
            lbl = clean_str(it.get("label"))
            for ident in (
                clean_str(it.get("trace_id")),
                clean_str(it.get("retest_trace_id")),
                clean_str(it.get("session_id")),
            ):
                if not ident:
                    continue
                by_pos[(ident, scope, tidx, pidx)] = val
                if lbl:
                    by_lbl[(ident, lbl)] = val
    return by_pos, by_lbl


def _pack_ab_jsonl(
    conn,
    *,
    src_path: Path,
    data_root: Path,
    rel_path: str,
    kind: str,
    model: str,
    level: int,
    transform=None,
) -> tuple[int, dict[str, tuple[int, int, dict[str, Any]]]]:
    """Pack a legacy AB jsonl file into one multi-frame `.jsonl.zst` and register in `pack_files`.

    Returns `(file_id, by_key)` where `by_key` maps trace_id / eq_index / case_key to `(offset, length, record)`.
    """
    dst_path = data_root / rel_path
    by_key: dict[str, tuple[int, int, dict[str, Any]]] = {}
    with BulkPackWriter(dst_path, rel_path, level=level) as w:
        with src_path.open("rb", buffering=8 << 20) as fh:
            for raw in fh:
                if not raw.strip():
                    continue
                try:
                    rec = json_loads_bytes(raw)
                except ValueError:
                    continue
                out_rec = transform(rec) if transform else rec
                if out_rec is None:
                    continue
                ptr = w.write_record(out_rec)
                # Index by multiple keys for reliable AB matching
                smeta = rec.get("session_meta") if isinstance(rec.get("session_meta"), dict) else {}
                meta = rec.get("meta") if isinstance(rec.get("meta"), dict) else {}
                keys = []
                for k in (
                    rec.get("trace_id"),
                    meta.get("trace_id"),
                    smeta.get("trace_id"),
                    rec.get("case_id"),
                    meta.get("case_id"),
                    smeta.get("case_id"),
                    smeta.get("item_id"),
                ):
                    ks = clean_str(k)
                    if ks:
                        keys.append(ks)
                for t in rec.get("turns") or []:
                    if isinstance(t, dict) and isinstance(t.get("meta"), dict):
                        tid = clean_str(t["meta"].get("trace_id"))
                        if tid:
                            keys.append(tid)
                for tr in rec.get("traces") or []:
                    if isinstance(tr, dict):
                        trm = tr.get("meta") if isinstance(tr.get("meta"), dict) else {}
                        for cand in (tr.get("trace_id"), trm.get("trace_id"), trm.get("case_id"), trm.get("case_key")):
                            cs = clean_str(cand)
                            if cs:
                                keys.append(cs)
                tm = rec.get("trace_meta")
                if isinstance(tm, list):
                    for item in tm:
                        if isinstance(item, dict):
                            tid = clean_str(item.get("trace_id"))
                            if tid:
                                keys.append(tid)
                elif isinstance(tm, dict):
                    tid = clean_str(tm.get("trace_id"))
                    if tid:
                        keys.append(tid)
                for eq in (rec.get("eq_index"), meta.get("eq_index"), smeta.get("eq_index")):
                    if eq is not None:
                        keys.append(f"eq:{eq}")
                for ck in (
                    rec.get("case_key"),
                    meta.get("case_key"),
                    smeta.get("case_key"),
                    rec.get("case_id"),
                    meta.get("case_id"),
                    smeta.get("case_id"),
                ):
                    cks = clean_str(ck)
                    if cks:
                        keys.append(cks)
                        m_eq = CASE_EQ_RE.search(cks)
                        if m_eq:
                            eq_num = int(m_eq.group(1))
                            keys.append(f"eq:{eq_num}")
                            keys.append(f"eq_{eq_num:05d}")
                for k in keys:
                    by_key[k] = (ptr.offset, ptr.length, rec)
        sha = w.close()

    row = conn.execute(
        """
        INSERT INTO public.pack_files(
            rel_path, domain, kind, model, part_no, status,
            committed_bytes, uncompressed_bytes, record_count, sha256
        )
        VALUES (%s, 'ab', %s, %s, 0, 'sealed', %s, %s, %s, %s)
        ON CONFLICT (rel_path) DO UPDATE SET
            committed_bytes = EXCLUDED.committed_bytes,
            uncompressed_bytes = EXCLUDED.uncompressed_bytes,
            record_count = EXCLUDED.record_count,
            sha256 = EXCLUDED.sha256,
            updated_at = now()
        RETURNING file_id
        """,
        (rel_path, kind, model, w.committed_bytes, w.uncompressed_bytes, w.record_count, sha),
    ).fetchone()
    return int(row["file_id"]), by_key


def migrate_ab_rounds(cfg: DataCoreConfig, legacy_root: Path) -> dict[str, Any]:
    ab_src_root = legacy_root / "1_aime" / "ab_test"
    if not ab_src_root.is_dir():
        return {"rounds": []}

    results: list[dict[str, Any]] = []

    with connect_direct(cfg, autocommit=False, app_name="etl_ab") as conn:
        for rdir in sorted(p for p in ab_src_root.iterdir() if p.is_dir()):
            m = ROUND_DIR_RE.match(rdir.name)
            if not m:
                continue
            ver = m.group("ver")
            model = m.group("model")
            tag = m.group("tag")
            yyyy = ver[:4]
            round_folder = f"version_{ver}" + (f"_{tag}" if tag else "")
            round_key = rdir.name

            meta_doc = (
                json.loads((rdir / "index_stats" / "meta.json").read_text(encoding="utf-8"))
                if (rdir / "index_stats" / "meta.json").is_file()
                else {}
            )
            stats_doc = (
                json.loads((rdir / "index_stats" / "stats.json").read_text(encoding="utf-8"))
                if (rdir / "index_stats" / "stats.json").is_file()
                else {}
            )

            released_at = None
            if meta_doc.get("released_at"):
                try:
                    released_at = date.fromisoformat(str(meta_doc["released_at"])[:10])
                except ValueError:
                    pass
            if released_at is None:
                released_at = date(int(ver[:4]), int(ver[4:6]), int(ver[6:8]))

            # Load pairs_index.csv
            pairs_rows: list[dict[str, str]] = []
            pairs_csv = rdir / "index_stats" / "pairs_index.csv"
            if pairs_csv.is_file():
                with pairs_csv.open("r", encoding="utf-8", newline="") as fh:
                    pairs_rows = list(csv.DictReader(fh))

            # Load bench.jsonl for extra target fields (turn_type, session_round, bench_rank, bench_severity)
            bench_by_tid: dict[str, dict[str, Any]] = {}
            bench_jsonl = rdir / "bench" / "bench.jsonl"
            if bench_jsonl.is_file():
                with bench_jsonl.open("rb", buffering=4 << 20) as fh:
                    for raw in fh:
                        if not raw.strip():
                            continue
                        try:
                            br = json_loads_bytes(raw)
                        except ValueError:
                            continue
                        tid = clean_str(br.get("trace_id"))
                        if tid:
                            bench_by_tid[tid] = br

            # Load optional verify/verify.jsonl (1106)
            verify_by_qid: dict[str, dict[str, Any]] = {}
            verify_file = rdir / "verify" / "verify.jsonl"
            if verify_file.is_file():
                with verify_file.open("rb") as fh:
                    for raw in fh:
                        if not raw.strip():
                            continue
                        try:
                            vr = json_loads_bytes(raw)
                        except ValueError:
                            continue
                        qid = clean_str(vr.get("question_id"))
                        if qid:
                            verify_by_qid[qid] = vr
                # Also preserve read-only copy in round directory
                dst_verify = cfg.data_root / "ab_test" / model / yyyy / round_folder / "verify" / "verify.jsonl"
                dst_verify.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(verify_file, dst_verify)

            # Upsert bench snapshot in bench_sets
            bench_key = f"ab:{round_key}"
            brow = conn.execute(
                """
                INSERT INTO public.bench_sets(
                    bench_key, product, model, bench_type, tier_size, version, is_frozen,
                    requested_count, actual_count, stats, built_at
                )
                VALUES (%s,%s,%s,'ab_snapshot',%s,'1.0.0',TRUE,%s,%s,%s,%s)
                ON CONFLICT (bench_key) DO UPDATE SET
                    actual_count = EXCLUDED.actual_count,
                    stats = EXCLUDED.stats,
                    updated_at = now()
                RETURNING bench_id
                """,
                (
                    bench_key,
                    cfg.product,
                    model,
                    to_int_or_none(meta_doc.get("tier")) or len(pairs_rows),
                    to_int_or_none(meta_doc.get("tier")) or len(pairs_rows),
                    len(pairs_rows),
                    Jsonb(stats_doc),
                    parse_timestamp(meta_doc.get("generated_at")),
                ),
            ).fetchone()
            bench_id = int(brow["bench_id"])

            # Clean and re-upsert ab_rounds (cascades candidates/targets/cases/problems cleanly on re-run)
            conn.execute("DELETE FROM public.ab_rounds WHERE round_key = %s", (round_key,))
            rrow = conn.execute(
                """
                INSERT INTO public.ab_rounds(
                    round_key, idempotency_key, product, model, version_tag, released_at, title,
                    bench_id, tier_size, requested_count, actual_count, status, stage,
                    evaluator_version, cluster_version, finished_at, extra
                )
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'succeeded','completed','legacy','4.4',%s,%s)
                RETURNING round_id
                """,
                (
                    round_key,
                    f"legacy:{round_key}",
                    cfg.product,
                    model,
                    ver + (f"_{tag}" if tag else ""),
                    released_at,
                    clean_str(meta_doc.get("title")) or round_key,
                    bench_id,
                    to_int_or_none(meta_doc.get("tier")) or len(pairs_rows),
                    to_int_or_none(meta_doc.get("tier")) or len(pairs_rows),
                    len(pairs_rows),
                    parse_timestamp(meta_doc.get("generated_at")),
                    Jsonb({"legacy_meta": meta_doc, "legacy_stats": stats_doc, "has_verify": bool(verify_by_qid)}),
                ),
            ).fetchone()
            round_id = int(rrow["round_id"])

            # Resolve source_input_id map for targets
            src_tids = [r.get("trace_id", "").strip() for r in pairs_rows if r.get("trace_id")]
            input_id_map: dict[str, int] = {}
            if src_tids:
                for ir in conn.execute(
                    "SELECT trace_id, input_id FROM public.eval_inputs WHERE product=%s AND model=%s AND trace_id = ANY(%s)",
                    (cfg.product, model, src_tids),
                ).fetchall():
                    input_id_map[ir["trace_id"]] = int(ir["input_id"])

            # Insert ab_targets & bench_items
            conn.execute("DELETE FROM public.bench_items WHERE bench_id = %s", (bench_id,))
            target_by_eq: dict[int, tuple[int, dict[str, str]]] = {}
            for pr in pairs_rows:
                eq = int(pr["eq_index"])
                case_key = pr.get("case_key") or f"eq_{eq:05d}"
                src_tid = clean_str(pr.get("trace_id"))
                br = bench_by_tid.get(src_tid or "", {})
                bmeta = br.get("bench") if isinstance(br.get("bench"), dict) else {}
                extra_t: dict[str, Any] = {}
                if pr.get("question_time"):
                    extra_t["question_time"] = pr["question_time"]
                if pr.get("session_id"):
                    extra_t["source_session_id"] = pr["session_id"]
                if pr.get("eval_category"):
                    extra_t["eval_category"] = pr["eval_category"]
                if src_tid and src_tid in verify_by_qid:
                    extra_t["verify"] = verify_by_qid[src_tid]
                elif case_key in verify_by_qid:
                    extra_t["verify"] = verify_by_qid[case_key]

                trow = conn.execute(
                    """
                    INSERT INTO public.ab_targets(
                        round_id, eq_index, case_key, source_input_id, source_trace_id,
                        question_text, turn_type, session_round, task_category, subtask_category,
                        bench_rank, bench_severity, extra
                    )
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    RETURNING target_id
                    """,
                    (
                        round_id,
                        eq,
                        case_key,
                        input_id_map.get(src_tid) if src_tid else None,
                        src_tid,
                        clean_str(pr.get("question") or br.get("question")),
                        clean_str(br.get("turn")),
                        to_int_or_none(br.get("session_round")),
                        clean_str(pr.get("task")),
                        clean_str(pr.get("subtask")),
                        to_int_or_none(bmeta.get("rank")) or eq,
                        clean_str(br.get("severity")),
                        Jsonb(extra_t),
                    ),
                ).fetchone()
                target_by_eq[eq] = (int(trow["target_id"]), pr)

                if src_tid:
                    conn.execute(
                        """
                        INSERT INTO public.bench_items(
                            bench_id, input_id, trace_id, session_id, rank, turn_type,
                            session_round, severity, question_text
                        )
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                        ON CONFLICT (bench_id, trace_id) DO NOTHING
                        """,
                        (
                            bench_id,
                            input_id_map.get(src_tid),
                            src_tid,
                            clean_str(pr.get("session_id")),
                            eq,
                            clean_str(br.get("turn")),
                            to_int_or_none(br.get("session_round")),
                            clean_str(br.get("severity")),
                            clean_str(pr.get("question")),
                        ),
                    )

            # Define candidates: 1=before, 2=after, optional 3=gpt_answer
            cand_specs = [
                {
                    "idx": 1,
                    "key": "candidate_model_1",
                    "legacy_side": "before",
                    "dir": rdir / "agent_before_opt",
                    "input_file": rdir / "agent_before_opt" / "res_before_opt.jsonl",
                    "desc": str(meta_doc.get("before_label") or "优化前") + f" ({round_key} baseline)",
                    "is_baseline": True,
                    "source_mode": "live",
                },
                {
                    "idx": 2,
                    "key": "candidate_model_2",
                    "legacy_side": "after",
                    "dir": rdir / "agent_after_opt",
                    "input_file": rdir / "agent_after_opt" / "res_after_opt.jsonl",
                    "desc": str(meta_doc.get("after_label") or "优化后") + f" ({round_key} candidate)",
                    "is_baseline": False,
                    "source_mode": "live",
                },
            ]

            cand_summary = []
            for spec in cand_specs:
                cdir: Path = spec["dir"]
                ckey = spec["key"]
                side = spec["legacy_side"]
                if not cdir.is_dir():
                    continue

                # Copy cluster deliverables
                cluster_src = cdir / "cluster"
                cluster_rel = None
                item_pos_map: dict[tuple[str, str, int, int], tuple[str, bool]] = {}
                item_lbl_map: dict[tuple[str, str], tuple[str, bool]] = {}
                if cluster_src.is_dir():
                    cluster_rel = f"ab_test/{model}/{yyyy}/{round_folder}/{ckey}/cluster"
                    dst_cl = cfg.data_root / cluster_rel
                    dst_cl.mkdir(parents=True, exist_ok=True)
                    for fn in CLUSTER_DELIVERABLES:
                        if (cluster_src / fn).is_file():
                            shutil.copy2(cluster_src / fn, dst_cl / fn)
                    item_pos_map, item_lbl_map = _load_item_index_map(cluster_src / "item_index.jsonl")

                crow = conn.execute(
                    """
                    INSERT INTO public.ab_candidates(
                        round_id, candidate_idx, candidate_key, description,
                        is_baseline, source_mode, cluster_rel_dir, extra
                    )
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                    RETURNING candidate_id
                    """,
                    (
                        round_id,
                        spec["idx"],
                        ckey,
                        spec["desc"],
                        spec["is_baseline"],
                        spec["source_mode"],
                        cluster_rel,
                        Jsonb({"legacy_side": side}),
                    ),
                ).fetchone()
                cand_id = int(crow["candidate_id"])

                # Pack input / attribution / compact / optional human_read
                in_fid, in_map = (None, {})
                if spec["input_file"].is_file():
                    in_fid, in_map = _pack_ab_jsonl(
                        conn,
                        src_path=spec["input_file"],
                        data_root=cfg.data_root,
                        rel_path=ab_candidate_rel_path(model, yyyy, round_folder, ckey, "input"),
                        kind="input",
                        model=model,
                        level=cfg.zstd_level,
                    )

                attr_file = cdir / "eval_output" / "attribution.jsonl"
                attr_fid, attr_map = (None, {})
                if attr_file.is_file():
                    attr_fid, attr_map = _pack_ab_jsonl(
                        conn,
                        src_path=attr_file,
                        data_root=cfg.data_root,
                        rel_path=ab_candidate_rel_path(model, yyyy, round_folder, ckey, "attribution"),
                        kind="attribution",
                        model=model,
                        level=cfg.zstd_level,
                    )

                comp_file = cdir / "eval_output" / "compact.jsonl"
                comp_fid, comp_map = (None, {})
                if comp_file.is_file():
                    comp_fid, comp_map = _pack_ab_jsonl(
                        conn,
                        src_path=comp_file,
                        data_root=cfg.data_root,
                        rel_path=ab_candidate_rel_path(model, yyyy, round_folder, ckey, "compact"),
                        kind="compact",
                        model=model,
                        level=cfg.zstd_level,
                    )

                hr_file = cdir / "eval_output" / "attribution_human_read.jsonl"
                hr_fid, hr_map = (None, {})
                if hr_file.is_file():
                    hr_fid, hr_map = _pack_ab_jsonl(
                        conn,
                        src_path=hr_file,
                        data_root=cfg.data_root,
                        rel_path=ab_candidate_rel_path(model, yyyy, round_folder, ckey, "human_read"),
                        kind="human_read",
                        model=model,
                        level=cfg.zstd_level,
                        transform=lambda r: extract_human_read_delta(
                            r, "attribution", trace_id=clean_str((r.get("session_meta") or {}).get("trace_id")) or "", model=model, biz_day=released_at.isoformat()
                        )[0],
                    )

                cases_cnt = 0
                probs_cnt = 0
                for eq, (target_id, pr) in sorted(target_by_eq.items()):
                    case_key = pr.get("case_key") or f"eq_{eq:05d}"
                    c_status = clean_str(pr.get(f"{side}_status")) or "missing"
                    c_bucket = clean_str(pr.get(f"{side}_b_reason"))
                    c_tid = clean_str(pr.get(f"{side}_trace_id"))
                    c_sid = clean_str(pr.get(f"{side}_session_id")) or (clean_str(pr.get("session_id")) if side == "before" else None)

                    lookup_keys = [k for k in (c_tid, case_key, f"eq:{eq}", clean_str(pr.get("trace_id"))) if k]
                    in_hit = next((in_map[k] for k in lookup_keys if k in in_map), None)
                    attr_hit = next((attr_map[k] for k in lookup_keys if k in attr_map), None)
                    comp_hit = next((comp_map[k] for k in lookup_keys if k in comp_map), None)
                    hr_hit = next((hr_map[k] for k in lookup_keys if k in hr_map), None)

                    # Extract structured metrics from attribution record if present
                    parsed_attr = None
                    if attr_hit is not None:
                        alist = extract_attribution_fields(attr_hit[2], model, fallback_day=released_at.isoformat())
                        if alist:
                            parsed_attr = next((a for a in alist if c_tid and a["trace_id"] == c_tid), alist[0])

                    if parsed_attr is not None:
                        is_gold = parsed_attr["is_gold"]
                        prob_count = parsed_attr["problem_count"]
                        max_sev = parsed_attr["max_severity"]
                        p0, p1, p2, p3, p4 = (
                            parsed_attr["p0_cnt"],
                            parsed_attr["p1_cnt"],
                            parsed_attr["p2_cnt"],
                            parsed_attr["p3_cnt"],
                            parsed_attr["p4_cnt"],
                        )
                        is_correct = parsed_attr["is_correct"]
                        req_dt = parsed_attr["request_time"]
                        c_tid = c_tid or parsed_attr["trace_id"]
                        c_sid = c_sid or parsed_attr["session_id"]
                    else:
                        csv_sev = clean_str(pr.get(f"{side}_severity"))
                        max_sev = csv_sev if csv_sev in ("GOLD", "P0", "P1", "P2", "P3", "P4") else None
                        prob_count = to_int_or_none(pr.get(f"{side}_n_problem")) or 0
                        is_gold = max_sev == "GOLD" or (c_status == "evaluated" and prob_count == 0)
                        p0 = p1 = p2 = p3 = p4 = 0
                        is_correct = None
                        req_dt = None

                    # Tokens / tools from input record if present
                    tot_tok = tool_cnt = None
                    if in_hit is not None:
                        imeta = in_hit[2].get("meta") if isinstance(in_hit[2].get("meta"), dict) else {}
                        tot_tok = to_int_or_none(imeta.get("total_tokens"))
                        tool_cnt = to_int_or_none(imeta.get("tool_count"))

                    c_row = conn.execute(
                        """
                        INSERT INTO public.ab_candidate_cases(
                            round_id, candidate_id, target_id, eq_index, status, eval_bucket,
                            linked_input_id, trace_id, session_id, request_time,
                            input_file_id, input_offset, input_len,
                            attr_file_id, attr_offset, attr_len,
                            compact_file_id, compact_offset, compact_len,
                            hr_file_id, hr_offset, hr_len,
                            is_gold, problem_count, max_severity,
                            p0_cnt, p1_cnt, p2_cnt, p3_cnt, p4_cnt,
                            is_correct, total_tokens, tool_count, change_seq
                        )
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                        RETURNING case_id
                        """,
                        (
                            round_id,
                            cand_id,
                            target_id,
                            eq,
                            c_status,
                            c_bucket,
                            input_id_map.get(c_tid) if (side == "before" and c_tid) else None,
                            c_tid,
                            c_sid,
                            req_dt,
                            in_fid if in_hit else None,
                            in_hit[0] if in_hit else None,
                            in_hit[1] if in_hit else None,
                            attr_fid if attr_hit else None,
                            attr_hit[0] if attr_hit else None,
                            attr_hit[1] if attr_hit else None,
                            comp_fid if comp_hit else None,
                            comp_hit[0] if comp_hit else None,
                            comp_hit[1] if comp_hit else None,
                            hr_fid if hr_hit else None,
                            hr_hit[0] if hr_hit else None,
                            hr_hit[1] if hr_hit else None,
                            is_gold,
                            prob_count,
                            max_sev,
                            p0,
                            p1,
                            p2,
                            p3,
                            p4,
                            is_correct,
                            tot_tok,
                            tool_cnt,
                            eq,
                        ),
                    ).fetchone()
                    case_id = int(c_row["case_id"])
                    cases_cnt += 1

                    # Insert ab_candidate_problems
                    if parsed_attr is not None:
                        src_tid_p = clean_str(pr.get("trace_id"))
                        src_sid_p = clean_str(pr.get("session_id"))
                        csv_paths = [x.strip() for x in (pr.get(f"{side}_cls_paths") or "").split(";") if x.strip()]
                        cand_idents = [x for x in (c_tid, src_tid_p, c_sid, src_sid_p) if x]
                        for p_ord, prob in enumerate(parsed_attr["problems"]):
                            hit_cl = None
                            for ident in cand_idents:
                                hit_cl = item_pos_map.get((ident, prob["scope"], prob["turn_index"], prob["problem_index"]))
                                if hit_cl:
                                    break
                            if not hit_cl and prob.get("label"):
                                for ident in cand_idents:
                                    hit_cl = item_lbl_map.get((ident, prob["label"]))
                                    if hit_cl:
                                        break
                            if not hit_cl and p_ord < len(csv_paths):
                                hit_cl = (csv_paths[p_ord], False)
                            cl_code, is_edge = hit_cl or (None, False)
                            l1, l2, l3, l4 = split_cluster_code(cl_code)
                            conn.execute(
                                """
                                INSERT INTO public.ab_candidate_problems(
                                    round_id, case_id, candidate_id, eq_index, scope,
                                    turn_index, problem_index, severity, component, label,
                                    cluster_code, l1_stage, l2_mechanism, l3_leaf, l4_subleaf, is_edge
                                )
                                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                                """,
                                (
                                    round_id,
                                    case_id,
                                    cand_id,
                                    eq,
                                    prob["scope"],
                                    prob["turn_index"],
                                    prob["problem_index"],
                                    prob["severity"],
                                    prob["component_family"] or prob["component"],
                                    prob["label"],
                                    cl_code,
                                    l1,
                                    l2,
                                    l3,
                                    l4,
                                    is_edge,
                                ),
                            )
                            probs_cnt += 1

                cand_summary.append({"candidate_key": ckey, "cases": cases_cnt, "problems": probs_cnt})

            # Optional candidate 3: gpt_answer (answer_only, e.g. 1106)
            gpt_raw_dir = rdir / "gpt_answer" / "raw"
            if gpt_raw_dir.is_dir():
                gpt_files = sorted(gpt_raw_dir.glob("*.json"))
                if gpt_files:
                    ckey = "candidate_model_3"
                    rel_ans = ab_candidate_rel_path(model, yyyy, round_folder, ckey, "answer_only")
                    ans_by_tid: dict[str, tuple[int, int]] = {}
                    gpt_model_name = ""
                    gpt_effort = ""
                    with BulkPackWriter(cfg.data_root / rel_ans, rel_ans, level=cfg.zstd_level) as w:
                        for fp in gpt_files:
                            try:
                                doc = json.loads(fp.read_text(encoding="utf-8"))
                            except (OSError, ValueError):
                                continue
                            if not gpt_model_name and isinstance(doc, dict):
                                gpt_model_name = str(doc.get("model") or "")
                                gpt_effort = str(doc.get("effort") or "")
                            tid = fp.stem
                            ptr = w.write_record({"trace_id": tid, "answer": doc})
                            ans_by_tid[tid] = (ptr.offset, ptr.length)
                        sha = w.close()

                    crow = conn.execute(
                        """
                        INSERT INTO public.ab_candidates(
                            round_id, candidate_idx, candidate_key, description,
                            is_baseline, source_mode, extra
                        )
                        VALUES (%s, 3, %s, %s, FALSE, 'answer_only', %s)
                        RETURNING candidate_id
                        """,
                        (
                            round_id,
                            ckey,
                            f"GPT Reference Answers ({round_key})",
                            Jsonb(
                                {
                                    "legacy_dir": "gpt_answer",
                                    "gpt_model": gpt_model_name or "GPT",
                                    "gpt_effort": gpt_effort,
                                    "gpt_total": len(gpt_files),
                                    "gpt_answered": len(ans_by_tid),
                                }
                            ),
                        ),
                    ).fetchone()
                    cand_id = int(crow["candidate_id"])

                    pf = conn.execute(
                        """
                        INSERT INTO public.pack_files(
                            rel_path, domain, kind, model, part_no, status,
                            committed_bytes, uncompressed_bytes, record_count, sha256
                        )
                        VALUES (%s, 'ab', 'answer_only', %s, 0, 'sealed', %s, %s, %s, %s)
                        ON CONFLICT (rel_path) DO UPDATE SET
                            committed_bytes = EXCLUDED.committed_bytes,
                            record_count = EXCLUDED.record_count,
                            updated_at = now()
                        RETURNING file_id
                        """,
                        (rel_ans, model, w.committed_bytes, w.uncompressed_bytes, w.record_count, sha),
                    ).fetchone()
                    ans_fid = int(pf["file_id"])

                    gpt_cases = 0
                    for eq, (target_id, pr) in sorted(target_by_eq.items()):
                        src_tid = clean_str(pr.get("trace_id"))
                        if src_tid and src_tid in ans_by_tid:
                            off, ln = ans_by_tid[src_tid]
                            conn.execute(
                                """
                                INSERT INTO public.ab_candidate_cases(
                                    round_id, candidate_id, target_id, eq_index, status,
                                    trace_id, input_file_id, input_offset, input_len, change_seq
                                )
                                VALUES (%s,%s,%s,%s,'answer_only',%s,%s,%s,%s,%s)
                                """,
                                (round_id, cand_id, target_id, eq, src_tid, ans_fid, off, ln, eq),
                            )
                            gpt_cases += 1
                    cand_summary.append({"candidate_key": ckey, "cases": gpt_cases, "problems": 0})

            conn.commit()
            results.append(
                {
                    "round_key": round_key,
                    "round_id": round_id,
                    "targets": len(target_by_eq),
                    "candidates": cand_summary,
                }
            )

    return {"rounds": results}
