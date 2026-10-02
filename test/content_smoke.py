#!/usr/bin/env python3
"""Headless smoke test for the content script against a GitHub-shaped DOM.

Serves fixture pages at /owner/repo/pull/N paths, injects a browser-API shim
plus the REAL content/github.js, auto-clicks the scan button with a mocked
background response, and asserts the badges actually render. Catches the class
of bug where unit logic passes but the wiring never executes.

  python3 test/content_smoke.py
"""
import html
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
        # b0 carries no style_* fields at all: the chip row must survive a
        # response from a worker build that predates the comment-style layer.
        {"id": "b1", "flagged": False, "abstained": False, "p": 0.03,
         "verdict": "no detection at the 5% false-positive operating point", "words": 120,
         "truncated": False, "language": "en", "signals": [],
         "style_flag": True, "style_points": 8.5,
         "style_reasons": ["no #issue, @name or link: real comments point at something"]},
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

SHIM = """
<script>
  window.__sent = null;
  window.browser = {
    runtime: {
      sendMessage: async (msg) => {
        if (msg.type === "settings") return { autoScan: false };
        if (msg.type === "scan" || msg.type === "batch") { window.__sent = msg; return MOCK(msg); }
        return null;
      },
      onMessage: { addListener: () => {} },
    },
  };
</script>"""

PROBE = """
<script>
  setTimeout(() => {
    const fab = document.getElementById("tellcheck-fab");
    if (fab) fab.click();
    setTimeout(() => {
      const out = document.createElement("div");
      out.id = "test-output";
      const blocks = [...document.querySelectorAll(".timeline-comment")];
      out.textContent = JSON.stringify({
        sent: window.__sent,
        sentTexts: window.__sent && window.__sent.texts ? window.__sent.texts.map(t => t.text) : null,
        sentKinds: window.__sent && window.__sent.texts ? window.__sent.texts.map(t => t.kind) : null,
        fabText: fab ? fab.textContent : null,
        blocks: blocks.length,
        chips: blocks.map(b => { const c = b.querySelector(".tellcheck-chip"); return c ? c.textContent : null; }),
      });
      document.body.appendChild(out);
    }, 300);
  }, 100);
</script>"""


def page(body, mock_js):
    """A GitHub-shaped page: fixture markup, the browser shim answering with
    mock_js(msg), the real content script, then a probe that clicks scan and
    writes what happened into #test-output."""
    return (f'<!doctype html>\n<html><head><meta charset="utf-8"><style>{CONTENT_CSS}</style></head>\n'
            f"<body>\n{body}\n<script>const MOCK = {mock_js};</script>{SHIM}\n"
            f"<script>{CONTENT_JS}</script>{PROBE}\n</body></html>")


def comments(texts):
    return "\n".join(f'<div class="timeline-comment"><div class="comment-body"><p>{t}</p></div></div>'
                     for t in texts)


TITLE = ('<h1 data-component="PH_Title" class="prc-PageHeader-Title-p0Mgh"><span class="f1 text-normal '
         'markdown-title">Add comprehensive error handling</span><span class="sr-only"> - #<!-- -->42</span></h1>')

DETAIL_BODY = TITLE + """
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
</div></div>"""

# Answers every id it is sent with a clean result, except the last `capped`
# ids, which come back refused at the daily limit.
ANSWER_ALL = """(capped) => (msg) => ({
  ok: true,
  results: msg.texts.map((t, i) => i >= msg.texts.length - capped
    ? { id: t.id, p: null, flagged: false, abstained: true, reason: "quota",
        verdict: "not scored: the daily scan limit ran out before this text", words: 0 }
    : { id: t.id, p: 0.03, flagged: false, abstained: false,
        verdict: "no detection at the 5% false-positive operating point", words: 40,
        truncated: false, language: "en", signals: [] }),
  quota: { used: msg.texts.length - capped, limit: 100, meter: "ok" },
})"""

LONG_THREAD = TITLE + "\n" + comments(
    [f"comment number {i} on this long thread, with enough words in it to be worth scoring"
     for i in range(31)])

PAGES = {
    "/someowner/somerepo/pull/1": page(DETAIL_BODY, f"() => ({json.dumps(MOCK_RESPONSE)})"),
    "/someowner/somerepo/pull/2": page(LONG_THREAD, f"({ANSWER_ALL})(0)"),
    "/someowner/somerepo/pull/3": page(LONG_THREAD, f"({ANSWER_ALL})(4)"),
}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in PAGES:
            self.send_error(404)
            return
        body = PAGES[self.path].encode()
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


def dump(port, path):
    dom = subprocess.run(
        [browser(), "--headless=new", "--disable-gpu", "--no-sandbox",
         f"--user-data-dir=/tmp/claude-1000/tellcheck-github-smoke-profile",
         "--virtual-time-budget=4000", "--dump-dom", f"http://127.0.0.1:{port}{path}"],
        capture_output=True, text=True, timeout=60,
    ).stdout
    m = re.search(r'<div id="test-output">([^<]+)</div>', dom)
    return dom, (json.loads(html.unescape(m.group(1))) if m else {})


def main():
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    dom, out = dump(port, "/someowner/somerepo/pull/1")
    _, long_thread = dump(port, "/someowner/somerepo/pull/2")
    _, capped = dump(port, "/someowner/somerepo/pull/3")
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

    checks += [
        ("style chip on the style-only comment",
         "tellcheck-style" in dom and "reads assistant-drafted (style)" in dom),
        # Class-attr match, so the embedded CSS/JS source cannot satisfy it:
        # only b0 flags, so a second flag chip would mean the style layer
        # leaked into the detector's chip.
        ("style flag never borrows the detector's flag chip",
         dom.count('tellcheck-chip tellcheck-flag"') == 1),
        ("style reasons render in the panel",
         "real comments point at something" in dom),
        ("style panel says it is a separate signal", "Separate signal" in dom),
    ]

    sent = out.get("sentTexts")
    kinds = out.get("sentKinds")
    checks.append(("scan sent 5 texts", bool(sent) and len(sent) == 5))
    checks.append(("description sent as kind pr, thread comments as kind comment",
                   kinds == ["pr", "comment", "comment", "comment", "comment"]))
    checks.append(("title prepended to first block",
                   bool(sent) and sent[0].startswith("Add comprehensive error handling")))
    # The live h1 carries a screen-reader "- #15000" sibling; scoring the issue
    # number as if it were prose would be noise.
    checks.append(("issue number not scraped in with the title",
                   bool(sent) and "#42" not in sent[0]))
    checks.append(("code blocks stripped from sent text",
                   bool(sent) and all("must never reach" not in t for t in sent)))

    # Past the worker's 25 texts per request: the content script sends every
    # block and the background splits the call, so every block gets a chip.
    chips = long_thread.get("chips") or []
    checks.append(("long thread sends every block", len(long_thread.get("sentTexts") or []) == 31))
    checks.append(("long thread has 31 blocks and 31 chips",
                   long_thread.get("blocks") == 31 and len(chips) == 31 and all(chips)))
    checks.append(("long thread fab counts all 31", long_thread.get("fabText") == "No flags in 31 scored. Rescan"))
    capped_chips = capped.get("chips") or []
    marked = [i for i, c in enumerate(capped_chips) if c == "Tellcheck: not scored (daily limit)"]
    checks.append(("daily-limit refusals get their own chip, on exactly those blocks", marked == [27, 28, 29, 30]))
    checks.append(("fab says how many ran past the daily limit",
                   capped.get("fabText") == "No flags in 27 scored, 4 past the daily limit. Rescan"))

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
