"""Model spec compiler, pure stage: part graph -> world-space closed meshes within budget.

plan(request) validates the spec, resolves parent transforms, expands array/radial/mirror
copies and Poisson scatter, applies seeded noise, and picks ONE global target edge length
(by bisection) so that every part's tessellation fits the triangle budget. SDF parts are
meshed by marching tetrahedra finer than their share and carry a decimation target that
the Blender stage (model_build.py) enforces. Deterministic for (spec, seed).
"""
import hashlib
import math
import random

import model_detail as D
import model_geom as G
from model_sdf import Field, mesh_field, noise_field, noise_mask
from model_spec import validate, FINISHES

HARD_TRIANGLE_LIMIT = 20000
AXIS = {"x": (1.0, 0.0, 0.0), "y": (0.0, 1.0, 0.0), "z": (0.0, 0.0, 1.0)}
MIRROR = {"x": G.scaling((-1, 1, 1)), "y": G.scaling((1, -1, 1)), "z": G.scaling((1, 1, -1))}


def stable_seed(*parts):
    text = "\0".join(str(p) for p in parts)
    return int.from_bytes(hashlib.sha256(text.encode("utf-8")).digest()[:4], "big")


class Instance:
    __slots__ = ("key", "part", "material", "csg", "targets", "mesh", "matrix", "auto_uv", "smooth", "target", "grain", "scatter", "op", "weld")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))


class Plan:
    def __init__(self, spec, instances, edge, budget, warnings):
        self.spec, self.instances, self.edge, self.budget, self.warnings = spec, instances, edge, budget, warnings
        self.detail = {}

    def solids(self):
        return [i for i in self.instances if i.csg not in ("subtract", "intersect")]

    def cutters(self):
        return [i for i in self.instances if i.csg in ("subtract", "intersect")]

    def estimated_triangles(self):
        return sum(i.target if i.target else i.mesh.triangles() for i in self.solids())


def prototype(p, edge):
    """The part's mesh in its own local frame at target edge `edge` (SDF parts: (mesh, target))."""
    e = edge / p["detail"]
    seg = p["segments"]
    op = p["op"]
    cap = p.get("_bevelSegments", 6)
    if op == "box":
        if p.get("_blocks"):
            return D.ashlar(p, p["_blocks"])
        return G.box(p["size"], p["bevel"], e, cap, p.get("_grid", 0.0))
    if op == "cylinder":
        return G.cylinder(p["radius"], p["height"], p["radiusTop"], p["bevel"], e, seg, cap)
    if op == "sphere":
        return G.sphere(p["radius"], e, seg)
    if op == "revolve":
        return G.revolve(p["profile"], e, p["curve"], p["flutes"], seg, p["closed"])
    if op == "extrude":
        return G.extrude(G.shape_points(p["shape"], e, seg), p["height"], p["bevel"], p["inset"], e, cap)
    if op == "loft":
        return G.loft(p["sections"], e, p["curve"], seg)
    if op == "sweep":
        pts = G.sample_path(p["path"], e)
        outline = G.shape_points(p["shape"], e, seg)
        return G.sweep(pts, p["path"]["closed"], outline, p["twist"], p["taper"])
    raise ValueError("Model spec: unsupported operator")


def sdf_area(p):
    return Field(p["shapes"]).area


def sdf_target(p, edge, scale):
    s = (abs(scale[0] * scale[1] * scale[2])) ** (2 / 3)
    e = edge / p["detail"]
    return int(max(160, min(8000, 2.3 * sdf_area(p) * s / (e * e))))


def copies_of(p, base, proto=None):
    mats = [base]
    a = p["array"]
    if a:
        out = []
        if a["grid"]:
            nx, ny, nz = a["grid"]
            for i in range(nx):
                for j in range(ny):
                    for k in range(nz):
                        off = ((i - (nx - 1) / 2) * a["step"][0], (j - (ny - 1) / 2) * a["step"][1], (k - (nz - 1) / 2) * a["step"][2])
                        out.extend(G.matmul(G.translate(off), m) for m in mats)
        elif a["path"]:
            pts = G.sample_path(a["path"], 1e-3 + G.polyline_length(a["path"]["points"], a["path"]["closed"]) / 400)
            stations = place_along(pts, a["path"]["closed"], a["count"])
            for pos, tangent in stations:
                if a["align"]:
                    x = G.norm(tangent)
                    z = (0.0, 0.0, 1.0) if abs(x[2]) < .95 else (1.0, 0.0, 0.0)
                    y = G.norm(G.cross(z, x))
                    z = G.cross(x, y)
                    f = G.frame(pos, x, y, z)
                else:
                    f = G.translate(pos)
                out.extend(G.matmul(f, m) for m in mats)
        else:
            for k in range(a["count"]):
                step = G.translate(G.mul(a["step"], k))
                spin = G.euler(G.mul(a["rotStep"], k))
                out.extend(G.matmul(step, G.matmul(m, spin)) for m in mats)
        mats = out
    r = p["radial"]
    if r:
        out = []
        c = r["center"]
        for k in range(r["count"]):
            rot = G.rot_axis(r["axis"], r["offset"] + 360.0 * k / r["count"])
            about = G.matmul(G.translate(c), G.matmul(rot, G.translate(G.mul(c, -1))))
            out.extend(G.matmul(about, m) for m in mats)
        mats = out
    if p["mirror"]:
        for axis in p["mirror"]:
            mats = mats + [G.matmul(MIRROR[axis], m) for m in mats]
    # Drop coincident copies (a mirror or radial copy of a part symmetric about that plane/axis):
    # compared by transformed geometry, since a mirrored matrix can still give the same solid.
    unique, seen = [], set()
    for m in mats:
        if proto is not None:
            key = tuple(sorted(tuple(round(c, 6) for c in G.apply(m, v)) for v in proto.verts))
        else:
            key = tuple(round(v, 7) for row in m[:3] for v in row)
        if key not in seen:
            seen.add(key)
            unique.append(m)
    return unique, len(mats) - len(unique)


def place_along(points, closed, count):
    dist = [0.0]
    loop = points + ([points[0]] if closed else [])
    for a, b in zip(loop, loop[1:]):
        dist.append(dist[-1] + math.dist(a, b))
    total = dist[-1]
    out, seg = [], 0
    for k in range(count):
        target = total * (k / count if closed else k / max(1, count - 1))
        while seg < len(dist) - 2 and dist[seg + 1] < target:
            seg += 1
        a, b = loop[seg], loop[seg + 1]
        t = (target - dist[seg]) / max(dist[seg + 1] - dist[seg], 1e-12)
        out.append((G.lerp(a, b, min(1.0, max(0.0, t))), G.sub(b, a)))
    return out


def grain_axis(p, mesh):
    if p["grain"] != "auto":
        return "xyz".index(p["grain"])
    lo, hi = mesh.bounds()
    ext = [h - l for l, h in zip(lo, hi)]
    return max(range(3), key=lambda k: (ext[k], -k))


def world_bases(spec):
    by = {p["id"]: p for p in spec["parts"]}
    cache = {}

    def base(pid):
        if pid not in cache:
            p = by[pid]
            local = G.compose(p["at"], p["rot"], p["scale"])
            cache[pid] = G.matmul(base(p["parent"]), local) if p["parent"] else local
        return cache[pid]
    return {pid: base(pid) for pid in by}


def scatter_frames(p, targets, seed, solids=None):
    """Seeded Poisson-disk points on the target meshes, aligned to the surface normal. With
    `solids` (model_detail.Solids of the other parts), faces buried inside another solid are skipped."""
    s = p["scatter"]
    rng = random.Random(stable_seed("scatter", seed, p["id"], s["seed"]))
    tris = []
    for mesh in targets:
        own = []
        for face in mesh.faces:
            a = mesh.verts[face[0]]
            for i in range(1, len(face) - 1):
                b, c = mesh.verts[face[i]], mesh.verts[face[i + 1]]
                n = G.cross(G.sub(b, a), G.sub(c, a))
                area = G.length(n) / 2
                if area > 1e-12 and G.norm(n)[2] >= s["minUp"]:
                    own.append((area, a, b, c, G.norm(n), mesh))
        if solids is not None:
            own = D.visible_triangles(own, solids, lambda inst, mesh=mesh: inst.mesh is mesh)
        tris.extend(own)
    if not tris:
        return []
    total = sum(t[0] for t in tris)
    cumulative, acc = [], 0.0
    for t in tris:
        acc += t[0]
        cumulative.append(acc)
    spacing = s["spacing"] or .7 * math.sqrt(total / s["count"])
    accepted = []
    import bisect
    for _ in range(s["count"] * 40):
        if len(accepted) >= s["count"]:
            break
        _, a, b, c, n, host = tris[min(len(tris) - 1, bisect.bisect_left(cumulative, rng.random() * total))]
        u, v = rng.random(), rng.random()
        if u + v > 1:
            u, v = 1 - u, 1 - v
        q = G.add(a, G.add(G.mul(G.sub(b, a), u), G.mul(G.sub(c, a), v)))
        if solids is not None and solids.inside_any(G.add(q, G.mul(n, 1e-3)), lambda inst, host=host: inst.mesh is host):
            continue  # this spot of the face is covered by another part
        if any(math.dist(q, o[0]) < spacing for o in accepted):
            continue
        accepted.append((q, n))
    frames = []
    for q, n in accepted:
        up = G.norm(G.lerp((0.0, 0.0, 1.0), n, s["align"]))
        x = G.perpendicular(up)
        y = G.cross(up, x)
        yaw = (rng.random() - .5) * s["yaw"]
        k = s["scaleRange"][0] + (s["scaleRange"][1] - s["scaleRange"][0]) * rng.random()
        f = G.frame(G.sub(q, G.mul(up, s["sink"])), x, y, up)
        frames.append(G.matmul(f, G.matmul(G.rot_axis("z", yaw), G.scaling((k, k, k)))))
    return frames


def build_instances(spec, seed, edge, final):
    """All instances at `edge`. During the budget search (final=False) SDF parts are estimated."""
    bases = world_bases(spec)
    by = {p["id"]: p for p in spec["parts"]}
    instances, warnings, built = [], [], {}
    order = [p for p in spec["parts"] if not p["scatter"]] + [p for p in spec["parts"] if p["scatter"]]
    for p in order:
        if p["op"] == "sdf":
            if final:
                field = Field(p["shapes"], p["noise"], stable_seed("noise", seed, p["id"]))
                target = sdf_target(p, edge, p["scale"])
                # Mesh about twice as finely as the target for a clean decimation, bounded for time.
                cell = math.sqrt(field.area / max(1.0, target * 2.6))
                cell = min(cell, max(field.min_feature / 2.5, 1e-3)) if field.min_feature < 1e8 else cell
                res = p["resolution"]
                if res:
                    cell = max(b - a for a, b in zip(field.lo, field.hi)) / res
                proto, _ = mesh_field(field, cell, 72 if not res else res + 4)
                if not proto.faces:
                    raise ValueError("Model spec: sdf part " + p["id"] + " is empty (check subtract order and sizes)")
            else:
                proto, target = None, sdf_target(p, edge, p["scale"])
        else:
            proto, target = prototype(p, edge), 0
        base = bases[p["id"]]
        if p["scatter"]:
            on = [i.mesh for i in instances if i.part == p["scatter"]["on"]]
            if not final:
                # Budget search: assume every requested copy lands.
                mats = [base] * p["scatter"]["count"]
            else:
                parent = G.compose(p["at"], p["rot"], p["scale"])
                solids = D.Solids([i for i in instances if i.csg not in ("subtract", "intersect")]) if spec.get("autoDetail", True) else None
                mats = [G.matmul(f, parent) for f in scatter_frames(p, on, seed, solids)]
                if len(mats) < p["scatter"]["count"]:
                    warnings.append("scatter %s placed %d of %d (surface too small for its spacing or minUp)" % (p["id"], len(mats), p["scatter"]["count"]))
            dropped = 0
        else:
            mats, dropped = copies_of(p, base, proto)
        if dropped:
            warnings.append("part %s: %d coincident copies dropped (mirror/radial of a centred part)" % (p["id"], dropped))
        built[p["id"]] = proto
        if proto is not None:
            lo3, hi3 = proto.bounds()
            p["_extent"] = min((h - l) * abs(s) for l, h, s in zip(lo3, hi3, p["scale"]))
        nz = None
        if final and p["noise"] and p["op"] != "sdf":
            nz = (noise_field(p["noise"], stable_seed("noise", seed, p["id"])), noise_mask(p["noise"]))
        for n, m in enumerate(mats):
            mesh = proto.transformed(m) if proto is not None else None
            if mesh is not None and nz is not None:
                field, mask = nz
                shift = stable_seed("instance", p["id"], n) % 997 * 1.37

                def f(q, field=field, shift=shift):
                    return field((q[0] + shift, q[1] - shift, q[2]))
                G.displace(mesh, f, mask)
            instances.append(Instance(key="%s#%d" % (p["id"], n), part=p["id"], material=p["material"], csg=p["csg"], targets=p["with"],
                                      mesh=mesh, matrix=m, auto_uv=p["op"] == "sdf", smooth=spec["smoothAngle"] if p["smooth"] is None else p["smooth"],
                                      target=target if p["op"] == "sdf" else 0, grain=grain_axis(p, proto) if proto is not None else 2,
                                      scatter=bool(p["scatter"]), op=p["op"], weld=bool(p.get("_blocks"))))
    return instances, warnings


def estimate(spec, seed, edge):
    by_part, total = {}, 0
    bases = world_bases(spec)
    for p in spec["parts"]:
        if p["csg"] in ("subtract", "intersect"):
            continue
        if p["op"] == "sdf":
            tris = sdf_target(p, edge, p["scale"])
        else:
            tris = prototype(p, edge).triangles()
        n = p["scatter"]["count"] if p["scatter"] else len(copies_of(p, bases[p["id"]], None if p["op"] == "sdf" else prototype(p, edge))[0])
        by_part[p["id"]] = tris * n
        total += tris * n
    return total, by_part


def plan(request):
    spec = D.prepare(validate(request["procedural"]))
    seed = int(request["seed"])
    budget = min(int(request["triangleBudget"]), HARD_TRIANGLE_LIMIT)
    # Headroom for booleans; the Blender edge-bevel tier (model_build) degrades to fit what is left.
    csg = any(p["csg"] for p in spec["parts"])
    reserve = .82 if csg else .94
    goal = budget * reserve
    notes = D.fit_blocks(spec, goal, 0)
    span = max(spec["size"])
    lo, hi = span / 600, span / 5
    coarse, _ = estimate(spec, seed, hi)
    if coarse > goal:
        raise ValueError("Model spec: %d triangles even at the coarsest resolution exceeds the %d budget; reduce arrays/scatter/parts or raise triangleBudget" % (coarse, budget))
    if estimate(spec, seed, lo)[0] <= goal:
        hi = lo
    else:
        for _ in range(14):
            mid = math.sqrt(lo * hi)
            if estimate(spec, seed, mid)[0] <= goal:
                hi = mid
            else:
                lo = mid
    edge = hi
    # Micro relief spends what the silhouette, bevels and masonry leave (lowest priority tier).
    used, _ = estimate(spec, seed, edge)
    bases = world_bases(spec)
    counts = {p["id"]: (p["scatter"]["count"] if p["scatter"] else len(copies_of(p, bases[p["id"]], None)[0])) for p in spec["parts"]}
    notes += D.plan_relief(spec, goal - used, counts)
    if any(p.get("_grid") for p in spec["parts"]) and estimate(spec, seed, edge)[0] > goal:
        for p in spec["parts"]:
            if p.pop("_grid", None):
                p["noise"], p["_relief"] = None, 0.0
        notes.append("micro relief skipped (triangle budget)")
    instances, warnings = build_instances(spec, seed, edge, True)
    warnings = notes + warnings
    for inst in instances:
        if not inst.mesh.closed():
            raise ValueError("Model spec: part " + inst.part + " did not build a closed solid")
    seated = D.seat(instances, spec, warnings) if spec["autoDetail"] or any(p.get("_surface") for p in spec["parts"]) else {}
    plan_ = Plan(spec, instances, edge, budget, warnings)
    plan_.detail = detail_summary(spec, seated)
    # Floor pivot (and centred base): the lowest solid vertex rests on z = 0.
    pts = [v for i in plan_.solids() for v in i.mesh.verts]
    lo3 = [min(v[k] for v in pts) for k in range(3)]
    hi3 = [max(v[k] for v in pts) for k in range(3)]
    shift = (-(lo3[0] + hi3[0]) / 2, -(lo3[1] + hi3[1]) / 2, -lo3[2]) if spec["pivot"] == "base" else (0.0, 0.0, -lo3[2])
    move = G.translate(shift)
    for inst in instances:
        inst.mesh.verts = [G.add(v, shift) for v in inst.mesh.verts]
        inst.matrix = G.matmul(move, inst.matrix)
    built = [h - l for l, h in zip(lo3, hi3)]
    for k, name in enumerate("xyz"):
        want = spec["size"][k]
        if abs(built[k] - want) > max(.1 * want, .01):
            warnings.append("size %s: built %.3f m, spec says %.3f m" % (name, built[k], want))
    return plan_


def detail_summary(spec, seated):
    """Compact record of the automatic detail tiers for the review (audit.json review.detail)."""
    out = {"auto": spec["autoDetail"], "bevels": {}, "blocks": {}, "relief": {}, "surfaceDetails": seated}
    for p in spec["parts"]:
        if p.get("_bevelAuto"):
            out["bevels"][p["id"]] = round(p["bevel"], 4)
        if p.get("_blocks"):
            out["blocks"][p["id"]] = {k: round(v, 4) for k, v in p["_blocks"].items()}
        if p.get("_relief"):
            out["relief"][p["id"]] = round(p["_relief"], 4)
    return out


def edge_widths(spec):
    """Per part: (Blender edge-bevel width, segments) for the hard edges the planner could not
    round itself (CSG cuts, extrude corners, revolve/sweep/loft creases); None = skip."""
    out = []
    for p in spec["parts"]:
        if not spec["autoDetail"] or p["op"] == "sdf" or p["csg"] in ("subtract", "intersect"):
            out.append(None)
            continue
        d = p.get("_extent") or 0.0
        if p.get("_blocks"):
            d = min(d, p["_blocks"]["course"])
        w = D.width_for(p["_finish"], d) if d > 0 else 0.0
        out.append((w, D.BEVEL[p["_finish"]][3]) if w > 0 else None)
    return out


def surface_profile(material):
    return FINISHES[material["finish"]][0]
