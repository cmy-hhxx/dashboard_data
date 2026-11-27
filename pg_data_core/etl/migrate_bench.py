"""ETL Stage 4: Migrate `3_dynamic_bench/` (pool + tiers + long) into PG `bench_sets` & `bench_items`."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from psycopg.types.json import Jsonb

from ..config import DataCoreConfig
from ..db import connect_direct
from ..models import clean_str, parse_severity, parse_timestamp, to_int_or_none
from ..zst_pack import json_loads_bytes

TIER_RE = re.compile(r"^tier_(\d+)\.jsonl$")
LONG_RE = re.compile(r"^tier_(\d+)_long\.jsonl$")


def _upsert_bench_set(
    conn,
    *,
    bench_key: str,
    product: str,
    model: str,
    bench_type: str,
    tier_size: int | None,
    version: str,
    is_frozen: bool,
    requested_count: int | None,
    params: dict[str, Any],
    stats: dict[str, Any],
    built_at,
    items: list[dict[str, Any]],
) -> tuple[int, int, int]:
    row = conn.execute(
        """
        INSERT INTO public.bench_sets(
            bench_key, product, model, bench_type, tier_size, version, is_frozen,
            requested_count, actual_count, params, stats, built_at
        )
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT (bench_key) DO UPDATE SET
            version = EXCLUDED.version,
            requested_count = EXCLUDED.requested_count,
            actual_count = EXCLUDED.actual_count,
            params = EXCLUDED.params,
            stats = EXCLUDED.stats,
            built_at = EXCLUDED.built_at,
            updated_at = now()
        RETURNING bench_id
        """,
        (
            bench_key,
            product,
            model,
            bench_type,
            tier_size,
            version,
            is_frozen,
            requested_count,
            len(items),
            Jsonb(params),
            Jsonb(stats),
            built_at,
        ),
    ).fetchone()
    bench_id = int(row["bench_id"])

    # Resolve input_id map in bulk for this model
    tids = [it["trace_id"] for it in items]
    input_map: dict[str, int] = {}
    if tids:
        for r in conn.execute(
            "SELECT trace_id, input_id FROM public.eval_inputs WHERE product=%s AND model=%s AND trace_id = ANY(%s)",
            (product, model, tids),
        ).fetchall():
            input_map[r["trace_id"]] = int(r["input_id"])

    conn.execute("DELETE FROM public.bench_items WHERE bench_id = %s", (bench_id,))
    linked = 0
    with conn.cursor().copy(
        """
        COPY public.bench_items(
            bench_id, input_id, trace_id, session_id, rank, min_tier, stratum,
            turn_type, session_round, severity, dup_question_cnt, question_text, primary_cluster, extra
        ) FROM STDIN
        """
    ) as copy:
        for it in items:
            iid = input_map.get(it["trace_id"])
            if iid is not None:
                linked += 1
            copy.write_row(
                (
                    bench_id,
                    iid,
                    it["trace_id"],
                    it["session_id"],
                    it["rank"],
                    it["min_tier"],
                    it["stratum"],
                    it["turn_type"],
                    it["session_round"],
                    it["severity"],
                    it["dup_question_cnt"],
                    it["question_text"],
                    it["primary_cluster"],
                    json.dumps(it["extra"], ensure_ascii=False),
                )
            )
    return bench_id, len(items), linked


def _read_bench_jsonl(path: Path, *, default_min_tier: int | None = None) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}
    with path.open("rb", buffering=8 << 20) as fh:
        for idx, raw in enumerate(fh, 1):
            if not raw.strip():
                continue
            try:
                rec = json_loads_bytes(raw)
            except ValueError:
                continue
            tid = clean_str(rec.get("trace_id"))
            if not tid:
                continue
            bench_meta = rec.get("bench") if isinstance(rec.get("bench"), dict) else {}
            primary = rec.get("primary") if isinstance(rec.get("primary"), dict) else {}
            sev = clean_str(rec.get("severity"))
            if sev and sev != "GOLD":
                sev = parse_severity(sev) or sev
            seen[tid] = {
                "trace_id": tid,
                "session_id": clean_str(rec.get("session_id")),
                "rank": to_int_or_none(bench_meta.get("rank")) or idx,
                "min_tier": to_int_or_none(bench_meta.get("min_tier")) or default_min_tier,
                "stratum": clean_str(bench_meta.get("stratum") or rec.get("group")),
                "turn_type": clean_str(rec.get("turn")),
                "session_round": to_int_or_none(rec.get("session_round")),
                "severity": sev,
                "dup_question_cnt": to_int_or_none(bench_meta.get("dup_question_cnt")) or 1,
                "question_text": clean_str(rec.get("question_full") or rec.get("question")),
                "primary_cluster": clean_str(primary.get("path") or primary.get("code") or primary.get("l3")),
                "extra": {
                    k: rec[k]
                    for k in ("group", "batch_id", "request_time", "recalled_from", "primary", "bench")
                    if k in rec
                },
            }
    return list(seen.values())


def migrate_benches(cfg: DataCoreConfig, legacy_root: Path) -> dict[str, Any]:
    bench_root = legacy_root / "3_dynamic_bench"
    if not bench_root.is_dir():
        return {"sets": []}

    manifest = (
        json.loads((bench_root / "manifest.json").read_text(encoding="utf-8"))
        if (bench_root / "manifest.json").is_file()
        else {}
    )
    pool_manifest = (
        json.loads((bench_root / "pool" / "manifest.json").read_text(encoding="utf-8"))
        if (bench_root / "pool" / "manifest.json").is_file()
        else {}
    )
    version = str(manifest.get("version") or "1.0.0")
    params = manifest.get("params") if isinstance(manifest.get("params"), dict) else {}
    built_at = parse_timestamp(manifest.get("built_at"))
    pool_built_at = parse_timestamp(pool_manifest.get("built_at")) or built_at

    migrated: list[dict[str, Any]] = []
    with connect_direct(cfg, autocommit=False, app_name="etl_bench") as conn:
        for model in ("aime_expert", "aime_fast"):
            # 1. Dynamic main pool
            pool_file = bench_root / "pool" / f"{model}.jsonl"
            if pool_file.is_file():
                items = _read_bench_jsonl(pool_file)
                bid, cnt, linked = _upsert_bench_set(
                    conn,
                    bench_key=f"{model}:pool",
                    product=cfg.product,
                    model=model,
                    bench_type="pool",
                    tier_size=None,
                    version=version,
                    is_frozen=False,
                    requested_count=None,
                    params=params,
                    stats=(pool_manifest.get("pool") or {}),
                    built_at=pool_built_at,
                    items=items,
                )
                conn.commit()
                migrated.append({"bench_key": f"{model}:pool", "bench_id": bid, "items": cnt, "linked_inputs": linked})

            mdir = bench_root / model
            if not mdir.is_dir():
                continue

            # 2. Tier files (500 / 1000 / 5000 / 10000)
            for p in sorted(mdir.glob("tier_*.jsonl")):
                m = TIER_RE.match(p.name)
                if not m:
                    continue
                tier = int(m.group(1))
                items = _read_bench_jsonl(p, default_min_tier=tier)
                bid, cnt, linked = _upsert_bench_set(
                    conn,
                    bench_key=f"{model}:tier_{tier}",
                    product=cfg.product,
                    model=model,
                    bench_type="tier",
                    tier_size=tier,
                    version=version,
                    is_frozen=False,
                    requested_count=tier,
                    params=params,
                    stats=((manifest.get("models") or {}).get(model, {}).get("tiers", {}).get(str(tier), {})),
                    built_at=built_at,
                    items=items,
                )
                conn.commit()
                migrated.append({"bench_key": f"{model}:tier_{tier}", "bench_id": bid, "items": cnt, "linked_inputs": linked})

            # 3. Long tier files (10 / 20 / 100 / 200)
            ldir = mdir / "long"
            if ldir.is_dir():
                for p in sorted(ldir.glob("tier_*_long.jsonl")):
                    m = LONG_RE.match(p.name)
                    if not m:
                        continue
                    tier = int(m.group(1))
                    items = _read_bench_jsonl(p, default_min_tier=tier)
                    bid, cnt, linked = _upsert_bench_set(
                        conn,
                        bench_key=f"{model}:tier_{tier}_long",
                        product=cfg.product,
                        model=model,
                        bench_type="long",
                        tier_size=tier,
                        version=version,
                        is_frozen=False,
                        requested_count=tier,
                        params=params,
                        stats=((manifest.get("models") or {}).get(model, {}).get("long", {}).get(str(tier), {})),
                        built_at=built_at,
                        items=items,
                    )
                    conn.commit()
                    migrated.append(
                        {"bench_key": f"{model}:tier_{tier}_long", "bench_id": bid, "items": cnt, "linked_inputs": linked}
                    )

    return {"sets": migrated}
