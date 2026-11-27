"""ETL Stage 3: Copy versioned cluster_tree deliverables, populate cluster_trees/cluster_nodes,
and bind all 693k+ `item_index.jsonl` entries to `eval_problems`.
"""

from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from psycopg.types.json import Jsonb

from ..config import DataCoreConfig
from ..db import connect_direct
from ..models import clean_str, parse_timestamp, split_cluster_code
from ..zst_pack import json_loads_bytes

# Deliverable files copied into cluster_tree/<model>/v<ver>_<date>/
# (item_index.jsonl is 1+ GB of redundant flat index now stored natively in PG eval_problems!)
DELIVERABLE_FILES = (
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


def _flatten_cluster_nodes(tree_doc: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    root = tree_doc.get("tree") or {}

    def walk(node: dict[str, Any], parent_code: str | None, order: int) -> None:
        code = str(node.get("id") or "")
        if not code:
            return
        level = int(node.get("level", 0))
        if level >= 1:
            rows.append(
                {
                    "code": code,
                    "parent_code": parent_code,
                    "level": level,
                    "sort_order": order,
                    "name_zh": str(node.get("name") or code),
                    "name_en": clean_str(node.get("name_en")),
                    "plain_desc": clean_str(node.get("plain")),
                    "definition": clean_str(node.get("definition")),
                    "include_rule": clean_str(node.get("include")),
                    "exclude_rule": clean_str(node.get("exclude")),
                    "legacy_code": clean_str(node.get("legacy_code")),
                    "mechanism": clean_str(node.get("mechanism")),
                    "item_count": int(node.get("count") or 0),
                    "trace_count": int(node.get("traces") or 0),
                    "session_count": int(node.get("sessions") or 0),
                    "share": float(node["share"]) if node.get("share") is not None else None,
                    "severity_dist": node.get("severity") if isinstance(node.get("severity"), dict) else {},
                    "components": [str(c) for c in (node.get("components") or []) if c],
                    "tags": [str(t) for t in (node.get("tags") or []) if t],
                }
            )
        next_parent = code if level >= 1 else None
        for idx, child in enumerate(node.get("children") or []):
            if isinstance(child, dict):
                walk(child, next_parent, idx)

    walk(root, None, 0)
    return rows


def migrate_cluster_trees(cfg: DataCoreConfig, legacy_root: Path) -> dict[str, Any]:
    """Copy versioned cluster artifacts, insert cluster_trees/cluster_nodes, bind eval_problems."""
    cluster_src_root = legacy_root / "1_aime" / "eval_output" / "cluster"
    summary: dict[str, Any] = {"models": {}}

    for model in ("aime_expert", "aime_fast"):
        src_dir = cluster_src_root / model
        tree_file = src_dir / "cluster_tree.json"
        if not tree_file.is_file():
            continue

        tree_doc = json.loads(tree_file.read_text(encoding="utf-8"))
        meta = tree_doc.get("meta") or {}
        verify_doc = (
            json.loads((src_dir / "verify.json").read_text(encoding="utf-8"))
            if (src_dir / "verify.json").is_file()
            else {}
        )
        manifest_doc = (
            json.loads((src_dir / "MANIFEST.json").read_text(encoding="utf-8"))
            if (src_dir / "MANIFEST.json").is_file()
            else {}
        )

        pv = manifest_doc.get("pipeline_version")
        version = str(
            meta.get("pipeline_version")
            or (pv.get("version") if isinstance(pv, dict) else pv)
            or "unknown"
        )
        gen_dt = parse_timestamp(meta.get("generated_at")) or datetime.fromtimestamp(
            tree_file.stat().st_mtime, tz=timezone.utc
        )
        date_tag = gen_dt.strftime("%Y%m%d")
        release_tag = f"v{version}_{date_tag}"
        artifact_rel_dir = f"cluster_tree/{model}/{release_tag}"
        dst_dir = cfg.data_root / artifact_rel_dir
        dst_dir.mkdir(parents=True, exist_ok=True)

        for fname in DELIVERABLE_FILES:
            fp = src_dir / fname
            if fp.is_file():
                shutil.copy2(fp, dst_dir / fname)

        # Update `current -> v<ver>_<date>/` symlink atomically
        cur_link = cfg.data_root / "cluster_tree" / model / "current"
        tmp_link = cfg.data_root / "cluster_tree" / model / f".current.{os.getpid()}"
        if tmp_link.is_symlink() or tmp_link.exists():
            tmp_link.unlink()
        os.symlink(release_tag, tmp_link)
        os.replace(tmp_link, cur_link)

        nodes = _flatten_cluster_nodes(tree_doc)
        tax_desc = pv.get("taxonomy") if isinstance(pv, dict) else None

        with connect_direct(cfg, autocommit=False, app_name=f"etl_cluster_{model}") as conn:
            # Flip prior current tree if any
            conn.execute(
                "UPDATE public.cluster_trees SET is_current = FALSE WHERE product = %s AND model = %s AND is_current",
                (cfg.product, model),
            )
            trow = conn.execute(
                """
                INSERT INTO public.cluster_trees(
                    product, model, version, release_tag, taxonomy_desc, is_current,
                    total_items, total_traces, total_sessions, leaf_count,
                    verify_errors, verify_mismatch, edge_flagged, data_cutoff,
                    artifact_rel_dir, generated_at, extra
                )
                VALUES (%s,%s,%s,%s,%s,TRUE,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (product, model, release_tag) DO UPDATE SET
                    is_current = TRUE,
                    total_items = EXCLUDED.total_items,
                    total_traces = EXCLUDED.total_traces,
                    total_sessions = EXCLUDED.total_sessions,
                    leaf_count = EXCLUDED.leaf_count,
                    verify_errors = EXCLUDED.verify_errors,
                    verify_mismatch = EXCLUDED.verify_mismatch,
                    edge_flagged = EXCLUDED.edge_flagged,
                    artifact_rel_dir = EXCLUDED.artifact_rel_dir,
                    generated_at = EXCLUDED.generated_at,
                    extra = EXCLUDED.extra
                RETURNING tree_id
                """,
                (
                    cfg.product,
                    model,
                    version,
                    release_tag,
                    tax_desc,
                    int(meta.get("total_items") or verify_doc.get("total") or 0),
                    int(meta.get("total_traces") or 0),
                    int(meta.get("total_sessions") or 0),
                    int(verify_doc.get("leaves") or 0),
                    int(verify_doc.get("errors") or 0),
                    int(verify_doc.get("locator_mismatch") or 0),
                    int(meta.get("edge_flagged") or 0),
                    clean_str(meta.get("data_cutoff")),
                    artifact_rel_dir,
                    gen_dt,
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
                            tree_id,
                            n["code"],
                            n["parent_code"],
                            n["level"],
                            n["sort_order"],
                            n["name_zh"],
                            n["name_en"],
                            n["plain_desc"],
                            n["definition"],
                            n["include_rule"],
                            n["exclude_rule"],
                            n["legacy_code"],
                            n["mechanism"],
                            n["item_count"],
                            n["trace_count"],
                            n["session_count"],
                            n["share"],
                            Jsonb(n["severity_dist"]),
                            n["components"],
                            n["tags"],
                        )
                        for n in nodes
                    ],
                )
            conn.commit()

            # Bulk bind item_index.jsonl into eval_problems via TEMP staging table + COPY!
            item_index_path = src_dir / "item_index.jsonl"
            bound_pos = 0
            bound_lbl = 0
            total_idx = 0
            if item_index_path.is_file():
                conn.execute(
                    """
                    CREATE TEMP TABLE _stage_cluster (
                        trace_id TEXT NOT NULL,
                        scope TEXT NOT NULL,
                        turn_index INTEGER NOT NULL,
                        problem_index INTEGER NOT NULL,
                        label TEXT,
                        cluster_code TEXT NOT NULL,
                        l1_stage TEXT,
                        l2_mechanism TEXT,
                        l3_leaf TEXT,
                        l4_subleaf TEXT,
                        is_edge BOOLEAN NOT NULL,
                        tags TEXT[] NOT NULL
                    ) ON COMMIT DROP
                    """
                )
                # Deduplicate by (trace_id, scope, turn_index, problem_index) keeping last entry
                seen_pos: dict[tuple[str, str, int, int], tuple[Any, ...]] = {}
                with item_index_path.open("rb", buffering=8 << 20) as fh:
                    for raw in fh:
                        if not raw.strip():
                            continue
                        try:
                            it = json_loads_bytes(raw)
                        except ValueError:
                            continue
                        code = clean_str(it.get("path"))
                        tid = clean_str(it.get("trace_id"))
                        if not code or not tid:
                            continue
                        jp = str(it.get("json_path") or "")
                        scope = "session" if jp.startswith("session_problem") else "turn"
                        tidx = int(it.get("turn_index") or 0)
                        pidx = int(it.get("problem_index") or 0)
                        lbl = clean_str(it.get("label"))
                        l1, l2, l3, l4 = split_cluster_code(code)
                        is_edge = bool(it.get("edge"))
                        tags = [str(t) for t in (it.get("tags") or []) if t]
                        seen_pos[(tid, scope, tidx, pidx)] = (
                            tid,
                            scope,
                            tidx,
                            pidx,
                            lbl,
                            code,
                            l1,
                            l2,
                            l3,
                            l4,
                            is_edge,
                            tags,
                        )
                total_idx = len(seen_pos)

                with conn.cursor().copy(
                    "COPY _stage_cluster(trace_id, scope, turn_index, problem_index, label, cluster_code, l1_stage, l2_mechanism, l3_leaf, l4_subleaf, is_edge, tags) FROM STDIN"
                ) as copy:
                    for rec in seen_pos.values():
                        copy.write_row(rec)

                conn.execute("CREATE INDEX ON _stage_cluster (trace_id, scope, turn_index, problem_index)")
                conn.execute("CREATE INDEX ON _stage_cluster (trace_id, label) WHERE label IS NOT NULL")

                # Primary join: exact (model, trace_id, scope, turn_index, problem_index)
                r1 = conn.execute(
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
                    FROM _stage_cluster s
                    WHERE p.model = %s
                      AND p.trace_id = s.trace_id
                      AND p.scope = s.scope
                      AND p.turn_index = s.turn_index
                      AND p.problem_index = s.problem_index
                    """,
                    (tree_id, version, gen_dt, model),
                )
                bound_pos = r1.rowcount or 0

                # Fallback join for remaining unbound rows: (model, trace_id, label)
                r2 = conn.execute(
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
                    FROM (
                        SELECT DISTINCT ON (trace_id, label)
                            trace_id, label, cluster_code, l1_stage, l2_mechanism, l3_leaf, l4_subleaf, is_edge, tags
                        FROM _stage_cluster
                        WHERE label IS NOT NULL
                        ORDER BY trace_id, label, problem_index
                    ) s
                    WHERE p.model = %s
                      AND p.cluster_code IS NULL
                      AND p.trace_id = s.trace_id
                      AND p.label = s.label
                    """,
                    (tree_id, version, gen_dt, model),
                )
                bound_lbl = r2.rowcount or 0
                conn.commit()

        summary["models"][model] = {
            "tree_id": tree_id,
            "release_tag": release_tag,
            "nodes": len(nodes),
            "item_index_rows": total_idx,
            "bound_by_position": bound_pos,
            "bound_by_label_fallback": bound_lbl,
            "total_bound": bound_pos + bound_lbl,
        }

    return summary
