# Skyburn Phase 5 (Task 5.1) - PWA icon generator.
# Generates all manifest.json icons as ORIGINAL procedural artwork (golden rule: no assets
# copied from any existing game): a navy roundel + cyan horizon + white delta-wing jet.
# Pure standard library (zlib + struct) - no PIL/numpy dependency on the build machine.
#
# Usage: python tools/gen_icons.py   (writes icons/*.png, idempotent)
#
# Icons produced (referenced by manifest.json):
#   icon-64.png            favicon / tiny
#   icon-192.png           PWA "any" + apple-touch-icon
#   icon-512.png           PWA "any" (install prompt needs 512)
#   maskable-192/512.png   "maskable" variants (art inside the 80% safe zone, full bleed)

import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'icons')

# Palette (matches the game HUD: dark navy panels, cyan accents, off-white jet)
BG_TOP = (10, 14, 20)        # #0a0e14
BG_BOTTOM = (24, 44, 62)     # #182c3e
ROUNDEL = (13, 34, 51)       # #0d2233
RING = (78, 140, 175)        # #4e8caf
HORIZON = (46, 126, 168)     # #2e7ea8
JET = (234, 244, 251)        # #eaf4fb
CANOPY = (13, 34, 51)        # #0d2233
ACCENT = (126, 212, 255)     # #7ed4ff


def _chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data +
            struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))


def write_png(path, size, pixels):
    """pixels: flat bytearray RGBA8, row-major, length size*size*4. Filter 0 scanlines."""
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw += pixels[y * stride:(y + 1) * stride]
    png = (b'\x89PNG\r\n\x1a\n' +
           _chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) +
           _chunk(b'IDAT', zlib.compress(bytes(raw), 9)) +
           _chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


def _inside_rounded_square(x, y, radius):
    """x,y in [0,1]; radius as fraction of side. True inside the rounded shape."""
    r = radius
    cx = min(max(x, r), 1.0 - r)
    cy = min(max(y, r), 1.0 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def _inside_circle(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def _inside_ring(x, y, cx, cy, r, w):
    d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    return abs(d - r) <= w


def _inside_poly(x, y, pts):
    """Even-odd point-in-polygon over a closed vertex list."""
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > y) != (yj > y):
            xint = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < xint:
                inside = not inside
        j = i
    return inside


def _inside_seg(x, y, ax, ay, bx, by, half_w):
    """Distance-to-segment <= half_w (thick stroke)."""
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    if l2 <= 0.0:
        return (x - ax) ** 2 + (y - ay) ** 2 <= half_w * half_w
    t = ((x - ax) * dx + (y - ay) * dy) / l2
    t = min(1.0, max(0.0, t))
    px, py = ax + t * dx, ay + t * dy
    return (x - px) ** 2 + (y - py) ** 2 <= half_w * half_w


def _jet_polygon(scale):
    """Delta-wing jet silhouette pointing up, centered near (0.5, 0.47), unit space.
    Original geometry: nose, swept main wings, notched tail - no existing-game art."""
    s = scale
    cx, cy = 0.5, 0.47
    def p(dx, dy):
        return (cx + dx * s, cy + dy * s)
    return [
        p(0.000, -0.285),   # nose tip
        p(0.055, -0.145),   # fuselage shoulder R
        p(0.275, 0.115),    # right wing tip leading
        p(0.275, 0.165),    # right wing tip trailing
        p(0.075, 0.150),    # right wing root trailing
        p(0.075, 0.235),    # right stabilizer tip
        p(0.030, 0.235),    # right stabilizer root
        p(0.000, 0.180),    # tail notch
        p(-0.030, 0.235),
        p(-0.075, 0.235),
        p(-0.075, 0.150),
        p(-0.275, 0.165),
        p(-0.275, 0.115),
        p(-0.055, -0.145),  # fuselage shoulder L
    ]


def render(size, maskable=False, ss=2):
    """Render one icon at `size` px with `ss`x supersampling (box filter down)."""
    W = size * ss
    buf = bytearray(W * W * 4)
    jet = _jet_polygon(0.62 if not maskable else 0.46)
    ring_w = 0.014
    horizon_hw = 0.006
    chev_hw = 0.011
    for py in range(W):
        y = (py + 0.5) / W
        # vertical background gradient (row-constant -> compute once per row)
        t = y
        bg_r = int(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
        bg_g = int(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
        bg_b = int(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
        for px in range(W):
            x = (px + 0.5) / W
            o = (py * W + px) * 4
            if not maskable and not _inside_rounded_square(x, y, 0.18):
                continue  # stays transparent (bytearray zero-init)
            buf[o + 3] = 255
            r, g, b = bg_r, bg_g, bg_b
            # roundel fill + ring + horizon
            if _inside_circle(x, y, 0.5, 0.47, 0.40):
                r, g, b = ROUNDEL
                if _inside_ring(x, y, 0.5, 0.47, 0.40, ring_w):
                    r, g, b = RING
                elif abs(y - 0.47) <= horizon_hw and abs(x - 0.5) <= 0.40:
                    r, g, b = HORIZON
            # jet silhouette (with canopy cutout) or contrail chevrons below
            if _inside_poly(x, y, jet):
                r, g, b = JET
                if ((x - 0.5) / 0.045) ** 2 + ((y - 0.345) / 0.075) ** 2 <= 1.0:
                    r, g, b = CANOPY
            elif (_inside_seg(x, y, 0.375, 0.795, 0.5, 0.745, chev_hw) or
                  _inside_seg(x, y, 0.5, 0.745, 0.625, 0.795, chev_hw)):
                r, g, b = ACCENT
            buf[o] = r
            buf[o + 1] = g
            buf[o + 2] = b
    # box downsample ss x ss -> size, premultiplied alpha average (no dark halos)
    out = bytearray(size * size * 4)
    for oy in range(size):
        for ox in range(size):
            ar = ag = ab = aa = 0
            for sy in range(ss):
                base = ((oy * ss + sy) * W + ox * ss) * 4
                for sx in range(ss):
                    o = base + sx * 4
                    a = buf[o + 3]
                    aa += a
                    ar += buf[o] * a
                    ag += buf[o + 1] * a
                    ab += buf[o + 2] * a
            d = (oy * size + ox) * 4
            if aa == 0:
                continue  # fully transparent pixel stays zero
            out[d] = ar // aa
            out[d + 1] = ag // aa
            out[d + 2] = ab // aa
            out[d + 3] = aa // (ss * ss)
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    jobs = [
        ('icon-64.png', 64, False, 4),
        ('icon-192.png', 192, False, 2),
        ('icon-512.png', 512, False, 2),
        ('maskable-192.png', 192, True, 2),
        ('maskable-512.png', 512, True, 2),
    ]
    for name, size, maskable, ss in jobs:
        pixels = render(size, maskable=maskable, ss=ss)
        write_png(os.path.join(OUT_DIR, name), size, pixels)
        print('[icons] %s  (%dx%d, %s)' % (name, size, size,
              'maskable' if maskable else 'any'))
    print('[icons] OK: %d files in %s' % (len(jobs), OUT_DIR))


if __name__ == '__main__':
    main()

