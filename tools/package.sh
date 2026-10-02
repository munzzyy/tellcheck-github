#!/bin/bash
# Package the extension for AMO submission: dist/tellcheck-github-<version>.zip
# Lints first with web-ext (npm install for the dev dependency) and builds
# nothing when the lint fails or web-ext is missing.
set -euo pipefail
cd "$(dirname "$0")/.."

# A regex, not a JSON parse, so a broken manifest still clears its old zip before the lint fails.
VERSION=$(python3 - <<'PY'
import re
m = re.search(r'"version"\s*:\s*"([^"]+)"', open("extension/manifest.json").read())
print(m.group(1) if m else "")
PY
)
if [ -z "$VERSION" ]; then
  echo "no version in extension/manifest.json; not building" >&2
  exit 1
fi
OUT="dist/tellcheck-github-${VERSION}.zip"
mkdir -p dist
rm -f "$OUT"

if ! npx --no-install web-ext --version >/dev/null 2>&1; then
  echo "web-ext is not installed (run npm install); not building $OUT" >&2
  exit 1
fi
echo "== web-ext lint =="
if ! npx --no-install web-ext lint --source-dir extension; then
  echo "web-ext lint failed; not building $OUT" >&2
  exit 1
fi
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
