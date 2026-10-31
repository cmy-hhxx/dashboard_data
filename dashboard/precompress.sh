#!/usr/bin/env bash
# Precompress static assets once at deploy time; server.py serves the .gz
# variant when the client accepts gzip.
set -euo pipefail
cd "$(dirname "$0")/static"
find . -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' \) \
  ! -name '*.gz' -print0 | while IFS= read -r -d '' file; do
  gzip -9 -k -f "$file"
done
echo "precompressed static assets"
