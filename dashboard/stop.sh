#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd -P)"

terminate() {
  local pid="$1"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
}

if [ -f server.pid ]; then
  terminate "$(cat server.pid)"
  rm -f server.pid
fi

# A previous stop could leave an orphan behind after its pid file was removed;
# clean up any dashboard server.py / build.py whose cwd is this deployment directory.
# build.py is a child of server.py: killing only the server leaves the build running, and two
# builds then collide on cache/build.sqlite3 ("database is locked") and on payload writes.
# argv[0] can be "python3" or an absolute "/usr/local/bin/python3": match its basename.
for script in server.py build.py; do
  for pid in $(ps -eo pid=,args= | awk -v s="$script" '{a=$2; b=$3; sub(/.*\//,"",a); sub(/.*\//,"",b); if (a=="python3" && b==s) print $1}'); do
    [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)" = "$HERE" ] && terminate "$pid"
  done
done

if [ -f stats.pid ]; then
  terminate "$(cat stats.pid)"
  rm -f stats.pid
fi
for pid in $(ps -eo pid=,args= | awk '{a=$2; b=$3; sub(/.*\//,"",a); sub(/.*\//,"",b); if (a=="python3" && b=="stats_worker.py") print $1}'); do
  [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)" = "$HERE" ] && terminate "$pid"
done

echo stopped
