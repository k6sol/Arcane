"""Baked PBR for model spec materials: object-space finishes plus weathering, into UV0.

Each material mesh has one non-overlapping UV0 atlas, so every texel maps to exactly one
surface point. The texel's world position, normal, part and instance come from a UV-space
rasterisation; the finish (wood grain along each part's grain axis, stone, metal, leather,
fabric, ceramic, plaster, plastic, glass) is evaluated in object space with seeded NumPy
value noise, and two masks weather it:
- edge wear from local convexity (normals of nearby surface points diverge),
- cavity from short-range ambient occlusion rays (crevices, contact seams),
- up-facing grime: dust settles on faces that look up, most in their occluded corners.
Glass is opaque-stylised (Roblox imports no BLEND): a dark tint, a bright rim on convex edges and
soft diagonal specular streaks; `glow` > 0 adds a constant emission (lantern panes, windows).
Every material is baked by a workers/blender/materials library family over the same UV0 atlas,
under the same texture contract: the family named in `library`, else one inferred from the ids,
context tags and geometry (model_materials; reported in review.materials). Glass, plastic,
`library: "none"` and a missing or failing library use the finish bake below.
Outputs follow the shared texture contract (textures.surface_evidence): T_<Id>_BaseColor
(sRGB), T_<Id>_Normal (OpenGL tangent space) and T_<Id>_MetallicRoughness (G roughness,
B metallic), packed, REPEAT/Linear, bound to UV0. Deterministic for the request seed.
"""
import hashlib
import json
import math

RESOLUTION = 512
MASK = 0xFFFFFFFF


def np_():
    import numpy
    return numpy


# ------------------------------------------------------------------ noise --
def _hash(np, i, j, k, seed):
    v = (i * 374761393 + j * 668265263 + k * 1440670441 + seed * 144665) & MASK
    v = ((v ^ (v >> 13)) * 1274126177) & MASK
    return ((v ^ (v >> 16)) & 0xFFFF).astype(np.float32) / 32767.5 - 1.0


def noise3(np, x, y, z, seed):
    ix, iy, iz = np.floor(x), np.floor(y), np.floor(z)
    fx, fy, fz = (x - ix).astype(np.float32), (y - iy).astype(np.float32), (z - iz).astype(np.float32)
    ix, iy, iz = ix.astype(np.int64), iy.astype(np.int64), iz.astype(np.int64)

    def fade(t):
        return t * t * t * (t * (t * 6 - 15) + 10)
    ux, uy, uz = fade(fx), fade(fy), fade(fz)
    out = 0
    for dx in (0, 1):
        wx = ux if dx else 1 - ux
        for dy in (0, 1):
            wy = uy if dy else 1 - uy
            for dz in (0, 1):
                wz = uz if dz else 1 - uz
                out = out + wx * wy * wz * _hash(np, ix + dx, iy + dy, iz + dz, seed)
    return out


def fbm3(np, p, scale, octaves, seed, gain=.5):
    x, y, z = p[..., 0] / scale, p[..., 1] / scale, p[..., 2] / scale
    total, amp, norm = 0, 1.0, 0.0
    for o in range(octaves):
        total = total + amp * noise3(np, x, y, z, seed + 97 * o)
        norm += amp
        x, y, z = x * 2.03 + 11.3, y * 2.03 + 5.1, z * 2.03 + 2.7
        amp *= gain
    return total / norm


def smoothstep(np, a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ----------------------------------------------------------------- raster --
def raster(np, tri, size, small=8):
    """Rasterise (N, 3, 2) pixel-space triangles: per-pixel triangle id (-1 empty) and barycentrics."""
    fid = np.full((size, size), -1, np.int32)
    bary = np.zeros((size, size, 3), np.float32)
    if not len(tri):
        return fid, bary
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    det = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])
    lo = np.floor(tri.min(1) - .5).astype(np.int64)
    hi = np.ceil(tri.max(1) + .5).astype(np.int64)
    span = hi - lo
    ok = np.abs(det) > 1e-12
    small_ids = np.nonzero(ok & (span[:, 0] <= small) & (span[:, 1] <= small))[0]
    gx, gy = np.meshgrid(np.arange(small), np.arange(small))
    offsets = np.stack([gx.ravel(), gy.ravel()], 1)

    def fill(ids, px, py):
        # px, py: (n, m) integer pixel coords for triangles ids (n,)
        cx, cy = px + .5, py + .5
        A, B, C, D = a[ids], b[ids], c[ids], det[ids][:, None]
        w1 = ((cx - A[:, 0:1]) * (C[:, 1:2] - A[:, 1:2]) - (C[:, 0:1] - A[:, 0:1]) * (cy - A[:, 1:2])) / D
        w2 = ((B[:, 0:1] - A[:, 0:1]) * (cy - A[:, 1:2]) - (cx - A[:, 0:1]) * (B[:, 1:2] - A[:, 1:2])) / D
        w0 = 1 - w1 - w2
        inside = (w0 >= -1e-5) & (w1 >= -1e-5) & (w2 >= -1e-5) & (px >= 0) & (py >= 0) & (px < size) & (py < size)
        r, k = np.nonzero(inside)
        fid[py[r, k], px[r, k]] = ids[r]
        bary[py[r, k], px[r, k]] = np.stack([w0[r, k], w1[r, k], w2[r, k]], 1)
    for start in range(0, len(small_ids), 4096):
        ids = small_ids[start:start + 4096]
        px = lo[ids, 0:1] + offsets[None, :, 0]
        py = lo[ids, 1:2] + offsets[None, :, 1]
        fill(ids, px, py)
    for t in np.nonzero(ok & ~((span[:, 0] <= small) & (span[:, 1] <= small)))[0]:
        x0, y0 = max(0, lo[t, 0]), max(0, lo[t, 1])
        x1, y1 = min(size, hi[t, 0]), min(size, hi[t, 1])
        if x1 <= x0 or y1 <= y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1), np.arange(y0, y1))
        fill(np.array([t]), xs.reshape(1, -1), ys.reshape(1, -1))
    return fid, bary


def dilate(np, filled, arrays, steps):
    """Grow covered texels into empty ones (gutters) so filtering never samples background."""
    filled = filled.copy()
    for _ in range(steps):
        grown = False
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            src = np.roll(np.roll(filled, dy, 0), dx, 1)
            take = src & ~filled
            if take.any():
                grown = True
                for arr in arrays:
                    arr[take] = np.roll(np.roll(arr, dy, 0), dx, 1)[take]
                filled = filled | take
        if not grown:
            break
    return filled


# --------------------------------------------------------------- finishes --
def finish_layers(np, finish, local, world, grain, inst_seed, seed, n):
    """Return (albedo multiplier (..,3) about 1, height in metres, roughness offset, metal factor)."""
    g = grain
    a = np.take_along_axis(local, g[..., None], -1)[..., 0]
    others = np.stack([np.take_along_axis(local, ((g + 1) % 3)[..., None], -1)[..., 0],
                       np.take_along_axis(local, ((g + 2) % 3)[..., None], -1)[..., 0]], -1)
    ones = np.ones(world.shape[:-1], np.float32)
    if finish == "wood":
        # Rings round a pith line parallel to the grain but set off the part (per instance), so
        # plank faces show long arched grain, staves show stripes and end grain shows ring arcs.
        h1 = (np.sin(inst_seed * 12.9898 + 1.3) * 43758.5453) % 1.0
        h2 = (np.sin(inst_seed * 78.233 + 4.1) * 12543.123) % 1.0
        ang = h1 * 2 * math.pi
        dist = .06 + .22 * h2
        pith = np.stack([np.cos(ang) * dist, np.sin(ang) * dist], -1)
        rel = others - pith
        rho = np.sqrt((rel ** 2).sum(-1))
        warp = fbm3(np, np.stack([a * .7, others[..., 0] * 5, others[..., 1] * 5], -1), .2, 3, seed + 3)
        rings = (rho * 70 + warp * 1.6 + a * .15) % 1.0
        late = smoothstep(np, .55, .92, rings) * (1 - smoothstep(np, .92, 1.0, rings))
        fibre = fbm3(np, np.stack([a * .8, others[..., 0] * 140, others[..., 1] * 140], -1), 1.0, 3, seed + 5)
        streak = fbm3(np, np.stack([a * 1.5, others[..., 0] * 12, others[..., 1] * 12], -1), .6, 2, seed + 7)
        board = (h2 - .5) * .16 + (h1 - .5) * .08
        tone = 1 - .3 * late + .11 * fibre + .12 * streak + board
        height = -.0004 * late + .00015 * fibre
        mult = np.stack([tone * 1.03, tone, tone * .95], -1)
        return mult, height, .08 * late - .04 * streak, ones
    if finish in ("stone", "plaster", "ceramic"):
        big = fbm3(np, world, .35, 4, seed + 11)
        fine = fbm3(np, world, .03, 3, seed + 13)
        pits = smoothstep(np, .45, .75, noise3(np, world[..., 0] / .012, world[..., 1] / .012, world[..., 2] / .012, seed + 17))
        k = {"stone": 1.0, "plaster": .45, "ceramic": .18}[finish]
        speck = smoothstep(np, .55, .85, noise3(np, world[..., 0] / .006, world[..., 1] / .006, world[..., 2] / .006, seed + 23))
        blotch = fbm3(np, world, 1.2, 3, seed + 29)
        tone = 1 + k * (.2 * big + .12 * fine - .22 * pits + .12 * blotch - .1 * speck)
        warm = 1 + k * .04 * fbm3(np, world, .6, 2, seed + 19)
        mult = np.stack([tone * warm, tone, tone / warm], -1)
        height = k * (.0016 * big + .0007 * fine - .0006 * pits)
        return mult, height, k * (.05 * fine + .08 * pits), ones
    if finish == "metal":
        brushed = fbm3(np, np.stack([a * 2, others[..., 0] * 180, others[..., 1] * 180], -1), 1.0, 2, seed + 23)
        tarnish = fbm3(np, world, .18, 4, seed + 29)
        scratch = np.abs(fbm3(np, np.stack([world[..., 0] * 3 + world[..., 1] * 40, world[..., 1] * 3 - world[..., 2] * 40, world[..., 2] * 3], -1), .5, 2, seed + 31))
        lines = 1 - smoothstep(np, .0, .025, scratch)
        tone = 1 + .05 * brushed - .12 * smoothstep(np, .1, .6, tarnish) + .12 * lines
        mult = np.stack([tone, tone, tone], -1)
        height = .00008 * brushed - .00006 * lines
        return mult, height, .1 * smoothstep(np, -.2, .6, tarnish) - .12 * lines + .04 * brushed, ones
    if finish == "leather":
        cell = np.abs(noise3(np, world[..., 0] / .004, world[..., 1] / .004, world[..., 2] / .004, seed + 37))
        crease = fbm3(np, world, .05, 3, seed + 41)
        tone = 1 + .08 * cell - .12 * smoothstep(np, .2, .7, crease)
        return np.stack([tone, tone, tone], -1), .00025 * cell - .0003 * smoothstep(np, .2, .7, crease), .08 * crease, ones
    if finish == "fabric":
        f = 2 * math.pi / .003
        weave = np.sin(a * f) * np.sin((others[..., 0] + others[..., 1]) * f)
        fuzz = fbm3(np, world, .02, 3, seed + 43)
        tone = 1 + .07 * weave + .08 * fuzz
        return np.stack([tone, tone, tone], -1), .00015 * weave, .03 * fuzz, ones
    soft = fbm3(np, world, .25, 3, seed + 47)
    k = .03 if finish == "glass" else .06
    tone = 1 + k * soft
    return np.stack([tone, tone, tone], -1), .00005 * soft, .03 * soft, ones


# finish -> share of the material's cavity amount that settles as up-facing grime
GRIME = {"wood": .55, "stone": .6, "metal": .45, "plaster": .6, "ceramic": .3, "leather": .3, "fabric": .4, "plastic": .3, "glass": .35}
DUST = (.2, .18, .15)
# finish -> ground-line darkening share, and piece-to-piece tone spread (blocks, staves, copies)
GROUND = {"wood": .8, "stone": .9, "metal": .5, "plaster": .9, "ceramic": .4, "leather": .4, "fabric": .5, "plastic": .3, "glass": 0.0}
PIECE_TONE = {"wood": .3, "stone": .22, "metal": .05, "plaster": .06, "ceramic": .04, "leather": .08, "fabric": .08, "plastic": .03, "glass": 0.0}
MUD = (.07, .06, .045)

WEAR = {
    # finish -> (edge colour lift, edge roughness shift, cavity darkening, cavity roughness shift)
    "wood": ((1.32, 1.28, 1.2), .06, .5, .12), "stone": ((1.22, 1.2, 1.17), -.04, .45, .06),
    "metal": ((2.4, 2.35, 2.25), -.26, .55, .2), "plaster": ((1.08, 1.08, 1.06), .0, .4, .05),
    "ceramic": ((1.05, 1.05, 1.05), .1, .35, .1), "leather": ((1.35, 1.3, 1.2), .12, .45, .08),
    "fabric": ((1.15, 1.15, 1.15), .04, .4, .03), "plastic": ((1.25, 1.25, 1.25), .1, .3, .06),
    "glass": ((1.0, 1.0, 1.0), .05, .25, .2),
}


# ------------------------------------------------------------------- bake --
def edge_mask(np, bvh, pos, nrm, ok, size_hint, Vector):
    """Convexity at covered texels: normals of nearby surface points diverge across convex edges."""
    r = max(.004, min(.03, size_hint * .015))
    out = np.zeros(ok.shape, np.float32)
    ys, xs = np.nonzero(ok)
    for y, x in zip(ys.tolist(), xs.tolist()):
        p = Vector(pos[y, x].tolist())
        n = Vector(nrm[y, x].tolist())
        if n.length < .5:
            continue
        t = n.orthogonal().normalized()
        b = n.cross(t)
        conv = 0.0
        for d in (t, -t, b, -b, (t + b).normalized(), -(t + b).normalized()):
            loc, nn, _, _ = bvh.find_nearest(p + d * r)
            if loc is not None:
                conv += (nn - n).dot(loc - p) / r
        out[y, x] = conv / 6
    return out


def cavity_mask(np, bvh, pos, nrm, ok, size_hint, Vector):
    """Short-range ambient occlusion at covered texels (crevices, contact seams)."""
    reach = max(.02, min(.4, size_hint * .12))
    out = np.zeros(ok.shape, np.float32)
    golden = math.pi * (3 - math.sqrt(5))
    dirs = []
    for k in range(10):
        z = .15 + .8 * (k + .5) / 10
        rr = math.sqrt(1 - z * z)
        dirs.append((math.cos(golden * k) * rr, math.sin(golden * k) * rr, z))
    ys, xs = np.nonzero(ok)
    for y, x in zip(ys.tolist(), xs.tolist()):
        p = Vector(pos[y, x].tolist())
        n = Vector(nrm[y, x].tolist())
        if n.length < .5:
            continue
        t = n.orthogonal().normalized()
        b = n.cross(t)
        hits = 0.0
        for d in dirs:
            loc, _, _, dist = bvh.ray_cast(p + n * 4e-4, t * d[0] + b * d[1] + n * d[2], reach)
            if loc is not None:
                hits += 1 - dist / reach
        out[y, x] = hits / len(dirs)
    return out


def upsample(np, small, factor, size):
    return np.repeat(np.repeat(small, factor, 0), factor, 1)[:size, :size]


def author(request, directory, objects, state):
    import bpy
    from mathutils import Vector, Matrix
    from mathutils.bvhtree import BVHTree
    np = np_()
    spec = state["plan"].spec
    if spec["finish"] != "natural":
        return
    plan = state["plan"]
    mats = {m["id"]: m for m in spec["materials"]}
    inv = [Matrix([list(r) for r in i.matrix]).inverted_safe() for i in plan.instances]
    grains = np.array([i.grain for i in plan.instances], np.int64)
    by_part = {p["id"]: p for p in spec["parts"]}
    # Revolved wood with flutes reads as staves: the seams split the tone per stave.
    staves_of = np.array([(by_part[i.part]["flutes"] or {}).get("count", 0) if by_part[i.part]["op"] == "revolve" and by_part[i.part]["_finish"] == "wood" else 0
                          for i in plan.instances], np.int64)
    floor_z = min(v.co.z for obj in objects for v in obj.data.vertices)
    top_z = max(v.co.z for obj in objects for v in obj.data.vertices)
    # One BVH over every material: wear and occlusion see neighbouring parts (contact seams).
    verts, polys = [], []
    for obj in objects:
        base = len(verts)
        verts.extend(tuple(v.co) for v in obj.data.vertices)
        polys.extend(tuple(base + i for i in p.vertices) for p in obj.data.polygons)
    bvh = BVHTree.FromPolygons(verts, polys)
    lo = np.array(verts).min(0)
    hi = np.array(verts).max(0)
    size_hint = float(np.max(hi - lo))
    info = state["info"]
    info.setdefault("surfaces", {})
    # Material choice: explicit library families win; other slots get an inferred family and
    # context weathering (model_materials), reported in review.materials so it can be overridden.
    from model_materials import infer
    masonry = {p["material"] for p in spec["parts"] if p.get("_blocks")}
    inferred = infer(spec, request.get("procedural"), request.get("name", ""), masonry)
    info["materials"] = inferred
    choice = {e["material"]: e for e in inferred["materials"]}
    for obj in objects:
        mid = obj["arcane_source_key"]
        m = mats[mid]
        size = RESOLUTION
        seed = int.from_bytes(hashlib.sha256((str(request["seed"]) + ":" + mid).encode()).digest()[:4], "big") % 60000
        me = obj.data
        me.calc_loop_triangles()
        uv = me.uv_layers["UVMap"].data
        nt = len(me.loop_triangles)
        tri_uv = np.zeros((nt, 3, 2), np.float64)
        tri_p = np.zeros((nt, 3, 3), np.float64)
        tri_poly = np.zeros(nt, np.int64)
        co = np.array([v.co[:] for v in me.vertices])
        for n, t in enumerate(me.loop_triangles):
            tri_uv[n] = [uv[l].uv[:] for l in t.loops]
            tri_p[n] = co[list(t.vertices)]
            tri_poly[n] = t.polygon_index
        inst_attr = me.attributes.get("arcane_inst")
        poly_inst = np.zeros(len(me.polygons), np.int64)
        if inst_attr is not None:
            inst_attr.data.foreach_get("value", poly_inst)
        tone_attr = me.attributes.get("arcane_tone")
        poly_tone = np.zeros(len(me.polygons), np.int64)
        if tone_attr is not None:
            tone_attr.data.foreach_get("value", poly_tone)
        fid, bary = raster(np, tri_uv * size, size)
        covered = fid >= 0
        f = np.where(covered, fid, 0)
        pos = (tri_p[f] * bary[..., None]).sum(2)
        face_n = np.cross(tri_p[:, 1] - tri_p[:, 0], tri_p[:, 2] - tri_p[:, 0])
        face_n /= np.maximum(np.linalg.norm(face_n, axis=1, keepdims=True), 1e-12)
        nrm = face_n[f]
        inst = poly_inst[tri_poly[f]]
        pos[~covered] = 0
        nrm[~covered] = 0
        filled = dilate(np, covered, [pos, nrm, inst], 10)
        # Local (part-instance) coordinates for grain-aligned finishes.
        mats_inv = np.array([[list(r) for r in mtx] for mtx in inv])
        mi = mats_inv[inst]
        local = np.einsum("hwij,hwj->hwi", mi[..., :3, :3], pos) + mi[..., :3, 3]
        grain = grains[inst]
        mult, height, rough_shift, _ = finish_layers(np, m["finish"], local.astype(np.float32), pos.astype(np.float32), grain, inst.astype(np.float32), seed, size)
        # Piece-to-piece tone: every stone block, stave and part copy is cut from different stock.
        tone_id = np.where(covered, poly_tone[tri_poly[f]], 0)
        staves = staves_of[inst]
        sector = np.floor((np.arctan2(local[..., 1], local[..., 0]) / (2 * math.pi) + .5) * np.maximum(staves, 1) + .5).astype(np.int64) % np.maximum(staves, 1)
        piece = np.where(tone_id > 0, tone_id * 7919, np.where(staves > 0, inst * 104729 + sector * 31 + 17, inst * 104729 + 3))
        jitter = ((np.sin(piece.astype(np.float64) * 12.9898 + seed * .001) * 43758.5453) % 1.0 - .5).astype(np.float32)
        jitter2 = ((np.sin(piece.astype(np.float64) * 78.233 + 2.1) * 12543.123) % 1.0 - .5).astype(np.float32)
        spread = PIECE_TONE[m["finish"]]
        tone = (1 + spread * jitter)[..., None] * np.stack([1 + .25 * spread * jitter2, np.ones_like(jitter2), 1 - .25 * spread * jitter2], -1)
        mult = mult * tone
        pick = choice.get(mid)
        library = library_maps(m, pick, obj, bvh, size_hint, seed, info) if pick and pick["library"] else None
        if library is not None:
            # Library bake (no finish layers needed): keep the piece-to-piece tone of blocks,
            # staves and part copies on top of the family's own variation.
            if pick["source"] == "inferred":
                base_c = library["baseColor"]
                lin = np.where(base_c[..., :3] <= .04045, base_c[..., :3] / 12.92, np.power((np.clip(base_c[..., :3], 0, 1) + .055) / 1.055, 2.4))
                library["baseColor"] = np.concatenate([srgb(np, lin * np.where(covered[..., None], tone, 1)), base_c[..., 3:]], -1).astype(np.float32)
            write_material(bpy, directory, m, None, None, None, None, size, library)
            ev = library.get("_evidence", {})
            info["surfaces"][mid] = {"finish": m["finish"], "library": pick["library"], "source": pick["source"], "coverage": round(float(covered.mean()), 3),
                                     **{k: v for k, v in (ev.get("coverage") or {}).items()}}
            if m.get("glow"):
                info["surfaces"][mid]["glow"] = m["glow"]
                info.setdefault("glow", []).append(glow_hint(m, obj))
            continue
        # Weathering masks on covered texels only (edge wear at 1/2, occlusion at 1/4 resolution:
        # both are broad), grown into the gutters, upsampled and softened.
        edge = edge_mask(np, bvh, pos[::2, ::2], nrm[::2, ::2], covered[::2, ::2], size_hint, Vector)
        dilate(np, covered[::2, ::2], [edge], 4)
        cav = cavity_mask(np, bvh, pos[::4, ::4], nrm[::4, ::4], covered[::4, ::4], size_hint, Vector)
        dilate(np, covered[::4, ::4], [cav], 3)
        edge = box_blur(np, upsample(np, edge, 2, size), 2)
        cav = box_blur(np, upsample(np, cav, 4, size), 3)
        breakup = fbm3(np, pos.astype(np.float32), .025, 3, seed + 61)
        wear = smoothstep(np, .18, .55, edge * (.75 + .9 * breakup)) * m["wear"]
        dirt = smoothstep(np, .12, .6, cav) * m["cavity"]
        # Up-facing grime: dust on faces that look up, heavier in their occluded corners, broken up.
        blotch = fbm3(np, pos.astype(np.float32), .12, 3, seed + 67)
        up = smoothstep(np, .35, .95, nrm[..., 2])
        grime = np.clip(up * (.35 + .65 * smoothstep(np, .05, .45, cav)) * smoothstep(np, -.35, .45, blotch) * (1 - wear), 0, 1) * m["cavity"] * GRIME[m["finish"]]
        # Ground line: splash and damp darken the lowest band of anything standing on the floor.
        reach = max(.04, min(.35, .14 * (top_z - floor_z)))
        ground = (1 - smoothstep(np, 0, reach, pos[..., 2] - floor_z)) * (.6 + .4 * smoothstep(np, -.4, .4, blotch)) * m["cavity"] * GROUND[m["finish"]]
        lift, rough_edge, dark, rough_cav = WEAR[m["finish"]]
        base = np.array(m["color"], np.float32)
        albedo = base * mult
        worn = np.clip(base * np.array(lift, np.float32), 0, 1)
        albedo = albedo * (1 - wear[..., None]) + worn * mult * wear[..., None]
        albedo = albedo * (1 - dark * dirt[..., None])
        albedo = albedo * (1 - .55 * grime[..., None]) + np.array(DUST, np.float32) * (.55 * grime[..., None])
        albedo = albedo * (1 - .45 * ground[..., None]) + np.array(MUD, np.float32) * (.45 * ground[..., None])
        rough = np.clip(m["roughness"] + rough_shift + rough_edge * wear + rough_cav * dirt + .18 * grime + .12 * ground, .02, 1)
        metal = np.clip(m["metallic"] * (1 - .55 * dirt) * (1 - .6 * grime) * (1 - .5 * ground) * np.ones_like(rough), 0, 1)
        if m["finish"] == "glass":
            albedo, rough = stylised_glass(np, base, pos.astype(np.float32), nrm.astype(np.float32), edge, cav, seed)
        if m.get("glow"):
            # Lit look baked into the albedo (no emissive slot in the import): warm, bright, brightest mid-pane.
            lit = np.clip(np.array(m["color"], np.float32) * 1.25 + .12, 0, 1)
            k = min(1.0, .25 + .12 * m["glow"]) * (1 - .5 * smoothstep(np, .1, .6, cav))
            albedo = albedo * (1 - k[..., None]) + lit * k[..., None]
        height = height - .0004 * wear * (breakup > .1)
        ppm = max(info.get("texelsPerMetre", 200.0), 1.0)
        texel = 1.0 / ppm
        gx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) / (2 * texel)
        gy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) / (2 * texel)
        gx = np.clip(gx, -1.5, 1.5)
        gy = np.clip(gy, -1.5, 1.5)
        nl = np.sqrt(gx * gx + gy * gy + 1)
        normal = np.stack([-gx / nl * .5 + .5, -gy / nl * .5 + .5, 1 / nl * .5 + .5], -1)
        empty = ~filled
        albedo[empty] = albedo[covered].mean(0) if covered.any() else base
        rough[empty] = m["roughness"]
        normal[empty] = (.5, .5, 1.0)
        write_material(bpy, directory, m, albedo, normal, rough, metal, size)
        info["surfaces"][mid] = {"finish": m["finish"], "coverage": round(float(covered.mean()), 3),
                                 "edgeWear": round(float(((wear > .2) & covered).mean() / max(covered.mean(), 1e-6)), 3),
                                 "cavity": round(float(((dirt > .2) & covered).mean() / max(covered.mean(), 1e-6)), 3),
                                 "grime": round(float(((grime > .1) & covered).mean() / max(covered.mean(), 1e-6)), 3)}
        if m.get("glow"):
            info["surfaces"][mid]["glow"] = m["glow"]
            info.setdefault("glow", []).append(glow_hint(m, obj))


def stylised_glass(np, base, pos, nrm, edge, cav, seed):
    """Opaque glass that still reads as glass: a dark tinted body, a bright rim along convex
    edges (frame catch-light) and two soft diagonal specular streaks; low roughness."""
    lum = float(base @ np.array([.2126, .7152, .0722], np.float32))
    body = base * (.42 / max(lum, .05)) * .32 if lum > .1 else base * .9
    depth = fbm3(np, pos, .3, 2, seed + 71)
    diag = (pos[..., 0] * .7 - pos[..., 1] * .45 + pos[..., 2] * 1.0)
    upright = 1 - smoothstep(np, .5, .9, np.abs(nrm[..., 2]))
    streak = (smoothstep(np, .9, .99, np.cos(diag * 9.0 + depth * 1.2)) * .8 + smoothstep(np, .95, .995, np.cos(diag * 23.0 + 1.3)) * .45) * upright
    rim = smoothstep(np, .15, .5, edge)
    shade = 1 - .45 * smoothstep(np, .1, .5, cav)
    albedo = body[None, None, :] * (.85 + .3 * depth[..., None]) * shade[..., None]
    bright = np.clip(base * 1.35 + .28, 0, .95)
    albedo = albedo + (bright - albedo) * np.clip(.6 * rim + .3 * streak * shade, 0, .75)[..., None]
    rough = np.clip(.05 + .03 * depth - .03 * streak + .1 * rim, .02, .3)
    return albedo.astype(np.float32), rough.astype(np.float32)


def glow_hint(m, obj):
    """Roblox imports have no emissive slot: a glowing material asks the scene for a Neon part
    and a PointLight at its centre (Studio units: studs, brightness 0-10)."""
    pts = [v.co for v in obj.data.vertices]
    lo = [min(p[k] for p in pts) for k in range(3)]
    hi = [max(p[k] for p in pts) for k in range(3)]
    span = max(h - l for l, h in zip(lo, hi))
    colour = [round(min(1.0, c * 1.25 + .12), 3) for c in m["color"]]
    return {"material": m["id"], "neon": {"color": colour, "sizeMeters": [round(h - l, 3) for l, h in zip(lo, hi)]},
            "pointLight": {"position": [round((l + h) / 2, 3) for l, h in zip(lo, hi)], "color": colour,
                           "brightness": round(min(10.0, float(m["glow"])), 2), "rangeStuds": round(min(60.0, max(8.0, span * 3.57 * 12)), 1)}}


def library_maps(m, pick, obj, bvh, span, seed, info):
    """Bake the chosen library family (explicit or inferred, see model_materials) over obj's UV0
    atlas (workers/blender/materials), or None when the library is not shipped, does not know the
    name or fails (the finish bake is used)."""
    name = pick["library"]
    try:
        import mat_bake
        import mat_library
    except ImportError:
        info.setdefault("surfaceNotes", []).append("library %s unavailable; finish bake used" % name)
        return None
    if name not in mat_library.NAMES:
        info.setdefault("surfaceNotes", []).append("library %s unknown; finish bake used" % name)
        return None
    params = {k: (tuple(v) if isinstance(v, list) else v) for k, v in pick["params"].items()}
    known = mat_library.describe()[name]["params"]
    params = {k: v for k, v in params.items() if k in known}
    kw = {"frame": pick.get("frame", "box")}
    if kw["frame"] == "axis":
        pts = [v.co for v in obj.data.vertices]
        kw["axis"] = tuple(pick.get("axis", (0, 0, 1)))
        kw["centre"] = ((min(p.x for p in pts) + max(p.x for p in pts)) / 2, (min(p.y for p in pts) + max(p.y for p in pts)) / 2, 0.0)
    try:
        samples = mat_bake.object_samples(obj, RESOLUTION, "UVMap")
        mat_bake.mesh_masks(samples, bvh, span)
        result = mat_library.bake(name, samples, params, seed=int(seed) % (2 ** 31), **kw)
    except Exception as error:  # A library failure never fails the asset: the finish bake remains.
        info.setdefault("surfaceNotes", []).append("library %s failed (%s); finish bake used" % (name, type(error).__name__))
        return None
    maps = dict(result["maps"])
    maps["_evidence"] = result["evidence"]
    return maps


def box_blur(np, a, r):
    out = a.copy()
    for axis in (0, 1):
        acc = out.copy()
        for k in range(1, r + 1):
            acc = acc + np.roll(out, k, axis) + np.roll(out, -k, axis)
        out = acc / (2 * r + 1)
    return out


def srgb(np, x):
    x = np.clip(x, 0, 1)
    return np.where(x <= .0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - .055)


def write_material(bpy, directory, m, albedo, normal, rough, metal, size, library=None):
    from model_spec import FINISHES
    np = np_()
    mid = m["id"][:1].upper() + m["id"][1:]
    mat = bpy.data.materials["MAT_" + mid]
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    shader = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
    uvn = nodes.new("ShaderNodeUVMap")
    uvn.name, uvn.uv_map = "Arcane_UV0", "UVMap"
    if library is None:
        ones = np.ones(albedo.shape[:2] + (1,), np.float32)
        pixels = {
            "BaseColor": np.concatenate([srgb(np, albedo), ones], -1),
            "Normal": np.concatenate([normal, ones], -1),
            "MetallicRoughness": np.concatenate([ones, rough[..., None], metal[..., None], ones], -1),
        }
    else:
        # Same image names, colour spaces and binding as the finish bake.
        pixels = {"BaseColor": library["baseColor"], "Normal": library["normal"],
                  "MetallicRoughness": library["metallicRoughness"]}  # R occlusion, G roughness, B metallic as the import expects
    roles = [("baseColor", "BaseColor", "sRGB"), ("normal", "Normal", "Non-Color"), ("metallicRoughness", "MetallicRoughness", "Non-Color")]
    textures = {}
    for role, suffix, space in roles:
        name = "T_" + mid + "_" + suffix
        image = bpy.data.images.new(name, width=size, height=size, alpha=True)
        image.colorspace_settings.name = space
        image.pixels.foreach_set(pixels[suffix].astype(np.float32).ravel())
        image.filepath_raw = str(directory / ".worker" / (name + ".png"))
        image.file_format = "PNG"
        image.save()
        image.pack()
        tex = nodes.new("ShaderNodeTexImage")
        tex.name, tex.image, tex.extension, tex.interpolation = "Arcane_" + suffix, image, "REPEAT", "Linear"
        links.new(uvn.outputs["UV"], tex.inputs["Vector"])
        textures[role] = tex
    links.new(textures["baseColor"].outputs["Color"], shader.inputs["Base Color"])
    channels = nodes.new("ShaderNodeSeparateColor")
    channels.name, channels.mode = "Arcane_MR_Channels", "RGB"
    links.new(textures["metallicRoughness"].outputs["Color"], channels.inputs["Color"])
    links.new(channels.outputs["Green"], shader.inputs["Roughness"])
    links.new(channels.outputs["Blue"], shader.inputs["Metallic"])
    nmap = nodes.new("ShaderNodeNormalMap")
    nmap.name, nmap.space, nmap.uv_map = "Arcane_TangentNormal", "TANGENT", "UVMap"
    nmap.inputs["Strength"].default_value = 1
    links.new(textures["normal"].outputs["Color"], nmap.inputs["Color"])
    links.new(nmap.outputs["Normal"], shader.inputs["Normal"])
    mat["arcane_surface"] = json.dumps({"profile": FINISHES[m["finish"]][0], "resolution": size, "generator": "arcane-tile-v1",
                                        "texCoord": 0, "pattern": "spec-" + m["finish"], "alphaMode": "OPAQUE"})
    mat.update_tag()
