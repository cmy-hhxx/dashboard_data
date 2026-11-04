"""验收用例：v2 协议的核心口径 + 本实现补充的边界。

用法：

    python3 tests/test_acceptance.py            # 用 fixture 自建服务，跑全部用例
    python3 tests/test_acceptance.py --real     # 打已部署服务，跑数据无关的用例
    python3 tests/test_acceptance.py --base-url http://127.0.0.1:5003 --real
"""

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "tests"))

import fixtures  # noqa: E402

API = "/api/v1/analysis"


# --------------------------------------------------------------------------- HTTP

class Client:
    def __init__(self, base):
        self.base = base.rstrip("/")
        # 不走系统代理：容器里 http_proxy 指向 squid，会把 127.0.0.1 也拦掉
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _call(self, method, path, params=None, body=None):
        url = self.base + path
        if params:
            clean = {k: v for k, v in params.items() if v is not None}
            if clean:
                url += "?" + urllib.parse.urlencode(clean, doseq=True)
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=60) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            try:
                return exc.code, json.loads(raw)
            except ValueError:
                return exc.code, {"raw": raw}

    def get(self, path, **params):
        return self._call("GET", path, params)

    def post(self, path, body):
        return self._call("POST", path, None, body)


def expect(status, payload, want=200):
    if status != want:
        raise AssertionError(f"期望 HTTP {want}，实际 {status}：{json.dumps(payload, ensure_ascii=False)[:300]}")
    return payload


# --------------------------------------------------------------------------- 用例

def check_taxonomy(client):
    problem_nodes = {}
    for app_version in ("AIME-Atlas_expert", "aime-fast-new_fast"):
        payload = expect(*client.get(f"{API}/taxonomy", kind="problem", app_version=app_version))
        nodes = payload["data"]["nodes"]
        codes = {node["code"] for node in nodes}
        for node in nodes:
            if node["parent_code"] is not None and node["parent_code"] not in codes:
                raise AssertionError(f"{app_version}: {node['code']} 的 parent_code 不存在")
            if "counts_as_error" in node:
                raise AssertionError(f"{app_version}: v2 不应再返回 counts_as_error")
        problem_nodes[app_version] = nodes

    intent = expect(*client.get(f"{API}/taxonomy", kind="intent"))
    codes = {node["code"] for node in intent["data"]["nodes"]}
    for node in intent["data"]["nodes"]:
        if node["parent_code"] is not None and node["parent_code"] not in codes:
            raise AssertionError(f"intent: {node['code']} 的 parent_code 不存在")

    severity = expect(*client.get(f"{API}/taxonomy", kind="severity"))
    levels = [node["code"] for node in severity["data"]["nodes"]]
    if levels != ["P0", "P1", "P2", "P3", "P4"]:
        raise AssertionError(f"severity 树应返回 P0–P4，实际 {levels}")
    return intent["data"]["nodes"]


def check_group_traces_consistency(client, dataset, group_by=("intent", "problem"), sample=5):
    payload = expect(*client.get(f"{API}/summary", dataset=dataset, group_by=",".join(group_by), limit=1000))
    groups = payload["data"]["groups"]
    if not groups:
        raise AssertionError("summary 没有返回任何分组")
    checked = 0
    for group in groups:
        if checked >= sample:
            break
        # 编码为 null 的分组无法用筛选条件复现（协议只承诺有编码的分组），跳过
        if any(value is None for value in group["keys"].values()):
            continue
        params = {"dataset": dataset}
        for dim, value in group["keys"].items():
            params[dim] = value
        traces = expect(*client.get(f"{API}/traces", **params))
        if traces["data"]["total"] != group["traces"]:
            raise AssertionError(
                f"分组 {group['keys']} traces={group['traces']}，/traces total={traces['data']['total']}"
            )
        checked += 1
    candidates = sum(1 for group in groups if all(value is not None for value in group["keys"].values()))
    if candidates == 0:
        raise AssertionError("没有带编码的分组，无法校验一致性")
    if checked < min(sample, candidates):
        raise AssertionError(f"抽样不足：只校验了 {checked} 组，候选 {candidates} 组")
    return checked


def check_denominator(client, dataset):
    intent_summary = expect(*client.get(f"{API}/summary", dataset=dataset, group_by="intent", level="top"))
    groups = [g for g in intent_summary["data"]["groups"] if g["keys"].get("intent")]
    if not groups:
        raise AssertionError("没有非空意图分组")
    target = groups[0]["keys"]["intent"]
    per_problem = expect(
        *client.get(f"{API}/summary", dataset=dataset, intent=target, group_by="problem", limit=1000)
    )
    analyzed = {row["analyzed"] for row in per_problem["data"]["groups"]}
    if len(analyzed) != 1:
        raise AssertionError(f"按问题分组的 analyzed 不一致：{sorted(analyzed)}")
    if analyzed.pop() != groups[0]["analyzed"]:
        raise AssertionError("analyzed 与意图分组的分母不等")
    return target


def check_problem_total(client, dataset):
    base = expect(*client.get(f"{API}/summary", dataset=dataset, group_by="day"))
    flagged = expect(
        *client.get(f"{API}/summary", dataset=dataset, severity="P0,P1,P2,P3,P4", group_by="day")
    )
    if base["data"]["total"]["problem_traces"] != flagged["data"]["total"]["traces"]:
        raise AssertionError(
            f"total.problem_traces={base['data']['total']['problem_traces']} 与筛全部严重度的 traces="
            f"{flagged['data']['total']['traces']} 不等"
        )
    severity = expect(*client.get(f"{API}/severity", dataset=dataset))
    if severity["data"]["total"]["problems"] != base["data"]["total"]["problems"]:
        raise AssertionError(
            f"/severity problems={severity['data']['total']['problems']} 与 /summary problems="
            f"{base['data']['total']['problems']} 不等"
        )


def check_severity_totals(client, dataset):
    payload = expect(*client.get(f"{API}/severity", dataset=dataset))
    total = payload["data"]["total"]
    levels = ["P0", "P1", "P2", "P3", "P4"]
    summed = sum(total["severity"][level]["problems"] for level in levels)
    if summed != total["problems"]:
        raise AssertionError(f"P0–P4 条目之和 {summed} != problems {total['problems']}")
    for level in levels:
        bucket = total["severity"][level]
        if bucket["traces"] > total["traces"]:
            raise AssertionError(f"{level} 的 traces 不可能超过 total.traces")
        if bucket["problems"] < bucket["traces"]:
            raise AssertionError(f"{level} 的条目数不应少于 trace 数")
        filtered = expect(*client.get(f"{API}/severity", dataset=dataset, severity=level))
        if filtered["data"]["total"]["severity"][level]["traces"] != bucket["traces"]:
            raise AssertionError(f"severity={level} 过滤后的 traces 与总表不一致")
        listed = expect(*client.get(f"{API}/traces", dataset=dataset, severity=level, page_size=100))
        if listed["data"]["total"] != bucket["traces"]:
            raise AssertionError(
                f"severity={level}: /severity traces={bucket['traces']}，/traces total={listed['data']['total']}"
            )


def check_severity_groups(client, dataset):
    for group_by in ("day", "app_version", "source", "intent", "problem"):
        payload = expect(*client.get(f"{API}/severity", dataset=dataset, group_by=group_by, limit=1000))
        summed = sum(row["problems"] for row in payload["data"]["groups"])
        if summed != payload["data"]["total"]["problems"]:
            raise AssertionError(f"group_by={group_by}: 各分组 problems 之和 {summed} != total")
        for row in payload["data"]["groups"]:
            if sum(row["severity"][level]["problems"] for level in ("P0", "P1", "P2", "P3", "P4")) != row["problems"]:
                raise AssertionError(f"group_by={group_by}: 分组的 P0–P4 之和与 problems 不等")


def check_intent_leaf_sum(client, dataset):
    leaf = expect(*client.get(f"{API}/summary", dataset=dataset, group_by="intent", level="leaf", limit=1000))
    total = leaf["data"]["total"]["traces"]
    summed = sum(row["traces"] for row in leaf["data"]["groups"])
    if summed != total:
        raise AssertionError(f"意图叶子分组之和 {summed} != total {total}")


def check_multi_problem(client, dataset, trace_id, codes):
    for code in codes:
        payload = expect(*client.get(f"{API}/traces", dataset=dataset, problem=code, page_size=100))
        found = {item["trace_id"] for item in payload["data"]["items"]}
        if trace_id not in found:
            raise AssertionError(f"多问题 trace {trace_id} 未出现在 problem={code} 的结果里")


def check_big_class(client, dataset, code, children):
    parent = expect(*client.get(f"{API}/traces", dataset=dataset, intent=code, page_size=1))
    total = parent["data"]["total"]
    child_sum = 0
    for child in children:
        payload = expect(*client.get(f"{API}/traces", dataset=dataset, intent=child, page_size=1))
        child_sum += payload["data"]["total"]
    if child_sum != total:
        raise AssertionError(f"大类 {code} total={total}，子类之和={child_sum}")


def check_unknown_code(client, dataset):
    status, payload = client.get(f"{API}/summary", dataset=dataset, intent="not_exist", group_by="day")
    if status != 422 or payload["error"]["code"] != "UNKNOWN_CODE":
        raise AssertionError(f"未知编码应返回 422：{status} {payload}")
    status, payload = client.get(f"{API}/summary", dataset=dataset, problem="not_exist", group_by="day")
    if status != 422 or payload["error"]["code"] != "UNKNOWN_CODE":
        raise AssertionError(f"未知问题编码应返回 422：{status} {payload}")
    status, payload = client.get(f"{API}/severity", dataset=dataset, severity="P9")
    if status != 422 or payload["error"]["code"] != "UNKNOWN_CODE":
        raise AssertionError(f"未知严重度应返回 422：{status} {payload}")


def check_batch(client, dataset, real_id, fake_id):
    payload = expect(
        *client.post(f"{API}/traces/batch", {"dataset": dataset, "trace_ids": [real_id, fake_id]})
    )
    items = payload["data"]["items"]
    if len(items) != 2:
        raise AssertionError(f"batch 应返回 2 条，实际 {len(items)}")
    if items[0]["trace_id"] != real_id or items[0]["status"] != "analyzed":
        raise AssertionError(f"batch 第一条不对：{items[0]}")
    for key in ("problems", "problem_codes", "problem_count", "is_correct", "session_id"):
        if key not in items[0]:
            raise AssertionError(f"batch 已分析条目缺字段 {key}")
    if not items[0]["session_id"]:
        raise AssertionError(f"batch 已分析条目缺 session_id：{items[0]}")
    if items[1]["trace_id"] != fake_id or items[1]["status"] != "not_analyzed":
        raise AssertionError(f"batch 第二条不对：{items[1]}")
    if items[1]["session_id"] is not None:
        raise AssertionError(f"未分析条目的 session_id 应为 null：{items[1]}")
    if items[1]["problems"] != [] or items[1]["problem_count"] != 0 or items[1]["is_correct"] is not None:
        raise AssertionError(f"未分析条目的问题字段应为空：{items[1]}")


def check_reanalysis(client, dataset, trace_id, day, expect_codes, expect_history=1):
    detail = expect(*client.get(f"{API}/traces/{trace_id}", dataset=dataset, day=day))
    data = detail["data"]
    if data["problem_codes"] != expect_codes:
        raise AssertionError(f"{trace_id} 的最新编码 {data['problem_codes']} != {expect_codes}")
    history = data["analysis"]["history"]
    if len(history) != expect_history:
        raise AssertionError(f"{trace_id} history 条数 {len(history)} != {expect_history}")
    if history and history[0]["problem_codes"] == expect_codes:
        raise AssertionError("history 里的旧版本不应等于最新版本")


def check_ids_only(client, dataset, attempts=3):
    """两轮翻页必须覆盖同一批 id。

    线上服务每 10 分钟换一次快照，两轮之间如果正好重建，新增 trace 会让集合不一致；
    这时重试一轮，连续三轮都撞上重建才跳过（记录 NOTE）。
    """
    last_race = None
    for _ in range(attempts):
        built_before = _built_at(client)
        params = {"dataset": dataset, "page_size": 100}
        pk = set()
        cursor = None
        while True:
            query = dict(params, cursor=cursor)
            status, payload = client.get(f"{API}/traces", **query)
            if status != 200:
                raise AssertionError(f"普通翻页失败：{status} {payload}")
            pk.update(item["trace_id"] for item in payload["data"]["items"])
            cursor = payload["data"]["next_cursor"]
            if not cursor:
                break
        cursor = None
        export = []
        exported = 0
        while True:
            status, payload = client.get(f"{API}/traces", dataset=dataset, ids_only="true", page_size=5000, cursor=cursor)
            if status != 200:
                raise AssertionError(f"ids_only 翻页失败：{status} {payload}")
            export.extend(payload["data"]["items"])
            exported = payload["data"]["total"]
            cursor = payload["data"]["next_cursor"]
            if not cursor:
                break
        built_after = _built_at(client)
        if built_before != built_after:
            last_race = built_after
            continue
        if len(export) != exported:
            raise AssertionError(f"ids_only 条数 {len(export)} != total {exported}")
        # trace_id 不全局唯一（跨模型 / 重跑），ids_only 允许同一 id 出现多次；按集合比对
        if set(export) != pk:
            missing = pk - set(export)
            extra = set(export) - pk
            raise AssertionError(f"ids_only 与普通翻页的 id 集合不一致：缺 {len(missing)} 个，多 {len(extra)} 个")
        return
    print(f"  NOTE  翻页期间服务换了快照（{last_race}），跳过导出集合比对")


def _built_at(client):
    status, payload = client.get("/healthz")
    if status != 200:
        raise AssertionError(f"/healthz 失败：{status} {payload}")
    return payload.get("built_at")


def check_user_ids(client, dataset, limit=5000):
    user_ids = [f"u_fake_{i}" for i in range(limit)]
    status, payload = client.post(
        f"{API}/summary", {"dataset": dataset, "user_ids": user_ids, "group_by": ["intent"]}
    )
    if status != 200:
        raise AssertionError(f"5000 个 user_ids 应正常返回：{status} {payload}")
    status, payload = client.post(
        f"{API}/summary", {"dataset": dataset, "user_ids": user_ids + ["extra"], "group_by": ["intent"]}
    )
    if status != 413:
        raise AssertionError(f"超过上限应返回 413：{status}")


def check_detail(client, dataset, trace_id, day):
    status, payload = client.get(f"{API}/traces/{trace_id}", dataset=dataset, day=day)
    if status != 200:
        raise AssertionError(f"详情失败：{status} {payload}")
    data = payload["data"]
    if not data["session"] or not data["trace"]:
        raise AssertionError("详情应返回 eval_input 的整行与 trace 对象")
    if data["trace"]["meta"]["trace_id"] != trace_id:
        raise AssertionError("详情返回的 trace 不是请求的那条")
    for key in ("problems", "problem_codes", "problem_count", "is_correct", "session_id"):
        if key not in data:
            raise AssertionError(f"详情缺字段 {key}")
    if "correct_reason" in data["analysis"]:
        raise AssertionError("v2 不再返回 correct_reason")
    status, payload = client.get(f"{API}/traces/{trace_id}", dataset=dataset)
    if status != 400:
        raise AssertionError(f"缺 day 应返回 400：{status}")
    status, payload = client.get(f"{API}/traces/nope", dataset=dataset, day=day)
    if status != 404:
        raise AssertionError(f"不存在的 trace 应返回 404：{status}")


def check_cursor_expired(client, dataset):
    from analysis_api import config, cursors, snapshot as snapshot_module

    filter_key = snapshot_module.Filters(dataset=dataset).cache_key()
    body = {"k": "traces", "f": filter_key, "p": 20, "t": int(time.time()) - config.CURSOR_TTL - 10, "c": ["", ""]}
    token = cursors.encode("traces", filter_key, 20, ["", ""])
    # 用同一条密钥、把签发时间改成过期后重新签名
    import base64
    import hashlib
    import hmac

    raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(cursors._secret(), raw, hashlib.sha256).digest()[:16]
    expired = base64.urlsafe_b64encode(signature + raw).decode("ascii").rstrip("=")
    if token == expired:
        raise AssertionError("cursor 生成异常")

    status, payload = client.get(f"{API}/traces", dataset=dataset, cursor=expired)
    if status != 410 or payload["error"]["code"] != "CURSOR_EXPIRED":
        raise AssertionError(f"过期 cursor 应返回 410：{status} {payload}")
    status, payload = client.get(f"{API}/traces", dataset=dataset, cursor="garbage")
    if status != 400:
        raise AssertionError(f"非法 cursor 应返回 400：{status}")
    status, payload = client.get(f"{API}/traces", dataset=dataset, cursor=token)
    if status != 200:
        raise AssertionError(f"有效 cursor 应正常返回：{status} {payload}")


def check_problem_group_counts(client, dataset):
    for path in ("summary", "severity"):
        payload = expect(*client.get(f"{API}/{path}", dataset=dataset, group_by="problem", limit=1000))
        summed = sum(row["problems"] for row in payload["data"]["groups"])
        if summed != payload["data"]["total"]["problems"]:
            raise AssertionError(f"/{path} group_by=problem: 分组 problems 之和 {summed} != total")
        # 未聚类问题应落在 problem=null 组，且有条目
        null_group = next((row for row in payload["data"]["groups"] if row["keys"].get("problem") is None), None)
        if null_group is None or null_group["problems"] <= 0:
            raise AssertionError(f"/{path} group_by=problem: 未聚类问题应进 problem=null 组：{null_group}")


def check_problem_entries(client, dataset):
    """问题数组是真相：未聚类问题也有严重度，列表/详情/batch 一致。"""
    payload = expect(*client.get(f"{API}/traces", dataset=dataset, page_size=100))
    for item in payload["data"]["items"]:
        if item["problem_count"] != len(item["problems"]):
            raise AssertionError(f"{item['trace_id']} problem_count 与 problems 长度不等")
        if item["problem_codes"] != sorted({p["code"] for p in item["problems"] if p["code"]}):
            raise AssertionError(f"{item['trace_id']} problem_codes 与 problems 中的编码不一致")
        for problem in item["problems"]:
            if problem["severity"] not in ("P0", "P1", "P2", "P3", "P4"):
                raise AssertionError(f"{item['trace_id']} 的问题缺少严重度：{problem}")
    delta = next((item for item in payload["data"]["items"] if item["trace_id"] == "trace_delta"), None)
    if delta is not None:
        if delta["problem_count"] != 2 or delta["problem_codes"] != []:
            raise AssertionError(f"未聚类问题应计入 problems、不进 problem_codes：{delta}")
    alpha = next((item for item in payload["data"]["items"] if item["trace_id"] == "trace_alpha"), None)
    if alpha is not None and alpha["problem_count"] != 1:
        raise AssertionError(f"重跑后 trace_alpha 只应有 1 个问题：{alpha}")


def check_session_problem_once(client, dataset):
    """session 级问题只在会话最后一轮出现一次，列表/详情/统计三处一致。"""
    payload = expect(
        *client.post(f"{API}/traces/batch", {"dataset": dataset, "trace_ids": ["trace_multi_1", "trace_multi_2"]})
    )
    by_id = {item["trace_id"]: item for item in payload["data"]["items"]}
    first, last = by_id["trace_multi_1"], by_id["trace_multi_2"]
    if first["problem_count"] != 1 or any(p["session_level"] for p in first["problems"]):
        raise AssertionError(f"第一轮不应带跨轮问题：{first['problems']}")
    if last["problem_count"] != 1 or [p["session_level"] for p in last["problems"]] != [True]:
        raise AssertionError(f"最后一轮应带 1 条跨轮问题：{last['problems']}")

    detail_first = expect(*client.get(f"{API}/traces/trace_multi_1", dataset=dataset, day=fixtures.DAY))
    detail_last = expect(*client.get(f"{API}/traces/trace_multi_2", dataset=dataset, day=fixtures.DAY))
    if len(detail_first["data"]["analysis"]["problems"]) != 1:
        raise AssertionError("第一轮详情不应出现跨轮问题")
    last_problems = detail_last["data"]["analysis"]["problems"]
    if len(last_problems) != 1 or not last_problems[0]["session_level"]:
        raise AssertionError(f"最后一轮详情应只有 1 条跨轮问题：{last_problems}")

    ids = expect(*client.get(f"{API}/traces", dataset=dataset, ids_only="true", page_size=5000))["data"]["items"]
    unique_ids = sorted(set(ids))
    problems_total = 0
    for start in range(0, len(unique_ids), 1000):
        batch = expect(
            *client.post(f"{API}/traces/batch", {"dataset": dataset, "trace_ids": unique_ids[start:start + 1000]})
        )
        problems_total += sum(item["problem_count"] for item in batch["data"]["items"])
    severity_total = expect(*client.get(f"{API}/severity", dataset=dataset))["data"]["total"]["problems"]
    if problems_total != severity_total:
        raise AssertionError(f"逐条 problems 之和 {problems_total} != /severity total {severity_total}")


# --------------------------------------------------------------------------- 运行

def start_fixture_server(workdir: Path):
    data_root = workdir / "datasets"
    fixtures.build(data_root)
    state = workdir / "state"
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = dict(os.environ)
    env["EVAL_DATASETS"] = str(data_root)
    env["ANALYSIS_STATE"] = str(state)
    env["PORT"] = str(port)
    env["REFRESH_SECONDS"] = "3600"
    os.environ.update({"EVAL_DATASETS": str(data_root), "ANALYSIS_STATE": str(state)})
    log = (workdir / "server.log").open("wb")
    process = subprocess.Popen(
        [sys.executable, str(REPO / "run.py"), "serve", "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(REPO),
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    opener = Client(base).opener  # 同样绕开容器里的 http_proxy
    deadline = time.time() + 120
    while time.time() < deadline:
        if process.poll() is not None:
            raise SystemExit(f"服务进程退出：\n{(workdir / 'server.log').read_text()}")
        try:
            with opener.open(base + "/healthz", timeout=2) as response:
                payload = json.loads(response.read())
            if payload.get("ok"):
                return process, base, data_root, log
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.3)
    process.kill()  # 不留孤儿服务进程
    raise SystemExit(f"服务未就绪：\n{(workdir / 'server.log').read_text()}")


def _run_cases(cases, process, log):
    passed, failed = 0, []
    try:
        for name, fn in cases:
            try:
                fn()
                passed += 1
                print(f"  PASS  {name}")
            except AssertionError as exc:
                failed.append((name, str(exc)))
                print(f"  FAIL  {name}: {exc}")
    finally:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
        log.close()

    print()
    if failed:
        print(f"{passed} passed, {len(failed)} failed")
        for name, message in failed:
            print(f"  - {name}: {message}")
        return 1
    print(f"all {passed} cases passed")
    return 0


def run_fixture_cases(workdir: Path):
    process, base, data_root, log = start_fixture_server(workdir)
    client = Client(base)
    dataset = "aime_eval"
    nodes = {}

    def _taxonomy():
        nodes["intent"] = check_taxonomy(client)

    cases = [
        ("1 分类树完整", _taxonomy),
        ("2 分组与明细一致", lambda: check_group_traces_consistency(client, dataset)),
        ("3 分母规则", lambda: check_denominator(client, dataset)),
        ("4 问题占比", lambda: check_problem_total(client, dataset)),
        ("5 严重度总量", lambda: check_severity_totals(client, dataset)),
        ("6 严重度分组", lambda: check_severity_groups(client, dataset)),
        ("7 问题数组", lambda: check_problem_entries(client, dataset)),
        ("7b 问题分组条目数", lambda: check_problem_group_counts(client, dataset)),
        ("7c 跨轮问题只计一次", lambda: check_session_problem_once(client, dataset)),
        ("8 意图互斥", lambda: check_intent_leaf_sum(client, dataset)),
        ("9 多问题计数", lambda: check_multi_problem(client, dataset, "trace_gamma", ["S1.M1.1", "S9.M5.1"])),
        (
            "10 大类展开",
            lambda: check_big_class(
                client,
                dataset,
                "T01",
                [node["code"] for node in nodes["intent"] if node["parent_code"] == "T01"],
            ),
        ),
        ("11 未知编码/严重度", lambda: check_unknown_code(client, dataset)),
        ("12 批量查询", lambda: check_batch(client, dataset, "trace_alpha", "trace_missing")),
        (
            "13 重分析",
            lambda: check_reanalysis(client, dataset, "trace_alpha", fixtures.DAY, ["S1.M1.1"], 1),
        ),
        ("14 导出", lambda: check_ids_only(client, dataset)),
        ("15 用户筛选", lambda: check_user_ids(client, dataset)),
        ("16 详情", lambda: check_detail(client, dataset, "trace_alpha", fixtures.DAY)),
        ("17 cursor 过期", lambda: check_cursor_expired(client, dataset)),
    ]
    return _run_cases(cases, process, log)


def run_real_cases(base, history_trace=None, history_day=None):
    client = Client(base)
    dataset = "aime_eval"
    nodes = {}

    def _taxonomy():
        nodes["intent"] = check_taxonomy(client)

    def _reanalysis():
        """校验重分析：优先用 --history-trace 指定的 trace，否则抽样翻页找一条带历史的。"""
        if history_trace:
            detail = expect(
                *client.get(f"{API}/traces/{history_trace}", dataset=dataset, day=history_day)
            )
            history = detail["data"]["analysis"]["history"]
            if not history:
                raise AssertionError(f"{history_trace} 没有历史版本")
            if any(row["problem_codes"] == detail["data"]["problem_codes"] for row in history):
                raise AssertionError("history 里的旧版本不应等于最新版本")
            return
        cursor = None
        for _page in range(40):
            listing = expect(*client.get(f"{API}/traces", dataset=dataset, page_size=100, cursor=cursor))
            items = listing["data"]["items"]
            if not items:
                break
            picks = {0, len(items) // 2, len(items) - 1}
            for index in sorted(picks):
                item = items[index]
                detail = expect(
                    *client.get(f"{API}/traces/{item['trace_id']}", dataset=dataset, day=item["day"])
                )
                history = detail["data"]["analysis"]["history"]
                if not history:
                    continue
                if not detail["data"]["problem_count"]:
                    raise AssertionError(f"{item['trace_id']} 有历史版本但最新版没有问题条目")
                if any(row["problem_codes"] == detail["data"]["problem_codes"] for row in history):
                    raise AssertionError("history 里的旧版本不应等于最新版本")
                return
            cursor = listing["data"]["next_cursor"]
            if not cursor:
                break
        # 抽样没命中：用构建摘要确认索引里确实有历史版本，逻辑本身已由 fixture 用例覆盖
        health = client.get("/healthz")[1]
        if (health.get("build") or {}).get("history"):
            print("  NOTE  抽样未命中历史版本，索引里存在 history；可用 --history-trace 指定一条")
            return
        raise AssertionError("索引里没有历史版本，无法验证重分析")

    def _multi():
        summary = expect(*client.get(f"{API}/summary", dataset=dataset, group_by="problem", level="leaf", limit=1000))
        multi_codes = [g["keys"]["problem"] for g in summary["data"]["groups"] if g["keys"]["problem"]]
        if len(multi_codes) < 2:
            raise AssertionError("问题分组不足两个")
        listing = expect(*client.get(f"{API}/traces", dataset=dataset, problem=",".join(multi_codes[:2]), page_size=100))
        target = None
        for item in listing["data"]["items"]:
            if len(item["problem_codes"]) >= 2:
                target = item
                break
        if target is None:
            raise AssertionError("没有找到命中两个问题的 trace")
        for code in target["problem_codes"][:2]:
            payload = expect(*client.get(f"{API}/traces", dataset=dataset, problem=code, page_size=100))
            if target["trace_id"] not in {i["trace_id"] for i in payload["data"]["items"]}:
                raise AssertionError(f"{target['trace_id']} 不在 problem={code} 的结果里")

    def _detail():
        listing = expect(*client.get(f"{API}/traces", dataset=dataset, page_size=1))
        item = listing["data"]["items"][0]
        payload = expect(*client.get(f"{API}/traces/{item['trace_id']}", dataset=dataset, day=item["day"]))
        if not payload["data"].get("session"):
            raise AssertionError("详情没有返回 eval_input 的整行")

    def _expansion():
        summary = expect(*client.get(f"{API}/summary", dataset=dataset, group_by="problem", level="top", limit=1000))
        codes = [g["keys"]["problem"] for g in summary["data"]["groups"] if g["keys"]["problem"]]
        if not codes:
            raise AssertionError("没有顶层问题编码")
        checked = 0
        for code in codes[:3]:
            group = next(g for g in summary["data"]["groups"] if g["keys"]["problem"] == code)
            listing = expect(*client.get(f"{API}/traces", dataset=dataset, problem=code, page_size=1))
            if listing["data"]["total"] != group["traces"]:
                raise AssertionError(f"problem={code} 展开后 total={listing['data']['total']}，分组={group['traces']}")
            checked += 1
        if checked == 0:
            raise AssertionError("大类展开未校验任何编码")

    def _batch():
        listing = expect(*client.get(f"{API}/traces", dataset=dataset, page_size=1, ids_only="true"))
        trace_id = listing["data"]["items"][0]
        check_batch(client, dataset, trace_id, "trace_does_not_exist")

    process = _PASSTHROUGH
    log = _PassthroughLog()
    cases = [
        ("1 分类树完整", _taxonomy),
        ("2 分组与明细一致", lambda: check_group_traces_consistency(client, dataset)),
        ("3 分母规则", lambda: check_denominator(client, dataset)),
        ("4 问题占比", lambda: check_problem_total(client, dataset)),
        ("5 严重度总量", lambda: check_severity_totals(client, dataset)),
        ("6 严重度分组", lambda: check_severity_groups(client, dataset)),
        ("7 问题数组", lambda: check_problem_entries(client, dataset)),
        ("7b 问题分组条目数", lambda: check_problem_group_counts(client, dataset)),
        ("7c 跨轮问题只计一次", lambda: check_session_problem_once(client, dataset)),
        ("8 意图互斥", lambda: check_intent_leaf_sum(client, dataset)),
        ("9 多问题计数", _multi),
        ("10 大类展开", _expansion),
        ("11 未知编码/严重度", lambda: check_unknown_code(client, dataset)),
        ("12 批量查询", _batch),
        ("13 重分析", _reanalysis),
        ("14 导出", lambda: check_ids_only(client, dataset)),
        ("15 用户筛选", lambda: check_user_ids(client, dataset, limit=5000)),
        ("16 详情", _detail),
    ]
    return _run_cases(cases, process, log)


class _Passthrough:
    def send_signal(self, _signal):
        pass

    def wait(self, timeout=None):
        return 0

    def kill(self):
        pass


class _PassthroughLog:
    def close(self):
        pass


_PASSTHROUGH = _Passthrough()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--real", action="store_true", help="打已部署服务")
    parser.add_argument("--base-url", default="http://127.0.0.1:5003")
    parser.add_argument("--history-trace", default=None, help="真实数据验收时指定的重分析 trace_id")
    parser.add_argument("--history-day", default=None, help="配合 --history-trace 的 day")
    args = parser.parse_args()

    if args.real:
        return run_real_cases(args.base_url, args.history_trace, args.history_day)

    with tempfile.TemporaryDirectory(prefix="analysis-fixture-") as tmp:
        return run_fixture_cases(Path(tmp))


if __name__ == "__main__":
    raise SystemExit(main())
