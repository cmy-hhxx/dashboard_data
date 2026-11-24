"""问财 RSI 布局（0_wencai/2_rsi_eval + 2_rsi_input）的供数验收。

AIME 的完整协议用例在 test_acceptance.py；这里只覆盖布局差异：
cohort→source、目录模型→app_version、聚类 total、compact 日期文件名、北京时间划日。
"""

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


class Client:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def get(self, path, **params):
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None}, doseq=True)
        try:
            with self.opener.open(url, timeout=30) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())


def start(workdir: Path):
    data = workdir / "datasets"
    fixtures.build_wencai(data)
    state = workdir / "state"
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = dict(os.environ, EVAL_DATASETS=str(data), ANALYSIS_STATE=str(state),
               ANALYSIS_DATASET="wencai_eval", PORT=str(port), REFRESH_SECONDS="3600")
    log = (workdir / "server.log").open("wb")
    process = subprocess.Popen(
        [sys.executable, str(REPO / "run.py"), "serve", "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(REPO), env=env, stdout=log, stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    opener = Client(base).opener
    deadline = time.time() + 120
    while time.time() < deadline:
        if process.poll() is not None:
            raise SystemExit(f"服务进程退出：\n{(workdir / 'server.log').read_text()}")
        try:
            with opener.open(base + "/healthz", timeout=2) as response:
                if json.loads(response.read()).get("ok"):
                    return process, Client(base), log
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.3)
    process.kill()
    raise SystemExit(f"服务未就绪：\n{(workdir / 'server.log').read_text()}")


def run_cases(client: Client):
    dataset = "wencai_eval"
    status, health = client.get("/healthz")
    assert status == 200 and health["dataset"] == dataset, health
    assert health["traces"] == 2, health

    status, payload = client.get(f"{API}/traces", dataset=dataset)
    assert status == 200, payload
    rows = payload["data"]["items"]
    assert {r["app_version"] for r in rows} == {"b_expert"}, rows
    assert {r["source"] for r in rows} == {fixtures.WENCAI_COHORT}, rows
    assert {r["day"] for r in rows} == {fixtures.WENCAI_DAY}, rows
    assert {r["query_preview"] for r in rows} == {"云南锗业为什么涨停", "今天适合买什么"}, rows
    assert {r["intent_code"] for r in rows} == {"FIN-L2-024"}, rows
    assert {r["task"] for r in rows} == {"投资标的研究与分析"}, rows
    assert {r["subtask"] for r in rows} == {"事件影响与异常波动研究"}, rows

    status, sev = client.get(f"{API}/severity", dataset=dataset)
    assert status == 200 and sev["data"]["total"]["analyzed"] == 2, sev
    assert sev["data"]["total"]["severity"]["P2"]["problems"] == 1, sev
    assert sev["data"]["total"]["severity"]["P4"]["problems"] == 1, sev

    status, summary = client.get(f"{API}/summary", dataset=dataset, group_by="source")
    assert status == 200, summary
    assert [g["keys"]["source"] for g in summary["data"]["groups"]] == [fixtures.WENCAI_COHORT], summary

    status, filtered = client.get(f"{API}/traces", dataset=dataset, source=fixtures.WENCAI_COHORT)
    assert status == 200 and filtered["data"]["total"] == 2, filtered
    status, unknown = client.get(f"{API}/traces", dataset=dataset, source="不存在")
    assert status == 422, unknown

    status, tax = client.get(f"{API}/taxonomy", kind="problem", app_version="b_expert")
    assert status == 200, tax
    assert "S1.M1.1" in {n["code"] for n in tax["data"]["nodes"]}, tax

    status, detail = client.get(f"{API}/traces/trace_wc_alpha", dataset=dataset, day=fixtures.WENCAI_DAY)
    assert status == 200, detail
    assert detail["data"]["app_version"] == "b_expert", detail
    assert detail["data"]["session"] and detail["data"]["trace"], detail
    assert detail["data"]["session"]["meta"]["task_category"] == "投资标的研究与分析", detail
    assert {p["code"] for p in detail["data"]["problems"]} == {"S1.M1.1", "S9.M5.1"}, detail

    status, changes = client.get(f"{API}/changes", dataset=dataset, page_size=10)
    assert status == 200 and len(changes["data"]["items"]) == 2, changes
    assert changes["data"]["next_since"], changes

    status, wrong = client.get(f"{API}/traces", dataset="aime_eval")
    assert status == 422, wrong

    status, index = client.get(f"{API}/docs")
    assert status == 200, index
    assert {d["name"] for d in index["data"]["docs"]} == {"接入说明", "incremental"}, index
    status, guide = client.get(f"{API}/docs/" + urllib.parse.quote("接入说明"))
    assert status == 200 and "wencai_eval" in guide["data"]["content"], guide
    status, missing = client.get(f"{API}/docs/not-exist")
    assert status == 404, missing


def main():
    with tempfile.TemporaryDirectory() as tmp:
        process, client, log = start(Path(tmp))
        try:
            run_cases(client)
            print("all wencai layout cases passed")
            return 0
        finally:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
            log.close()


if __name__ == "__main__":
    raise SystemExit(main())
