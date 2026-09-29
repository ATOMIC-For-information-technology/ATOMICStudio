#!/usr/bin/env python3
"""
Generate the ATOMIC Studio app icons from the brand logo.

Run:  python3 scripts/make-icons.py            (from apps/desktop)

Produces into build/:
  icon.icns        macOS app icon (all 10 sizes, packed by iconutil)
  icon.ico         Windows app icon (6 sizes)
  icon.png         1024px master, also used by Linux targets
  atom-mark.png    the mark alone on transparency — for the website / docs

── Decisions, so a future edit doesn't undo them on purpose ──────────────────────────────────────
* **The mark only, never the wordmark.** The source logo is the atom above the word "ATOMIC". At
  32 px in the Dock the lettering is an illegible smudge, so it is cropped away. The mark alone
  reads at every size, which is the entire job of an app icon.
* **Alpha is keyed on min(r,g,b), not luminance.** The obvious "白 = transparent" trick is to use
  brightness, but the electron in this logo is a saturated blue: it is *mid*-brightness, so a
  luminance key would render it half-transparent and wash it out. `min(r,g,b)` is low for navy AND
  for saturated blue, and 255 only for true white — so both parts of the mark keep full opacity and
  the anti-aliased edges still fade correctly.
* **The rounded square is drawn here, not by macOS.** macOS does not mask app icons; whatever shape
  is in the .icns is the shape on screen. The proportions follow Apple's current icon grid: the
  square occupies ~80% of the canvas with a ~22% corner radius, which is what makes an icon sit
  correctly next to the system's own.
"""
import os
import subprocess
import sys
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP = os.path.dirname(HERE)
SRC = os.path.expanduser('~/Downloads/ATOMIC new LOGO.PNG')
OUT = os.path.join(DESKTOP, 'build')

# Measured bounding box of the atom mark in the source art (the wordmark sits below y=828).
MARK_BOX = (370, 265, 884, 748)

CANVAS = 1024
SQUARE = 824          # Apple's icon grid: the rounded square inside the 1024 canvas
RADIUS = 185          # ~22% of the square
# How much of the square the glyph fills. Pushed up from 0.62 after looking at a real contact sheet:
# this logo is built from thin orbit strokes, and at 32/16 px they thinned into mush. A larger glyph
# thickens every stroke relative to the canvas, which is the only lever available short of redrawing
# a simplified small-size variant.
MARK_FRACTION = 0.72


def load_mark() -> Image.Image:
    """The atom, cropped from the logo and keyed to transparency."""
    if not os.path.exists(SRC):
        sys.exit(f'Source logo not found: {SRC}')
    im = Image.open(SRC).convert('RGB').crop(MARK_BOX)
    w, h = im.size
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    src, dst = im.load(), out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = src[x, y]
            a = 255 - min(r, g, b)  # see module docstring — NOT luminance
            if a > 0:
                dst[x, y] = (r, g, b, a)
    return out


def master(mark: Image.Image) -> Image.Image:
    """The 1024px icon: gradient rounded square, mark centred on top."""
    icon = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))

    # A near-white vertical gradient. Flat #FFF goes invisible against a light Dock; this keeps the
    # brand's white while still reading as an object.
    grad = Image.new('RGBA', (1, SQUARE))
    for y in range(SQUARE):
        t = y / (SQUARE - 1)
        grad.putpixel((0, y), (int(255 - 17 * t), int(255 - 13 * t), int(255 - 7 * t), 255))
    grad = grad.resize((SQUARE, SQUARE))

    mask = Image.new('L', (SQUARE, SQUARE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SQUARE - 1, SQUARE - 1], radius=RADIUS, fill=255)

    inset = (CANVAS - SQUARE) // 2
    icon.paste(grad, (inset, inset), mask)

    # Scale the mark to fill MARK_FRACTION of the square, preserving its aspect ratio.
    mw, mh = mark.size
    target = int(SQUARE * MARK_FRACTION)
    scale = target / max(mw, mh)
    new = (max(1, int(mw * scale)), max(1, int(mh * scale)))
    m = mark.resize(new, Image.LANCZOS)
    icon.paste(m, ((CANVAS - new[0]) // 2, (CANVAS - new[1]) // 2), m)
    return icon


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    mark = load_mark()
    mark.save(os.path.join(OUT, 'atom-mark.png'))

    icon = master(mark)
    icon.save(os.path.join(OUT, 'icon.png'))

    # macOS: a .iconset folder of exact sizes, packed by the system's own iconutil.
    iconset = os.path.join(OUT, 'icon.iconset')
    os.makedirs(iconset, exist_ok=True)
    for base in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = base * scale
            name = f'icon_{base}x{base}{"@2x" if scale == 2 else ""}.png'
            icon.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, name))
    subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', os.path.join(OUT, 'icon.icns')], check=True)

    # Windows: one .ico carrying every size Explorer and the taskbar ask for.
    icon.save(
        os.path.join(OUT, 'icon.ico'),
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (128, 128), (256, 256)],
    )

    print('wrote:')
    for f in ('icon.icns', 'icon.ico', 'icon.png', 'atom-mark.png'):
        p = os.path.join(OUT, f)
        print(f'  build/{f}  {os.path.getsize(p) // 1024} KB')


if __name__ == '__main__':
    main()
