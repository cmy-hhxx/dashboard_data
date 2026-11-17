#!/usr/bin/env python3
"""供数接口自检：把 5003 的每个端点、参数、错误码、口径不变量跑一遍。

    python3 scripts/audit_analysis_api.py http://127.0.0.1:5003
    python3 scripts/audit_analysis_api.py http://10.217.219.2:2477

只读，不改数据。退出码非 0 表示有检查项失败。业务方接入前、发布后都可以跑一遍。
"""

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
import gzip

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5003").rstrip("/")
API = BASE + "/api/v1/analysis"
DATASET = "aime_eval"
RESULTS = []


def call(path, params=None, method="GET", body=None):
    url = path
    if params:
        url += ("&" if "?" in path else "?") + urllib.parse.urlencode(params, doseq=True)
    data = None
    headers = {"Accept": "application/json"}
    if method == "POST":
        data = json.dumps(body or {}).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            if resp.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            return resp.status, json.loads(raw), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw), dict(exc.headers)
        except ValueError:
            return exc.code, {"raw": raw[:200].decode("utf-8", "replace")}, dict(exc.headers)


def check(name, fn):
    try:
        detail = fn()
        RESULTS.append((True, name, detail or ""))
    except AssertionError as exc:
        RESULTS.append((False, name, str(exc)))
    except Exception as exc:  # noqa: BLE001
        RESULTS.append((False, name, f"{type(exc).__name__}: {exc}"))


def expect(path, params=None, status=200, method="GET", body=None):
    code, payload, headers = call(path, params, method, body)
    assert code == status, f"{path} 期望 {status} 实际 {code}: {str(payload)[:200]}"
    return payload


def envelope(payload, where):
    for key in ("request_id", "schema_version", "data", "meta"):
        assert key in payload, f"{where} 缺 {key}"
    meta = payload["meta"]
    for key in ("taxonomy_version", "data_updated_at", "built_at", "latest_seq", "filters"):
        assert key in meta, f"{where} 的 meta 缺 {key}"
    assert payload["schema_version"] == "2.0", f"{where} schema_version={payload['schema_version']}"


def error_code(payload):
    assert "error" in payload, f"错误响应缺少 error: {payload}"
    return payload["error"]["code"], payload["error"].get("details") or {}


# --------------------------------------------------------------------------- 各项检查

def c_health():
    payload = expect(BASE + "/healthz")
    for key in ("ok", "traces", "problems", "building", "latest_seq", "data_updated_at"):
        assert key in payload, f"/healthz 缺 {key}"
    assert payload["ok"] is True, "健康检查未就绪"
    return f"traces={payload['traces']} problems={payload['problems']} seq={payload['latest_seq']}"


def c_envelope():
    for path, params in (
        ("/taxonomy", {"kind": "severity"}),
        ("/severity", {"dataset": DATASET}),
        ("/summary", {"dataset": DATASET, "group_by": "day"}),
        ("/users", {"dataset": DATASET, "severity": "P0"}),
        ("/traces", {"dataset": DATASET, "page_size": 1}),
        ("/changes", {"dataset": DATASET, "page_size": 1}),
    ):
        envelope(expect(API + path, params), path)
    return "6 个端点信封一致"


def c_taxonomy():
    for kind in ("intent", "problem", "severity"):
        payload = expect(API + "/taxonomy", {"kind": kind})
        envelope(payload, f"/taxonomy?kind={kind}")
        assert payload["data"]["nodes"], f"{kind} 树为空"
    code, payload, _ = call(API + "/taxonomy", {"kind": "nope"})
    assert code == 422 and error_code(payload)[0] == "UNKNOWN_CODE", f"未知 kind 应 422: {code}"
    return "intent/problem/severity 三棵树 + 未知 kind 422"


def c_summary():
    total = expect(API + "/summary", {"dataset": DATASET, "group_by": "day"})["data"]["total"]
    groups = expect(API + "/summary", {"dataset": DATASET, "group_by": "day", "limit": 1000})["data"]["groups"]
    assert sum(g["traces"] for g in groups) == total["traces"], "按 day 分组的 traces 之和 != total"
    two = expect(API + "/summary", {"dataset": DATASET, "group_by": "day,app_version"})["data"]
    assert two["total"]["traces"] == total["traces"], "两个维度分组不该改变 total"
    for bad, params, code_want in (
        ("缺 group_by", {"dataset": DATASET}, 400),
        ("未知维度", {"dataset": DATASET, "group_by": "nope"}, 422),
        ("limit 超限", {"dataset": DATASET, "group_by": "day", "limit": 1001}, 400),
        ("未知 sort", {"dataset": DATASET, "group_by": "day", "sort": "nope"}, 422),
        ("level=children 无筛选", {"dataset": DATASET, "group_by": "intent", "level": "children"}, 400),
    ):
        code, payload, _ = call(API + "/summary", params)
        assert code == code_want, f"{bad} 期望 {code_want} 实际 {code}"
    return f"分组加和一致，total.traces={total['traces']}"


def c_severity():
    payload = expect(API + "/severity", {"dataset": DATASET})["data"]
    total = payload["total"]
    assert payload["groups"] == [], "不给 group_by 时 groups 应为空"
    sev = total["severity"]
    assert sum(v["problems"] for v in sev.values()) + total["unlabeled"] == total["problems"], "各等级条目之和 != problems"
    grouped = expect(API + "/severity", {"dataset": DATASET, "group_by": "app_version"})["data"]
    assert sum(g["severity"]["P0"]["problems"] for g in grouped["groups"]) == sev["P0"]["problems"], "分组 P0 条目数不一致"
    code, payload, _ = call(API + "/severity", {"dataset": DATASET, "severity": "P9"})
    assert code == 422, f"未知严重度应 422，实际 {code}"
    return f"P0..P4 加和一致，problems={total['problems']}"


def c_users():
    data = expect(API + "/users", {"dataset": DATASET, "severity": "P0"})["data"]
    total = data["total"]
    traces_total = expect(API + "/traces", {"dataset": DATASET, "severity": "P0", "page_size": 1})["data"]["total"]
    sev_total = expect(API + "/severity", {"dataset": DATASET, "severity": "P0"})["data"]["total"]
    assert total["traces"] == traces_total, f"/users traces={total['traces']} != /traces total={traces_total}"
    assert total["severity"]["P0"]["traces"] == sev_total["severity"]["P0"]["traces"], "/users 与 /severity 的 P0 trace 数不一致"
    assert data["items"], "/users 未返回用户"
    for row in data["items"]:
        for key in ("user_id", "analyzed", "traces", "problems", "severity", "first_day", "last_day",
                    "app_versions", "sample_trace_id"):
            assert key in row, f"/users 行缺 {key}"
        assert row["traces"] > 0, f"用户 {row['user_id']} 零命中却出现在列表里"
        assert row["analyzed"] >= row["traces"], f"用户 {row['user_id']} analyzed < traces"
        assert row["severity"]["P0"]["traces"] > 0, f"用户 {row['user_id']} 没有 P0 却出现在 P0 列表"
    assert sum(r["traces"] for r in data["items"]) <= total["traces"], "用户 traces 之和超过 total"
    # sample_trace_id 必须属于该用户
    first = data["items"][0]
    item = expect(API + "/traces/batch", status=200, method="POST",
                  body={"dataset": DATASET, "trace_ids": [first["sample_trace_id"]]})["data"]["items"][0]
    assert item.get("user_id") == first["user_id"], "sample_trace_id 的 user_id 与聚合行不一致"
    # 翻页不重复
    page1 = expect(API + "/users", {"dataset": DATASET, "severity": "P0", "limit": 1})["data"]
    if page1["has_more"]:
        page2 = expect(API + "/users", {"dataset": DATASET, "severity": "P0", "limit": 1,
                                        "cursor": page1["next_cursor"]})["data"]
        assert page2["items"][0]["user_id"] != page1["items"][0]["user_id"], "翻页重复返回同一用户"
    code, payload, _ = call(API + "/users", {"dataset": DATASET, "sort": "nope"})
    assert code == 422, f"未知 sort 应 422，实际 {code}"
    return f"P0 用户 {total['users']} 个 / trace {total['traces']} 条，与 /traces /severity 对齐"


def c_traces():
    data = expect(API + "/traces", {"dataset": DATASET, "page_size": 3})["data"]
    for key in ("items", "total", "page_size", "next_cursor", "has_more"):
        assert key in data, f"/traces 缺 {key}"
    for item in data["items"]:
        for key in ("trace_id", "day", "user_id", "session_id", "app_version", "query_preview",
                    "severity", "problems", "problem_codes"):
            assert key in item, f"/traces item 缺 {key}"
    page2 = expect(API + "/traces", {"dataset": DATASET, "page_size": 3, "cursor": data["next_cursor"]})["data"]
    assert not ({i["trace_id"] for i in page2["items"]} & {i["trace_id"] for i in data["items"]}), "cursor 翻页重复"
    ids = expect(API + "/traces", {"dataset": DATASET, "ids_only": True, "page_size": 5})["data"]["items"]
    assert all(isinstance(x, str) for x in ids), "ids_only 应只返回 trace_id 字符串"
    for bad, params, code_want in (
        ("page_size 超 100", {"dataset": DATASET, "page_size": 101}, 400),
        ("ids_only 超 5000", {"dataset": DATASET, "ids_only": "true", "page_size": 5001}, 400),
        ("q 过长", {"dataset": DATASET, "q": "x" * 201}, 400),
        ("未知严重度", {"dataset": DATASET, "severity": "P9"}, 422),
        ("未知 dataset", {"dataset": "nope"}, 422),
        ("缺 dataset", {}, 400),
    ):
        code, payload, _ = call(API + "/traces", params)
        assert code == code_want, f"{bad} 期望 {code_want} 实际 {code}"
    too_many = [f"9{i}" for i in range(5001)]
    code, payload, _ = call(API + "/traces", {"dataset": DATASET})
    assert code == 200
    code, payload, _ = call(API + "/traces/batch", method="POST", body={"dataset": DATASET, "trace_ids": too_many[:1001]})
    assert code == 413, f"batch 超 1000 应 413，实际 {code}"
    return "分页/限制/错误码符合文档"


def c_batch():
    listing = expect(API + "/traces", {"dataset": DATASET, "page_size": 2})["data"]["items"]
    ids = [item["trace_id"] for item in listing]
    data = expect(API + "/traces/batch", method="POST",
                  body={"dataset": DATASET, "trace_ids": ids + ["does_not_exist"]})["data"]["items"]
    assert [i["trace_id"] for i in data] == ids + ["does_not_exist"], "batch 返回顺序与请求不一致"
    assert data[-1]["status"] == "not_analyzed" and data[-1]["query_preview"] is None, "未知 id 应为 not_analyzed + null"
    assert data[0]["status"] == "analyzed" and data[0]["user_id"], "已分析条目应有 user_id"
    code, payload, _ = call(API + "/traces/batch", method="POST", body={"dataset": DATASET, "trace_ids": []})
    assert code == 400, f"空 trace_ids 应 400，实际 {code}"
    return "顺序/未知 id/空列表都符合文档"


def c_detail():
    listing = expect(API + "/traces", {"dataset": DATASET, "page_size": 1})["data"]["items"][0]
    tid, day = listing["trace_id"], listing["day"]
    data = expect(API + "/traces/" + tid, {"dataset": DATASET, "day": day})["data"]
    for key in ("session", "trace", "analysis", "problems", "problem_codes", "file", "taxonomy_version"):
        assert key in data, f"详情缺 {key}"
    assert data["session"], "详情 session 为空"
    if data["trace"]:
        assert data["trace"]["meta"]["trace_id"] == tid, "详情 trace 与请求的 trace_id 不一致"
    code, payload, _ = call(API + "/traces/" + tid, {"dataset": DATASET})
    assert code == 400, f"缺 day 应 400，实际 {code}"
    code, payload, _ = call(API + "/traces/does_not_exist", {"dataset": DATASET, "day": day})
    assert code == 404 and error_code(payload)[1].get("reason") == "not_analyzed", "未知 id 应 404 not_analyzed"
    code, payload, _ = call(API + "/traces/" + tid, {"dataset": DATASET, "day": "1999-01-01"})
    details = error_code(payload)[1]
    assert code == 404 and details.get("reason") == "day_mismatch" and details.get("available_days"), "day 不匹配应 404 + available_days"
    return "session/trace 一致，404 三种 reason 可自查"


def c_changes():
    data = expect(API + "/changes", {"dataset": DATASET, "page_size": 2})["data"]
    for key in ("items", "deleted", "has_more", "next_cursor", "next_since", "latest_seq"):
        assert key in data, f"/changes 缺 {key}"
    latest = data["latest_seq"]
    tail = expect(API + "/changes", {"dataset": DATASET, "since": latest})["data"]
    assert tail["items"] == [], "since=latest 应无新变更"
    code, payload, _ = call(API + "/changes", {"dataset": DATASET, "page_size": 1001})
    assert code == 400, f"page_size 超限应 400，实际 {code}"
    code, payload, _ = call(API + "/changes", {"dataset": DATASET, "since": "garbage"})
    assert code == 400, f"坏 since 应 400，实际 {code}"
    return f"latest_seq={latest}，since 语义正确"


def c_docs():
    data = expect(API + "/docs")["data"]["docs"]
    names = {doc["name"] for doc in data}
    assert {"接入说明", "incremental"} <= names, f"文档列表缺项：{names}"
    doc = data[0]
    content = expect(API + "/docs/" + urllib.parse.quote(doc["name"], safe=""))["data"]
    assert content["format"] == "markdown" and content["content"], "文档内容为空"
    code, payload, _ = call(API + "/docs/not_exist_doc")
    assert code == 404, f"未知文档应 404，实际 {code}"
    return f"文档 {sorted(names)} 可读"


def c_test_accounts():
    """非纯数字 / 超过 10 位的 userid 都是测试账号：任何接口都不该出。"""
    for uid in ("duansiyuan", "xutianhao", "12345678901"):
        total = expect(API + "/traces", {"dataset": DATASET, "user_ids": uid})["data"]["total"]
        assert total == 0, f"测试账号 {uid} 在 /traces 里还有 {total} 条"
        users_total = expect(API + "/users", {"dataset": DATASET, "user_ids": uid})["data"]["total"]
        assert users_total["traces"] == 0, f"测试账号 {uid} 在 /users 里还有 {users_total['traces']} 条"
    numeric = expect(API + "/traces", {"dataset": DATASET, "page_size": 1})["data"]["items"][0]["user_id"]
    assert numeric and numeric.isdigit() and len(numeric) <= 10, f"可见用户 {numeric} 不是 10 位以内纯数字"
    return "英文名/长数字都不可见，可见 userid 全是 ≤10 位纯数字"


def c_gzip():
    req = urllib.request.Request(
        API + "/traces?dataset=" + DATASET + "&page_size=100",
        headers={"Accept-Encoding": "gzip", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        assert resp.headers.get("Content-Encoding") == "gzip", "大响应未 gzip"
    return "大响应按 Accept-Encoding 压缩"


def c_unknown_path():
    code, payload, _ = call(API + "/nope")
    assert code == 404, f"未知路径应 404，实际 {code}"
    return "未知路径 404"


CHECKS = [
    ("健康检查", c_health),
    ("响应信封与 meta", c_envelope),
    ("分类树", c_taxonomy),
    ("聚合 /summary", c_summary),
    ("严重度 /severity", c_severity),
    ("用户聚合 /users", c_users),
    ("trace 列表 /traces", c_traces),
    ("批量 /traces/batch", c_batch),
    ("详情 /traces/{id}", c_detail),
    ("增量 /changes", c_changes),
    ("文档 /docs", c_docs),
    ("测试账号口径", c_test_accounts),
    ("gzip", c_gzip),
    ("未知路径", c_unknown_path),
]


def main():
    print(f"audit {API}\n" + "-" * 72)
    for name, fn in CHECKS:
        check(name, fn)
    failed = [row for row in RESULTS if not row[0]]
    for ok, name, detail in RESULTS:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}: {detail}")
    print("-" * 72)
    print(f"{len(RESULTS) - len(failed)} passed, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
