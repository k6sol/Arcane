"""Procedural PBR material families (original, authored from noise, Voronoi, waves and masks).

Each family is ``fn(np, dom, prm) -> Layers`` over a mat_core.Domain: linear albedo, height in
metres, roughness, metallic, optional emission, the pattern ``recess`` mask (mortar, gaps, grooves)
and what wear reveals. Feature sizes are physical (metres) times ``prm["scale"]``; in tile mode the
domain snaps them so they repeat a whole number of times per tile. Metals use measured-style
reflectance (F0) as base colour with metallic 1; oxides, rust, dirt and patina are dielectric.
"""
import math

from mat_core import Layers, mix, desaturate, luminance
from mat_noise import hash01, smooth, segment_distance


def V(np, c):
    return np.array(c, dtype=float)


def _per(dom, period_cells, index):
    return index % period_cells if period_cells else index


def _jgrid(np, x, length, jitter, seed, n, salt):
    """Jittered 1D partition: (index, start, end) with boundaries k*L + jitter*L*(h-.5)."""
    k = np.floor(x / length).astype(np.int64)

    def bound(i):
        ii = i % n if n else i
        return i * length + jitter * length * (hash01(np, ii, salt, 0, seed) - .5)
    b0, b1 = bound(k), bound(k + 1)
    idx = np.where(x < b0, k - 1, np.where(x >= b1, k + 1, k))
    return idx, bound(idx), bound(idx + 1)


def blocks(np, dom, a, b, height, length, name, row_jitter=0.0, col_jitter=0.0, bond="random"):
    """Courses of rectangular units (bricks, ashlar, planks): unit id, edge distance, local coords."""
    seed = dom.key(name)
    height = dom.fit(height, 2 if bond == "running" else 1)
    length = dom.fit(length)
    nh, nl = dom.count_of(height), dom.count_of(length)
    row, rs, re = _jgrid(np, b, height, row_jitter, seed, nh, np.zeros_like(b, dtype=np.int64) + 7)
    rw = _per(dom, nh, row)
    if bond == "running":
        offset = (rw % 2) * .5 * length
    else:
        offset = hash01(np, rw, 3, 1, seed) * length
    x = a + offset
    col, cs, ce = _jgrid(np, x, length, col_jitter, seed + 1, nl, rw)
    cw = _per(dom, nl, col)
    lx, ly = x - cs, b - rs
    w, h = ce - cs, re - rs
    edge = np.minimum(np.minimum(lx, w - lx), np.minimum(ly, h - ly))
    uid = hash01(np, cw, rw, 5, seed)
    return {"id": uid, "id2": hash01(np, cw, rw, 6, seed), "id3": hash01(np, cw, rw, 7, seed), "edge": edge,
            "lx": lx, "ly": ly, "w": w, "h": h, "row": rw, "col": cw, "dx": np.minimum(lx, w - lx), "dy": np.minimum(ly, h - ly)}


def palette(np, ids, colours):
    """Pick per-unit colours from a small palette with smooth interpolation."""
    colours = V(np, colours)
    t = np.clip(ids, 0, .999999) * (len(colours) - 1)
    i = np.floor(t).astype(np.int64)
    f = (t - i)[:, None]
    return colours[i] + (colours[np.minimum(i + 1, len(colours) - 1)] - colours[i]) * f


# ------------------------------------------------------------------- woods --
def _rings(np, dom, a, b, c, board, spacing, name, tilt=.06):
    """Growth rings of a board sawn off a log: distance from a pith line that runs near the board
    (per-board offset and slow tilt), warped. Returns (latewood mask, ring fade)."""
    seed = dom.key(name)
    h1, h2, h3 = (hash01(np, board, 11 + k, 3, seed) for k in range(3))
    pb = (h1 - .5) * .3
    pc = -(.03 + .25 * h2)
    period = dom.tile
    wave = np.sin(a * (2 * math.pi / period if period else 1.7) * max(1, round((period or 3.0) / 1.5)) + h3 * 6.283)
    pc_line = pc + tilt * wave * (.4 + h2)
    warp = dom.noise(name + "-warp", 3.0, 3, stretch=(.2, 6.0, 6.0), space="f")
    db, dc = b - pb, c - pc_line
    rho = np.sqrt(db * db + dc * dc) + .006 * (warp - .5) * (1 + 4 * h2)
    rings = rho / spacing
    # On-surface ring frequency (|grad rho| / spacing) fades rings that would alias.
    grad = np.abs(db) / np.maximum(rho, 1e-6) + np.abs(tilt * dc) / np.maximum(rho, 1e-6) * .5 + .02
    fade = np.clip((.38 - grad / spacing * dom.texel) / .2, 0, 1)
    r = rings % 1.0
    late = smooth(np, .5, .86, r) * (1 - smooth(np, .9, 1.0, r))
    return late, fade


def _wood(np, dom, base, a, b, c, board, prm, name, spacing=.0045, knots=True):
    """Shared wood grain: rings, fibres, pores, knots; per-board tone. Returns dict."""
    s = prm["scale"]
    late, fade = _rings(np, dom, a, b, c, board, spacing * s, name)
    fibre = dom.noise(name + "-fibre", 260.0 / s, 2, stretch=(.03, 1.0, 1.0), space="f")
    streak = dom.noise(name + "-streak", 22.0 / s, 3, stretch=(.08, 1.0, 1.0), space="f")
    pores = smooth(np, .66, .8, dom.noise(name + "-pores", 420.0 / s, 1, stretch=(.08, 1.0, 1.0), space="f"))
    seed = dom.key(name)
    tone = 1 + .38 * (hash01(np, board, 21, 0, seed) - .5)
    hue = hash01(np, board, 22, 0, seed) - .5
    knot = np.zeros(dom.count)
    ring_mix = late * fade + .5 * (1 - fade) * .55
    if knots:
        cell = dom.voronoi(name + "-knots", 2.2 / s, stretch=(.6, 1.6))
        has = cell["id"] < .3
        radius = (.008 + .012 * cell["id2"]) * s
        d = cell["f1"]
        halo = smooth(np, radius * 3.2, radius * .9, d) * has
        kr = (d / (spacing * s * .55)) % 1.0
        ring_mix = mix(ring_mix, smooth(np, .45, .85, kr) * (1 - smooth(np, .9, 1, kr)), halo * .9)
        knot = smooth(np, radius, radius * .55, d) * has
    early = V(np, base) * np.array([1.12, 1.1, 1.06])
    latec = V(np, base) * np.array([.74, .66, .6])
    albedo = mix(early, latec, ring_mix[:, None])
    albedo = albedo * (tone * (.86 + .2 * fibre + .32 * (streak - .5)))[:, None]
    albedo = albedo * (1 + hue[:, None] * np.array([.1, 0, -.12]))
    albedo = albedo * (1 - .25 * pores)[:, None]
    knotc = V(np, base) * np.array([.35, .24, .18])
    albedo = mix(albedo, knotc, knot[:, None])
    height = -.00025 * ring_mix - .00012 * pores + .00008 * fibre + .0004 * knot
    rough = .62 + .08 * (fibre - .5) - .05 * ring_mix + .1 * pores
    return {"albedo": albedo, "height": height, "rough": rough, "late": ring_mix, "fibre": fibre, "streak": streak, "knot": knot}


def _planks(np, dom, prm, name, width=.15, length=1.6, gap=.003):
    s = prm["scale"]
    a, b, c = dom.f[:, 0], dom.f[:, 1], dom.f[:, 2]
    # joints 0: continuous boards (barrel staves, long boards) with no end joints.
    u = blocks(np, dom, a, b, width * s, length * s if prm.get("joints", 1.0) >= .5 else 1000.0, name, 0.0, .2, "random")
    board = (u["row"] * 7919 + u["col"] * 104729) % 1000003
    gap_w = dom.aa(gap * s)
    # seams 0: no modelled gaps (the mesh already has its boards), only per-board tone.
    show = 1.0 if prm.get("seams", 1.0) >= .5 else 0.0
    seam = (1 - smooth(np, 0, gap_w, u["dy"])) * show
    joint = (1 - smooth(np, 0, gap_w * .7, u["dx"])) * show
    edge_round = (1 - smooth(np, 0, dom.aa(.006 * s), u["edge"])) * show
    lb = u["ly"] - u["h"] * .5
    # Each board sits at its own small height and cups slightly across its width.
    level = (u["id"] - .5) * .0008 - .0006 * (lb / np.maximum(u["h"] * .5, 1e-6)) ** 2
    return u, board, np.maximum(seam, joint), edge_round, level, (a, u["ly"] - u["h"] * .5, c)


def _nails(np, dom, u, s, name):
    """Two nail heads near each board end."""
    r = dom.aa(.0035 * s)
    off = .035 * s
    dx_end = np.minimum(u["lx"], u["w"] - u["lx"]) - off
    dy1 = u["ly"] - u["h"] * .27
    dy2 = u["ly"] - u["h"] * .73
    dy = np.where(np.abs(dy1) < np.abs(dy2), dy1, dy2)
    d = np.sqrt(dx_end ** 2 + dy ** 2)
    return smooth(np, r, r * .55, d), (dx_end, dy)


def wood_planks(np, dom, prm):
    s = prm["scale"]
    u, board, gap, rounded, level, (a, lb, c) = _planks(np, dom, prm, "planks")
    w = _wood(np, dom, prm["color"], dom.f[:, 0], lb, c, board, prm, "planks")
    nail, _ = _nails(np, dom, u, s, "planks")
    nail = nail * (1.0 if prm.get("seams", 1.0) >= .5 else 0.0)
    albedo = w["albedo"] * (1 - .55 * gap - .18 * rounded)[:, None]
    albedo = mix(albedo, V(np, (.025, .02, .015)), gap[:, None] * .8)
    iron = V(np, (.3, .29, .28))
    albedo = mix(albedo, iron, nail[:, None])
    height = level + w["height"] - .003 * s * gap - .0012 * rounded ** 2 + .0002 * nail
    rough = mix(w["rough"], np.full(dom.count, .5), nail)
    metal = nail * .9
    return Layers(albedo, height, rough, metal, recess=np.maximum(gap, .6 * rounded),
                  under={"albedo": w["albedo"] * 1.28, "rough": w["rough"] - .1, "metal": metal},
                  aged={"albedo": desaturate(np, w["albedo"], .7) * 1.15 + .02, "rough": np.minimum(w["rough"] + .2, 1)})


def wood_endgrain(np, dom, prm):
    s = prm["scale"]
    a, b = dom.f[:, 0], dom.f[:, 1]
    u = blocks(np, dom, a, b, .11 * s, .11 * s, "endgrain", 0.0, 0.0, "random")
    seed = dom.key("endgrain")
    cx = (hash01(np, u["col"], u["row"], 31, seed) * 1.6 - .3) * u["w"]
    cy = (hash01(np, u["col"], u["row"], 32, seed) * 1.6 - .3) * u["h"]
    dx, dy = u["lx"] - cx, u["ly"] - cy
    rho = np.sqrt(dx * dx + dy * dy)
    theta = np.arctan2(dy, dx)
    warp = dom.noise("endgrain-warp", 30.0 / s, 3, space="f")
    spacing = .0075 * s
    rings = (rho + .004 * (warp - .5) + .0015 * np.sin(theta * 7 + u["id"] * 6)) / spacing
    fade = np.clip((.6 - dom.texel / spacing) / .3, 0, 1)
    r = rings % 1.0
    late = smooth(np, .55, .88, r) * (1 - smooth(np, .92, 1, r)) * fade + .3 * (1 - fade)
    pores = smooth(np, .6, .8, dom.noise("endgrain-pores", 380.0 / s, 1, space="f"))
    # Radial checks (drying cracks) from the pith.
    crack = np.zeros(dom.count)
    for k in range(2):
        ck = hash01(np, u["col"], u["row"], 34 + k, seed) * 6.283
        reach = (.25 + .45 * hash01(np, u["col"], u["row"], 36 + k, seed)) * u["w"]
        off = np.abs(np.sin(theta - ck)) * rho
        ahead = np.cos(theta - ck) > 0
        width = dom.aa(.0016 * s) * np.clip(1 - rho / reach, .05, 1)
        crack = np.maximum(crack, smooth(np, width, width * .2, off) * ahead * (rho < reach) * (hash01(np, u["col"], u["row"], 38 + k, seed) < .55))
    base = V(np, prm["color"])
    tone = 1 + .22 * (u["id"] - .5)
    albedo = mix(base * np.array([1.05, 1.0, .95]), base * np.array([.6, .5, .42]), late[:, None]) * (tone * (1 - .3 * pores))[:, None]
    glue = 1 - smooth(np, 0, dom.aa(.0012 * s), u["edge"])
    albedo = albedo * (1 - .7 * glue - .6 * crack)[:, None]
    height = -.0003 * late - .0002 * pores - .002 * crack - .001 * glue + (u["id2"] - .5) * .0004
    rough = .78 + .08 * pores - .05 * late
    return Layers(albedo, height, rough, np.zeros(dom.count), recess=np.maximum(glue, crack),
                  under={"albedo": albedo * 1.25, "rough": rough - .08})


def wood_painted(np, dom, prm):
    s = prm["scale"]
    u, board, gap, rounded, level, (a, lb, c) = _planks(np, dom, prm, "painted")
    w = _wood(np, dom, (.3, .17, .08), dom.f[:, 0], lb, c, board, prm, "painted", knots=False)
    brush = dom.noise("painted-brush", 90.0 / s, 2, stretch=(.05, 1.0, 1.0), space="f")
    paint = V(np, prm["color"]) * (.93 + .1 * brush + .05 * (u["id"] - .5))[:, None]
    # Age crazes the paint into small flakes that lift and fall away.
    flakes = dom.voronoi("painted-flakes", 70.0 / s, jitter=.9)
    peel = smooth(np, .7, .8, dom.noise("painted-peel", 6.0 / s, 4) + .3 * prm["age"] - .15 + .25 * (1 - smooth(np, 0, .02 * s, u["dy"])))
    crack = (1 - smooth(np, 0, dom.aa(.0007 * s), flakes["edge"])) * smooth(np, .05, .3, prm["age"]) * smooth(np, .2, .6, dom.noise("painted-craze", 6.0 / s, 2))
    lost = peel * (flakes["id"] < .25 + .45 * prm["age"])
    albedo = mix(paint, w["albedo"], np.maximum(lost, .0)[:, None])
    albedo = albedo * (1 - .5 * gap - .1 * rounded - .45 * crack)[:, None]
    albedo = mix(albedo, V(np, (.03, .025, .02)), gap[:, None] * .75)
    height = level + .35 * w["height"] - .003 * s * gap - .001 * rounded ** 2 + .00025 * (1 - lost) - .0002 * crack + .00006 * brush
    rough = mix(np.full(dom.count, .42) + .08 * brush, w["rough"], lost)
    return Layers(albedo, height, rough, np.zeros(dom.count), recess=np.maximum(gap, crack),
                  under={"albedo": w["albedo"] * 1.15, "rough": w["rough"]}, chip=.0004,
                  aged={"albedo": desaturate(np, albedo, .2) * 1.06 + .008, "rough": rough + .1})


def wood_weathered(np, dom, prm):
    s = prm["scale"]
    u, board, gap, rounded, level, (a, lb, c) = _planks(np, dom, prm, "weathered", width=.17, length=2.0, gap=.005)
    w = _wood(np, dom, prm["color"], dom.f[:, 0], lb, c, board, prm, "weathered", spacing=.0055)
    silver = V(np, (.24, .23, .21)) * (1 + .25 * (u["id2"] - .5))[:, None]
    weathering = smooth(np, .25, .7, dom.noise("weathered-silver", 3.0 / s, 3) * .7 + .5 * u["id3"])
    grain_lum = luminance(np, w["albedo"]) / max(float(luminance(np, V(np, prm["color"])[None, :])[0]), 1e-4)
    albedo = mix(w["albedo"], silver * (.75 + .35 * grain_lum)[:, None], (.55 + .45 * weathering)[:, None])
    # Raised grain: soft early wood erodes, late wood and fibres stand proud.
    checks = smooth(np, .94, .985, dom.ridges("weathered-checks", 70.0 / s, 1, stretch=(.03, 1.0, 1.0), space="f")) * smooth(np, .5, .7, dom.noise("weathered-checkmask", 3.0 / s, 2))
    nail, (ndx, ndy) = _nails(np, dom, u, s, "weathered")
    # Rust stains run down from each nail (+b is up in tile and box frames).
    below = -ndy
    stain = smooth(np, .008 * s, .0, np.abs(ndx)) * smooth(np, -.002 * s, .004 * s, below) * smooth(np, .07 * s, .0, below)
    albedo = mix(albedo, V(np, (.12, .05, .02)), (stain * .6)[:, None])
    albedo = albedo * (1 - .6 * checks - .5 * gap - .15 * rounded)[:, None]
    albedo = mix(albedo, V(np, (.06, .045, .03)), nail[:, None])
    height = level * 2 + .00045 * w["late"] + .00025 * (w["fibre"] - .5) - .0012 * checks - .004 * s * gap - .002 * rounded ** 2 + .0002 * nail
    rough = np.clip(.86 + .06 * (w["fibre"] - .5) + .05 * checks - .25 * nail, 0, 1)
    return Layers(albedo, height, rough, np.zeros(dom.count), recess=np.maximum.reduce([gap, checks, .6 * rounded]),
                  under={"albedo": w["albedo"] * 1.1, "rough": rough - .05}, chip=.0009)


# ------------------------------------------------------------------ stones --
def _grain(np, dom, s, name):
    g = dom.noise(name + "-grain", 160.0 / s, 2)
    speck = dom.noise(name + "-speck", 300.0 / s, 1)
    return g, speck


def stone_cobble(np, dom, prm):
    s = prm["scale"]
    warp = np.stack([dom.noise("cobble-wx", 9.0 / s, 2, space="f") - .5, dom.noise("cobble-wy", 9.0 / s, 2, space="f") - .5], axis=1) * .03 * s
    cell = dom.voronoi("cobble", 1.0 / (.14 * s), jitter=.9, warp=warp)
    joint = (.004 + .004 * dom.noise("cobble-joint", 12.0 / s, 2, space="f")) * s
    e = cell["edge"] - joint
    stone = smooth(np, 0, dom.aa(.004 * s), e)
    dome = np.sqrt(np.clip(e / (.035 * s), 0, 1)) * (1 - .35 * (cell["f1"] / (.09 * s)) ** 2)
    g, speck = _grain(np, dom, s, "cobble")
    base = V(np, prm["color"])
    tint = palette(np, cell["id"], [(.85, .82, .78), (1.05, .95, .82), (.9, .92, 1.0), (1.15, 1.08, .98), (.7, .68, .66)])
    stone_c = base * tint * (.78 + .4 * cell["id2"])[:, None]
    stone_c = stone_c * (.9 + .16 * g + .1 * (speck - .5))[:, None] * (.85 + .2 * dome)[:, None]
    mortar = V(np, (.12, .105, .085)) * (.8 + .4 * dom.noise("cobble-mortar", 40.0 / s, 2))[:, None]
    albedo = mix(mortar, stone_c, stone[:, None])
    height = stone * (.016 * s * dome + .002 * g) - (1 - stone) * .004 * s
    rough = mix(np.full(dom.count, .95), .82 - .22 * dome ** 2 + .05 * g, stone)
    return Layers(albedo, height, rough, np.zeros(dom.count), recess=1 - stone, chip=.0015,
                  under={"albedo": stone_c * 1.15, "rough": rough - .1})


def _block_face(np, dom, u, s, name, joint, chamfer):
    """Mortar mask and a chamfered, chipped block surface for ashlar/brick."""
    erode = (dom.noise(name + "-erode", 30.0 / s, 3, space="f") - .5) * chamfer * 1.4
    e = u["edge"] - joint * .5 + erode
    solid = smooth(np, 0, dom.aa(.002 * s), e)
    bevel = np.sqrt(np.clip(e / max(chamfer, 1e-4), 0, 1))
    return solid, bevel


def stone_ashlar(np, dom, prm):
    s = prm["scale"]
    a, b = dom.f[:, 0], dom.f[:, 1]
    u = blocks(np, dom, a, b, .32 * s, .62 * s, "ashlar", .22, .3, "random")
    solid, bevel = _block_face(np, dom, u, s, "ashlar", .011 * s, .02 * s)
    g, speck = _grain(np, dom, s, "ashlar")
    pits = smooth(np, .62, .8, dom.noise("ashlar-pits", 70.0 / s, 2))
    tooled = dom.noise("ashlar-tool", 50.0 / s, 2, stretch=(1.0, .25, 1.0), space="f")
    base = V(np, prm["color"])
    tint = palette(np, u["id"], [(.92, .92, .9), (1.05, 1.0, .92), (.96, .97, 1.0), (1.1, 1.04, .94), (.84, .82, .8)])
    face = dom.noise("ashlar-face", 4.0 / s, 3)
    block = base * tint * (.74 + .4 * u["id2"] + .3 * (face - .5))[:, None]
    block = block * (.92 + .1 * g + .08 * (speck - .5) - .18 * pits)[:, None] * (.88 + .12 * bevel)[:, None]
    mortar = V(np, (.3, .28, .25)) * (.75 + .4 * dom.noise("ashlar-mortar", 50.0 / s, 2))[:, None]
    albedo = mix(mortar, block, solid[:, None])
    height = solid * (.006 * s * bevel + .0008 * g - .0006 * pits + .0004 * tooled + (u["id3"] - .5) * .002 * s) - (1 - solid) * .006 * s
    rough = mix(np.full(dom.count, .94), .84 + .05 * pits - .04 * g, solid)
    return Layers(albedo, height, rough, np.zeros(dom.count), recess=1 - solid, chip=.002,
                  under={"albedo": block * 1.12, "rough": rough})


def stone_slate(np, dom, prm):
    s = prm["scale"]
    warp = np.stack([dom.noise("slate-wx", 4.0 / s, 2, space="f") - .5, dom.noise("slate-wy", 4.0 / s, 2, space="f") - .5], axis=1) * .06 * s
    cell = dom.voronoi("slate", 1.0 / (.42 * s), stretch=(.8, 1.2), jitter=.75, warp=warp)
    joint = .006 * s
    solid = smooth(np, 0, dom.aa(.003 * s), cell["edge"] - joint)
    cleft = dom.noise("slate-cleft", 6.0 / s, 4, stretch=(.6, 1.4, 1.0), space="f")
    levels = 5.0
    t = cleft * levels + 2.0 * cell["id"]
    terrace = np.floor(t) + smooth(np, .82, 1.0, t - np.floor(t))
    striae = dom.noise("slate-striae", 120.0 / s, 2, stretch=(.08, 1.0, 1.0), space="f")
    base = V(np, prm["color"])
    tint = palette(np, cell["id2"], [(.95, .97, 1.0), (1.0, 1.0, 1.0), (1.08, 1.02, .95), (.9, .92, .93)])
    rust = smooth(np, .66, .82, dom.noise("slate-rust", 5.0 / s, 3))
    slab = base * tint * (.8 + .3 * (terrace % 2) * .3 + .2 * (cleft - .5) + .1 * striae)[:, None]
    slab = mix(slab, V(np, (.16, .1, .06)), (rust * .5)[:, None])
    gap = V(np, (.03, .03, .03))
    albedo = mix(gap, slab, solid[:, None])
    step_edge = smooth(np, .82, .95, t - np.floor(t))
    height = solid * (.0012 * s * terrace / levels + .0002 * striae + (cell["id3"] - .5) * .003 * s) - (1 - solid) * .005 * s
    rough = mix(np.full(dom.count, .95), .62 + .14 * step_edge + .05 * striae + .1 * rust, solid)
    return Layers(albedo, height, rough, np.zeros(dom.count), recess=1 - solid, chip=.001,
                  under={"albedo": slab * 1.25, "rough": rough + .05})


def stone_marble(np, dom, prm):
    s = prm["scale"]
    # Classic warped-sine veins: a slow linear gradient (whole cycles per tile) bent by fractal
    # noise; veins sit where the sine crosses zero, the secondary set at another angle.
    a, bb = dom.f[:, 0], dom.f[:, 1]
    veins = []
    for name, (ka, kb), warp_k, width in (("marble-v1", (.55, .35), 2.4, .06), ("marble-v2", (-.3, .9), 1.8, .045)):
        fa, _ = dom.snap(ka / s) if ka > 0 else tuple(-x for x in dom.snap(-ka / s))
        fb, _ = dom.snap(kb / s)
        warp = dom.noise(name + "-warp", 1.3 / s, 6)
        t = a * fa + bb * fb + warp_k * (warp - .5)
        line = np.abs(np.sin(math.pi * t))
        texel_w = np.clip(dom.texel * (abs(fa) + abs(fb) + 4) * math.pi, 0, .5)
        thick = .6 + .8 * dom.noise(name + "-thick", 3.0 / s, 2)
        veins.append(np.maximum(1 - smooth(np, 0, width * thick + texel_w, line), .22 * (1 - smooth(np, 0, .45, line))))
    gate = smooth(np, .35, .6, dom.noise("marble-gate", 1.5 / s, 3))
    v1 = veins[0] * (.55 + .45 * gate) * .85
    v2 = veins[1] * smooth(np, .45, .7, dom.noise("marble-gate2", 2.0 / s, 3)) * .45
    cloud = dom.noise("marble-cloud", 3.0 / s, 4)
    base = V(np, prm["color"])
    vein = V(np, (.17, .18, .17))
    body = base * (.9 + .16 * cloud)[:, None] * (1 + (dom.noise("marble-warm", 1.2 / s, 2) - .5)[:, None] * np.array([.08, .03, -.06]))
    albedo = mix(body, vein, np.maximum(v1, v2 * .7)[:, None])
    albedo = mix(albedo, base * np.array([.85, .9, .86]), (v2 * .25)[:, None])
    scratch = smooth(np, .97, .995, dom.ridges("marble-scratch", 25.0 / s, 2))
    height = -.00008 * v1 - .00001 * scratch + .00004 * cloud
    rough = .13 + .06 * cloud + .08 * scratch + .04 * v1
    return Layers(albedo, height, rough, np.zeros(dom.count), recess=v1 * .3, chip=.0006,
                  under={"albedo": albedo * 1.05, "rough": rough + .25},
                  aged={"albedo": desaturate(np, albedo, .2) * .88 + V(np, (.02, .018, .01)), "rough": rough + .35})


def stone_sandstone(np, dom, prm):
    s = prm["scale"]
    b = dom.f[:, 1]
    layer = dom.fit(.11 * s)
    nl = dom.count_of(layer)
    warp = dom.noise("sand-bed", 1.2 / s, 4, stretch=(1.0, .6, 1.0), space="f")
    t = (b + .22 * s * (warp - .5)) / layer
    t = t + .25 * (dom.noise("sand-bed2", 4.0 / s, 3, space="f") - .5)
    idx = np.floor(t).astype(np.int64)
    wi = idx % nl if nl else idx
    seed = dom.key("sandstone")
    lh = hash01(np, wi, 0, 41, seed)
    base = V(np, prm["color"])
    band = palette(np, lh, [(1.18, 1.05, .9), (.85, .72, .62), (1.25, 1.06, .82), (1.0, .84, .7), (.78, .7, .66)])
    frac = t - idx
    soft = lh > .55
    g, speck = _grain(np, dom, s, "sand")
    tafoni = smooth(np, .6, .8, dom.noise("sand-taf-mask", 2.0 / s, 3)) * smooth(np, .55, .75, dom.noise("sand-pits", 35.0 / s, 2))
    nh = hash01(np, (wi + 1) % nl if nl else wi + 1, 0, 41, seed)
    blend = smooth(np, .45, 1.0, frac)
    albedo = base * band * (.9 + .12 * g + .12 * (speck - .5))[:, None]
    albedo = mix(albedo, base * palette(np, hash01(np, (wi + 1) % nl if nl else wi + 1, 0, 41, seed), [(1.18, 1.05, .9), (.85, .72, .62), (1.25, 1.06, .82), (1.0, .84, .7), (.78, .7, .66)]), blend[:, None] * .5) * (1 - .15 * tafoni)[:, None] * (.94 + .12 * speck)[:, None] * (1 + .1 * (dom.noise("sand-cross", 9.0 / s, 3, stretch=(1.0, 3.0, 1.0), space="f") - .5))[:, None]
    height = -.0003 * s * ((1 - blend) * lh + blend * nh) - .0012 * s * tafoni + .0005 * g + .0015 * s * dom.noise("sand-relief", 6.0 / s, 3)
    rough = .9 + .05 * (g - .5)
    return Layers(albedo, height, rough, np.zeros(dom.count), recess=.4 * tafoni, chip=.0012)


def concrete(np, dom, prm):
    s = prm["scale"]
    a, b = dom.f[:, 0], dom.f[:, 1]
    panel = blocks(np, dom, a, b, .6 * s, 1.2 * s, "concrete-panel", 0.0, 0.0, "running")
    seam = 1 - smooth(np, 0, dom.aa(.0015 * s), panel["edge"])
    # Tie holes at the panel quarter points.
    hx = np.minimum(np.abs(panel["lx"] - panel["w"] * .25), np.abs(panel["lx"] - panel["w"] * .75))
    hy = np.abs(panel["ly"] - panel["h"] * .5)
    hole = smooth(np, dom.aa(.012 * s), dom.aa(.012 * s) * .7, np.sqrt(hx * hx + hy * hy))
    mottle = dom.noise("concrete-mottle", 1.5 / s, 4)
    agg = dom.voronoi("concrete-agg", 1.0 / (.006 * s), jitter=.9)
    stones = smooth(np, .0005, .0015, agg["edge"]) * (agg["id"] < .35)
    bug = smooth(np, .82, .9, dom.noise("concrete-bug", 160.0 / s, 1)) * smooth(np, .4, .7, dom.noise("concrete-bugmask", 6.0 / s, 2))
    streak = dom.noise("concrete-streak", 3.0 / s, 3, stretch=(3.0, .15, 1.0), space="f")
    base = V(np, prm["color"])
    albedo = base * (.86 + .22 * mottle + .1 * (panel["id"] - .5))[:, None]
    albedo = albedo * (1 + .12 * stones * (agg["id2"] - .3))[:, None]
    albedo = albedo * (1 - .25 * smooth(np, .55, .8, streak) - .5 * bug - .3 * seam - .55 * hole)[:, None]
    height = .0004 * mottle - .0012 * bug + .0004 * seam + .00015 * stones - .006 * hole
    rough = .86 + .06 * (mottle - .5) - .1 * stones * .3
    return Layers(albedo, height, rough, np.zeros(dom.count), recess=np.maximum.reduce([bug, hole, seam * .5]), chip=.001)


def brick(np, dom, prm):
    s = prm["scale"]
    a, b = dom.f[:, 0], dom.f[:, 1]
    u = blocks(np, dom, a, b, .075 * s, .225 * s, "brick", 0.0, 0.0, "running")
    solid, bevel = _block_face(np, dom, u, s, "brick", .01 * s, .006 * s)
    g, speck = _grain(np, dom, s, "brick")
    pits = smooth(np, .7, .82, dom.noise("brick-pits", 140.0 / s, 1))
    base = V(np, prm["color"])
    tint = palette(np, u["id"], [(.55, .5, .52), (.85, .8, .78), (1.0, 1.0, 1.0), (1.12, 1.05, .9), (1.25, 1.1, .82)])
    flash = smooth(np, 0, 1, u["lx"] / np.maximum(u["w"], 1e-6)) * (u["id2"] - .5) * .25
    burnt = (u["id3"] < .12)
    brickc = base * tint * (.86 + .18 * g + .1 * (speck - .5) - .12 * pits + flash)[:, None]
    brickc = mix(brickc, brickc * np.array([.42, .4, .45]), burnt[:, None] * 1.0)
    mortar = V(np, (.36, .34, .3)) * (.8 + .35 * dom.noise("brick-mortar", 60.0 / s, 2))[:, None]
    albedo = mix(mortar, brickc, solid[:, None])
    height = solid * (.004 * s * bevel + .0004 * g - .0004 * pits) - (1 - solid) * .005 * s
    rough = mix(np.full(dom.count, .95), .86 + .06 * pits - .05 * burnt, solid)
    return Layers(albedo, height, rough, np.zeros(dom.count), recess=1 - solid, chip=.0015,
                  under={"albedo": brickc * 1.1, "rough": rough})


# ------------------------------------------------------------------ metals --
def _hammered(np, dom, s, name, size=.025):
    cell = dom.voronoi(name + "-dents", 1.0 / (size * s), jitter=.9)
    return -(1 - np.clip(cell["f1"] / (size * s * .7), 0, 1)) ** 2


def scratches(np, dom, s, name, size=.05, density=.6, width=.0004):
    """Straight hairline scratches: per Voronoi cell (and layer) one segment at a random angle,
    thinner than a texel only through its fade (never narrower than ~1 texel)."""
    out = np.zeros(dom.count)
    for k in range(2):
        cell = dom.voronoi("%s-scr%d" % (name, k), 1.0 / (size * s), jitter=.9)
        ang = cell["id"] * math.pi
        cs, sn = np.cos(ang), np.sin(ang)
        rx, ry = cell["rel"][:, 0] * size * s, cell["rel"][:, 1] * size * s
        along = rx * cs + ry * sn
        across = np.abs(-rx * sn + ry * cs)
        half = size * s * (.25 + .5 * cell["id2"])
        w = dom.aa(width * s)
        line = smooth(np, w, w * .3, across) * smooth(np, half, half * .7, np.abs(along)) * (cell["id3"] < density)
        out = np.maximum(out, line * (.5 + .5 * cell["id2"]))
    return out


def metal_iron(np, dom, prm):
    s = prm["scale"]
    f0 = V(np, prm["color"])
    dents = _hammered(np, dom, s, "iron")
    mottle = dom.noise("iron-mottle", 6.0 / s, 4)
    scale_mask = smooth(np, .3, .38, dom.noise("iron-scale", 7.0 / s, 5) + .05)
    oxide = V(np, (.045, .044, .046)) * (.75 + .5 * dom.noise("iron-oxide", 12.0 / s, 3))[:, None]
    bare = f0 * (.78 + .12 * mottle)[:, None]
    albedo = mix(bare, oxide, scale_mask[:, None])
    metal = 1 - scale_mask
    rough = mix(.42 + .14 * mottle, .58 + .1 * mottle, scale_mask)
    pits = smooth(np, .82, .92, dom.noise("iron-pits", 120.0 / s, 1))
    height = .0004 * s * dents - .0002 * pits + .0001 * mottle
    rough = rough + .1 * pits
    return Layers(albedo, height, rough, metal, recess=pits * .5, chip=.0003,
                  under={"albedo": f0 * .82, "rough": np.full(dom.count, .42), "metal": np.ones(dom.count)},
                  aged={"albedo": mix(albedo, V(np, (.12, .05, .025)), .5), "rough": rough + .25, "metal": metal * .4})


def _rust(np, dom, s, name, coverage):
    mask_n = dom.noise(name + "-cover", 3.0 / s, 5)
    cav = dom.cavity if dom.cavity is not None else np.zeros(dom.count)
    amount = smooth(np, .5, .56, mask_n + .55 * (coverage - .5) + .35 * cav)
    flake = dom.voronoi(name + "-flake", 1.0 / (.012 * s), jitter=.9)
    tone = dom.noise(name + "-tone", 18.0 / s, 3)
    colour = palette(np, np.clip(tone * 1.3 - .15, 0, 1), [(.05, .025, .014), (.13, .05, .02), (.26, .1, .035), (.36, .16, .05)])
    lift = smooth(np, .0004, .003 * s, flake["edge"]) * (flake["id"] < .6)
    return amount, colour, lift, flake


def metal_rusted(np, dom, prm):
    s = prm["scale"]
    f0 = V(np, prm["color"])
    dents = _hammered(np, dom, s, "rusted")
    mottle = dom.noise("rusted-mottle", 6.0 / s, 3)
    amount, colour, lift, flake = _rust(np, dom, s, "rusted", .78)
    pits = smooth(np, .66, .8, dom.noise("rusted-pits", 90.0 / s, 2)) * amount
    bare = f0 * (.82 + .14 * mottle)[:, None]
    albedo = mix(bare, colour * (1 - .4 * pits)[:, None], amount[:, None])
    metal = 1 - amount
    rough = mix(.5 + .12 * mottle, .88 + .08 * flake["id2"], amount)
    height = .0003 * s * dents + amount * (.0005 * lift - .0004 * pits) + .00015 * amount
    return Layers(albedo, height, rough, metal, recess=pits, chip=.0002,
                  under={"albedo": f0 * .95, "rough": np.full(dom.count, .38), "metal": np.ones(dom.count)})


def metal_brass(np, dom, prm):
    s = prm["scale"]
    f0 = V(np, prm["color"])
    # Cast/turned brass: soft polish variation, isotropic micro-scratches, tarnish in broad patches.
    polish = dom.noise("brass-polish", 7.0 / s, 4)
    scratch = scratches(np, dom, s, "brass", .06, .5)
    tarnish = smooth(np, .5, .8, dom.noise("brass-tarnish", 2.5 / s, 4))
    cav = dom.cavity if dom.cavity is not None else np.zeros(dom.count)
    verd = smooth(np, .5, .8, cav + .5 * (dom.noise("brass-verd", 9.0 / s, 3) - .5)) * smooth(np, .1, .6, prm["age"] + .25)
    albedo = f0 * (.96 + .06 * (polish - .5) + .02 * scratch)[:, None]
    albedo = mix(albedo, f0 * np.array([.7, .6, .48]), (tarnish * .45)[:, None])
    verdc = V(np, (.09, .24, .19)) * (.8 + .4 * dom.noise("brass-verdt", 40.0 / s, 2))[:, None]
    albedo = mix(albedo, verdc, verd[:, None])
    metal = 1 - verd
    rough = mix(.22 + .1 * polish + .12 * tarnish - .06 * scratch, np.full(dom.count, .82), verd)
    height = .00003 * polish + .0003 * verd - .00002 * scratch
    return Layers(albedo, height, rough, metal, recess=verd, chip=.0001,
                  under={"albedo": f0 * 1.04, "rough": np.full(dom.count, .14), "metal": np.ones(dom.count)},
                  aged={"albedo": mix(albedo, f0 * np.array([.5, .4, .28]), .6), "rough": rough + .12, "metal": metal})


def metal_steel(np, dom, prm):
    s = prm["scale"]
    f0 = V(np, prm["color"])
    brushed = dom.noise("steel-brush", 300.0 / s, 2, stretch=(.02, 1.0, 1.0), space="f")
    brushed2 = dom.noise("steel-brush2", 40.0 / s, 2, stretch=(.05, 1.0, 1.0), space="f")
    smudge = smooth(np, .5, .8, dom.noise("steel-smudge", 5.0 / s, 4))
    scratch = scratches(np, dom, s, "steel", .12, .3)
    albedo = f0 * (.96 + .05 * (brushed - .5) + .04 * (brushed2 - .5) + .015 * scratch)[:, None]
    rough = .2 + .1 * brushed + .06 * brushed2 + .12 * smudge - .06 * scratch
    height = .00002 * (brushed - .5) - .00003 * scratch
    return Layers(albedo, height, rough, np.ones(dom.count), recess=smudge * .2, chip=.0001,
                  under={"albedo": f0 * 1.06, "rough": np.full(dom.count, .14), "metal": np.ones(dom.count)},
                  aged={"albedo": mix(albedo, V(np, (.2, .16, .13)), .35), "rough": rough + .2, "metal": np.full(dom.count, .85)})


def metal_gold(np, dom, prm):
    s = prm["scale"]
    f0 = V(np, prm["color"])
    dents = _hammered(np, dom, s, "gold", .09)
    micro = dom.noise("gold-micro", 200.0 / s, 2)
    sheen = dom.noise("gold-sheen", 3.0 / s, 3)
    albedo = f0 * (.95 + .06 * (sheen - .5) + .03 * (micro - .5))[:, None]
    rough = .16 + .05 * micro + .08 * sheen + .1 * scratches(np, dom, s, "gold", .06, .4)
    height = .00012 * s * dents + .00001 * micro
    return Layers(albedo, height, rough, np.ones(dom.count), chip=.0001,
                  under={"albedo": f0 * 1.03, "rough": np.full(dom.count, .1), "metal": np.ones(dom.count)},
                  aged={"albedo": f0 * np.array([.8, .7, .55]), "rough": rough + .15, "metal": np.ones(dom.count)})


# --------------------------------------------------------- other surfaces --
def fabric(np, dom, prm):
    s = prm["scale"]
    a, b = dom.f[:, 0], dom.f[:, 1]
    texel = float(np.max(dom.texel)) if np.ndim(dom.texel) else float(dom.texel)
    pitch = dom.fit(max(.0028 * s, 4.2 * texel))
    ia, ib = np.floor(a / pitch).astype(np.int64), np.floor(b / pitch).astype(np.int64)
    fa, fb = a / pitch - ia, b / pitch - ib
    # 2/2 twill: the warp thread is on top where (i + j) mod 4 < 2.
    up = ((ia + ib) % 4) < 2
    warp_profile = np.sin(np.pi * fb) ** .6
    weft_profile = np.sin(np.pi * fa) ** .6
    top = np.where(up, warp_profile, weft_profile)
    gap = 1 - np.where(up, smooth(np, 0, .18, fb) * smooth(np, 1, .82, fb), smooth(np, 0, .18, fa) * smooth(np, 1, .82, fa))
    n = dom.count_of(pitch)
    yarn_a = hash01(np, ia % n if n else ia, 0, 51, dom.key("fabric"))
    yarn_b = hash01(np, ib % n if n else ib, 0, 52, dom.key("fabric"))
    yarn = np.where(up, yarn_b, yarn_a)
    fuzz = dom.noise("fabric-fuzz", 90.0 / s, 3)
    folds = dom.noise("fabric-folds", 3.0 / s, 3, stretch=(.5, 1.6, 1.0), space="f")
    base = V(np, prm["color"])
    albedo = base * (.82 + .2 * top + .05 * (yarn - .5) + .1 * (fuzz - .5) - .25 * gap)[:, None] * np.where(up, 1.0, .9)[:, None]
    height = .00035 * s * top - .0002 * gap + .002 * s * (folds - .5)
    rough = .9 + .06 * (fuzz - .5) - .04 * top
    return Layers(albedo, height, rough, np.zeros(dom.count), recess=gap * .3, chip=.0001,
                  under={"albedo": desaturate(np, albedo, .3) * 1.12, "rough": rough},
                  aged={"albedo": desaturate(np, albedo, .4) * .85 + .02, "rough": np.minimum(rough + .05, 1)})


def leather(np, dom, prm):
    s = prm["scale"]
    texel = float(np.max(dom.texel)) if np.ndim(dom.texel) else float(dom.texel)
    cell_size = max(.0026 * s, 3.5 * texel)
    pebble = dom.voronoi("leather-pebble", 1.0 / cell_size, jitter=.95)
    crease_line = 1 - smooth(np, 0, cell_size * .22, pebble["edge"])
    bump = smooth(np, 0, cell_size * .45, pebble["edge"])
    creases = smooth(np, .955, .99, dom.ridges("leather-crease", 14.0 / s, 2, stretch=(1.0, .6, 1.0), space="f")) * smooth(np, .35, .6, dom.noise("leather-creasem", 4.0 / s, 2))
    tone = dom.noise("leather-tone", 3.0 / s, 4)
    base = V(np, prm["color"])
    albedo = base * (.78 + .32 * tone + .12 * bump * pebble["id"])[:, None] * (1 - .22 * crease_line - .22 * creases)[:, None]
    height = .00022 * s * bump - .0003 * creases
    rough = .58 + .12 * crease_line + .08 * (tone - .5) - .06 * bump
    return Layers(albedo, height, rough, np.zeros(dom.count), recess=np.maximum(creases, crease_line * .3), chip=.0001,
                  under={"albedo": albedo * .72, "rough": rough - .22},
                  aged={"albedo": desaturate(np, albedo, .3) * .82, "rough": rough + .12})


def ceramic(np, dom, prm):
    s = prm["scale"]
    glaze = dom.noise("ceramic-glaze", 5.0 / s, 4)
    cav = dom.cavity if dom.cavity is not None else np.zeros(dom.count)
    pool = np.clip(smooth(np, .5, .85, glaze) * .35 + .8 * cav, 0, 1)
    craze = dom.voronoi("ceramic-craze", 1.0 / (.009 * s), jitter=.95)
    crack = (1 - smooth(np, 0, dom.aa(.0004 * s), craze["edge"])) * smooth(np, .35, .6, dom.noise("ceramic-crazem", 4.0 / s, 2))
    speck = smooth(np, .9, .95, dom.noise("ceramic-speck", 240.0 / s, 1))
    throw = dom.noise("ceramic-throw", 2.0 / s, 2, stretch=(.2, 8.0, 1.0), space="f")
    base = V(np, prm["color"])
    deep = base * np.array([.72, .66, .6]) * (1 + .2 * (base - base.mean()))
    albedo = mix(base * (.95 + .08 * glaze)[:, None], deep[None, :], pool[:, None]) * (1 - .4 * speck - .25 * crack)[:, None]
    height = .00002 * (throw - .5) - .00002 * crack + .00003 * glaze
    rough = .07 + .05 * glaze + .04 * crack + .1 * speck * .3
    bisque = V(np, (.42, .24, .14))
    return Layers(albedo, height, rough, np.zeros(dom.count), recess=pool * .4, chip=.0012,
                  under={"albedo": np.broadcast_to(bisque, albedo.shape).copy(), "rough": np.full(dom.count, .85)})


def glass(np, dom, prm):
    s = prm["scale"]
    depth = dom.noise("glass-depth", 2.0 / s, 4)
    swirl = dom.noise("glass-swirl", 4.0 / s, 3)
    bubble = smooth(np, .9, .95, dom.noise("glass-bubble", 140.0 / s, 1)) * smooth(np, .5, .75, dom.noise("glass-bubblem", 8.0 / s, 2))
    base = V(np, prm["color"])
    albedo = base * (.7 + .45 * depth + .12 * (swirl - .5))[:, None]
    albedo = mix(albedo, np.clip(base * 1.6 + .1, 0, .9), (bubble * .6)[:, None])
    rough = .04 + .03 * swirl + .05 * bubble
    height = .00004 * (swirl - .5) + .00003 * bubble
    emit = None
    if prm.get("strength", 0) > 0:
        glow = V(np, prm["glow"])
        inner = .55 + .45 * smooth(np, .3, .8, depth)
        emit = glow[None, :] * (inner * prm["strength"])[:, None]
    return Layers(albedo, height, rough, np.zeros(dom.count), emit=emit, chip=.0002,
                  under={"albedo": np.clip(albedo * 1.3 + .05, 0, .9), "rough": np.full(dom.count, .45)})


def ground_foliage(np, dom, prm):
    s = prm["scale"]
    soil_n = dom.noise("ground-soil", 8.0 / s, 4)
    soil = V(np, (.07, .05, .033)) * (.75 + .5 * soil_n)[:, None]
    albedo = soil.copy()
    height = .002 * s * (soil_n - .5)
    rough = .93 + .04 * (soil_n - .5)
    leaves_cols = [(.2, .085, .025), (.32, .14, .035), (.42, .25, .06), (.16, .12, .05), (.12, .13, .04), (.26, .08, .03)]
    base = V(np, prm["color"])
    cover = np.zeros(dom.count)
    for k, (size, density) in enumerate(((.1, .8), (.08, .75), (.12, .7))):
        cell = dom.voronoi("ground-leaf%d" % k, 1.0 / (size * s), jitter=.6)
        ang = cell["id"] * math.pi * 2
        rx, ry = cell["rel"][:, 0], cell["rel"][:, 1]
        cs, sn = np.cos(ang), np.sin(ang)
        lx, ly = rx * cs + ry * sn, -rx * sn + ry * cs
        length = (.32 + .12 * cell["id2"])
        width = length * (.38 + .2 * cell["id3"])
        t = np.clip(lx / length, -1, 1)
        half = width * np.sqrt(np.clip(1 - t * t, 0, 1)) * (1 - .25 * t)
        inside = smooth(np, .02, -.02, np.abs(ly) - half) * (np.abs(lx) < length) * (cell["id3"] < density)
        vein = smooth(np, .03, 0, np.abs(ly)) * inside
        col = palette(np, cell["id2"], leaves_cols) * base[None, :] / max(float(base.mean()), 1e-4) * .33
        col = col * (.85 + .3 * dom.noise("ground-leaft%d" % k, 60.0 / s, 2))[:, None] * (1 + .25 * vein)[:, None]
        curl = .0012 * s * (1 - np.abs(t)) + .0018 * s * (k + 1)
        albedo = mix(albedo * (1 - .35 * inside)[:, None], col, inside[:, None])
        height = np.where(inside > .5, np.maximum(height, curl + .0004 * vein), height)
        rough = mix(rough, .75 + .1 * cell["id"], inside)
        cover = np.maximum(cover, inside)
    twig_cell = dom.voronoi("ground-twig", 1.0 / (.12 * s), jitter=.8)
    ang = twig_cell["id"] * math.pi
    d = np.abs(-twig_cell["rel"][:, 0] * np.sin(ang) + twig_cell["rel"][:, 1] * np.cos(ang)) / (1.0 / (.12 * s)) * (1.0 / (.12 * s))
    along = np.abs(twig_cell["rel"][:, 0] * np.cos(ang) + twig_cell["rel"][:, 1] * np.sin(ang))
    twig = smooth(np, .03, .015, d) * (along < .4) * (twig_cell["id2"] < .5)
    albedo = mix(albedo, V(np, (.1, .07, .045)), twig[:, None])
    height = np.where(twig > .5, np.maximum(height, .007 * s), height)
    recess = (1 - cover) * (1 - twig)
    return Layers(albedo, height, rough, np.zeros(dom.count), recess=recess * .6, chip=.0002)


def sand(np, dom, prm):
    s = prm["scale"]
    a, b = dom.f[:, 0], dom.f[:, 1]
    lam = dom.fit(.16 * s)
    warp = dom.noise("sand-ripple-warp", 2.2 / s, 3, space="f")
    t = (b + .25 * s * (warp - .5) + .04 * s * (dom.noise("sand-ripple-w2", 7.0 / s, 2, space="f") - .5)) / lam
    r = t - np.floor(t)
    ripple = np.where(r < .7, smooth(np, 0, .7, r), 1 - smooth(np, .7, 1.0, r))
    amp = .3 + .7 * dom.noise("sand-ripple-amp", 1.5 / s, 3)
    grains = dom.noise("sand-grain", 500.0 / s, 1)
    dark = smooth(np, .75, .85, dom.noise("sand-dark", 350.0 / s, 1))
    base = V(np, prm["color"])
    albedo = base * (.92 + .12 * (grains - .5) + .03 * ripple * amp)[:, None] * (1 - .35 * dark)[:, None]
    albedo = albedo * (1 + (dom.noise("sand-tone", 1.0 / s, 3) - .5)[:, None] * np.array([.08, .05, .02]))
    height = .005 * s * ripple * amp + .0002 * grains
    rough = .93 - .25 * smooth(np, .9, .97, grains)
    return Layers(albedo, height, rough, np.zeros(dom.count), recess=(1 - ripple) * .3, chip=.0001)


def snow(np, dom, prm):
    s = prm["scale"]
    lumps = dom.noise("snow-lumps", 3.0 / s, 5)
    sast = dom.noise("snow-sast", 6.0 / s, 3, stretch=(.25, 1.0, 1.0), space="f")
    sparkle = dom.noise("snow-spark", 400.0 / s, 1)
    base = V(np, prm["color"])
    shade = smooth(np, .3, .6, lumps)
    albedo = mix(base * np.array([.9, .94, 1.0]), base, shade[:, None]) * (.985 + .015 * smooth(np, .8, .95, sparkle))[:, None]
    height = .012 * s * (lumps - .5) + .004 * s * (sast - .5)
    rough = .74 + .1 * (sparkle - .5) - .2 * smooth(np, .97, .995, sparkle)
    return Layers(albedo, height, rough, np.zeros(dom.count), recess=(1 - shade) * .2, chip=.0005, moss_ok=0.0)


def ice(np, dom, prm):
    s = prm["scale"]
    depth = dom.noise("ice-depth", 2.0 / s, 4)
    c1 = dom.voronoi("ice-crack1", 1.0 / (.22 * s), jitter=.95)
    c2 = dom.voronoi("ice-crack2", 1.0 / (.07 * s), jitter=.95)
    crack = np.maximum((1 - smooth(np, 0, dom.aa(.0018 * s), c1["edge"])) * (c1["id"] < .7 + .3 * smooth(np, .3, .6, dom.noise("ice-c1m", 3.0 / s, 2))),
                       .6 * (1 - smooth(np, 0, dom.aa(.001 * s), c2["edge"])) * smooth(np, .6, .75, dom.noise("ice-crackm", 4.0 / s, 2)))
    bubbles = smooth(np, .9, .95, dom.noise("ice-bub", 200.0 / s, 1)) * smooth(np, .5, .8, dom.noise("ice-bubm", 6.0 / s, 3))
    frost = smooth(np, .58, .78, dom.noise("ice-frost", 3.5 / s, 4))
    base = V(np, prm["color"])
    deep = base * np.array([.35, .55, .75])
    albedo = mix(deep, base, smooth(np, .25, .75, depth)[:, None])
    white = V(np, (.75, .82, .86))
    albedo = mix(albedo, white, np.clip(crack * .7 + bubbles * .6, 0, 1)[:, None])
    albedo = mix(albedo, white * .95, (frost * .75)[:, None])
    height = -.0004 * crack + .0003 * frost + .0001 * (depth - .5)
    rough = .06 + .04 * depth + .6 * frost + .1 * crack
    return Layers(albedo, height, rough, np.zeros(dom.count), recess=crack * .4, chip=.0003, moss_ok=.2,
                  under={"albedo": albedo, "rough": np.full(dom.count, .3)})


def runes(np, dom, prm):
    s = prm["scale"]
    a, b = dom.f[:, 0], dom.f[:, 1]
    cell = dom.fit(.085 * s)
    n = dom.count_of(cell)
    ia, ib = np.floor(a / cell).astype(np.int64), np.floor(b / cell).astype(np.int64)
    wa, wb = (ia % n, ib % n) if n else (ia, ib)
    seed = dom.key("runes")
    lx, ly = a / cell - ia - .5, b / cell - ib - .5
    row_on = hash01(np, wb, 0, 61, seed) < .72
    glyph_on = (hash01(np, wa, wb, 62, seed) < .82) & row_on
    width = max(.0045 * s, 1.6 * float(np.max(dom.texel))) / cell
    d = np.full(dom.count, 9.0)
    strokes = 2 + np.floor(hash01(np, wa, wb, 63, seed) * 3).astype(np.int64)
    pts = np.array([-.28, 0.0, .28])
    for k in range(4):
        h1 = np.floor(hash01(np, wa, wb, 70 + k, seed) * 9).astype(np.int64)
        h2 = np.floor(hash01(np, wa, wb, 80 + k, seed) * 9).astype(np.int64)
        h2 = np.where(h2 == h1, (h1 + 4) % 9, h2)
        ax, ay, bx, by = pts[h1 % 3], pts[h1 // 3], pts[h2 % 3], pts[h2 // 3]
        dk = segment_distance(np, lx, ly, ax, ay, bx, by)
        d = np.where(k < strokes, np.minimum(d, dk), d)
    # A small ring or dot on some glyphs.
    ring = np.abs(np.sqrt(lx * lx + ly * ly) - .14)
    d = np.where(hash01(np, wa, wb, 90, seed) < .3, np.minimum(d, ring), d)
    carve = smooth(np, width, width * .45, d) * glyph_on
    halo = smooth(np, width * 4, width, d) * glyph_on
    stone = V(np, prm["color"])
    tex = dom.noise("runes-stone", 7.0 / s, 4)
    g = dom.noise("runes-grain", 150.0 / s, 2)
    # Row bands: a framing groove between the inscription rows.
    band = 1 - smooth(np, 0, dom.aa(.002 * s), np.abs(ly + .5) * cell)
    glow = V(np, prm["glow"])
    albedo = stone * (.8 + .3 * tex + .12 * (g - .5))[:, None] * (1 - .3 * band)[:, None]
    albedo = mix(albedo, albedo + glow * .08, halo[:, None])
    albedo = mix(albedo, glow * .55, carve[:, None])
    height = .0006 * tex + .00015 * g - .0018 * s * carve - .001 * band
    rough = .7 + .1 * (g - .5) - .35 * carve
    emit = glow[None, :] * (carve * prm["strength"])[:, None]
    return Layers(albedo, height, rough, np.zeros(dom.count), emit=emit, recess=np.maximum(band, carve * .2), chip=.0008)


# ------------------------------------------------------------------ catalog --
# name -> (family fn, group, evidence profile, default tile metres, default params)
_BASE = {"scale": 1.0, "wear": 0.0, "dirt": 0.0, "moss": 0.0, "age": 0.0, "snow": 0.0}


def _p(color, **kw):
    out = dict(_BASE)
    out["color"] = tuple(color)
    out.update(kw)
    return out


CATALOG = {
    "wood-planks": (wood_planks, "wood", "bark", 2.0, _p((.3, .16, .07), wear=.25, dirt=.3, joints=1.0, seams=1.0)),
    "wood-endgrain": (wood_endgrain, "wood", "bark", 1.0, _p((.36, .21, .1), dirt=.2)),
    "wood-painted": (wood_painted, "wood", "bark", 2.0, _p((.07, .17, .22), wear=.45, dirt=.3, age=.2, joints=1.0, seams=1.0)),
    "wood-weathered": (wood_weathered, "wood", "bark", 2.0, _p((.26, .17, .1), wear=.3, dirt=.35, moss=.06, joints=1.0, seams=1.0)),
    "stone-cobble": (stone_cobble, "stone", "stone", 2.0, _p((.2, .19, .175), dirt=.45, moss=.08)),
    "stone-ashlar": (stone_ashlar, "stone", "stone", 4.0, _p((.4, .37, .31), wear=.35, dirt=.4)),
    "stone-slate": (stone_slate, "stone", "stone", 2.0, _p((.07, .078, .085), dirt=.25)),
    "stone-marble": (stone_marble, "stone", "stone", 2.0, _p((.74, .72, .68), wear=.2, dirt=.15)),
    "stone-sandstone": (stone_sandstone, "stone", "stone", 2.0, _p((.46, .32, .19), wear=.3, dirt=.3)),
    "concrete": (concrete, "stone", "stone", 4.0, _p((.34, .33, .31), dirt=.4)),
    "brick": (brick, "stone", "stone", 2.0, _p((.34, .1, .055), wear=.25, dirt=.35)),
    "metal-iron": (metal_iron, "metal", "weathered", 1.0, _p((.53, .52, .5), wear=.45, dirt=.35)),
    "metal-rusted": (metal_rusted, "metal", "weathered", 1.0, _p((.53, .52, .5), wear=.3, dirt=.3)),
    "metal-brass": (metal_brass, "metal", "weathered", 1.0, _p((.88, .7, .38), wear=.4, dirt=.2, age=.1)),
    "metal-steel": (metal_steel, "metal", "weathered", 1.0, _p((.6, .61, .63), wear=.3, dirt=.15)),
    "metal-gold": (metal_gold, "metal", "weathered", 1.0, _p((1.0, .76, .33), wear=.2, dirt=.08)),
    "fabric": (fabric, "cloth", "weathered", .5, _p((.36, .28, .19), dirt=.25)),
    "leather": (leather, "cloth", "weathered", .5, _p((.15, .065, .028), wear=.4, dirt=.25)),
    "ceramic": (ceramic, "other", "stone", 1.0, _p((.62, .58, .5), wear=.15, dirt=.2)),
    "glass": (glass, "other", "weathered", 1.0, _p((.35, .52, .5), dirt=.15, glow=(1.0, .55, .2), strength=0.0)),
    "ground-foliage": (ground_foliage, "ground", "stone", 2.0, _p((.33, .33, .33))),
    "sand": (sand, "ground", "stone", 2.0, _p((.46, .37, .25))),
    "snow": (snow, "ground", "stone", 2.0, _p((.82, .84, .88))),
    "ice": (ice, "ground", "stone", 2.0, _p((.5, .68, .76), dirt=.1)),
    "emissive-runes": (runes, "emissive", "stone", 1.0, _p((.085, .085, .095), wear=.3, dirt=.3, glow=(.25, .62, 1.0), strength=4.0)),
}

NAMES = tuple(CATALOG)
