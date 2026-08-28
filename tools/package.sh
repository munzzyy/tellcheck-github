#!/bin/bash
# Package the extension for AMO submission: dist/slopscreen-<version>.zip
# Runs web-ext lint first when available (npx --no-install web-ext).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
mkdir -p dist

if npx --no-install web-ext --version >/dev/null 2>&1; then
  echo "== web-ext lint =="
  npx --no-install web-ext lint --source-dir extension || true
else
  echo "(web-ext not installed, skipping lint)"
fi

OUT="dist/slopscreen-${VERSION}.zip"
rm -f "$OUT"
python3 - "$OUT" <<'PY'
import pathlib, sys, zipfile
out = pathlib.Path(sys.argv[1])
root = pathlib.Path("extension")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for p in sorted(root.rglob("*")):
        if p.is_file() and ".DS_Store" not in p.name:
            z.write(p, p.relative_to(root))
print(f"built {out}  ({out.stat().st_size//1024} KB, {len(z.namelist())} files)")
PY
