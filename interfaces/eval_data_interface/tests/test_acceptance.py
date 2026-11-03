"""验收用例：协议 §12 的 12 条 + 本实现补充的边界。

用法：

    python3 tests/test_acceptance.py            # 用 fixture 自建服务，跑全部用例
    python3 tests/test_acceptance.py --real     # 打已部署服务，跑数据无关的 12 条
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
    for app_version in ("AIME-Atlas_expert", "aime-fast-new_fast"):
        payload = expect(
            *client.get(f"{API}/taxonomy", kind="error", app_version=app_version)
        )
        nodes = payload["data"]["nodes"]
        codes = {node["code"] for node in nodes}
        for node in nodes:
            if node["parent_code"] is not None and node["parent_code"] not in codes:
                raise AssertionError(f"{app_version}: {node['code']} 的 parent_code 不存在")
    intent = expect(*client.get(f"{API}/taxonomy", kind="intent"))
    codes = {node["code"] for node in intent["data"]["nodes"]}
    for node in intent["data"]["nodes"]:
        if node["parent_code"] is not None and node["parent_code"] not in codes:
            raise AssertionError(f"intent: {node['code']} 的 parent_code 不存在")
    return intent["data"]["nodes"]


def check_group_traces_consistency(client, dataset, group_by=("intent", "error"), sample=5):
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
    per_error = expect(
        *client.get(f"{API}/summary", dataset=dataset, intent=target, group_by="error", limit=1000)
    )
    analyzed = {row["analyzed"] for row in per_error["data"]["groups"]}
    if len(analyzed) != 1:
        raise AssertionError(f"按问题分组的 analyzed 不一致：{sorted(analyzed)}")
    if analyzed.pop() != groups[0]["analyzed"]:
        raise AssertionError("analyzed 与意图分组的分母不等")
    return target


def check_error_total(client, dataset):
    base = expect(*client.get(f"{API}/summary", dataset=dataset, group_by="day"))
    flagged = expect(*client.get(f"{API}/summary", dataset=dataset, has_error="true", group_by="day"))
    if base["data"]["total"]["error_traces"] != flagged["data"]["total"]["traces"]:
        raise AssertionError(
            f"total.error_traces={base['data']['total']['error_traces']} 与 has_error=true 的 traces={flagged['data']['total']['traces']} 不等"
        )


def check_intent_leaf_sum(client, dataset):
    leaf = expect(*client.get(f"{API}/summary", dataset=dataset, group_by="intent", level="leaf", limit=1000))
    total = leaf["data"]["total"]["traces"]
    summed = sum(row["traces"] for row in leaf["data"]["groups"])
    if summed != total:
        raise AssertionError(f"意图叶子分组之和 {summed} != total {total}")


def check_multi_problem(client, dataset, trace_id, codes):
    for code in codes:
        payload = expect(*client.get(f"{API}/traces", dataset=dataset, error=code, page_size=100))
        found = {item["trace_id"] for item in payload["data"]["items"]}
        if trace_id not in found:
            raise AssertionError(f"多问题 trace {trace_id} 未出现在 error={code} 的结果里")


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


def check_batch(client, dataset, real_id, fake_id):
    payload = expect(
        *client.post(f"{API}/traces/batch", {"dataset": dataset, "trace_ids": [real_id, fake_id]})
    )
    items = payload["data"]["items"]
    if len(items) != 2:
        raise AssertionError(f"batch 应返回 2 条，实际 {len(items)}")
    if items[0]["trace_id"] != real_id or items[0]["status"] != "analyzed":
        raise AssertionError(f"batch 第一条不对：{items[0]}")
    if items[1]["trace_id"] != fake_id or items[1]["status"] != "not_analyzed":
        raise AssertionError(f"batch 第二条不对：{items[1]}")


def check_reanalysis(client, dataset, trace_id, day, expect_codes, expect_history=1):
    detail = expect(*client.get(f"{API}/traces/{trace_id}", dataset=dataset, day=day))
    data = detail["data"]
    if data["error_codes"] != expect_codes:
        raise AssertionError(f"{trace_id} 的最新编码 {data['error_codes']} != {expect_codes}")
    history = data["analysis"]["history"]
    if len(history) != expect_history:
        raise AssertionError(f"{trace_id} history 条数 {len(history)} != {expect_history}")
    if history and history[0]["error_codes"] == expect_codes:
        raise AssertionError("history 里的旧版本不应等于最新版本")


def check_ids_only(client, dataset):
    params = {"dataset": dataset, "page_size": 2}
    pk, paged = {}, None
    cursor = None
    while True:
        query = dict(params, cursor=cursor)
        status, payload = client.get(f"{API}/traces", **query)
        if status != 200:
            raise AssertionError(f"普通翻页失败：{status} {payload}")
        items = payload["data"]["items"]
        for item in items:
            pk[item["trace_id"]] = True
        cursor = payload["data"]["next_cursor"]
        if not cursor:
            break
    cursor = None
    export, exported = [], 0
    while True:
        status, payload = client.get(f"{API}/traces", dataset=dataset, ids_only="true", page_size=5000, cursor=cursor)
        if status != 200:
            raise AssertionError(f"ids_only 翻页失败：{status} {payload}")
        for tid in payload["data"]["items"]:
            if tid not in pk:
                raise AssertionError(f"ids_only 返回了普通翻页没有的 id：{tid}")
            export.append(tid)
        exported = payload["data"]["total"]
        cursor = payload["data"]["next_cursor"]
        if not cursor:
            break
    if len(export) != exported:
        raise AssertionError(f"ids_only 条数 {len(export)} != total {exported}")
    if set(export) != set(pk):
        raise AssertionError("ids_only 与普通翻页的 id 集合不一致")


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


def run_fixture_cases(workdir: Path):
    process, base, data_root, log = start_fixture_server(workdir)
    client = Client(base)
    dataset = "aime_eval"
    passed, failed = 0, []

    def case(name, fn):
        nonlocal passed
        try:
            fn()
            passed += 1
            print(f"  PASS  {name}")
        except AssertionError as exc:
            failed.append((name, str(exc)))
            print(f"  FAIL  {name}: {exc}")

    try:
        nodes = {}

        def _taxonomy():
            nodes["intent"] = check_taxonomy(client)

        case("1 分类树完整", _taxonomy)
        case("2 分组与明细一致", lambda: check_group_traces_consistency(client, dataset))
        case("3 分母规则", lambda: check_denominator(client, dataset))
        case("4 错误占比", lambda: check_error_total(client, dataset))
        case("5 意图互斥", lambda: check_intent_leaf_sum(client, dataset))
        case("6 多问题计数", lambda: check_multi_problem(client, dataset, "trace_gamma", ["S1.M1.1", "S9.M5.1"]))
        case(
            "7 大类展开",
            lambda: check_big_class(
                client,
                dataset,
                "T01",
                [node["code"] for node in nodes["intent"] if node["parent_code"] == "T01"],
            ),
        )
        case("8 未知编码", lambda: check_unknown_code(client, dataset))
        case("9 批量查询", lambda: check_batch(client, dataset, "trace_alpha", "trace_missing"))
        case(
            "10 重分析",
            lambda: check_reanalysis(client, dataset, "trace_alpha", fixtures.DAY, ["S1.M1.1"], 1),
        )
        case("11 导出", lambda: check_ids_only(client, dataset))
        case("12 用户筛选", lambda: check_user_ids(client, dataset))
        case("13 详情", lambda: check_detail(client, dataset, "trace_alpha", fixtures.DAY))
        case("14 cursor 过期", lambda: check_cursor_expired(client, dataset))
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


def run_real_cases(base):
    client = Client(base)
    dataset = "aime_eval"
    passed, failed = 0, []

    def case(name, fn):
        nonlocal passed
        try:
            fn()
            passed += 1
            print(f"  PASS  {name}")
        except AssertionError as exc:
            failed.append((name, str(exc)))
            print(f"  FAIL  {name}: {exc}")

    nodes = {}

    def _taxonomy():
        nodes["intent"] = check_taxonomy(client)

    def _reanalysis():
        listing = expect(*client.get(f"{API}/traces", dataset=dataset, page_size=100))
        for item in listing["data"]["items"]:
            detail = expect(
                *client.get(f"{API}/traces/{item['trace_id']}", dataset=dataset, day=item["day"])
            )
            history = detail["data"]["analysis"]["history"]
            if history:
                if detail["data"]["error_codes"] and history[0]["error_codes"] == detail["data"]["error_codes"]:
                    pass
                return
        raise AssertionError("没有找到带历史版本的 trace，无法验证重分析")

    def _multi():
        summary = expect(*client.get(f"{API}/summary", dataset=dataset, group_by="error", level="leaf", limit=1000))
        multi_codes = [g["keys"]["error"] for g in summary["data"]["groups"] if g["keys"]["error"]]
        if len(multi_codes) < 2:
            raise AssertionError("问题分组不足两个")
        listing = expect(*client.get(f"{API}/traces", dataset=dataset, error=",".join(multi_codes[:2]), page_size=100))
        target = None
        for item in listing["data"]["items"]:
            if len(item["error_codes"]) >= 2:
                target = item
                break
        if target is None:
            raise AssertionError("没有找到命中两个问题的 trace")
        for code in target["error_codes"][:2]:
            payload = expect(*client.get(f"{API}/traces", dataset=dataset, error=code, page_size=100))
            if target["trace_id"] not in {i["trace_id"] for i in payload["data"]["items"]}:
                raise AssertionError(f"{target['trace_id']} 不在 error={code} 的结果里")

    def _detail():
        listing = expect(*client.get(f"{API}/traces", dataset=dataset, page_size=1))
        item = listing["data"]["items"][0]
        payload = expect(*client.get(f"{API}/traces/{item['trace_id']}", dataset=dataset, day=item["day"]))
        if not payload["data"].get("session"):
            raise AssertionError("详情没有返回 eval_input 的整行")

    def _expansion():
        summary = expect(*client.get(f"{API}/summary", dataset=dataset, group_by="error", level="top", limit=1000))
        codes = [g["keys"]["error"] for g in summary["data"]["groups"] if g["keys"]["error"]]
        if not codes:
            raise AssertionError("没有顶层问题编码")
        checked = 0
        for code in codes[:3]:
            group = next(g for g in summary["data"]["groups"] if g["keys"]["error"] == code)
            listing = expect(*client.get(f"{API}/traces", dataset=dataset, error=code, page_size=1))
            if listing["data"]["total"] != group["traces"]:
                raise AssertionError(f"error={code} 展开后 total={listing['data']['total']}，分组={group['traces']}")
            checked += 1
        if checked == 0:
            raise AssertionError("大类展开未校验任何编码")

    def _batch():
        listing = expect(*client.get(f"{API}/traces", dataset=dataset, page_size=1, ids_only="true"))
        trace_id = listing["data"]["items"][0]
        check_batch(client, dataset, trace_id, "trace_does_not_exist")

    case("1 分类树完整", _taxonomy)
    case("2 分组与明细一致", lambda: check_group_traces_consistency(client, dataset))
    case("3 分母规则", lambda: check_denominator(client, dataset))
    case("4 错误占比", lambda: check_error_total(client, dataset))
    case("5 意图互斥", lambda: check_intent_leaf_sum(client, dataset))
    case("6 多问题计数", _multi)
    case("7 大类展开", _expansion)
    case("8 未知编码", lambda: check_unknown_code(client, dataset))
    case("9 批量查询", _batch)
    case("10 重分析", _reanalysis)
    case("11 导出", lambda: check_ids_only(client, dataset))
    case("12 用户筛选", lambda: check_user_ids(client, dataset, limit=5000))
    case("13 详情", _detail)

    print()
    if failed:
        print(f"{passed} passed, {len(failed)} failed")
        for name, message in failed:
            print(f"  - {name}: {message}")
        return 1
    print(f"all {passed} cases passed")
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--real", action="store_true", help="打已部署服务")
    parser.add_argument("--base-url", default="http://127.0.0.1:5003")
    args = parser.parse_args()

    if args.real:
        return run_real_cases(args.base_url)

    with tempfile.TemporaryDirectory(prefix="analysis-fixture-") as tmp:
        return run_fixture_cases(Path(tmp))


if __name__ == "__main__":
    raise SystemExit(main())
