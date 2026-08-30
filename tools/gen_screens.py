#!/usr/bin/env python3
"""Render the real content script on a GitHub-shaped page and capture PNGs +
a demo GIF for the AMO listing and the landing page.

The fixture styles a plausible GitHub PR page, injects a mocked extension
runtime, loads the ACTUAL extension/content/github.js, runs a scan, and (for
some shots) opens a signal panel. So the screenshots show the true UI, not a
mockup. Nothing here ships; it only produces marketing images.

  python3 tools/gen_screens.py
"""
import http.server
import json
import pathlib
import subprocess
import threading

from PIL import Image, ImageChops

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTENT_JS = (ROOT / "extension" / "content" / "github.js").read_text()
CONTENT_CSS = (ROOT / "extension" / "content" / "github.css").read_text()
OUT = ROOT / "site" / "shots"
OUT.mkdir(parents=True, exist_ok=True)

# Realistic-length PR description that genuinely trips the detector, and a
# genuinely human review comment that does not.
AI_BODY = (
    "This comprehensive pull request delves into the intricacies of the "
    "configuration parser, leveraging a robust and seamless approach to "
    "significantly enhance maintainability. Additionally, it underscores our "
    "commitment to code quality by fostering a more vibrant and resilient "
    "architecture. Furthermore, the meticulous refactoring showcases a "
    "transformative improvement, empowering future contributors to seamlessly "
    "navigate the ever-evolving landscape of the codebase. Moreover, these "
    "changes ensure a holistic and cohesive developer experience across the "
    "entire stack, and stand as a testament to the power of thoughtful design."
)
HUMAN_BODY = (
    "thanks for this but the second case still segfaults on my box. repro: "
    "empty [server] section with no keys, parser walks off the end. i think "
    "the bounds check on line 214 needs to run before the memcpy, not after. "
    "can you add a test for the empty-section case?"
)

RESULTS = {
    "b0": {"id": "b0", "flagged": True, "abstained": False, "p": 0.96,
           "verdict": "flags as AI at the 5% false-positive operating point", "words": 118,
           "truncated": False, "language": "en",
           "signals": ["9 buzzword hits (delve, leverage, seamless)",
                       "3 stock AI phrases (a testament to, ever-evolving landscape)",
                       "connective-opener overuse (additionally, furthermore, moreover)",
                       "unusually uniform sentence rhythm"]},
    "b1": {"id": "b1", "flagged": False, "abstained": False, "p": 0.02,
           "verdict": "no detection at the 5% false-positive operating point", "words": 61,
           "truncated": False, "language": "en", "signals": []},
}

LIST_RESULTS = [
    {"n": 4823, "title": "Refactor the entire authentication subsystem for robustness", "cls": "flag", "txt": "AI? p 0.94"},
    {"n": 4820, "title": "fix: off-by-one in ring buffer wraparound", "cls": "clean", "txt": "ok"},
    {"n": 4816, "title": "Comprehensive improvements to enhance the user experience", "cls": "flag", "txt": "AI? p 0.89"},
    {"n": 4811, "title": "add ipv6 support to the resolver", "cls": "clean", "txt": "ok"},
    {"n": 4809, "title": "typo", "cls": "abstain", "txt": "n/a"},
]

PAGE_CSS = """
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--fg); }
  :root { --bg:#fff; --fg:#1f2328; --muted:#59636e; --line:#d1d9e0; --box:#f6f8fa; --accent:#0969da; }
  [data-color-mode="dark"] { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --line:#30363d; --box:#161b22; --accent:#4493f8; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 20px 26px; }
  .prtitle { font-size: 26px; font-weight: 400; margin: 0 0 6px; }
  .prtitle .num { color: var(--muted); font-weight: 300; }
  .prmeta { color: var(--muted); font-size: 13px; padding-bottom: 14px; border-bottom: 1px solid var(--line); margin-bottom: 20px; }
  .state { display:inline-block; background:#1a7f37; color:#fff; border-radius:999px; padding:3px 10px; font-size:12px; font-weight:600; margin-right:8px; }
  .comment { border: 1px solid var(--line); border-radius: 8px; margin-bottom: 18px; }
  .chead { display:flex; align-items:center; gap:8px; background: var(--box); border-bottom: 1px solid var(--line);
    padding: 8px 14px; border-radius: 8px 8px 0 0; font-size: 13px; }
  .chead b { color: var(--fg); } .chead span { color: var(--muted); }
  .avatar { width: 24px; height: 24px; border-radius: 50%; }
  .cbody { padding: 14px; }
  .cbody p { margin: 0 0 10px; } .cbody p:last-child { margin: 0; }
  .listrow { display:flex; align-items:center; gap:10px; padding:12px 8px; border-bottom:1px solid var(--line); }
  .listrow .ic { color:#1a7f37; }
  .listrow a { color: var(--fg); text-decoration:none; font-weight:600; }
  .listrow a:hover { color: var(--accent); }
  .listmeta { color: var(--muted); font-size:12px; margin-left: 30px; }
"""

def avatar(color):
    return (f'<svg class="avatar" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="{color}"/>'
            f'<circle cx="12" cy="9" r="4" fill="#fff" opacity=".9"/>'
            f'<path d="M4 22c0-4 4-6 8-6s8 2 8 6" fill="#fff" opacity=".9"/></svg>')

def detail_fixture(dark, open_panel, do_scan=True):
    mode = 'dark' if dark else 'light'
    if not do_scan:
        trigger = ""
    else:
        trigger = """
          setTimeout(() => {
            const fab = document.getElementById("tellcheck-fab");
            if (fab) fab.click();
            %s
          }, 150);
        """ % ('setTimeout(() => { const c = document.querySelector(".tellcheck-flag"); if (c) c.click(); }, 550);' if open_panel else '')
    return f"""<!doctype html><html data-color-mode="{mode}"><head><meta charset="utf-8">
<style>{PAGE_CSS}{CONTENT_CSS}</style></head><body><div class="wrap">
<h1 class="prtitle">Improve config parser <span class="num">#4823</span></h1>
<div class="prmeta"><span class="state">Open</span>
 <b>quietriver</b> wants to merge 3 commits into <b>main</b> from <b>config-refactor</b></div>

<div class="comment"><div class="chead">{avatar('#6e5494')}<b>quietriver</b><span>opened this pull request 2 hours ago</span></div>
<div class="cbody timeline-comment"><div class="comment-body"><h1 class="js-issue-title" style="display:none">Improve config parser</h1>
<p>{AI_BODY}</p></div></div></div>

<div class="comment"><div class="chead">{avatar('#0969da')}<b>maintainer</b><span>commented 40 minutes ago</span></div>
<div class="cbody timeline-comment"><div class="comment-body"><p>{HUMAN_BODY}</p></div></div></div>
</div>
<script>
  const SCAN = {{ ok:true, results:{json.dumps([RESULTS['b0'], RESULTS['b1']])}, quota:{{used:2,limit:30,meter:"ok"}} }};
  window.browser = {{ runtime: {{
    sendMessage: async (m) => (m.type === "settings" ? {{autoScan:false}} : m.type === "scan" ? SCAN : null),
    onMessage: {{ addListener: () => {{}} }},
  }} }};
</script>
<script>{CONTENT_JS}</script>
<script>{trigger}</script>
</body></html>"""

def list_fixture(dark):
    mode = 'dark' if dark else 'light'
    rows = ""
    for r in LIST_RESULTS:
        rows += (f'<div class="listrow"><span class="ic">&#9737;</span>'
                 f'<a href="/o/r/pull/{r["n"]}">{r["title"]}</a>'
                 f'<span class="tellcheck-mini tellcheck-{r["cls"]}">{r["txt"]}</span>'
                 f'<div style="flex:1"></div></div>'
                 f'<div class="listmeta">#{r["n"]} opened by contributor</div>')
    return f"""<!doctype html><html data-color-mode="{mode}"><head><meta charset="utf-8">
<style>{PAGE_CSS}{CONTENT_CSS}</style></head><body><div class="wrap">
<h1 class="prtitle" style="font-size:20px">Pull requests</h1>
<div class="prmeta">5 open</div>{rows}
<button class="tellcheck-fab">2 flagged of 5. Rescan</button>
</div></body></html>"""

def content_box(img, pad=48):
    """Bounding box of the real content inside a screenshot, padded a bit.
    Drops the empty chrome a fixed window size always leaves around
    variable-height content, so the same badge/signal text reads bigger
    once the image is squeezed into a phone-width <img>."""
    bg = Image.new("RGB", img.size, img.getpixel((0, 0)))
    diff = ImageChops.difference(img, bg)
    bbox = diff.getbbox()
    if not bbox:
        return (0, 0, img.width, img.height)
    left, top, right, bottom = bbox
    left = max(0, left - pad)
    top = max(0, top - pad)
    right = min(img.width, right + pad)
    bottom = min(img.height, bottom + pad)
    return (left, top, right, bottom)


def autocrop(path, box=None, pad=48):
    """Crop a screenshot to its own content box, or to a caller-supplied box
    (used to keep every frame of the demo gif aligned to one canvas)."""
    img = Image.open(path).convert("RGB")
    box = box or content_box(img, pad)
    img.crop(box).save(path)
    return box


def shoot(html, out, path="/quietriver/config/pull/4823", w=980, h=760, wait=2500, crop_box=None):
    """Serve the fixture at a GitHub-shaped path so the content script's route
    matcher fires, then screenshot it, then crop the outer chrome away.
    Returns the crop box actually used, so a caller can reuse it for a
    matching frame."""
    body = html.encode()

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    subprocess.run(
        ["chromium", "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
         "--force-device-scale-factor=2", f"--window-size={w},{h}",
         "--user-data-dir=/tmp/claude-1000/ss-shot-profile",
         f"--virtual-time-budget={wait}", f"--screenshot={out}",
         f"http://127.0.0.1:{port}{path}"],
        capture_output=True, timeout=60)
    srv.shutdown()
    used_box = autocrop(out, box=crop_box)
    with Image.open(out) as img:
        size = img.size
    print("wrote", pathlib.Path(out).relative_to(ROOT), size)
    return used_box


def make_gif():
    """plain -> badges -> panel open, held, looping. Scaled down for the web."""
    import shutil
    frames = [("detail-plain.png", 12), ("detail-badges.png", 12), ("detail-light.png", 34)]
    concat = OUT / "_frames.txt"
    lines = []
    for name, hold in frames:
        # ffmpeg concat demuxer: duration in seconds per still.
        lines.append(f"file '{OUT / name}'\nduration {hold/10:.1f}")
    lines.append(f"file '{OUT / frames[-1][0]}'")  # last frame repeated (demuxer quirk)
    concat.write_text("\n".join(lines))
    palette = OUT / "_palette.png"
    scale = "scale=760:-1:flags=lanczos"
    subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
                    "-vf", f"{scale},palettegen=stats_mode=diff", str(palette)],
                   capture_output=True, timeout=90)
    subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
                    "-i", str(palette),
                    "-lavfi", f"{scale}[x];[x][1:v]paletteuse=dither=bayer",
                    str(OUT / "demo.gif")],
                   capture_output=True, timeout=90)
    concat.unlink(missing_ok=True); palette.unlink(missing_ok=True)
    if shutil.which("magick"):
        print("demo.gif:", subprocess.run(["identify", str(OUT / "demo.gif")],
              capture_output=True, text=True).stdout.strip()[:120])


def main():
    # detail-light is both the standalone hero shot and the tallest gif frame
    # (panel open); reuse its crop box for the other two frames so the three
    # line up on one canvas instead of jumping size mid-animation.
    box = shoot(detail_fixture(dark=False, open_panel=True), str(OUT / "detail-light.png"))
    shoot(detail_fixture(dark=True, open_panel=True), str(OUT / "detail-dark.png"))
    shoot(detail_fixture(dark=False, open_panel=False), str(OUT / "detail-badges.png"), crop_box=box)
    shoot(detail_fixture(dark=False, open_panel=False, do_scan=False), str(OUT / "detail-plain.png"), crop_box=box)
    # Window height close to the 5-row list's real content height. The fab
    # button is position:fixed to the viewport bottom, so a tall window
    # drags a huge dead strip of whitespace into the autocrop bbox.
    shoot(list_fixture(dark=False), str(OUT / "list-light.png"), h=440)
    shoot(list_fixture(dark=True), str(OUT / "list-dark.png"), h=440)
    make_gif()


if __name__ == "__main__":
    main()
