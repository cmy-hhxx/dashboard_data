#!/usr/bin/env bash
# Precompress static assets once at deploy time; server.py serves the .br
# variant when the client accepts brotli, else the .gz variant.  The JSON payloads
# are not touched here: build.py writes their .gz/.br twins atomically and deploy
# no longer deletes them.
set -euo pipefail
cd "$(dirname "$0")/static"
find . -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' \) \
  ! -name '*.gz' ! -name '*.br' -print0 | while IFS= read -r -d '' file; do
  gzip -9 -k -f "$file"
done
# Brotli is typically 20-25% smaller than gzip; only compress when the optional
# module is installed (deploy.sh installs it best-effort).
if python3 -c 'import brotli' 2>/dev/null; then
  python3 - <<'PY'
import pathlib
import brotli

for path in pathlib.Path('.').rglob('*'):
    if not path.is_file():
        continue
    if path.suffix in ('.js', '.css', '.html', '.svg'):
        path.with_name(path.name + '.br').write_bytes(brotli.compress(path.read_bytes(), quality=9))
PY
fi
echo "precompressed static assets"
