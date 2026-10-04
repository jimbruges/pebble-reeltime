#!/usr/bin/env python3
"""Rasterize stroke_font_data.h into a PNG for visual verification."""
import re, sys
from PIL import Image, ImageDraw

hdr = open('src/c/stroke_font_data.h').read()
pts = re.search(r'static const int8_t sf_points\[\] = \{([\s\S]*?)\};', hdr).group(1)
points = [int(v) for v in pts.split(',') if v.strip()]
recs = re.findall(r'\{(\d+), (\d+), (-?\d+), (-?\d+)\}, // (\S)', hdr)
glyphs = [(int(o), int(n), int(xm), int(av), ch) for o, n, xm, av, ch in recs]
PENUP = -128

def layout(s, scale):
    """returns list of polylines in pixels, plus width"""
    x = 0
    polys = []
    for ch in s:
        if ch == ' ':
            x += 10
            continue
        g = None
        for rec in glyphs:
            if rec[4] == ch:
                g = rec
                break
        if g is None:
            continue
        off, npts, xmin, adv, _ = g
        cur = []
        for i in range(0, npts, 2):
            px, py = points[off + i], points[off + i + 1]
            if px == PENUP and py == PENUP:
                if cur:
                    polys.append(cur)
                cur = []
                continue
            cur.append(((px - xmin + x) * scale, (py + 12) * scale))
        if cur:
            polys.append(cur)
        x += adv
    return polys, x * scale

strings = sys.argv[1:] or ['10:45 AM', '12:34:56', '7890', 'Pothys calomira.', 'TUE 2 OCT']
scale = 3
W, H = 700, 90 * len(strings) + 20
img = Image.new('RGB', (W, H), 'white')
d = ImageDraw.Draw(img)
y = 15
for s in strings:
    polys, w = layout(s, scale)
    for p in polys:
        if len(p) >= 2:
            d.line([tuple(pt) for pt in p], fill='black', width=3, joint='curve')
    d.text((w + 20, y), s, fill='red')
    y += 90
out = 'tools/font_check.png'
img.save(out)
print('wrote', out)
