#!/usr/bin/env python3
"""AIME 评测输入/输出：乌兰 -> 弗吉尼亚 增量同步（经本机中转）。

两台服务器互不可达，本机（macOS）作为中转；数据是 append-only 的 JSONL，
所以按「只传新增尾部 + zstd 流式压缩」做增量，失败可续传，全程不删除目标端文件。

用法：
    python3 scripts/sync_aime_ulan_to_va.py --dry-run        # 只看计划
    python3 scripts/sync_aime_ulan_to_va.py                  # 跑一轮（全部任务）
    python3 scripts/sync_aime_ulan_to_va.py --only lost      # 只同步流失回测
    python3 scripts/sync_aime_ulan_to_va.py --verify synced  # 本轮传过的文件做 md5 对账
    python3 scripts/sync_aime_ulan_to_va.py --verify all --only lost   # 全量 md5 对账

产物：
    tmp/aime_sync/sync.log        每轮日志
    tmp/aime_sync/last_round.json 最近一轮的结构化摘要
    tmp/aime_sync/history.jsonl   历次摘要（一行一轮）
"""

import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATE_DIR = ROOT / "tmp" / "aime_sync"

ULAN_HOST = "eval_data"
VA_HOST = "aime_rsi_data"
ULAN_ZSTD = "/root/miniforge3/bin/zstd"
VA_ZSTD = "zstd"
ZSTD_LEVEL = 3
PREFIX_CHECK_BYTES = 64 * 1024
PART_SUFFIX = ".part-sync"
STALL_SECONDS = 120       # 单次传输连续无字节流动超过该秒数即判定挂起
STALL_ATTEMPTS = 2       # 挂起类错误最多重试次数（避免一轮被拖死）

ULAN_BASE = "/mnt/fin_bench/code_and_clean_data/datasets/1_aime"
VA_BASE = "/mnt/fin_bench/aime_rsi_data/1_aime"

TASKS = {
    "lost": {
        "label": "流失用户回测（专项）",
        "pairs": [
            ("input", f"{ULAN_BASE}/eval_input/2_task_eval_input/lost_user_test",
             f"{VA_BASE}/eval_input/2_task_eval/0_lost_user_back_test", "append"),
            ("output", f"{ULAN_BASE}/eval_output/2_task_eval/lost_user_test",
             f"{VA_BASE}/eval_output/2_task_eval/0_lost_user_back_test", "append"),
        ],
        "run_state": f"{ULAN_BASE}/eval_output/2_task_eval/lost_user_test/.runs",
    },
    "lost_archive": {
        "label": "流失回测（看板 lost split：archive 全量输入 + 1_lost_user_eval 输出）",
        # build.py 的 SPLITS 只认 0_daily_eval / 1_lost_user_eval；lost 的输入优先读
        # .archive/1_lost_user_input/*-<date>_input.jsonl，缺失时才回退 eval_input/1_lost_user_eval。
        # 弗吉尼亚缺的正是 archive，导致有输出、输入显示 0。
        "pairs": [
            ("input", f"{ULAN_BASE}/.archive/1_lost_user_input",
             f"{VA_BASE}/.archive/1_lost_user_input", "append"),
            ("output", f"{ULAN_BASE}/eval_output/1_lost_user_eval",
             f"{VA_BASE}/eval_output/1_lost_user_eval", "append"),
        ],
    },
    "daily": {
        "label": "日常评测",
        "pairs": [
            ("input", f"{ULAN_BASE}/eval_input/0_daily_eval_input",
             f"{VA_BASE}/eval_input/0_daily_eval_input", "append"),
            ("output", f"{ULAN_BASE}/eval_output/0_daily_eval",
             f"{VA_BASE}/eval_output/0_daily_eval", "append"),
            ("cluster", f"{ULAN_BASE}/eval_output/cluster",
             f"{VA_BASE}/eval_output/cluster", "exact"),
            # 投递台账 provenance 是整份重写的，append 会在两边互相覆盖；用 exact 让新的一方胜出
            ("provenance", f"{ULAN_BASE}/eval_output/0_daily_eval/.delivery/provenance",
             f"{VA_BASE}/eval_output/0_daily_eval/.delivery/provenance", "exact"),
        ],
        "status_files": {
            "aime_expert": f"{ULAN_BASE}/eval_input/0_daily_eval_input/aime_expert/status.json",
            "aime_fast": f"{ULAN_BASE}/eval_input/0_daily_eval_input/aime_fast/status.json",
        },
    },
    "ab_test": {
        "label": "A/B 测试（ab_test/0_version1106_test 等版本目录）",
        # 2026-11-07 起要求随同步一起带过去：目前是空的版本目录骨架，内容会陆续落盘。
        "pairs": [
            ("data", f"{ULAN_BASE}/ab_test", f"{VA_BASE}/ab_test", "append"),
        ],
    },
}

DIRECTION = "forward"

SSH_OPTS = [
    "ssh",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ControlMaster=auto",
    "-o", "ControlPath=/tmp/aimsync-cm-%C",
    "-o", "ControlPersist=120",
]


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #

def log(msg):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)


def ssh_argv(host, remote_cmd):
    return SSH_OPTS + [host, remote_cmd]


def run_ssh(host, remote_cmd, retries=6, timeout=180):
    """跑一条远端命令，返回 stdout；连接被拒/超时按指数退避重试。"""
    last = None
    for attempt in range(retries):
        try:
            p = subprocess.run(ssh_argv(host, remote_cmd), capture_output=True,
                               timeout=timeout)
            if p.returncode == 0:
                return p.stdout.decode("utf-8", "replace")
            last = f"rc={p.returncode} {p.stderr.decode('utf-8', 'replace').strip()[:300]}"
        except subprocess.TimeoutExpired:
            last = "timeout"
        sleep = min(2.0 + attempt * 1.5, 8.0)
        if attempt + 1 < retries:
            time.sleep(sleep)
    raise RuntimeError(f"ssh {host} 失败（{retries} 次）：{remote_cmd[:100]} <- {last}")


class StallError(RuntimeError):
    """传输长时间没有任何字节流动（ceph/网络挂起）。"""


def stream_transfer(src_cmd, dst_cmd, retries=6):
    """乌兰的 src_cmd 输出 -> 弗吉尼亚的 dst_cmd 输入；返回中转字节数。"""
    last = None
    stalls = 0
    for attempt in range(retries):
        try:
            return _stream_once(src_cmd, dst_cmd)
        except StallError as exc:
            stalls += 1
            last = str(exc)
            if stalls >= STALL_ATTEMPTS:
                break
        except Exception as exc:  # noqa: BLE001 - 统一重试
            last = str(exc)
        time.sleep(min(2.0 + attempt * 1.5, 8.0))
    raise RuntimeError(f"传输失败（{retries} 次）：{last}")


def _stream_once(src_cmd, dst_cmd):
    p_src = subprocess.Popen(ssh_argv(ULAN_HOST, src_cmd), stdout=subprocess.PIPE,
                             stderr=tempfile.TemporaryFile())
    p_dst = subprocess.Popen(ssh_argv(VA_HOST, dst_cmd), stdin=subprocess.PIPE,
                             stderr=tempfile.TemporaryFile())
    sent = 0
    broken = None
    activity = {"last": time.time(), "stalled": False}
    stop = threading.Event()

    def watchdog():
        while not stop.wait(5):
            if time.time() - activity["last"] > STALL_SECONDS:
                activity["stalled"] = True
                for proc in (p_src, p_dst):
                    try:
                        proc.kill()
                    except OSError:
                        pass
                return

    watcher = threading.Thread(target=watchdog, daemon=True)
    watcher.start()
    try:
        while True:
            chunk = p_src.stdout.read(1 << 20)
            if not chunk:
                break
            activity["last"] = time.time()
            try:
                p_dst.stdin.write(chunk)
            except (BrokenPipeError, ConnectionResetError) as exc:
                broken = exc
                break
            sent += len(chunk)
        try:
            p_dst.stdin.close()
        except (BrokenPipeError, ConnectionResetError):
            pass
        rc_src = p_src.wait()
        rc_dst = p_dst.wait()
    finally:
        stop.set()
        if p_src.poll() is None:
            p_src.kill()
        if p_dst.poll() is None:
            p_dst.kill()

    err_src = _read_tail(p_src.stderr)
    err_dst = _read_tail(p_dst.stderr)
    if activity["stalled"]:
        raise StallError(f"传输停滞超过 {STALL_SECONDS}s（已中转 {sent} 字节）")
    if broken is not None or rc_src != 0 or rc_dst != 0:
        raise RuntimeError(f"pipe rc_src={rc_src} rc_dst={rc_dst} "
                           f"src_err={err_src[:200]} dst_err={err_dst[:200]}")
    return sent


def _read_tail(fh):
    try:
        fh.seek(0)
        return fh.read().decode("utf-8", "replace").strip()
    except Exception:  # noqa: BLE001
        return ""


def q(path):
    return shlex.quote(path)


# --------------------------------------------------------------------------- #
# 清单 / 过滤
# --------------------------------------------------------------------------- #

EXTRA_EXCLUDES = []   # 运行时附加排除（子串匹配），用于反向同步时跳过 .delivery/provenance 等


def is_excluded(rel):
    if any(x and x in rel for x in EXTRA_EXCLUDES):
        return True
    parts = rel.split("/")
    if ".runs" in parts:
        return True
    if rel.startswith(".delivery/claims/"):
        return True
    if rel.startswith(".delivery/provenance/"):
        # 投递台账会整份重写（不是 append-only），单独用 exact pair 按 mtime 同步
        return True
    if "/99_provenance/work/" in "/" + rel:
        # ab_test 实验的 run 工作目录（中间产物，~800MB/128 文件），两边不必一致且拖慢同步
        return True
    name = parts[-1]
    if name.startswith(".") or name.endswith(".tmp"):
        return True
    if name.endswith(".dedup-bak"):
        # 2026-11-07 一次性去重维护留下的备份副本（内容已是当前文件前缀），不要同步
        return True
    if (name.endswith(".lock") or name.endswith(".run-lock")
            or name.startswith(".run-lock") or name.endswith(PART_SUFFIX)):
        return True
    return False


FIND_TMPL = (r"cd {d} && find . -type d \( -name .runs -o -name claims \) -prune "
             r"-o -type f ! -name '.*' ! -name '*.tmp' ! -name '*.lock' -printf '%s\t%P\n'")

# 目录骨架：空目录（如刚建好的新版本测试目录）也要求在目标端存在，只建不删
FIND_DIRS_TMPL = (r"cd {d} && find . -mindepth 1 "
                  r"\( -name '.?*' -o -name .runs -o -name claims \) -prune "
                  r"-o -type d -printf '%P\n'")


def remote_dirs(host, abs_dir):
    """源端子目录相对路径（跳过隐藏目录 / .runs / claims）。"""
    out = run_ssh(host, FIND_DIRS_TMPL.format(d=q(abs_dir)))
    return [ln.strip() for ln in out.splitlines() if ln.strip()]


def ensure_dir_skeleton(src_host, dst_host, src_dir, dst_dir, batch=200):
    """把源端已有子目录在目标端补齐（幂等、只增不删），让空的版本目录也保持一致。"""
    try:
        dirs = remote_dirs(src_host, src_dir)
    except Exception:  # noqa: BLE001
        return 0
    made = 0
    for i in range(0, len(dirs), batch):
        chunk = dirs[i:i + batch]
        cmd = "; ".join(f"mkdir -p {q(os.path.join(dst_dir, rel))}" for rel in chunk)
        try:
            run_ssh(dst_host, cmd, retries=3, timeout=120)
            made += len(chunk)
        except Exception:  # noqa: BLE001
            pass
    return made


def remote_manifest(host, abs_dir):
    out = run_ssh(host, FIND_TMPL.format(d=q(abs_dir)))
    files = {}
    for line in out.splitlines():
        if "\t" not in line:
            continue
        size, rel = line.split("\t", 1)
        rel = rel.strip()
        if not rel or is_excluded(rel):
            continue
        try:
            files[rel] = int(size)
        except ValueError:
            continue
    return files


# --------------------------------------------------------------------------- #
# 前缀校验 / 传输
# --------------------------------------------------------------------------- #

REMOTE_RANGE_MD5 = r'''import hashlib, sys
args = sys.argv[1:]
out = []
for i in range(0, len(args), 3):
    path, start, length = args[i], int(args[i + 1]), int(args[i + 2])
    h = hashlib.md5()
    with open(path, "rb") as fh:
        fh.seek(start)
        left = length
        while left > 0:
            block = fh.read(min(1 << 20, left))
            if not block:
                break
            h.update(block)
            left -= len(block)
    out.append(path + "\t" + h.hexdigest())
print("\n".join(out))
'''


def range_md5(host, items):
    """items: [(abs_path, start, length)] -> {abs_path: md5}"""
    if not items:
        return {}
    args = []
    for path, start, length in items:
        args += [path, str(start), str(length)]
    remote = ("python3 - " + " ".join(q(a) for a in args)
              + " <<'PYEOF'\n" + REMOTE_RANGE_MD5 + "PYEOF")
    out = run_ssh(host, remote)
    result = {}
    for line in out.splitlines():
        if "\t" in line:
            path, digest = line.rsplit("\t", 1)
            result[path] = digest.strip()
    return result


def full_md5(host, abs_paths, workers=6):
    """并行算多个文件的整文件 md5 -> {abs_path: md5}"""
    if not abs_paths:
        return {}
    py = r'''import hashlib, sys
from concurrent.futures import ThreadPoolExecutor

paths = sys.argv[1:]

def one(path):
    h = hashlib.md5()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(4 << 20)
            if not block:
                break
            h.update(block)
    return path + "\t" + h.hexdigest()

with ThreadPoolExecutor(max_workers=%d) as pool:
    for row in pool.map(one, paths):
        print(row)
''' % workers
    remote = ("python3 - " + " ".join(q(p) for p in abs_paths)
              + " <<'PYEOF'\n" + py + "PYEOF")
    out = run_ssh(host, remote, timeout=1800)
    result = {}
    for line in out.splitlines():
        if "\t" in line:
            path, digest = line.rsplit("\t", 1)
            result[path] = digest.strip()
    return result


def remote_size(host, abs_path):
    out = run_ssh(host, f"stat -c %s -- {q(abs_path)} 2>/dev/null || echo -1")
    try:
        return int(out.strip())
    except ValueError:
        return -1


def stat_sizes(host, abs_paths):
    """批量取远端文件大小 -> {abs_path: size}（不存在的文件为 -1）"""
    if not abs_paths:
        return {}
    py = r'''import os, sys
for path in sys.argv[1:]:
    try:
        print(path + "\t" + str(os.path.getsize(path)))
    except OSError:
        print(path + "\t-1")
'''
    remote = ("python3 - " + " ".join(q(p) for p in abs_paths)
              + " <<'PYEOF'\n" + py + "PYEOF")
    out = run_ssh(host, remote)
    result = {}
    for line in out.splitlines():
        if "\t" in line:
            path, size = line.rsplit("\t", 1)
            try:
                result[path] = int(size)
            except ValueError:
                result[path] = -1
    return result


def append_transfer(abs_src, abs_dst, offset):
    """从 target 当前末尾追加传输，直到与源对齐。

    每次重试都重新读两端大小再拼命令——中途失败留下的半截数据不会被重复追加，
    下一轮/下一次尝试从真实末尾继续。
    """
    total = 0
    last = None
    stalls = 0
    for attempt in range(6):
        src_size = remote_size(ULAN_HOST, abs_src)
        if src_size < 0:
            raise FileNotFoundError(f"源文件不存在：{abs_src}")
        cur = remote_size(VA_HOST, abs_dst)
        if cur < 0:
            raise FileNotFoundError(f"目标文件不存在：{abs_dst}")
        if cur > src_size:
            raise RuntimeError(f"目标比源大（dst={cur} src={src_size}），需整传")
        if cur == src_size:
            return total
        start = max(cur, offset if total == 0 else cur)
        src_cmd = (f"tail -c +{start + 1} -- {q(abs_src)} | "
                   f"{ULAN_ZSTD} -{ZSTD_LEVEL} -q -c")
        dst_cmd = f"{VA_ZSTD} -d -q -c >> {q(abs_dst)}"
        try:
            sent = _stream_once(src_cmd, dst_cmd)
            total += sent
            now = remote_size(VA_HOST, abs_dst)
            if now == src_size:
                return total
            last = f"追加后大小不符 dst={now} src={src_size}"
        except StallError as exc:
            stalls += 1
            last = str(exc)
            if stalls >= STALL_ATTEMPTS:
                break
        except Exception as exc:  # noqa: BLE001
            last = str(exc)
        time.sleep(min(2.0 + attempt * 1.5, 8.0))
    raise RuntimeError(f"追加失败：{last}")


def full_transfer(abs_src, abs_dst, mtime=None):
    """整文件传输：先写 .part-sync，再原子 mv 覆盖。mtime 给定时保留源文件修改时间。"""
    parent = os.path.dirname(abs_dst)
    src_cmd = f"{ULAN_ZSTD} -{ZSTD_LEVEL} -q -c -- {q(abs_src)}"
    tail = ""
    if mtime is not None:
        tail = f" && touch -d @{int(mtime)} {q(abs_dst)}"
    dst_cmd = (f"mkdir -p {q(parent)} && {VA_ZSTD} -d -q -c > {q(abs_dst + PART_SUFFIX)}"
               f" && mv -f {q(abs_dst + PART_SUFFIX)} {q(abs_dst)}{tail}")
    return stream_transfer(src_cmd, dst_cmd)


# --------------------------------------------------------------------------- #
# 单个目录对的同步
# --------------------------------------------------------------------------- #

FIND_META_TMPL = (r"cd {d} && find . -type d \( -name .runs -o -name claims \) -prune "
                  r"-o -type f ! -name '.*' ! -name '*.tmp' ! -name '*.lock' -printf '%s\t%T@\t%P\n'")


def remote_manifest_meta(host, abs_dir):
    """带 mtime 的清单：{rel: (size, mtime_float)}"""
    out = run_ssh(host, FIND_META_TMPL.format(d=q(abs_dir)))
    files = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        size_s, mtime_s, rel = parts[0], parts[1], parts[2].strip()
        if not rel or is_excluded(rel):
            continue
        try:
            files[rel] = (int(size_s), float(mtime_s))
        except ValueError:
            continue
    return files


def load_exact_state():
    path = STATE_DIR / "exact_state.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_exact_state(state):
    try:
        (STATE_DIR / "exact_state.json").write_text(
            json.dumps(state, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def sync_exact_pair(task_key, kind, src_dir, dst_dir, dry_run=False):
    """整文件一致模式（聚类树这类会整体重写的产物）：按 (size,mtime) 状态增量整传。"""
    stats = {
        "mode": "exact", "src_dir": src_dir, "dst_dir": dst_dir,
        "new": 0, "appended": 0, "full": 0, "skipped": 0,
        "raw_new_bytes": 0, "raw_append_bytes": 0, "sent_bytes": 0,
        "dst_only": [], "vanished": [], "errors": [], "planned": [],
    }
    src = remote_manifest_meta(ULAN_HOST, src_dir)
    dst = remote_manifest_meta(VA_HOST, dst_dir)
    stats["src_files"] = len(src)
    stats["dst_files"] = len(dst)
    stats["src_bytes"] = sum(v[0] for v in src.values())
    stats["dst_bytes"] = sum(v[0] for v in dst.values())
    stats["dst_only"] = sorted(set(dst) - set(src))

    state_all = load_exact_state()
    key = f"{src_dir} -> {dst_dir}"
    state = dict(state_all.get(key, {}))
    plans = []
    for rel in sorted(src):
        size, mtime = src[rel]
        have = dst.get(rel)
        prev = state.get(rel)
        if have is not None:
            # 两边内容一致（大小 + mtime 相同）直接跳过
            if have[0] == size and abs(float(have[1]) - mtime) < 1e-6:
                stats["skipped"] += 1
                continue
            # 目标端更新 -> 这一侧不覆盖，交给反方向同步
            if float(have[1]) > mtime + 1e-6:
                stats["skipped"] += 1
                stats.setdefault("dst_newer", []).append(rel)
                continue
        unchanged = (prev and int(prev[0]) == size
                     and abs(float(prev[1]) - mtime) < 1e-6
                     and have is not None and have[0] == size)
        if unchanged:
            stats["skipped"] += 1
            continue
        plans.append((rel, size, mtime, "new" if have is None else "update"))
    stats["new"] = sum(1 for p in plans if p[3] == "new")
    stats["full"] = sum(1 for p in plans if p[3] == "update")
    stats["raw_new_bytes"] = sum(p[1] for p in plans)
    stats["planned"] = [{"rel": r, "action": a, "size": sz, "have": 0}
                        for r, sz, _mt, a in plans]

    if dry_run:
        return stats

    total = len(plans)
    for idx, (rel, size, mtime, action) in enumerate(plans, 1):
        abs_src = os.path.join(src_dir, rel)
        abs_dst = os.path.join(dst_dir, rel)
        try:
            sent = full_transfer(abs_src, abs_dst, mtime=mtime)
            stats["sent_bytes"] += sent
            state[rel] = [size, mtime]
            log(f"  [{task_key}/{kind}] 聚类整传({action}) {rel} {size / 1e6:.1f}MB "
                f"(压缩后 {sent / 1e6:.1f}MB) {idx}/{total}")
        except Exception as exc:  # noqa: BLE001
            if remote_size(ULAN_HOST, abs_src) < 0:
                stats["vanished"].append(rel)
                log(f"  [{task_key}/{kind}] 源文件已消失，跳过 {rel}")
            else:
                stats["errors"].append({"rel": rel, "action": action, "error": str(exc)})
                log(f"  [{task_key}/{kind}] 失败 {rel}: {exc}")
    state_all[key] = state
    save_exact_state(state_all)
    return stats


def sync_pair(task_key, kind, src_dir, dst_dir, mode="append", dry_run=False):
    if mode == "exact":
        return sync_exact_pair(task_key, kind, src_dir, dst_dir, dry_run=dry_run)
    return sync_append_pair(task_key, kind, src_dir, dst_dir, dry_run=dry_run)


def sync_append_pair(task_key, kind, src_dir, dst_dir, dry_run=False):
    stats = {
        "src_dir": src_dir, "dst_dir": dst_dir,
        "new": 0, "appended": 0, "full": 0, "skipped": 0,
        "raw_new_bytes": 0, "raw_append_bytes": 0, "sent_bytes": 0,
        "dst_only": [], "vanished": [], "ahead": [], "errors": [],
    }
    if not dry_run:
        ensure_dir_skeleton(ULAN_HOST, VA_HOST, src_dir, dst_dir)
    try:
        src = remote_manifest(ULAN_HOST, src_dir)
    except Exception as exc:  # noqa: BLE001
        if "No such file or directory" in str(exc):
            # 对端目录还没建（如反向同步时弗吉尼亚的 ab_test 尚未产出）：跳过，不算故障
            log(f"  [{task_key}/{kind}] 源目录不存在，跳过（{src_dir}）")
            stats.update({"src_files": 0, "dst_files": 0,
                          "src_bytes": 0, "dst_bytes": 0})
            return stats
        raise
    dst = remote_manifest(VA_HOST, dst_dir)
    stats["src_files"] = len(src)
    stats["dst_files"] = len(dst)
    stats["src_bytes"] = sum(src.values())
    stats["dst_bytes"] = sum(dst.values())

    stats["dst_only"] = sorted(set(dst) - set(src))

    plans = []       # (rel, action, src_size, dst_size)
    check_items = []  # (rel, dst_size)
    for rel in sorted(src):
        size = src[rel]
        have = dst.get(rel)
        if have is not None and have == size:
            stats["skipped"] += 1
        elif have is None:
            plans.append((rel, "full", size, 0))
        elif have > size:
            # 目标比源大：目标端可能更新（双向写入场景），不覆盖，交人工/下轮判断
            stats["ahead"].append({"rel": rel, "src_size": size, "dst_size": have})
            stats["skipped"] += 1
        else:
            plans.append((rel, "append?", size, have))
            check_items.append((rel, have))

    # 前缀校验：确认目标文件是源文件的前缀，才允许尾部追加
    overlap_ok = set()
    if check_items:
        src_paths = {rel: os.path.join(src_dir, rel) for rel, _ in check_items}
        dst_paths = {rel: os.path.join(dst_dir, rel) for rel, _ in check_items}
        src_ranges, dst_ranges = [], []
        for rel, have in check_items:
            start = max(0, have - PREFIX_CHECK_BYTES)
            length = have - start
            src_ranges.append((src_paths[rel], start, length))
            dst_ranges.append((dst_paths[rel], start, length))
        src_md5 = range_md5(ULAN_HOST, src_ranges)
        dst_md5 = range_md5(VA_HOST, dst_ranges)
        for rel, _ in check_items:
            if src_md5.get(src_paths[rel]) and src_md5.get(src_paths[rel]) == dst_md5.get(dst_paths[rel]):
                overlap_ok.add(rel)

    final_plans = []
    for rel, action, size, have in plans:
        if action == "append?":
            action = "append" if rel in overlap_ok else "full"
        if action == "append":
            stats["appended"] += 1
            stats["raw_append_bytes"] += size - have
        else:
            stats["full"] += 1
            if have == 0:
                stats["new"] += 1
                stats["raw_new_bytes"] += size
        final_plans.append((rel, action, size, have))
    stats["planned"] = [{"rel": r, "action": a, "size": s, "have": h} for r, a, s, h in final_plans]

    if dry_run:
        return stats

    total = len(final_plans)
    for idx, (rel, action, size, have) in enumerate(final_plans, 1):
        abs_src = os.path.join(src_dir, rel)
        abs_dst = os.path.join(dst_dir, rel)
        try:
            if action == "append":
                sent = append_transfer(abs_src, abs_dst, have)
                stats["sent_bytes"] += sent
                if size - have >= 1 << 20:
                    log(f"  [{task_key}/{kind}] 追加 {rel} +{(size - have) / 1e6:.1f}MB "
                        f"(压缩后 {sent / 1e6:.1f}MB) {idx}/{total}")
            else:
                sent = full_transfer(abs_src, abs_dst)
                stats["sent_bytes"] += sent
                log(f"  [{task_key}/{kind}] 整传 {rel} {size / 1e6:.1f}MB "
                    f"(压缩后 {sent / 1e6:.1f}MB) {idx}/{total}")
        except Exception as exc:  # noqa: BLE001
            # 源文件在清单与传输之间被清理/改名（运行现场常见）不算错误
            if remote_size(ULAN_HOST, abs_src) < 0:
                stats["vanished"].append(rel)
                log(f"  [{task_key}/{kind}] 源文件已消失，跳过 {rel}")
            else:
                stats["errors"].append({"rel": rel, "action": action, "error": str(exc)})
                log(f"  [{task_key}/{kind}] 失败 {rel}: {exc}")
    return stats


# --------------------------------------------------------------------------- #
# 进度 / 状态信息
# --------------------------------------------------------------------------- #

def lost_run_meta():
    state_glob = f"{TASKS['lost']['run_state']}"
    py = r'''import collections, glob, json, os
dirs = sorted(glob.glob(%s + "/*/state.json"), key=os.path.getmtime, reverse=True)
if not dirs:
    print(json.dumps({"error": "no state.json"}))
else:
    p = dirs[0]
    try:
        d = json.load(open(p))
    except Exception as exc:
        print(json.dumps({"error": "parse: %%s" %% exc, "path": p}))
    else:
        m = d.get("manifest", {}) or {}
        tasks = d.get("tasks", {}) or {}
        counts = collections.Counter((t.get("state") or {}).get("status") for t in tasks.values())
        print(json.dumps({
            "path": p,
            "run": m.get("runId"),
            "status": m.get("status"),
            "started_ms": m.get("startedAt"),
            "finished_ms": m.get("finishedAt"),
            "tasks": dict(counts),
            "attempts": d.get("recordedAttempts"),
        }, ensure_ascii=False))
''' % json.dumps(state_glob)
    remote = "python3 - <<'PYEOF'\n" + py + "\nPYEOF"
    try:
        out = run_ssh(ULAN_HOST, remote, timeout=120)
        return json.loads(out.strip().splitlines()[-1])
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


def daily_status_meta():
    py = r'''import json
paths = %s
out = {}
for model, path in paths.items():
    try:
        d = json.load(open(path))
    except Exception as exc:
        out[model] = {"error": str(exc)}
        continue
    files = d.get("files", {}) or {}
    counts = {}
    latest = None
    for name, info in files.items():
        st = (info or {}).get("status")
        counts[st] = counts.get(st, 0) + 1
        upd = (info or {}).get("updated_at")
        if upd and (latest is None or upd > latest):
            latest = upd
    out[model] = {"files": len(files), "status_counts": counts, "latest_update": latest}
print(json.dumps(out, ensure_ascii=False))
''' % json.dumps({m: p for m, p in TASKS["daily"]["status_files"].items()})
    remote = "python3 - <<'PYEOF'\n" + py + "\nPYEOF"
    try:
        out = run_ssh(ULAN_HOST, remote, timeout=120)
        return json.loads(out.strip().splitlines()[-1])
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


# --------------------------------------------------------------------------- #
# 对账
# --------------------------------------------------------------------------- #

def verify_pair(task_key, kind, src_dir, dst_dir, scope, exchanged):
    """scope: 'synced' | 'all'；返回 {checked, pending, missing, problems}

    注意：源文件仍在追加写，源/目标大小会在读取瞬间不同；目标更短且是源的前缀
    时归为 pending（下一轮自动补齐），不算问题。
    """
    src = remote_manifest(ULAN_HOST, src_dir)
    dst = remote_manifest(VA_HOST, dst_dir)
    rels = set(src) & set(dst)
    if scope == "synced":
        rels &= exchanged
    size_diff = [rel for rel in sorted(rels) if src[rel] != dst[rel]]
    problems = []
    pending = []
    grow = [rel for rel in size_diff if dst[rel] < src[rel]]
    if grow:
        src_ranges = [(os.path.join(src_dir, rel), max(0, dst[rel] - PREFIX_CHECK_BYTES),
                       min(dst[rel], PREFIX_CHECK_BYTES)) for rel in grow]
        dst_ranges = [(os.path.join(dst_dir, rel), max(0, dst[rel] - PREFIX_CHECK_BYTES),
                       min(dst[rel], PREFIX_CHECK_BYTES)) for rel in grow]
        src_md5 = range_md5(ULAN_HOST, src_ranges)
        dst_md5 = range_md5(VA_HOST, dst_ranges)
        for rel, (sp, _, _), (dp, _, _) in zip(grow, src_ranges, dst_ranges):
            if dst[rel] > 0 and src_md5.get(sp) == dst_md5.get(dp):
                pending.append({"rel": rel, "src_size": src[rel], "dst_size": dst[rel],
                                "kind": "pending_append"})
            else:
                problems.append({"rel": rel, "src_size": src[rel],
                                 "dst_size": dst[rel], "kind": "size"})
    for rel in size_diff:
        if rel not in grow and rel not in {p["rel"] for p in problems}:
            problems.append({"rel": rel, "src_size": src[rel],
                             "dst_size": dst[rel], "kind": "size"})
    missing = sorted(set(src) - set(dst))
    if scope == "all":
        for rel in missing:
            problems.append({"rel": rel, "kind": "missing"})
    check = [rel for rel in sorted(rels) if src[rel] == dst[rel]]
    mismatches = []
    if check:
        src_paths = [os.path.join(src_dir, rel) for rel in check]
        dst_paths = [os.path.join(dst_dir, rel) for rel in check]
        src_md5 = full_md5(ULAN_HOST, src_paths)
        dst_md5 = full_md5(VA_HOST, dst_paths)
        md5_bad = [(rel, sp, dp) for rel, sp, dp in zip(check, src_paths, dst_paths)
                   if src_md5.get(sp) != dst_md5.get(dp)]
        if md5_bad:
            # 源文件在读取瞬间还在追加时会假阳性：复核当前大小，源更长则算待补
            src_now = stat_sizes(ULAN_HOST, [sp for _, sp, _ in md5_bad])
            dst_now = stat_sizes(VA_HOST, [dp for _, _, dp in md5_bad])
            for rel, sp, dp in md5_bad:
                if src_now.get(sp, 0) > dst_now.get(dp, 0):
                    pending.append({"rel": rel, "src_size": src_now.get(sp),
                                    "dst_size": dst_now.get(dp), "kind": "pending_append"})
                else:
                    mismatches.append({"rel": rel, "kind": "md5",
                                       "src_md5": src_md5.get(sp),
                                       "dst_md5": dst_md5.get(dp)})
    return {"checked": len(check), "pending": pending, "missing": missing,
            "problems": problems + mismatches}


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #

def active_pairs():
    """按方向产出 (task_key, kind, src_dir, dst_dir, mode)。reverse = 弗吉尼亚 -> 乌兰。"""
    for task_key, task in TASKS.items():
        for kind, src_dir, dst_dir, mode in task["pairs"]:
            if DIRECTION == "reverse":
                yield task_key, kind, dst_dir, src_dir, mode
            else:
                yield task_key, kind, src_dir, dst_dir, mode


def apply_direction(direction):
    """切换方向：reverse 时把「源」指向弗吉尼亚、「目标」指向乌兰。"""
    global DIRECTION, ULAN_HOST, VA_HOST, ULAN_ZSTD, VA_ZSTD
    DIRECTION = direction
    if direction == "reverse":
        ULAN_HOST, VA_HOST = "aime_rsi_data", "eval_data"
        ULAN_ZSTD, VA_ZSTD = "zstd", "/root/miniforge3/bin/zstd"


def preflight():
    """通道自检：两端可达、zstd 可用、目标目录可写；失败则本轮直接报错退出。"""
    problems = []
    for host, zstd in ((ULAN_HOST, ULAN_ZSTD), (VA_HOST, VA_ZSTD)):
        try:
            out = run_ssh(host, f"command -v {q(zstd)} || echo MISSING", retries=8, timeout=45)
            if "MISSING" in out:
                # 容器重建后 zstd 可能缺失：尝试自动装一次（仅 Ubuntu 系 apt 可用时）
                log(f"  {host}: 缺 zstd({zstd})，尝试 apt-get install zstd …")
                try:
                    run_ssh(host, "DEBIAN_FRONTEND=noninteractive timeout 180 apt-get install -y zstd",
                            retries=2, timeout=240)
                except Exception:  # noqa: BLE001
                    pass
                out = run_ssh(host, f"command -v {q(zstd)} || echo MISSING", retries=2, timeout=30)
            if "MISSING" in out:
                problems.append(f"{host}: 找不到 zstd({zstd})，且自动安装失败")
        except Exception as exc:  # noqa: BLE001
            problems.append(f"{host}: 不可达（{exc}）")
    try:
        dirs = [pair[3] for pair in active_pairs()]
        out = run_ssh(VA_HOST, "; ".join(
            f"mkdir -p {q(d)} && test -w {q(d)} && echo WRITABLE" for d in dirs),
            retries=8, timeout=90)
        if out.count("WRITABLE") < len(dirs):
            problems.append(f"目标目录不可写：{out.strip()[:200]}")
    except Exception as exc:  # noqa: BLE001
        problems.append(f"目标目录检查失败（{exc}）")
    if problems:
        raise RuntimeError("通道自检失败：" + "；".join(problems))


def acquire_lock():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    lock = STATE_DIR / "lock"
    if lock.exists():
        try:
            pid = int(lock.read_text().strip())
            os.kill(pid, 0)
            return None  # 已有同步在跑
        except (ValueError, ProcessLookupError, PermissionError):
            pass
    lock.write_text(str(os.getpid()))
    return lock


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="只打印同步计划，不做任何传输")
    parser.add_argument("--only", choices=["lost", "lost_archive", "daily", "ab_test", "all"], default="all")
    parser.add_argument("--verify", choices=["none", "synced", "all"], default="none",
                        help="对账范围：不校验 / 只校验本轮传过的 / 校验全部")
    parser.add_argument("--no-meta", action="store_true", help="跳过评测进度读取")
    parser.add_argument("--direction", choices=["forward", "reverse"], default="forward",
                        help="forward=乌兰->弗吉尼亚（默认）；reverse=弗吉尼亚->乌兰")
    parser.add_argument("--skip", default="",
                        help="逗号分隔的 task/kind，例如 daily/cluster")
    parser.add_argument("--exclude", default="",
                        help="逗号分隔的路径子串，运行时跳过，例如 .delivery/provenance")
    args = parser.parse_args()
    apply_direction(args.direction)
    global EXTRA_EXCLUDES
    EXTRA_EXCLUDES = [x.strip() for x in args.exclude.split(",") if x.strip()]
    skip_pairs = {x.strip() for x in args.skip.split(",") if x.strip()}

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    log_path = STATE_DIR / "sync.log"

    def logfile(msg):
        log(msg)
        try:
            with open(log_path, "a", encoding="utf-8") as fh:
                fh.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
        except OSError:
            pass

    lock = acquire_lock()
    if lock is None:
        logfile("上一轮同步还在跑，本轮跳过")
        return 0

    started = time.time()
    result = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "direction": DIRECTION,
              "dry_run": args.dry_run,
              "duration_s": 0, "tasks": {}, "meta": {}, "verify": {},
              "errors": []}
    try:
        preflight()
        selected = [p for p in active_pairs()
                    if (args.only == "all" or p[0] == args.only)
                    and f"{p[0]}/{p[1]}" not in skip_pairs]
        if skip_pairs:
            logfile(f"跳过：{', '.join(sorted(skip_pairs))}")
        seen_task = set()
        for task_key, kind, src_dir, dst_dir, mode in selected:
            task = TASKS[task_key]
            if task_key not in seen_task:
                logfile(f"== {task['label']} ==")
                seen_task.add(task_key)
                result["tasks"][task_key] = {}
            logfile(f"-- {task_key}/{kind}({mode}): {src_dir} -> {dst_dir}")
            stats = sync_pair(task_key, kind, src_dir, dst_dir, mode,
                              dry_run=args.dry_run)
            result["tasks"][task_key][kind] = stats
            nothing = not (stats["new"] or stats["appended"] or stats["full"]
                           or stats.get("ahead"))
            if mode == "exact":
                if nothing:
                    logfile(f"  已同步：{stats['src_files']} 文件 / "
                            f"{stats['src_bytes'] / 1e9:.2f} GB，无变化")
                else:
                    logfile(f"  聚类树同步：新增 {stats['new']}、更新 {stats['full']}、"
                            f"跳过 {stats['skipped']}；上传 {stats['sent_bytes'] / 1e6:.1f}MB")
            elif nothing:
                logfile(f"  已同步：{stats['src_files']} 文件 / "
                        f"{stats['src_bytes'] / 1e9:.2f} GB，无增量")
            else:
                logfile(f"  同步：新增 {stats['new']}、追尾 {stats['appended']}、"
                        f"整传 {stats['full']}、跳过 {stats['skipped']}；"
                        f"新增 {stats['raw_new_bytes'] / 1e6:.1f}MB + "
                        f"尾部 {stats['raw_append_bytes'] / 1e6:.1f}MB "
                        f"-> 上传 {stats['sent_bytes'] / 1e6:.1f}MB")
            if stats.get("ahead"):
                names = ", ".join(f"{a['rel']}(源{a['src_size']}<目标{a['dst_size']})"
                                  for a in stats["ahead"][:5])
                logfile(f"  ⚠ 目标端更大、未覆盖：{names}")
            if stats["vanished"]:
                logfile(f"  运行现场文件消失（跳过）：{', '.join(stats['vanished'][:5])}")
            if stats["dst_only"]:
                logfile(f"  目标端多出（不删除）：{', '.join(stats['dst_only'][:10])}")
            for err in stats["errors"]:
                result["errors"].append({"task": task_key, "kind": kind, **err})

        if not args.dry_run:
            if not args.no_meta and DIRECTION == "forward":
                logfile("-- 读取评测进度 --")
                result["meta"]["lost"] = lost_run_meta()
                result["meta"]["daily"] = daily_status_meta()

            if args.verify != "none":
                logfile(f"-- 对账（{args.verify}）--")
                for task_key in dict.fromkeys(p[0] for p in selected):
                    result["verify"][task_key] = {}
                    for tk, kind, src_dir, dst_dir, mode in selected:
                        if tk != task_key:
                            continue
                        if args.verify == "synced":
                            exchanged = {p["rel"] for p in result["tasks"][task_key][kind]["planned"]
                                         if p["action"] != "skip"}
                        else:
                            exchanged = set()
                        rep = verify_pair(task_key, kind, src_dir, dst_dir,
                                          args.verify, exchanged)
                        result["verify"][task_key][kind] = rep
                        logfile(f"  对账 {task_key}/{kind}: 校验 {rep['checked']} 文件，"
                                f"待补 {len(rep['pending'])}，"
                                f"问题 {len(rep['problems']) + len(rep['missing'])}")
    except Exception as exc:  # noqa: BLE001
        result["errors"].append({"fatal": str(exc)})
        logfile(f"FATAL: {exc}")
    finally:
        result["duration_s"] = round(time.time() - started, 1)
        try:
            (STATE_DIR / "last_round.json").write_text(
                json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            with open(STATE_DIR / "history.jsonl", "a", encoding="utf-8") as fh:
                fh.write(json.dumps(result, ensure_ascii=False) + "\n")
        except OSError:
            pass
        if lock.exists():
            lock.unlink()
        logfile(f"本轮结束：{result['duration_s']}s，错误 {len(result['errors'])} 条")

    return 0 if not result["errors"] else 1


if __name__ == "__main__":
    sys.exit(main())
