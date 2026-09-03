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
import os
import shutil
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
        {"id": "b0", "flagged": True, "abstained": False, "p": 1,
         "verdict": "flags as AI at the 5% false-positive operating point", "words": 300,
         "truncated": False, "language": "en",
         "signals": ["31 buzzword hits (delve, leverage, seamless)"]},
        {"id": "b1", "flagged": False, "abstained": False, "p": 0.03,
         "verdict": "no detection at the 5% false-positive operating point", "words": 120,
         "truncated": False, "language": "en", "signals": []},
        {"id": "b2", "flagged": False, "abstained": True, "p": None,
         "verdict": "not scored: under 20 words", "words": 5,
         "truncated": False, "language": "en", "signals": []},
        {"id": "b3", "flagged": False, "abstained": True, "p": None,
         "verdict": "not scored: the classifier is calibrated for English only",
         "words": 80, "truncated": False, "language": "de", "signals": []},
        # b4 deliberately missing: the fixture has 5 blocks, the worker "dropped" one.
    ],
    "quota": {"used": 4, "limit": 30, "meter": "ok"},
    "dropped": 1,
}

FIXTURE = f"""<!doctype html>
<html><head><meta charset="utf-8"><style>{CONTENT_CSS}</style></head>
<body>
<h1 data-component="PH_Title" class="prc-PageHeader-Title-p0Mgh"><span class="f1 text-normal markdown-title">Add comprehensive error handling</span><span class="sr-only"> - #<!-- -->42</span></h1>
<div class="timeline-comment"><div class="comment-body">
  <p>This comprehensive PR delves into robust error handling.</p>
  <pre>this code block must never reach the scanner</pre>
</div></div>
<div class="timeline-comment"><div class="comment-body">
  <p>lgtm but the second case still segfaults on my box, see the trace below</p>
</div></div>
<div class="timeline-comment"><div class="comment-body"><p>thanks!</p></div></div>
<div class="timeline-comment"><div class="comment-body">
  <p>Dieser Pull Request behebt einen Fehler in der Konfigurationsdatei und mehr.</p>
</div></div>
<div class="timeline-comment"><div class="comment-body">
  <p>this fifth comment is over the mocked per-scan limit and gets no result</p>
</div></div>

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
    const fab = document.getElementById("tellcheck-fab");
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


def browser():
    """Chromium goes by different names depending on the box and the CI image."""
    override = os.environ.get("CHROMIUM")
    names = [override] if override else ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]
    for n in names:
        if n and shutil.which(n):
            return n
    sys.exit(f"no chromium binary found (tried: {', '.join(n for n in names if n)})")


def main():
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    url = f"http://127.0.0.1:{port}/someowner/somerepo/pull/1"
    dom = subprocess.run(
        [browser(), "--headless=new", "--disable-gpu", "--no-sandbox",
         f"--user-data-dir=/tmp/claude-1000/tellcheck-github-smoke-profile",
         "--virtual-time-budget=4000", "--dump-dom", url],
        capture_output=True, text=True, timeout=60,
    ).stdout
    httpd.shutdown()

    checks = [
        ("fab rendered", 'id="tellcheck-fab"' in dom),
        ("flag chip on AI comment", "tellcheck-flag" in dom and "flags as AI (p 1.00)" in dom),
        ("clean chip on human comment", "tellcheck-clean" in dom and "no AI detection" in dom),
        ("abstain chip on short comment", "tellcheck-abstain" in dom and "too short to judge" in dom),
        ("English-only abstain labeled honestly", "not scored (English only)" in dom),
        ("dropped block gets a not-scored chip", "not scored (scan limit)" in dom),
        ("signal panel present", "31 buzzword hits" in dom),
        ("signal-not-proof footer", "not proof" in dom),
        ("chip announces itself as a closed disclosure", 'aria-expanded="false"' in dom),
        ("chip points at the panel it opens", 'aria-controls="tellcheck-panel-' in dom),
        # Match the rendered chip, not raw page text: the content script's own
        # source is embedded in this fixture, so a bare substring search hits
        # the comment that explains this very case.
        ("saturated score renders two decimals, not a bare 1",
         "AI (p 1)</button>" not in dom),
        ("fab summary counts flags and misses", "1 of 2 flagged, 1 over the scan limit" in dom),
    ]

    m = re.search(r'<div id="test-output">([^<]+)</div>', dom)
    sent = json.loads(m.group(1))["sentTexts"] if m else None
    checks.append(("scan sent 5 texts", bool(sent) and len(sent) == 5))
    checks.append(("title prepended to first block",
                   bool(sent) and sent[0].startswith("Add comprehensive error handling")))
    # The live h1 carries a screen-reader "- #15000" sibling; scoring the issue
    # number as if it were prose would be noise.
    checks.append(("issue number not scraped in with the title",
                   bool(sent) and "#42" not in sent[0]))
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
