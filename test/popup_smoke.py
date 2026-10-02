#!/usr/bin/env python3
"""Headless check of the popup's quota line against stored quota states.

Serves the real popup.html and popup.js with a browser-API shim injected ahead
of popup.js, then dumps the DOM.

  python3 test/popup_smoke.py
"""
import html
import http.server
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading

from content_smoke import browser

ROOT = pathlib.Path(__file__).resolve().parent.parent
POPUP = ROOT / "extension" / "popup"

QUOTAS = {
    "/network": {"used": 0, "limit": 500, "reason": "network daily cap reached", "meter": "ok"},
    "/normal": {"used": 40, "limit": 100, "meter": "ok"},
    "/install-cap": {"used": 100, "limit": 100, "reason": "daily limit reached", "meter": "ok"},
}

PROBE = """<script>
  setTimeout(() => {
    const scan = document.getElementById("scan");
    const out = document.createElement("div");
    out.id = "test-output";
    out.textContent = JSON.stringify({
      line: document.getElementById("quota-line").textContent,
      barHidden: document.getElementById("quota-bar").parentElement.hidden,
      scanDisabled: scan.disabled,
      scanText: scan.textContent,
    });
    document.body.appendChild(out);
  }, 300);
</script>"""


def shim(quota):
    return f"""<script>
  window.browser = {{
    storage: {{ local: {{ get: async () => ({{ lastQuota: {json.dumps(quota)}, lastQuotaAt: Date.now() }}) }} }},
    tabs: {{ query: async () => [], sendMessage: async () => null }},
    runtime: {{ openOptionsPage: () => {{}} }},
  }};
</script>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/popup.js":
            body, kind = (POPUP / "popup.js").read_bytes(), "text/javascript"
        elif self.path in QUOTAS:
            page = (POPUP / "popup.html").read_text()
            tag = '<script src="popup.js"></script>'
            assert tag in page, "popup.html no longer loads popup.js the way this test expects"
            page = page.replace(tag, shim(QUOTAS[self.path]) + '<script src="/popup.js"></script>' + PROBE)
            body, kind = page.encode(), "text/html; charset=utf-8"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


def state(port, path):
    profile = tempfile.mkdtemp(prefix="tellcheck-popup-smoke-")
    try:
        dom = subprocess.run(
            [browser(), "--headless=new", "--disable-gpu", "--no-sandbox", f"--user-data-dir={profile}",
             "--virtual-time-budget=3000", "--dump-dom", f"http://127.0.0.1:{port}{path}"],
            capture_output=True, text=True, timeout=60,
        ).stdout
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    m = re.search(r'<div id="test-output">([^<]+)</div>', dom)
    return json.loads(html.unescape(m.group(1))) if m else {}


def main():
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    network, normal, capped = (state(port, p) for p in QUOTAS)
    httpd.shutdown()

    checks = [
        ("network cap never reads as the install's own count", bool(network) and "of 500" not in network["line"]),
        ("network cap explains the shared allowance", "shared" in network.get("line", "")),
        ("network cap hides the bar", network.get("barHidden") is True),
        ("network cap disables scan", network.get("scanDisabled") is True),
        ("normal day shows the count", normal.get("line") == "40 of 100 scans used today."),
        ("normal day leaves scan enabled", normal.get("scanDisabled") is False),
        ("install cap still disables scan", capped.get("scanDisabled") is True
         and capped.get("scanText") == "Daily limit reached"),
    ]
    ok = True
    for name, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
        ok = ok and passed
    if not ok:
        print("\n--- states ---", json.dumps({"network": network, "normal": normal, "capped": capped}, indent=1))
    print("\nALL PASS" if ok else "\nFAILURES ABOVE")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
