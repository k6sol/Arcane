"""Model spec compiler, Blender stage: plan -> clean game-ready meshes, UVs, review.

1. Every planned instance becomes a closed mesh object (analytic UVs in metres, a per-face
   part index). SDF parts are decimated to their triangle share.
2. CSG: csg:"union" parts of one material weld into one watertight solid (exact boolean,
   self-union); csg:"subtract"/"intersect" cutters cut their `with` parts (default: every
   solid they overlap). A boolean that would break the solid is skipped with a warning.
3. One mesh per material (source key = material id), triangulated, degenerate faces
   dissolved, coincident vertices separated, decimated to the triangle budget, sharp edges
   by each part's auto-smooth angle.
4. UV0: the general UV stage (uv_engine.unwrap) when it ships next to this file, otherwise
   analytic charts + smart projection for SDF faces, equalised and packed into one atlas.
5. Collision: up to 21 boxes from a voxelised greedy cover of the final solid (keeps
   openings such as arches walkable), one proxy object.
Review metrics and renders live in model_review.py; baked PBR in model_surface.py.
"""
import math
import time

import bpy
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import model_plan

STATE = {}
UV_TIMES = {}
COLLISION_BOXES = 21


def material_name(mid):
    return mid[:1].upper() + mid[1:]


def to_object(inst, index, instance, collection, name):
    me = bpy.data.meshes.new(name + "_Mesh")
    me.from_pydata(inst.mesh.verts, [], inst.mesh.faces)
    if me.validate(verbose=False):
        raise ValueError("Procedural mesh required structural repair")
    uv = me.uv_layers.new(name="UVMap")
    for poly, pts in zip(me.polygons, inst.mesh.uvs):
        for loop, p in zip(poly.loop_indices, pts):
            uv.data[loop].uv = p
    part = me.attributes.new("arcane_part", "INT", "FACE")
    part.data.foreach_set("value", [index] * len(me.polygons))
    owner = me.attributes.new("arcane_inst", "INT", "FACE")
    owner.data.foreach_set("value", [instance] * len(me.polygons))
    auto = me.attributes.new("arcane_auto_uv", "BOOLEAN", "FACE")
    auto.data.foreach_set("value", [inst.auto_uv] * len(me.polygons))
    obj = bpy.data.objects.new(name, me)
    collection.objects.link(obj)
    return obj


def bake_modifiers(obj):
    """Apply all modifiers through the evaluated mesh (no operator context needed)."""
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
    old = obj.data
    obj.modifiers.clear()
    obj.data = mesh
    bpy.data.meshes.remove(old)


def stats(obj):
    bm = bmesh.new()
    try:
        bm.from_mesh(obj.data)
        bad = sum(1 for e in bm.edges if not e.is_manifold)
        return len(bm.faces), bad, sum(len(f.verts) - 2 for f in bm.faces)
    finally:
        bm.free()


def triangles(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def snapshot(obj):
    return obj.data.copy()


def restore(obj, mesh):
    old = obj.data
    obj.data = mesh
    bpy.data.meshes.remove(old)


def decimate(obj, target, warnings, label):
    """Collapse-decimate to `target` triangles, keeping the solid closed (retries gentler)."""
    tris = triangles(obj)
    if tris <= target:
        return
    keep = snapshot(obj)
    for attempt in range(4):
        ratio = max(.01, min(1.0, target / tris * (1 + .15 * attempt)))
        mod = obj.modifiers.new("Budget", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        bake_modifiers(obj)
        faces, bad, _ = stats(obj)
        if faces and not bad:
            bpy.data.meshes.remove(keep)
            return
        restore(obj, keep.copy())
    bpy.data.meshes.remove(keep)
    warnings.append(label + ": decimation would open the solid; kept full resolution")


def boolean(target, operand, operation, warnings, label):
    keep = snapshot(target)
    mod = target.modifiers.new("CSG", "BOOLEAN")
    mod.operation = operation
    mod.solver = "EXACT"
    if isinstance(operand, bpy.types.Collection):
        mod.operand_type = "COLLECTION"
        mod.collection = operand
    else:
        mod.object = operand
    mod.use_self = operation == "UNION"
    bake_modifiers(target)
    faces, bad, _ = stats(target)
    if not faces or bad:
        restore(target, keep)
        warnings.append(label + ": boolean %s skipped (result would not be a closed solid)" % operation.lower())
        return False
    bpy.data.meshes.remove(keep)
    return True


def overlaps(a, b):
    la, ha = a
    lb, hb = b
    return all(la[k] <= hb[k] and lb[k] <= ha[k] for k in range(3))


def world_bounds(obj):
    pts = [v.co for v in obj.data.vertices]
    return tuple(min(p[k] for p in pts) for k in range(3)), tuple(max(p[k] for p in pts) for k in range(3))


def join(objects, name):
    """Merge meshes (already in world space) into the first object with bmesh, keeping layers."""
    base = objects[0]
    bm = bmesh.new()
    try:
        for obj in objects:
            bm.from_mesh(obj.data)
        bm.to_mesh(base.data)
    finally:
        bm.free()
    for obj in objects[1:]:
        mesh = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.meshes.remove(mesh)
    base.name = name
    base.data.name = name + "_Mesh"
    return base


def clean(obj):
    bm = bmesh.new()
    try:
        bm.from_mesh(obj.data)
        bmesh.ops.dissolve_degenerate(bm, dist=1e-6, edges=list(bm.edges))
        bmesh.ops.triangulate(bm, faces=list(bm.faces), quad_method="BEAUTY", ngon_method="BEAUTY")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        # Drop needle triangles that would carry no texels (merging their shortest edge).
        for _ in range(3):
            needles = [f for f in bm.faces if f.calc_area() < 1e-10]
            if not needles:
                break
            edges = {min(f.edges, key=lambda e: e.calc_length()) for f in needles}
            bmesh.ops.collapse(bm, edges=list(edges), uvs=True)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bm.normal_update()
        # Distinct parts may touch at exactly coincident vertices: separate them by 20 micrometres.
        seen = {}
        for v in bm.verts:
            key = tuple(round(c, 6) for c in v.co)
            if key in seen:
                v.co -= v.normal * 2e-5
            else:
                seen[key] = v
        bm.to_mesh(obj.data)
    finally:
        bm.free()


def sharp_edges(obj, angles):
    """Auto-smooth by angle per part (angle False = faceted)."""
    bm = bmesh.new()
    try:
        bm.from_mesh(obj.data)
        layer = bm.faces.layers.int.get("arcane_part")
        for f in bm.faces:
            f.smooth = angles[f[layer]] is not False
        for e in bm.edges:
            if len(e.link_faces) != 2:
                e.smooth = False
                continue
            a, b = e.link_faces
            ta, tb = angles[a[layer]], angles[b[layer]]
            if ta is False or tb is False:
                e.smooth = False
                continue
            # Seams between different parts (welds, cuts) stay crisp unless nearly flush.
            limit = math.radians(min(ta, tb)) * (1.0 if a[layer] == b[layer] else .6)
            e.smooth = e.calc_face_angle(math.pi) <= limit
        bm.to_mesh(obj.data)
    finally:
        bm.free()


# ---------------------------------------------------------------------- UV --
def external_uv():
    """The shared general UV stage (workers/blender/uv), when shipped beside this worker
    (flat in a job directory) or present in the repository layout; None otherwise."""
    import importlib
    import sys
    from pathlib import Path
    repo = Path(__file__).resolve().parent.parent / "uv"
    if (repo / "uv_stage.py").is_file() and str(repo) not in sys.path:
        sys.path.append(str(repo))
    try:
        stage = importlib.import_module("uv_stage")
    except ImportError:
        return None
    return stage if hasattr(stage, "unwrap_blender_mesh") else None


def read_uvs(obj):
    data = obj.data.uv_layers["UVMap"].data
    flat = [0.0] * (len(data) * 2)
    data.foreach_get("uv", flat)
    return flat


def write_uvs(obj, flat):
    obj.data.uv_layers["UVMap"].data.foreach_set("uv", flat)


def hidden_faces(objects):
    """Faces whose centre lies inside another solid part (never visible): per object, a set of indices."""
    verts, polys = [], []
    for obj in objects:
        base = len(verts)
        verts.extend(tuple(v.co) for v in obj.data.vertices)
        polys.extend(tuple(base + i for i in p.vertices) for p in obj.data.polygons)
    parent = {}

    def find(a):
        while parent.setdefault(a, a) != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for poly in polys:
        root = find(poly[0])
        for v in poly[1:]:
            other = find(v)
            if other != root:
                parent[other] = root
    comp = [find(p[0]) for p in polys]
    tree = BVHTree.FromPolygons(verts, polys)
    out = [set() for _ in objects]
    k = 0
    for n, obj in enumerate(objects):
        for p in obj.data.polygons:
            own, direction = comp[k], p.normal.copy()
            origin, winding = p.center + direction * 1e-5, 0
            for _ in range(24):
                loc, normal, index, _ = tree.ray_cast(origin, direction)
                if loc is None:
                    break
                if comp[index] != own:
                    winding += 1 if normal.dot(direction) > 0 else -1
                origin = loc + direction * 1e-5
            if winding > 0:
                out[n].add(p.index)
            k += 1
    return out


def shrink_hidden_islands(obj, hidden, factor=.25):
    """In edit mode: UV islands that are (almost) entirely hidden keep only a token texel share."""
    me = obj.data
    bm = bmesh.from_edit_mesh(me)
    uv = bm.loops.layers.uv["UVMap"]
    bm.faces.ensure_lookup_table()
    parent = list(range(len(bm.faces)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for e in bm.edges:
        if len(e.link_faces) != 2:
            continue
        f1, f2 = e.link_faces
        l1 = [l for l in f1.loops if l.edge == e][0]
        l2 = [l for l in f2.loops if l.edge == e][0]
        # A shared edge with matching UVs at both ends joins one island.
        if (l1[uv].uv - l2.link_loop_next[uv].uv).length < 1e-6 and (l1.link_loop_next[uv].uv - l2[uv].uv).length < 1e-6:
            parent[find(f1.index)] = find(f2.index)
    islands = {}
    for f in bm.faces:
        islands.setdefault(find(f.index), []).append(f)
    shrunk = 0
    for faces in islands.values():
        loops = [l for f in faces for l in f.loops]
        # Islands wound against their faces (cutter faces turned inside out by booleans) are
        # mirrored: flip U so the tangent basis keeps one handedness everywhere.
        signed = 0.0
        for f in faces:
            q = [l[uv].uv for l in f.loops]
            signed += sum((q[k].x - q[0].x) * (q[k + 1].y - q[0].y) - (q[k + 1].x - q[0].x) * (q[k].y - q[0].y) for k in range(1, len(q) - 1))
        if signed < 0:
            for l in loops:
                l[uv].uv.x = -l[uv].uv.x
        area = sum(f.calc_area() for f in faces)
        dark = sum(f.calc_area() for f in faces if f.index in hidden)
        if area <= 0 or dark < .9 * area:
            continue
        cx = sum(l[uv].uv.x for l in loops) / len(loops)
        cy = sum(l[uv].uv.y for l in loops) / len(loops)
        for l in loops:
            l[uv].uv.x = cx + (l[uv].uv.x - cx) * factor
            l[uv].uv.y = cy + (l[uv].uv.y - cy) * factor
        shrunk += 1
    bmesh.update_edit_mesh(me)
    return shrunk


def bundled_unwrap(obj, hidden, texture_size, shrink=True):
    """Analytic charts (metres) + smart projection of SDF faces, equal density, hidden islands
    shrunk, packed with Blender's concave packer."""
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    me = obj.data
    auto = [False] * len(me.polygons)
    if "arcane_auto_uv" in me.attributes:
        me.attributes["arcane_auto_uv"].data.foreach_get("value", auto)
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    bpy.ops.object.mode_set(mode="EDIT")
    bm = bmesh.from_edit_mesh(me)
    for f, flag in zip(bm.faces, auto):
        f.select = flag
    bmesh.update_edit_mesh(me)
    if any(auto):
        bpy.ops.uv.smart_project(angle_limit=math.radians(55), island_margin=0.0, scale_to_bounds=False, area_weight=0.0)
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.average_islands_scale()
    shrunk = shrink_hidden_islands(obj, hidden if shrink else set())
    t = time.perf_counter()
    # Box outlines with 90-degree turns: as tight as exact outlines for these charts, in milliseconds
    bpy.ops.uv.pack_islands(rotate=True, rotate_method="CARDINAL", scale=True, margin_method="FRACTION", margin=4 / texture_size, shape_method="AABB")
    UV_TIMES["pack"] = UV_TIMES.get("pack", 0) + time.perf_counter() - t
    bpy.ops.object.mode_set(mode="OBJECT")
    return shrunk


def visible_density(obj, size, hidden):
    me = obj.data
    uv = me.uv_layers["UVMap"].data
    a3 = a2 = 0.0
    for p in me.polygons:
        if p.index in hidden:
            continue
        pts = [me.vertices[i].co for i in p.vertices]
        q = [uv[i].uv for i in p.loop_indices]
        for k in range(1, len(pts) - 1):
            a3 += (pts[k] - pts[0]).cross(pts[k + 1] - pts[0]).length / 2
            a2 += abs((q[k].x - q[0].x) * (q[k + 1].y - q[0].y) - (q[k + 1].x - q[0].x) * (q[k].y - q[0].y)) / 2
    return math.sqrt(a2 / a3) * size if a3 > 0 else 0.0


def uv_stage(objects, texture_size, info, budget_seconds=40.0):
    """UV0 hand-off. Per material mesh the bundled analytic packer runs first (hidden islands
    shrunk); only if that layout fails the shared UV gate (uv_stage.audit_quality, when shipped)
    are the even-density bundled layout and the general UV stage (uv_stage.unwrap_blender_mesh)
    tried, within a time budget. The kept layout passes the gate first, then has the higher
    texel density on visible faces."""
    stage = external_uv()
    t0 = time.perf_counter()
    hidden = hidden_faces(objects)
    info["uvSeconds"] = {"hidden": round(time.perf_counter() - t0, 2)}
    info["hiddenFaces"] = {o["arcane_source_key"]: len(h) for o, h in zip(objects, hidden)}
    info["uvStage"], quality, density = {}, {}, []
    start = time.perf_counter()
    for obj, dark in zip(objects, hidden):
        key = obj["arcane_source_key"]
        analytic = read_uvs(obj)
        candidates = []

        def measure():
            t = time.perf_counter()
            out = stage.audit_quality(obj.data, "unique", texture_size) if stage is not None else None
            info["uvSeconds"]["measure"] = round(info["uvSeconds"].get("measure", 0) + time.perf_counter() - t, 2)
            return out
        bundled_unwrap(obj, dark, texture_size, True)
        candidates.append(("bundled", read_uvs(obj), measure(), visible_density(obj, texture_size, dark)))
        if candidates[0][2] and candidates[0][2].get("errors"):
            if dark and time.perf_counter() - start < budget_seconds:
                write_uvs(obj, analytic)
                bundled_unwrap(obj, dark, texture_size, False)
                candidates.append(("bundled-even", read_uvs(obj), measure(), visible_density(obj, texture_size, dark)))
            if not any(not (c[2] or {}).get("errors") for c in candidates) and time.perf_counter() - start < budget_seconds:
                write_uvs(obj, analytic)
                try:
                    # pack="engine": the "best" re-pack reuses a UV layer reference across an edit-mode round trip.
                    report = stage.unwrap_blender_mesh(obj, mode="atlas", texture_size=texture_size, pack="engine")
                    candidates.append(("uv_stage", read_uvs(obj), report, visible_density(obj, texture_size, dark)))
                except Exception as error:  # The hook never fails the asset; the bundled layouts remain.
                    info.setdefault("uvNotes", []).append("uv_stage %s on %s" % (type(error).__name__, key))
        info.setdefault("uvCandidates", {})[key] = [{"stage": c[0], "texelsPerMetre": round(c[3], 1), "errors": list((c[2] or {}).get("errors", []))[:3],
                                                     "utilization": (c[2] or {}).get("utilization")} for c in candidates]
        name, flat, report, ppm = min(candidates, key=lambda c: (len((c[2] or {}).get("errors", [])), -c[3]))
        write_uvs(obj, flat)
        info["uvStage"][key] = name
        density.append(ppm)
        for tag in ("arcane_uv_intent", "arcane_uv_texture"):
            if tag in obj:
                del obj[tag]
        if report is not None:
            quality[key] = {k: report.get(k) for k in ("utilization", "texelsPerMetre", "angleDistortion", "overlapFaces") if k in report}
            quality[key]["errors"] = list(report.get("errors", []))
            if not report.get("errors"):
                # Opt into the shared UV quality gate only with a layout that passes it.
                obj["arcane_uv_intent"], obj["arcane_uv_texture"] = "unique", int(texture_size)
    if quality:
        info["uvQuality"] = quality
    info["texelsPerMetre"] = round(min(density), 1)
    info["uvSeconds"].update({k: round(v, 2) for k, v in UV_TIMES.items()})
    info["uvSeconds"]["total"] = round(time.perf_counter() - start, 2)


def texel_density(obj, size):
    me = obj.data
    me.calc_loop_triangles()
    uv = me.uv_layers["UVMap"].data
    a3 = a2 = 0.0
    for t in me.loop_triangles:
        p = [me.vertices[i].co for i in t.vertices]
        q = [uv[i].uv for i in t.loops]
        a3 += (p[1] - p[0]).cross(p[2] - p[0]).length / 2
        a2 += abs((q[1].x - q[0].x) * (q[2].y - q[0].y) - (q[2].x - q[0].x) * (q[1].y - q[0].y)) / 2
    return math.sqrt(a2 / a3) * size if a3 > 0 else 0.0


# -------------------------------------------------------------- collision --
def collision_boxes(objects, limit=COLLISION_BOXES):
    """Greedy box cover of a voxelised solid; coarsens until it fits `limit` boxes."""
    verts, polys = [], []
    for obj in objects:
        base = len(verts)
        verts.extend(tuple(v.co) for v in obj.data.vertices)
        polys.extend(tuple(base + i for i in p.vertices) for p in obj.data.polygons)
    tree = BVHTree.FromPolygons(verts, polys)
    lo = Vector(tuple(min(v[k] for v in verts) for k in range(3)))
    hi = Vector(tuple(max(v[k] for v in verts) for k in range(3)))
    size = hi - lo

    def inside(p):
        # Winding number along one ray: robust where separate closed parts overlap.
        winding, origin = 0, Vector(p)
        direction = Vector((.5773, .5774, .5773))
        for _ in range(64):
            loc, normal, _, _ = tree.ray_cast(origin, direction)
            if loc is None:
                break
            winding += 1 if normal.dot(direction) > 0 else -1
            origin = loc + direction * 1e-5
        return winding > 0
    for res in (14, 10, 7, 5, 3):
        cell = max(size) / res
        dims = [max(1, int(math.ceil(size[k] / cell - 1e-6))) for k in range(3)]
        step = [size[k] / dims[k] for k in range(3)]
        occ = set()
        for i in range(dims[0]):
            for j in range(dims[1]):
                for k in range(dims[2]):
                    for sx, sy, sz in ((.25, .25, .25), (.75, .75, .75), (.25, .75, .5), (.75, .25, .5), (.5, .5, .5)):
                        if inside((lo[0] + (i + sx) * step[0], lo[1] + (j + sy) * step[1], lo[2] + (k + sz) * step[2])):
                            occ.add((i, j, k))
                            break
        boxes = greedy_boxes(occ, dims)
        if len(boxes) <= limit and boxes:
            return [(tuple(lo[a] + b[0][a] * step[a] for a in range(3)), tuple(lo[a] + b[1][a] * step[a] for a in range(3))) for b in boxes]
    return [(tuple(lo), tuple(hi))]


def greedy_boxes(occ, dims):
    left, boxes = set(occ), []
    while left:
        i, j, k = min(left, key=lambda c: (c[2], c[1], c[0]))
        x1 = i
        while (x1 + 1, j, k) in left:
            x1 += 1
        y1 = j
        while all((x, y1 + 1, k) in left for x in range(i, x1 + 1)):
            y1 += 1
        z1 = k
        while all((x, y, z1 + 1) in left for x in range(i, x1 + 1) for y in range(j, y1 + 1)):
            z1 += 1
        for x in range(i, x1 + 1):
            for y in range(j, y1 + 1):
                for z in range(k, z1 + 1):
                    left.discard((x, y, z))
        boxes.append(((i, j, k), (x1 + 1, y1 + 1, z1 + 1)))
    return boxes


def collision_object(collection, name, boxes):
    bm = bmesh.new()
    try:
        for n, (lo, hi) in enumerate(boxes):
            # Shrink each box slightly so neighbouring boxes never share a vertex.
            e = 1e-4 * (1 + n % 3)
            lo = [lo[k] + e for k in range(3)]
            hi = [hi[k] - e for k in range(3)]
            corners = [bm.verts.new((x, y, z)) for z in (lo[2], hi[2]) for y in (lo[1], hi[1]) for x in (lo[0], hi[0])]
            for f in ((0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)):
                bm.faces.new([corners[i] for i in f])
        bmesh.ops.triangulate(bm, faces=list(bm.faces))
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        me = bpy.data.meshes.new(name + "_Mesh")
        bm.to_mesh(me)
    finally:
        bm.free()
    obj = bpy.data.objects.new(name, me)
    collection.objects.link(obj)
    obj["arcane_role"] = "collision"
    obj["arcane_source_key"] = "proxy"
    return obj


# ------------------------------------------------------------------- build --
def tick(name):
    now = time.perf_counter()
    timings = STATE["info"].setdefault("seconds", {})
    timings[name] = round(now - STATE.get("_t", now), 2)
    STATE["_t"] = now


def build(request, make_material, make_collection, select, make_box):
    STATE.clear()
    STATE.update(info={}, _t=time.perf_counter())
    plan = model_plan.plan(request)
    spec, warnings = plan.spec, list(plan.warnings)
    STATE.update(plan=plan, warnings=warnings)
    tick("plan")
    work = make_collection("COL_SpecWork")
    parts = {p["id"]: n for n, p in enumerate(spec["parts"])}
    angles = [spec["smoothAngle"] if p["smooth"] is None else p["smooth"] for p in spec["parts"]]
    objects = []
    for n, inst in enumerate(plan.instances):
        obj = to_object(inst, parts[inst.part], n, work, "W_%s_%d" % (inst.part, n))
        objects.append((inst, obj))
        if inst.target:
            decimate(obj, inst.target, warnings, "part " + inst.part)
    tick("objects")
    # Reference silhouette for the review: every planned solid before CSG/decimation.
    STATE["planned"] = [(list(i.mesh.verts), [tuple(f) for f in i.mesh.faces]) for i in plan.solids()]
    solids = [(i, o) for i, o in objects if i.csg not in ("subtract", "intersect")]
    cutters = [(i, o) for i, o in objects if i.csg in ("subtract", "intersect")]
    # Welds: union groups per material become one solid. Each solid remembers its member parts.
    final = []
    for m in spec["materials"]:
        group = [(i, o) for i, o in solids if i.material == m["id"] and i.csg == "union"]
        rest = [(i, o) for i, o in solids if i.material == m["id"] and i.csg != "union"]
        if len(group) > 1:
            members = {i.part for i, _ in group}
            base = join([o for _, o in group], "W_union_" + m["id"])
            empty = bpy.data.collections.new("CSG_Empty_" + m["id"])
            boolean(base, empty, "UNION", warnings, "weld " + m["id"])
            bpy.data.collections.remove(empty)
            final.append((base, members, m["id"]))
        else:
            final.extend((o, {i.part}, m["id"]) for i, o in group)
        final.extend((o, {i.part}, m["id"]) for i, o in rest)
    for inst, cutter in cutters:
        if inst.targets:
            targets = [o for o, members, _ in final if members & set(inst.targets)]
        else:
            box = world_bounds(cutter)
            targets = [o for o, _, _ in final if overlaps(world_bounds(o), box)]
        if not targets:
            warnings.append("cutter %s touches no solid" % inst.part)
        for o in targets:
            boolean(o, cutter, "DIFFERENCE" if inst.csg == "subtract" else "INTERSECT", warnings, "cut " + inst.part)
    for _, cutter in cutters:
        mesh = cutter.data
        bpy.data.objects.remove(cutter, do_unlink=True)
        bpy.data.meshes.remove(mesh)
    tick("csg")
    group = make_collection("COL_Procedural")
    main = []
    for m in spec["materials"]:
        objs = [o for o, _, mid in final if mid == m["id"] and o.data.polygons]
        if not objs:
            raise ValueError("Model spec: material %s has no geometry after CSG" % m["id"])
        obj = join(objs, "SM_" + request["name"] + "_" + m["id"])
        work.objects.unlink(obj)
        group.objects.link(obj)
        clean(obj)
        main.append(obj)
    total = sum(triangles(o) for o in main)
    STATE["info"]["trianglesBeforeBudget"] = total
    # Silhouette reference for the review: the welded/cut solid before budget decimation.
    STATE["reference"] = [[tuple(o.data.vertices[i].co) for i in p.vertices] for o in main for p in o.data.polygons]
    if total > plan.budget:
        for obj in main:
            decimate(obj, int(triangles(obj) * plan.budget * .985 / total), warnings, "material " + obj.name.rsplit("_", 1)[-1])
            clean(obj)
    if sum(triangles(o) for o in main) > plan.budget:
        raise ValueError("Procedural mesh exceeded its triangle budget or is empty")
    for obj in main:
        sharp_edges(obj, angles)
    bpy.data.collections.remove(work)
    for obj, m in zip(main, spec["materials"]):
        obj["arcane_source_key"] = m["id"]
    tick("join")
    texture = 512
    uv_stage(main, texture, STATE["info"])
    tick("uv")
    mats = {}
    for m in spec["materials"]:
        mats[m["id"]] = make_material("MAT_" + material_name(m["id"]), m["color"], m["metallic"], m["roughness"])
    for obj, m in zip(main, spec["materials"]):
        obj.data.materials.append(mats[m["id"]])
        obj["arcane_role"] = "render"
        obj["arcane_source_key"] = m["id"]
        obj["arcane_surface_uv"] = True
        for name in ("arcane_auto_uv",):
            if name in obj.data.attributes:
                obj.data.attributes.remove(obj.data.attributes[name])
    collisions = make_collection("COL_Collision")
    proxy = collision_object(collisions, "COL_" + request["name"], collision_boxes(main))
    tick("collision")
    STATE["main"] = main
    return main, [], [proxy], []


def author_finish(request, directory, objects):
    from model_surface import author
    STATE["_t"] = time.perf_counter()
    author(request, directory, objects, STATE)
    tick("surfaces")


def review(request, directory, camera, target, span, render_metrics):
    from model_review import review as run
    STATE["_t"] = time.perf_counter()
    return run(request, directory, camera, target, span, render_metrics, STATE)
