"""Pre-bake the gallery's 3D textures so the browser doesn't have to build them at load time.

Run from the project root:  python tools/bake_textures.py
Re-run whenever an artwork in site/assets/works changes.
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent / "site" / "assets"
WORKS = ROOT / "works"
OUT = ROOT / "tex"
OUT.mkdir(exist_ok=True)
(OUT / "normal").mkdir(exist_ok=True)
rng = np.random.default_rng(7)

DRAWINGS = {"portrait-in-stripes", "graphite-rose", "the-couple", "charcoal-dog"}


def to_normal(h, strength, wrap):
    """Height field (0..1 float array) -> RGB tangent-space normal map (Sobel)."""
    if wrap:
        s = lambda dx, dy: np.roll(np.roll(h, -dy, 0), -dx, 1)
    else:
        p = np.pad(h, 1, mode="edge")
        s = lambda dx, dy: p[1 + dy:p.shape[0] - 1 + dy, 1 + dx:p.shape[1] - 1 + dx]
    gx = (s(1, -1) + 2 * s(1, 0) + s(1, 1)) - (s(-1, -1) + 2 * s(-1, 0) + s(-1, 1))
    gy = (s(-1, 1) + 2 * s(0, 1) + s(1, 1)) - (s(-1, -1) + 2 * s(0, -1) + s(1, -1))
    n = np.dstack([-gx * strength, gy * strength, np.ones_like(h)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8))


def tile_noise(size, octaves, amp=0.5):
    """Seamless multi-octave value noise in 0..1."""
    acc = np.full((size, size), 0.5)
    for i, cells in enumerate(octaves):
        g = Image.fromarray((rng.random((cells, cells)) * 255).astype(np.uint8))
        big = g.resize((cells * 3, cells * 3), Image.NEAREST)
        # tile 3x3 and resize so edges interpolate across the wrap, then crop the middle
        tiled = Image.new("L", (cells * 3, cells * 3))
        for x in range(3):
            for y in range(3):
                tiled.paste(g, (x * cells, y * cells))
        up = np.asarray(tiled.resize((size * 3, size * 3), Image.BICUBIC), dtype=np.float64)[size:size * 2, size:size * 2] / 255
        acc += (up - 0.5) * amp / (i * 0.55 + 1)
    return np.clip(acc, 0, 1)


# --- artwork relief: brushstrokes + canvas weave / paper tooth -----------------
for f in sorted(WORKS.glob("*.jpg")):
    img = Image.open(f).convert("L")
    img.thumbnail((512, 512), Image.LANCZOS)
    paint = f.stem not in DRAWINGS
    h = np.asarray(img.filter(ImageFilter.GaussianBlur(1.4 if paint else 1.5)), dtype=np.float64) / 255
    yy, xx = np.mgrid[0:h.shape[0], 0:h.shape[1]]
    if paint:
        weave = np.sin(xx * 2.1) * np.sin(yy * 2.1 + ((xx // 3) % 2) * np.pi) * 0.07
        h = h * 0.35 + weave
        strength = 3.2
    else:
        h = h * 0.1 + rng.normal(0, 0.03, h.shape)
        strength = 1.4
    to_normal(h, strength, wrap=False).save(OUT / "normal" / f.name, quality=80)
    print("normal", f.name, img.size)

# --- plaster wall normal (tileable) -------------------------------------------
to_normal(tile_noise(512, [6, 12, 24, 48, 96, 192, 384], 0.55), 1.6, wrap=True).save(OUT / "plaster-normal.jpg", quality=90)

# --- polished concrete colour + roughness (tileable) ---------------------------
size = 1024
n = tile_noise(size, [3, 6, 12, 24, 48], 0.32)
base = np.array([111, 110, 106], dtype=np.float64)  # warm grey
col = base[None, None, :] * (0.55 + n[..., None] * 0.9)
fleck = rng.random((size, size))
col += rng.normal(0, 7, (size, size))[..., None]
col[fleck > 0.9985] += 46
col[fleck < 0.0015] -= 40
yy, xx = np.mgrid[0:size, 0:size]
for _ in range(26):  # soft trowel clouds
    cx, cy, r = rng.random() * size, rng.random() * size, 80 + rng.random() * 260
    d = np.hypot(((xx - cx + size / 2) % size) - size / 2, ((yy - cy + size / 2) % size) - size / 2)
    fall = np.clip(1 - d / r, 0, 1)
    col += (fall * (18 if rng.random() > 0.5 else -20))[..., None]
col[:3, :] *= 0.35  # control joints
col[:, :3] *= 0.35
Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)).save(OUT / "concrete.jpg", quality=86)

rough = 0.35 + tile_noise(512, [4, 8, 16, 32], 0.6) * 0.3
Image.fromarray((rough * 255).astype(np.uint8)).save(OUT / "concrete-rough.jpg", quality=90)
print("done")
