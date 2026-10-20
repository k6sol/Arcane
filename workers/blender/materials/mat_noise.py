"""Stateless hash noise for the material library (workers/blender/materials).

Every function is a pure function of its coordinates and an integer seed (no random state is
consumed), so a material can be re-evaluated at any point and gives the same value, and two runs
give identical bytes. ``period`` gives, per axis, the lattice period in cells (0 = none): tileable
textures snap their frequencies to whole cells per tile and wrap the lattice, so the noise is
exactly periodic. NumPy only (bundled with Blender; the test interpreter has it too).
"""
MASK = 0xFFFFFFFF


def seed_of(base, name):
    """Stable 31-bit sub-seed for a named layer (no Python hash randomisation)."""
    h = 2166136261
    for ch in (str(base) + ":" + name).encode():
        h = ((h ^ ch) * 16777619) & MASK
    return h & 0x7FFFFFFF


def hash01(np, i, j, k, seed):
    """Uniform [0, 1) from integer lattice coordinates (int64 arrays)."""
    v = (i * 374761393 + j * 668265263 + k * 1440670441 + (seed & 0xFFFF) * 144665 + (seed >> 16) * 2654435761) & MASK
    v = ((v ^ (v >> 13)) * 1274126177) & MASK
    v = ((v ^ (v >> 16)) * 2246822519) & MASK
    v = v ^ (v >> 13)
    return v.astype(np.float64) / 4294967296.0


def _wrap(i, p):
    return i % p if p else i


def smooth(np, a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def vnoise(np, q, seed, period=(0, 0, 0)):
    """Smooth 3D value noise in [0, 1] at lattice coordinates q (N, 3)."""
    c = np.floor(q)
    f = q - c
    s = f * f * (3 - 2 * f)
    i = c.astype(np.int64)
    x = [_wrap(i[:, 0] + d, period[0]) for d in (0, 1)]
    y = [_wrap(i[:, 1] + d, period[1]) for d in (0, 1)]
    z = [_wrap(i[:, 2] + d, period[2]) for d in (0, 1)]
    sx, sy, sz = s[:, 0], s[:, 1], s[:, 2]

    def lerp_x(b, cz):
        a0 = hash01(np, x[0], y[b], z[cz], seed)
        return a0 + (hash01(np, x[1], y[b], z[cz], seed) - a0) * sx
    out = []
    for cz in (0, 1):
        y0 = lerp_x(0, cz)
        out.append(y0 + (lerp_x(1, cz) - y0) * sy)
    return out[0] + (out[1] - out[0]) * sz


def fbm(np, q, seed, octaves=1, period=(0, 0, 0), gain=.5, texel=None):
    """Fractal value noise in [0, 1]. ``texel`` (lattice units per texel at the base octave, scalar
    or (N,)) fades each octave out before it reaches the texel Nyquist limit, so fine detail never
    aliases where texels are coarse."""
    total, weight, w = 0.0, 0.0, 1.0
    scale = 1.0
    per = tuple(period)
    for octave in range(octaves):
        if texel is not None:
            fade = np.clip((.5 - texel * scale) / .25, 0.0, 1.0)
            value = .5 + (vnoise(np, q * scale + octave * 31.7, seed + octave * 101, per) - .5) * fade
        else:
            value = vnoise(np, q * scale + octave * 31.7, seed + octave * 101, per)
        total = total + w * value
        weight += w
        w *= gain
        scale *= 2.0
        per = tuple(p * 2 for p in per)
    return total / weight


def ridge(np, q, seed, octaves=1, period=(0, 0, 0), texel=None):
    """Ridged noise in [0, 1]: 1 along the zero set of a noise field (veins, cracks, creases)."""
    return 1 - np.abs(2 * fbm(np, q, seed, octaves, period, .5, texel) - 1)


def cells(np, q, seed, period=(0, 0), jitter=.85):
    """2D Voronoi on lattice coordinates q (N, 2). Returns dict with ``f1`` (distance to the
    nearest site), ``edge`` (exact distance to the nearest cell border), ``id`` (per-cell uniform
    [0, 1)), ``id2``, ``id3`` (two more per-cell values) and ``rel`` (offset from the site), all in
    lattice units."""
    g = np.floor(q).astype(np.int64)
    f = q - g
    best = np.full(len(q), 1e9)
    mr = np.zeros((len(q), 2))
    mo = np.zeros((len(q), 2), dtype=np.int64)
    for oy in (-1, 0, 1):
        for ox in (-1, 0, 1):
            cx, cy = _wrap(g[:, 0] + ox, period[0]), _wrap(g[:, 1] + oy, period[1])
            px = ox + .5 + jitter * (hash01(np, cx, cy, 0, seed) - .5)
            py = oy + .5 + jitter * (hash01(np, cx, cy, 1, seed) - .5)
            rx, ry = px - f[:, 0], py - f[:, 1]
            d = rx * rx + ry * ry
            pick = d < best
            best = np.where(pick, d, best)
            mr[pick] = np.stack([rx[pick], ry[pick]], axis=1)
            mo[pick] = (ox, oy)
    edge = np.full(len(q), 1e9)
    for oy in range(-2, 3):
        for ox in range(-2, 3):
            bx, by = g[:, 0] + mo[:, 0] + ox, g[:, 1] + mo[:, 1] + oy
            cx, cy = _wrap(bx, period[0]), _wrap(by, period[1])
            px = (bx - g[:, 0]) + .5 + jitter * (hash01(np, cx, cy, 0, seed) - .5)
            py = (by - g[:, 1]) + .5 + jitter * (hash01(np, cx, cy, 1, seed) - .5)
            rx, ry = px - f[:, 0], py - f[:, 1]
            dx, dy = rx - mr[:, 0], ry - mr[:, 1]
            dl = np.sqrt(dx * dx + dy * dy)
            ok = dl > 1e-6
            e = ((.5 * (mr[:, 0] + rx)) * dx + (.5 * (mr[:, 1] + ry)) * dy) / np.where(ok, dl, 1.0)
            edge = np.where(ok, np.minimum(edge, e), edge)
    cx, cy = _wrap(g[:, 0] + mo[:, 0], period[0]), _wrap(g[:, 1] + mo[:, 1], period[1])
    return {"f1": np.sqrt(best), "edge": np.maximum(edge, 0.0), "id": hash01(np, cx, cy, 2, seed),
            "id2": hash01(np, cx, cy, 3, seed), "id3": hash01(np, cx, cy, 4, seed), "rel": -mr}


def segment_distance(np, px, py, ax, ay, bx, by):
    """Distance from points (px, py) to segments a-b (all broadcastable arrays)."""
    dx, dy = bx - ax, by - ay
    t = np.clip(((px - ax) * dx + (py - ay) * dy) / np.maximum(dx * dx + dy * dy, 1e-12), 0.0, 1.0)
    ex, ey = px - ax - t * dx, py - ay - t * dy
    return np.sqrt(ex * ex + ey * ey)


def box_blur(np, a, radius, periodic=True):
    """Separable box blur of a 2D grid (periodic wrap, or edge clamp)."""
    if radius < 1:
        return a
    out = a.astype(np.float64)
    for axis in (0, 1):
        if periodic:
            acc = out.copy()
            for k in range(1, radius + 1):
                acc = acc + np.roll(out, k, axis) + np.roll(out, -k, axis)
            out = acc / (2 * radius + 1)
        else:
            pad = [(0, 0), (0, 0)]
            pad[axis] = (radius, radius)
            padded = np.pad(out, pad, mode="edge")
            c = np.cumsum(padded, axis=axis)
            c = np.concatenate([np.zeros_like(np.take(c, [0], axis=axis)), c], axis=axis)
            n = out.shape[axis]
            out = (np.take(c, np.arange(2 * radius + 1, 2 * radius + 1 + n), axis=axis) - np.take(c, np.arange(0, n), axis=axis)) / (2 * radius + 1)
    return out
