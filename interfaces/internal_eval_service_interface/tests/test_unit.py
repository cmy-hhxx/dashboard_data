"""Unit tests for config, bench_sampler, ab_layout, state_store, and compare."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = ROOT.parent.parent
sys.path.insert(0, str(ROOT))

from internal_eval.ab_layout import allocate_round_dir, init_round_layout, sync_round_manifests
from internal_eval.bench_sampler import sample_bench_targets, write_targets_and_dispatch_files
from internal_eval.compare import build_compare_payload
from internal_eval.config import load_config
from internal_eval.state_store import StateStore


def _write_fake_bench(bench_root: Path, model: str = "aime_expert", count: int = 6) -> Path:
    mdir = bench_root / model
    mdir.mkdir(parents=True, exist_ok=True)
    path = mdir / "tier_500.jsonl"
    rows = []
    for i in range(count):
        is_multi = (i % 3 == 0)
        messages = (
            [
                {"role": "user", "type": "user_question", "content": f"Prior question {i}"},
                {"role": "assistant", "type": "final_answer", "content": f"Prior answer {i}"},
                {"role": "user", "type": "user_question", "content": f"Target question {i}"},
                {"role": "assistant", "type": "final_answer", "content": f"Old model answer {i}"},
            ]
            if is_multi
            else [
                {"role": "user", "type": "user_question", "content": f"Target question {i}"},
                {"role": "assistant", "type": "final_answer", "content": f"Old model answer {i}"},
            ]
        )
        rows.append(
            {
                "trace_id": f"src_tid_{i:04d}",
                "session_id": f"src_sid_{i:04d}",
                "model": model,
                "question": f"Target question {i}",
                "request_time": "2026-11-20T10:00:00Z",
                "batch_id": "2026-11-20",
                "turn": "multi" if is_multi else "single",
                "session_round": 2 if is_multi else 1,
                "severity": "GOLD" if i == 0 else "P1",
                "primary": {} if i == 0 else {"l1": "S9", "l2": "S9.M5", "l3": "S9.M5.2"},
                "messages": messages,
                "bench": {"tier": 500, "rank": i, "seed": "20261118"},
            }
        )
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    return path


class UnitTests(unittest.TestCase):
    def test_config_gateway_normalization_and_no_secret_leak(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            env_file = Path(td) / "secret.env"
            env_file.write_text(
                "export INTERNAL_EVAL_GATEWAY_BASE_URL=http://10.217.220.51/ai-gateway/\n"
                "export INTERNAL_EVAL_GATEWAY_API_KEY=sk-test-secret-should-not-leak\n"
                "export INTERNAL_EVAL_API_TOKENS='alice:tok-alice-secret, bob:tok-bob-secret, tok-bare-secret'\n"
                "export INTERNAL_EVAL_API_TOKEN=tok-legacy-secret\n"
                "export INTERNAL_EVAL_AUTH_MODE=all\n"
                "export INTERNAL_EVAL_MAX_QUEUED_RUNS=0\n"
                "export INTERNAL_EVAL_MAX_INFLIGHT_PER_CALLER=4\n"
                "export INTERNAL_EVAL_RATE_LIMIT_PER_MINUTE=60\n",
                encoding="utf-8",
            )
            cfg = load_config(env={}, env_file=env_file)
            self.assertEqual(cfg.gateway_base_url, "http://10.217.220.51/ai-gateway/v1")
            self.assertEqual(cfg.gateway_api_key, "sk-test-secret-should-not-leak")
            self.assertEqual(
                cfg.resolved_api_tokens(),
                (
                    ("alice", "tok-alice-secret"),
                    ("bob", "tok-bob-secret"),
                    ("token_1", "tok-bare-secret"),
                    ("default", "tok-legacy-secret"),
                ),
            )
            summary = cfg.public_summary()
            self.assertTrue(summary["gateway_configured"])
            self.assertTrue(summary["auth_enabled"])
            self.assertEqual(summary["auth_mode"], "all")
            self.assertEqual(summary["auth_token_count"], 4)
            self.assertEqual(summary["max_queued_runs"], 0)
            self.assertEqual(summary["max_inflight_per_caller"], 4)
            self.assertEqual(summary["rate_limit_per_minute"], 60)
            serialized = json.dumps(summary)
            for secret in (
                "sk-test-secret-should-not-leak",
                "tok-alice-secret",
                "tok-bob-secret",
                "tok-bare-secret",
                "tok-legacy-secret",
            ):
                self.assertNotIn(secret, serialized)

    def test_bench_sampler_extracts_history_and_writes_two_dispatch_jsonls(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            _write_fake_bench(tmp / "bench", count=6)
            targets, meta = sample_bench_targets(tmp / "bench", "aime_expert", 500, limit_override=6)
            self.assertEqual(len(targets), 6)
            self.assertEqual(meta["multi_turn"], 2)
            self.assertEqual(meta["single_turn"], 4)
            # Multi-turn history must exclude the target question and old final answer
            self.assertEqual(len(targets[0]["history_messages"]), 2)
            self.assertEqual(targets[0]["history_messages"][0]["content"], "Prior question 0")
            self.assertEqual(targets[0]["history_messages"][1]["content"], "Prior answer 0")
            # Single-turn has empty history
            self.assertEqual(targets[1]["history_messages"], [])

            files = write_targets_and_dispatch_files(
                run_id="run_test_1",
                version="1124",
                model="aime_expert",
                tier=500,
                sides=["before", "after"],
                before_agent={"name": "v1"},
                after_agent={"name": "v2"},
                targets=targets,
                targets_jsonl_path=tmp / "bench" / "bench.jsonl",
                dispatch_dir=tmp / "dispatch",
                split_mode="both",
            )
            self.assertTrue(Path(files["before"]).is_file())
            self.assertTrue(Path(files["after"]).is_file())
            self.assertTrue(Path(files["single_turn"]).is_file())
            self.assertTrue(Path(files["multi_turn"]).is_file())

            before_lines = [json.loads(l) for l in Path(files["before"]).read_text().splitlines()]
            self.assertEqual(len(before_lines), 6)
            self.assertEqual(before_lines[0]["side"], "before")
            self.assertEqual(before_lines[0]["case_key"], "eq_00001")
            self.assertTrue(before_lines[0]["case_id"].endswith("_eq_00001"))

    def test_ab_layout_allocates_non_overwriting_rounds_and_matches_dashboard_parser(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ds = Path(td)
            ab_root = ds / "1_aime" / "ab_test"
            (ab_root / "version_20261106_aime_expert").mkdir(parents=True)
            (ab_root / "version_20261112_aime_expert").mkdir(parents=True)

            o1, n1, d1 = allocate_round_dir(ab_root, "20261124", "aime_expert")
            self.assertEqual(o1, 2)
            self.assertEqual(n1, "version_20261124_aime_expert")

            # Same date + model must reject duplicate instead of appending _r2
            with self.assertRaises(FileExistsError):
                allocate_round_dir(ab_root, "20261124", "aime_expert")

            # Non-date suffix version must be rejected cleanly
            with self.assertRaises(ValueError):
                allocate_round_dir(ab_root, "20261124smoke", "aime_expert")

            # 4-digit MMDD + aime_fast succeeds with strict naming
            o2, n2, d2 = allocate_round_dir(ab_root, "1125", "aime_fast")
            self.assertEqual(o2, 3)
            self.assertRegex(n2, r"^version_\d{4}1125_aime_fast$")
            self.assertNotEqual(d1, d2)

            init_round_layout(
                round_dir=d1,
                version="20261124",
                model="aime_expert",
                tier=500,
                before_agent_label="v1",
                after_agent_label="v2",
                run_id="run_abc",
                base_taxonomy_dir=ROOT / "vendor" / "cluster_pkg" / "builtin_taxonomy",
            )
            self.assertTrue((d1 / "index_stats" / "meta.json").is_file())
            self.assertTrue((d1 / ".work" / "taxonomy" / "inventory.json").is_file())

            # Verify dashboard/ab_test.py recognizes our round layout cleanly!
            dash_dir = REPO_ROOT / "dashboard"
            if dash_dir.is_dir():
                sys.path.insert(0, str(dash_dir))
                import ab_test as dash_ab  # type: ignore

                self.assertTrue(dash_ab.is_ab_round(d1))
                found = dash_ab.ab_round_dirs(ds, "aime")
                names = [p.name for _, _, p in found]
                self.assertIn("version_20261124_aime_expert", names)
                # Ensure .service_state is ignored by dashboard scanner
                (ab_root / ".service_state").mkdir(exist_ok=True)
                found2 = dash_ab.ab_round_dirs(ds, "aime")
                self.assertNotIn(".service_state", [p.name for _, _, p in found2])

    def test_compare_engine_paired_migration_and_leaf_delta(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            store = StateStore(Path(td) / "state.sqlite3")
            run = store.create_run(
                {
                    "run_id": "run_cmp_1",
                    "version": "1124",
                    "round_order": 0,
                    "round_dir_name": "0_version1124_test",
                    "round_dir_path": td,
                    "model": "aime_expert",
                    "tier": 500,
                    "requested_count": 3,
                    "sides": ["before", "after"],
                    "before_agent": {"name": "old"},
                    "after_agent": {"name": "new"},
                    "before_agent_label": "old",
                    "after_agent_label": "new",
                }
            )
            targets = [
                {"case_key": "eq_00001", "eq_index": 1, "source_trace_id": "s1", "question": "Q1", "turn": "single"},
                {"case_key": "eq_00002", "eq_index": 2, "source_trace_id": "s2", "question": "Q2", "turn": "single"},
                {"case_key": "eq_00003", "eq_index": 3, "source_trace_id": "s3", "question": "Q3", "turn": "multi"},
            ]
            store.save_targets("run_cmp_1", targets, ["before", "after"])

            # Case 1: before=P0 -> after=GOLD (improved!)
            store.mark_fetched("run_cmp_1", "before", "eq_00001", trace_id="bt1")
            store.mark_evaluated("run_cmp_1", "before", "eq_00001", trace_id="bt1", session_id="bs1", attribution_file="a", problems=[{"severity": "P0", "label": "bad", "component": "finquery"}])
            store.mark_clustered_ready("run_cmp_1", "before", "eq_00001", {0: {"path": "S9.M6.4", "name": "凭空补出数值"}}, {"S9.M6.4": "凭空补出数值"})
            store.mark_fetched("run_cmp_1", "after", "eq_00001", trace_id="at1")
            self.assertTrue(store.mark_evaluated("run_cmp_1", "after", "eq_00001", trace_id="at1", session_id="as1", attribution_file="a", problems=[]))

            # Case 2: before=GOLD -> after=P2 (regressed!)
            store.mark_fetched("run_cmp_1", "before", "eq_00002", trace_id="bt2")
            store.mark_evaluated("run_cmp_1", "before", "eq_00002", trace_id="bt2", session_id="bs2", attribution_file="a", problems=[])
            store.mark_fetched("run_cmp_1", "after", "eq_00002", trace_id="at2")
            store.mark_evaluated("run_cmp_1", "after", "eq_00002", trace_id="at2", session_id="as2", attribution_file="a", problems=[{"severity": "P2", "label": "slow", "component": "search"}])
            store.mark_clustered_ready("run_cmp_1", "after", "eq_00002", {0: {"path": "S5.M3.1", "name": "抓取失败返回全空字段"}}, {"S5.M3.1": "抓取失败返回全空字段"})

            # Case 3: before=P1 -> after=P1 same problem count (unchanged)
            store.mark_fetched("run_cmp_1", "before", "eq_00003", trace_id="bt3")
            store.mark_evaluated("run_cmp_1", "before", "eq_00003", trace_id="bt3", session_id="bs3", attribution_file="a", problems=[{"severity": "P1", "label": "err", "component": "x"}])
            store.mark_clustered_ready("run_cmp_1", "before", "eq_00003", {0: {"path": "S9.M6.4", "name": "凭空补出数值"}}, {"S9.M6.4": "凭空补出数值"})
            store.mark_fetched("run_cmp_1", "after", "eq_00003", trace_id="at3")
            store.mark_evaluated("run_cmp_1", "after", "eq_00003", trace_id="at3", session_id="as3", attribution_file="a", problems=[{"severity": "P1", "label": "err", "component": "x"}])
            store.mark_clustered_ready("run_cmp_1", "after", "eq_00003", {0: {"path": "S9.M6.4", "name": "凭空补出数值"}}, {"S9.M6.4": "凭空补出数值"})

            before_map = {c["case_key"]: c for c in store.get_side_cases("run_cmp_1", side="before")}
            after_map = {c["case_key"]: c for c in store.get_side_cases("run_cmp_1", side="after")}
            cmp = build_compare_payload(run=run, targets=targets, before_cases=before_map, after_cases=after_map)

            self.assertEqual(cmp["paired_summary"]["paired_ready_count"], 3)
            self.assertEqual(cmp["paired_summary"]["improved"], 1)
            self.assertEqual(cmp["paired_summary"]["regressed"], 1)
            self.assertEqual(cmp["paired_summary"]["unchanged"], 1)
            self.assertEqual(cmp["severity_migration_matrix"]["P0"]["GOLD"], 1)
            self.assertEqual(cmp["severity_migration_matrix"]["GOLD"]["P2"], 1)
            self.assertEqual(cmp["severity_migration_matrix"]["P1"]["P1"], 1)

            # Verify sync_round_manifests writes canonical index_stats files without error
            round_dir = Path(td) / "version_20261124_aime_expert"
            sync_round_manifests(
                round_dir=round_dir,
                run=run,
                targets=targets,
                before_cases=before_map,
                after_cases=after_map,
                compare_payload=cmp,
            )
            self.assertTrue((round_dir / "index_stats" / "meta.json").is_file())
            self.assertTrue((round_dir / "index_stats" / "pairs_index.csv").is_file())
            self.assertTrue((round_dir / "index_stats" / "stats.json").is_file())

    def test_mixed_bench_and_extra_traces_dedupe_and_source_breakdown(self) -> None:
        from internal_eval.ab_layout import resolve_round_dir_name
        from internal_eval.bench_sampler import normalize_extra_traces
        from internal_eval.pipeline import _eval_version_id

        self.assertEqual(
            _eval_version_id({"model": "aime_expert", "before_agent_label": "线上旧版", "after_agent_label": "线上新版(20261127 online-expert)"}, "before"),
            "aime_expert_before",
        )
        self.assertEqual(
            _eval_version_id({"model": "aime_expert", "before_agent_label": "线上旧版", "after_agent_label": "线上新版(20261127 online-expert)"}, "after"),
            "20261127_online-expert",
        )

        self.assertEqual(
            resolve_round_dir_name("20261127", "aime_expert", round_tag="smoke"),
            "version_20261127_aime_expert_smoke",
        )
        norm = normalize_extra_traces([
            "src_tid_0001",
            {"trace_id": "src_tid_0005", "group": "ignored-tag"},
            {"trace_id": "src_tid_0001"},
            {"question": "Brand new custom query"},
        ])
        self.assertEqual(len(norm), 3)
        self.assertEqual(norm[0], {"trace_id": "src_tid_0001"})
        self.assertEqual(norm[1], {"trace_id": "src_tid_0005"})
        self.assertEqual(norm[2], {"question": "Brand new custom query"})

        with tempfile.TemporaryDirectory() as td:
            bench_root = Path(td) / "bench"
            _write_fake_bench(bench_root, "aime_expert", count=8)

            # 3 from bench (src_tid_0000..0002) + 1 overlap (src_tid_0001) + 1 extra in bench pool (src_tid_0005) + 1 pure question
            targets, meta = sample_bench_targets(
                bench_root,
                "aime_expert",
                tier=3,
                extra_traces=[
                    {"trace_id": "src_tid_0001"},
                    {"trace_id": "src_tid_0005"},
                    {"question": "Brand new custom query"},
                ],
            )
            self.assertEqual(len(targets), 5)
            self.assertEqual(meta["bench_count"], 3)
            self.assertEqual(meta["extra_added_count"], 2)
            self.assertEqual(meta["overlap_count"], 1)
            origins = [t["source_origin"] for t in targets]
            self.assertEqual(origins, ["bench", "bench+算法提供", "bench", "算法提供", "算法提供"])

            # Strict missing trace_id raises ValueError by default
            with self.assertRaises(ValueError):
                sample_bench_targets(
                    bench_root,
                    "aime_expert",
                    tier=2,
                    extra_traces=[{"trace_id": "nonexistent_tid_999"}],
                )

            # Verify compare source_breakdown + source_origin filtering
            store = StateStore(Path(td) / "state.sqlite3")
            run = store.create_run(
                {
                    "run_id": "run_mix",
                    "version": "20261127",
                    "round_order": 0,
                    "round_dir_name": "version_20261127_aime_expert",
                    "round_dir_path": str(Path(td) / "version_20261127_aime_expert"),
                    "model": "aime_expert",
                    "tier": 3,
                    "requested_count": 3,
                    "sides": ["before", "after"],
                    "before_mode": "historical",
                    "before_agent": {"name": "线上旧版"},
                    "after_agent": {"name": "线上新版"},
                    "before_agent_label": "线上旧版",
                    "after_agent_label": "线上新版",
                }
            )
            store.save_targets("run_mix", targets, ["before", "after"])
            store.save_historical_cases_bulk(
                "run_mix",
                "before",
                [
                    {
                        "case_key": t["case_key"],
                        "linked_input_id": idx + 100,
                        "linked_output_id": idx + 200,
                        "trace_id": t["source_trace_id"] or f"h_{idx}",
                        "problems": [{"severity": "P0", "label": "err", "component": "c", "cluster_path": "S1.M1.1", "cluster_name": "n"}],
                    }
                    for idx, t in enumerate(targets)
                ],
            )
            for idx, t in enumerate(targets):
                store.mark_fetched("run_mix", "after", t["case_key"], trace_id=f"a_{idx}")
                store.mark_evaluated("run_mix", "after", t["case_key"], trace_id=f"a_{idx}", session_id="", attribution_file="", problems=[])

            saved_targets = store.get_targets("run_mix")
            bmap = {c["case_key"]: c for c in store.get_side_cases("run_mix", side="before")}
            amap = {c["case_key"]: c for c in store.get_side_cases("run_mix", side="after")}
            self.assertEqual(bmap["eq_00001"]["linked_output_id"], 200)
            cmp_all = build_compare_payload(run=run, targets=saved_targets, before_cases=bmap, after_cases=amap)
            self.assertEqual(cmp_all["source_breakdown"]["bench"]["total_targets"], 3)
            self.assertEqual(cmp_all["source_breakdown"]["算法提供"]["total_targets"], 3)
            self.assertEqual(cmp_all["source_breakdown"]["bench+算法提供"]["total_targets"], 1)

            cmp_extra = build_compare_payload(
                run=run, targets=saved_targets, before_cases=bmap, after_cases=amap, source_origin="算法提供"
            )
            self.assertEqual(cmp_extra["paired_summary"]["paired_ready_count"], 3)
            self.assertEqual(cmp_extra["source_breakdown"]["bench"]["total_targets"], 3)

            res_extra = store.query_results("run_mix", side="before", source_origin="算法提供")
            self.assertEqual(res_extra["total"], 3)

    def test_human_read_retries_and_salvages_partial_failures(self) -> None:
        from unittest.mock import patch
        from internal_eval.config import load_config
        from internal_eval.engines import VendoredEngineBackend, ensure_vendor_on_path

        ensure_vendor_on_path()
        import eval_harness

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            inp = root / "in.jsonl"
            attr = root / "pg_attribution.jsonl"
            out = root / "out.jsonl"
            work = root / "work"
            inp.write_text('{"trace_id":"t1"}\n', encoding="utf-8")
            attr.write_text('{"trace_id":"t1"}\n{"trace_id":"t2"}\n', encoding="utf-8")

            calls: list[dict] = []

            def fake_hr(cfg_dict, *, retry_failed=None, quiet=False):
                calls.append({"retry_failed": retry_failed, "quiet": quiet})
                out_file = Path(cfg_dict["human_read"]["output_root"]) / "pg_attribution.jsonl"
                out_file.parent.mkdir(parents=True, exist_ok=True)
                out_file.write_text('{"trace_id":"t1","_human_read":{"model":"m"}}\n', encoding="utf-8")
                raise eval_harness.EvalRunError(
                    "Human-read translation finished with failures (failed=1)",
                    returncode=2,
                    summary={"ok": 1, "failed": 1},
                )

            cfg = load_config(env={"INTERNAL_EVAL_GATEWAY_API_KEY": "test-key"})
            adapter = VendoredEngineBackend(cfg)
            with patch.object(eval_harness, "human_read_eval", side_effect=fake_hr):
                res = adapter.human_read(
                    input_path=inp,
                    attribution_path=attr,
                    output_path=out,
                    work_dir=work,
                )

            self.assertEqual(len(calls), 2)
            self.assertIsNone(calls[0]["retry_failed"])
            self.assertTrue(calls[1]["retry_failed"])
            self.assertTrue(res["copied"])
            self.assertTrue(res["partial_failures"])
            self.assertTrue(res["retried_failed"])
            self.assertEqual(res["failed"], 1)
            self.assertTrue(out.is_file())
            self.assertIn("_human_read", out.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
