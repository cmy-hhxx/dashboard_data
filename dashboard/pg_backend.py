"""PostgreSQL 16 + Multi-Frame Zstd backend for the AIME dashboard (5001).

Activated ONLY when ``EVAL_STORAGE_BACKEND=pg``. All ``pg_data_core`` / ``psycopg``
imports are strictly lazy so non-PG deployments (e.g. Wencai flat-file SQLite)
and local unit tests run with zero extra dependencies.

Eliminates:
  - ``cache/build.sqlite3`` and ``cache/samples.pkl``
  - ``stats.json`` / ``stats_worker.py``
  - ``3_dynamic_bench/*.jsonl`` and flat ``eval_input``/``eval_output`` scans
  - ``human_read/.state/state.sqlite3``
"""
from __future__ import annotations

import csv
import gc
import hashlib
import os
import re
import sys
import threading
import time
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import ab_test
import bench_dynamic
import build
import json_compat as json
from daytime import iso_now, local_day

PG_BACKEND_VERSION = "2026-11-27.2"
SLUG_RE = re.compile(r"^[0-9a-f]{10}$")
AB_REF_RE = re.compile(r"^(?:(before|after|candidate_model_\d+)-)?(\d+)$")
FS_CLOCK_SLACK_NS = 20_000_000

_COMPACT_OVERLAY_MAP = (
    ("plans", "plans"),
    ("reasoning", "reasoning_chain"),
    ("execution", "execution_chain"),
    ("reflections", "reflections"),
    ("tool_errors", "tool_errors"),
    ("artifacts", "artifacts"),
    ("components", "components"),
)

_SKILL_COMPONENTS = frozenset({
    "aime-finquery",
    "data-visualizer",
    "cloud-automation",
    "superchart-settings",
    "market-news",
    "sec-filings",
})


def is_pg_enabled() -> bool:
    return os.environ.get("EVAL_STORAGE_BACKEND", "").strip().lower() in ("pg", "postgres", "postgresql")


def _ensure_pg():
    """Lazy-import pg_data_core modules only when PG backend is active."""
    here = Path(__file__).resolve().parent
    for cand in (
        os.environ.get("PG_DATA_CORE_PATH") or "",
        "/opt/pg_data_core",
        str(here.parent),
    ):
        if cand and os.path.isdir(cand) and cand not in sys.path:
            sys.path.insert(0, cand)
    from pg_data_core.config import load_config
    from pg_data_core.db import connect_direct
    from pg_data_core.models import UserRules
    from pg_data_core.zst_pack import pread_json

    return load_config, connect_direct, UserRules, pread_json


def _load_pg_config():
    load_config, _, _, _ = _ensure_pg()
    data_root = os.environ.get("AIME_DATA_ROOT") or None
    return load_config(role="ro", data_root=data_root)


def _infer_role(component: str | None, family: str | None, l1_stage: str | None, explicit_role: str | None) -> str:
    if explicit_role:
        return explicit_role
    comp = (component or "").strip()
    fam = (family or "").strip().lower()
    st = (l1_stage or "").strip().upper()
    cl = comp.lower()
    if "请求生成" in comp or st == "S10":
        return "request_generation"
    if cl.startswith("planner-") or comp in ("规划", "推理") or st in ("S12", "S1", "S2"):
        return "planning"
    if comp.startswith("/") or cl.endswith((".py", ".js", ".sh", ".mjs")) or fam == "script":
        return "script"
    if cl in _SKILL_COMPONENTS or "skill" in cl:
        return "skill"
    if comp.startswith("答案合成") or comp in ("交付", "图表", "render") or st in ("S9", "S11"):
        return "delivery"
    return "tool" if comp else "other"


def _assign_pg_slug(product: str, model: str, trace_id: str, seen: dict[str, str]) -> str:
    key = f"{product}|{model}|{trace_id}"
    slug = hashlib.md5(key.encode("utf-8")).hexdigest()[:10]
    while slug in seen and seen[slug] != key:
        slug = hashlib.sha256(slug.encode("utf-8")).hexdigest()[:10]
    seen[slug] = key
    return slug


def _iso_dt(val: Any) -> str | None:
    if val is None:
        return None
    if isinstance(val, datetime):
        if val.tzinfo is None:
            val = val.replace(tzinfo=timezone.utc)
        return val.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if isinstance(val, date):
        return val.isoformat()
    return str(val)


def _dt_to_ns(val: Any) -> int:
    if isinstance(val, datetime):
        if val.tzinfo is None:
            val = val.replace(tzinfo=timezone.utc)
        return int(val.timestamp() * 1_000_000_000)
    return 0


def _overlay_pg_human_read_detail(
    detail: dict[str, Any],
    hr_attr_delta: dict[str, Any] | None,
    hr_comp_delta: dict[str, Any] | None = None,
) -> bool:
    """Apply delta-only PG human_read translations over a built dashboard detail dict."""
    applied = False
    if isinstance(hr_attr_delta, dict) and isinstance(detail.get("attribution"), dict):
        da = detail["attribution"]
        if (hr_attr_delta.get("session_summary") or "").strip() and da.get("summary"):
            da["summary"] = hr_attr_delta["session_summary"]
            applied = True
        d_turns = da.get("turns") or []
        d_probs = da.get("problems") or []
        for ht_row in hr_attr_delta.get("turns") or []:
            if not isinstance(ht_row, dict):
                continue
            tidx = int(ht_row.get("turn_index", 0))
            if not (0 <= tidx < len(d_turns)):
                continue
            dt_row = d_turns[tidx]
            if (ht_row.get("summary") or "").strip() and dt_row.get("summary"):
                dt_row["summary"] = ht_row["summary"]
                applied = True
            hp_list = ht_row.get("problem") or []
            dp_ids = dt_row.get("problems") or []
            if len(hp_list) == len(dp_ids):
                for pid, hp in zip(dp_ids, hp_list):
                    if 0 <= pid < len(d_probs) and isinstance(hp, dict):
                        dp = d_probs[pid]
                        for d_key, h_key in (
                            ("label", "label"),
                            ("ph", "problem_phenomena"),
                            ("why", "reason"),
                            ("sevr", "severity_reason"),
                        ):
                            nv = (hp.get(h_key) or "").strip()
                            if nv and dp.get(d_key):
                                dp[d_key] = nv
                                applied = True
        hr_sprobs = hr_attr_delta.get("session_problem") or []
        d_sprob_ids = da.get("session_problems") or []
        if len(hr_sprobs) == len(d_sprob_ids):
            for pid, hp in zip(d_sprob_ids, hr_sprobs):
                if 0 <= pid < len(d_probs) and isinstance(hp, dict):
                    dp = d_probs[pid]
                    for d_key, h_key in (
                        ("label", "label"),
                        ("ph", "problem_phenomena"),
                        ("why", "reason"),
                        ("sevr", "severity_reason"),
                    ):
                        nv = (hp.get(h_key) or "").strip()
                        if nv and dp.get(d_key):
                            dp[d_key] = nv
                            applied = True

    if isinstance(hr_comp_delta, dict) and isinstance(detail.get("compact"), dict):
        d_cturns = detail["compact"].get("turns") or []
        for h_ct in hr_comp_delta.get("turns") or []:
            if not isinstance(h_ct, dict):
                continue
            tidx = int(h_ct.get("turn_index", 0))
            if not (0 <= tidx < len(d_cturns)):
                continue
            d_ct = d_cturns[tidx]
            for d_key, h_key in _COMPACT_OVERLAY_MAP:
                d_items = d_ct.get(d_key) or []
                h_texts = h_ct.get(h_key) or []
                if len(d_items) == len(h_texts) and d_items:
                    for d_it, h_txt in zip(d_items, h_texts):
                        if isinstance(h_txt, str) and h_txt.strip() and d_it.get("c"):
                            d_it["c"] = h_txt.strip()
                            applied = True
    return applied


def _attach_pg_problem_clusters(detail: dict[str, Any], prob_rows: list[dict[str, Any]]) -> None:
    """Attach exact PG cluster bindings onto `detail['attribution']['problems']`."""
    attr = detail.get("attribution") or {}
    d_probs = attr.get("problems") or []
    if not d_probs or not prob_rows:
        return
    by_pos: dict[tuple[str, int, int], dict[str, Any]] = {}
    by_lbl: dict[str, dict[str, Any]] = {}
    for pr in prob_rows:
        code = pr.get("cluster_code")
        if not code:
            continue
        cl_obj = {"path": code, "edge": bool(pr.get("is_edge")), "tags": list(pr.get("tags") or [])}
        by_pos[(pr.get("scope") or "turn", int(pr.get("turn_index") or 0), int(pr.get("problem_index") or 0))] = cl_obj
        if pr.get("label"):
            by_lbl.setdefault(str(pr["label"]), cl_obj)

    for ti, turn in enumerate(attr.get("turns") or []):
        for pi, pid in enumerate(turn.get("problems") or []):
            if 0 <= pid < len(d_probs):
                hit = by_pos.get(("turn", ti, pi)) or by_lbl.get(str(d_probs[pid].get("label") or ""))
                if hit:
                    d_probs[pid]["cl"] = hit
    for pi, pid in enumerate(attr.get("session_problems") or []):
        if 0 <= pid < len(d_probs):
            hit = by_pos.get(("session", 0, pi))
            if not hit:
                # Session problems attach to last turn_index in PG
                for (sc, _t, p_idx), val in by_pos.items():
                    if sc == "session" and p_idx == pi:
                        hit = val
                        break
            if not hit:
                hit = by_lbl.get(str(d_probs[pid].get("label") or ""))
            if hit:
                d_probs[pid]["cl"] = hit


# --------------------------------------------------------------------------- PG Taxonomy

def _load_pg_taxonomy(conn, data_root: Path) -> dict[str, Any]:
    taxonomy: dict[str, Any] = {
        "stages": {},
        "l2": {},
        "patterns": {},
        "mechanisms": {},
        "tags": {},
        "meta": {},
        "runs": [],
    }
    trees = conn.execute(
        """
        SELECT tree_id, product, model, version, release_tag, total_items, total_traces,
               total_sessions, edge_flagged, artifact_rel_dir, generated_at, extra
        FROM public.cluster_trees
        WHERE product = 'aime' AND is_current
        ORDER BY model
        """
    ).fetchall()

    for tr in trees:
        extra = tr["extra"] if isinstance(tr["extra"], dict) else {}
        artifact_tree = data_root / str(tr["artifact_rel_dir"] or "") / "cluster_tree.json"
        file_meta: dict[str, Any] = {}
        if artifact_tree.is_file():
            try:
                doc = json.loads(artifact_tree.read_text(encoding="utf-8"))
                file_meta = doc.get("meta") or {}
            except (OSError, ValueError):
                file_meta = {}

        gen_iso = file_meta.get("generated_at") or _iso_dt(tr["generated_at"]) or ""
        if gen_iso >= taxonomy["meta"].get("generated_at", ""):
            taxonomy["meta"] = {
                "version": file_meta.get("pipeline_version") or tr["version"],
                "generated_at": gen_iso,
                "title": file_meta.get("title") or "归因问题聚类树",
                "unit": file_meta.get("unit") or "原子归因问题条目",
                "axes": file_meta.get("axes") or {},
                "counting": file_meta.get("counting") or "",
                "low_sample_threshold": file_meta.get("low_sample_threshold", 10),
            }
        tot_items = int(tr["total_items"] or 0)
        edge_rate = round(int(tr["edge_flagged"] or 0) / tot_items, 4) if tot_items else 0.0
        taxonomy["runs"].append({
            "product": tr["product"],
            "model": tr["model"],
            "items": tot_items,
            "sessions": int(tr["total_sessions"] or 0),
            "edge_rate": file_meta.get("edge_rate", edge_rate),
        })

        for m in extra.get("mechanism_rollup") or []:
            if isinstance(m, dict) and m.get("mechanism"):
                taxonomy["mechanisms"].setdefault(
                    m["mechanism"],
                    {"id": m["mechanism"], "name": m.get("name"), "def": m.get("definition")},
                )
        for t in extra.get("tag_rollup") or []:
            if isinstance(t, dict) and t.get("tag"):
                taxonomy["tags"].setdefault(
                    t["tag"],
                    {"id": t["tag"], "name": t.get("name"), "def": t.get("definition")},
                )

        nodes = conn.execute(
            """
            SELECT code, level, name_zh, plain_desc, definition, include_rule,
                   exclude_rule, mechanism, components, tags
            FROM public.cluster_nodes
            WHERE tree_id = %s
            ORDER BY level, sort_order, code
            """,
            (tr["tree_id"],),
        ).fetchall()
        for n in nodes:
            lvl = int(n["level"])
            code = n["code"]
            if lvl == 1:
                st = taxonomy["stages"].setdefault(
                    code,
                    {"id": code, "name": n["name_zh"], "def": n["definition"], "components": set()},
                )
                st["components"].update(n["components"] or [])
            elif lvl == 2:
                taxonomy["l2"].setdefault(
                    code,
                    {"id": code, "name": n["name_zh"], "mech": n["mechanism"], "def": n["definition"]},
                )
            elif lvl in (3, 4):
                taxonomy["patterns"].setdefault(
                    code,
                    {
                        "id": code,
                        "name": n["name_zh"],
                        "plain": n["plain_desc"],
                        "def": n["definition"],
                        "include": n["include_rule"],
                        "exclude": n["exclude_rule"],
                        "tags": list(n["tags"] or []),
                    },
                )

    for st in taxonomy["stages"].values():
        st["components"] = sorted(st["components"])
    return taxonomy


# --------------------------------------------------------------------------- PG AB Payload

def _read_ab_leaf_names(data_root: Path, cluster_rel_dirs: list[str], fallback_names: dict[str, str]) -> dict[str, str]:
    names = dict(fallback_names)
    for rel in cluster_rel_dirs:
        if not rel:
            continue
        cdir = data_root / rel
        if not cdir.is_dir():
            continue
        tsv = cdir / "leaves.tsv"
        if tsv.is_file():
            try:
                with tsv.open(encoding="utf-8", newline="") as fh:
                    for row in csv.DictReader(fh):
                        p = (row.get("path") or "").strip()
                        if p:
                            names.setdefault(p, row.get("name") or p)
            except OSError:
                pass
        tree_p = cdir / "cluster_tree.json"
        if tree_p.is_file():
            try:
                doc = json.loads(tree_p.read_text(encoding="utf-8"))
                stack = [doc.get("tree") or {}]
                while stack:
                    node = stack.pop()
                    nid = node.get("id") or ""
                    if re.fullmatch(r"S\d+(?:\.M\d+)?(?:\.\d+){0,2}", nid):
                        names[nid] = node.get("name") or nid
                    stack.extend(node.get("children") or [])
            except (OSError, ValueError):
                pass
    return names


def _build_pg_ab_payload(
    conn,
    data_root: Path,
    generated: str,
    taxonomy: dict[str, Any],
) -> dict[str, Any] | None:
    rounds_rows = conn.execute(
        """
        SELECT round_id, round_key, model, version_tag, released_at, title,
               tier_size, requested_count, actual_count, status, stage, finished_at, extra
        FROM public.ab_rounds
        WHERE product = 'aime'
        ORDER BY COALESCE(released_at, created_at::date) ASC, round_key ASC
        """
    ).fetchall()
    if not rounds_rows:
        return None

    fallback_names: dict[str, str] = {}
    for sid, st in (taxonomy.get("stages") or {}).items():
        fallback_names[sid] = st.get("name") or sid
    for l2id, v in (taxonomy.get("l2") or {}).items():
        fallback_names[l2id] = v.get("name") or l2id
    for pid, v in (taxonomy.get("patterns") or {}).items():
        fallback_names[pid] = v.get("name") or pid

    out_rounds = []
    models_seen = set()

    for order, rr in enumerate(rounds_rows):
        rid = int(rr["round_id"])
        round_key = rr["round_key"]
        model_short = ab_test._short_model(rr["model"])
        if model_short:
            models_seen.add(model_short)
        extra = rr["extra"] if isinstance(rr["extra"], dict) else {}
        lmeta = extra.get("legacy_meta") if isinstance(extra.get("legacy_meta"), dict) else {}
        lstats = extra.get("legacy_stats") if isinstance(extra.get("legacy_stats"), dict) else {}

        cands = conn.execute(
            """
            SELECT candidate_id, candidate_idx, candidate_key, description,
                   is_baseline, source_mode, cluster_rel_dir, extra
            FROM public.ab_candidates
            WHERE round_id = %s
            ORDER BY candidate_idx ASC
            """,
            (rid,),
        ).fetchall()
        before_cand = next((c for c in cands if c["is_baseline"]), cands[0] if cands else None)
        after_cand = next(
            (c for c in cands if c["source_mode"] in ("live", "slice") and (not before_cand or c["candidate_id"] != before_cand["candidate_id"])),
            None,
        )
        gpt_cand = next((c for c in cands if c["source_mode"] == "answer_only"), None)

        targets = conn.execute(
            """
            SELECT target_id, eq_index, case_key, source_trace_id, question_text,
                   task_category, subtask_category, extra
            FROM public.ab_targets
            WHERE round_id = %s
            ORDER BY eq_index ASC
            """,
            (rid,),
        ).fetchall()

        cases = conn.execute(
            """
            SELECT case_id, candidate_id, target_id, eq_index, status, eval_bucket,
                   trace_id, session_id, request_time, attr_file_id, linked_output_id,
                   input_file_id, problem_count, max_severity, is_gold
            FROM public.ab_candidate_cases
            WHERE round_id = %s
            """,
            (rid,),
        ).fetchall()
        cases_by_cand_eq: dict[tuple[int, int], dict[str, Any]] = {
            (int(c["candidate_id"]), int(c["eq_index"])): c for c in cases
        }

        probs = conn.execute(
            """
            SELECT case_id, candidate_id, eq_index, cluster_code
            FROM public.ab_candidate_problems
            WHERE round_id = %s AND cluster_code IS NOT NULL
            ORDER BY case_id, turn_index, problem_index
            """,
            (rid,),
        ).fetchall()
        paths_by_case: dict[int, list[str]] = defaultdict(list)
        for pr in probs:
            cid = int(pr["case_id"])
            code = str(pr["cluster_code"])
            if code not in paths_by_case[cid]:
                paths_by_case[cid].append(code)

        verify_map = {}
        dates_set = set()
        sources_cnt = Counter()
        status_cnt = Counter()
        b_reason_cnt = Counter()
        fixed_scenes = Counter()

        before_id = int(before_cand["candidate_id"]) if before_cand else -1
        after_id = int(after_cand["candidate_id"]) if after_cand else -1
        gpt_id = int(gpt_cand["candidate_id"]) if gpt_cand else -1

        def _is_eval(case_row: dict[str, Any] | None) -> bool:
            if not case_row:
                return False
            st = str(case_row["status"] or "").strip()
            return st in ("evaluated", "ready") or st.startswith(("已评测", "已重测"))

        def _has_detail(case_row: dict[str, Any] | None) -> bool:
            return bool(case_row and (case_row["attr_file_id"] is not None or case_row["linked_output_id"] is not None))

        after_available = any(_is_eval(cases_by_cand_eq.get((after_id, int(t["eq_index"])))) for t in targets) if after_cand else False

        before_evaluated_count = 0
        after_evaluated_count = 0
        common_rows = []
        common_before, common_after = Counter(), Counter()
        common_before_matrix, common_after_matrix = Counter(), Counter()
        common_before_scene, common_after_scene = Counter(), Counter()
        common_before_problem = common_after_problem = 0
        before_only_counter, before_only_matrix, before_only_scene = Counter(), Counter(), Counter()
        before_only_problem = 0
        before_refs, after_refs, pairs = [], [], []
        gpt_has_set = set()

        for t in targets:
            eq = int(t["eq_index"])
            tex = t["extra"] if isinstance(t["extra"], dict) else {}
            trace = str(t["source_trace_id"] or t["case_key"] or f"eq_{eq:05d}")
            q = str(t["question_text"] or "")
            task = (t["task_category"] or "").strip() or ab_test.NO_SCENE
            sub = (t["subtask_category"] or "").strip() if task != ab_test.NO_SCENE else ""
            fixed_scenes[(task, sub)] += 1

            qtime = str(tex.get("question_time") or "")
            day = local_day(qtime, "aime")
            if day:
                dates_set.add(day)
            ecat = str(tex.get("eval_category") or "").strip()
            if ecat:
                sources_cnt[ecat] += 1
            if isinstance(tex.get("verify"), dict):
                vmodels = ab_test._verify_models(tex["verify"])
                if vmodels:
                    qid = str(tex["verify"].get("question_id") or trace)
                    verify_map[qid] = {"models": vmodels}

            bc = cases_by_cand_eq.get((before_id, eq))
            ac = cases_by_cand_eq.get((after_id, eq))
            gc_row = cases_by_cand_eq.get((gpt_id, eq)) if gpt_cand else None
            if gc_row and gc_row["input_file_id"] is not None:
                gpt_has_set.add(trace)

            b_eval = _is_eval(bc)
            a_eval = _is_eval(ac)
            b_paths = paths_by_case.get(int(bc["case_id"]), []) if bc else []
            a_paths = paths_by_case.get(int(ac["case_id"]), []) if ac else []

            if b_eval:
                before_evaluated_count += 1
                if b_paths:
                    status_cnt["A"] += 1
                else:
                    status_cnt["B"] += 1
                    br = (bc["eval_bucket"] or ("B1" if bc["is_gold"] else "B2")) if bc else ""
                    if br:
                        b_reason_cnt[br] += 1
                before_only_scene[(task, sub)] += 1
                if b_paths:
                    before_only_problem += 1
                for p in b_paths:
                    before_only_counter[p] += 1
                    before_only_matrix[(task, sub, p)] += 1
            else:
                status_cnt["C"] += 1

            if a_eval:
                after_evaluated_count += 1

            b_detail = f"before-{eq}" if (b_eval and _has_detail(bc)) else None
            a_detail = f"after-{eq}" if (a_eval and _has_detail(ac)) else None

            before_obj = {
                "trace": trace,
                "model": model_short,
                "detail": b_detail,
                "n": len(b_paths),
                "paths": b_paths,
                "status": str(bc["status"]) if bc else "missing",
            } if b_eval else None
            a_status_str = str(ac["status"]) if ac else "missing"
            after_obj = {
                "trace": (ac["trace_id"] if ac and ac["trace_id"] else trace),
                "model": model_short,
                "detail": a_detail,
                "n": len(a_paths),
                "paths": a_paths,
                "status": a_status_str,
            } if (a_eval or a_status_str in ("failed", "pending")) else None

            pairs.append({
                "id": trace,
                "eq": eq,
                "q": ab_test._clip(q, 160),
                "scene": task,
                "sub": sub,
                "before": before_obj,
                "after": after_obj,
            })

            if b_eval and b_paths:
                before_refs.append({
                    "trace": trace,
                    "pair": trace,
                    "eq": eq,
                    "q": ab_test._clip(q, 160),
                    "detail": b_detail,
                    "model": model_short,
                    "task": task,
                    "sub": sub,
                    "paths": b_paths,
                })
            if a_eval and a_paths:
                after_refs.append({
                    "trace": (ac["trace_id"] if ac and ac["trace_id"] else trace),
                    "pair": trace,
                    "eq": eq,
                    "q": ab_test._clip(q, 160),
                    "detail": a_detail,
                    "model": model_short,
                    "task": task,
                    "sub": sub,
                    "paths": a_paths,
                })

            if b_eval and a_eval:
                common_rows.append([task, sub, list(b_paths), list(a_paths)])
                common_before_scene[(task, sub)] += 1
                common_after_scene[(task, sub)] += 1
                if b_paths:
                    common_before_problem += 1
                if a_paths:
                    common_after_problem += 1
                for p in b_paths:
                    common_before[p] += 1
                    common_before_matrix[(task, sub, p)] += 1
                for p in a_paths:
                    common_after[p] += 1
                    common_after_matrix[(task, sub, p)] += 1

        if after_available:
            active_before = common_before
            active_before_matrix = common_before_matrix
            active_before_scene = common_before_scene
            active_before_traces = len(common_rows)
            active_before_problem = common_before_problem
        else:
            active_before = before_only_counter
            active_before_matrix = before_only_matrix
            active_before_scene = before_only_scene
            active_before_traces = before_evaluated_count
            active_before_problem = before_only_problem

        ab_test._paired_only(pairs, {"before": before_refs, "after": after_refs})

        names = _read_ab_leaf_names(
            data_root,
            [str(c["cluster_rel_dir"] or "") for c in cands if c["cluster_rel_dir"]],
            fallback_names,
        )
        leaves = [
            {
                "id": path,
                "name": names.get(path) or path,
                "before": active_before.get(path, 0),
                "after": common_after.get(path, 0) if after_available else None,
                "model_before": {},
                "model_after": {},
                "source_before": {},
                "source_after": {},
            }
            for path in sorted(set(active_before) | set(common_after), key=ab_test.node_order)
        ]

        digits = re.sub(r"\D", "", str(lmeta.get("version") or rr["version_tag"] or ""))
        short_ver = digits[-4:] if len(digits) >= 4 else str(rr["version_tag"])
        rel_str = rr["released_at"].isoformat() if isinstance(rr["released_at"], date) else (lmeta.get("released_at") or None)
        label = str(lmeta.get("label") or f"v{short_ver}")
        sorted_dates = sorted(dates_set)
        common_scenes = Counter((task, sub) for task, sub, _b, _a in common_rows)

        round_doc: dict[str, Any] = {
            "id": round_key,
            "order": order,
            "version": short_ver,
            "label": label,
            "title": str(lmeta.get("title") or rr["title"] or ""),
            "released_at": rel_str,
            "release_label": lmeta.get("label") if isinstance(lmeta.get("label"), str) else None,
            "before_label": str(lmeta.get("before_label") or (before_cand["description"] if before_cand else ab_test.SIDE_LABEL["before"])),
            "after_label": str(lmeta.get("after_label") or (after_cand["description"] if after_cand else ab_test.SIDE_LABEL["after"])),
            "generated_at": lmeta.get("generated_at") or lstats.get("generated_at") or _iso_dt(rr["finished_at"]),
            "targets": int(rr["tier_size"] or rr["actual_count"] or len(targets)),
            "models": [model_short] if model_short else [],
            "status": dict(sorted(status_cnt.items())),
            "b_reason": dict(sorted(b_reason_cnt.items())),
            "sources": [[k, v] for k, v in sorted(sources_cnt.items(), key=lambda kv: -kv[1])],
            "dates": [sorted_dates[0], sorted_dates[-1]] if sorted_dates else [],
            "verify": verify_map,
            "sides": {
                "before": {
                    "traces": active_before_traces,
                    "hits": sum(active_before.values()),
                    "problem_traces": active_before_problem,
                },
                "after": ({
                    "traces": len(common_rows),
                    "hits": sum(common_after.values()),
                    "problem_traces": common_after_problem,
                } if after_available else None),
            },
            "candidates": [
                {
                    "idx": int(c["candidate_idx"]),
                    "key": c["candidate_key"],
                    "description": c["description"],
                    "is_baseline": bool(c["is_baseline"]),
                    "source_mode": c["source_mode"],
                }
                for c in cands
            ],
            "leaves": leaves,
            "sample_refs": {"before": before_refs, "after": after_refs},
            "fixed": {
                "total": int(rr["tier_size"] or rr["actual_count"] or len(targets)),
                "before": before_evaluated_count,
                "after": after_evaluated_count,
                "scenes": [[task, sub, count] for (task, sub), count in fixed_scenes.items()],
            },
            "common": {
                "total": len(common_rows),
                "scenes": [[task, sub, count] for (task, sub), count in common_scenes.items()],
                "rows": common_rows,
            },
            "pairs": pairs,
            "matrix": {
                "before": ab_test.matrix_rows(active_before_matrix, active_before_scene) if before_evaluated_count else [],
                "after": ab_test.matrix_rows(common_after_matrix, common_after_scene) if after_available else None,
            },
            "nodes": ab_test.tree_nodes(active_before, common_after, names, after_available),
        }

        if gpt_cand is not None:
            gex = gpt_cand["extra"] if isinstance(gpt_cand["extra"], dict) else {}
            g_model = str(gex.get("gpt_model") or "GPT")
            round_doc["gpt"] = {
                "total": int(gex.get("gpt_total") or len(gpt_has_set)),
                "answered": int(gex.get("gpt_answered") or len(gpt_has_set)),
                "model": g_model,
                "effort": str(gex.get("gpt_effort") or ""),
            }
            for pair in pairs:
                key = str(pair.get("id") or "")
                pair["gpt"] = {"key": key, "has": key in gpt_has_set, "model": g_model}

        out_rounds.append(round_doc)

    return {
        "schema": 4,
        "generated_at": generated,
        "product": "aime",
        "labels": {
            "status": {k: list(v) for k, v in ab_test.STATUS_LABEL.items()},
            "b_reason": {k: list(v) for k, v in ab_test.B_REASON_LABEL.items()},
            "sources": ab_test.SOURCE_LABEL,
            "sides": ab_test.SIDE_LABEL,
        },
        "models": sorted(models_seen),
        "rounds": out_rounds,
    }


# --------------------------------------------------------------------------- PG Dynamic Bench

def _build_pg_bench(
    conn,
    taxonomy: dict[str, Any],
    trace_refs: dict[str, tuple[str, str]],
    generated: str,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    bsets = conn.execute(
        """
        SELECT bench_id, bench_key, model, bench_type, tier_size, version,
               requested_count, actual_count, params, stats, built_at
        FROM public.bench_sets
        WHERE product = 'aime' AND bench_type IN ('pool', 'tier', 'long')
        ORDER BY model, bench_type, tier_size NULLS FIRST
        """
    ).fetchall()
    if not bsets:
        return None

    stage_names = {sid: (st.get("name") or sid) for sid, st in (taxonomy.get("stages") or {}).items()}
    mech_names = {mid: (m.get("name") or mid) for mid, m in (taxonomy.get("mechanisms") or {}).items()}
    pat_names = {pid: (p.get("name") or pid) for pid, p in (taxonomy.get("patterns") or {}).items()}

    by_model: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: {"pool": [], "tier": [], "long": []})
    manifest_params: dict[str, Any] = {}
    built_at_iso = generated
    pool_meta_manifest: dict[str, Any] = {}
    for bs in bsets:
        by_model[bs["model"]][bs["bench_type"]].append(bs)
        if isinstance(bs["params"], dict) and bs["params"]:
            manifest_params = bs["params"]
        if bs["built_at"]:
            built_at_iso = _iso_dt(bs["built_at"]) or built_at_iso
        if bs["bench_type"] == "pool" and isinstance(bs["stats"], dict) and bs["stats"]:
            pool_meta_manifest = bs["stats"]

    long_threshold = int(manifest_params.get("long_tokens") or 65536)
    models_out: dict[str, Any] = {}
    models_cases: dict[str, list[dict[str, Any]]] = {}
    linked_counts: dict[str, int] = {}
    manifest_models: dict[str, Any] = {}

    for model in sorted(by_model):
        groups = by_model[model]
        std_sets = sorted(groups["tier"], key=lambda x: int(x["tier_size"] or 0))
        long_sets = sorted(groups["long"], key=lambda x: int(x["tier_size"] or 0))
        pool_set = groups["pool"][0] if groups["pool"] else None

        # Pool stats from PG bench_items + eval_inputs
        pool_size = int(pool_set["actual_count"] or 0) if pool_set else 0
        pool_daily = []
        pool_sev = Counter()
        pool_turn = Counter()
        pool_toks: list[int] = []
        pool_dim_counts = {d: Counter() for d in bench_dynamic.DIMS}
        pool_defects = 0
        long_pool = 0
        if pool_set:
            p_rows = conn.execute(
                """
                SELECT bi.severity, bi.turn_type, bi.session_round, bi.primary_cluster,
                       bi.extra->>'batch_id' AS batch_id, bi.extra->>'group' AS grp,
                       i.biz_day, i.total_tokens
                FROM public.bench_items bi
                LEFT JOIN public.eval_inputs i ON i.input_id = bi.input_id
                WHERE bi.bench_id = %s
                """,
                (pool_set["bench_id"],),
            ).fetchall()
            day_cnt = Counter()
            for r in p_rows:
                sev = r["severity"] or "GOLD"
                trn = r["turn_type"] or "single"
                tok = int(r["total_tokens"] or 0)
                if tok >= long_threshold:
                    long_pool += 1
                pool_toks.append(tok)
                pool_sev[sev] += 1
                pool_turn[trn] += 1
                bday = (r["batch_id"] or "")[:10] or (r["biz_day"].isoformat() if r["biz_day"] else "")
                if bday:
                    day_cnt[bday] += 1
                    pool_dim_counts["day"][bday] += 1
                pool_dim_counts["severity"][sev] += 1
                pool_dim_counts["turn_type"][trn] += 1
                pool_dim_counts["round"][bench_dynamic.round_bucket(r["session_round"])] += 1
                if r["grp"]:
                    pool_dim_counts["group"][r["grp"]] += 1
                pcode = r["primary_cluster"] or ""
                if pcode:
                    parts = pcode.split(".")
                    pool_defects += 1
                    pool_dim_counts["stage"][parts[0]] += 1
                    if len(parts) >= 2:
                        pool_dim_counts["mechanism"][parts[1]] += 1
                    pool_dim_counts["pattern"][pcode] += 1
            pool_daily = [{"key": d, "count": c} for d, c in sorted(day_cnt.items())]

        pool_toks.sort()
        base_pool = max(0, pool_size - long_pool) if pool_size > long_pool else pool_size
        pool_dims_out = {}
        for d in bench_dynamic.DIMS:
            denom = pool_defects if d in bench_dynamic.TAX_DIMS else max(1, pool_size)
            pool_dims_out[d] = [
                {
                    "key": k,
                    "bucket": (
                        stage_names.get(k, k) if d == "stage"
                        else mech_names.get(k, k) if d == "mechanism"
                        else pat_names.get(k, k) if d == "pattern"
                        else k
                    ),
                    "count": int(c),
                    "share": round(c / denom, 6) if denom else 0.0,
                }
                for k, c in pool_dim_counts[d].most_common()
            ]
        pool_stats = {
            "pool_size": base_pool,
            "base_pool": base_pool,
            "long_pool": long_pool,
            "by_severity": dict(pool_sev),
            "by_turn": dict(pool_turn),
            "tokens": {
                "p50": bench_dynamic._quantile(pool_toks, 0.5),
                "p90": bench_dynamic._quantile(pool_toks, 0.9),
                "p99": bench_dynamic._quantile(pool_toks, 0.99),
            },
            "dims": pool_dims_out,
        }

        def _load_tier_family(tier_sets: list[dict[str, Any]], is_long: bool) -> list[dict[str, Any]]:
            if not tier_sets:
                return []
            min_tier_by_tid: dict[str, int] = {}
            for ts in tier_sets[:-1]:
                tnum = int(ts["tier_size"] or 0)
                for r in conn.execute("SELECT trace_id FROM public.bench_items WHERE bench_id = %s", (ts["bench_id"],)).fetchall():
                    min_tier_by_tid.setdefault(r["trace_id"], tnum)
            max_set = tier_sets[-1]
            max_tnum = int(max_set["tier_size"] or 0)
            rows = conn.execute(
                """
                SELECT bi.input_id, bi.trace_id, bi.session_id, bi.rank, bi.turn_type,
                       bi.session_round, bi.severity, bi.dup_question_cnt, bi.question_text,
                       bi.primary_cluster, bi.extra,
                       i.biz_day, i.request_time, i.turn_index, i.total_tokens, i.input_tokens,
                       i.tool_count, i.latency_ms, i.source,
                       o.output_id, o.problem_count
                FROM public.bench_items bi
                LEFT JOIN public.eval_inputs i ON i.input_id = bi.input_id
                LEFT JOIN public.eval_outputs o ON o.input_id = bi.input_id AND o.is_latest
                WHERE bi.bench_id = %s
                ORDER BY bi.rank ASC
                """,
                (max_set["bench_id"],),
            ).fetchall()

            # Load primary problem labels for output_ids in one query
            oids = [int(r["output_id"]) for r in rows if r["output_id"] is not None]
            prob_by_oid: dict[int, list[tuple[str, str]]] = defaultdict(list)
            if oids:
                for pr in conn.execute(
                    """
                    SELECT output_id, label, cluster_code
                    FROM public.eval_problems
                    WHERE output_id = ANY(%s)
                    ORDER BY output_id, turn_index, problem_index
                    """,
                    (oids,),
                ).fetchall():
                    prob_by_oid[int(pr["output_id"])].append((pr["label"] or "", pr["cluster_code"] or ""))

            out_cases = []
            for idx, r in enumerate(rows):
                tid = r["trace_id"]
                mt = min_tier_by_tid.get(tid, max_tnum)
                bex = r["extra"] if isinstance(r["extra"], dict) else {}
                prim_raw = bex.get("primary") if isinstance(bex.get("primary"), dict) else {}
                pcode = r["primary_cluster"] or prim_raw.get("l3") or prim_raw.get("path") or ""
                parts = pcode.split(".") if pcode else []
                l1 = (prim_raw.get("l1") or (parts[0] if len(parts) >= 1 else "")) or "NA"
                l2 = (prim_raw.get("l2") or (parts[1] if len(parts) >= 2 else "")) or "NA"
                l3 = pcode or "NA"
                oid = int(r["output_id"]) if r["output_id"] is not None else None
                plist = prob_by_oid.get(oid, []) if oid is not None else []
                sev = r["severity"] or "GOLD"
                prim_label = next((lb for lb, pc in plist if pc == pcode and lb), plist[0][0] if plist else "")
                if not prim_label:
                    prim_label = pat_names.get(l3, "") if l3 != "NA" else ("goldencase" if sev == "GOLD" else "")
                day_str = r["biz_day"].isoformat() if r["biz_day"] else str(bex.get("batch_id") or "")[:10]
                req_str = _iso_dt(r["request_time"]) or str(bex.get("request_time") or "")
                ref = trace_refs.get(tid)
                rank_val = int(((bex.get("bench") or {}).get("rank")) if isinstance(bex.get("bench"), dict) and (bex.get("bench") or {}).get("rank") is not None else (r["rank"] if r["rank"] else idx))
                out_cases.append({
                    "trace_id": tid,
                    "session_id": r["session_id"] or "",
                    "model": model,
                    "day": day_str,
                    "request_time": req_str,
                    "group": str(bex.get("group") or "0_daily_eval"),
                    "question": bench_dynamic._clip(r["question_text"] or "", 220),
                    "turn": r["turn_type"] or "single",
                    "session_round": int(r["session_round"] or 1),
                    "turn_index": int(r["turn_index"] or 1),
                    "severity": sev,
                    "primary": {
                        "l1": l1,
                        "l2": l2,
                        "l3": l3,
                        "label": bench_dynamic._clip(prim_label, 120),
                        "path": pcode,
                        "path_source": "none" if sev == "GOLD" else ("join" if pcode else "none"),
                    },
                    "probs_count": int(r["problem_count"] or len(plist)),
                    "probs_search": bench_dynamic._clip(" | ".join(f"{lb} {pc}".strip() for lb, pc in plist), 360),
                    "stats": {
                        "total_tokens": int(r["total_tokens"] or 0),
                        "input_tokens": int(r["input_tokens"] or 0),
                        "tool_count": int(r["tool_count"] or 0),
                        "latency": round(float(r["latency_ms"] or 0.0) / 1000.0, 1),
                        "dup_question": int(r["dup_question_cnt"] or 1),
                    },
                    "meta": {
                        "recalled_from": str(bex.get("recalled_from") or "unknown"),
                        "comefrom": "",
                        "source": str(r["source"] or ""),
                        "tool_names": [],
                    },
                    "bench": {
                        "tier": max_tnum,
                        "min_tier": 0 if is_long else mt,
                        "long_tier": mt if is_long else 0,
                        "rank": rank_val,
                        "pool_size": long_pool if is_long else base_pool,
                    },
                    "loc": ["pg", int(r["input_id"]) if r["input_id"] is not None else 0, oid or 0],
                    "slug": ref[0] if ref else None,
                    "case_key": ref[1] if ref else None,
                })
            out_cases.sort(key=lambda c: c["bench"]["rank"])
            return out_cases

        std_cases = _load_tier_family(std_sets, False)
        long_cases = _load_tier_family(long_sets, True)
        all_m_cases = std_cases + long_cases
        models_cases[model] = all_m_cases
        linked_counts[model] = sum(1 for c in all_m_cases if c.get("slug"))

        # Compute schema:2 tier stats purely from PG cases (reusing bench_dynamic math!)
        def _tier_stats_from_cases(cases_list: list[dict[str, Any]], req_n: int, is_long: bool, pool_n: int) -> dict[str, Any]:
            # Temporarily mirror min_tier into long_tier when calling _derive_long_tier_stats
            if is_long:
                return bench_dynamic._derive_long_tier_stats(
                    cases_list, req_n, pool_n, pool_stats, manifest_params, stage_names, mech_names, pat_names
                )
            adapted = [
                {**c, "bench": {**c["bench"], "long_tier": c["bench"]["min_tier"]}}
                for c in cases_list
            ]
            return bench_dynamic._derive_long_tier_stats(
                adapted, req_n, pool_n, pool_stats, manifest_params, stage_names, mech_names, pat_names
            )

        tiers_out = {
            str(int(ts["tier_size"])): _tier_stats_from_cases(std_cases, int(ts["tier_size"]), False, base_pool)
            for ts in std_sets if ts["tier_size"]
        }
        long_tiers_out = {
            str(int(ts["tier_size"])): _tier_stats_from_cases(long_cases, int(ts["tier_size"]), True, long_pool)
            for ts in long_sets if ts["tier_size"]
        }
        models_out[model] = {
            "pool_size": pool_size,
            "base_pool": base_pool,
            "long_pool": long_pool,
            "pool_daily": pool_daily,
            "pool_stats": pool_stats,
            "tiers": tiers_out,
            "long_tiers": long_tiers_out,
        }
        manifest_models[model] = {
            "pool_size": pool_size,
            "base_pool": base_pool,
            "long_pool": long_pool,
            "tiers": {k: {"requested": v["requested"], "actual": v["actual"], "shortfall": v["shortfall"]} for k, v in tiers_out.items()},
            "long": {k: {"pool": long_pool, "actual": v["actual"]} for k, v in long_tiers_out.items()},
        }

    manifest = {
        "schema": bench_dynamic.DYNAMIC_SCHEMA,
        "channel": "aime",
        "built_at": built_at_iso,
        "params": manifest_params,
        "pool": pool_meta_manifest,
        "models": manifest_models,
    }
    summary = {
        "schema": bench_dynamic.DYNAMIC_SCHEMA,
        "manifest": manifest,
        "stage_names": stage_names,
        "mech_names": mech_names,
        "pat_names": pat_names,
        "models": models_out,
        "product": "aime",
        "linked_counts": linked_counts,
        "generated_at": generated,
    }
    sig = hashlib.sha1(f"{generated}:{linked_counts}".encode("utf-8")).hexdigest()[:16]
    index = {
        "schema": bench_dynamic.DYNAMIC_SCHEMA,
        "product": "aime",
        "sig": sig,
        "models": models_cases,
        "generated_at": generated,
    }
    return summary, index


# --------------------------------------------------------------------------- Main PG Build

def _pg_watermark(conn, datasets: Path) -> str:
    parts: list[Any] = [PG_BACKEND_VERSION, build.PAYLOAD_VERSION, build.release_signature(datasets)]
    for sql in (
        "SELECT COALESCE(MAX(seq), 0), COUNT(*) FROM public.changes",
        "SELECT COUNT(*), COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM public.eval_inputs WHERE product='aime' AND NOT is_deleted",
        "SELECT COUNT(*), COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM public.eval_outputs WHERE product='aime' AND is_latest",
        "SELECT COUNT(*) FILTER (WHERE cluster_code IS NOT NULL), COALESCE(MAX(clustered_at), '1970-01-01'::timestamptz) FROM public.eval_problems",
        "SELECT COUNT(*), COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM public.users",
        "SELECT COUNT(*), COALESCE(MAX(created_at), '1970-01-01'::timestamptz) FROM public.cluster_trees WHERE product='aime' AND is_current",
        "SELECT COUNT(*), COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM public.bench_sets WHERE product='aime'",
        "SELECT COUNT(*), COALESCE(MAX(updated_at), '1970-01-01'::timestamptz) FROM public.ab_rounds WHERE product='aime'",
    ):
        row = conn.execute(sql).fetchone()
        parts.append([str(v) for v in row.values()])
    return hashlib.sha1(json.dumps(parts, separators=(",", ":")).encode("utf-8")).hexdigest()


def _release_entries_pg(data_root: Path, datasets: Path, product: str) -> list[dict[str, Any]]:
    cfg_rel = data_root / "config" / "releases.json"
    if cfg_rel.is_file():
        return build.release_entries(cfg_rel.parent, product)
    return build.release_entries(datasets, product)


def _sample_goldens_and_sevr(
    conn,
    data_root: Path,
    slug_by_oid: dict[int, str],
    pread_json,
) -> tuple[dict[str, list[dict[str, Any]]], list[tuple[float, dict[str, Any]]]]:
    """Fetch ~25 real samples via O(1) Zstd pread for 评测体系 severity examples & golden cases."""
    sev_examples: dict[str, list[dict[str, Any]]] = {s: [] for s in build.SEVERITIES}
    golden_pool: list[tuple[float, dict[str, Any]]] = []

    # Pick up to 8 outputs per severity for severity examples + golden candidates
    cand_oids: list[tuple[int, str]] = []
    for sev in build.SEVERITIES:
        rows = conn.execute(
            """
            SELECT o.output_id, o.model
            FROM public.eval_outputs o
            JOIN public.eval_inputs i ON i.input_id = o.input_id
            WHERE o.product='aime' AND o.is_latest AND o.max_severity = %s
              AND i.has_input_blob AND o.attr_file_id IS NOT NULL
              AND i.n_messages BETWEEN 12 AND 36
              AND o.problem_count BETWEEN 1 AND 6
            ORDER BY o.biz_day DESC, o.output_id DESC
            LIMIT 6
            """,
            (sev,),
        ).fetchall()
        for r in rows:
            cand_oids.append((int(r["output_id"]), r["model"]))

    if not cand_oids:
        return sev_examples, golden_pool

    oid_list = list(dict.fromkeys(oid for oid, _ in cand_oids))
    detail_rows = conn.execute(
        """
        SELECT o.output_id, o.input_id, o.model, o.biz_day,
               ipf.rel_path AS in_path, i.input_offset, i.input_len,
               apf.rel_path AS attr_path, o.attr_offset, o.attr_len
        FROM public.eval_outputs o
        JOIN public.eval_inputs i ON i.input_id = o.input_id
        LEFT JOIN public.pack_files ipf ON ipf.file_id = i.input_file_id
        LEFT JOIN public.pack_files apf ON apf.file_id = o.attr_file_id
        WHERE o.output_id = ANY(%s)
        """,
        (oid_list,),
    ).fetchall()
    prob_map: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for pr in conn.execute(
        """
        SELECT output_id, scope, turn_index, problem_index, label, cluster_code, is_edge, tags
        FROM public.eval_problems WHERE output_id = ANY(%s)
        """,
        (oid_list,),
    ).fetchall():
        prob_map[int(pr["output_id"])].append(dict(pr))

    seen_labels: dict[str, set[str]] = {s: set() for s in build.SEVERITIES}
    for r in detail_rows:
        oid = int(r["output_id"])
        slug = slug_by_oid.get(oid)
        if not slug or not r["attr_path"]:
            continue
        try:
            attr = pread_json(data_root / r["attr_path"], int(r["attr_offset"]), int(r["attr_len"]))
            inp = (
                pread_json(data_root / r["in_path"], int(r["input_offset"]), int(r["input_len"]))
                if r["in_path"] and r["input_len"]
                else None
            )
            pair = {
                "product": "aime",
                "model": r["model"],
                "date": r["biz_day"].isoformat(),
                "split": "daily",
                "input": None,
                "compact": None,
                "output": None,
            }
            detail, _, _ = build.build_sample(pair, inp, attr, None, {}, Counter())
            detail["slug"] = slug
            _attach_pg_problem_clusters(detail, prob_map.get(oid, []))
            gc_cand = build.golden_candidate(detail)
            if gc_cand:
                golden_pool.append(gc_cand)
            for p in (detail.get("attribution") or {}).get("problems") or []:
                sev = p.get("sev")
                sevr = p.get("sevr")
                lab = p.get("label") or ""
                if (
                    sev in sev_examples
                    and len(sev_examples[sev]) < 3
                    and sevr
                    and len(sevr) < 150
                    and len(lab) < 26
                    and lab not in seen_labels[sev]
                ):
                    seen_labels[sev].add(lab)
                    sev_examples[sev].append({
                        "slug": slug,
                        "product": "aime",
                        "p": p["id"],
                        "label": lab,
                        "reason": sevr,
                        "comp": p.get("comp"),
                    })
        except Exception:  # noqa: BLE001
            continue
    return sev_examples, golden_pool


def build_from_pg(datasets: Path, out_dir: Path, log=print):
    """Build every dashboard payload directly from PostgreSQL 16 + Multi-Frame Zstd."""
    started = time.time()
    _, connect_direct, UserRules, pread_json = _ensure_pg()
    cfg = _load_pg_config()
    data_root = cfg.data_root
    cache_dir = build.cache_root(out_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "samples").mkdir(parents=True, exist_ok=True)

    timers: dict[str, float] = {}
    with connect_direct(cfg, app_name="dashboard_build") as conn:
        t0 = time.time()
        wm = _pg_watermark(conn, datasets)
        marker_path = cache_dir / "pg-build-marker.json"
        has_ab = bool(conn.execute("SELECT 1 FROM public.ab_rounds WHERE product='aime' LIMIT 1").fetchone())
        has_bench = bool(
            conn.execute(
                "SELECT 1 FROM public.bench_sets WHERE product='aime' AND bench_type IN ('pool','tier','long') LIMIT 1"
            ).fetchone()
        )
        ab_expected = {"aime"} if has_ab else set()
        bench_expected = {"aime"} if has_bench else set()

        try:
            prev_marker = json.loads(marker_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            prev_marker = None

        if (
            isinstance(prev_marker, dict)
            and prev_marker.get("watermark") == wm
            and (cache_dir / "pg-slug-map.json").is_file()
            and (out_dir / "data.json").is_file()
            and (out_dir / "samples.json").is_file()
            and build.payload_files_exist(out_dir, ab_expected, bench_expected)
        ):
            summary = Counter({
                "pairs": int(prev_marker.get("pairs") or 0),
                "pairing": "pg",
                "reused": 1,
                "seconds": round(time.time() - started, 1),
            })
            return (None, None), summary

        taxonomy = _load_pg_taxonomy(conn, data_root)
        timers["cluster"] = round(time.time() - t0, 1)

        # 1. Users map
        t0 = time.time()
        rules = UserRules.from_file(data_root / "config" / "user_rules.json")
        user_map: dict[str, tuple[str, bool]] = {}
        for r in conn.execute("SELECT user_id, user_type, is_lost FROM public.users").fetchall():
            user_map[r["user_id"]] = (r["user_type"] or "unknown", bool(r["is_lost"]))

        # 2. Load eval_inputs (feeds both `input` volume card, `daily` denominators, and output joins)
        inputs_by_id: dict[int, dict[str, Any]] = {}
        in_records_total = 0
        in_traces_total = 0
        in_tool_calls = 0
        in_tokens_in = 0
        in_tokens_out = 0
        in_cache_read = 0
        in_by_model: dict[str, dict[str, Any]] = {}
        in_sessions_all: set[tuple[str, str, str]] = set()
        daily_in_records: Counter[tuple[str, str, str]] = Counter()
        daily_in_traces: Counter[tuple[str, str, str]] = Counter()
        daily_in_sids: dict[tuple[str, str, str], set[int]] = defaultdict(set)
        sid_num: dict[str, int] = {}

        with conn.cursor(name="dash_inputs_cur") as cur:
            cur.itersize = 20000
            cur.execute(
                """
                SELECT input_id, model, trace_id, session_id, user_id, source,
                       runtime_mode, biz_day, request_time, question_text,
                       n_messages, total_tokens, input_tokens, output_tokens,
                       cache_read_tokens, tool_count, latency_ms, has_visual,
                       task_category, subtask_category, has_input_blob
                FROM public.eval_inputs
                WHERE product = 'aime' AND NOT is_deleted
                """
            )
            for r in cur:
                iid = int(r["input_id"])
                m = r["model"]
                sid = r["session_id"] or ""
                uid = r["user_id"] or ""
                day = r["biz_day"].isoformat()
                req_iso = _iso_dt(r["request_time"])
                task = (r["task_category"] or "").strip() or None
                sub = (r["subtask_category"] or "").strip() or None
                t_in = int(r["input_tokens"] or 0)
                t_out = int(r["output_tokens"] or 0)
                t_tot = int(r["total_tokens"]) if r["total_tokens"] is not None else (t_in + t_out)
                t_cache = int(r["cache_read_tokens"] or 0)
                tc = int(r["tool_count"] or 0)
                has_blob = bool(r["has_input_blob"])

                if uid:
                    um = user_map.get(uid)
                    if um is not None:
                        ut, is_lost = um
                    else:
                        ut, _is_real, is_lost = rules.classify(uid)
                else:
                    ut, is_lost = "unknown", False

                inputs_by_id[iid] = {
                    "model": m,
                    "trace_id": r["trace_id"],
                    "session_id": sid,
                    "user_id": uid,
                    "ut": ut,
                    "is_lost": is_lost,
                    "source": r["source"] or "",
                    "mode": r["runtime_mode"],
                    "day": day,
                    "request_time": req_iso,
                    "question": r["question_text"] or "",
                    "n_messages": int(r["n_messages"] or 0),
                    "total_tokens": t_tot,
                    "input_tokens": r["input_tokens"],
                    "output_tokens": r["output_tokens"],
                    "tool_count": tc,
                    "latency_ms": r["latency_ms"],
                    "has_visual": bool(r["has_visual"]),
                    "task": task,
                    "sub": sub,
                    "has_blob": has_blob,
                }

                if has_blob:
                    in_records_total += 1
                    in_traces_total += 1
                    in_tool_calls += tc
                    in_tokens_in += t_in
                    in_tokens_out += t_out
                    in_cache_read += t_cache
                    ms = in_by_model.get(m)
                    if ms is None:
                        ms = in_by_model[m] = {
                            "traces": 0,
                            "tool_calls": 0,
                            "tokens_in": 0,
                            "tokens_out": 0,
                            "cache_read": 0,
                            "tasks": {},
                        }
                    ms["traces"] += 1
                    ms["tool_calls"] += tc
                    ms["tokens_in"] += t_in
                    ms["tokens_out"] += t_out
                    ms["cache_read"] += t_cache
                    tname = task or build.NO_SCENE
                    tnode = ms["tasks"].get(tname)
                    if tnode is None:
                        tnode = ms["tasks"][tname] = {"n": 0, "lost": 0, "sub": {}}
                    tnode["n"] += 1
                    if is_lost:
                        tnode["lost"] += 1
                    if sub:
                        snode = tnode["sub"].get(sub)
                        if snode is None:
                            snode = tnode["sub"][sub] = {"n": 0, "lost": 0}
                        snode["n"] += 1
                        if is_lost:
                            snode["lost"] += 1
                    if sid:
                        in_sessions_all.add(("daily", m, sid))
                        daily_in_sids[(day, m, "daily")].add(sid_num.setdefault(sid, len(sid_num)))
                    daily_in_records[(day, m, "daily")] += 1
                    daily_in_traces[(day, m, "daily")] += 1

        # Build input_payload dict matching build.input_payload()
        sess_by_model = Counter(m for _sp, m, _sid in in_sessions_all)
        in_models_out = {}
        top_tasks: dict[str, dict[str, Any]] = {}
        for m, ms in in_by_model.items():
            in_models_out[m] = {
                "label": build.MODEL_LABEL.get(m, m),
                "traces": ms["traces"],
                "tool_calls": ms["tool_calls"],
                "tokens_in": ms["tokens_in"],
                "tokens_out": ms["tokens_out"],
                "cache_read": ms["cache_read"],
                "lost": sum(t["lost"] for t in ms["tasks"].values()),
                "tasks": build._task_nodes(ms["tasks"]),
                "sessions": int(sess_by_model.get(m, 0)),
            }
            for tname, node in ms["tasks"].items():
                dst = top_tasks.setdefault(tname, {"n": 0, "lost": 0, "sub": {}})
                dst["n"] += node["n"]
                dst["lost"] += node["lost"]
                for sname, sv in node["sub"].items():
                    sdst = dst["sub"].setdefault(sname, {"n": 0, "lost": 0})
                    sdst["n"] += sv["n"]
                    sdst["lost"] += sv["lost"]
        input_vol_payload = {
            "records": in_records_total,
            "traces": in_traces_total,
            "tool_calls": in_tool_calls,
            "tokens_in": in_tokens_in,
            "tokens_out": in_tokens_out,
            "cache_read": in_cache_read,
            "lost": sum(t["lost"] for t in top_tasks.values()),
            "tasks": build._task_nodes(top_tasks),
            "models": in_models_out,
            "sessions": len(in_sessions_all),
        }
        daily_in_sids_sorted = {k: sorted(v) for k, v in daily_in_sids.items()}
        timers["inputs"] = round(time.time() - t0, 1)

        # 3. Load latest eval_outputs & eval_problems
        t0 = time.time()
        probs_by_oid: dict[int, list[dict[str, Any]]] = defaultdict(list)
        with conn.cursor(name="dash_probs_cur") as cur:
            cur.itersize = 50000
            cur.execute(
                """
                SELECT p.output_id, p.scope, p.turn_index, p.problem_index,
                       p.severity, p.component, p.component_family, p.label,
                       p.evidence_count, p.located_count, p.cluster_code, p.l1_stage,
                       p.tags, p.extra->>'role' AS explicit_role
                FROM public.eval_problems p
                JOIN public.eval_outputs o ON o.output_id = p.output_id
                WHERE o.product = 'aime' AND o.is_latest
                ORDER BY p.output_id, CASE WHEN p.scope='turn' THEN 0 ELSE 1 END, p.turn_index, p.problem_index
                """
            )
            for r in cur:
                oid = int(r["output_id"])
                code = r["cluster_code"]
                sev = r["severity"] if r["severity"] in build.SEVERITIES else None
                role = _infer_role(r["component"], r["component_family"], r["l1_stage"], r["explicit_role"])
                ev_n = int(r["evidence_count"] or 0)
                ev_loc = int(r["located_count"] or 0)
                comp_prefix = (r["component"] or "—").split(":")[0].strip() or "—"
                probs_by_oid[oid].append({
                    "id": len(probs_by_oid[oid]),
                    "turn": int(r["turn_index"] or 0) if r["scope"] == "turn" else None,
                    "sev": sys.intern(sev) if sev else None,
                    "label": r["label"] or "",
                    "comp": sys.intern(r["component"]) if r["component"] else None,
                    "fam": sys.intern(r["component_family"]) if r["component_family"] else None,
                    "role": sys.intern(role),
                    "ev_s": [ev_n, ev_loc, [sys.intern(comp_prefix)] * min(ev_n, 4)],
                    "cl": (
                        {"path": sys.intern(code), "tags": [sys.intern(t) for t in (r["tags"] or ())]}
                        if code
                        else None
                    ),
                })

        hr_oids = {
            int(r["output_id"])
            for r in conn.execute(
                "SELECT DISTINCT output_id FROM public.human_read_overlays WHERE status = 'done'"
            ).fetchall()
        }

        samples_list: list[tuple[str, dict[str, Any], dict[str, Any], dict[str, Any]]] = []
        slug_seen: dict[str, str] = {}
        slug_map: dict[str, list[int]] = {}
        slug_by_oid: dict[int, str] = {}
        trace_refs: dict[str, tuple[str, str]] = {}
        compacted_cnt = 0

        with conn.cursor(name="dash_outputs_cur") as cur:
            cur.itersize = 20000
            cur.execute(
                """
                SELECT output_id, input_id, model, trace_id, biz_day, max_severity,
                       p0_cnt, p1_cnt, p2_cnt, p3_cnt, p4_cnt, problem_count,
                       is_correct, compact_file_id IS NOT NULL AS has_compact
                FROM public.eval_outputs
                WHERE product = 'aime' AND is_latest
                ORDER BY output_id ASC
                """
            )
            for r in cur:
                oid = int(r["output_id"])
                iid = int(r["input_id"])
                inp = inputs_by_id.get(iid)
                if inp is None:
                    continue
                m = r["model"]
                tid = r["trace_id"]
                day = r["biz_day"].isoformat()
                slug = _assign_pg_slug("aime", m, tid, slug_seen)
                slug_map[slug] = [iid, oid]
                slug_by_oid[oid] = slug

                plist = probs_by_oid.pop(oid, [])
                worst = r["max_severity"] if r["max_severity"] in build.SEVERITIES else "none"
                sv = [int(r["p0_cnt"]), int(r["p1_cnt"]), int(r["p2_cnt"]), int(r["p3_cnt"]), int(r["p4_cnt"])]
                roles_set = sorted(
                    {p["role"] for p in plist if p.get("role")},
                    key=lambda x: build.ROLE_ORDER.index(x) if x in build.ROLE_ORDER else 99,
                )
                stages_set = sorted(
                    {p["cl"]["path"].split(".")[0] for p in plist if p.get("cl")},
                    key=lambda x: build.STAGE_ORDER.index(x) if x in build.STAGE_ORDER else 99,
                )
                pats_set = sorted({p["cl"]["path"] for p in plist if p.get("cl")})
                tags_set = sorted({tg for p in plist if p.get("cl") for tg in p["cl"]["tags"]})
                labels_joined = "｜".join(p["label"] for p in plist)[:600]

                q = inp["question"]
                lang = build.lang_of(q)
                sid = inp["session_id"] or None
                tr_count = 1 if inp["has_blob"] else 0
                has_comp = bool(r["has_compact"])
                if has_comp:
                    compacted_cnt += 1

                row: dict[str, Any] = {
                    "s": slug,
                    "q": build.clip(q, 160),
                    "m": sys.intern(m),
                    "sp": "daily",
                    "d": day,
                    "idate": day,
                    "inp": 1 if inp["has_blob"] else 0,
                    "im": sys.intern(m),
                    "isp": "daily",
                    "sid": sid,
                    "tid": tid,
                    "w": worst,
                    "n": len(plist),
                    "sv": sv,
                    "r": roles_set,
                    "st": stages_set,
                    "pt": pats_set,
                    "tg": tags_set,
                    "lb": labels_joined,
                    "tr": tr_count,
                    "mc": inp["n_messages"],
                    "tc": inp["tool_count"],
                    "lang": lang,
                    "ut": inp["ut"],
                }
                if inp["task"]:
                    row["task"] = sys.intern(inp["task"])
                if inp["sub"]:
                    row["sub"] = sys.intern(inp["sub"])
                if inp["user_id"]:
                    row["uid"] = inp["user_id"]
                if inp["is_lost"]:
                    row["ul"] = 1
                if oid in hr_oids:
                    row["hr"] = 1

                ev_tot = sum(p["ev_s"][0] for p in plist)
                ev_loc = sum(p["ev_s"][1] for p in plist)
                w_idx = build.SEVERITIES.index(worst) if worst in build.SEVERITIES else 5
                ts_counts = [0, 0, 0, 0, 0, 0]
                ts_counts[w_idx] = 1
                brief = {
                    "product": "aime",
                    "model": sys.intern(m),
                    "ids": {"session": sid or "", "trace": tid, "case": ""},
                    "meta": {
                        **({"task": sys.intern(inp["task"])} if inp["task"] else {}),
                        **({"subtask": sys.intern(inp["sub"])} if inp["sub"] else {}),
                        **({"request_time": inp["request_time"]} if inp["request_time"] else {}),
                        **({"tokens_in": inp["input_tokens"]} if inp["input_tokens"] is not None else {}),
                        **({"tokens_out": inp["output_tokens"]} if inp["output_tokens"] is not None else {}),
                    },
                    "attribution": {
                        "turns": [{"problems": [p["id"] for p in plist if p["turn"] is not None], "trace_id": tid}],
                        "session_problems": [p["id"] for p in plist if p["turn"] is None],
                        "problems": plist,
                    },
                    "trace_severity": {
                        "counts": ts_counts,
                        "unresolved": 0,
                        "refs": [[0, w_idx, tid]],
                    },
                    "ev_stats": [ev_tot, ev_loc],
                }
                facts = {
                    "messages": inp["n_messages"],
                    "tool_calls": inp["tool_count"],
                    "traces": tr_count,
                    "kinds": Counter(),
                    "tokens": inp["total_tokens"] or 0,
                    "finish_ms": inp["latency_ms"],
                    "question_len": len(q),
                    "mode": inp["mode"],
                    "comefrom": None,
                    "source": inp["source"],
                    "has_visual": inp["has_visual"],
                    "compact": (
                        {
                            "summary": True,
                            "turns": 1,
                            "counts": {k: 0 for k in build.COMPACT_STEPS},
                            "kinds": {},
                            "names": {},
                        }
                        if has_comp
                        else None
                    ),
                    "correct": r["is_correct"],
                }
                samples_list.append((slug, brief, row, facts))
                trace_refs[tid] = (slug, f"daily|{m}|{sid or slug}")

        del inputs_by_id, probs_by_oid
        gc.collect()
        timers["samples"] = round(time.time() - t0, 1)

        if not samples_list:
            return build.empty_payloads("no-pairs"), Counter({"pairs": 0, "pairing": "pg"})

        # 4. Aggregate using existing build.py functions for 100% frontend JSON parity
        t0 = time.time()
        product_payload = build.aggregate("aime", samples_list, taxonomy)
        product_payload["input"] = input_vol_payload
        product_payload["kpi"]["inputs"] = input_vol_payload["records"]
        product_payload["kpi"]["lost"] = input_vol_payload["lost"]
        product_payload["kpi"]["compacted"] = compacted_cnt
        product_payload["daily"], product_payload["daily_summary"] = build.build_daily(
            samples_list, daily_in_records, daily_in_sids_sorted, daily_in_traces
        )
        used_patterns = {
            p["cl"]["path"]
            for _, d, _, _ in samples_list
            for p in d["attribution"]["problems"]
            if p.get("cl")
        }

        generated = iso_now()
        rows_sorted = sorted(
            samples_list,
            key=lambda s: (build.WORST_KEYS.index(s[2]["w"]), -s[2]["n"], s[2]["d"]),
        )
        build.mark_evaluated(product_payload["input"], [s[2] for s in rows_sorted])

        # Severity examples + golden cases via O(1) Zstd pread on ~25 rows
        sev_examples, golden_pool = _sample_goldens_and_sevr(conn, data_root, slug_by_oid, pread_json)
        sys_facts = build.system_facts(samples_list, {"aime": golden_pool})
        for sev_k, items in sev_examples.items():
            if items:
                sys_facts["severity_examples"][sev_k] = items

        # AB & Dynamic Bench directly from PG
        ab_payload = _build_pg_ab_payload(conn, data_root, generated, taxonomy)
        bench_result = _build_pg_bench(conn, taxonomy, trace_refs, generated)
        timers["aggregate"] = round(time.time() - t0, 1)

        # 5. Write all static payloads + prewarm + slug map + watermark
        t0 = time.time()
        ab_bytes = 0
        if ab_payload:
            latest = ab_payload["rounds"][-1]
            product_payload["ab"] = {
                "url": "abtests-aime.json",
                "rounds": len(ab_payload["rounds"]),
                "label": latest["label"],
                "targets": latest["targets"],
                "paired": latest["sides"]["after"] is not None,
            }
            ab_bytes += build.write_json(out_dir / "abtests-aime.json", ab_payload)

        shared = {
            "schema": 2,
            "generated_at": generated,
            "source": {
                "mode": "pg",
                "pairs": len(samples_list),
                "root": data_root.name,
                "timings": timers,
            },
            "taxonomy": build.taxonomy_out(taxonomy, used_patterns) if taxonomy["stages"] else None,
            "system": sys_facts,
            "products": {
                "aime": {
                    "label": build.PRODUCTS["aime"]["label"],
                    "clusters": {
                        p["id"]: p["n"]
                        for p in (product_payload.get("patterns") or [])
                        if p.get("n")
                    },
                }
            },
        }
        aime_index = {
            "schema": 2,
            "generated_at": generated,
            "product": "aime",
            "available": ["aime"],
            "products": {
                "aime": {
                    "label": build.PRODUCTS["aime"]["label"],
                    "models": [{"id": m["id"], "label": m["label"]} for m in product_payload["models"]],
                    "splits": product_payload["splits"],
                    "rows": [{k: s[2][k] for k in build.INDEX_FIELDS if k in s[2]} for s in rows_sorted],
                }
            },
        }
        aime_labels = {
            "schema": 2,
            "product": "aime",
            "labels": [s[2].get(build.LABEL_FIELD) or "" for s in rows_sorted],
        }
        index_shell = {
            "schema": 2,
            "generated_at": generated,
            "products": {
                "aime": {
                    "label": build.PRODUCTS["aime"]["label"],
                    "rows": len(samples_list),
                    "url": "samples-aime.json",
                }
            },
        }

        data_bytes = build.write_json(
            out_dir / "data-aime.json",
            {"schema": 2, "generated_at": generated, "product": "aime", "products": {"aime": product_payload}},
        )
        trend_bytes = build.write_trend_artifacts(
            out_dir, "aime",
            build.trend_payload("aime", samples_list, _release_entries_pg(data_root, datasets, "aime"), generated),
        )
        data_bytes += build.write_json(out_dir / "data.json", shared)
        index_bytes = build.write_json(out_dir / "samples.json", index_shell)
        index_bytes += build.write_json(out_dir / "samples-aime.json", aime_index)
        index_bytes += build.write_json(out_dir / "recall-aime.json", build.recall_head(aime_index, "aime"))
        index_bytes += build.write_json(out_dir / "labels-aime.json", aime_labels)

        if bench_result is not None:
            b_summary, b_index = bench_result
            build.write_json(out_dir / "bench-aime.json", b_summary)
            build.replace_bytes(
                out_dir / "bench_index-aime.json",
                json.dumps(b_index, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            )
        else:
            b_fallback = build.bench_payload(datasets, "aime", samples_list, {r[2]["tid"]: r[0] for r in samples_list if r[2].get("tid")})
            b_fallback["generated_at"] = generated
            build.write_json(out_dir / "bench-aime.json", b_fallback)

        build.write_prewarm(
            out_dir,
            {"aime": build.prewarm_picks(aime_index["products"]["aime"]["rows"])},
        )
        build.replace_bytes(
            cache_dir / "pg-slug-map.json",
            json.dumps(slug_map, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )
        build.replace_bytes(
            marker_path,
            json.dumps({"watermark": wm, "pairs": len(samples_list), "at": generated}).encode("utf-8"),
        )
        build.cleanup_samples(out_dir / "samples", list(slug_map.keys()))
        timers["write"] = round(time.time() - t0, 1)

        summary = Counter({
            "pairs": len(samples_list),
            "details": len(samples_list),
            "pairing": "pg",
            "data_kb": round(data_bytes / 1024),
            "trend_kb": round(trend_bytes / 1024),
            "ab_kb": round(ab_bytes / 1024),
            "index_kb": round(index_bytes / 1024),
            **{f"t_{k}": v for k, v in timers.items()},
            "seconds": round(time.time() - started, 1),
        })
        return (shared, index_shell), summary


# --------------------------------------------------------------------------- PG Detail Builder (5001 /samples/<slug>.json)

class PGDetailBuilder:
    """Lazy O(1) Zstd sample detail generator backed by PostgreSQL 16."""

    def __init__(self, sample_dir: Path | str, cache_dir: Path | str):
        self.sample_dir = Path(sample_dir)
        self.cache_dir = Path(cache_dir)
        self.sample_dir.mkdir(parents=True, exist_ok=True)
        self.version_file = self.sample_dir / ".build-version"
        self.version_stamp = self._sync_version()
        self._cfg = _load_pg_config()
        _, self._connect_direct, _, self._pread_json = _ensure_pg()
        self._slug_lock = threading.Lock()
        self._slug_map: dict[str, list[int]] = {}
        self._slug_map_mtime = 0.0
        self._per_slug_locks: dict[str, threading.Lock] = {}
        self._per_slug_guard = threading.Lock()

    def _sync_version(self) -> float:
        ver = f"pg-{PG_BACKEND_VERSION}"
        try:
            cur = self.version_file.read_text(encoding="utf-8").strip()
        except OSError:
            cur = ""
        if cur != ver:
            try:
                self.version_file.write_text(ver, encoding="utf-8")
            except OSError:
                pass
            return time.time()
        try:
            return self.version_file.stat().st_mtime
        except OSError:
            return 0.0

    def _lock_for(self, slug: str) -> threading.Lock:
        with self._per_slug_guard:
            lk = self._per_slug_locks.get(slug)
            if lk is None:
                if len(self._per_slug_locks) > 4096:
                    self._per_slug_locks.clear()
                lk = self._per_slug_locks[slug] = threading.Lock()
            return lk

    def _lookup_ids(self, slug: str) -> tuple[int, int] | None:
        map_path = self.cache_dir / "pg-slug-map.json"
        try:
            mtime = map_path.stat().st_mtime
        except OSError:
            return None
        with self._slug_lock:
            if mtime != self._slug_map_mtime or not self._slug_map:
                try:
                    self._slug_map = json.loads(map_path.read_text(encoding="utf-8"))
                    self._slug_map_mtime = mtime
                except (OSError, ValueError):
                    return None
            hit = self._slug_map.get(slug)
        return (int(hit[0]), int(hit[1])) if hit and len(hit) == 2 else None

    def ensure(self, slug: str) -> Path | None:
        if not SLUG_RE.match(slug or ""):
            return None
        ids = self._lookup_ids(slug)
        if not ids:
            return None
        input_id, output_id = ids
        path = self.sample_dir / f"{slug}.json"
        with self._lock_for(slug):
            with self._connect_direct(self._cfg, app_name="dashboard_detail") as conn:
                row = conn.execute(
                    """
                    SELECT i.input_id, i.product, i.model, i.biz_day, i.updated_at AS in_upd,
                           ipf.rel_path AS in_path, i.input_offset, i.input_len,
                           o.output_id, o.updated_at AS out_upd,
                           apf.rel_path AS attr_path, o.attr_offset, o.attr_len,
                           cpf.rel_path AS comp_path, o.compact_offset, o.compact_len,
                           hra.updated_at AS hra_upd, hrapf.rel_path AS hra_path, hra.hr_offset AS hra_off, hra.hr_len AS hra_len,
                           hrc.updated_at AS hrc_upd, hrcpf.rel_path AS hrc_path, hrc.hr_offset AS hrc_off, hrc.hr_len AS hrc_len
                    FROM public.eval_outputs o
                    JOIN public.eval_inputs i ON i.input_id = o.input_id
                    LEFT JOIN public.pack_files ipf ON ipf.file_id = i.input_file_id
                    LEFT JOIN public.pack_files apf ON apf.file_id = o.attr_file_id
                    LEFT JOIN public.pack_files cpf ON cpf.file_id = o.compact_file_id
                    LEFT JOIN public.human_read_overlays hra ON hra.output_id = o.output_id AND hra.target_kind = 'attribution' AND hra.status = 'done'
                    LEFT JOIN public.pack_files hrapf ON hrapf.file_id = hra.hr_file_id
                    LEFT JOIN public.human_read_overlays hrc ON hrc.output_id = o.output_id AND hrc.target_kind = 'compact' AND hrc.status = 'done'
                    LEFT JOIN public.pack_files hrcpf ON hrcpf.file_id = hrc.hr_file_id
                    WHERE o.output_id = %s AND i.input_id = %s
                    """,
                    (output_id, input_id),
                ).fetchone()
                if not row or not row["attr_path"]:
                    return None
                probs = [
                    dict(r)
                    for r in conn.execute(
                        """
                        SELECT scope, turn_index, problem_index, label, cluster_code, is_edge, tags, clustered_at
                        FROM public.eval_problems
                        WHERE output_id = %s
                        ORDER BY CASE WHEN scope='turn' THEN 0 ELSE 1 END, turn_index, problem_index
                        """,
                        (output_id,),
                    ).fetchall()
                ]

            need_ns = max(
                int(self.version_stamp * 1_000_000_000),
                _dt_to_ns(row["in_upd"]),
                _dt_to_ns(row["out_upd"]),
                _dt_to_ns(row["hra_upd"]),
                _dt_to_ns(row["hrc_upd"]),
                max((_dt_to_ns(p.get("clustered_at")) for p in probs), default=0),
            )
            try:
                if path.stat().st_mtime_ns >= need_ns - FS_CLOCK_SLACK_NS:
                    build.ensure_detail_gz(path)
                    return path
            except OSError:
                pass

            root = self._cfg.data_root
            attr = self._pread_json(root / row["attr_path"], int(row["attr_offset"]), int(row["attr_len"]))
            inp = (
                self._pread_json(root / row["in_path"], int(row["input_offset"]), int(row["input_len"]))
                if row["in_path"] and row["input_len"]
                else None
            )
            comp = (
                self._pread_json(root / row["comp_path"], int(row["compact_offset"]), int(row["compact_len"]))
                if row["comp_path"] and row["compact_len"]
                else None
            )
            pair = {
                "product": row["product"],
                "model": row["model"],
                "date": row["biz_day"].isoformat(),
                "split": "daily",
                "input": None,
                "compact": None,
                "output": None,
            }
            detail, _, _ = build.build_sample(pair, inp, attr, comp, {}, Counter())
            _attach_pg_problem_clusters(detail, probs)

            hr_attr = (
                self._pread_json(root / row["hra_path"], int(row["hra_off"]), int(row["hra_len"]))
                if row["hra_path"] and row["hra_len"]
                else None
            )
            hr_comp = (
                self._pread_json(root / row["hrc_path"], int(row["hrc_off"]), int(row["hrc_len"]))
                if row["hrc_path"] and row["hrc_len"]
                else None
            )
            hr_applied = False
            if hr_attr or hr_comp:
                hr_applied = _overlay_pg_human_read_detail(detail, hr_attr, hr_comp)
            detail["human_read"] = bool(hr_applied)

            detail["slug"] = slug
            build.write_json(path, detail)
            return path

    def prewarm(self, slugs: list[str]) -> int:
        from concurrent.futures import ThreadPoolExecutor

        workers = min(8, max(1, len(slugs)))

        def one(s: str) -> bool:
            try:
                return bool(self.ensure(s))
            except Exception:  # noqa: BLE001
                return False

        with ThreadPoolExecutor(max_workers=workers) as pool:
            return sum(1 for ok in pool.map(one, slugs) if ok)


# --------------------------------------------------------------------------- PG AB Detail Builder

class PGABDetailBuilder:
    """Lazy O(1) Zstd AB detail & GPT reference answer builder backed by PG 16."""

    def __init__(self, sample_dir: Path | str):
        self.sample_dir = Path(sample_dir)
        self.sample_dir.mkdir(parents=True, exist_ok=True)
        self._cfg = _load_pg_config()
        _, self._connect_direct, _, self._pread_json = _ensure_pg()
        self._locks: dict[tuple[str, str], threading.Lock] = {}
        self._guard = threading.Lock()

    def warm(self) -> None:
        return None

    def _lock_for(self, key: tuple[str, str]) -> threading.Lock:
        with self._guard:
            lk = self._locks.get(key)
            if lk is None:
                if len(self._locks) > 2048:
                    self._locks.clear()
                lk = self._locks[key] = threading.Lock()
            return lk

    @staticmethod
    def _parse_ref(ref) -> tuple[str, int] | None:
        if isinstance(ref, int):
            return ("after", ref) if ref > 0 else None
        m = AB_REF_RE.match(str(ref or "").strip())
        if not m:
            return None
        side = m.group(1) or "after"
        eq = int(m.group(2))
        return (side, eq) if eq > 0 else None

    def ensure(self, round_id: str, ref) -> Path | None:
        parsed = self._parse_ref(ref)
        if not parsed:
            return None
        side, eq = parsed
        file_stem = str(ref).strip()
        path = self.sample_dir / round_id / f"{file_stem}.json"

        with self._lock_for((round_id, file_stem)):
            with self._connect_direct(self._cfg, app_name="dashboard_ab_detail") as conn:
                if side == "before":
                    cand_where = "(c.is_baseline OR c.candidate_idx = 1)"
                    cand_params: tuple[Any, ...] = (round_id, eq)
                elif side == "after":
                    cand_where = "(NOT c.is_baseline AND c.source_mode IN ('live', 'slice'))"
                    cand_params = (round_id, eq)
                else:
                    cand_where = "c.candidate_key = %s"
                    cand_params = (round_id, eq, side)

                row = conn.execute(
                    f"""
                    SELECT r.product, r.model, r.released_at,
                           c.candidate_id, c.candidate_key, c.source_mode,
                           t.source_trace_id,
                           cc.case_id, cc.trace_id AS side_trace_id, cc.updated_at,
                           cc.linked_input_id, cc.linked_output_id,
                           ipf.rel_path AS in_path, cc.input_offset, cc.input_len,
                           apf.rel_path AS attr_path, cc.attr_offset, cc.attr_len,
                           cpf.rel_path AS comp_path, cc.compact_offset, cc.compact_len,
                           hpf.rel_path AS hr_path, cc.hr_offset, cc.hr_len
                    FROM public.ab_rounds r
                    JOIN public.ab_candidates c ON c.round_id = r.round_id
                    JOIN public.ab_candidate_cases cc ON cc.round_id = r.round_id AND cc.candidate_id = c.candidate_id
                    JOIN public.ab_targets t ON t.target_id = cc.target_id
                    LEFT JOIN public.pack_files ipf ON ipf.file_id = cc.input_file_id
                    LEFT JOIN public.pack_files apf ON apf.file_id = cc.attr_file_id
                    LEFT JOIN public.pack_files cpf ON cpf.file_id = cc.compact_file_id
                    LEFT JOIN public.pack_files hpf ON hpf.file_id = cc.hr_file_id
                    WHERE r.round_key = %s AND cc.eq_index = %s AND {cand_where}
                    ORDER BY c.candidate_idx ASC
                    LIMIT 1
                    """,
                    cand_params,
                ).fetchone()
                if not row:
                    return None

                # Zero-copy slice fallback to daily packs when AB case links directly to daily rows
                in_ptr = (row["in_path"], row["input_offset"], row["input_len"])
                attr_ptr = (row["attr_path"], row["attr_offset"], row["attr_len"])
                comp_ptr = (row["comp_path"], row["compact_offset"], row["compact_len"])
                if not attr_ptr[0] and row["linked_output_id"]:
                    drow = conn.execute(
                        """
                        SELECT ipf.rel_path AS in_path, i.input_offset, i.input_len,
                               apf.rel_path AS attr_path, o.attr_offset, o.attr_len,
                               cpf.rel_path AS comp_path, o.compact_offset, o.compact_len
                        FROM public.eval_outputs o
                        JOIN public.eval_inputs i ON i.input_id = o.input_id
                        LEFT JOIN public.pack_files ipf ON ipf.file_id = i.input_file_id
                        LEFT JOIN public.pack_files apf ON apf.file_id = o.attr_file_id
                        LEFT JOIN public.pack_files cpf ON cpf.file_id = o.compact_file_id
                        WHERE o.output_id = %s
                        """,
                        (row["linked_output_id"],),
                    ).fetchone()
                    if drow:
                        if not in_ptr[0]:
                            in_ptr = (drow["in_path"], drow["input_offset"], drow["input_len"])
                        attr_ptr = (drow["attr_path"], drow["attr_offset"], drow["attr_len"])
                        if not comp_ptr[0]:
                            comp_ptr = (drow["comp_path"], drow["compact_offset"], drow["compact_len"])
                if not attr_ptr[0]:
                    return None

                probs = [
                    dict(p)
                    for p in conn.execute(
                        """
                        SELECT scope, turn_index, problem_index, label, cluster_code, is_edge
                        FROM public.ab_candidate_problems
                        WHERE case_id = %s
                        ORDER BY CASE WHEN scope='turn' THEN 0 ELSE 1 END, turn_index, problem_index
                        """,
                        (row["case_id"],),
                    ).fetchall()
                ]

            need_ns = _dt_to_ns(row["updated_at"])
            try:
                if path.stat().st_mtime_ns >= need_ns - FS_CLOCK_SLACK_NS:
                    build.ensure_detail_gz(path)
                    return path
            except OSError:
                pass

            root = self._cfg.data_root
            attr = self._pread_json(root / attr_ptr[0], int(attr_ptr[1]), int(attr_ptr[2]))
            inp = self._pread_json(root / in_ptr[0], int(in_ptr[1]), int(in_ptr[2])) if in_ptr[0] and in_ptr[2] else None
            comp = self._pread_json(root / comp_ptr[0], int(comp_ptr[1]), int(comp_ptr[2])) if comp_ptr[0] and comp_ptr[2] else None
            hr_delta = self._pread_json(root / row["hr_path"], int(row["hr_offset"]), int(row["hr_len"])) if row["hr_path"] and row["hr_len"] else None

            smeta = attr.get("session_meta") or {}
            imeta = (inp or {}).get("meta") or {}
            day = local_day(imeta.get("request_time") or smeta.get("request_time"), "aime") or (
                row["released_at"].isoformat() if isinstance(row["released_at"], date) else ""
            )
            pair = {
                "product": row["product"],
                "model": ab_test._short_model(row["model"]),
                "date": day,
                "split": side,
                "input": None,
                "compact": None,
                "output": None,
            }
            detail, _, _ = build.build_sample(pair, inp, attr, comp, {}, Counter())
            _attach_pg_problem_clusters(detail, probs)
            if hr_delta:
                _overlay_pg_human_read_detail(detail, hr_delta, None)

            target_trace = str(row["source_trace_id"] or "")
            side_trace = str(row["side_trace_id"] or "")
            detail["ab"] = {"round": round_id, "side": side, "eq": eq, "trace": target_trace}
            if side_trace and side_trace != target_trace:
                detail["ab"]["side_trace"] = side_trace
            build.write_json(path, detail)
            build.ensure_detail_gz(path)
            return path

    def gpt(self, round_id: str, key: str) -> dict[str, Any] | None:
        if not re.fullmatch(r"[0-9A-Za-z_-]+", str(key or "")):
            return None
        with self._connect_direct(self._cfg, app_name="dashboard_ab_gpt") as conn:
            row = conn.execute(
                """
                SELECT pf.rel_path, cc.input_offset, cc.input_len
                FROM public.ab_rounds r
                JOIN public.ab_candidates c ON c.round_id = r.round_id AND c.source_mode = 'answer_only'
                JOIN public.ab_candidate_cases cc ON cc.round_id = r.round_id AND cc.candidate_id = c.candidate_id
                JOIN public.ab_targets t ON t.target_id = cc.target_id
                JOIN public.pack_files pf ON pf.file_id = cc.input_file_id
                WHERE r.round_key = %s AND (cc.trace_id = %s OR t.source_trace_id = %s)
                LIMIT 1
                """,
                (round_id, key, key),
            ).fetchone()
        if not row or not row["rel_path"] or not row["input_len"]:
            return None
        wrapped = self._pread_json(self._cfg.data_root / row["rel_path"], int(row["input_offset"]), int(row["input_len"]))
        payload = wrapped.get("answer") if isinstance(wrapped, dict) and isinstance(wrapped.get("answer"), dict) else wrapped
        if not isinstance(payload, dict):
            return None
        response = payload.get("response") if isinstance(payload.get("response"), dict) else {}
        texts, sources, searches = [], [], []
        seen_urls, seen_queries = set(), set()
        for item in response.get("output") or []:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "message":
                for part in item.get("content") or []:
                    if not isinstance(part, dict) or part.get("type") not in ("output_text", "text"):
                        continue
                    text = str(part.get("text") or "")
                    if text.strip():
                        texts.append(text.strip())
                    for ann in part.get("annotations") or []:
                        if isinstance(ann, dict):
                            url = str(ann.get("url") or "")
                            if url and url not in seen_urls:
                                seen_urls.add(url)
                                sources.append({"title": str(ann.get("title") or url), "url": url})
            elif item.get("type") == "web_search_call":
                action = item.get("action") if isinstance(item.get("action"), dict) else {}
                queries = action.get("queries") or ([action.get("query")] if action.get("query") else [])
                for q in queries:
                    qs = str(q or "")
                    if qs and qs not in seen_queries:
                        seen_queries.add(qs)
                        searches.append(qs)
        answer = "\n\n".join(texts).strip()
        if not answer:
            return None
        usage = response.get("usage") if isinstance(response.get("usage"), dict) else {}
        return {
            "key": key,
            "question": str(payload.get("question") or ""),
            "model": str(payload.get("model") or ""),
            "effort": str(payload.get("effort") or ""),
            "question_time": str(payload.get("question_time") or ""),
            "latency_s": payload.get("latency_s"),
            "status": str(response.get("status") or ""),
            "answer": answer,
            "sources": sources,
            "searches": searches,
            "usage": {"input": usage.get("input_tokens"), "output": usage.get("output_tokens")},
        }


# --------------------------------------------------------------------------- PG Input Lister

class PGInputLister:
    """Direct PostgreSQL input listing, bounded input slice, and O(1) Zstd input detail."""

    def __init__(self, cache_dir: Path | str):
        self.cache_dir = Path(cache_dir)
        self._cfg = _load_pg_config()
        _, self._connect_direct, _, self._pread_json = _ensure_pg()
        self._slug_lock = threading.Lock()
        self._oid_to_slug: dict[int, str] = {}
        self._slug_mtime = 0.0

    def warm(self, products) -> None:
        return None

    def prewarm_listings(self, products, days: int = 1) -> None:
        return None

    def _slug_by_oid(self) -> dict[int, str]:
        p = self.cache_dir / "pg-slug-map.json"
        try:
            mt = p.stat().st_mtime
        except OSError:
            return {}
        with self._slug_lock:
            if mt != self._slug_mtime:
                try:
                    raw = json.loads(p.read_text(encoding="utf-8"))
                    self._oid_to_slug = {int(v[1]): k for k, v in raw.items() if isinstance(v, list) and len(v) == 2}
                    self._slug_mtime = mt
                except (OSError, ValueError):
                    pass
            return self._oid_to_slug

    def listing(self, product: str, day: str, model: str, split: str) -> dict[str, Any]:
        lost_clause = "AND COALESCE(u.is_lost, FALSE)" if split == "lost" else ""
        slug_by_oid = self._slug_by_oid()
        with self._connect_direct(self._cfg, app_name="dashboard_inputs") as conn:
            rows = conn.execute(
                f"""
                SELECT i.input_id, i.trace_id, i.session_id, i.question_text,
                       i.task_category, i.request_time,
                       o.output_id, o.p0_cnt, o.p1_cnt, o.p2_cnt, o.p3_cnt, o.p4_cnt
                FROM public.eval_inputs i
                LEFT JOIN public.eval_outputs o ON o.input_id = i.input_id AND o.is_latest
                LEFT JOIN public.users u ON u.user_id = i.user_id
                WHERE i.product = %s AND i.biz_day = %s AND i.model = %s
                  AND NOT i.is_deleted AND i.has_input_blob
                  {lost_clause}
                ORDER BY i.input_id ASC
                """,
                (product, day, model),
            ).fetchall()
        out = []
        max_id = 0
        for r in rows:
            iid = int(r["input_id"])
            if iid > max_id:
                max_id = iid
            oid = int(r["output_id"]) if r["output_id"] is not None else None
            slug = slug_by_oid.get(oid) if oid is not None else None
            item: dict[str, Any] = {
                "r": f"pg:{iid}",
                "q": (r["question_text"] or "")[:200],
                "sid": r["session_id"] or "",
                "tid": r["trace_id"] or "",
                "cat": r["task_category"] or "",
                "tr": 1,
                "rq": _iso_dt(r["request_time"]) or "",
                "ev": 1 if oid is not None else 0,
            }
            if slug:
                item["s"] = slug
            if oid is not None:
                item["sv"] = [int(r["p0_cnt"]), int(r["p1_cnt"]), int(r["p2_cnt"]), int(r["p3_cnt"]), int(r["p4_cnt"])]
            out.append(item)
        return {"version": 5, "sig": [product, day, model, split, len(out), max_id], "files": 1, "rows": out}

    def detail(self, product: str, day: str, model: str, split: str, ref: str) -> dict[str, Any] | None:
        m = re.match(r"^pg:(\d+)$", str(ref or "").strip())
        if not m:
            return None
        input_id = int(m.group(1))
        with self._connect_direct(self._cfg, app_name="dashboard_input_detail") as conn:
            row = conn.execute(
                """
                SELECT i.product, i.model, i.biz_day, i.request_time,
                       pf.rel_path, i.input_offset, i.input_len
                FROM public.eval_inputs i
                JOIN public.pack_files pf ON pf.file_id = i.input_file_id
                WHERE i.input_id = %s AND i.product = %s AND NOT i.is_deleted
                """,
                (input_id, product),
            ).fetchone()
        if not row or not row["rel_path"] or not row["input_len"]:
            return None
        inp = self._pread_json(self._cfg.data_root / row["rel_path"], int(row["input_offset"]), int(row["input_len"]))
        if not isinstance(inp, dict):
            return None
        detail, _, _ = build.build_sample(
            {
                "product": product,
                "model": row["model"],
                "date": row["biz_day"].isoformat(),
                "split": split,
                "input": None,
                "compact": None,
                "output": None,
            },
            inp,
            {},
            None,
            {},
            Counter(),
        )
        detail["slug"] = f"pg{input_id}"
        detail["inputs_only"] = True
        detail.setdefault("meta", {})
        detail["meta"]["request_time"] = detail["meta"].get("request_time") or _iso_dt(row["request_time"])
        return detail

    def slice_inputs(
        self,
        product: str,
        model: str = "",
        task: str = "",
        others: set[str] | None = None,
        cap: int = 500,
    ) -> dict[str, Any]:
        cap = max(1, min(500, int(cap or 500)))
        others_set = set(others or ())
        where = ["i.product = %s", "NOT i.is_deleted", "i.has_input_blob"]
        params: list[Any] = [product]
        if model and model != "all":
            where.append("i.model LIKE %s")
            params.append(f"{model}%")
        if task:
            if task == build.NO_SCENE:
                where.append("(i.task_category IS NULL OR i.task_category = '')")
            else:
                where.append("i.task_category = %s")
                params.append(task)
        elif others_set:
            where.append("COALESCE(NULLIF(i.task_category, ''), %s) <> ALL(%s)")
            params.append(build.NO_SCENE)
            params.append(list(others_set))

        clause = " AND ".join(where)
        slug_by_oid = self._slug_by_oid()
        with self._connect_direct(self._cfg, app_name="dashboard_input_slice") as conn:
            total = int(conn.execute(f"SELECT COUNT(*) AS c FROM public.eval_inputs i WHERE {clause}", params).fetchone()["c"])
            rows = conn.execute(
                f"""
                SELECT i.input_id, i.model, i.biz_day, i.question_text,
                       i.task_category, i.subtask_category, o.output_id
                FROM public.eval_inputs i
                LEFT JOIN public.eval_outputs o ON o.input_id = i.input_id AND o.is_latest
                WHERE {clause}
                ORDER BY i.biz_day DESC, i.input_id DESC
                LIMIT %s
                """,
                [*params, cap],
            ).fetchall()

        collected = []
        for r in rows:
            rtask = (r["task_category"] or "").strip() or build.NO_SCENE
            rsub = (r["subtask_category"] or "").strip()
            oid = int(r["output_id"]) if r["output_id"] is not None else None
            collected.append({
                "q": (r["question_text"] or "")[:200],
                "m": r["model"],
                "sp": "daily",
                "d": r["biz_day"].isoformat(),
                "r": f"pg:{r['input_id']}",
                "tr": 1,
                "ev": 1 if oid is not None else 0,
                "s": slug_by_oid.get(oid, "") if oid is not None else "",
                "cat": rtask,
                "_grp": (rsub or rtask) if (task or others_set) else rtask,
            })

        grp_keys = {it["_grp"] for it in collected}
        if len(grp_keys) <= 1 and len(collected) > 1:
            if len({it["d"] for it in collected if it["d"]}) > 1:
                for it in collected:
                    it["_grp"] = it["d"] or "未知日期"
            elif len({it["m"] for it in collected if it["m"]}) > 1:
                for it in collected:
                    it["_grp"] = it["m"] or "未知模型"

        grouped: dict[str, list[dict[str, Any]]] = {}
        ev_done = ev_pending = 0
        for it in collected:
            gkey = it.pop("_grp", None) or build.NO_SCENE
            if it["ev"]:
                ev_done += 1
            else:
                ev_pending += 1
            grouped.setdefault(gkey, []).append(it)

        groups = [
            {"key": k, "name": k, "total": len(items), "items": items}
            for k, items in sorted(grouped.items(), key=lambda kv: (-len(kv[1]), kv[0]))
        ]
        return {
            "product": product,
            "source": "inputs",
            "total": max(total, len(collected)),
            "recalled": len(collected),
            "cap": cap,
            "capped": total > len(collected),
            "eval_counts": [ev_done, ev_pending],
            "groups": groups,
        }


# --------------------------------------------------------------------------- PG Bench Case & Export

def pg_load_bench_case(row: dict[str, Any]) -> dict[str, Any] | None:
    """Load full Bench case record from PG multi-frame Zstd pack."""
    loc = row.get("loc")
    if not isinstance(loc, (list, tuple)) or len(loc) != 3 or loc[0] != "pg":
        return None
    input_id, output_id = int(loc[1] or 0), int(loc[2] or 0)
    if input_id <= 0:
        return None
    cfg = _load_pg_config()
    _, connect_direct, _, pread_json = _ensure_pg()
    with connect_direct(cfg, app_name="dashboard_bench_case") as conn:
        r = conn.execute(
            """
            SELECT ipf.rel_path AS in_path, i.input_offset, i.input_len,
                   i.question_text, i.source, i.session_round, i.turn_index,
                   i.total_tokens, i.input_tokens, i.tool_count, i.latency_ms,
                   apf.rel_path AS attr_path, o.attr_offset, o.attr_len
            FROM public.eval_inputs i
            LEFT JOIN public.pack_files ipf ON ipf.file_id = i.input_file_id
            LEFT JOIN public.eval_outputs o ON o.output_id = %s
            LEFT JOIN public.pack_files apf ON apf.file_id = o.attr_file_id
            WHERE i.input_id = %s
            """,
            (output_id or -1, input_id),
        ).fetchone()
        probs = (
            [
                dict(p)
                for p in conn.execute(
                    """
                    SELECT severity, label, cluster_code, l1_stage, l2_mechanism, l3_leaf, component
                    FROM public.eval_problems WHERE output_id = %s ORDER BY turn_index, problem_index
                    """,
                    (output_id,),
                ).fetchall()
            ]
            if output_id > 0
            else []
        )
    if not r:
        return None
    inp = pread_json(cfg.data_root / r["in_path"], int(r["input_offset"]), int(r["input_len"])) if r["in_path"] and r["input_len"] else {}
    traces = inp.get("traces") if isinstance(inp, dict) and isinstance(inp.get("traces"), list) else []
    t0 = traces[0] if traces and isinstance(traces[0], dict) else (inp if isinstance(inp, dict) else {})
    msgs = t0.get("messages") if isinstance(t0.get("messages"), list) else []
    pool = (t0.get("message_pool") if isinstance(t0.get("message_pool"), list) else None) or (
        inp.get("message_pool") if isinstance(inp, dict) and isinstance(inp.get("message_pool"), list) else []
    )
    imeta = inp.get("meta") if isinstance(inp, dict) and isinstance(inp.get("meta"), dict) else {}
    rec = {
        "trace_id": row.get("trace_id") or "",
        "session_id": row.get("session_id") or "",
        "model": row.get("model") or "",
        "day": row.get("day") or "",
        "request_time": row.get("request_time") or "",
        "group": row.get("group") or "0_daily_eval",
        "question": r["question_text"] or row.get("question") or "",
        "question_full": r["question_text"] or row.get("question") or "",
        "turn": row.get("turn") or "single",
        "session_round": int(r["session_round"] or row.get("session_round") or 1),
        "turn_index": int(r["turn_index"] or row.get("turn_index") or 1),
        "severity": row.get("severity") or "GOLD",
        "primary": row.get("primary") or {},
        "problems": [
            {
                "severity": p["severity"] or row.get("severity") or "",
                "label": p["label"] or "",
                "path": p["cluster_code"] or "",
                "l1": p["l1_stage"] or "",
                "l2": (p["l2_mechanism"] or "").split(".")[-1] if p["l2_mechanism"] else "",
                "l3": p["l3_leaf"] or p["cluster_code"] or "",
                "component": p["component"] or "",
            }
            for p in probs
        ],
        "messages": msgs,
        "message_pool": pool,
        "stats": row.get("stats") or {},
        "meta": {
            **(row.get("meta") or {}),
            "comefrom": str(imeta.get("comefrom") or ""),
            "source": str(r["source"] or imeta.get("source") or ""),
            "skill_names": [],
        },
        "bench": row.get("bench") or {},
        "slug": row.get("slug"),
        "case_key": row.get("case_key"),
    }
    return rec


def pg_export_bench_jsonl(rows: list[dict[str, Any]], summary: dict[str, Any] | None = None) -> bytes:
    """Batch-fetch PG Zstd inputs for filtered Bench rows and emit compact JSONL bytes."""
    s = summary if isinstance(summary, dict) else {}
    stage_names = s.get("stage_names") if isinstance(s.get("stage_names"), dict) else {}
    mech_names = s.get("mech_names") if isinstance(s.get("mech_names"), dict) else {}
    pat_names = s.get("pat_names") if isinstance(s.get("pat_names"), dict) else {}

    cfg = _load_pg_config()
    _, connect_direct, _, pread_json = _ensure_pg()

    iids = [
        int(r["loc"][1])
        for r in rows
        if isinstance(r.get("loc"), (list, tuple)) and len(r["loc"]) == 3 and r["loc"][0] == "pg" and int(r["loc"][1] or 0) > 0
    ]
    ptrs: dict[int, tuple[str, int, int, str]] = {}
    if iids:
        with connect_direct(cfg, app_name="dashboard_bench_export") as conn:
            for r in conn.execute(
                """
                SELECT i.input_id, pf.rel_path, i.input_offset, i.input_len, i.question_text
                FROM public.eval_inputs i
                LEFT JOIN public.pack_files pf ON pf.file_id = i.input_file_id
                WHERE i.input_id = ANY(%s)
                """,
                (list(set(iids)),),
            ).fetchall():
                if r["rel_path"] and r["input_len"]:
                    ptrs[int(r["input_id"])] = (
                        r["rel_path"],
                        int(r["input_offset"]),
                        int(r["input_len"]),
                        r["question_text"] or "",
                    )

    lines: list[bytes] = []
    for row in rows:
        loc = row.get("loc")
        rec: dict[str, Any] = dict(row)
        if isinstance(loc, (list, tuple)) and len(loc) == 3 and loc[0] == "pg":
            hit = ptrs.get(int(loc[1] or 0))
            if hit:
                try:
                    inp = pread_json(cfg.data_root / hit[0], hit[1], hit[2])
                    traces = inp.get("traces") if isinstance(inp, dict) and isinstance(inp.get("traces"), list) else []
                    t0 = traces[0] if traces and isinstance(traces[0], dict) else (inp if isinstance(inp, dict) else {})
                    rec["question_full"] = hit[3] or row.get("question") or ""
                    if isinstance(t0.get("messages"), list):
                        rec["messages"] = t0["messages"]
                    pool = t0.get("message_pool") or (inp.get("message_pool") if isinstance(inp, dict) else None)
                    if isinstance(pool, list):
                        rec["message_pool"] = pool
                except Exception:  # noqa: BLE001
                    pass
        item = bench_dynamic.format_export_case(
            rec, row=row, stage_names=stage_names, mech_names=mech_names, pat_names=pat_names
        )
        lines.append((json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
    return b"".join(lines)
