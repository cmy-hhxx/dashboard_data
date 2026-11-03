#!/usr/bin/env bash
#
# pack_aime_io.sh — AIME 评测输入 + 输出一键打成单个 tar.zst（常规打包口径）
#
# 用法（脚本在远端 eval_data 上执行，见 docs/aime-input-packaging.md）:
#   scp scripts/pack_aime_io.sh eval_data:/tmp/
#   ssh eval_data 'chmod +x /tmp/pack_aime_io.sh && /tmp/pack_aime_io.sh'
#   ./pack_aime_io.sh                                  # 默认 eval_input + eval_output
#   ./pack_aime_io.sh eval_output                      # 只打输出
#   LEVEL=15 ./pack_aime_io.sh --tag small             # 更小的产物，耗时略长
#   VERIFY=0 ./pack_aime_io.sh                         # 跳过解压对账（省 ~20s）
#   OUT_FILE=/tmp/x.tar.zst ./pack_aime_io.sh          # 演练
#
# 为什么不是一条 tar | zstd 管道（老 pack_aime_input.sh 的做法）:
#   源在 ceph-fuse 上，单流顺序读实测只有 ~20MB/s，13GB 会卡在读取上约 11 分钟。
#   这里先用 PAR 路并行把文件读到本地快盘（ceph 多流聚合实测 ~130MB/s），
#   再用单流 tar + 多线程 zstd 压（实测 ~320MB/s）。产物仍是标准单流 tar.zst，
#   解压用普通 `zstd -dc x.tar.zst | tar -xf -` 即可，全流程约 2.5-3 分钟。
#
# 设计要点:
#   * 排除 .archive（历史运行现场）与 .runs/.delivery（流水线实时写入的运行现场）:
#     业务输入/输出都在 eval_input / eval_output 下的 jsonl 里，这两类是运行现场，
#     且正在被写入会拖慢读取、也无法得到一致的快照
#   * 实时目录按快照语义处理：搬完先对账，个别文件在搬运期间被改写则重搬，最终包里
#     是当时读到的一致快照；打包后再校验包内条目 / 解压后字节数
#   * 先把文件搬到本地暂存再压，ceph 只写最终压缩产物，不做写放大
#   * 产物先写 .part，完成后 rename，失败不留半成品

set -Eeuo pipefail
export PATH=/root/miniforge3/bin:$PATH   # zstd 装在 miniforge 里，非交互 ssh 的 PATH 里没有

SRC_BASE=${SRC_BASE:-/mnt/fin_bench/code_and_clean_data/datasets/1_aime}
DST_DIR=${DST_DIR:-/mnt/fin_bench/aime_data}
LEVEL=${LEVEL:-12}
THREADS=${THREADS:-$(nproc 2>/dev/null || echo 8)}
PAR=${PAR:-8}            # ceph 并行读流数；单流 ~20MB/s，8 流 ~130MB/s
STAGE=${STAGE:-/tmp/aime_stage}
VERIFY=${VERIFY:-1}
EXCLUDE=${EXCLUDE:-.archive,.runs,.delivery}
export EXCLUDE
TAG=""
DIRS=()

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
now() { date +%s; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --level)     LEVEL=$2; shift 2 ;;
    --threads)   THREADS=$2; shift 2 ;;
    --par)       PAR=$2; shift 2 ;;
    --tag)       TAG=$2; shift 2 ;;
    --no-verify) VERIFY=0; shift ;;
    -h|--help)   sed -n '2,30p' "$0"; exit 0 ;;
    -*)          die "未知参数 $1（--help 查看用法）" ;;
    *)           DIRS+=("$1"); shift ;;
  esac
done
[[ ${#DIRS[@]} -gt 0 ]] || DIRS=(eval_input eval_output)
[[ $STAGE == /tmp/* ]] || die "STAGE 必须在 /tmp 下: $STAGE"

for bin in tar zstd python3; do
  command -v "$bin" >/dev/null || die "缺少 $bin"
done

cd "$SRC_BASE" || die "源目录不存在: $SRC_BASE"
for d in "${DIRS[@]}"; do [[ -d $d ]] || die "源目录不存在: $SRC_BASE/$d"; done

STAMP=${TAG:-$(date +%Y%m%d)}
OUT_FILE=${OUT_FILE:-$DST_DIR/aime_input_output_${STAMP}.tar.zst}
[[ -e $OUT_FILE ]] && die "目标已存在，未覆盖: $OUT_FILE"
mkdir -p "$DST_DIR"
rm -rf "$STAGE"; mkdir -p "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

say "源   ${DIRS[*]}  (${SRC_BASE})"
say "目标 ${OUT_FILE}"
say "参数 level=${LEVEL} threads=${THREADS} par=${PAR} window=128MB 排除=${EXCLUDE}"

# --- 1) 清单 + PAR 路并行搬运到本地暂存 + 对账（python 只做这两件事） ---
T0=$(now)
read -r SRC_N SRC_B ST_N ST_B < <(python3 - "$SRC_BASE" "$STAGE" "$PAR" "${DIRS[@]}" <<'PY'
import os, shutil, sys
from concurrent.futures import ThreadPoolExecutor

src_base, stage, par = sys.argv[1], sys.argv[2], int(sys.argv[3])
dirs = sys.argv[4:]
excl = set(filter(None, os.environ.get("EXCLUDE", ".archive,.runs,.delivery").split(",")))


def walk():
    want = {}
    for top in dirs:
        for root, subdirs, files in os.walk(os.path.join(src_base, top)):
            subdirs[:] = [d for d in subdirs if d not in excl]
            for f in files:
                p = os.path.join(root, f)
                want[os.path.relpath(p, src_base)] = os.lstat(p).st_size
    return want


def copy_one(item):
    size, rel = item
    src, dst = os.path.join(src_base, rel), os.path.join(stage, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)      # 单文件单流；PAR 路并行 = ceph 聚合带宽

def stage_totals():
    n = b = 0
    for root, _, files in os.walk(stage):
        for f in files:
            n += 1; b += os.lstat(os.path.join(root, f)).st_size
    return n, b

want = walk()
if not want:
    sys.exit("源为空")
need = sum(want.values())
free = shutil.disk_usage(stage).free
if free < need * 1.1:
    sys.exit(f"本地暂存空间不足: need {need/2**30:.1f} GiB, free {free/2**30:.1f} GiB")

for rnd in range(1, 4):
    have = {}
    if os.path.isdir(stage):
        for root, _, files in os.walk(stage):
            for f in files:
                p = os.path.join(root, f)
                have[os.path.relpath(p, stage)] = os.lstat(p).st_size
    todo = sorted(((s, r) for r, s in want.items() if have.get(r) != s), reverse=True)
    if not todo:
        break
    print(f"[stage] round {rnd}: {len(todo)} files / {sum(s for s, _ in todo)/2**30:.2f} GiB",
          file=sys.stderr, flush=True)
    with ThreadPoolExecutor(max_workers=par) as ex:
        list(ex.map(copy_one, todo))

n, b = stage_totals()
if n != len(want) or b != need:
    print(f"[stage] 未收敛: stage {n}/{b} vs source {len(want)}/{need}（实时目录仍在写，按快照接受）",
          file=sys.stderr)
print(len(want), need, n, b)
PY
)
[[ ${SRC_N:-0} -gt 0 ]] || die "清单为空"
say "待打包 ${SRC_N} 个文件 / ${SRC_B} B（$(python3 -c "print(f'{$SRC_B/2**30:.2f} GiB')")）"
[[ $ST_N -eq $SRC_N && $ST_B -eq $SRC_B ]] \
  || say "注意: 源在搬运期间变化，包内为暂存快照 ${ST_N} 文件 / ${ST_B} B"
say "搬运完成 $(($(now)-T0))s"

# --- 2) 单流 tar | 多线程 zstd（--long=27 = 128MB 窗口，跨文件共享字典） ---
T1=$(now)
cd "$STAGE"
mkdir -p "$(dirname "$OUT_FILE")"
tar -cf - -b 512 --warning=no-file-changed \
    --exclude=.archive --exclude=.runs --exclude=.delivery "${DIRS[@]}" |
  zstd -"$LEVEL" --long=27 -T"$THREADS" -q -f -o "$OUT_FILE.part"
TAR_RC=${PIPESTATUS[0]}
[[ -s $OUT_FILE.part ]] || die "压缩产物为空 (tar rc=$TAR_RC)"
[[ $TAR_RC -eq 0 ]] || say "注意: tar 返回 $TAR_RC（实时目录被改写，按快照接受）"
PACKED=$(stat -c%s "$OUT_FILE.part")
say "压缩完成 $(($(now)-T1))s  ${PACKED} B"

# --- 3) 校验：zstd 帧 + 包内条目数/字节数对账 ---
if [[ $VERIFY -eq 1 ]]; then
  T2=$(now)
  zstd -t "$OUT_FILE.part" >/dev/null 2>&1 || die "zstd 完整性校验失败"
  read -r PK_N PK_B < <(python3 - "$OUT_FILE.part" <<'PY'
import subprocess, sys
n = tot = 0
z = subprocess.Popen(["zstd", "-dc", "--long=27", sys.argv[1]], stdout=subprocess.PIPE)
t = subprocess.Popen(["tar", "-tvf", "-"], stdin=z.stdout, stdout=subprocess.PIPE, text=True)
for line in t.stdout:
    if line[:1] in ("d", "l", "h"):
        continue
    n += 1; tot += int(line.split()[2])
z.stdout.close(); t.wait(); z.wait()
print(n, tot)
PY
)
  [[ $PK_N -eq $ST_N && $PK_B -eq $ST_B ]] \
    || die "包内校验失败: files $PK_N/$ST_N bytes $PK_B/$ST_B"
  say "校验通过 ${PK_N} 文件 / ${PK_B} B  用时 $(($(now)-T2))s"
fi

mv -f "$OUT_FILE.part" "$OUT_FILE"
ELAPSED=$(($(now)-T0))
python3 -c "
r=$ST_B; p=$PACKED; t=$ELAPSED
print(f'DONE {p} B / {r} B  {p/r*100:.2f}%  {r/p:.2f}x  总耗时 {t}s  {r/t/1e6:.0f} MB/s')"
say "产物: $OUT_FILE"
