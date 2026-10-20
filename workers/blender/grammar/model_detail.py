"""Automatic detail hierarchy for model specs: what makes a plain part graph read as crafted.

Pure Python (no bpy), deterministic, applied by model_plan unless the spec sets autoDetail:false.
Priority order inside the triangle budget (each tier only spends what the tiers above leave):
1. Silhouette: the planner's global edge length (model_plan) always comes first.
2. Edges: every box/cylinder/extrude without an explicit `bevel` gets a rounded bevel sized by
   the part and its material class (stone soft and wide, metal crisp and narrow, at most 2
   segments); the Blender stage then bevels the remaining hard edges (CSG cuts, extrude
   corners, revolve/sweep/loft creases) with the per-part `edge` width and adds weighted normals.
3. Masonry: stone boxes with a large face (or `blocks:true|{...}`) become an ashlar course
   pattern: chamfered blocks in running bond over a core recessed by the mortar depth.
4. Micro relief: large flat stone/plaster/wood box faces are subdivided with the budget that is
   left and displaced by a few millimetres of seeded noise (material-class amplitude).
Surface details (caps, nails, studs, rivets, handles; declared with `surface` or recognised by id
and size) must stand proud of the surface they sit on: a sunk detail is pushed out along the host
normal to its protrusion (default half its thickness), scattered copies on hidden faces are never
placed, and a declared detail that is buried (nothing of it shows) fails with a hint.
"""
import math
import random

import model_geom as G

# finish -> (bevel ratio of the part's smallest dimension, min width m, max width m, segments)
BEVEL = {
    "stone": (.05, .004, .03, 2), "plaster": (.05, .003, .02, 2), "ceramic": (.08, .001, .006, 2),
    "wood": (.045, .0015, .008, 2), "leather": (.1, .001, .005, 2), "fabric": (.15, .002, .015, 2),
    "plastic": (.06, .001, .005, 2), "metal": (.03, .0006, .003, 1), "glass": (.02, .0004, .0015, 1),
}
# finish -> (relief amplitude per metre of face, amplitude cap m, smallest qualifying face m)
RELIEF = {"stone": (.0025, .006, .5), "plaster": (.0015, .003, .5), "wood": (.0008, .0015, .6)}
DETAIL_WORDS = ("cap", "nail", "stud", "rivet", "bolt", "screw", "knob", "boss", "hinge", "latch", "clasp", "handle",
                "bracket", "plate", "corner", "pin", "button", "gem")
BLOCK_COST = 44  # triangles per chamfered block (model_geom.chamfer_box)


def stable(*parts):
    import hashlib
    return int.from_bytes(hashlib.sha256("\0".join(str(p) for p in parts).encode()).digest()[:4], "big")


def width_for(finish, d):
    """Bevel width for a feature of smallest dimension d (metres) in this material class."""
    ratio, lo, hi, _ = BEVEL[finish]
    return max(0.0, min(max(ratio * d, lo), hi, .2 * d))


def shape_min(s):
    t = s["type"]
    if t == "circle":
        return 2 * s["r"]
    if t == "ellipse":
        return 2 * min(s["rx"], s["ry"])
    if t == "rect":
        return min(s["w"], s["h"])
    if t == "ngon":
        return 2 * s["r"] * math.sin(math.pi / s["n"])
    if t == "star":
        return .5 * min(s["r"], s["r2"])
    pts = s["points"]
    return min(math.dist(a, b) for a, b in zip(pts, pts[1:] + pts[:1]))


def auto_bevel(p, finish):
    """(width, segments) for a part whose `bevel` was not given, or None."""
    op = p["op"]
    _, _, _, segs = BEVEL[finish]
    if op == "box":
        d = min(p["size"])
        w = width_for(finish, d)
        return (w, segs) if w * 2 < d else None
    if op == "cylinder":
        top = p["radiusTop"] or p["radius"]
        d = min(p["height"], 2 * min(p["radius"], top))
        w = width_for(finish, d)
        return (w, segs) if w * 2 < d else None
    if op == "extrude":
        d = min(p["height"], shape_min(p["shape"]))
        w = min(width_for(finish, d), .2 * shape_min(p["shape"]))
        if p["shape"]["round"] > 0:
            w = min(w, .8 * (p["shape"]["round"] - (p["inset"]["width"] if p["inset"] else 0.0)))
        return (w, segs) if w > 0 and w * 2 < p["height"] else None
    return None


def surface_word(pid):
    words = pid.split("_")
    return any(w.rstrip("s") in DETAIL_WORDS for w in words)


def prepare(spec):
    """Resolve the automatic tiers that do not depend on the budget: bevels, masonry blocks and
    surface-detail declarations. Mutates the validated spec's parts (keys starting `_`)."""
    finishes = {m["id"]: m["finish"] for m in spec["materials"]}
    auto = spec.get("autoDetail", True)
    span = max(spec["size"])
    for p in spec["parts"]:
        cutter = p["csg"] in ("subtract", "intersect")
        finish = finishes.get(p["material"], "stone")
        p["_finish"] = finish
        p["_bevelSegments"] = 6
        p["_bevelAuto"] = False
        if auto and not cutter and p.get("bevelAuto") and p["op"] in ("box", "cylinder", "extrude"):
            got = auto_bevel(p, finish)
            if got:
                p["bevel"], p["_bevelSegments"] = got
                p["_bevelAuto"] = True
        p["_blocks"] = None
        if p["op"] == "box" and not cutter and p.get("blocks") is not False and (auto or p.get("blocks")):
            p["_blocks"] = block_layout(p, finish, explicit=p.get("blocks"))
        p["_surface"] = None
        s = p.get("surface")
        if s is not False and not cutter:
            if isinstance(s, dict):
                p["_surface"] = {"declared": True, "protrude": s.get("protrude"), "on": s.get("on")}
            elif s is True:
                p["_surface"] = {"declared": True, "protrude": None, "on": None}
            elif auto and surface_word(p["id"]):
                p["_surface"] = {"declared": False, "protrude": None, "on": None}
            elif auto and finish == "metal" and p["op"] in ("box", "cylinder", "sphere", "extrude") and part_extent(p) <= .12 * span:
                p["_surface"] = {"declared": False, "protrude": None, "on": None, "foreign": True}
    return spec


def part_extent(p):
    s = p["scale"]
    if p["op"] == "box":
        return max(a * b for a, b in zip(p["size"], s))
    if p["op"] == "cylinder":
        return max(2 * max(p["radius"], p["radiusTop"]) * max(s[0], s[1]), p["height"] * s[2])
    if p["op"] == "sphere":
        return 2 * p["radius"] * max(s)
    if p["op"] == "extrude":
        sh = p["shape"]
        if sh["type"] == "polygon":
            xs, ys = [q[0] for q in sh["points"]], [q[1] for q in sh["points"]]
            w = max(max(xs) - min(xs), max(ys) - min(ys))
        else:
            w = 2 * max(sh.get(k) or 0.0 for k in ("r", "rx", "ry", "w", "h", "r2"))
        return max(p["height"], w) * max(s)
    return 1e9


# ----------------------------------------------------------------- masonry --
def block_layout(p, finish, explicit=None):
    """Ashlar settings for a stone box (or an explicit `blocks` request), else None."""
    sx, sy, sz = (a * b for a, b in zip(p["size"], p["scale"]))
    dims = sorted((sx, sy, sz))
    if not explicit and (finish != "stone" or dims[1] < 1.2 or p["noise"]):
        return None
    cfg = explicit if isinstance(explicit, dict) else {}
    height = sz
    course = cfg.get("course") or max(.18, min(.5, height / max(1, round(height / .32))))
    length = cfg.get("length") or course * 1.85
    mortar = cfg.get("mortar") or max(.006, min(.016, course * .035))
    depth = cfg.get("depth") or max(.006, min(.014, course * .03))
    return {"course": course, "length": length, "mortar": mortar, "depth": depth}


def ashlar(p, cfg):
    """Blocks in running bond over a recessed core, in the part's local frame (centred).
    Courses run along local z; blocks run along the longer horizontal axis and pass through
    the thinner one, so both faces and the ends show the joint pattern."""
    size = p["size"]
    long_axis = 0 if size[0] >= size[1] else 1
    thin = 1 - long_axis
    L, T, H = size[long_axis], size[thin], size[2]
    g, depth = cfg["mortar"], cfg["depth"]
    rng = random.Random(stable("ashlar", p["id"], round(L, 4), round(H, 4)))
    n = max(1, int(round(H / cfg["course"])))
    c = H / n
    mesh = G.Mesh()
    chamfer = min(.6 * depth + .004, .15 * c)

    def add_block(x0, x1, z0, z1, out0, out1):
        bsize = [0.0, 0.0, 0.0]
        centre = [0.0, 0.0, 0.0]
        bsize[long_axis], centre[long_axis] = x1 - x0, (x0 + x1) / 2
        bsize[2], centre[2] = z1 - z0, (z0 + z1) / 2
        bsize[thin], centre[thin] = T + out0 + out1, (out1 - out0) / 2
        block = G.chamfer_box(bsize, chamfer)
        block.tones = [1 + len(mesh.faces) // 26 % 250] * len(block.faces)  # one tone per stone
        mesh.extend(block, G.translate(centre))
    for k in range(n):
        z0 = -H / 2 + k * c + (g / 2 if k else 0.0)
        z1 = -H / 2 + (k + 1) * c - (g / 2 if k < n - 1 else 0.0)
        b = cfg["length"]
        x = -L / 2
        cuts = [x]
        first = b * (.5 if k % 2 else 1.0) * (1 + (rng.random() - .5) * .3)
        x += first
        while x < L / 2 - .35 * b:
            cuts.append(x)
            x += b * (1 + (rng.random() - .5) * .3)
        cuts.append(L / 2)
        for i in range(len(cuts) - 1):
            x0 = cuts[i] + (g / 2 if i else 0.0)
            x1 = cuts[i + 1] - (g / 2 if i < len(cuts) - 2 else 0.0)
            if x1 - x0 < 2.5 * chamfer:
                continue
            # Slightly proud or sunk faces per block (hand-set stone), never into the core.
            out0 = depth * (rng.random() - .35) * .45
            out1 = depth * (rng.random() - .35) * .45
            add_block(x0, x1, z0, z1, out0, out1)
    core = [0.0, 0.0, 0.0]
    core[long_axis], core[thin], core[2] = L - 2 * depth, T - 2 * depth, H - 2 * depth
    mesh.extend(G.box(core))
    return mesh


def block_count(p, cfg):
    size = p["size"]
    L, H = max(size[0], size[1]), size[2]
    n = max(1, int(round(H / cfg["course"])))
    return n * (int(L / cfg["length"]) + 2)


def fit_blocks(spec, goal, base_estimate):
    """Coarsen (or drop) masonry so blocks take at most 45% of the goal on top of the rest."""
    notes = []
    for p in spec["parts"]:
        cfg = p.get("_blocks")
        if not cfg:
            continue
        for _ in range(4):
            if block_count(p, cfg) * BLOCK_COST <= .45 * goal:
                break
            cfg["course"] *= 1.3
            cfg["length"] *= 1.3
        if block_count(p, cfg) * BLOCK_COST > .45 * goal or cfg["course"] > p["size"][2] / 2:
            p["_blocks"] = None
            notes.append("part %s: masonry blocks skipped (triangle budget)" % p["id"])
    return notes


# ------------------------------------------------------------- micro relief --
def relief_candidates(spec):
    out = []
    if not spec.get("autoDetail", True):
        return out
    for p in spec["parts"]:
        if p["op"] != "box" or p["csg"] in ("subtract", "intersect") or p["noise"] or p.get("_blocks") or p["scatter"]:
            continue
        rule = RELIEF.get(p["_finish"])
        if not rule:
            continue
        dims = sorted(a * b for a, b in zip(p["size"], p["scale"]))
        if dims[1] < rule[2]:
            continue
        out.append(p)
    return out


def plan_relief(spec, leftover, copies):
    """Spend up to 60% of the leftover triangles on relief grids: one shared cell size so
    sum(2 * area / cell^2) fits. Returns notes; sets p["_grid"] and p["noise"]."""
    parts = relief_candidates(spec)
    if not parts or leftover <= 0:
        return []
    area = 0.0
    for p in parts:
        x, y, z = (a * b for a, b in zip(p["size"], p["scale"]))
        area += 2 * (x * y + y * z + z * x) * copies[p["id"]]
    cell = math.sqrt(2 * area / max(1.0, .6 * leftover))
    notes = []
    for p in parts:
        dims = sorted(a * b for a, b in zip(p["size"], p["scale"]))
        if cell > dims[1] / 4:
            notes.append("part %s: micro relief skipped (triangle budget)" % p["id"])
            continue
        per_metre, cap, _ = RELIEF[p["_finish"]]
        amp = min(cap, per_metre * dims[2], .02 * dims[0] + .0005)
        p["_grid"] = cell / max(p["scale"])
        p["noise"] = {"amp": amp, "scale": max(.12, min(.9, .3 * dims[1])), "octaves": 3, "warp": .4,
                      "seed": stable("relief", p["id"]) % 65536, "mask": None}
        p["_relief"] = amp
    return notes


# ---------------------------------------------------------- surface details --
def tri_list(mesh):
    out = []
    for face in mesh.faces:
        a = mesh.verts[face[0]]
        for i in range(1, len(face) - 1):
            out.append((a, mesh.verts[face[i]], mesh.verts[face[i + 1]]))
    return out


def closest_on_triangle(p, a, b, c):
    """Closest point to p on triangle abc (Ericson, Real-Time Collision Detection 5.1.5)."""
    ab, ac, ap = G.sub(b, a), G.sub(c, a), G.sub(p, a)
    d1, d2 = G.dot(ab, ap), G.dot(ac, ap)
    if d1 <= 0 and d2 <= 0:
        return a
    bp = G.sub(p, b)
    d3, d4 = G.dot(ab, bp), G.dot(ac, bp)
    if d3 >= 0 and d4 <= d3:
        return b
    vc = d1 * d4 - d3 * d2
    if vc <= 0 and d1 >= 0 and d3 <= 0:
        return G.add(a, G.mul(ab, d1 / (d1 - d3)))
    cp = G.sub(p, c)
    d5, d6 = G.dot(ab, cp), G.dot(ac, cp)
    if d6 >= 0 and d5 <= d6:
        return c
    vb = d5 * d2 - d1 * d6
    if vb <= 0 and d2 >= 0 and d6 <= 0:
        return G.add(a, G.mul(ac, d2 / (d2 - d6)))
    va = d3 * d6 - d5 * d4
    if va <= 0 and d4 - d3 >= 0 and d5 - d6 >= 0:
        w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
        return G.add(b, G.mul(G.sub(c, b), w))
    denom = 1 / (va + vb + vc)
    return G.add(a, G.add(G.mul(ab, vb * denom), G.mul(ac, vc * denom)))


def inside(point, tris, direction=(.5773, .5774, .5773)):
    """Ray parity of a point against one closed triangle soup."""
    hits = 0
    for a, b, c in tris:
        e1, e2 = G.sub(b, a), G.sub(c, a)
        h = G.cross(direction, e2)
        det = G.dot(e1, h)
        if abs(det) < 1e-14:
            continue
        f = 1 / det
        s = G.sub(point, a)
        u = f * G.dot(s, h)
        if u < 0 or u > 1:
            continue
        q = G.cross(s, e1)
        v = f * G.dot(direction, q)
        if v < 0 or u + v > 1:
            continue
        if f * G.dot(e2, q) > 1e-9:
            hits += 1
    return hits % 2 == 1


class Solids:
    """Bounding-box indexed closed meshes (other parts' instances) for inside/closest queries."""

    def __init__(self, instances):
        self.items = []
        for inst in instances:
            lo, hi = inst.mesh.bounds()
            self.items.append((inst, lo, hi, None))

    def tris(self, k):
        inst, lo, hi, tris = self.items[k]
        if tris is None:
            tris = tri_list(inst.mesh)
            self.items[k] = (inst, lo, hi, tris)
        return tris

    def near(self, lo, hi, pad=0.0, skip=None):
        for k, (inst, a, b, _) in enumerate(self.items):
            if skip is not None and skip(inst):
                continue
            if all(a[i] - pad <= hi[i] and lo[i] <= b[i] + pad for i in range(3)):
                yield k, inst

    def inside_any(self, point, skip=None):
        for k, _ in self.near(point, point, 0.0, skip):
            if inside(point, self.tris(k)):
                return True
        return False


def visible_triangles(tris, solids, skip):
    """Drop triangles whose centre (nudged off the surface) lies inside another solid."""
    out = []
    for t in tris:
        a, b, c, n = t[1:5]
        centre = G.mul(G.add(G.add(a, b), c), 1 / 3)
        probe = G.add(centre, G.mul(n, 1e-3))
        if not solids.inside_any(probe, skip):
            out.append(t)
    return out


def seat(instances, spec, warnings):
    """Push sunk surface details out to their protrusion along the host normal (in place).
    Raises ValueError for a declared detail that is buried (its top below the host surface);
    buried scattered copies are dropped and buried recognised (undeclared) ones kept with a warning.
    Returns {part: {"raised": n, "maxShift": m, "dropped": n}}."""
    by = {p["id"]: p for p in spec["parts"]}
    finishes = {m["id"]: m["finish"] for m in spec["materials"]}
    details = {pid for pid, p in by.items() if p.get("_surface")}
    if not details:
        return {}
    hosts = Solids([i for i in instances if i.csg not in ("subtract", "intersect") and i.part not in details])
    report, keep = {}, []
    for inst in instances:
        p = by[inst.part]
        rule = p.get("_surface")
        if not rule or inst.csg in ("subtract", "intersect"):
            keep.append(inst)
            continue
        lo, hi = inst.mesh.bounds()
        size = max(h - l for l, h in zip(lo, hi))
        centre = tuple((l + h) / 2 for l, h in zip(lo, hi))
        on = rule.get("on")
        best = None
        for k, host in hosts.near(lo, hi, size * .75 + 1e-3, skip=(lambda h: h.part != on) if on else None):
            if not rule["declared"]:
                # Recognised details sit on larger hosts; metal fittings only on non-metal hosts.
                hlo, hhi = host.mesh.bounds()
                if max(h - l for l, h in zip(hlo, hhi)) < 2 * size or (rule.get("foreign") and finishes.get(host.material) == "metal"):
                    continue
            for a, b, c in hosts.tris(k):
                q = closest_on_triangle(centre, a, b, c)
                d = math.dist(q, centre)
                if best is None or d < best[0] - 1e-12:
                    n = G.cross(G.sub(b, a), G.sub(c, a))
                    if G.length(n) > 1e-14:
                        best = (d, q, G.norm(n), host.part)
        entry = report.setdefault(inst.part, {"raised": 0, "maxShift": 0.0, "dropped": 0})
        if best is None:
            keep.append(inst)
            continue
        _, q, n, host_part = best
        heights = [G.dot(G.sub(v, q), n) for v in inst.mesh.verts]
        top, bottom = max(heights), min(heights)
        extent = top - bottom
        need = rule.get("protrude") or max(.5 * extent, .0005)
        need = min(need, extent)
        shift = need - top
        if shift <= 1e-5:
            keep.append(inst)
            continue
        if top <= 1e-5:
            # Nothing of it shows: buried, not merely sunk.
            where = "part %s (copy %s) is buried %.1f mm inside %s" % (inst.part, inst.key.split("#")[-1], -top * 1000, host_part)
            if rule["declared"] and not p["scatter"]:
                raise ValueError("Model spec: " + where + "; move it onto the surface (its top must stand %.1f mm proud) or set surface.protrude" % (need * 1000))
            if p["scatter"]:
                entry["dropped"] += 1
                continue
            warnings.append(where + " (left in place; not declared as a surface detail)")
            keep.append(inst)
            continue
        move = G.mul(n, shift)
        inst.mesh.verts = [G.add(v, move) for v in inst.mesh.verts]
        inst.matrix = G.matmul(G.translate(move), inst.matrix)
        entry["raised"] += 1
        entry["maxShift"] = round(max(entry["maxShift"], shift), 5)
        keep.append(inst)
    instances[:] = keep
    report = {k: v for k, v in report.items() if v["raised"] or v["dropped"]}
    for pid, e in sorted(report.items()):
        if e["dropped"]:
            warnings.append("surface detail %s: %d buried copies dropped" % (pid, e["dropped"]))
    return report
