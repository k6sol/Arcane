"""Self-check for model spec builds: standard review renders plus measured metrics.

preview-hero.png: the shared three-quarter hero view. preview-side.png: a 2x2 review sheet
(top-left front -Y, top-right right +X, bottom-left top +Z, bottom-right wireframe hero) so
silhouette, proportions and topology can be judged in one image.
Lighting (previews only; exported assets are untouched): a neutral, revealing review rig instead of
the generic lookdev lights: a soft key sun raking from camera-left (about 5:1 over the ambient, so
relief, normal maps and tone variation read), a cool low fill from camera-right, a rim from behind,
a procedural horizon-to-zenith sky (generated nodes, no image), a mid-grey (18%) ground that takes
contact shadows, path-traced ambient occlusion and AgX at exposure 0. The hero's bottom-left corner
carries an inset "in-game" approximation: one sharp sun plus flat sky ambient, the look of Roblox
Future lighting, so the preview predicts the in-Studio read.
Metrics (audit.json "review", also returned by assets_preview): built size vs spec (metres
and studs), triangles vs budget, closed/manifold per mesh, minimum wall thickness, silhouette
fidelity (IoU of the final mesh vs the planned spec geometry) and complexity per view, parts
that float free of the ground/other parts, texel density, LOD hints and compiler warnings.
"""
import math

from model_surface import raster, np_

STUDS_PER_METRE = 1 / .28


def rnd(x, n=3):
    return round(float(x), n)


def silhouette(np, tris, axes, lo, span, size=128):
    t = tris[:, :, axes]
    px = (t - lo[list(axes)]) / span * (size - 8) + 4
    fid, _ = raster(np, px, size)
    return fid >= 0


def complexity(np, mask):
    area = mask.sum()
    if not area:
        return 0.0
    edge = mask & ~(np.roll(mask, 1, 0) & np.roll(mask, -1, 0) & np.roll(mask, 1, 1) & np.roll(mask, -1, 1))
    return float(edge.sum()) / (2 * math.sqrt(math.pi * area))


def triangles_of(obj):
    me = obj.data
    me.calc_loop_triangles()
    co = [v.co[:] for v in me.vertices]
    return [[co[i] for i in t.vertices] for t in me.loop_triangles]


def components(polys):
    """Connected component id per polygon (shared vertex indices)."""
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
    return [find(p[0]) for p in polys]


def thickness(np, bvh, objects, comp, rng_seed=7):
    """Wall thickness: from sampled surface points, inward to the same solid's opposite side.
    Hits on other (overlapping) parts are skipped, so contact never reads as a thin wall."""
    import random
    rng = random.Random(rng_seed)
    samples = []
    base = 0
    for obj in objects:
        me = obj.data
        for poly in me.polygons:
            samples.append((poly.area, poly.center.copy(), poly.normal.copy(), obj["arcane_source_key"], comp[base + poly.index]))
        base += len(me.polygons)
    total = sum(s[0] for s in samples)
    if not total:
        return None
    acc, cum = 0.0, []
    for s in samples:
        acc += s[0]
        cum.append(acc)
    import bisect
    found = []
    for _ in range(400):
        s = samples[min(len(samples) - 1, bisect.bisect_left(cum, rng.random() * total))]
        _, c, n, key, own = s
        origin, travelled = c - n * 1e-4, 1e-4
        for _ in range(16):
            loc, _, index, dist = bvh.ray_cast(origin, -n, 10.0)
            if loc is None:
                break
            travelled += dist
            if comp[index] == own:
                found.append((travelled, key))
                break
            origin = loc - n * 1e-5
            travelled += 1e-5
    if not found:
        return None
    found.sort()
    return {"min": rnd(found[0][0], 4), "p05": rnd(found[len(found) // 20][0], 4), "thinnest": found[0][1]}


def floating(planned, keys, tol):
    """Instances not connected (within tol) to the ground through other instances."""
    from mathutils.bvhtree import BVHTree
    from mathutils import Vector
    n = len(planned)
    if n > 160:
        return [], "skipped (more than 160 instances)"
    boxes, trees = [], []
    for verts, faces in planned:
        lo = [min(v[k] for v in verts) for k in range(3)]
        hi = [max(v[k] for v in verts) for k in range(3)]
        boxes.append((lo, hi))
        trees.append(BVHTree.FromPolygons(verts, faces))
    samples = []
    for verts, faces in planned:
        pts = [Vector(v) for v in verts[::max(1, len(verts) // 160)]]
        pts += [Vector(tuple(sum(verts[k][c] for k in f) / len(f) for c in range(3))) for f in faces[::max(1, len(faces) // 160)]]
        samples.append(pts)
    ground = [b[0][2] <= tol for b in boxes]
    near = [[] for _ in range(n)]
    gap = [math.inf] * n
    for i in range(n):
        for j in range(i + 1, n):
            (la, ha), (lb, hb) = boxes[i], boxes[j]
            if any(la[k] > hb[k] + tol * 4 or lb[k] > ha[k] + tol * 4 for k in range(3)):
                continue
            # Contact: crossing triangles, or any sample (vertices and face centres, both
            # directions) on or inside the other part.
            best = 0.0 if trees[i].overlap(trees[j]) else math.inf
            for a, b in ((i, j), (j, i)):
                if best == 0.0:
                    break
                for v in samples[a]:
                    loc, nn, _, dist = trees[b].find_nearest(v)
                    if loc is None:
                        continue
                    if dist < 1e-6 or (v - loc).dot(nn) < 0:
                        best = 0.0
                        break
                    best = min(best, dist)
            gap[i], gap[j] = min(gap[i], best), min(gap[j], best)
            if best <= tol:
                near[i].append(j)
                near[j].append(i)
    reached = [g for g in range(n) if ground[g]]
    seen = set(reached)
    while reached:
        k = reached.pop()
        for m in near[k]:
            if m not in seen:
                seen.add(m)
                reached.append(m)
    out = []
    for k in range(n):
        if k not in seen:
            out.append({"part": keys[k], "gap": rnd(gap[k], 4) if math.isfinite(gap[k]) else None})
    return out[:12], None


def render_sheet(bpy, directory, camera, target, span, request, render_metrics, main):
    from mathutils import Vector
    np = np_()
    scene = bpy.context.scene
    res = request["renderResolution"]
    half = res // 2
    scene.render.resolution_x = scene.render.resolution_y = half
    data = camera.data
    old_scale = data.ortho_scale
    pts = [v.co for obj in main for v in obj.data.vertices]
    lo = Vector(tuple(min(p[k] for p in pts) for k in range(3)))
    hi = Vector(tuple(max(p[k] for p in pts) for k in range(3)))
    dims = hi - lo
    centre = (lo + hi) / 2
    views = [("front", Vector((0, -1, 0)), max(dims.x, dims.z)), ("right", Vector((1, 0, 0)), max(dims.y, dims.z)),
             ("top", Vector((0, 0, 1)), max(dims.x, dims.y)), ("wire", Vector((.6, -.8, .55)).normalized(), span * 1.25)]
    tiles = []
    wire = wire_material(bpy)
    for name, direction, extent in views:
        camera.location = centre + direction * span * 4
        up = Vector((0, 1, 0)) if name == "top" else Vector((0, 0, 1))
        camera.rotation_euler = (centre - camera.location).to_track_quat("-Z", "Y" if name != "top" else "Y").to_euler()
        if name == "top":
            camera.rotation_euler = (0.0, 0.0, 0.0)
        data.ortho_scale = max(extent, 1e-3) * 1.18
        bpy.context.view_layer.material_override = wire if name == "wire" else None
        path = directory / ".worker" / ("review-" + name + ".png")
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        image = bpy.data.images.load(str(path))
        px = np.array(image.pixels[:], np.float32).reshape(half, half, 4)
        bpy.data.images.remove(image)
        tiles.append(px)
    bpy.context.view_layer.material_override = None
    sheet = np.zeros((res, res, 4), np.float32)
    # Image rows run bottom-up: the top row of the sheet holds front | right.
    sheet[half:half * 2, :half] = tiles[0]
    sheet[half:half * 2, half:half * 2] = tiles[1]
    sheet[:half, :half] = tiles[2]
    sheet[:half, half:half * 2] = tiles[3]
    sheet[half - 1:half + 1, :, :3] = .6
    sheet[:, half - 1:half + 1, :3] = .6
    sheet[..., 3] = 1
    out = bpy.data.images.new("ReviewSheet", width=res, height=res, alpha=True)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = str(directory / "preview-side.png")
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)
    scene.render.resolution_x = scene.render.resolution_y = res
    data.ortho_scale = old_scale
    return render_metrics(directory / "preview-side.png")


def _sun(bpy, group, name, azimuth, elevation, strength, angle, color):
    from mathutils import Vector
    data = bpy.data.lights.new("LGT_Review" + name, "SUN")
    data.energy, data.angle, data.color = strength, math.radians(angle), color
    obj = bpy.data.objects.new("LGT_Review" + name, data)
    group.objects.link(obj)
    a, e = math.radians(azimuth), math.radians(elevation)
    towards = Vector((math.cos(a) * math.cos(e), math.sin(a) * math.cos(e), math.sin(e)))
    obj.rotation_euler = (-towards).to_track_quat("-Z", "Y").to_euler()
    return obj


def _sky(world, zenith, horizon, ground, strength):
    """Procedural gradient sky: ground colour below the horizon, horizon -> zenith above."""
    world.use_nodes = True
    nodes, links = world.node_tree.nodes, world.node_tree.links
    for node in list(nodes):
        nodes.remove(node)
    out = nodes.new("ShaderNodeOutputWorld")
    bg = nodes.new("ShaderNodeBackground")
    coord = nodes.new("ShaderNodeTexCoord")
    split = nodes.new("ShaderNodeSeparateXYZ")
    remap = nodes.new("ShaderNodeMapRange")
    ramp = nodes.new("ShaderNodeValToRGB")
    # World "Generated" coordinates are the view direction; z in -1..1 -> 0..1.
    links.new(coord.outputs["Generated"], split.inputs["Vector"])
    remap.inputs["From Min"].default_value, remap.inputs["From Max"].default_value = -1.0, 1.0
    links.new(split.outputs["Z"], remap.inputs["Value"])
    links.new(remap.outputs["Result"], ramp.inputs["Fac"])
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = .47, tuple(ground) + (1,)
    els[1].position, els[1].color = 1.0, tuple(zenith) + (1,)
    mid = els.new(.5)
    mid.color = tuple(horizon) + (1,)
    links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = strength
    links.new(bg.outputs["Background"], out.inputs["Surface"])
    return bg, ramp


def _look(view, name):
    try:
        view.look = name
    except TypeError:
        pass


def review_rig(bpy, scene):
    """Replace the generic lookdev lights with the review rig (see module doc). Returns the rig
    and in-game light lists plus the sky nodes so the inset render can switch between them."""
    for obj in scene.objects:
        if obj.type == "LIGHT" and obj.name.startswith("LGT_") and not obj.name.startswith("LGT_Review"):
            obj.hide_render = True
    ground = bpy.data.objects.get("PreviewGround")
    if ground is not None:
        mat = bpy.data.materials.new("PreviewReviewGround")
        mat.use_nodes = True
        shader = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        shader.inputs["Base Color"].default_value = (.18, .18, .18, 1)
        shader.inputs["Roughness"].default_value = .9
        ground.data.materials.clear()
        ground.data.materials.append(mat)
    group = bpy.data.collections.get("COL_Preview") or scene.collection
    rig = [_sun(bpy, group, "Key", -125, 38, KEY, 6, (1.0, .97, .92)),
           _sun(bpy, group, "Fill", 10, 16, KEY * .2, 35, (.86, .92, 1.0)),
           _sun(bpy, group, "Rim", 160, 55, KEY * .6, 10, (.95, .97, 1.0))]
    game = [_sun(bpy, group, "GameSun", -100, 52, 2.6, 1, (1.0, .96, .9))]
    for obj in game:
        obj.hide_render = True
    sky = _sky(scene.world, (.3, .38, .5), (.55, .56, .58), (.2, .19, .18), SKY)
    vs = scene.view_settings
    vs.view_transform = "AgX"
    _look(vs, "AgX - Medium High Contrast")
    vs.exposure = 0.0
    c = scene.cycles
    c.max_bounces, c.diffuse_bounces, c.glossy_bounces, c.transmission_bounces = 4, 2, 2, 2
    c.transparent_max_bounces, c.volume_bounces = 2, 0
    return {"rig": rig, "game": game, "sky": sky}


KEY = 2.4   # key sun irradiance (W/m2); the sky ambient is about a fifth of it
SKY = .55


def ingame_inset(bpy, scene, rig, directory, res):
    """Render the hero view under the in-game approximation at a fifth of the resolution."""
    vs = scene.view_settings
    look = vs.look
    bg, ramp = rig["sky"]
    saved = [tuple(e.color) for e in ramp.color_ramp.elements]
    for obj in rig["rig"]:
        obj.hide_render = True
    for obj in rig["game"]:
        obj.hide_render = False
    for e in ramp.color_ramp.elements:  # flat sky ambient, like Studio's Ambient/OutdoorAmbient
        e.color = (.55, .6, .68, 1)
    bg.inputs["Strength"].default_value = .6
    _look(vs, "AgX - Base Contrast")
    samples = scene.cycles.samples
    scene.cycles.samples = max(4, samples // 2)
    small = max(64, res // 5)
    scene.render.resolution_x = scene.render.resolution_y = small
    path = directory / ".worker" / "review-ingame.png"
    scene.render.filepath = str(path)
    try:
        bpy.ops.render.render(write_still=True)
    finally:
        scene.render.resolution_x = scene.render.resolution_y = res
        scene.cycles.samples = samples
        _look(vs, look)
        bg.inputs["Strength"].default_value = SKY
        for e, col in zip(ramp.color_ramp.elements, saved):
            e.color = col
        for obj in rig["rig"]:
            obj.hide_render = False
        for obj in rig["game"]:
            obj.hide_render = True
    return path, small


def composite_inset(bpy, hero_path, inset_path, res, small):
    np = np_()
    image = bpy.data.images.load(str(hero_path))
    px = np.array(image.pixels[:], np.float32).reshape(res, res, 4)
    bpy.data.images.remove(image)
    image = bpy.data.images.load(str(inset_path))
    ins = np.array(image.pixels[:], np.float32).reshape(small, small, 4)
    bpy.data.images.remove(image)
    m = max(4, res // 64)
    # Rows run bottom-up: the bottom-left corner is the first rows and columns (the emptiest corner
    # of the hero framing: the x axis runs down-right and key shadows fall to the right).
    y0 = x0 = m
    y1, x1 = y0 + small, x0 + small
    px[y0 - 2:y1 + 2, x0 - 2:x1 + 2, :3] = .92
    px[y0:y1, x0:x1] = ins
    px[..., 3] = 1
    out = bpy.data.images.new("ReviewHero", width=res, height=res, alpha=True)
    out.pixels.foreach_set(px.ravel())
    out.filepath_raw = str(hero_path)
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)


def wire_material(bpy):
    mat = bpy.data.materials.new("PreviewWire")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    shader = nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (.55, .58, .62, 1)
    shader.inputs["Roughness"].default_value = .7
    wire = nodes.new("ShaderNodeWireframe")
    wire.use_pixel_size = True
    wire.inputs["Size"].default_value = 1.0
    mix = nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["A"].default_value = (.55, .58, .62, 1)
    mix.inputs["B"].default_value = (.03, .05, .09, 1)
    links.new(wire.outputs["Fac"], mix.inputs["Factor"])
    links.new(mix.outputs["Result"], shader.inputs["Base Color"])
    return mat


def review(request, directory, camera, target, span, render_metrics, state):
    import bpy
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    np = np_()
    plan, info, main = state["plan"], state["info"], state["main"]
    spec = plan.spec
    scene = bpy.context.scene
    import time
    started = time.perf_counter()
    rig = review_rig(bpy, scene)
    renders = []
    camera.location = target + Vector((2.6, -3.5, 2.3)) * span
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    hero = directory / "preview-hero.png"
    scene.render.filepath = str(hero)
    bpy.ops.render.render(write_still=True)
    hero_done = time.perf_counter()
    inset, small = ingame_inset(bpy, scene, rig, directory, request["renderResolution"])
    composite_inset(bpy, hero, inset, request["renderResolution"], small)
    inset_done = time.perf_counter()
    renders.append(render_metrics(hero))
    renders.append(render_sheet(bpy, directory, camera, target, span, request, render_metrics, main))
    rendered = time.perf_counter()
    lighting = {"rig": "review-v2: key/fill/rim suns, procedural sky, 18% grey ground, AgX medium-high contrast, exposure 0",
                "inset": "bottom-left of preview-hero.png: in-game approximation (one sharp sun + flat sky ambient)",
                "seconds": {"hero": round(hero_done - started, 2), "inset": round(inset_done - hero_done, 2), "sheet": round(rendered - inset_done, 2)}}
    # ---- metrics
    verts, polys = [], []
    for obj in main:
        base = len(verts)
        verts.extend(tuple(v.co) for v in obj.data.vertices)
        polys.extend(tuple(base + i for i in p.vertices) for p in obj.data.polygons)
    bvh = BVHTree.FromPolygons(verts, polys)
    arr = np.array(verts)
    lo, hi = arr.min(0), arr.max(0)
    built = hi - lo
    want = np.array(spec["size"])
    meshes = {}
    for obj in main:
        import bmesh
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        try:
            open_edges = sum(1 for e in bm.edges if not e.is_manifold)
            comps, seen = 0, set()
            for f in bm.faces:
                if f.index in seen:
                    continue
                comps += 1
                stack = [f]
                seen.add(f.index)
                while stack:
                    g = stack.pop()
                    for e in g.edges:
                        for h in e.link_faces:
                            if h.index not in seen:
                                seen.add(h.index)
                                stack.append(h)
            meshes[obj["arcane_source_key"]] = {"triangles": sum(len(f.verts) - 2 for f in bm.faces), "closed": open_edges == 0,
                                                "nonManifoldEdges": open_edges, "components": comps}
        finally:
            bm.free()
    final_tris = np.array([t for obj in main for t in triangles_of(obj)])
    planned_tris = np.array([[poly[0], poly[k], poly[k + 1]] for poly in state["reference"] for k in range(1, len(poly) - 1)])
    span3 = float(max(built.max(), 1e-6))
    views = {}
    for name, axes in (("front", (0, 2)), ("side", (1, 2)), ("top", (0, 1))):
        a = silhouette(np, final_tris, axes, lo, span3)
        b = silhouette(np, planned_tris, axes, lo, span3)
        union = (a | b).sum()
        views[name] = {"iou": rnd((a & b).sum() / union if union else 1.0), "complexity": rnd(complexity(np, a), 2)}
    tol = max(.004, .006 * span3)
    keys = [i.key for i in plan.solids() if not i.scatter]
    planned = [p for p, i in zip(state["planned"], plan.solids()) if not i.scatter]
    floats, note = floating(planned, keys, tol)
    total = sum(m["triangles"] for m in meshes.values())
    height_studs = float(built[2]) * STUDS_PER_METRE
    lod_distance = lambda frac: rnd(max(height_studs, 1e-3) / (2 * math.tan(math.radians(35)) * frac), 0)
    parts = {}
    for inst in plan.solids():
        row = parts.setdefault(inst.part, [0, 0])
        row[0] += 1
        row[1] += inst.target or inst.mesh.triangles()
    result = {
        "size": {"spec": [rnd(v) for v in want], "built": [rnd(v) for v in built], "studs": [rnd(v * STUDS_PER_METRE, 2) for v in built],
                 "ratio": [rnd(b / w) for b, w in zip(built, want)]},
        "triangles": {"total": total, "budget": plan.budget, "beforeBudget": info.get("trianglesBeforeBudget", total), "planned": plan.estimated_triangles(),
                      "edgeMetres": rnd(plan.edge, 4)},
        "meshes": meshes,
        "watertight": all(m["closed"] for m in meshes.values()),
        "thickness": thickness(np, bvh, main, components(polys)),
        "silhouette": views,
        "floating": floats,
        "uv": {"stage": info.get("uvStage"), "texelsPerMetre": info.get("texelsPerMetre"), "quality": info.get("uvQuality"), "candidates": info.get("uvCandidates"), "seconds": info.get("uvSeconds"),
               "hiddenFaces": {k: rnd(v / max(1, meshes[k]["triangles"]), 3) for k, v in info.get("hiddenFaces", {}).items() if k in meshes}},
        "surfaces": info.get("surfaces", {}),
        "detail": {**getattr(plan, "detail", {}), **info.get("detail", {}), **({"glow": info["glow"]} if info.get("glow") else {})},
        "lod": {"lod1Triangles": int(total * .5), "lod2Triangles": int(total * .2), "lod1AtStuds": lod_distance(.25), "lod2AtStuds": lod_distance(.1)},
        "parts": {k: {"instances": v[0], "triangles": v[1]} for k, v in sorted(parts.items())},
        "materials": info.get("materials"),
        "lighting": lighting,
        "warnings": (state["warnings"] + ([note] if note else []))[:16],
        "seconds": {**info.get("seconds", {}), "renders": round(rendered - state.get("_t", rendered), 2), "metrics": round(time.perf_counter() - rendered, 2)},
    }
    hints = []
    if any(abs(r - 1) > .1 for r in result["size"]["ratio"]):
        hints.append("Built size differs from spec size by more than 10%; fix part dimensions or the spec size.")
    if floats:
        hints.append("Some parts float free of the model: move them into contact (see floating gaps, metres).")
    if result["thickness"] and result["thickness"]["min"] < .005:
        hints.append("Walls thinner than 5 mm: thicken the thinnest part for robust rendering/collision.")
    if min(v["iou"] for v in views.values()) < .9:
        hints.append("Budget decimation lost silhouette detail (IoU < 0.9 vs the full-resolution build): raise triangleBudget or lower detail on hidden/minor parts.")
    buried = [k for k, v in result["uv"]["hiddenFaces"].items() if v > .4]
    if buried:
        hints.append("Over 40% of the faces of " + ", ".join(buried) + " are buried inside other parts (fine for inlays): if unintended, drop hidden parts or weld same-material parts with csg union.")
    inferred = [e for e in (info.get("materials") or {}).get("materials", []) if e.get("source") == "inferred"]
    if inferred:
        hints.append("Materials inferred (review.materials): " + ", ".join("%s -> %s" % (e["material"], e["library"]) for e in inferred)
                     + "; set materials[].library (or 'none'), wear, cavity, moss, age or spec.context to override.")
    result["hints"] = hints
    return renders, result
