#!/bin/bash
# One-command deploy for SlopScreen's backend + landing site. Idempotent.
# Needs CLOUDFLARE_API_TOKEN (Workers Scripts:Edit, Workers KV:Edit, Pages:Edit)
# or a prior `wrangler login`.
#
#   bash deploy.sh
#
# This does NOT submit the extension to AMO (that needs your Mozilla account) and
# does NOT touch payments (v0.1 ships free). After deploy, the extension zip is
# rebuilt against the live worker URL; upload dist/slopscreen-*.zip to AMO.
set -euo pipefail
cd "$(dirname "$0")"
W=(npx --yes wrangler@latest)

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && ! "${W[@]}" whoami >/dev/null 2>&1; then
  echo "No Cloudflare auth. Set CLOUDFLARE_API_TOKEN or run: npx wrangler login"; exit 1
fi

echo "== 1/5 detector =="
python3 tools/sync_detector.py

echo "== 2/5 KV namespace =="
KVID=$("${W[@]}" kv namespace list 2>/dev/null | python3 -c "import sys,json;print(next((n['id'] for n in json.load(sys.stdin) if n.get('title','').endswith('QUOTA')),''))" || true)
if [ -z "$KVID" ]; then
  OUT=$( cd worker && "${W[@]}" kv namespace create QUOTA 2>&1 ); echo "$OUT"
  KVID=$(printf '%s' "$OUT" | grep -oE '[0-9a-f]{32}' | head -1)
fi
[ -n "$KVID" ] || { echo "could not resolve KV id"; exit 1; }
python3 - "$KVID" <<'PY'
import re, sys, pathlib
kid = sys.argv[1]
p = pathlib.Path("worker/wrangler.toml"); t = p.read_text()
t = re.sub(r'\n*\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"[^"]*"\n?', '\n', t).rstrip()
t += f'\n\n[[kv_namespaces]]\nbinding = "QUOTA"\nid = "{kid}"\n'
p.write_text(t); print(f"   KV id {kid} written")
PY

echo "== 3/5 deploy worker =="
DEPLOY=$( cd worker && "${W[@]}" deploy 2>&1 ); echo "$DEPLOY"
URL=$(printf '%s' "$DEPLOY" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
if [ -n "$URL" ]; then
  python3 - "$URL" <<'PY'
import re, sys, pathlib
p = pathlib.Path("extension/config.js"); t = p.read_text()
p.write_text(re.sub(r'API_URL:\s*"[^"]*"', f'API_URL: "{sys.argv[1]}"', t, count=1))
print(f"   API_URL set to {sys.argv[1]}; rebuilding extension zip")
PY
  bash tools/package.sh >/dev/null && echo "   rebuilt dist/"
fi

echo "== 4/5 Pages project =="
"${W[@]}" pages project list 2>/dev/null | grep -q slopscreen || "${W[@]}" pages project create slopscreen --production-branch=main

echo "== 5/5 deploy site =="
"${W[@]}" pages deploy site --project-name=slopscreen --branch=main

echo
echo "DONE. Worker: ${URL:-<above>}   Site: https://slopscreen.pages.dev"
echo "Next (yours): submit dist/slopscreen-*.zip to addons.mozilla.org (see listing.md)."
