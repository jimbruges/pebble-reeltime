#!/usr/bin/env python3
"""Generate a 48x48 black-on-transparent fish icon (pure Python PNG)."""
import struct
import zlib
import os

W = H = 48
px = [[(0, 0, 0, 0) for _ in range(W)] for _ in range(H)]
BLACK = (17, 17, 17, 255)
WHITE = (255, 255, 255, 255)


def setp(x, y, c):
    if 0 <= x < W and 0 <= y < H:
        px[y][x] = c


# body ellipse
cx, cy, rx, ry = 20, 24, 14, 9
for y in range(H):
    for x in range(W):
        if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0:
            setp(x, y, BLACK)

# tail: triangle opening right
for x in range(33, 47):
    spread = int(round((x - 33) * 10 / 12.0))
    for y in range(cy - spread, cy + spread + 1):
        setp(x, y, BLACK)

# dorsal fin
for x in range(16, 27):
    h = 6 - abs(x - 20)
    if h > 0:
        top = cy - ry + 1
        for y in range(top - h, top):
            setp(x, y, BLACK)

# eye
for y in range(18, 23):
    for x in range(11, 16):
        if (x - 13) ** 2 + (y - 20.5) ** 2 <= 5:
            setp(x, y, WHITE)


def write_png(path):
    raw = b""
    for row in px:
        raw += b"\x00" + b"".join(struct.pack("4B", *p) for p in row)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..", "resources", "images")
    os.makedirs(out, exist_ok=True)
    dest = os.path.join(out, "menu_icon.png")
    write_png(dest)
    print("wrote", os.path.abspath(dest))
