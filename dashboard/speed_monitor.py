#!/usr/bin/env python3
"""AIME evaluation speed & live gateway telemetry monitor for the dashboard server.

Migrated and upgraded from eval_agent_harness/server_monitor:
- Uses direct local filesystem access when Virginia SSD paths exist locally,
  or SSH when EVAL_SPEED_SSH_HOST is explicitly configured.
- Probes authenticated OpenAI-compatible gateways (/v1/models + /key/info)
  for real-time health, latency, last_active, and MaAS QoS RPM quota.
- Incrementally scans .parts/*.jsonl and .orchestrator/locks/* for live
  in-flight throughput, active writers, running chunks, and real-time RPM.
"""
from __future__ import annotations

import collections
import configparser
import glob
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULTS = {
    "output_root": "/mnt/aime_eval_ssd/1_aime/eval_output/0_daily_eval",
    "input_root": "/mnt/aime_eval_ssd/1_aime/eval_input/0_daily_eval_input",
    "chunk_root": "/mnt/aime_eval_ssd/1_aime/eval_input/0_daily_eval_chunks",
    "lost_input_root": "/mnt/aime_eval_ssd/1_aime/eval_input/1_lost_user_eval",
    "lost_output_root": "/mnt/aime_eval_ssd/1_aime/eval_output/1_lost_user_eval",
    "cluster_root": "/mnt/aime_eval_ssd/1_aime/eval_output/cluster",
    "runtime_root": "/mnt/aime_eval_ssd/code/1_eval_harnes/runtime",
    "gateway_state": "/mnt/aime_eval_ssd/code/1_eval_harnes/runtime/orchestrator-state/gateway-health.json",
    "conf_ini": "/opt/eval_harness/main/config.ini",
    "refresh_seconds": 15,
    "input_refresh_seconds": 60,
    "history_seconds": 172800,
    "rpm_window_seconds": 120,
    "rate_window_seconds": 300,
    "ssh_host": "",
    "ssh_port": None,
    "identity_file": None,
    "ssh_options": [],
}

_LOCK = threading.Lock()
_STARTED = False
_CACHE_FILE: Path | None = None
# Mirror of the cache on the persistent datasets disk: /opt is rolled back when the
# container is rebuilt, and losing the cache means re-reading (and JSON-parsing) the
# whole 55 GB input tree just to show the counts again.
_PERSIST_FILE: Path | None = None
_MIRROR_AT = 0.0
_CONFIG: dict = dict(DEFAULTS)
_CONTROL_SOCKET = Path("/tmp/eval-dash-speed-%C")
_IDS_DIR: Path | None = None
_EVAL_IDS_CACHE: dict = {"sig": None, "ids": {}}

# 输入文件的 trace 键提取与 scripts/aime_data_inventory.py 完全一致：
# 行尾窗口里的最后一个 trace_id；没有就全行取最后一个（不回退到头部 meta.trace_id），
# 再没有才用 session_id。行尾没写完整的半行留给下一轮。
HEAD_HASH_BYTES = 4096
TAIL_WIN = 4096
HEAD_WIN = 1024
TID = re.compile(rb'"trace_id"\s*:\s*"([^"]+)"')
SID = re.compile(rb'"session_id"\s*:\s*"([^"]+)"')

_STATE: dict = {
    "available": False,
    "mode": "disabled",
    "ok": False,
    "error": "正在初始化实时统计…",
    "input_error": "",
    "updated_at": None,
    "last_success": None,
    "input_updated_at": None,
    "input_total": None,
    "models": {},
    "output_key_stats": {},
    "keys_sig": "",
    "input": {},
    "input_files": {},
    "input_ids": {},
    "output_files": {},
    "lost_user": {
        "input_sessions": 0,
        "input_traces": 0,
        "attr_sessions": 0,
        "attr_traces": 0,
        "attr_items": 0,
    },
    "gateways": {},
    "gateway_prev": {},
    "control": {},
    "rpm_limit_info": {},
    "cluster": {},
    "cluster_stats": {},
    "cluster_files": {},
    "cluster_output_sig": "",
    "cluster_updated_at": 0,
    "queue": {},
    "queue_history": collections.deque(),
    "locks": [],
    "part_files": {},
    "parts_seeded": False,
    "parts_seeded_at": 0.0,
    "part_events": collections.deque(),
    "active_writers": 0,
    "newest_part_age_s": None,
    "history": collections.deque(),
    "rpm_history": collections.deque(),
}


def _to_iso(ts) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(float(ts), timezone.utc).isoformat(timespec="seconds")


def _parse_iso_ts(value: str | None) -> float | None:
    if not value:
        return None
    try:
        s = str(value).strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s).timestamp()
    except ValueError:
        return None


def load_config(overrides: dict | None = None) -> dict:
    cfg = dict(DEFAULTS)
    env_map = {
        "output_root": "EVAL_SPEED_OUTPUT_ROOT",
        "input_root": "EVAL_SPEED_INPUT_ROOT",
        "chunk_root": "EVAL_SPEED_CHUNK_ROOT",
        "lost_input_root": "EVAL_SPEED_LOST_INPUT_ROOT",
        "lost_output_root": "EVAL_SPEED_LOST_OUTPUT_ROOT",
        "cluster_root": "EVAL_SPEED_CLUSTER_ROOT",
        "runtime_root": "EVAL_SPEED_RUNTIME_ROOT",
        "gateway_state": "EVAL_SPEED_GATEWAY_STATE",
        "conf_ini": "EVAL_SPEED_CONF_INI",
        "ssh_host": "EVAL_SPEED_SSH_HOST",
    }
    for key, env_name in env_map.items():
        val = os.environ.get(env_name)
        if val:
            cfg[key] = val
    for key, env_name in (
        ("refresh_seconds", "EVAL_SPEED_REFRESH_SECONDS"),
        ("input_refresh_seconds", "EVAL_SPEED_INPUT_REFRESH_SECONDS"),
        ("history_seconds", "EVAL_SPEED_HISTORY_SECONDS"),
        ("ssh_port", "EVAL_SPEED_SSH_PORT"),
    ):
        val = os.environ.get(env_name)
        if val and val.isdigit():
            cfg[key] = int(val)
    if os.environ.get("EVAL_SPEED_IDENTITY_FILE"):
        cfg["identity_file"] = os.environ["EVAL_SPEED_IDENTITY_FILE"]
    if overrides:
        cfg.update(overrides)
    if cfg["runtime_root"] and not (overrides and "gateway_state" in overrides) and not os.environ.get("EVAL_SPEED_GATEWAY_STATE"):
        cfg["gateway_state"] = str(Path(cfg["runtime_root"]) / "orchestrator-state" / "gateway-health.json")
    return cfg


def detect_mode(cfg: dict) -> tuple[str, bool, str]:
    """Choose local direct filesystem access, explicit SSH, or disabled."""
    if cfg.get("ssh_host"):
        return "ssh", True, ""
    if os.path.isdir(cfg["output_root"]) or os.path.isdir(cfg["input_root"]):
        return "local", True, ""
    products_env = os.environ.get("EVAL_PRODUCTS", "")
    if products_env and "aime" not in {x.strip() for x in products_env.split(",") if x.strip()}:
        return "disabled", False, "当前节点未部署 AIME 评测流水线（请切换至 AIME · 弗吉尼亚查看）"
    return "disabled", False, "当前环境未挂载 AIME 实时监控目录"


def _ssh_command(cfg: dict) -> list[str]:
    cmd = [
        "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
        "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
        "-o", "LogLevel=ERROR",
        "-o", "ControlMaster=auto", "-o", f"ControlPath={_CONTROL_SOCKET}",
        "-o", "ControlPersist=10m",
    ]
    if cfg.get("identity_file"):
        cmd += ["-i", str(cfg["identity_file"])]
    if cfg.get("ssh_port"):
        cmd += ["-p", str(cfg["ssh_port"])]
    cmd += [str(opt) for opt in cfg.get("ssh_options", [])]
    cmd.append(str(cfg["ssh_host"]))
    return cmd


def _ssh_run(cfg: dict, script: str, timeout: int) -> str:
    proc = subprocess.run(_ssh_command(cfg) + [script], capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        raise RuntimeError(detail[-1] if detail else f"ssh exit {proc.returncode}")
    return proc.stdout


def _read_json_file(path: str | Path) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def _read_channels_ini(cfg: dict) -> dict[str, dict]:
    candidates = [cfg.get("conf_ini") or ""]
    if cfg.get("runtime_root"):
        candidates.append(str(Path(cfg["runtime_root"]) / "config" / "config.ini"))
    channels: dict[str, dict] = {}
    for candidate in candidates:
        if not candidate or not os.path.isfile(candidate):
            continue
        parser = configparser.ConfigParser()
        try:
            parser.read(candidate, encoding="utf-8")
        except (OSError, configparser.Error):
            continue
        for section in parser.sections():
            if not section.startswith("channel."):
                continue
            name = section.removeprefix("channel.")
            if name in channels:
                continue
            vals = parser[section]
            base = (vals.get("base_url") or "").strip().rstrip("/")
            key = (vals.get("api_key") or "").strip()
            models = [m.strip() for m in (vals.get("models") or "").split(",") if m.strip()]
            if base:
                channels[name] = {
                    "channel": name,
                    "base_url": base,
                    "api_key": key,
                    "models": models,
                }
        if channels:
            break
    return channels


def _extract_maas_rpm(payload: dict, preferred_models: list[str]) -> tuple[int | None, str | None, str | None, list[str]]:
    info = payload.get("info") or {}
    models = [str(m) for m in (info.get("models") or []) if m]
    qos = ((info.get("metadata") or {}).get("maas_qos") or {})
    workload = qos.get("workload")
    qos_models = qos.get("models") or {}
    now_hm = datetime.now(timezone.utc).strftime("%H:%M")
    candidates = [m for m in preferred_models if m in qos_models] or list(qos_models.keys())
    active, configured = [], []
    for model in candidates:
        mrule = qos_models.get(model) or {}
        for rule in mrule.get("rules") or []:
            for win in rule.get("windows") or []:
                rpm = win.get("rpm")
                if not isinstance(rpm, int) or rpm <= 0:
                    continue
                start = str(win.get("start") or "00:00")
                end = str(win.get("end") or "24:00")
                entry = (rpm, f"{start}–{end} UTC")
                configured.append(entry)
                if start <= now_hm < end:
                    active.append(entry)
    picks = active or configured
    if picks:
        best_rpm, best_win = max(picks, key=lambda x: x[0])
        return best_rpm, best_win, workload, models
    fallback = info.get("rpm_limit")
    if isinstance(fallback, int) and fallback > 0:
        return fallback, None, workload, models
    return None, None, workload, models


def _probe_http(url: str, headers: dict[str, str] | None = None, timeout: float = 3.0) -> tuple[int, str, float]:
    t0 = time.monotonic()
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "ignore")
            return int(resp.status), body, round((time.monotonic() - t0) * 1000.0, 1)
    except urllib.error.HTTPError as err:
        try:
            body = err.read().decode("utf-8", "ignore")
        except Exception:
            body = ""
        return int(err.code), body, round((time.monotonic() - t0) * 1000.0, 1)
    except Exception:
        return 0, "", round((time.monotonic() - t0) * 1000.0, 1)


def _parse_vllm_metrics(text: str) -> tuple[int, int, float]:
    running = waiting = 0
    gen = 0.0
    for line in text.splitlines():
        if line.startswith("#") or " " not in line:
            continue
        if line.startswith("vllm:num_requests_running{"):
            try:
                running += int(float(line.rsplit(" ", 1)[1]))
            except ValueError:
                pass
        elif line.startswith("vllm:num_requests_waiting{"):
            try:
                waiting += int(float(line.rsplit(" ", 1)[1]))
            except ValueError:
                pass
        elif line.startswith("vllm:generation_tokens_total{"):
            try:
                gen += float(line.rsplit(" ", 1)[1])
            except ValueError:
                pass
    return running, waiting, gen


def _normalize_gateway_root(url: str) -> str:
    clean = url.strip().rstrip("/")
    if clean.endswith("/v1"):
        clean = clean[:-3]
    return clean


def _gateway_host_label(url: str) -> str:
    s = url.strip()
    s = re.sub(r"^https?://", "", s)
    return s.split("/", 1)[0]


def collect_gateway_local(cfg: dict) -> tuple[dict, dict, dict]:
    runtime_root = Path(cfg["runtime_root"]) if cfg.get("runtime_root") else None
    control = _read_json_file(runtime_root / "control.json") if runtime_root else {}
    rpm_limit_info = _read_json_file(runtime_root / "rpm-limit.json") if runtime_root else {}
    health = _read_json_file(cfg["gateway_state"]) if cfg.get("gateway_state") else {}
    ini_channels = _read_channels_ini(cfg)

    assignments = health.get("assignments") or {}
    healthy_urls = health.get("healthy") or []
    url_to_channels: dict[str, list[str]] = collections.defaultdict(list)
    for sec, url in assignments.items():
        ch_name = str(sec).removeprefix("channel.")
        url_to_channels[_normalize_gateway_root(str(url))].append(ch_name)

    targets: dict[str, dict] = {}
    ordered_urls = [_normalize_gateway_root(str(u)) for u in healthy_urls if u]
    for u in assignments.values():
        norm = _normalize_gateway_root(str(u))
        if norm and norm not in ordered_urls:
            ordered_urls.append(norm)
    if not ordered_urls:
        for ch in ini_channels.values():
            norm = _normalize_gateway_root(ch["base_url"])
            if norm and norm not in ordered_urls:
                ordered_urls.append(norm)
                url_to_channels[norm].append(ch["channel"])

    now = time.time()
    for root_url in ordered_urls:
        ch_names = sorted(set(url_to_channels.get(root_url) or []))
        matched_ini = None
        for ch_name in ch_names:
            if ch_name in ini_channels:
                matched_ini = ini_channels[ch_name]
                break
        if matched_ini is None:
            for ch in ini_channels.values():
                if _normalize_gateway_root(ch["base_url"]) == root_url:
                    matched_ini = ch
                    break
        api_key = matched_ini["api_key"] if matched_ini else ""
        pref_models = matched_ini["models"] if matched_ini else []
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

        models_url = root_url + "/v1/models"
        code, models_body, latency_ms = _probe_http(models_url, headers=headers, timeout=2.5)
        models_list = list(pref_models)
        if code == 200 and models_body:
            try:
                m_payload = json.loads(models_body)
                data_items = m_payload.get("data") or []
                if isinstance(data_items, list) and data_items:
                    parsed_ids = [str(item.get("id")) for item in data_items if isinstance(item, dict) and item.get("id")]
                    if parsed_ids:
                        models_list = parsed_ids
            except ValueError:
                pass

        rpm_limit = rpm_limit_info.get("rpm") if isinstance(rpm_limit_info.get("rpm"), int) else None
        # Where the number came from: the key itself (authoritative), the harness's cached
        # rpm-limit.json, or nothing. The UI shows it so a stale cache is never read as real.
        rpm_source = "runtime" if rpm_limit else "none"
        rpm_window = None
        workload = None
        last_active = None
        active_ago_s = None
        cooldown = False
        tpm_limit = None
        has_key_info = False

        if api_key:
            ki_code, ki_body, _ = _probe_http(root_url + "/key/info", headers=headers, timeout=2.5)
            if ki_code == 200 and ki_body:
                try:
                    ki = json.loads(ki_body)
                    has_key_info = True
                    q_rpm, q_win, q_work, q_models = _extract_maas_rpm(ki, pref_models or models_list)
                    if q_rpm is not None:
                        rpm_limit = q_rpm
                        rpm_source = "key"
                    rpm_window = q_win
                    workload = q_work
                    if q_models:
                        models_list = q_models
                    info = ki.get("info") or {}
                    last_active = info.get("last_active")
                    ts = _parse_iso_ts(last_active)
                    if ts is not None:
                        active_ago_s = round(max(0.0, now - ts), 1)
                    meta = info.get("metadata") or {}
                    mgmt = meta.get("gateway_management") or {}
                    cooldown = bool(info.get("soft_budget_cooldown") or info.get("blocked") or mgmt.get("security_blocked"))
                    if isinstance(info.get("tpm_limit"), int):
                        tpm_limit = info.get("tpm_limit")
                except ValueError:
                    pass

        running = waiting = 0
        gen = 0.0
        has_vllm_metrics = False
        if not has_key_info:
            m_code, m_body, _ = _probe_http(root_url + "/metrics", timeout=1.5)
            if m_code == 200 and "vllm:" in m_body:
                has_vllm_metrics = True
                running, waiting, gen = _parse_vllm_metrics(m_body)

        host = _gateway_host_label(root_url)
        label = ch_names[0] if len(ch_names) == 1 else (matched_ini["channel"] if matched_ini else host)
        targets[label] = {
            "name": label,
            "host": host,
            "url": root_url + "/v1",
            "channels": ch_names or ([matched_ini["channel"]] if matched_ini else []),
            "code": code,
            "ok": code > 0 and code < 500,
            "healthy": code == 200,
            "latency_ms": latency_ms,
            "models": models_list,
            "workload": workload,
            "rpm_limit": rpm_limit,
            "rpm_source": rpm_source,
            "rpm_window": rpm_window,
            "tpm_limit": tpm_limit,
            "last_active": last_active,
            "active_ago_s": active_ago_s,
            "cooldown": cooldown,
            "metrics": has_vllm_metrics,
            "running": running,
            "waiting": waiting,
            "gen": gen,
        }

    return targets, control, rpm_limit_info


def _collect_local_output_files(cfg: dict) -> dict[str, dict]:
    files: dict[str, dict] = {}
    for src, root in (("daily", cfg["output_root"]), ("lost_user", cfg["lost_output_root"])):
        if not root or not os.path.isdir(root):
            continue
        try:
            entries = sorted(os.scandir(root), key=lambda e: e.name)
        except OSError:
            continue
        for entry in entries:
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            model = entry.name
            for path in glob.glob(os.path.join(entry.path, "*attribution-*.jsonl")):
                if not os.path.isfile(path):
                    continue
                ma = re.search(r"attribution-(\d{4}-\d{2}-\d{2})", path)
                if not ma:
                    continue
                try:
                    st = os.stat(path)
                except OSError:
                    continue
                files[path] = {
                    "source": src, "model": model, "kind": "attr",
                    "date": ma.group(1), "size": st.st_size, "mtime": st.st_mtime,
                }
            compact_dir = os.path.join(entry.path, "compact")
            if os.path.isdir(compact_dir):
                for path in glob.glob(os.path.join(compact_dir, "*compact-*.jsonl")):
                    if not os.path.isfile(path):
                        continue
                    mc = re.search(r"compact-(\d{4}-\d{2}-\d{2})", path)
                    if not mc:
                        continue
                    try:
                        st = os.stat(path)
                    except OSError:
                        continue
                    files[path] = {
                        "source": src, "model": model, "kind": "compact",
                        "date": mc.group(1), "size": st.st_size, "mtime": st.st_mtime,
                    }
    return files


def _collect_local_cluster_meta(cfg: dict) -> tuple[dict[str, dict], dict[str, dict]]:
    clusters: dict[str, dict] = {}
    cluster_files: dict[str, dict] = {}
    root = cfg["cluster_root"]
    if not root or not os.path.isdir(root):
        return clusters, cluster_files
    for entry in sorted(os.scandir(root), key=lambda e: e.name):
        if not entry.is_dir():
            continue
        manifest = os.path.join(entry.path, "MANIFEST.json")
        if not os.path.isfile(manifest):
            continue
        m = entry.name
        idx_path = os.path.join(entry.path, "item_index.jsonl")
        if os.path.isfile(idx_path):
            try:
                st = os.stat(idx_path)
                cluster_files[m] = {"size": st.st_size, "mtime": int(st.st_mtime)}
            except OSError:
                pass
        try:
            d = json.loads(Path(manifest).read_text(encoding="utf-8"))
            ds = d.get("dataset") or {}
            clusters[m] = {
                "items": int(ds.get("total_items") or 0),
                "traces": int(ds.get("total_traces") or 0),
                "generated_at": str(d.get("generated_at") or ""),
            }
        except (OSError, ValueError, TypeError):
            pass
    return clusters, cluster_files


def _collect_local_queue(cfg: dict) -> tuple[dict, list[dict]]:
    chunk_root = cfg["chunk_root"]
    output_root = cfg["output_root"]
    queue_root = os.path.join(output_root, ".orchestrator", "queue")
    locks_root = os.path.join(output_root, ".orchestrator", "locks")
    models: dict[str, dict] = collections.defaultdict(lambda: {"total": 0, "done": 0, "running": 0, "retry": 0})
    done_times: list[float] = []
    if chunk_root and os.path.isdir(chunk_root):
        for path in glob.glob(os.path.join(chunk_root, "*", "*", "*.jsonl")):
            if not os.path.isfile(path):
                continue
            rel = os.path.relpath(path, chunk_root).split(os.sep)
            if len(rel) >= 3:
                models[rel[0]]["total"] += 1
    if os.path.isdir(queue_root):
        for path in glob.glob(os.path.join(queue_root, "*.state")):
            key = os.path.basename(path)[:-6]
            if ".c" not in key:
                continue
            model = key.split("__", 1)[0]
            if model not in models:
                continue
            try:
                lines = Path(path).read_text(encoding="utf-8").splitlines()
            except OSError:
                continue
            status = lines[1] if len(lines) > 1 else ""
            if status == "0":
                models[model]["done"] += 1
                try:
                    done_times.append(os.stat(path).st_mtime)
                except OSError:
                    pass
            elif status == "running":
                models[model]["running"] += 1
            else:
                models[model]["retry"] += 1
    rows = []
    total = done = running = retry = 0
    for model in sorted(models):
        rec = models[model]
        rec["pending"] = max(0, rec["total"] - rec["done"] - rec["running"] - rec["retry"])
        total += rec["total"]
        done += rec["done"]
        running += rec["running"]
        retry += rec["retry"]
        rows.append({"name": model, **rec})
    queue = {
        "total": total,
        "done": done,
        "running": running,
        "retry": retry,
        "pending": max(0, total - done - running - retry),
        "done_since": min(done_times) if done_times else None,
        "done_last": max(done_times) if done_times else None,
        "models": rows,
    }
    locks: list[dict] = []
    now = time.time()
    if os.path.isdir(locks_root):
        for entry in sorted(os.scandir(locks_root), key=lambda e: e.name):
            if not entry.is_dir():
                continue
            unit = entry.name
            hb = os.path.join(entry.path, "heartbeat")
            cr = os.path.join(entry.path, "created")
            ow = os.path.join(entry.path, "owner")
            try:
                hb_t = os.stat(hb).st_mtime if os.path.exists(hb) else os.stat(entry.path).st_mtime
            except OSError:
                hb_t = now
            cr_t = hb_t
            if os.path.isfile(cr):
                try:
                    cr_t = float(Path(cr).read_text(encoding="utf-8").strip())
                except (OSError, ValueError):
                    pass
            owner = ""
            if os.path.isfile(ow):
                try:
                    owner = Path(ow).read_text(encoding="utf-8").strip()
                except OSError:
                    pass
            m_match = re.match(r"^([^_]+(?:_[^_]+)?)__(\d{4}-\d{2}-\d{2})\.(.+)$", unit)
            locks.append({
                "unit": unit,
                "model": m_match.group(1) if m_match else "",
                "date": m_match.group(2) if m_match else "",
                "chunk": m_match.group(3) if m_match else unit,
                "owner": owner,
                "elapsed_m": round(max(0.0, now - cr_t) / 60.0, 1),
                "heartbeat_age_s": round(max(0.0, now - hb_t), 1),
            })
    return queue, locks


def _keys_signature(cfg: dict) -> str:
    keys_root = os.path.join(cfg["output_root"], ".keys")
    if not os.path.isdir(keys_root):
        return ""
    parts = []
    for path in sorted(glob.glob(os.path.join(keys_root, "**", "*.keys"), recursive=True)):
        if not os.path.isfile(path):
            continue
        try:
            st = os.stat(path)
            parts.append(f"{os.path.relpath(path, keys_root)}:{st.st_size}:{st.st_mtime_ns}")
        except OSError:
            continue
    return "|".join(parts)


def _compute_local_key_stats(cfg: dict) -> dict[str, dict]:
    keys_root = os.path.join(cfg["output_root"], ".keys")
    if not os.path.isdir(keys_root):
        return {}
    models = collections.defaultdict(lambda: {
        "attr": set(), "compact": set(), "attr_dates": {}, "compact_dates": {},
        "attr_sessions": set(),
        "dates": collections.defaultdict(lambda: {"attr": set(), "compact": set(),
                                                  "completed": set(), "attr_sessions": set()}),
    })
    all_attr, all_compact = set(), set()
    for path in glob.glob(os.path.join(keys_root, "**", "*.keys"), recursive=True):
        if not os.path.isfile(path):
            continue
        rel = os.path.relpath(path, keys_root)
        parts = rel.split(os.sep)
        if not parts or not parts[0].startswith("aime_"):
            continue
        model = parts[0]
        kind = "compact" if ("compact" in rel) else "attr"
        match = re.search(r"(\d{4}-\d{2}-\d{2})", rel)
        date = match.group(1) if match else ""
        keys = models[model][kind]
        dates = models[model]["dates"][date][kind]
        try:
            with open(path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        sid, traces = json.loads(line)
                    except Exception:
                        continue
                    if not isinstance(traces, list) or not traces:
                        continue
                    key = (str(sid), tuple(str(t) for t in traces))
                    keys.add(key)
                    dates.add(key)
                    if kind == "attr":
                        models[model]["attr_sessions"].add(str(sid))
                        models[model]["dates"][date]["attr_sessions"].add(str(sid))
                    (all_compact if kind == "compact" else all_attr).add(key)
                    models[model][kind + "_dates"][key] = date
        except OSError:
            continue
    all_completed = all_attr & all_compact
    base_completed = {model: row["attr"] & row["compact"] for model, row in models.items()}
    extra = {model: set() for model in models}
    for key in all_completed:
        if any(key in base_completed[model] for model in models):
            continue
        candidates = [m for m, row in models.items() if key in row["attr"]] or [m for m, row in models.items() if key in row["compact"]]
        if not candidates:
            continue
        model = candidates[0]
        extra[model].add(key)
        date = models[model]["attr_dates"].get(key) or models[model]["compact_dates"].get(key) or ""
        models[model]["dates"][date]["completed"].add(key)
    out: dict[str, dict] = {}
    for model, row in sorted(models.items()):
        attr, compact = row["attr"], row["compact"]
        completed = (attr & compact) | extra[model]
        dates = {}
        for date, drow in row["dates"].items():
            date_completed = (drow["attr"] & drow["compact"]) | drow["completed"]
            dates[date] = {
                "attr": len(drow["attr"]),
                "attr_sessions": len(drow["attr_sessions"]),
                "compact": len(drow["compact"]),
                "completed": len(date_completed),
                "sessions": len({k[0] for k in date_completed}),
            }
        out[model] = {
            "attr_rows": len(attr),
            "attr_sessions": len(row["attr_sessions"]),
            "compact_rows": len(compact),
            "completed": len(completed),
            "sessions": len({k[0] for k in completed}),
            "dates": dates,
        }
    out["__total"] = {
        "attr_rows": len(all_attr),
        "attr_sessions": len({k[0] for k in all_attr}),
        "compact_rows": len(all_compact),
        "completed": len(all_completed),
        "sessions": len({k[0] for k in all_completed}),
    }
    return out


def _count_local_output_files(items: list[tuple[str, int, str, int]]) -> dict[str, dict]:
    counts: dict[str, dict] = {}
    for path, offset, kind, size in items:
        try:
            with open(path, "rb") as fh:
                fh.seek(offset)
                data = fh.read()
        except OSError:
            continue
        end = data.rfind(b"\n")
        if end < 0:
            counts[path] = {"lines": 0, "items": 0, "used": 0, "sessions": [], "traces": 0, "trace_ids": []}
            continue
        complete = data[:end + 1]
        if kind != "attr":
            lines = sum(1 for raw in complete.split(b"\n") if raw.strip())
            counts[path] = {"lines": lines, "items": 0, "used": len(complete), "sessions": [], "traces": 0}
            continue
        lines = items_n = 0
        sessions: set[str] = set()
        trace_ids: set[str] = set()
        for raw in complete.split(b"\n"):
            raw = raw.strip()
            if not raw:
                continue
            try:
                row = json.loads(raw)
            except Exception:
                continue
            lines += 1
            sm = row.get("session_meta") or {}
            sid = sm.get("session_id")
            if sid:
                sessions.add(str(sid))
            for turn in (row.get("turns") or []):
                items_n += len(turn.get("problem") or [])
                tm = turn.get("meta") or {}
                sid2 = tm.get("session_id")
                if sid2:
                    sessions.add(str(sid2))
                tid = tm.get("trace_id")
                if tid:
                    trace_ids.add(str(tid))
        counts[path] = {
            "lines": lines,
            "items": items_n,
            "used": len(complete),
            "sessions": sorted(sessions),
            "traces": len(trace_ids),
            "trace_ids": sorted(trace_ids),
        }
    return counts


def _collect_local_input_meta(cfg: dict) -> dict[str, dict]:
    files: dict[str, dict] = {}
    for src, root in (("daily", cfg["input_root"]), ("lost_user", cfg["lost_input_root"])):
        if not root or not os.path.isdir(root):
            continue
        for entry in sorted(os.scandir(root), key=lambda e: e.name):
            if not entry.is_dir():
                continue
            model = entry.name
            for path in glob.glob(os.path.join(entry.path, "*.jsonl")):
                if not os.path.isfile(path):
                    continue
                date = Path(path).stem
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
                    continue
                try:
                    st = os.stat(path)
                except OSError:
                    continue
                files[path] = {
                    "source": src, "model": model, "date": date,
                    "size": st.st_size, "mtime_ns": st.st_mtime_ns,
                    "ctime_ns": st.st_ctime_ns,
                }
    return files


def _head_md5(path: str, limit: int) -> str:
    """只哈希文件前缀 limit 字节，用来判断「只是追加」还是「被回填重写」。"""
    if limit <= 0:
        return ""
    h = hashlib.md5()
    try:
        with open(path, "rb") as fh:
            h.update(fh.read(limit))
    except OSError:
        return ""
    return h.hexdigest()


def _count_local_input_files(items: list[tuple[str, int]]) -> dict[str, dict]:
    """从 offset 起扫描完整行，返回行数、唯一 trace 键和 session。

    ``keys`` 与盘点脚本同名口径：``T:<trace_id>``，没有 trace_id 时回退
    ``S:<session_id>``，两者都没有记 ``NONE``。``traces`` 就是键的个数。
    """
    counts: dict[str, dict] = {}
    for path, offset in items:
        lines = used = 0
        sessions: set[str] = set()
        keys: set[str] = set()
        try:
            # Line-by-line: a cold start walks the whole input tree (61 GB), and slurping
            # each file kept ~1 GB per file resident for no reason.
            with open(path, "rb") as fh:
                fh.seek(offset)
                while True:
                    raw = fh.readline()
                    if not raw or not raw.endswith(b"\n"):
                        break  # a half-written line stays for the next run
                    used += len(raw)
                    if not raw.strip():
                        continue
                    lines += 1
                    raw = raw.rstrip(b"\n")
                    m = TID.findall(raw[-TAIL_WIN:]) or TID.findall(raw)
                    if m:
                        keys.add("T:" + m[-1].decode("ascii", "ignore"))
                    else:
                        s = SID.search(raw[:HEAD_WIN])
                        keys.add("S:" + s.group(1).decode("ascii", "ignore") if s else "NONE")
                    s = SID.search(raw[:HEAD_WIN])
                    if s:
                        sessions.add(s.group(1).decode("ascii", "ignore"))
        except OSError:
            continue
        counts[path] = {
            "lines": lines,
            "used": used,
            "sessions": sorted(sessions),
            "keys": sorted(keys),
            "traces": len(keys),
        }
    return counts


def _compute_local_cluster_dist(cfg: dict) -> dict[str, dict]:
    cluster_root = cfg["cluster_root"]
    if not cluster_root or not os.path.isdir(cluster_root):
        return {}
    output_roots = [r for r in (cfg["output_root"], cfg["lost_output_root"]) if r and os.path.isdir(r)]
    dist: dict[str, dict] = {}
    for model in sorted(os.listdir(cluster_root)):
        index = os.path.join(cluster_root, model, "item_index.jsonl")
        if not os.path.isfile(index):
            continue
        out: dict[str, bool] = {}
        for root in output_roots:
            for path in glob.glob(os.path.join(root, model, "*attribution-*.jsonl")):
                if not os.path.isfile(path):
                    continue
                try:
                    with open(path, encoding="utf-8") as fh:
                        for line in fh:
                            try:
                                row = json.loads(line)
                            except Exception:
                                continue
                            for turn in row.get("turns") or []:
                                tid = (turn.get("meta") or {}).get("trace_id")
                                if not tid:
                                    continue
                                tid_s = str(tid)
                                out[tid_s] = out.get(tid_s, False) or bool(turn.get("problem"))
                except OSError:
                    continue
        index_ids: set[str] = set()
        try:
            with open(index, encoding="utf-8") as fh:
                for line in fh:
                    try:
                        row = json.loads(line)
                    except Exception:
                        continue
                    tid = row.get("trace_id")
                    if tid:
                        index_ids.add(str(tid))
        except OSError:
            continue
        landed = len(out)
        problem = sum(1 for v in out.values() if v)
        clustered = sum(1 for tid, v in out.items() if v and tid in index_ids)
        pending = problem - clustered
        handled = landed - pending
        dist[model] = {
            "landed": landed,
            "problem": problem,
            "zero": landed - problem,
            "clustered": clustered,
            "pending": pending,
            "handled": handled,
            "index_only": len(index_ids - set(out)),
            "index_unique": len(index_ids),
        }
    return dist


def _scan_parts_local(cfg: dict, old_part_files: dict[str, dict], seeded: bool) -> tuple[dict[str, dict], dict]:
    parts_root = os.path.join(cfg["output_root"], ".parts")
    now = time.time()
    new_files: dict[str, dict] = {}
    attr_rows = compact_rows = reqs = active_writers = 0
    newest_mtime = 0.0
    if not os.path.isdir(parts_root):
        return new_files, {"a": 0, "c": 0, "r": 0, "active_writers": 0, "newest_age_s": None}

    for dirpath, _dirnames, filenames in os.walk(parts_root):
        for fname in filenames:
            if not fname.endswith(".jsonl"):
                continue
            path = os.path.join(dirpath, fname)
            try:
                st = os.stat(path)
            except OSError:
                continue
            size = st.st_size
            mtime = st.st_mtime
            if mtime > newest_mtime:
                newest_mtime = mtime
            if now - mtime <= 60.0:
                active_writers += 1
            prev = old_part_files.get(path)
            prev_offset = int(prev.get("offset", 0)) if prev else 0
            if not seeded:
                new_files[path] = {"size": size, "mtime": mtime, "offset": size}
                continue
            if prev and size == int(prev.get("size", 0)) and mtime == float(prev.get("mtime", 0)):
                new_files[path] = prev
                continue
            offset = prev_offset if (prev and size >= prev_offset) else 0
            used = 0
            if size > offset:
                try:
                    with open(path, "rb") as fh:
                        fh.seek(offset)
                        data = fh.read()
                    end = data.rfind(b"\n")
                    if end >= 0:
                        complete = data[:end + 1]
                        used = len(complete)
                        is_compact = f"{os.sep}compact{os.sep}" in path
                        for raw in complete.split(b"\n"):
                            raw = raw.strip()
                            if not raw:
                                continue
                            try:
                                row = json.loads(raw)
                            except Exception:
                                continue
                            turns = row.get("turns") or []
                            t_cnt = max(1, len(turns))
                            if is_compact:
                                compact_rows += 1
                                comps = sum(len(t.get("components") or []) for t in turns)
                                reqs += 9 * t_cnt + comps
                            else:
                                attr_rows += 1
                                probs = sum(len(t.get("problem") or []) for t in turns)
                                reqs += t_cnt + max(t_cnt, probs) * 3
                except OSError:
                    pass
            new_files[path] = {"size": size, "mtime": mtime, "offset": min(size, offset + used)}

    newest_age_s = round(max(0.0, now - newest_mtime), 1) if newest_mtime > 0 else None
    return new_files, {
        "a": attr_rows,
        "c": compact_rows,
        "r": reqs,
        "active_writers": active_writers,
        "newest_age_s": newest_age_s,
    }


def _ssh_parts_script(cfg: dict, prev_files: dict[str, dict], seeded: bool) -> str:
    payload = json.dumps({"prev": {k: int(v.get("offset", 0)) for k, v in prev_files.items()}, "seeded": seeded})
    return f"python3 - <<'PY'\nimport json, os, time\nroot = {repr(os.path.join(cfg['output_root'], '.parts'))}\nreq = json.loads({repr(payload)})\nprev = req['prev']\nseeded = bool(req['seeded'])\nnow = time.time()\nfiles = {{}}\na = c = r = active = 0\nnewest = 0.0\nif os.path.isdir(root):\n  for dp, _, fns in os.walk(root):\n    for fn in fns:\n      if not fn.endswith('.jsonl'): continue\n      p = os.path.join(dp, fn)\n      try: st = os.stat(p)\n      except OSError: continue\n      sz, mt = st.st_size, st.st_mtime\n      if mt > newest: newest = mt\n      if now - mt <= 60.0: active += 1\n      if not seeded:\n        files[p] = {{'size': sz, 'mtime': mt, 'offset': sz}}\n        continue\n      off = prev.get(p, 0)\n      if sz < off: off = 0\n      used = 0\n      if sz > off:\n        try:\n          with open(p, 'rb') as fh:\n            fh.seek(off)\n            data = fh.read()\n          end = data.rfind(b'\\n')\n          if end >= 0:\n            comp = data[:end+1]\n            used = len(comp)\n            is_c = '/compact/' in p\n            for raw in comp.split(b'\\n'):\n              raw = raw.strip()\n              if not raw: continue\n              try: row = json.loads(raw)\n              except Exception: continue\n              turns = row.get('turns') or []\n              tc = max(1, len(turns))\n              if is_c:\n                c += 1\n                r += 9 * tc + sum(len(t.get('components') or []) for t in turns)\n              else:\n                a += 1\n                probs = sum(len(t.get('problem') or []) for t in turns)\n                r += tc + max(tc, probs) * 3\n        except OSError: pass\n      files[p] = {{'size': sz, 'mtime': mt, 'offset': min(sz, off + used)}}\nprint(json.dumps({{'files': files, 'delta': {{'a': a, 'c': c, 'r': r, 'active_writers': active, 'newest_age_s': round(max(0.0, now - newest), 1) if newest > 0 else None}}}}))\nPY"


def _ssh_gateway_script(cfg: dict) -> str:
    return f"""python3 - <<'PY'
import collections, configparser, json, os, re, time, urllib.error, urllib.request
from datetime import datetime, timezone
runtime_root = {repr(str(cfg.get('runtime_root') or ''))}
gw_state_path = {repr(str(cfg.get('gateway_state') or ''))}
conf_candidates = [{repr(str(cfg.get('conf_ini') or ''))}, os.path.join(runtime_root, 'config', 'config.ini') if runtime_root else '']
def rj(p):
  try: return json.loads(open(p, encoding='utf-8').read()) if p and os.path.isfile(p) else {{}}
  except Exception: return {{}}
control = rj(os.path.join(runtime_root, 'control.json')) if runtime_root else {{}}
rpm_info = rj(os.path.join(runtime_root, 'rpm-limit.json')) if runtime_root else {{}}
health = rj(gw_state_path)
ini = {{}}
for cpath in conf_candidates:
  if not cpath or not os.path.isfile(cpath): continue
  cp = configparser.ConfigParser()
  try: cp.read(cpath, encoding='utf-8')
  except Exception: continue
  for s in cp.sections():
    if not s.startswith('channel.'): continue
    n = s[8:]
    if n in ini: continue
    b = (cp[s].get('base_url') or '').strip().rstrip('/')
    if b: ini[n] = {{'channel': n, 'base_url': b, 'api_key': (cp[s].get('api_key') or '').strip(), 'models': [m.strip() for m in (cp[s].get('models') or '').split(',') if m.strip()]}}
  if ini: break
def norm(u):
  u = str(u).strip().rstrip('/')
  return u[:-3] if u.endswith('/v1') else u
def probe(url, hdrs, timeout=2.5):
  t0 = time.monotonic()
  req = urllib.request.Request(url, headers=hdrs or {{}})
  try:
    with urllib.request.urlopen(req, timeout=timeout) as resp:
      return int(resp.status), resp.read().decode('utf-8', 'ignore'), round((time.monotonic()-t0)*1000, 1)
  except urllib.error.HTTPError as e:
    return int(e.code), '', round((time.monotonic()-t0)*1000, 1)
  except Exception:
    return 0, '', round((time.monotonic()-t0)*1000, 1)
assign = health.get('assignments') or {{}}
u2c = collections.defaultdict(list)
for k, v in assign.items(): u2c[norm(v)].append(str(k).removeprefix('channel.'))
urls = []
for u in list(health.get('healthy') or []) + list(assign.values()):
  nu = norm(u)
  if nu and nu not in urls: urls.append(nu)
if not urls:
  for ch in ini.values():
    nu = norm(ch['base_url'])
    if nu and nu not in urls:
      urls.append(nu); u2c[nu].append(ch['channel'])
gws = {{}}
now = time.time()
now_hm = datetime.now(timezone.utc).strftime('%H:%M')
for ru in urls:
  chs = sorted(set(u2c.get(ru) or []))
  m_ini = next((ini[c] for c in chs if c in ini), None) or next((c for c in ini.values() if norm(c['base_url']) == ru), None)
  key = m_ini['api_key'] if m_ini else ''
  pref = m_ini['models'] if m_ini else []
  hdrs = {{'Authorization': 'Bearer ' + key}} if key else {{}}
  code, body, lat = probe(ru + '/v1/models', hdrs)
  models = list(pref)
  if code == 200 and body:
    try:
      ds = json.loads(body).get('data') or []
      ids = [str(x.get('id')) for x in ds if isinstance(x, dict) and x.get('id')]
      if ids: models = ids
    except Exception: pass
  rpm_limit = rpm_info.get('rpm') if isinstance(rpm_info.get('rpm'), int) else None
  rpm_win = workload = last_active = ago = tpm = None
  cooldown = False
  if key:
    kc, kb, _ = probe(ru + '/key/info', hdrs)
    if kc == 200 and kb:
      try:
        ki = json.loads(kb); info = ki.get('info') or {{}}
        meta = info.get('metadata') or {{}}; qos = meta.get('maas_qos') or {{}}
        workload = qos.get('workload'); qm = qos.get('models') or {{}}
        cands = [m for m in (pref or models) if m in qm] or list(qm.keys())
        act, cfgd = [], []
        for m in cands:
          for r in (qm.get(m) or {{}}).get('rules') or []:
            for w in r.get('windows') or []:
              rv = w.get('rpm')
              if isinstance(rv, int) and rv > 0:
                st, en = str(w.get('start') or '00:00'), str(w.get('end') or '24:00')
                cfgd.append((rv, st + '–' + en + ' UTC'))
                if st <= now_hm < en: act.append((rv, st + '–' + en + ' UTC'))
        pks = act or cfgd
        if pks: rpm_limit, rpm_win = max(pks, key=lambda x: x[0])
        elif isinstance(info.get('rpm_limit'), int): rpm_limit = info.get('rpm_limit')
        last_active = info.get('last_active')
        if last_active:
          try:
            s = last_active[:-1] + '+00:00' if last_active.endswith('Z') else last_active
            ago = round(max(0.0, now - datetime.fromisoformat(s).timestamp()), 1)
          except Exception: pass
        cooldown = bool(info.get('soft_budget_cooldown') or info.get('blocked') or (meta.get('gateway_management') or {{}}).get('security_blocked'))
        if isinstance(info.get('tpm_limit'), int): tpm = info.get('tpm_limit')
      except Exception: pass
  host = re.sub(r'^https?://', '', ru).split('/', 1)[0]
  label = chs[0] if len(chs) == 1 else (m_ini['channel'] if m_ini else host)
  gws[label] = {{'name': label, 'host': host, 'url': ru + '/v1', 'channels': chs, 'code': code, 'ok': 0 < code < 500, 'healthy': code == 200, 'latency_ms': lat, 'models': models, 'workload': workload, 'rpm_limit': rpm_limit, 'rpm_window': rpm_win, 'tpm_limit': tpm, 'last_active': last_active, 'active_ago_s': ago, 'cooldown': cooldown, 'metrics': False, 'running': 0, 'waiting': 0, 'gen': 0.0}}
print(json.dumps({{'gateways': gws, 'control': control, 'rpm_limit_info': rpm_info}}, ensure_ascii=False))
PY"""


def _load_eval_ids(cfg: dict, sig: str) -> dict[tuple[str, str], set[str]]:
    """读取 .keys，按 (model, date) 建评测过的 trace 键集合（与盘点脚本一致）。"""
    if _EVAL_IDS_CACHE["sig"] == sig and _EVAL_IDS_CACHE["ids"]:
        return _EVAL_IDS_CACHE["ids"]
    ids: dict[tuple[str, str], set[str]] = {}
    keys_root = os.path.join(cfg["output_root"], ".keys")
    if os.path.isdir(keys_root):
        for path in glob.glob(os.path.join(keys_root, "**", "*.keys"), recursive=True):
            if not os.path.isfile(path):
                continue
            rel = os.path.relpath(path, keys_root)
            parts = rel.split(os.sep)
            if not parts or not parts[0].startswith("aime_"):
                continue
            model = parts[0]
            if not os.path.basename(path).startswith(model + "_attribution-"):
                continue
            m = re.search(r"(\d{4}-\d{2}-\d{2})", rel)
            if not m:
                continue
            bucket = ids.setdefault((model, m.group(1)), set())
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            obj = json.loads(line)
                        except ValueError:
                            continue
                        if not isinstance(obj, list) or len(obj) < 2:
                            continue
                        if isinstance(obj[0], str):
                            bucket.add("S:" + obj[0])
                        val = obj[1]
                        for tid in (val if isinstance(val, list) else [val]):
                            if isinstance(tid, str):
                                bucket.add("T:" + tid)
            except OSError:
                continue
    _EVAL_IDS_CACHE["sig"] = sig
    _EVAL_IDS_CACHE["ids"] = ids
    return ids


def _input_ids_path(rec: dict) -> Path | None:
    if _IDS_DIR is None:
        return None
    return _IDS_DIR / str(rec["model"]) / (str(rec["date"]) + ".ids")


def _read_input_ids(rec: dict) -> list[str] | None:
    path = _input_ids_path(rec)
    if path is None or not path.is_file():
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return [line.rstrip("\n") for line in fh if line.strip()]
    except OSError:
        return None


def _write_input_ids(rec: dict, keys: list[str]) -> None:
    path = _input_ids_path(rec)
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text("\n".join(keys) + ("\n" if keys else ""), encoding="utf-8")
        tmp.replace(path)
    except OSError:
        pass


def _update_input_cache(old: dict[str, dict], meta: dict[str, dict],
                        counts: dict[str, dict], old_ids: dict[str, list[str]]) -> tuple[dict[str, dict], dict[str, list[str]]]:
    """合并本次扫描结果。

    ``offset > 0`` 表示只是在旧内容后追加；否则是整文件重读（新增、被回填重写、
    或与旧 offset 对不上）。只有追加才把旧的 trace 键并进来，重写必须丢掉旧计数，
    否则上游清洗一次就会把页面数字叠高（2026-11-20 的 182,292 就是这么来的）。
    """
    new: dict[str, dict] = {}
    ids_out: dict[str, list[str]] = {}
    for path, rec in meta.items():
        prev = old.get(path)
        size = int(rec["size"])
        old_offset = int(prev.get("offset", 0)) if prev else 0
        got = counts.get(path)
        if got is None:
            if prev:
                new[path] = prev
            continue
        append = bool(prev and int(got.get("offset", 0)) > 0)
        if append:
            keys = sorted(set(old_ids.get(path) or []) | set(got.get("keys") or []))
            lines = int(prev.get("lines", 0)) + int(got.get("lines", 0))
            sessions = sorted(set(prev.get("sessions") or []) | set(got.get("sessions") or []))
            offset = min(size, old_offset + int(got.get("used", 0)))
        else:
            keys = list(got.get("keys") or [])
            lines = int(got.get("lines", 0))
            sessions = list(got.get("sessions") or [])
            offset = min(size, int(got.get("used", 0)))
        limit = min(HEAD_HASH_BYTES, offset)
        ids_out[path] = keys
        new[path] = {
            **rec, "size": size, "offset": offset, "lines": lines,
            "sessions": sessions, "traces": len(keys),
            "head_limit": limit, "head": _head_md5(path, limit) if limit else "",
        }
    return new, ids_out


def _apply_eval_ids_locked(input_ids: dict[str, list[str]],
                           eval_ids: dict[tuple[str, str], set[str]]) -> None:
    for path, rec in _STATE["input_files"].items():
        keys = set(input_ids.get(path) or [])
        ev = eval_ids.get((str(rec.get("model")), str(rec.get("date"))), set())
        rec["evaluated"] = len(keys & ev) if keys else 0
        rec["pending"] = len(keys - ev) if keys else 0


def _rebuild_input_locked() -> None:
    models: dict[str, dict] = {}
    lost_in_sessions: set[str] = set()
    lost_in_traces = 0
    for rec in _STATE["input_files"].values():
        row = models.setdefault(rec["model"], {
            "input": 0, "sessions": set(), "traces": 0,
            "evaluated": 0, "pending": 0, "dates": {},
        })
        lines = int(rec.get("lines", 0))
        traces = int(rec.get("traces", 0))
        evaluated = int(rec.get("evaluated", 0))
        pending = int(rec.get("pending", 0))
        row["input"] += lines
        row["sessions"].update(rec.get("sessions") or [])
        row["traces"] += traces
        row["evaluated"] += evaluated
        row["pending"] += pending
        drow = row["dates"].setdefault(rec["date"], {
            "input": 0, "sessions": set(), "traces": 0, "evaluated": 0, "pending": 0,
        })
        drow["input"] += lines
        drow["sessions"].update(rec.get("sessions") or [])
        drow["traces"] += traces
        drow["evaluated"] += evaluated
        drow["pending"] += pending
        if rec.get("source") == "lost_user":
            lost_in_sessions.update(rec.get("sessions") or [])
            lost_in_traces += traces
    for row in models.values():
        row["sessions"] = len(row["sessions"])
        for drow in row["dates"].values():
            drow["sessions"] = len(drow["sessions"])
    _STATE["input"] = models
    _STATE["input_total"] = sum(v["input"] for v in models.values()) or None
    _STATE["lost_user"]["input_sessions"] = len(lost_in_sessions)
    _STATE["lost_user"]["input_traces"] = lost_in_traces


def _rebuild_output_locked() -> None:
    models: dict[str, dict] = {}
    lost_out_sessions: set[str] = set()
    lost_out_trace_ids: set[str] = set()
    lost_out_items = 0
    for rec in _STATE["output_files"].values():
        row = models.setdefault(rec["model"], {
            "attr": 0, "compact": 0, "items": 0, "attr_sessions": set(),
            "trace_ids": set(), "attr_dates": {}, "compact_dates": {}, "date_sessions": {},
            "date_trace_ids": {}, "daily_attr_sessions": set(), "daily_compact": 0,
        })
        lines = int(rec.get("lines", 0))
        if rec["kind"] == "attr":
            row["attr"] += lines
            row["items"] += int(rec.get("items", 0))
            row["attr_sessions"].update(rec.get("sessions") or [])
            ids = set(rec.get("trace_ids") or [])
            row["trace_ids"].update(ids)
            row["attr_dates"][rec["date"]] = row["attr_dates"].get(rec["date"], 0) + lines
            row["date_sessions"].setdefault(rec["date"], set()).update(rec.get("sessions") or [])
            row["date_trace_ids"].setdefault(rec["date"], set()).update(ids)
            if rec.get("source", "daily") == "daily":
                row["daily_attr_sessions"].update(rec.get("sessions") or [])
            if rec.get("source") == "lost_user":
                lost_out_sessions.update(rec.get("sessions") or [])
                lost_out_trace_ids.update(ids)
                lost_out_items += int(rec.get("items", 0))
        else:
            row["compact"] += lines
            row["compact_dates"][rec["date"]] = row["compact_dates"].get(rec["date"], 0) + lines
            if rec.get("source", "daily") == "daily":
                row["daily_compact"] += lines
    for row in models.values():
        row["attr_sessions"] = len(row["attr_sessions"])
        row["daily_attr_sessions"] = len(row["daily_attr_sessions"])
        row["attr_traces"] = len(row.pop("trace_ids"))
        row["attr_date_sessions"] = {d: len(v) for d, v in row.pop("date_sessions").items()}
        row["attr_date_traces"] = {d: len(v) for d, v in row.pop("date_trace_ids").items()}
    _STATE["models"] = models
    _STATE["lost_user"]["attr_sessions"] = len(lost_out_sessions)
    _STATE["lost_user"]["attr_traces"] = len(lost_out_trace_ids)
    _STATE["lost_user"]["attr_items"] = lost_out_items


def _trim_history_locked() -> None:
    cutoff = time.time() - float(_CONFIG["history_seconds"])
    while _STATE["history"] and _STATE["history"][0]["t"] < cutoff:
        _STATE["history"].popleft()
    while _STATE["rpm_history"] and _STATE["rpm_history"][0]["t"] < cutoff:
        _STATE["rpm_history"].popleft()
    while _STATE["queue_history"] and _STATE["queue_history"][0]["t"] < cutoff:
        _STATE["queue_history"].popleft()
    ev_cutoff = time.time() - 1800.0
    while _STATE["part_events"] and _STATE["part_events"][0]["t"] < ev_cutoff:
        _STATE["part_events"].popleft()


def _update_output_cache(old: dict[str, dict], meta: dict[str, dict], counts: dict[str, dict]) -> dict[str, dict]:
    new: dict[str, dict] = {}
    for path, rec in meta.items():
        prev = old.get(path)
        size = int(rec["size"])
        old_size = int(prev.get("size", 0)) if prev else 0
        old_offset = int(prev.get("offset", old_size)) if prev else 0
        needs = prev is None or size != old_size
        if needs and path not in counts:
            if prev:
                new[path] = prev
            continue
        got = counts.get(path)
        if got:
            append = bool(prev and size >= old_offset and old_offset > 0)
            lines = int(got.get("lines", 0)) + (int(prev.get("lines", 0)) if append else 0)
            items = int(got.get("items", 0)) + (int(prev.get("items", 0)) if append else 0)
            sessions = sorted(set(prev.get("sessions") or []) | set(got.get("sessions") or [])) if append else (got.get("sessions") or [])
            trace_ids = set(prev.get("trace_ids") or []) if append else set()
            trace_ids.update(got.get("trace_ids") or [])
            traces = len(trace_ids)
            offset = min(size, (old_offset if append else 0) + int(got.get("used", 0)))
        else:
            lines = int(prev.get("lines", 0)) if prev else 0
            items = int(prev.get("items", 0)) if prev else 0
            sessions = prev.get("sessions") if prev else []
            trace_ids = set(prev.get("trace_ids") or [])
            traces = len(trace_ids)
            offset = old_offset
        new[path] = {
            **rec, "size": size, "offset": offset, "lines": lines, "items": items,
            "sessions": sessions, "traces": traces,
            "trace_ids": sorted(trace_ids) if rec["kind"] == "attr" else [],
        }
    return new


def _mirror_stats(text: str) -> None:
    """Copy the 48h stats cache to the persistent disk every 60s (survives container rebuild)."""
    global _MIRROR_AT
    if not _PERSIST_FILE:
        return
    now = time.time()
    if now - _MIRROR_AT < 60:
        return
    try:
        _PERSIST_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _PERSIST_FILE.with_suffix(".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(_PERSIST_FILE)
        _MIRROR_AT = now
    except OSError:
        pass


def _load_stats(source: Path | None = None) -> bool:
    target = source or _CACHE_FILE
    if not target or not target.is_file():
        return False
    try:
        payload_data = json.loads(target.read_text(encoding="utf-8"))
        version = int(payload_data.get("version") or 0)
        if version not in (4, 5, 6):
            return False
        hist = payload_data.get("history") or []
        if version < 6:
            # v5 accidentally summed __total into k, doubling it; normalize once on load.
            for pt in hist:
                if isinstance(pt, dict) and "k" in pt and "a" in pt and pt["k"] > pt["a"] * 1.5:
                    pt["k"] = pt["k"] // 2
        rpm_hist = payload_data.get("rpm_history") or []
        if not rpm_hist and len(hist) >= 2:
            # Seed the 48h RPM trend from landed attribution/compact deltas when migrating from v5.
            j = 0
            for cur in hist:
                t = float(cur.get("t") or 0)
                while j + 1 < len(hist) and float(hist[j + 1].get("t") or 0) <= t - 300:
                    j += 1
                base = hist[j]
                span = t - float(base.get("t") or 0)
                if span < 30:
                    continue
                pa = round(max(0.0, (float(cur.get("a") or 0) - float(base.get("a") or 0)) / span * 60.0), 1)
                pc = round(max(0.0, (float(cur.get("c") or 0) - float(base.get("c") or 0)) / span * 60.0), 1)
                # No cap here: the real ceiling is whatever the key reports, not a hardcoded 500.
                rpm_hist.append({"t": t, "rpm": round(pa * 13.0 + pc * 14.0, 1), "pa": pa, "pc": pc})
        saved_at = float(payload_data.get("saved_at") or 0.0)
        stale_gap = max(90.0, float(_CONFIG.get("refresh_seconds", 15)) * 4.0)
        parts_fresh = bool(saved_at and (time.time() - saved_at) <= stale_gap)
        with _LOCK:
            _STATE["input_files"] = payload_data.get("input_files") or {}
            _STATE["input_ids"] = {}
            _STATE["output_files"] = payload_data.get("output_files") or {}
            _STATE["output_key_stats"] = payload_data.get("output_key_stats") or {}
            _STATE["keys_sig"] = payload_data.get("keys_sig") or ""
            _STATE["history"] = collections.deque(hist)
            _STATE["rpm_history"] = collections.deque(rpm_hist)
            _STATE["queue_history"] = collections.deque(payload_data.get("queue_history") or [])
            if parts_fresh:
                _STATE["part_files"] = payload_data.get("part_files") or {}
                _STATE["parts_seeded"] = bool(payload_data.get("parts_seeded", False))
                _STATE["parts_seeded_at"] = float(payload_data.get("parts_seeded_at") or 0.0)
                _STATE["part_events"] = collections.deque(payload_data.get("part_events") or [])
            else:
                # Downtime gap: keep full 48h history, re-seed .parts baseline to avoid fake RPM spike.
                _STATE["part_files"] = {}
                _STATE["parts_seeded"] = False
                _STATE["parts_seeded_at"] = 0.0
                _STATE["part_events"] = collections.deque()
            _STATE["gateway_prev"] = {k: tuple(v) for k, v in (payload_data.get("gateway_prev") or {}).items()}
            _STATE["cluster"] = payload_data.get("cluster") or {}
            _STATE["cluster_stats"] = payload_data.get("cluster_stats") or {}
            _STATE["cluster_files"] = payload_data.get("cluster_files") or {}
            _STATE["cluster_output_sig"] = payload_data.get("cluster_output_sig") or ""
            _STATE["cluster_updated_at"] = payload_data.get("cluster_updated_at") or 0
            _STATE["input_updated_at"] = payload_data.get("input_updated") or payload_data.get("saved_at")
            _rebuild_input_locked()
            _rebuild_output_locked()
            _trim_history_locked()
        return True
    except (OSError, ValueError, TypeError):
        return False


def _save_stats() -> None:
    if not _CACHE_FILE:
        return
    try:
        with _LOCK:
            data = {
                "version": 6,
                "input_files": _STATE["input_files"],
                "output_files": _STATE["output_files"],
                "output_key_stats": _STATE["output_key_stats"],
                "keys_sig": _STATE["keys_sig"],
                "history_metric": "traces",
                "history": list(_STATE["history"]),
                "rpm_history": list(_STATE["rpm_history"]),
                "queue_history": list(_STATE["queue_history"]),
                "part_files": _STATE["part_files"],
                "parts_seeded": _STATE["parts_seeded"],
                "parts_seeded_at": _STATE["parts_seeded_at"],
                "part_events": list(_STATE["part_events"]),
                "gateway_prev": {k: list(v) for k, v in _STATE["gateway_prev"].items()},
                "cluster": _STATE["cluster"],
                "cluster_stats": _STATE["cluster_stats"],
                "cluster_files": _STATE["cluster_files"],
                "cluster_output_sig": _STATE["cluster_output_sig"],
                "cluster_updated_at": _STATE["cluster_updated_at"],
                "input_updated": _STATE["input_updated_at"],
                "saved_at": time.time(),
            }
        _CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        tmp = _CACHE_FILE.with_suffix(".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(_CACHE_FILE)
        _mirror_stats(text)
    except OSError:
        pass


def _window_rate(history: list[dict], key: str, limit: int = 300):
    if len(history) < 2:
        return None, None
    last = history[-1]
    if time.time() - last["t"] > 120:
        return None, None
    base = None
    for point in reversed(history):
        if point["t"] <= last["t"] - limit:
            base = point
            break
    if base is None:
        base = history[0]
    span = last["t"] - base["t"]
    if span < 30:
        return None, None
    return max(0.0, (last[key] - base[key]) / span * 60.0), span


def _parts_rates(events: list[dict], seeded_at: float, now: float, window_s: int,
                 rpm_limit: int | None = None) -> tuple[float | None, float | None, float | None, int | None]:
    if not seeded_at or now - seeded_at < 15:
        return None, None, None, None
    cutoff = max(seeded_at, now - window_s)
    span = now - cutoff
    if span < 15:
        return None, None, None, None
    a_sum = c_sum = r_sum = 0
    for ev in events:
        if ev["t"] > cutoff:
            a_sum += int(ev.get("a", 0))
            c_sum += int(ev.get("c", 0))
            r_sum += int(ev.get("r", 0))
    pa = round(max(0.0, a_sum / span * 60.0), 1)
    pc = round(max(0.0, c_sum / span * 60.0), 1)
    rpm = max(0.0, r_sum / span * 60.0)
    if rpm_limit and rpm_limit > 0:
        rpm = min(float(rpm_limit), rpm)
    return pa, pc, round(rpm, 1), int(round(span))


def _ensure_cluster_dist_local(cfg: dict, cluster_files: dict[str, dict], output_sig: str) -> None:
    if not cluster_files:
        return
    now = time.time()
    with _LOCK:
        changed = (cluster_files != _STATE["cluster_files"] or not _STATE["cluster_stats"])
        stale = output_sig != _STATE["cluster_output_sig"]
        need = changed or (stale and now - float(_STATE["cluster_updated_at"] or 0) >= 60)
    if not need:
        return
    dist = _compute_local_cluster_dist(cfg)
    with _LOCK:
        _STATE["cluster_stats"] = dist
        _STATE["cluster_files"] = cluster_files
        _STATE["cluster_output_sig"] = output_sig
        _STATE["cluster_updated_at"] = time.time()


def collect_outputs() -> None:
    cfg = _CONFIG
    mode = _STATE["mode"]
    if mode == "disabled":
        return
    try:
        if mode == "local":
            meta = _collect_local_output_files(cfg)
            clusters, cluster_files = _collect_local_cluster_meta(cfg)
            gateways, control, rpm_limit_info = collect_gateway_local(cfg)
            queue, locks = _collect_local_queue(cfg)
            sig = _keys_signature(cfg)
            with _LOCK:
                old_sig = _STATE["keys_sig"]
                old_ks = _STATE["output_key_stats"]
                old_files = dict(_STATE["output_files"])
                old_part_files = dict(_STATE["part_files"])
                parts_seeded = _STATE["parts_seeded"]
            key_stats = _compute_local_key_stats(cfg) if (sig != old_sig or not old_ks) else old_ks
            changed = []
            for path, rec in meta.items():
                prev = old_files.get(path)
                size = int(rec["size"])
                if prev is None or int(prev.get("size", 0)) != size:
                    offset = int(prev.get("offset", 0)) if prev and size > int(prev.get("offset", 0)) else 0
                    changed.append((path, offset, rec["kind"], size))
            counts = _count_local_output_files(changed) if changed else {}
            new_files = _update_output_cache(old_files, meta, counts)
            output_sig = "|".join(f"{p}:{r['size']}" for p, r in sorted(new_files.items()) if r.get("kind") == "attr")
            _ensure_cluster_dist_local(cfg, cluster_files, output_sig)
            new_part_files, parts_delta = _scan_parts_local(cfg, old_part_files, parts_seeded)
        else:
            # Explicit SSH fallback for local laptop development
            from pathlib import PurePosixPath  # noqa: F401
            gw_out = json.loads(_ssh_run(cfg, _ssh_gateway_script(cfg), timeout=20).strip().splitlines()[-1])
            gateways = gw_out.get("gateways") or {}
            control = gw_out.get("control") or {}
            rpm_limit_info = gw_out.get("rpm_limit_info") or {}
            parts_raw = json.loads(_ssh_run(cfg, _ssh_parts_script(cfg, _STATE["part_files"], _STATE["parts_seeded"]), timeout=30).strip().splitlines()[-1])
            new_part_files = parts_raw.get("files") or {}
            parts_delta = parts_raw.get("delta") or {"a": 0, "c": 0, "r": 0, "active_writers": 0, "newest_age_s": None}
            # Minimal output/queue/key stats over SSH reusing server_monitor layout
            queue_script = f"python3 - <<'PY'\nimport collections, glob, json, os\ncr={repr(cfg['chunk_root'])}; qr={repr(cfg['output_root'] + '/.orchestrator/queue')}\nms=collections.defaultdict(lambda:{{'total':0,'done':0,'running':0,'retry':0}})\ndt=[]\nfor p in glob.glob(cr+'/*/*/*.jsonl'):\n rel=os.path.relpath(p,cr).split(os.sep)\n if len(rel)>=3: ms[rel[0]]['total']+=1\nfor p in glob.glob(qr+'/*.state'):\n k=os.path.basename(p)[:-6]\n if '.c' not in k: continue\n m=k.split('__',1)[0]\n if m not in ms: continue\n ls=open(p).read().splitlines(); s=ls[1] if len(ls)>1 else ''\n if s=='0': ms[m]['done']+=1; dt.append(os.stat(p).st_mtime)\n elif s=='running': ms[m]['running']+=1\n else: ms[m]['retry']+=1\nrows=[];t=d=r=rt=0\nfor m in sorted(ms):\n rc=ms[m]; rc['pending']=max(0,rc['total']-rc['done']-rc['running']-rc['retry']); t+=rc['total']; d+=rc['done']; r+=rc['running']; rt+=rc['retry']; rows.append({{'name':m,**rc}})\nprint(json.dumps({{'total':t,'done':d,'running':r,'retry':rt,'pending':max(0,t-d-r-rt),'done_since':min(dt) if dt else None,'done_last':max(dt) if dt else None,'models':rows}}))\nPY"
            queue = json.loads(_ssh_run(cfg, queue_script, timeout=30).strip().splitlines()[-1])
            locks = []
            meta, clusters, cluster_files = {}, {}, {}
            sig = _STATE["keys_sig"]
            key_stats = _STATE["output_key_stats"]
            new_files = _STATE["output_files"]

        now = time.time()
        with _LOCK:
            if new_files or not _STATE["output_files"]:
                _STATE["output_files"] = new_files
            if queue is not None:
                queue["updated_at"] = now
                _STATE["queue"] = queue
                qh = _STATE["queue_history"]
                qh.append({"t": now, "done": int(queue.get("done") or 0)})
                q_cutoff = now - float(_CONFIG["history_seconds"])
                while qh and qh[0]["t"] < q_cutoff:
                    qh.popleft()
            _STATE["locks"] = locks
            if key_stats:
                _STATE["output_key_stats"] = key_stats
                _STATE["keys_sig"] = sig
            if clusters:
                _STATE["cluster"] = clusters
            _rebuild_output_locked()
            _STATE["control"] = control
            _STATE["rpm_limit_info"] = rpm_limit_info
            prevs = _STATE["gateway_prev"]
            for name, gw in gateways.items():
                old_prev = prevs.get(name)
                gw["tps"] = None
                if gw.get("metrics") and gw.get("code") == 200 and old_prev:
                    dt = now - old_prev[0]
                    if 0 < dt <= 120 and gw.get("gen", 0) >= old_prev[1]:
                        gw["tps"] = round((gw["gen"] - old_prev[1]) / dt, 1)
                if gw.get("metrics") and gw.get("code") == 200 and gw.get("gen", 0) > 0:
                    prevs[name] = (now, gw["gen"])
                else:
                    prevs.pop(name, None)
            _STATE["gateways"] = gateways

            _STATE["part_files"] = new_part_files
            was_seeded = _STATE["parts_seeded"]
            _STATE["parts_seeded"] = True
            if not was_seeded or not _STATE["parts_seeded_at"]:
                _STATE["parts_seeded_at"] = now
            else:
                _STATE["part_events"].append({
                    "t": now,
                    "a": int(parts_delta.get("a") or 0),
                    "c": int(parts_delta.get("c") or 0),
                    "r": int(parts_delta.get("r") or 0),
                })
            _STATE["active_writers"] = int(parts_delta.get("active_writers") or 0)
            _STATE["newest_part_age_s"] = parts_delta.get("newest_age_s")

            rpm_limits = [g["rpm_limit"] for g in gateways.values() if isinstance(g.get("rpm_limit"), int) and g["rpm_limit"] > 0]
            cap_rpm = sum(rpm_limits) if rpm_limits else (rpm_limit_info.get("rpm") if isinstance(rpm_limit_info.get("rpm"), int) else None)
            pa, pc, live_rpm, _ = _parts_rates(
                list(_STATE["part_events"]), _STATE["parts_seeded_at"], now, int(cfg["rpm_window_seconds"]), cap_rpm,
            )
            if live_rpm is not None:
                _STATE["rpm_history"].append({"t": now, "rpm": live_rpm, "pa": pa or 0.0, "pc": pc or 0.0})

            attr = sum(int(v.get("attr", 0)) for v in _STATE["models"].values())
            compact = sum(int(v.get("compact", 0)) for v in _STATE["models"].values())
            evaluated = sum(
                int(v.get("attr_rows", 0))
                for k, v in (_STATE["output_key_stats"] or {}).items()
                if k != "__total" and isinstance(v, dict)
            )
            _STATE["history"].append({"t": now, "a": attr, "c": compact, "k": evaluated})
            _trim_history_locked()
            _STATE["ok"] = True
            _STATE["error"] = ""
            _STATE["updated_at"] = now
            _STATE["last_success"] = now
        _save_stats()
    except Exception as exc:  # noqa: BLE001 - keep last good stats
        with _LOCK:
            _STATE["ok"] = False
            _STATE["error"] = str(exc)[:240]


def refresh_inputs() -> None:
    cfg = _CONFIG
    if _STATE["mode"] != "local":
        return
    try:
        meta = _collect_local_input_meta(cfg)
        if not meta:
            raise RuntimeError("没有读到 daily 输入")
        sig = _keys_signature(cfg)
        eval_ids = _load_eval_ids(cfg, sig)
        with _LOCK:
            files = dict(_STATE["input_files"])
            ids = dict(_STATE["input_ids"])
        changed = []
        for path, rec in meta.items():
            prev = files.get(path)
            size = int(rec["size"])
            mtime_ns = int(rec.get("mtime_ns") or 0)
            ctime_ns = int(rec.get("ctime_ns") or 0)
            if path not in ids and prev:
                loaded = _read_input_ids(rec)
                if loaded is not None:
                    ids[path] = loaded
            same_basic = bool(
                prev
                and int(prev.get("size", 0)) == size
                and int(prev.get("mtime_ns", 0)) == mtime_ns
            )
            if same_basic and int(prev.get("ctime_ns") or 0) == ctime_ns:
                continue
            if same_basic and not prev.get("ctime_ns") and prev.get("head") and path in ids:
                # 旧缓存没有 ctime：当前计数已是新扫描器产出，补上时间戳即可，不必重扫 61 GB。
                files[path] = {**prev, "ctime_ns": ctime_ns}
                continue
            needs = (
                prev is None
                or int(prev.get("size", 0)) != size
                or int(prev.get("mtime_ns", 0)) != mtime_ns
                or int(prev.get("ctime_ns") or 0) != ctime_ns
                or path not in ids
            )
            if not needs:
                continue
            offset = 0
            if prev and path in ids:
                prev_offset = int(prev.get("offset", 0))
                # 只有「前缀没变、只是变长」才算追加；回填重写（含同大小重写）必须整读。
                if (
                    0 < prev_offset < size
                    and prev.get("head")
                    and _head_md5(path, int(prev.get("head_limit") or 0)) == prev.get("head")
                ):
                    offset = prev_offset
            changed.append((path, offset))
        # Newest first, and publish after every file: a cold start (cache lost with /opt)
        # has to re-read 61 GB, and waiting for the whole batch left the page at all zeros
        # for half an hour.
        changed.sort(key=lambda item: meta[item[0]]["date"], reverse=True)
        for path, offset in changed:
            counts = _count_local_input_files([(path, offset)])
            for got in counts.values():
                got["offset"] = offset
            with _LOCK:
                files, ids_out = _update_input_cache(files, meta, counts, ids)
                ids.update(ids_out)
                _STATE["input_files"] = files
                _STATE["input_ids"] = ids
                rec = files.get(path)
                if rec is not None:
                    _write_input_ids(rec, ids.get(path, []))
                _apply_eval_ids_locked(ids, eval_ids)
                _rebuild_input_locked()
                _STATE["input_error"] = ""
                _STATE["input_updated_at"] = time.time()
            _save_stats()
        with _LOCK:
            _STATE["input_files"] = files
            _apply_eval_ids_locked(ids, eval_ids)
            _rebuild_input_locked()
            _STATE["input_error"] = ""
            _STATE["input_updated_at"] = time.time()
        _save_stats()
    except Exception as exc:  # noqa: BLE001
        with _LOCK:
            _STATE["input_error"] = str(exc)[:240]


def _output_loop() -> None:
    interval = max(5.0, float(_CONFIG["refresh_seconds"]))
    while True:
        started = time.time()
        collect_outputs()
        time.sleep(max(5.0, interval - (time.time() - started)))


def _input_loop() -> None:
    interval = max(15.0, float(_CONFIG["input_refresh_seconds"]))
    while True:
        started = time.time()
        refresh_inputs()
        time.sleep(max(15.0, interval - (time.time() - started)))


def payload() -> dict:
    with _LOCK:
        meta = {
            k: _STATE[k]
            for k in ("available", "mode", "ok", "error", "input_error", "updated_at",
                      "last_success", "input_total", "input_updated_at",
                      "active_writers", "newest_part_age_s", "parts_seeded_at")
        }
        out_models = {name: {k: (dict(v) if isinstance(v, dict) else v) for k, v in row.items()}
                      for name, row in _STATE["models"].items()}
        key_stats = {name: {k: (dict(v) if isinstance(v, dict) else v) for k, v in row.items()}
                     for name, row in _STATE["output_key_stats"].items()}
        inp_models = {name: {k: (dict(v) if isinstance(v, dict) else v) for k, v in row.items()}
                      for name, row in _STATE["input"].items()}
        gateway_rows = {name: dict(row) for name, row in _STATE["gateways"].items()}
        control = dict(_STATE["control"])
        rpm_limit_info = dict(_STATE["rpm_limit_info"])
        cluster_rows = {name: dict(row) for name, row in _STATE["cluster"].items()}
        cluster_dist_rows = {name: dict(row) for name, row in _STATE["cluster_stats"].items()}
        lost_user = dict(_STATE["lost_user"])
        history = [dict(p) for p in _STATE["history"]]
        rpm_history = [dict(p) for p in _STATE["rpm_history"]]
        part_events = [dict(p) for p in _STATE["part_events"]]
        queue = dict(_STATE["queue"])
        queue_history = [dict(p) for p in _STATE["queue_history"]]
        locks = [dict(x) for x in _STATE["locks"]]

    if not meta["available"]:
        return {
            "available": False,
            "mode": meta["mode"],
            "ok": False,
            "error": meta["error"],
            "updated_at": _to_iso(time.time()),
        }

    names = list(inp_models) + [n for n in out_models if n not in inp_models]
    models = []
    for name in names:
        inp = inp_models.get(name, {})
        out = out_models.get(name, {})
        ks = key_stats.get(name, {})
        use_keys = bool(ks)
        kdates = ks.get("dates", {})
        ids = inp.get("dates", {})
        adates = out.get("attr_dates", {})
        cdates = out.get("compact_dates", {})
        ads = out.get("attr_date_sessions", {})
        if use_keys:
            completed = int(ks.get("attr_rows", 0))
            completed_sessions = int(ks.get("attr_sessions", 0))
        else:
            completed = int(out.get("attr", 0))
            completed_sessions = int(out.get("attr_sessions", 0))
        dates = []
        for date in sorted(set(ids) | set(adates) | set(cdates) | set(kdates), reverse=True):
            irow = ids.get(date, {})
            iv = int(irow.get("input", 0))
            isess = int(irow.get("sessions", 0))
            itr = int(irow.get("traces", 0))
            if use_keys:
                kd = kdates.get(date, {})
                av = int(kd.get("attr", 0))
                asess = int(kd.get("attr_sessions", 0))
                cv = int(kd.get("compact", 0))
            else:
                av = int(adates.get(date, 0))
                asess = int(ads.get(date, 0))
                cv = int(cdates.get(date, 0))
            if irow and "evaluated" in irow:
                # 输入 trace 集合 ∩ 该日 .keys；pending 是集合差，不是「输入行数 - 输出行数」。
                atr = int(irow.get("evaluated", 0))
                rem = int(irow.get("pending", max(0, itr - atr)))
            elif irow:
                atr = av
                rem = max(0, itr - atr)
            else:
                atr = 0
                rem = 0
            dates.append({
                "date": date, "input": iv, "input_sessions": isess,
                "input_traces": itr, "attr": av,
                "attr_sessions": asess, "attr_traces": atr,
                "compact": cv,
                "remaining": rem,
                "remaining_sessions": max(0, isess - asess),
                "remaining_traces": rem,
            })
        input_sessions = int(inp.get("sessions", 0))
        input_traces = int(inp.get("traces", 0))
        matched_traces = sum(d["attr_traces"] for d in dates)
        pending_traces = sum(d["remaining_traces"] for d in dates)
        models.append({
            "name": name,
            "input": int(inp.get("input", 0)),
            "input_sessions": input_sessions,
            "input_traces": input_traces,
            "attr": completed,
            "attr_sessions": completed_sessions,
            "attr_traces": matched_traces,
            "output_traces": completed,
            "compact": int(ks.get("compact_rows", completed)) if use_keys else int(out.get("compact", completed)),
            "items": int(out.get("items", 0)),
            "remaining": pending_traces,
            "dates": dates,
        })

    attr_total = sum(m["attr"] for m in models)
    compact_total = sum(m["compact"] for m in models)
    input_sessions = sum(m["input_sessions"] for m in models)
    input_traces = sum(m["input_traces"] for m in models)
    attr_sessions = sum(m["attr_sessions"] for m in models)
    attr_traces = sum(m["attr_traces"] for m in models)
    total = input_traces
    remaining_sessions = max(0, input_sessions - attr_sessions)
    remaining_traces = sum(m["remaining"] for m in models)
    remaining = remaining_traces

    a_rate, a_span = _window_rate(history, "a", int(_CONFIG["rate_window_seconds"]))
    c_rate, _ = _window_rate(history, "c", int(_CONFIG["rate_window_seconds"]))
    k_rate, _ = _window_rate(history, "k", int(_CONFIG["rate_window_seconds"]))

    now = time.time()
    rpm_limits = [g["rpm_limit"] for g in gateway_rows.values() if isinstance(g.get("rpm_limit"), int) and g["rpm_limit"] > 0]
    total_rpm_limit = sum(rpm_limits) if rpm_limits else (rpm_limit_info.get("rpm") if isinstance(rpm_limit_info.get("rpm"), int) else None)
    # "key" only when every gateway with a ceiling got it from /key/info; otherwise the total
    # leans on the harness cache and the UI says so.
    rpm_sources = [g.get("rpm_source") for g in gateway_rows.values()
                   if isinstance(g.get("rpm_limit"), int) and g["rpm_limit"] > 0]
    total_rpm_source = "key" if rpm_sources and all(x == "key" for x in rpm_sources) else (
        "runtime" if total_rpm_limit else "none")
    parts_attr_rate, parts_compact_rate, _, parts_span = _parts_rates(
        part_events, meta["parts_seeded_at"], now, int(_CONFIG["rate_window_seconds"]), total_rpm_limit,
    )
    _, _, realtime_rpm, rpm_span = _parts_rates(
        part_events, meta["parts_seeded_at"], now, int(_CONFIG["rpm_window_seconds"]), total_rpm_limit,
    )
    # Initial startup grace: if .parts hasn't spanned 15s yet, provide an indicative activity reading
    # only if workers are actively writing and the gateway was active within 30s.
    if realtime_rpm is None and meta["active_writers"] > 0:
        any_fresh = any(g.get("active_ago_s") is not None and g["active_ago_s"] <= 30 for g in gateway_rows.values())
        if any_fresh and a_rate is not None:
            est = round(a_rate * 25.0, 1)
            realtime_rpm = min(float(total_rpm_limit), est) if total_rpm_limit else est

    eta = None
    if remaining_traces == 0:
        eta = 0
    elif k_rate and k_rate > 0:
        eta = remaining_traces / k_rate
    elif parts_attr_rate and parts_attr_rate > 0:
        eta = remaining_traces / parts_attr_rate

    queue_eta = None
    if int(queue.get("total", 0)) > 0:
        remaining_chunks = max(0, int(queue["total"]) - int(queue["done"]))
        if remaining_chunks == 0:
            queue_eta = 0
        elif len(queue_history) >= 2:
            last = queue_history[-1]
            base = queue_history[0]
            for point in queue_history:
                if point["t"] >= last["t"] - 1800:
                    base = point
                    break
            span = last["t"] - base["t"]
            delta = last["done"] - base["done"]
            if span >= 60 and delta > 0:
                queue_eta = remaining_chunks / (delta / span * 60.0)
        if queue_eta is None and int(queue["done"]) > 0 and queue.get("done_since"):
            elapsed = now - float(queue["done_since"])
            if elapsed >= 300:
                queue_eta = remaining_chunks / (int(queue["done"]) / elapsed * 60.0)

    active_replicas = len({x["owner"] for x in locks if x.get("owner") != ""}) or None
    ctrl_channels = control.get("channels") if isinstance(control.get("channels"), dict) else {}
    gateway_items = []
    healthy_count = 0
    total_gw = len(gateway_rows)
    for name, row in sorted(gateway_rows.items()):
        ok = bool(row.get("ok"))
        if ok:
            healthy_count += 1
        ch_list = row.get("channels") or [name]
        permits = sum(int(ctrl_channels[c]) for c in ch_list if isinstance(ctrl_channels.get(c), int))
        if not permits and isinstance(control.get("modelRequests"), int):
            permits = int(control["modelRequests"])
        item_rpm_limit = row.get("rpm_limit") or total_rpm_limit
        item_rpm = None
        if realtime_rpm is not None and total_gw > 0:
            if total_rpm_limit and item_rpm_limit:
                item_rpm = round(realtime_rpm * (item_rpm_limit / total_rpm_limit), 1)
            else:
                item_rpm = round(realtime_rpm / max(1, healthy_count or total_gw), 1)
        gateway_items.append({
            "name": name,
            "host": row.get("host") or name,
            "url": row.get("url") or f"http://{name}/v1",
            "channels": ch_list,
            "ok": ok,
            "healthy": bool(row.get("healthy")),
            "metrics": bool(row.get("metrics")),
            "code": row.get("code"),
            "latency_ms": row.get("latency_ms"),
            "models": row.get("models") or [],
            "workload": row.get("workload"),
            "rpm": item_rpm,
            "rpm_limit": item_rpm_limit,
            "rpm_source": row.get("rpm_source") or ("none" if not item_rpm_limit else "runtime"),
            "rpm_window": row.get("rpm_window"),
            "tpm_limit": row.get("tpm_limit"),
            "permits": permits or None,
            "concurrency": control.get("concurrency"),
            "active_writers": meta["active_writers"],
            "active_replicas": active_replicas,
            "last_active": row.get("last_active"),
            "active_ago_s": row.get("active_ago_s"),
            "cooldown": bool(row.get("cooldown")),
            "running": int(row.get("running", 0)),
            "waiting": int(row.get("waiting", 0)),
            "tps": row.get("tps"),
        })

    running_sum = sum(g["running"] for g in gateway_items if g["ok"])
    waiting_sum = sum(g["waiting"] for g in gateway_items if g["ok"])
    tps_values = [g["tps"] for g in gateway_items if g["tps"] is not None]
    rpm_util = round(realtime_rpm / total_rpm_limit, 4) if (realtime_rpm is not None and total_rpm_limit) else None

    cluster_models = []
    output_traces_by_model = {m["name"]: m.get("output_traces", m["attr_traces"]) for m in models}
    for name in sorted(set(cluster_rows) | set(cluster_dist_rows)):
        out_traces = int(output_traces_by_model.get(name, 0))
        dist = cluster_dist_rows.get(name, {})
        if dist:
            landed = out_traces
            pending = min(int(dist.get("pending", 0)), landed)
            handled = landed - pending
        else:
            landed = out_traces
            handled = out_traces
            pending = 0
        cluster_models.append({
            "name": name,
            "traces": handled,
            "output_traces": landed,
            "pending": pending,
        })
    cluster_traces = sum(m["traces"] for m in cluster_models)
    cluster_pending = sum(m["pending"] for m in cluster_models)

    return {
        "available": True,
        "mode": meta["mode"],
        "ok": meta["ok"],
        "error": meta["error"],
        "input_error": meta["input_error"],
        "updated_at": _to_iso(meta["updated_at"]),
        "last_success": _to_iso(meta["last_success"]),
        "input_updated_at": _to_iso(meta["input_updated_at"]),
        "total": total,
        "attr": attr_total,
        "compact": compact_total,
        "input_sessions": input_sessions,
        "input_traces": input_traces,
        "attr_sessions": attr_sessions,
        "attr_traces": attr_traces,
        "remaining_sessions": remaining_sessions,
        "remaining_traces": remaining_traces,
        "remaining": remaining,
        "progress": (attr_traces / input_traces) if input_traces else None,
        "session_progress": (attr_sessions / input_sessions) if input_sessions else None,
        "rates": {
            "attr": a_rate,
            "compact": c_rate,
            "window_seconds": int(a_span) if a_span else None,
            "parts_attr": parts_attr_rate,
            "parts_compact": parts_compact_rate,
            "parts_window_seconds": parts_span,
            "realtime_rpm": realtime_rpm,
            "rpm_window_seconds": rpm_span,
            "active_writers": meta["active_writers"],
            "newest_part_age_s": meta["newest_part_age_s"],
        },
        "eta_minutes": eta,
        "queue": {
            **queue,
            "locks": locks,
            "active_replicas": active_replicas,
            "eta_minutes": queue_eta,
            "updated_at": _to_iso(queue.get("updated_at")),
        },
        "models": models,
        "lost_user": lost_user,
        "cluster": {
            "traces": cluster_traces,
            "pending": cluster_pending,
            "models": cluster_models,
        },
        "gateways": {
            "count": total_gw,
            "healthy": healthy_count,
            "realtime_rpm": realtime_rpm,
            "rpm_limit": total_rpm_limit,
            "rpm_source": total_rpm_source,
            "rpm_utilization": rpm_util,
            "parts_attr_rate": parts_attr_rate,
            "parts_compact_rate": parts_compact_rate,
            "active_writers": meta["active_writers"],
            "newest_part_age_s": meta["newest_part_age_s"],
            "active_replicas": active_replicas,
            "control": {
                "model_requests": control.get("modelRequests"),
                "concurrency": control.get("concurrency"),
                "task_concurrency": control.get("taskConcurrency"),
                "heavy_concurrency": control.get("heavyConcurrency"),
                "heavy_model_requests": control.get("heavyModelRequests"),
                "compact_backlog": control.get("compactBacklog"),
                "unit_concurrency": control.get("unitConcurrency"),
                "chunk_cases": control.get("chunkCases"),
                "paused": bool(control.get("paused", False)),
                "auto_tune_at": rpm_limit_info.get("updated_at"),
                "rpm_limit": rpm_limit_info.get("rpm"),
                "rpm_source": "runtime" if rpm_limit_info.get("rpm") else "none",
                "permits": rpm_limit_info.get("permits"),
            },
            "running": running_sum,
            "waiting": waiting_sum,
            "output_tps": round(sum(tps_values), 1) if tps_values else None,
            "items": gateway_items,
        },
        "history": [[round(p["t"]), p["a"], p["c"]] for p in history],
        "rpm_history": [[round(p["t"]), p["rpm"], p["pa"], p["pc"]] for p in rpm_history],
    }


def start(cache_dir: str | Path, overrides: dict | None = None,
          persist_path: str | Path | None = None) -> bool:
    """Configure and launch background speed polling if the AIME pipeline is reachable."""
    global _STARTED, _CACHE_FILE, _PERSIST_FILE, _CONFIG, _IDS_DIR
    with _LOCK:
        if _STARTED:
            return _STATE["available"]
        _STARTED = True
        _CONFIG = load_config(overrides)
        mode, available, reason = detect_mode(_CONFIG)
        _STATE["mode"] = mode
        _STATE["available"] = available
        _STATE["error"] = "" if available else reason
        _CACHE_FILE = Path(cache_dir) / "speed_stats.json"
        _PERSIST_FILE = Path(persist_path) if persist_path else None
        # Trace 键索引按文件落盘：容器重建丢掉 /opt 时不必重扫 61 GB 输入。
        base = _PERSIST_FILE.parent if _PERSIST_FILE else Path(cache_dir)
        _IDS_DIR = base / "speed_input_ids"
        _EVAL_IDS_CACHE["sig"] = None
        _EVAL_IDS_CACHE["ids"] = {}
    if not available:
        return False
    candidates = []
    for p in (_CACHE_FILE, _PERSIST_FILE):
        if p and p.is_file():
            try:
                candidates.append((p.stat().st_mtime, p))
            except OSError:
                pass
    candidates.sort(key=lambda item: item[0], reverse=True)
    loaded = False
    for _, src in candidates:
        if _load_stats(src):
            loaded = True
            if src != _CACHE_FILE and _CACHE_FILE:
                try:
                    _CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(src, _CACHE_FILE)
                except OSError:
                    pass
            break
    if not loaded:
        _load_stats()
    threading.Thread(target=_output_loop, name="speed-output", daemon=True).start()
    threading.Thread(target=_input_loop, name="speed-input", daemon=True).start()
    return True


def reset_for_test(cache_dir: str | Path | None = None, overrides: dict | None = None) -> None:
    """Reset module state for isolated unit tests."""
    global _STARTED, _CACHE_FILE, _CONFIG, _IDS_DIR
    with _LOCK:
        _STARTED = False
        _CONFIG = load_config(overrides)
        mode, available, reason = detect_mode(_CONFIG)
        _CACHE_FILE = Path(cache_dir) / "speed_stats.json" if cache_dir else None
        _IDS_DIR = Path(cache_dir) / "speed_input_ids" if cache_dir else None
        _EVAL_IDS_CACHE["sig"] = None
        _EVAL_IDS_CACHE["ids"] = {}
        _STATE.update({
            "available": available,
            "mode": mode,
            "ok": False,
            "error": "" if available else reason,
            "input_error": "",
            "updated_at": None,
            "last_success": None,
            "input_updated_at": None,
            "input_total": None,
            "models": {},
            "output_key_stats": {},
            "keys_sig": "",
            "input": {},
            "input_files": {},
            "input_ids": {},
            "output_files": {},
            "lost_user": {"input_sessions": 0, "input_traces": 0, "attr_sessions": 0, "attr_traces": 0, "attr_items": 0},
            "gateways": {},
            "gateway_prev": {},
            "control": {},
            "rpm_limit_info": {},
            "cluster": {},
            "cluster_stats": {},
            "cluster_files": {},
            "cluster_output_sig": "",
            "cluster_updated_at": 0,
            "queue": {},
            "queue_history": collections.deque(),
            "locks": [],
            "part_files": {},
            "parts_seeded": False,
            "parts_seeded_at": 0.0,
            "part_events": collections.deque(),
            "active_writers": 0,
            "newest_part_age_s": None,
            "history": collections.deque(),
            "rpm_history": collections.deque(),
        })
