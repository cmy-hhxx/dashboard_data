#!/usr/bin/env bash
#
# pack_aime_input.sh — 把 AIME 评测输入目录流式打包成单个 tar.zst
#
# 用法（脚本在远端 eval_data 上执行，见 docs/aime-input-packaging.md）:
#   ./pack_aime_input.sh                                  # 默认 -12 / nproc 线程（10.3GB≈47s）
#   LEVEL=19 ./pack_aime_input.sh --tag max               # 极致压缩档（10.3GB≈392s）
#   ./pack_aime_input.sh --tag 1019 1_lost_user_eval/.archive
#   OUT_FILE=/tmp/x.tar.zst ./pack_aime_input.sh                 # 演练
#
# 设计要点:
#   * tar | zstd 单流管道，不落中间文件；ceph 只写压缩后的字节
#   * 输出先写 .part，完成后 rename，失败不留半成品
#   * --long=27（128MB 窗口）让跨文件重复内容共享字典：同级别体积 -16%，速度不变
#   * 实时目录里被改写的文件会让 tar 返回 1，这里按快照语义接受并继续产出

set -Eeuo pipefail

SRC_BASE=${SRC_BASE:-/mnt/fin_bench/eval_data/1_aime/2_eval_input}
DST_DIR=${DST_DIR:-/mnt/fin_bench/aime_data}
LEVEL=${LEVEL:-12}
THREADS=${THREADS:-$(nproc 2>/dev/null || echo 8)}
TAG=""
DIRS=()

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --level)      LEVEL=$2; shift 2 ;;
    --threads)    THREADS=$2; shift 2 ;;
    --tag)        TAG=$2; shift 2 ;;
    -h|--help)    sed -n '2,20p' "$0"; exit 0 ;;
    -*)           die "未知参数 $1（--help 查看用法）" ;;
    *)            DIRS+=("$1"); shift ;;
  esac
done
[[ ${#DIRS[@]} -gt 0 ]] || DIRS=(1_lost_user_eval/.archive 0_daily_eval_input)

for bin in tar zstd find; do
  command -v "$bin" >/dev/null || die "缺少 $bin"
done

cd "$SRC_BASE" || die "源目录不存在: $SRC_BASE"
for d in "${DIRS[@]}"; do [[ -d $d ]] || die "源目录不存在: $SRC_BASE/$d"; done
mkdir -p "$DST_DIR"

STAMP=${TAG:-$(date +%Y%m%d)}
OUT_FILE=${OUT_FILE:-$DST_DIR/aime_input_${STAMP}.tar.zst}
[[ -e $OUT_FILE ]] && die "目标已存在，未覆盖: $OUT_FILE"
PART=$OUT_FILE.part
ERRLOG=$(mktemp -t pack_err.XXXXXX)
trap 'rm -f "$ERRLOG"' EXIT

say "源   ${DIRS[*]}  (${SRC_BASE})"
say "目标 ${OUT_FILE}"
say "参数 level=${LEVEL} threads=${THREADS} window=128MB"

RAW=$(find "${DIRS[@]}" -type f -printf '%s\n' | awk '{s+=$1} END {printf "%.0f", s+0}')
NFILES=$(find "${DIRS[@]}" -type f | wc -l | tr -d ' ')
say "待打包 ${NFILES} 个文件 / $(awk -v b="$RAW" 'BEGIN{printf "%.2f", b/1073741824}') GiB"

START=$(date +%s)
set +e
tar -cf - -b 512 --warning=no-file-changed "${DIRS[@]}" 2>"$ERRLOG" |
  zstd -"$LEVEL" --long=27 -T"$THREADS" -q -f -o "$PART"
TAR_RC=${PIPESTATUS[0]}
set -e
ELAPSED=$(( $(date +%s) - START ))

[[ -s $PART ]] || die "压缩产物为空 (tar rc=$TAR_RC)"
if [[ $TAR_RC -ne 0 ]]; then
  say "注意: tar 返回 $TAR_RC（多半是实时目录里文件被改写，按快照接受）"
  sed -n '1,5p' "$ERRLOG" >&2
fi

mv -f "$PART" "$OUT_FILE"
PACKED=$(stat -c%s "$OUT_FILE")

RATIO=$(awk -v r="$RAW" -v p="$PACKED" -v t="$ELAPSED" \
  'BEGIN{printf "%.2f%% (%.2fx)  %.0f MB/s", p/r*100, r/p, (t>0 ? r/t/1e6 : 0)}')
say "完成  ${RATIO}  ${PACKED} B / ${RAW} B  用时 ${ELAPSED}s"
