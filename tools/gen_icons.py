#!/usr/bin/env python3
"""Draw the SlopScreen icon: a screen (sieve) mark, blue on transparent.

  python3 tools/gen_icons.py
"""
import pathlib
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("needs pillow: pip install pillow")

OUT = pathlib.Path(__file__).resolve().parent.parent / "extension" / "icons"
BLUE = (31, 111, 235, 255)
RED = (209, 36, 47, 255)


def draw(size):
    s = 8  # supersample for clean edges
    n = size * s
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = n * 0.06
    lw = max(int(n * 0.055), s)

    # Sieve: a circle with a grid through it.
    d.ellipse([pad, pad, n - pad, n - pad], outline=BLUE, width=int(lw * 1.4))
    cx = n / 2
    import math
    r = (n - 2 * pad) / 2 - lw
    for f in (-0.45, 0.0, 0.45):
        off = r * f
        half = math.sqrt(max(r * r - off * off, 0))
        d.line([cx - half, cx + off, cx + half, cx + off], fill=BLUE, width=lw)
        d.line([cx + off, cx - half, cx + off, cx + half], fill=BLUE, width=lw)

    # A red dot caught in the top-left cell of the screen.
    dot_r = n * 0.09
    dx, dy = cx - r * 0.62, cx - r * 0.62
    d.ellipse([dx - dot_r, dy - dot_r, dx + dot_r, dy + dot_r], fill=RED)

    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (48, 96, 128):
        p = OUT / f"icon-{size}.png"
        draw(size).save(p)
        print(f"wrote {p}")


if __name__ == "__main__":
    main()
