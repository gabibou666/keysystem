#!/usr/bin/env python3
"""Genere l'image de partage social (Open Graph) 1200x630 : web/og.png.

Pourquoi: sans og:image, les partages Discord/Twitter du site affichent une
vignette vide, ce qui coute des clics. L'image est generee ici pour rester
reproductible (et modifiable) sans outil de design externe.

Usage: python scripts/make-og-image.py
"""
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.normpath(os.path.join(HERE, '..', '..', 'web'))
OUT = os.path.join(WEB, 'og.png')

W, H = 1200, 630
BG = (7, 6, 11)
VIOLET = (139, 92, 246)
GLOW = (192, 132, 252)
LIGHT = (233, 213, 255)
MUTED = (161, 161, 170)

FONTS = [
    'C:/Windows/Fonts/seguibl.ttf',
    'C:/Windows/Fonts/segoeuib.ttf',
    'C:/Windows/Fonts/arialbd.ttf',
    'C:/Windows/Fonts/arial.ttf',
]


def font(size, bold=True):
    for path in (FONTS if bold else FONTS[1:] + ['C:/Windows/Fonts/segoeui.ttf']):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def main():
    img = Image.new('RGB', (W, H), BG)
    draw = ImageDraw.Draw(img)

    # --- Halo violet central (l'identite visuelle du site) ---
    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    steps = 46
    for i in range(steps, 0, -1):
        radius = int(720 * i / steps)
        alpha = int(2 + 16 * (1 - i / steps))
        gdraw.ellipse(
            [W // 2 - radius, 120 - radius // 2, W // 2 + radius, 120 + radius // 2],
            fill=(VIOLET[0], VIOLET[1], VIOLET[2], alpha),
        )
    img = Image.alpha_composite(img.convert('RGBA'), glow).convert('RGB')
    draw = ImageDraw.Draw(img)

    # --- Grille discrete ---
    for x in range(0, W, 40):
        draw.line([(x, 0), (x, H)], fill=(255, 255, 255, 6), width=1)
    for y in range(0, H, 40):
        draw.line([(0, y), (W, y)], fill=(255, 255, 255, 6), width=1)

    # --- Bouclier (logo) ---
    cx, cy, s = W // 2, 150, 52
    shield = [
        (cx, cy - s),
        (cx + s * 0.92, cy - s * 0.55),
        (cx + s * 0.92, cy + s * 0.25),
        (cx, cy + s * 1.05),
        (cx - s * 0.92, cy + s * 0.25),
        (cx - s * 0.92, cy - s * 0.55),
    ]
    draw.polygon(shield, fill=(24, 18, 42), outline=GLOW, width=3)
    f_mark = font(46)
    draw.text((cx, cy + 2), 'A', font=f_mark, fill=LIGHT, anchor='mm')

    # --- Titre ---
    draw.text((W // 2, 300), 'AUDIT HUB', font=font(96), fill=LIGHT, anchor='mm')

    # --- Sous-titre ---
    draw.text(
        (W // 2, 380),
        'Free Roblox key system  ·  Universal script loader',
        font=font(34, bold=False),
        fill=(216, 180, 254),
        anchor='mm',
    )

    # --- Puces de reassurance ---
    pills = ['12h & 24h keys', 'All executors', 'Instant game detection', 'Anti-sharing']
    f_pill = font(24, bold=False)
    widths = [draw.textlength(p, font=f_pill) + 44 for p in pills]
    gap = 18
    total = sum(widths) + gap * (len(pills) - 1)
    x = (W - total) / 2
    for pill, w in zip(pills, widths):
        draw.rounded_rectangle([x, 440, x + w, 492], radius=26, fill=(19, 16, 28), outline=VIOLET, width=1)
        draw.text((x + w / 2, 466), pill, font=f_pill, fill=MUTED, anchor='mm')
        x += w + gap

    # --- Ligne de pied ---
    draw.line([(120, 560), (W - 120, 560)], fill=(139, 92, 246, 120), width=1)
    draw.text(
        (W // 2, 592),
        'Loadstring once — the script follows your game automatically',
        font=font(22, bold=False),
        fill=MUTED,
        anchor='mm',
    )

    img.save(OUT, 'PNG', optimize=True)

    # Sanity check: l'image ne doit pas etre quasi vide
    small = img.convert('L').resize((60, 32))
    bright = sum(1 for p in small.getdata() if p > 90)
    print(f'{OUT} ecrit ({W}x{H}, {os.path.getsize(OUT) / 1024:.0f} Ko) · pixels clairs: {bright}')


if __name__ == '__main__':
    main()
