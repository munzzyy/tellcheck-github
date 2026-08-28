#!/usr/bin/env python3
"""Headless smoke test for the content script against a GitHub-shaped DOM.

Serves a fixture page at a /owner/repo/pull/1 path, injects a browser-API shim
plus the REAL content/github.js, auto-clicks the scan button with a mocked
background response, and asserts the badges actually render. Catches the class
of bug where unit logic passes but the wiring never executes.

  python3 test/content_smoke.py
"""
import http.server
import json
import pathlib
import re
import subprocess
import sys
import threading

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTENT_JS = (ROOT / "extension" / "content" / "github.js").read_text()
CONTENT_CSS = (ROOT / "extension" / "content" / "github.css").read_text()

MOCK_RESPONSE = {
    "ok": True,
    "results": [
        {"id": "b0", "flagged": True, "abstained": False, "p": 0.97,
         "verdict": "flags as AI at the 5%-FPR operating point", "words": 300,
         "truncated": False, "language": "en",
         "signals": ["31 buzzword hits (delve, leverage, seamless)"]},
        {"id": "b1", "flagged": False, "abstained": False, "p": 0.03,
         "verdict": "no detection at the 5%-FPR operating point", "words": 120,
         "truncated": False, "language": "en", "signals": []},
        {"id": "b2", "flagged": False, "abstained": True, "p": None,
         "verdict": "n/a (under 20 words)", "words": 5,
         "truncated": False, "language": "en", "signals": []},
    ],
    "quota": {"used": 3, "limit": 30, "meter": "ok"},
}

FIXTURE = f"""<!doctype html>
<html><head><meta charset="utf-8"><style>{CONTENT_CSS}</style></head>
<body>
<h1><span class="js-issue-title">Add comprehensive error handling</span></h1>
<div class="timeline-comment"><div class="comment-body">
  <p>This comprehensive PR delves into robust error handling.</p>
  <pre>this code block must never reach the scanner</pre>
</div></div>
<div class="timeline-comment"><div class="comment-body">
  <p>lgtm but the second case still segfaults on my box, see the trace below</p>
</div></div>
<div class="timeline-comment"><div class="comment-body"><p>thanks!</p></div></div>

<script>
  window.__sent = null;
  window.browser = {{
    runtime: {{
      sendMessage: async (msg) => {{
        if (msg.type === "settings") return {{ autoScan: false }};
        if (msg.type === "scan") {{ window.__sent = msg; return {json.dumps(MOCK_RESPONSE)}; }}
        return null;
      }},
      onMessage: {{ addListener: () => {{}} }},
    }},
  }};
</script>
<script>{CONTENT_JS}</script>
<script>
  setTimeout(() => {{
    const fab = document.getElementById("slopscreen-fab");
    if (fab) fab.click();
    setTimeout(() => {{
      const out = document.createElement("div");
      out.id = "test-output";
      out.textContent = JSON.stringify({{
        sentTexts: window.__sent ? window.__sent.texts.map(t => t.text) : null,
        fabText: fab ? fab.textContent : null,
      }});
      document.body.appendChild(out);
    }}, 300);
  }}, 100);
</script>
</body></html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = FIXTURE.encode()
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


def main():
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    url = f"http://127.0.0.1:{port}/someowner/somerepo/pull/1"
    dom = subprocess.run(
        ["chromium", "--headless=new", "--disable-gpu", "--no-sandbox",
         f"--user-data-dir=/tmp/claude-1000/slopscreen-smoke-profile",
         "--virtual-time-budget=4000", "--dump-dom", url],
        capture_output=True, text=True, timeout=60,
    ).stdout
    httpd.shutdown()

    checks = [
        ("fab rendered", 'id="slopscreen-fab"' in dom),
        ("flag chip on AI comment", "slopscreen-flag" in dom and "flags as AI (p 0.97)" in dom),
        ("clean chip on human comment", "slopscreen-clean" in dom and "no AI detection" in dom),
        ("abstain chip on short comment", "slopscreen-abstain" in dom and "too short to judge" in dom),
        ("signal panel present", "31 buzzword hits" in dom),
        ("signal-not-proof footer", "not proof" in dom),
        ("fab summary updated", "1 of 2 flagged" in dom),
    ]

    m = re.search(r'<div id="test-output">([^<]+)</div>', dom)
    sent = json.loads(m.group(1))["sentTexts"] if m else None
    checks.append(("scan sent 3 texts", bool(sent) and len(sent) == 3))
    checks.append(("title prepended to first block",
                   bool(sent) and sent[0].startswith("Add comprehensive error handling")))
    checks.append(("code blocks stripped from sent text",
                   bool(sent) and all("must never reach" not in t for t in sent)))

    ok = True
    for name, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
        ok = ok and passed
    if not ok and dom:
        print("\n--- dom tail for debugging ---")
        print(dom[-1500:])
    print("\nALL PASS" if ok else "\nFAILURES ABOVE")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
