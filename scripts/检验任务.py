#!/usr/bin/env python3
# 检验任务：AIME 数据一致性 / 质量巡检常驻进程（PG 16 账本 + 多帧 Zstd 包 + 上游原始日志）。
import argparse
import fcntl
import hashlib
import json
import os
import resource
import signal
import sys
import time
import urllib.request
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

DATA_ROOT = Path(os.environ.get("AIME_DATA_ROOT", "/mnt/aime_eval_ssd/1_aime"))
UPSTREAM = Path(os.environ.get("AIME_UPSTREAM_ROOT", "/mnt/aime_eval_ssd/0_litefusion_data/online_data"))
STATE_PATH = Path(os.environ.get("INSPECT_STATE", "/opt/检验任务.state.json"))
PG_PATH = "/opt/pg_data_core"
PACKS_PER_ROUND = 12
PTR_PER_ROUND = 4000
INTERVAL = {"ledger": 600, "pg": 600, "mv": 900, "svc": 120}


def _ensure_pg_path() -> None:
    if PG_PATH not in sys.path:
        sys.path.insert(0, PG_PATH)


def set_proc_name(name: str) -> None:
    try:
        import ctypes
        ctypes.CDLL(None).prctl(15, name.encode("utf-8")[:15], 0, 0, 0)
    except Exception:
        pass


def cpu_seconds() -> float:
    proc_dir = Path("/proc")
    if proc_dir.is_dir():
        try:
            clk = float(os.sysconf("SC_CLK_TCK"))
            table: dict[int, tuple[int, int]] = {}
            children: dict[int, list[int]] = {}
            for entry in proc_dir.iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    raw = (entry / "stat").read_text()
                    rp = raw.rfind(")")
                    if rp < 0:
                        continue
                    fields = raw[rp + 2:].split()
                    pid = int(entry.name)
                    ppid = int(fields[1])
                    ticks = int(fields[11]) + int(fields[12])
                    table[pid] = (ppid, ticks)
                    children.setdefault(ppid, []).append(pid)
                except (OSError, ValueError, IndexError):
                    continue
            root = os.getpid()
            if root in table:
                total_ticks = 0
                queue = [root]
                seen: set[int] = set()
                while queue:
                    cur = queue.pop()
                    if cur in seen:
                        continue
                    seen.add(cur)
                    if cur in table:
                        total_ticks += table[cur][1]
                    queue.extend(children.get(cur, ()))
                return total_ticks / clk
        except Exception:
            pass
    r = resource.getrusage(resource.RUSAGE_SELF)
    rc = resource.getrusage(resource.RUSAGE_CHILDREN)
    return r.ru_utime + r.ru_stime + rc.ru_utime + rc.ru_stime


def log(msg: str) -> None:
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}", flush=True)


def pg_query(sql: str, params: tuple = ()):
    _ensure_pg_path()
    from pg_data_core.config import load_config
    from pg_data_core.db import connect_direct
    conn = None
    try:
        conn = connect_direct(load_config(role="ro"), app_name="aime_inspect")
        return conn.execute(sql, params).fetchall()
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


# ---------- 包账本 vs 磁盘 ----------

def check_ledger() -> dict:
    try:
        rows = pg_query("SELECT rel_path, committed_bytes FROM public.pack_files")
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}
    out = {"rows": len(rows), "missing": [], "size_mismatch": [], "unregistered": 0}
    known = set()
    for r in rows:
        rel = r["rel_path"]
        known.add(rel)
        try:
            size = (DATA_ROOT / rel).stat().st_size
        except OSError:
            out["missing"].append(rel)
            continue
        if size != r["committed_bytes"]:
            # 活跃分包可能正在 Blob-First 写入，重查一次账本与文件大小消除竞态
            try:
                fresh = pg_query(
                    "SELECT committed_bytes FROM public.pack_files WHERE rel_path = %s",
                    (rel,),
                )
                fresh_bytes = fresh[0]["committed_bytes"] if fresh else r["committed_bytes"]
                size2 = (DATA_ROOT / rel).stat().st_size
            except Exception:
                fresh_bytes, size2 = r["committed_bytes"], size
            if size2 != fresh_bytes:
                out["size_mismatch"].append([rel, size2, fresh_bytes])
    extra = {str(p.relative_to(DATA_ROOT)) for p in DATA_ROOT.rglob("*.jsonl.zst")} - known
    out["unregistered"] = len(extra)
    out["unregistered_sample"] = sorted(extra)[:5]
    out["ok"] = not out["missing"] and not out["size_mismatch"]
    return out


def ledger_map() -> dict:
    try:
        rows = pg_query("SELECT rel_path, kind, record_count, uncompressed_bytes, committed_bytes, sha256"
                        " FROM public.pack_files")
    except Exception:
        return {}
    return {r["rel_path"]: r for r in rows}


# ---------- 包帧结构 + 记录质量 ----------

def scan_pack(job) -> dict:
    rel_path, kind, need_sha256 = job
    _ensure_pg_path()
    from pg_data_core.zst_pack import iter_frames, json_loads_bytes

    path = DATA_ROOT / rel_path
    res = {"rel": rel_path, "kind": kind, "frames": 0, "raw": 0, "bad_json": 0, "bad_nl": 0,
           "no_trace": 0, "dup_trace": 0, "empty_question": 0, "last_end": 0, "sha256": None,
           "error": None}
    try:
        if need_sha256:
            digest = hashlib.sha256()
            with path.open("rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    digest.update(chunk)
            res["sha256"] = digest.hexdigest()
        seen = set()
        for fr in iter_frames(path):
            res["frames"] += 1
            res["raw"] += fr.raw_bytes
            res["last_end"] = fr.offset + fr.length
            if not fr.payload.endswith(b"\n"):
                res["bad_nl"] += 1
            try:
                rec = json_loads_bytes(fr.payload)
            except Exception:
                res["bad_json"] += 1
                continue
            if not isinstance(rec, dict):
                res["bad_json"] += 1
                continue
            if rel_path.startswith("eval_input/"):
                tid = rec.get("trace_id")
                if not tid:
                    res["no_trace"] += 1
                elif tid in seen:
                    res["dup_trace"] += 1
                else:
                    seen.add(tid)
            meta = rec.get("meta")
            if isinstance(meta, dict):
                q = meta.get("question") or meta.get("question_text")
                if not (isinstance(q, str) and q.strip()):
                    res["empty_question"] += 1
    except Exception as exc:
        res["error"] = f"{type(exc).__name__}: {exc}"
    return res


# ---------- PG 指针 -> 帧 ----------

def verify_pointers(after_id: int, limit: int) -> dict:
    _ensure_pg_path()
    from pg_data_core.zst_pack import pread_frame, json_loads_bytes

    try:
        rows = pg_query(
            "SELECT i.input_id, i.trace_id, i.input_offset, i.input_len, p.rel_path"
            " FROM public.eval_inputs i JOIN public.pack_files p ON p.file_id = i.input_file_id"
            " WHERE i.has_input_blob AND i.input_offset IS NOT NULL AND i.input_len IS NOT NULL"
            "   AND i.input_id > %s ORDER BY i.input_id LIMIT %s",
            (after_id, limit),
        )
    except Exception as exc:
        return {"checked": 0, "bad": [], "last_id": after_id, "error": f"{type(exc).__name__}: {exc}"}
    res = {"checked": 0, "bad": [], "last_id": after_id, "error": None}
    for r in rows:
        res["checked"] += 1
        res["last_id"] = r["input_id"]
        try:
            rec = json_loads_bytes(pread_frame(DATA_ROOT / r["rel_path"], r["input_offset"], r["input_len"]))
        except Exception as exc:
            res["bad"].append([r["input_id"], f"{type(exc).__name__}: {exc}"])
            continue
        if str(rec.get("trace_id")) != str(r["trace_id"]):
            res["bad"].append([r["input_id"], "trace_id mismatch"])
    return res


# ---------- 上游原始日志质量 ----------

def audit_upstream(rel_path: str) -> dict:
    _ensure_pg_path()
    from pg_data_core.zst_pack import json_loads_bytes

    path = UPSTREAM / rel_path
    res = {"rel": rel_path, "lines": 0, "bad_json": 0, "no_session": 0, "no_user": 0,
           "bad_time": 0, "empty_question": 0, "dup_session": 0, "error": None}
    try:
        seen = set()
        with path.open("rb") as fh:
            for line in fh:
                if not line.strip():
                    continue
                res["lines"] += 1
                try:
                    rec = json_loads_bytes(line)
                except Exception:
                    res["bad_json"] += 1
                    continue
                if not isinstance(rec, dict):
                    res["bad_json"] += 1
                    continue
                meta = rec.get("meta") if isinstance(rec.get("meta"), dict) else rec
                sid = meta.get("session_id")
                if not sid:
                    res["no_session"] += 1
                elif sid in seen:
                    res["dup_session"] += 1
                else:
                    seen.add(sid)
                if not meta.get("user_id"):
                    res["no_user"] += 1
                if not meta.get("request_time"):
                    res["bad_time"] += 1
                q = meta.get("question") or meta.get("question_text")
                if not (isinstance(q, str) and q.strip()):
                    res["empty_question"] += 1
    except Exception as exc:
        res["error"] = f"{type(exc).__name__}: {exc}"
    return res


# ---------- PG 内部一致性 ----------

def check_pg() -> dict:
    try:
        out = {}
        out["changes_gaps"] = pg_query(
            "SELECT count(*) AS c FROM ("
            "  SELECT seq, lag(seq) OVER (ORDER BY seq) AS prev FROM public.changes"
            ") t WHERE prev IS NOT NULL AND seq <> prev + 1"
        )[0]["c"]
        out["changes_max_seq"] = pg_query("SELECT COALESCE(max(seq), 0) AS s FROM public.changes")[0]["s"]
        out["inputs"] = pg_query("SELECT count(*) AS c FROM public.eval_inputs WHERE NOT is_deleted")[0]["c"]
        out["blob_without_ptr"] = pg_query(
            "SELECT count(*) AS c FROM public.eval_inputs WHERE NOT is_deleted AND has_input_blob"
            " AND (input_file_id IS NULL OR input_offset IS NULL)"
        )[0]["c"]
        out["ptr_out_of_range"] = pg_query(
            "SELECT count(*) AS c FROM public.eval_inputs i JOIN public.pack_files p ON p.file_id = i.input_file_id"
            " WHERE NOT i.is_deleted AND i.input_len IS NOT NULL AND i.input_offset + i.input_len > p.committed_bytes"
        )[0]["c"]
        out["dup_trace"] = pg_query(
            "SELECT count(*) AS c FROM (SELECT product, model, trace_id FROM public.eval_inputs"
            " GROUP BY 1,2,3 HAVING count(*) > 1) t"
        )[0]["c"]
        out["lease_expired"] = pg_query(
            "SELECT count(*) AS c FROM public.eval_inputs"
            " WHERE NOT is_deleted AND eval_status = 'claimed' AND lease_expires_at < now()"
        )[0]["c"]
        row = pg_query("SELECT value FROM meta.runtime_kv WHERE key = 'db_epoch'")
        out["db_epoch"] = row[0]["value"] if row else None
        return out
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


def check_mv() -> dict:
    try:
        mv = pg_query("SELECT COALESCE(SUM(total_traces), 0) AS c FROM public.stats_daily_overview")[0]["c"]
        base = pg_query("SELECT count(*) AS c FROM public.eval_inputs WHERE NOT is_deleted")[0]["c"]
        return {"mv": mv, "base": base, "drift": mv - base, "ok": mv == base}
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


def check_endpoint_epoch() -> dict:
    ep = DATA_ROOT / ".runtime" / "pg_endpoint.json"
    try:
        data = json.loads(ep.read_text())
        return {"db_epoch": data.get("db_epoch"), "age_sec": round(time.time() - ep.stat().st_mtime)}
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


def check_service() -> dict:
    out = {}
    for name, url in (
        ("5001", "http://127.0.0.1:5001/healthz"),
        ("5002", "http://127.0.0.1:5002/healthz"),
        ("5003", "http://127.0.0.1:5003/healthz"),
    ):
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                body = resp.read(4000).decode("utf-8", "replace")
            ok = resp.status == 200
            try:
                ok = ok and bool(json.loads(body).get("ok", True))
            except ValueError:
                pass
            out[name] = "ok" if ok else f"degraded({resp.status})"
        except Exception as exc:
            out[name] = f"down({type(exc).__name__})"
    return out


# ---------- 调度 ----------

class Inspector:
    def __init__(self, max_cores: float, workers: int):
        self.max_cores = max_cores
        self.pool = ProcessPoolExecutor(max_workers=workers)
        self.state = {"round": 0, "pack_cursor": 0, "up_cursor": 0, "ptr_cursor": 0,
                      "last": {}, "anomalies": []}
        try:
            saved = json.loads(STATE_PATH.read_text())
            self.state.update({k: v for k, v in saved.items() if k in self.state})
        except Exception:
            pass
        self._packs_cache, self._packs_at = [], 0.0
        self._up_cache, self._up_at = [], 0.0

    def save(self) -> None:
        try:
            tmp = STATE_PATH.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.state, ensure_ascii=False))
            os.replace(tmp, STATE_PATH)
        except OSError:
            pass

    def anomaly(self, kind: str, detail) -> None:
        self.state["anomalies"] = (self.state["anomalies"] + [[int(time.time()), kind, detail]])[-200:]

    def due(self, name: str) -> bool:
        if time.time() - self.state["last"].get(name, 0) < INTERVAL[name]:
            return False
        self.state["last"][name] = time.time()
        return True

    def packs(self) -> list:
        if time.time() - self._packs_at > 3600 or not self._packs_cache:
            self._packs_cache = sorted(str(p.relative_to(DATA_ROOT)) for p in DATA_ROOT.rglob("*.jsonl.zst"))
            self._packs_at = time.time()
        return self._packs_cache

    def upstream(self) -> list:
        if time.time() - self._up_at > 3600:
            self._up_cache = sorted(str(p.relative_to(UPSTREAM)) for p in UPSTREAM.rglob("*.jsonl") if p.is_file())
            self._up_at = time.time()
        return self._up_cache

    def take(self, items: list, key: str, n: int) -> list:
        if not items:
            return []
        start = self.state[key] % len(items)
        picked = [items[(start + i) % len(items)] for i in range(min(n, len(items)))]
        self.state[key] = (start + len(picked)) % len(items)
        return picked

    def run_round(self) -> dict:
        t0, cpu0 = time.time(), cpu_seconds()
        self.state["round"] += 1
        res = {"round": self.state["round"], "checks": []}

        if self.due("ledger"):
            res["checks"].append("ledger")
            led = check_ledger()
            if led.get("error") or not led.get("ok", True) or led.get("unregistered"):
                self.anomaly("ledger", {k: led.get(k) for k in ("missing", "size_mismatch", "unregistered", "error")})
        if self.due("pg"):
            res["checks"].append("pg")
            pg = check_pg()
            if pg.get("error"):
                self.anomaly("pg", pg["error"])
            else:
                for key in ("blob_without_ptr", "ptr_out_of_range", "dup_trace"):
                    if pg[key]:
                        self.anomaly("pg", [key, pg[key]])
            res["pg"] = pg
        if self.due("mv"):
            res["checks"].append("mv")
            mv = check_mv()
            if mv.get("error") or not mv.get("ok", True):
                self.anomaly("mv", mv)
            res["mv"] = mv
        if self.due("svc"):
            res["checks"].append("svc")
            svc = check_service()
            if any(v != "ok" for v in svc.values()):
                self.anomaly("svc", svc)
            res["svc"] = svc

        ep = check_endpoint_epoch()
        pg = res.get("pg") or {}
        if pg.get("db_epoch") and ep.get("db_epoch") and pg["db_epoch"] != ep["db_epoch"]:
            self.anomaly("epoch", {"pg": pg["db_epoch"], "endpoint": ep["db_epoch"]})
        res["endpoint"] = ep

        ledger = ledger_map()
        jobs = [
            (rel, (ledger.get(rel) or {}).get("kind"), bool((ledger.get(rel) or {}).get("sha256")))
            for rel in self.take(self.packs(), "pack_cursor", PACKS_PER_ROUND)
        ]
        pack_out = []
        for r in (self.pool.map(scan_pack, jobs) if jobs else []):
            issues = []
            if r["error"]:
                issues.append(r["error"])
            row = ledger.get(r["rel"])
            if row:
                mismatch = (
                    r["frames"] != row["record_count"]
                    or r["raw"] != row["uncompressed_bytes"]
                    or r["last_end"] != row["committed_bytes"]
                )
                if mismatch:
                    # 活跃分包在 ledger_map() 与 scan_pack() 之间可能有新帧提交，重查一次单行避免误报
                    try:
                        fresh_rows = pg_query(
                            "SELECT record_count, uncompressed_bytes, committed_bytes, sha256"
                            " FROM public.pack_files WHERE rel_path = %s",
                            (r["rel"],),
                        )
                        if fresh_rows:
                            row = fresh_rows[0]
                    except Exception:
                        pass
                growing_race = (
                    row["committed_bytes"] > r["last_end"]
                    and r["frames"] <= row["record_count"]
                    and r["raw"] <= row["uncompressed_bytes"]
                )
                if not growing_race:
                    if r["frames"] != row["record_count"]:
                        issues.append(f"frames {r['frames']}!={row['record_count']}")
                    if r["raw"] != row["uncompressed_bytes"]:
                        issues.append(f"raw {r['raw']}!={row['uncompressed_bytes']}")
                    if r["last_end"] != row["committed_bytes"]:
                        issues.append(f"end {r['last_end']}!={row['committed_bytes']}")
                if r["sha256"] and row["sha256"] and r["sha256"] != row["sha256"]:
                    issues.append("sha256 mismatch")
            for key in ("bad_json", "bad_nl", "no_trace", "dup_trace"):
                if r[key]:
                    issues.append(f"{key}={r[key]}")
            if issues:
                self.anomaly("pack", [r["rel"], issues[:6]])
            pack_out.append({"rel": r["rel"], "frames": r["frames"], "issues": issues[:4]})
        res["packs"] = pack_out

        up_jobs = self.take(self.upstream(), "up_cursor", 1)
        up_out = []
        for r in (self.pool.map(audit_upstream, up_jobs) if up_jobs else []):
            if r["error"]:
                self.anomaly("upstream", [r["rel"], r["error"]])
            elif r["bad_json"] or r["no_session"]:
                self.anomaly("upstream", [r["rel"], {"bad_json": r["bad_json"], "no_session": r["no_session"]}])
            up_out.append({"rel": r["rel"], "lines": r["lines"],
                           "bad_json": r["bad_json"], "dup_session": r["dup_session"],
                           "empty_question": r["empty_question"]})
        res["upstream"] = up_out

        ptr = verify_pointers(self.state["ptr_cursor"], PTR_PER_ROUND)
        if ptr["bad"]:
            self.anomaly("pointer", ptr["bad"][:5])
        if ptr["error"]:
            self.anomaly("pointer", [ptr["error"]])
        res["pointers"] = {"checked": ptr["checked"], "bad": len(ptr["bad"])}
        self.state["ptr_cursor"] = ptr["last_id"] if ptr["checked"] >= PTR_PER_ROUND else 0

        elapsed = time.time() - t0
        res["elapsed"] = round(elapsed, 1)
        res["cores"] = round((cpu_seconds() - cpu0) / max(elapsed, 0.001), 2)
        self.save()
        return res

    def close(self) -> None:
        self.pool.shutdown(wait=False)


def _handle_sigterm(_signum, _frame) -> None:
    raise SystemExit(0)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--cycles", type=int, default=0)
    ap.add_argument("--max-cores", type=float, default=1.5)
    ap.add_argument("--workers", type=int, default=2)
    args = ap.parse_args()

    signal.signal(signal.SIGTERM, _handle_sigterm)
    set_proc_name("检验任务")
    lock = open("/tmp/检验任务.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("already running")
        return 0

    ins = Inspector(args.max_cores, args.workers)
    log(f"start pid={os.getpid()} max_cores={args.max_cores} workers={args.workers}")
    rounds = 0
    try:
        while True:
            res = ins.run_round()
            anom = sum(1 for a in ins.state["anomalies"] if a[0] >= int(time.time()) - 3600)
            svc = res.get("svc") or {}
            log(f"round={res['round']} cores={res['cores']} elapsed={res['elapsed']}s "
                f"packs={len(res['packs'])} up={len(res['upstream'])} ptr={res['pointers']['checked']} "
                f"checks={','.join(res['checks']) or '-'} anom_1h={anom}"
                + (f" svc={svc}" if svc else ""))
            if args.once:
                print(json.dumps(res, ensure_ascii=False, default=str)[:4000])
                break
            rounds += 1
            if args.cycles and rounds >= args.cycles:
                break
            ratio = res["cores"] / args.max_cores if args.max_cores > 0 else 1.0
            time.sleep(max(1.0, res["elapsed"] * (ratio - 1.0)) if ratio > 1.0 else 1.0)
    finally:
        ins.close()
        lock.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
