"""ETL Stage 1: Copy config files (user_rules.json, releases.json) & migrate users + KYC summary into PG."""

from __future__ import annotations

import json
import shutil
import sqlite3
from datetime import date
from pathlib import Path
from typing import Any

from psycopg.types.json import Jsonb

from ..config import DataCoreConfig
from ..db import connect_direct
from ..models import UserRules, parse_timestamp

DEFAULT_RELEASES = {
    "aime": [
        {"date": "2026-11-06", "label": "v1106"},
        {"date": "2026-11-12", "label": "v1112"},
    ]
}


def sync_config_files(legacy_root: Path, data_root: Path) -> dict[str, str]:
    """Copy `user_rules.json` and `releases.json` into `<data_root>/config/`."""
    cfg_dir = data_root / "config"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    copied: dict[str, str] = {}

    rules_src = legacy_root / "user_rules.json"
    rules_dst = cfg_dir / "user_rules.json"
    if rules_src.is_file():
        shutil.copy2(rules_src, rules_dst)
        copied["user_rules.json"] = str(rules_src)
    elif not rules_dst.is_file():
        rules_dst.write_text(json.dumps({"heuristics": {"real_user_id_max_digits": 10}}, indent=2) + "\n", encoding="utf-8")
        copied["user_rules.json"] = "generated_default"

    rel_candidates = [
        legacy_root / "releases.json",
        legacy_root / "1_aime" / "releases.json",
        Path("/opt/eval_dashboard/config/releases.json"),
    ]
    rel_dst = cfg_dir / "releases.json"
    rel_src = next((p for p in rel_candidates if p.is_file()), None)
    if rel_src:
        shutil.copy2(rel_src, rel_dst)
        copied["releases.json"] = str(rel_src)
    elif not rel_dst.is_file():
        rel_dst.write_text(json.dumps(DEFAULT_RELEASES, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        copied["releases.json"] = "generated_default"

    return copied


def _parse_date(val: Any) -> date | None:
    if not val:
        return None
    try:
        return date.fromisoformat(str(val)[:10])
    except ValueError:
        return None


def migrate_users(cfg: DataCoreConfig, legacy_root: Path) -> dict[str, Any]:
    """Load `user_rules.json` + read-only `1_aime/user_kyc/kyc.sqlite3` into PG `public.users`."""
    copied = sync_config_files(legacy_root, cfg.data_root)
    rules = UserRules.from_file(cfg.data_root / "config" / "user_rules.json")
    sig = rules.signature()

    kyc_db = cfg.data_root / "user_kyc" / "kyc.sqlite3"
    if not kyc_db.is_file():
        kyc_db = legacy_root / "1_aime" / "user_kyc" / "kyc.sqlite3"
    rows_to_upsert: list[tuple[Any, ...]] = []
    seen_uids: set[str] = set()

    if kyc_db.is_file():
        sconn = sqlite3.connect(f"file:{kyc_db}?mode=ro", uri=True)
        sconn.row_factory = sqlite3.Row
        try:
            sections_by_uid: dict[str, list[str]] = {}
            for r in sconn.execute("SELECT user_id, section FROM user_sections ORDER BY user_id, section"):
                sections_by_uid.setdefault(str(r["user_id"]), []).append(str(r["section"]))

            for r in sconn.execute("SELECT * FROM users"):
                uid = str(r["user_id"]).strip()
                if not uid:
                    continue
                seen_uids.add(uid)
                utype, is_real, is_lost = rules.classify(uid)
                secs = sections_by_uid.get(uid, [])
                models_raw = r["models"] or ""
                try:
                    models_list = json.loads(models_raw) if models_raw.startswith("[") else [m.strip() for m in models_raw.split(",") if m.strip()]
                except ValueError:
                    models_list = [m.strip() for m in models_raw.split(",") if m.strip()]

                profile_summary: dict[str, Any] = {}
                if r["status"] == "ok" and r["profile"]:
                    try:
                        prof = json.loads(r["profile"])
                        if isinstance(prof, dict):
                            profile_summary = {
                                "sections": sorted(prof.keys()),
                                "top_keys": {k: (list(v.keys())[:8] if isinstance(v, dict) else type(v).__name__) for k, v in prof.items()},
                            }
                    except ValueError:
                        pass

                rows_to_upsert.append(
                    (
                        uid,
                        r["user_id_fp"],
                        utype,
                        is_real,
                        is_lost,
                        r["status"],
                        int(r["n_sections"] or 0),
                        int(r["profile_bytes"] or 0),
                        secs,
                        Jsonb(profile_summary),
                        _parse_date(r["first_day"]),
                        _parse_date(r["last_day"]),
                        int(r["n_traces"] or 0),
                        sorted(set(models_list)),
                        parse_timestamp(r["fetched_at"]),
                        parse_timestamp(r["kyc_update_time"]),
                        sig,
                    )
                )
        finally:
            sconn.close()

    # Also ensure explicit IDs from user_rules.json exist in users
    for uid in (rules.real_ids | rules.test_ids | rules.internal_ids | rules.lost_ids):
        if uid not in seen_uids:
            utype, is_real, is_lost = rules.classify(uid)
            rows_to_upsert.append(
                (uid, None, utype, is_real, is_lost, None, 0, 0, [], Jsonb({}), None, None, 0, [], None, None, sig)
            )

    with connect_direct(cfg, autocommit=False, app_name="etl_users") as conn:
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO public.users(
                    user_id, user_id_fp, user_type, is_real, is_lost,
                    kyc_status, kyc_n_sections, kyc_profile_bytes, kyc_sections, kyc_summary,
                    first_day, last_day, n_traces, models, kyc_fetched_at, kyc_updated_at, rules_signature
                )
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (user_id) DO UPDATE SET
                    user_id_fp = COALESCE(EXCLUDED.user_id_fp, public.users.user_id_fp),
                    user_type = EXCLUDED.user_type,
                    is_real = EXCLUDED.is_real,
                    is_lost = EXCLUDED.is_lost,
                    kyc_status = COALESCE(EXCLUDED.kyc_status, public.users.kyc_status),
                    kyc_n_sections = EXCLUDED.kyc_n_sections,
                    kyc_profile_bytes = EXCLUDED.kyc_profile_bytes,
                    kyc_sections = EXCLUDED.kyc_sections,
                    kyc_summary = EXCLUDED.kyc_summary,
                    first_day = COALESCE(EXCLUDED.first_day, public.users.first_day),
                    last_day = COALESCE(EXCLUDED.last_day, public.users.last_day),
                    n_traces = GREATEST(EXCLUDED.n_traces, public.users.n_traces),
                    models = CASE WHEN cardinality(EXCLUDED.models) > 0 THEN EXCLUDED.models ELSE public.users.models END,
                    kyc_fetched_at = COALESCE(EXCLUDED.kyc_fetched_at, public.users.kyc_fetched_at),
                    kyc_updated_at = COALESCE(EXCLUDED.kyc_updated_at, public.users.kyc_updated_at),
                    rules_signature = EXCLUDED.rules_signature,
                    updated_at = now()
                """,
                rows_to_upsert,
            )
        conn.commit()

    return {"config_copied": copied, "users_upserted": len(rows_to_upsert)}
