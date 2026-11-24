"""Real-time before vs after comparison & visualization aggregation."""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from .config import SEVERITY_ORDER, SEVERITY_RANK


def _side_summary(cases: dict[str, dict[str, Any]], total_targets: int) -> dict[str, Any]:
    ready = [c for c in cases.values() if c["status"] == "ready"]
    failed = sum(1 for c in cases.values() if c["status"] == "failed")
    rejected = sum(1 for c in cases.values() if c["status"] == "rejected")
    ready_n = len(ready)
    gold_n = sum(1 for c in ready if c["is_gold"])
    problem_traces = ready_n - gold_n
    total_problems = sum(int(c["problem_count"] or 0) for c in ready)
    sev_dist = {s: 0 for s in SEVERITY_ORDER}
    for c in ready:
        sev = c["max_severity"] or ("GOLD" if c["is_gold"] else "P4")
        if sev in sev_dist:
            sev_dist[sev] += 1
    p0p1 = sev_dist["P0"] + sev_dist["P1"]
    return {
        "total_targets": total_targets,
        "ready_traces": ready_n,
        "failed_traces": failed,
        "rejected_traces": rejected,
        "gold_traces": gold_n,
        "problem_traces": problem_traces,
        "total_problems": total_problems,
        "pass_rate": round(gold_n / ready_n, 4) if ready_n else 0.0,
        "problem_trace_rate": round(problem_traces / ready_n, 4) if ready_n else 0.0,
        "avg_problems_per_trace": round(total_problems / ready_n, 4) if ready_n else 0.0,
        "p0p1_traces": p0p1,
        "p0p1_rate": round(p0p1 / ready_n, 4) if ready_n else 0.0,
        "severity_distribution": sev_dist,
    }


def _leaf_stats(cases: list[dict[str, Any]]) -> tuple[Counter[str], Counter[str], dict[str, str]]:
    trace_hits: Counter[str] = Counter()
    prob_hits: Counter[str] = Counter()
    names: dict[str, str] = {}
    for c in cases:
        seen_in_trace: set[str] = set()
        for prob in c.get("problems") or []:
            path = prob.get("cluster_path")
            if not path:
                continue
            prob_hits[path] += 1
            seen_in_trace.add(path)
            if prob.get("cluster_name"):
                names[path] = prob["cluster_name"]
        for path in seen_in_trace:
            trace_hits[path] += 1
    return trace_hits, prob_hits, names


def _stage_mechanism_counts(cases: list[dict[str, Any]]) -> Counter[tuple[str, str]]:
    counts: Counter[tuple[str, str]] = Counter()
    for c in cases:
        for prob in c.get("problems") or []:
            path = prob.get("cluster_path")
            if not path:
                continue
            parts = path.split(".")
            if len(parts) >= 2:
                counts[(parts[0], parts[1])] += 1
    return counts


def build_compare_payload(
    *,
    run: dict[str, Any],
    targets: list[dict[str, Any]],
    before_cases: dict[str, dict[str, Any]],
    after_cases: dict[str, dict[str, Any]],
    paired_only_for_distribution: bool = False,
    top_leaves: int = 30,
) -> dict[str, Any]:
    """Compute real-time visual comparison metrics for before vs after agents."""
    total_targets = len(targets)
    target_by_key = {t["case_key"]: t for t in targets}

    before_summary = _side_summary(before_cases, total_targets)
    after_summary = _side_summary(after_cases, total_targets)

    # Identify strictly paired ready cases
    paired_keys = [
        t["case_key"]
        for t in targets
        if (bc := before_cases.get(t["case_key"]))
        and (ac := after_cases.get(t["case_key"]))
        and bc["status"] == "ready"
        and ac["status"] == "ready"
    ]
    paired_n = len(paired_keys)

    # Paired migration matrix & win/loss breakdown
    migration = {b: {a: 0 for a in SEVERITY_ORDER} for b in SEVERITY_ORDER}
    improved = 0
    regressed = 0
    unchanged = 0
    before_paired_gold = 0
    after_paired_gold = 0
    before_paired_p0p1 = 0
    after_paired_p0p1 = 0
    improved_examples: list[dict[str, Any]] = []
    regressed_examples: list[dict[str, Any]] = []

    for ck in paired_keys:
        bc = before_cases[ck]
        ac = after_cases[ck]
        b_sev = bc["max_severity"] or ("GOLD" if bc["is_gold"] else "P4")
        a_sev = ac["max_severity"] or ("GOLD" if ac["is_gold"] else "P4")
        if b_sev in migration and a_sev in migration[b_sev]:
            migration[b_sev][a_sev] += 1

        if b_sev == "GOLD":
            before_paired_gold += 1
        if a_sev == "GOLD":
            after_paired_gold += 1
        if b_sev in ("P0", "P1"):
            before_paired_p0p1 += 1
        if a_sev in ("P0", "P1"):
            after_paired_p0p1 += 1

        b_rank = SEVERITY_RANK.get(b_sev, 4)
        a_rank = SEVERITY_RANK.get(a_sev, 4)
        # Higher rank number means less severe (GOLD=5 > P4=4 > ... > P0=0)
        if a_rank > b_rank or (a_rank == b_rank and ac["problem_count"] < bc["problem_count"]):
            improved += 1
            if len(improved_examples) < 20:
                improved_examples.append(
                    {
                        "case_key": ck,
                        "question": target_by_key[ck]["question"],
                        "before_severity": b_sev,
                        "after_severity": a_sev,
                        "before_problems": bc["problem_count"],
                        "after_problems": ac["problem_count"],
                        "before_paths": bc["cluster_paths"],
                        "after_paths": ac["cluster_paths"],
                    }
                )
        elif a_rank < b_rank or (a_rank == b_rank and ac["problem_count"] > bc["problem_count"]):
            regressed += 1
            if len(regressed_examples) < 20:
                regressed_examples.append(
                    {
                        "case_key": ck,
                        "question": target_by_key[ck]["question"],
                        "before_severity": b_sev,
                        "after_severity": a_sev,
                        "before_problems": bc["problem_count"],
                        "after_problems": ac["problem_count"],
                        "before_paths": bc["cluster_paths"],
                        "after_paths": ac["cluster_paths"],
                    }
                )
        else:
            unchanged += 1

    before_pool = [before_cases[ck] for ck in paired_keys] if paired_only_for_distribution else [
        c for c in before_cases.values() if c["status"] == "ready"
    ]
    after_pool = [after_cases[ck] for ck in paired_keys] if paired_only_for_distribution else [
        c for c in after_cases.values() if c["status"] == "ready"
    ]

    # Severity distribution comparison
    b_sev_counts = Counter(c["max_severity"] or ("GOLD" if c["is_gold"] else "P4") for c in before_pool)
    a_sev_counts = Counter(c["max_severity"] or ("GOLD" if c["is_gold"] else "P4") for c in after_pool)
    b_denom = max(1, len(before_pool))
    a_denom = max(1, len(after_pool))
    severity_comparison: dict[str, dict[str, Any]] = {}
    for sev in SEVERITY_ORDER:
        bc_n = int(b_sev_counts.get(sev, 0))
        ac_n = int(a_sev_counts.get(sev, 0))
        b_rate = round(bc_n / b_denom, 4) if before_pool else 0.0
        a_rate = round(ac_n / a_denom, 4) if after_pool else 0.0
        severity_comparison[sev] = {
            "before": bc_n,
            "after": ac_n,
            "delta": ac_n - bc_n,
            "before_rate": b_rate,
            "after_rate": a_rate,
            "rate_delta": round(a_rate - b_rate, 4),
        }

    # Leaf comparison
    b_leaf_t, b_leaf_p, b_names = _leaf_stats(before_pool)
    a_leaf_t, a_leaf_p, a_names = _leaf_stats(after_pool)
    all_names = {**b_names, **a_names}
    all_paths = set(b_leaf_t) | set(a_leaf_t)
    leaf_comparison = []
    for path in all_paths:
        bt = int(b_leaf_t.get(path, 0))
        at = int(a_leaf_t.get(path, 0))
        bp = int(b_leaf_p.get(path, 0))
        ap = int(a_leaf_p.get(path, 0))
        parts = path.split(".")
        leaf_comparison.append(
            {
                "path": path,
                "stage": parts[0] if len(parts) >= 1 else "",
                "mechanism": parts[1] if len(parts) >= 2 else "",
                "name": all_names.get(path, path),
                "before_traces": bt,
                "after_traces": at,
                "delta_traces": at - bt,
                "before_problems": bp,
                "after_problems": ap,
                "delta_problems": ap - bp,
            }
        )
    leaf_comparison.sort(key=lambda x: (-max(x["before_traces"], x["after_traces"]), -abs(x["delta_traces"]), x["path"]))

    # Stage x Mechanism heatmap matrix
    b_sm = _stage_mechanism_counts(before_pool)
    a_sm = _stage_mechanism_counts(after_pool)
    all_sm_keys = sorted(set(b_sm) | set(a_sm))
    sm_cells = []
    stage_totals: dict[str, dict[str, int]] = defaultdict(lambda: {"before": 0, "after": 0})
    for stage, mech in all_sm_keys:
        bn = int(b_sm.get((stage, mech), 0))
        an = int(a_sm.get((stage, mech), 0))
        stage_totals[stage]["before"] += bn
        stage_totals[stage]["after"] += an
        sm_cells.append(
            {
                "stage": stage,
                "mechanism": mech,
                "before": bn,
                "after": an,
                "delta": an - bn,
            }
        )

    b_pass_p = round(before_paired_gold / paired_n, 4) if paired_n else 0.0
    a_pass_p = round(after_paired_gold / paired_n, 4) if paired_n else 0.0
    b_p0p1_p = round(before_paired_p0p1 / paired_n, 4) if paired_n else 0.0
    a_p0p1_p = round(after_paired_p0p1 / paired_n, 4) if paired_n else 0.0

    paired_summary = {
        "paired_ready_count": paired_n,
        "total_targets": total_targets,
        "paired_coverage_rate": round(paired_n / total_targets, 4) if total_targets else 0.0,
        "improved": improved,
        "regressed": regressed,
        "unchanged": unchanged,
        "net_improved": improved - regressed,
        "net_improvement_rate": round((improved - regressed) / paired_n, 4) if paired_n else 0.0,
        "before_pass_rate": b_pass_p,
        "after_pass_rate": a_pass_p,
        "pass_rate_delta": round(a_pass_p - b_pass_p, 4),
        "before_p0p1_rate": b_p0p1_p,
        "after_p0p1_rate": a_p0p1_p,
        "p0p1_rate_delta": round(a_p0p1_p - b_p0p1_p, 4),
    }

    return {
        "run_id": run["run_id"],
        "version": run["version"],
        "model": run["model"],
        "tier": run["tier"],
        "run_status": run["status"],
        "before_agent": run["before_agent_label"],
        "after_agent": run["after_agent_label"],
        "paired_only": paired_only_for_distribution,
        "before_summary": before_summary,
        "after_summary": after_summary,
        "paired_summary": paired_summary,
        "severity_comparison": severity_comparison,
        "severity_migration_matrix": migration,
        "leaf_comparison": leaf_comparison[:top_leaves],
        "leaf_total_count": len(leaf_comparison),
        "stage_mechanism_matrix": sm_cells,
        "stage_totals": [
            {"stage": st, "before": vals["before"], "after": vals["after"], "delta": vals["after"] - vals["before"]}
            for st, vals in sorted(stage_totals.items())
        ],
        "highlights": {
            "improved_examples": improved_examples,
            "regressed_examples": regressed_examples,
        },
    }
