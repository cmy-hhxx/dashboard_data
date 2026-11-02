"""构造一个迷你数据集，覆盖验收用例需要的主路径与边界。"""

import json
from pathlib import Path

DAY = "2026-10-20"
LOST_DAY = "2026-09-18"

EXPERT_TREE = {
    "meta": {
        "title": "归因问题聚类树（fixture）",
        "pipeline_version": "4.1.3",
        "generated_at": "2026-11-01T00:00:00+08:00",
        "axes": {"level_1": "环节", "level_2": "机制", "level_3": "模式"},
    },
    "tree": {
        "id": "root",
        "name": "归因聚类",
        "level": 0,
        "children": [
            {
                "id": "S1",
                "level": 1,
                "name": "取数",
                "definition": "从外部取数",
                "children": [
                    {
                        "id": "S1.M1",
                        "level": 2,
                        "name": "参数构造错误",
                        "definition": "工具调用参数有问题",
                        "children": [
                            {"id": "S1.M1.1", "level": 3, "name": "空查询参数", "definition": "空参数重试"}
                        ],
                    }
                ],
            },
            {
                "id": "S9",
                "level": 1,
                "name": "答案合成",
                "definition": "把材料组织成答复",
                "children": [
                    {
                        "id": "S9.M5",
                        "level": 2,
                        "name": "加工计算错误",
                        "definition": "换算口径错",
                        "children": [
                            {"id": "S9.M5.1", "level": 3, "name": "旧数据当当前值", "definition": "旧值当现价"}
                        ],
                    }
                ],
            },
        ],
    },
}

FAST_TREE = {
    "meta": {
        "title": "归因问题聚类树（fixture fast）",
        "pipeline_version": "4.1.3",
        "generated_at": "2026-11-01T00:30:00+08:00",
        "axes": {"level_1": "环节"},
    },
    "tree": {
        "id": "root",
        "name": "归因聚类",
        "level": 0,
        "children": [
            {
                "id": "S3",
                "level": 1,
                "name": "检索",
                "definition": "检索证据",
                "children": [
                    {
                        "id": "S3.M2",
                        "level": 2,
                        "name": "召回失效",
                        "definition": "召回不相关",
                        "children": [
                            {"id": "S3.M2.1", "level": 3, "name": "召回为空", "definition": "没有召回结果"}
                        ],
                    }
                ],
            }
        ],
    },
}


def _problem(label, severity):
    return {
        "label": label,
        "definition": f"{label} 的定义",
        "problem_phenomena": "现象",
        "reason": "原因",
        "severity": severity,
        "severity_reason": "依据",
        "component": "/opt/skills/aime/scripts/finquery.py",
        "component_family": "finquery",
        "component_role": "取数",
        "evidence": [{"position": "trace_index 0 / message_index 3 / path /content", "quote": "close: 138.2"}],
    }


def _session(session_id, trace_id, timestamp, task, subtask, user, model, problems, question="问句", source="ths_ainvest_backtestarticle"):
    return {
        "session_meta": {
            "request_time": timestamp,
            "session_id": session_id,
            "user_id": user,
            "question": question,
            "agent_mode": "expert-analyst",
            "source": "ainvest",
            "thread_id": session_id,
            "trace_id": session_id,
        },
        "turns": [
            {
                "meta": {
                    "trace_id": trace_id,
                    "session_id": session_id,
                    "name": "expert-analyst",
                    "mode": "expert",
                    "model": model,
                    "source": source,
                    "timestamp": timestamp,
                    "user_id": user,
                    "task": task,
                    "subtask": subtask,
                    "difficulty": "中等",
                },
                "summary": "轮次摘要",
                "problem": problems,
                "is_correct": None,
                "correct_reason": None,
            }
        ],
        "session_summary": {"summary": "会话摘要"},
        "session_problem": [],
    }


def _input_record(session_id, trace_id, timestamp, user, model, question="问句"):
    return {
        "request_time": timestamp,
        "meta": {"session_id": session_id, "user_id": user, "question": question, "source": "ainvest"},
        "traces": [
            {
                "meta": {
                    "trace_id": trace_id,
                    "session_id": session_id,
                    "name": "expert-analyst",
                    "model": model,
                    "timestamp": timestamp,
                    "user_id": user,
                },
                "messages": [
                    {"type": "user_question", "role": "user", "content": question},
                    {"type": "generation", "role": "assistant", "content": "回答正文"},
                ],
                "message_pool": [],
                "tool_sets": [],
            }
        ],
        "case_id": trace_id,
        "versions": "default",
        "_source": "fixture",
    }


def _write_jsonl(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def _write_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")


def build(root: Path) -> Path:
    """在 root 下建出 datasets 结构，返回数据集根目录（root/1_aime 的父级）。"""
    root = Path(root)
    aime = root / "1_aime"
    out = aime / "eval_output"

    _write_json(out / "cluster" / "aime_expert" / "cluster_tree.json", EXPERT_TREE)
    _write_json(out / "cluster" / "aime_fast" / "cluster_tree.json", FAST_TREE)

    daily = [
        _session(
            "thread_a", "trace_alpha", "2026-10-20T02:00:00.000Z", "事件解读", "行情事件解读", "u1", "AIME-Atlas",
            [_problem("空查询参数重试", "P2"), _problem("旧数据当当前值", "P4")],
            question="英伟达今天为什么跌",
        ),
        _session(
            "thread_b", "trace_beta", "2026-10-20T03:00:00.000Z", "数据查询类", "时点行情查询", "u2", "AIME-Atlas",
            [],
            question="AAPL 最新价",
        ),
        _session(
            "thread_c", "trace_gamma", "2026-10-20T04:00:00.000Z", "交易建议", "入场与加仓时机建议", "u1", "AIME-Atlas",
            [_problem("旧数据当当前值", "P1"), _problem("空查询参数重试", "P3")],
            question="现在适合加仓吗",
        ),
        # 同一 trace 的重跑：行号更大的一行生效，前一行进 history
        _session(
            "thread_a", "trace_alpha", "2026-10-20T02:00:00.000Z", "事件解读", "行情事件解读", "u1", "AIME-Atlas",
            [_problem("空查询参数重试", "P3")],
            question="英伟达今天为什么跌",
        ),
        # 未聚类问题：已知语义是"不计入 error_codes / has_error"
        _session(
            "thread_d", "trace_delta", "2026-10-20T05:00:00.000Z", "投教问答", "金融术语与指标释义", "u3", "AIME-Atlas",
            [_problem("自由文本问题", "P2")],
            question="什么是市盈率",
        ),
    ]
    attr_path = out / "0_daily_eval" / "aime_expert" / f"aime_expert_attribution-{DAY}.jsonl"
    _write_jsonl(attr_path, daily)

    lost = [
        _session(
            "thread_lost", "trace_lost", "2026-09-18T02:00:00.000Z", "投教问答", "金融术语与指标释义", "u9", "aime-fast-new",
            [_problem("召回为空", "P2")],
            question="lost user question",
        )
    ]
    _write_jsonl(out / "1_lost_user_eval" / "aime_fast" / f"aime_fast_attribution-{LOST_DAY}.jsonl", lost)

    basename = attr_path.name
    items = [
        {"file": f"/remote/src/{basename}", "line": 1, "turn_index": 0, "problem_index": 0,
         "json_path": "turns[0].problem[0]", "path": "S1.M1.1", "label": "空查询参数重试"},
        {"file": f"/remote/src/{basename}", "line": 1, "turn_index": 0, "problem_index": 1,
         "json_path": "turns[0].problem[1]", "path": "S9.M5.1", "label": "旧数据当当前值"},
        {"file": f"/remote/src/{basename}", "line": 3, "turn_index": 0, "problem_index": 0,
         "json_path": "turns[0].problem[0]", "path": "S9.M5.1", "label": "旧数据当当前值"},
        {"file": f"/remote/src/{basename}", "line": 3, "turn_index": 0, "problem_index": 1,
         "json_path": "turns[0].problem[1]", "path": "S1.M1.1", "label": "空查询参数重试"},
        {"file": f"/remote/src/{basename}", "line": 4, "turn_index": 0, "problem_index": 0,
         "json_path": "turns[0].problem[0]", "path": "S1.M1.1", "label": "空查询参数重试"},
    ]
    _write_jsonl(out / "cluster" / "aime_expert" / "item_index.jsonl", items)

    lost_basename = f"aime_fast_attribution-{LOST_DAY}.jsonl"
    _write_jsonl(
        out / "cluster" / "aime_fast" / "item_index.jsonl",
        [{"file": f"/remote/src/{lost_basename}", "line": 1, "turn_index": 0, "problem_index": 0,
          "json_path": "turns[0].problem[0]", "path": "S3.M2.1", "label": "召回为空"}],
    )

    inputs = [
        _input_record("thread_a", "trace_alpha", "2026-10-20T02:00:00.000Z", "u1", "AIME-Atlas", "英伟达今天为什么跌"),
        _input_record("thread_b", "trace_beta", "2026-10-20T03:00:00.000Z", "u2", "AIME-Atlas", "AAPL 最新价"),
        _input_record("thread_c", "trace_gamma", "2026-10-20T04:00:00.000Z", "u1", "AIME-Atlas", "现在适合加仓吗"),
        _input_record("thread_d", "trace_delta", "2026-10-20T05:00:00.000Z", "u3", "AIME-Atlas", "什么是市盈率"),
    ]
    _write_jsonl(aime / "eval_input" / "0_daily_eval_input" / "aime_expert" / f"{DAY}.jsonl", inputs)
    _write_jsonl(
        aime / ".archive" / "1_lost_user_input" / "aime_fast" / f"aime_fast-{LOST_DAY}_input.jsonl",
        [_input_record("thread_lost", "trace_lost", "2026-09-18T02:00:00.000Z", "u9", "aime-fast-new", "lost user question")],
    )
    return aime
