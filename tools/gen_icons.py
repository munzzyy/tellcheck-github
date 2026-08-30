#!/usr/bin/env python3
"""Draw the Tellcheck for GitHub icon: a solid accent tile with a bold T
monogram and a small red flag dot. Reads at toolbar size, on light or dark.
  python3 tools/gen_icons.py
"""
import pathlib
import sys
try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("needs pillow: pip install pillow")

OUT = pathlib.Path(__file__).resolve().parent.parent / "extension" / "icons"
ACCENT = (90, 162, 255, 255)   # #5aa2ff, the Tellcheck accent
DARK = (11, 14, 20, 255)       # #0b0e14, the brand ink
RED = (255, 107, 107, 255)     # the flag color used across the sites
S = 12                         # supersample for clean edges

FONTS = (
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
)


def load_font(px):
    for fp in FONTS:
        try:
            return ImageFont.truetype(fp, px)
        except OSError:
            continue
    return ImageFont.load_default()


def draw(size):
    n = size * S
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, n, n], radius=int(n * 0.22), fill=ACCENT)
    f = load_font(int(n * 0.60))
    tb = d.textbbox((0, 0), "T", font=f)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    d.text(((n - tw) / 2 - tb[0], (n - th) / 2 - tb[1] - n * 0.02), "T", font=f, fill=DARK)
    r = n * 0.085
    cx, cy = n * 0.71, n * 0.25
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=RED)
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (48, 96, 128):
        p = OUT / f"icon-{size}.png"
        draw(size).save(p)
        print(f"wrote {p}")


if __name__ == "__main__":
    main()
