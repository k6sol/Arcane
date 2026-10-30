"""Actual Blender representation test for the production foliage card root.

This imports the full original module. It does not project its AST, inject a
mathutils replacement, edit a source file, or certify whole-tree appearance.
"""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys

sys.dont_write_bytecode = True
import bpy
import bmesh
from mathutils import Euler, Matrix, Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "workers" / "blender" / "procedural.py"
P = None
EPS_NATIVE = 4e-6


def mesh_object(name, data, visible=False):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(data.vertices, [], data.faces)
    uv = mesh.uv_layers.new(name="UVMap")
    for polygon, coordinates in zip(mesh.polygons, data.uvs):
        for loop, point in zip(polygon.loop_indices, coordinates):
            uv.data[loop].uv = point
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.hide_render = not visible
    return obj


def snapshot(obj):
    mesh = obj.data
    return {"positions": [list(v.co) for v in mesh.vertices],
            "faces": [list(p.vertices) for p in mesh.polygons],
            "uv": [list(loop.uv) for loop in mesh.uv_layers[0].data]}


def require(condition, label, failures):
    if not condition:
        failures.append(label)


def check_card(data, root, axis, face, length, width, thickness, cup, bend, droop, failures, label):
    # The expected anchor is an input, not inferred from a nearby virtual twig.
    midpoint = (Vector(data.vertices[0]) + Vector(data.vertices[5])) * .5
    root_error = (midpoint - Vector(root)).length
    require(root_error <= EPS_NATIVE, label + ":declared-root", failures)
    require(len(data.vertices) == 8 and len(data.faces) == 12 and data.triangles() == 12,
            label + ":topology-size", failures)
    # Independent frame and the ORIGINAL distal shape: the repair may move only
    # the two basal corners. No candidate-source function is copied into a test.
    along = Vector(axis).normalized()
    side = along.cross(Vector(face)).normalized()
    up = side.cross(along).normalized()
    for index, t, across in [(1, .5, 1), (2, 1, 1), (3, 1, -1), (4, .5, -1), (6, .5, 0), (7, .5, 0)]:
        z = length * (bend * 4 * t * (1 - t) - droop * t * t) - cup * width * across * across
        expected = Vector(root) + along * (length * t) + side * (width * across / 2) + up * z
        if index in (6, 7):
            expected += up * (thickness * (.5 if index == 6 else -.5))
        require((Vector(data.vertices[index]) - expected).length <= EPS_NATIVE,
                label + ":distal-" + str(index), failures)
    rect = P.atlas_rect(2, 1)
    expected_rim = [(rect[2], rect[1]), (rect[2], (rect[1] + rect[3]) / 2), (rect[2], rect[3]),
                    (rect[0], rect[3]), (rect[0], (rect[1] + rect[3]) / 2), (rect[0], rect[1])]
    centre = ((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2)
    for n in range(6):
        k = (n + 1) % 6
        require(data.faces[2 * n] == (n, k, 6) and data.faces[2 * n + 1] == (k, n, 7), label + ":indices", failures)
        require(data.uvs[2 * n] == (expected_rim[n], expected_rim[k], centre)
                and data.uvs[2 * n + 1] == (expected_rim[k], expected_rim[n], centre), label + ":uv", failures)
    obj = mesh_object(label, data)
    actual = snapshot(obj)
    require(len(obj.data.uv_layers) == 1 and all(math.isfinite(x) and 0 <= x <= 1 for uv in actual["uv"] for x in uv), label + ":native-uv", failures)
    bm = bmesh.new()
    try:
        bm.from_mesh(obj.data)
        require(all(edge.is_manifold and edge.is_contiguous for edge in bm.edges), label + ":native-manifold", failures)
        require(all(face.calc_area() > 1e-12 for face in bm.faces), label + ":native-area", failures)
    finally:
        bm.free()
    native_error = ((obj.data.vertices[0].co + obj.data.vertices[5].co) * .5 - Vector(root)).length
    require(native_error <= EPS_NATIVE, label + ":native-root", failures)
    return obj, {"name": label, "cup": cup, "width": width, "rootErrorMeters": root_error,
                 "nativeRootErrorMeters": native_error, "vertices": 8, "triangles": 12}, actual


def atlas_diagnostics():
    # Retain the original single-texel diagnostic. Filtered root coverage and
    # encoded PNG/UV orientation are checked separately below; no diagnostic
    # pixel alone certifies visible-petiole or whole-tree/wood connectivity.
    texture_spec = importlib.util.spec_from_file_location("arcane_actual_textures", SOURCE.with_name("textures.py"))
    T = importlib.util.module_from_spec(texture_spec)
    texture_spec.loader.exec_module(T)
    rows = []
    for species in ("oak", "birch", "pine"):
        _, alpha, _, _ = T.tree_surface(species + "-leaves", (.12, .25, .06), 31, 512)
        for row in range(2):
            for col in range(4):
                y, start = row * 256 + 2, col * 128
                coverage = [x for x in range(2, 126) if float(alpha[y, start + x]) >= .5]
                rows.append({"species": species, "column": col, "row": row, "sampleYWithinTile": 2,
                             "coveredMinX": min(coverage) if coverage else None,
                             "coveredMaxX": max(coverage) if coverage else None,
                             "centreAlpha": float(alpha[y, start + 64])})
    return rows


def load_checked_module(name, path, expected):
    info = path.stat()
    if path.is_symlink() or not path.is_file() or info.st_nlink != 1 or not 0 < info.st_size <= 512*1024:
        raise RuntimeError("Native fixture module is not a bounded ordinary file")
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise RuntimeError("Native fixture source provenance changed")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def linear_alpha(alpha, x, y):
    # Source/bpy order: pixel centres are x+.5,y+.5. No nearest-texel shortcut.
    x, y = x - .5, y - .5
    ix, iy = math.floor(x), math.floor(y)
    fx, fy = x - ix, y - iy
    return float(alpha[iy, ix] * (1-fx) * (1-fy) + alpha[iy, ix+1] * fx * (1-fy)
                 + alpha[iy+1, ix] * (1-fx) * fy + alpha[iy+1, ix+1] * fx * fy)


def trace_atlas(T, species, seed, failures):
    generated, painted = [], []
    original_shoot, original_twig = T._shoot, T._Canvas.twig
    main_count = 18 if species == "pine" else 14

    def shoot(*args, **kwargs):
        result = original_shoot(*args, **kwargs)
        if len(result) == main_count:
            generated.append((result, [tuple(p) for p in result]))
        return result

    def twig(canvas, points, widths, color):
        if len(points) == main_count:
            painted.append(([tuple(p) for p in points], list(widths)))
        return original_twig(canvas, points, widths, color)

    T._shoot, T._Canvas.twig = shoot, twig
    try:
        surface = T.tree_surface(species + "-leaves", (.12, .25, .06), seed, 512)
    finally:
        T._shoot, T._Canvas.twig = original_shoot, original_twig
    require(len(generated) == 8 and len(painted) == 8, "paint-trace-count", failures)
    minimum = 1.0
    for tile, ((original, captured), (drawn, widths)) in enumerate(zip(generated, painted)):
        label = species + ":" + str(seed) + ":" + str(tile)
        require([tuple(p) for p in original] == captured, label + ":unmodified-main", failures)
        require(drawn[0] == (64., 2.) and drawn[1:] == captured[1:], label + ":paint-only-root", failures)
        w = 2.4 if species == "pine" else 2.6 if species == "oak" else 1.7
        taper = .6 if species == "pine" else .55
        require(widths == [w * (1-taper*k/(len(captured)-1)) for k in range(len(captured))], label + ":widths", failures)
        col, row = tile % 4, tile // 4
        root = linear_alpha(surface[1], col*128+64, row*256+2)
        require(root >= 1-1/255, label + ":filtered-root", failures)
        # Follow the actual painted first segment, not the unjittered vertical axis.
        first, second = drawn[:2]
        steps = max(1, math.ceil(math.dist(first, second) * 2))
        segment_minimum = 1.0
        for k in range(steps+1):
            t = k/steps
            value = linear_alpha(surface[1], col*128+first[0]+(second[0]-first[0])*t,
                                 row*256+first[1]+(second[1]-first[1])*t)
            minimum = min(minimum, value)
            segment_minimum = min(segment_minimum, value)
        require(segment_minimum >= .5, label + ":continuous-petiole", failures)
    return surface, minimum


def alpha_probes(directory, args, failures):
    T = load_checked_module("arcane_petiole_textures", SOURCE.with_name("textures.py"), args.textures_sha256)
    baseline_path = directory / "baseline-textures.py"
    if baseline_path.resolve(strict=True).parent != directory or baseline_path.is_symlink():
        raise RuntimeError("Original control is outside owned native data")
    # Complete current-layout module with only the two basal-paint edits reversed.
    if args.baseline_sha256 not in ("d0f0f08795e14431e9609007ebe78bb2f6654a45d51df595cc0932380a45dc89",
                                  "4c61f58d6281181bfcba3d1391de03b9cf90baf4c4aaa18976e00d2891eec187"):
        raise RuntimeError("Unreviewed full original control")
    B = load_checked_module("arcane_original_textures", baseline_path, args.baseline_sha256)
    load_checked_module("arcane_checked_audit", SOURCE.with_name("audit.py"), args.audit_sha256)
    W = load_checked_module("arcane_actual_asset_worker", SOURCE.with_name("asset_worker.py"), args.exporter_sha256)
    if Path(sys.modules["audit"].__file__).resolve(strict=True) != SOURCE.with_name("audit.py").resolve(strict=True):
        raise RuntimeError("Production exporter imported a different audit module")
    np = T._np()
    baseline, raw_checks, upper_checks, minima = [], 0, 0, []
    for species in ("oak", "birch", "pine"):
        upper_hashes = []
        for seed in (0, 1, 31, 2147483647):
            actual, minimum = trace_atlas(T, species, seed, failures)
            minima.append(minimum)
            raw_checks += 8
            rng_a, rng_b = np.random.default_rng(seed), np.random.default_rng(seed)
            fn = "_needle_spray" if species == "pine" else "_spray"
            params = ((.12, .25, .06), 128, 256, False)
            a = getattr(B, fn)(np, rng_a, *params) if species == "pine" else getattr(B, fn)(np, rng_a, species, *params)
            b = getattr(T, fn)(np, rng_b, *params) if species == "pine" else getattr(T, fn)(np, rng_b, species, *params)
            require(rng_a.bit_generator.state == rng_b.bit_generator.state, species + ":rng-schedule", failures)
            require(all(np.array_equal(getattr(a, key)[24:], getattr(b, key)[24:])
                        for key in ("rgb", "alpha", "height", "rough")), species + ":upper-spray", failures)
            upper_hashes.append(hashlib.sha256(b.rgb[24:].tobytes() + b.alpha[24:].tobytes()).hexdigest())
            upper_checks += 1
            if seed == 31:
                again = T.tree_surface(species + "-leaves", (.12, .25, .06), seed, 512)
                require(all(np.array_equal(a, b) for a, b in zip(actual, again)), species + ":repeat-seed", failures)
        require(len(set(upper_hashes)) == 4, species + ":seed-variation", failures)
        original = B.tree_surface(species + "-leaves", (.12, .25, .06), 31, 512)[1]
        baseline.extend({"species": species, "column": col, "row": row,
                         "filteredRootAlpha": linear_alpha(original, col*128+64, row*256+2)}
                        for row in range(2) for col in range(4))
    require(any(item["filteredRootAlpha"] < .5 for item in baseline), "original-control-must-fail", failures)

    objects, materials, captured = [], [], {}
    for species in ("oak", "birch", "pine"):
        key = species.capitalize() + "Leaves"
        material = bpy.data.materials.new("MAT_" + key)
        material.use_nodes = True
        materials.append({"id": key, "color": [.12, .25, .06], "metallic": 0., "roughness": .8,
                          "surface": {"profile": "leaf", "resolution": 512}, "pattern": species + "-leaves"})
        for row in range(2):
            for col in range(4):
                data = P.MeshData()
                data.card((0, 0, 0), (1, 0, 0), (0, 0, 1), 1., .5, .005, P.atlas_rect(col, row), bend=.1, droop=.08, cup=P.CANOPY[species]["cup"])
                obj = mesh_object("alpha-" + species + "-" + str(col) + "-" + str(row), data)
                obj.data.materials.append(material)
                objects.append(obj)
    original_pixels = T.tree_pixels

    def pixels(*args, **kwargs):
        mains, original_shoot = [], T._shoot

        def shoot(*shoot_args, **shoot_kwargs):
            points = original_shoot(*shoot_args, **shoot_kwargs)
            if len(points) == (18 if args[0] == "pine-leaves" else 14):
                mains.append([tuple(point) for point in points])
            return points

        T._shoot = shoot
        try:
            result = original_pixels(*args, **kwargs)
        finally:
            T._shoot = original_shoot
        require(len(mains) == 8, args[0] + ":authored-main-count", failures)
        captured[args[0]] = (args[3], np.asarray(result["baseColor"]).reshape(512, 512, 4)[..., 3].copy(), mains)
        return result

    T.tree_pixels = pixels
    try:
        T.author_surfaces({"seed": 31, "recipe": {"materials": materials}}, directory, objects, normal_relief=.008)
    finally:
        T.tree_pixels = original_pixels
    probes, snapshots = [], {}
    for obj in objects:
        _, species, col, row = obj.name.split("-")
        col, row = int(col), int(row)
        material = obj.data.materials[0]
        image = material.node_tree.nodes["Arcane_BaseColor"].image
        loaded = bpy.data.images.load(image.filepath_raw, check_existing=False)
        try:
            values = np.empty(512*512*4, dtype=np.float32)
            loaded.pixels.foreach_get(values)
            alpha = values.reshape(512, 512, 4)[..., 3]
            derived_seed, authored, mains = captured[species + "-leaves"]
            require(float(np.max(np.abs(alpha-authored))) <= 1/255+1e-7, obj.name + ":png-native-order", failures)
            root_alpha = linear_alpha(alpha, col*128+64, row*256+2)
            require(root_alpha >= 1-1/255, obj.name + ":packed-filtered-root", failures)
            distal = mains[row*4+col][1]
            steps = max(1, math.ceil(math.dist((64, 2), distal)*2))
            minimum = min(linear_alpha(alpha, col*128+64+(distal[0]-64)*k/steps,
                                       row*256+2+(distal[1]-2)*k/steps) for k in range(steps+1))
            require(minimum >= .5, obj.name + ":packed-continuous-petiole", failures)
            top_down_sha = hashlib.sha256(np.rint(np.clip(alpha[::-1], 0, 1)*255).astype(np.uint8).tobytes()).hexdigest()
        finally:
            bpy.data.images.remove(loaded)
        clip = material.node_tree.nodes["Arcane_AlphaClip"]
        shader = material.node_tree.nodes.get("Principled BSDF")
        require(clip.operation == "ROUND" and shader.inputs["Alpha"].is_linked
                and shader.inputs["Alpha"].links[0].from_node == clip, obj.name + ":actual-cutout", failures)
        probes.append({"name": obj.name, "species": species, "column": col, "row": row,
                       "derivedSeed": str(derived_seed), "materialName": material.name,
                       "rootUv": [(col+.5)/4, row/2+2/512], "rootAlpha": root_alpha,
                       "firstDistalPixel": list(distal), "minimumContinuousAlpha": minimum,
                       "pngAlphaTopDownSha256": top_down_sha,
                       "basalPoints": [list(obj.data.vertices[i].co) for i in (0, 5)]})
        snapshots[obj.name] = {"mesh": snapshot(obj), "surface": T.surface_evidence(material)}
    W.export_glb(directory / "alpha-contact.glb", objects)
    return {"baselineSha256": args.baseline_sha256, "baseline": baseline, "rawChecks": raw_checks,
            "upperAndRngChecks": upper_checks, "minimumContinuousAlpha": min(minima), "probes": probes}, snapshots


def alpha_contact_frame(scene, camera, contacts, failures, label):
    # Measure the actual evaluated geometry and camera used for this render.
    # These projections establish framing/isolation, not visible-alpha acceptance.
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    actual_camera = camera.evaluated_get(depsgraph)
    camera_world = actual_camera.matrix_world
    camera_inverse = camera_world.inverted()
    scale = actual_camera.data.ortho_scale
    width = int(scene.render.resolution_x * scene.render.resolution_percentage / 100)
    height = int(scene.render.resolution_y * scene.render.resolution_percentage / 100)
    require(actual_camera.data.type == "ORTHO" and width == height == 512
            and scene.render.pixel_aspect_x == scene.render.pixel_aspect_y,
            label + ":square-orthographic-camera", failures)

    def project(point):
        local = camera_inverse @ point
        return [width * (.5 + local.x / scale), height * (.5 - local.y / scale), -local.z]

    def world_points(obj):
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            if not 1 <= len(mesh.vertices) <= 512:
                raise RuntimeError("Cutout framing requires bounded actual mesh vertices")
            return [evaluated.matrix_world @ vertex.co for vertex in mesh.vertices]
        finally:
            evaluated.to_mesh_clear()

    def bounds(points, dimensions):
        return [[min(point[i] for point in points) for i in range(dimensions)],
                [max(point[i] for point in points) for i in range(dimensions)]]

    def measured(points):
        projected = [project(point) for point in points]
        return {"vertices": len(points), "worldBounds": bounds(points, 3),
                "pixelBounds": bounds(projected, 2),
                "depthRange": [min(point[2] for point in projected), max(point[2] for point in projected)]}

    cases = []
    for obj, stem in contacts:
        card_points, stem_points = world_points(obj), world_points(stem)
        require(len(card_points) == 8, label + ":evaluated-card-size", failures)
        root = (card_points[0] + card_points[5]) * .5
        card_measure, stem_measure = measured(card_points), measured(stem_points)
        low, high = stem_measure["worldBounds"]
        # This fixture's actual capped horizontal stem: derive both cap centres
        # from its evaluated vertex bounds, rather than echoing its construction.
        base = Vector((low[0], (low[1]+high[1])*.5, (low[2]+high[2])*.5))
        tip = Vector((high[0], base.y, base.z))
        require((root-tip).length <= EPS_NATIVE, label + ":evaluated-root-at-stem-tip", failures)
        cases.append({"name": obj.name, "stemName": stem.name, "card": card_measure, "stem": stem_measure,
                      "rootWorld": list(root), "rootPixels": project(root)[:2],
                      "stemAxisWorld": [list(base), list(tip)],
                      "stemAxisPixels": [project(base)[:2], project(tip)[:2]]})
    intervals = sorted((min(item["card"]["pixelBounds"][0][1], item["stem"]["pixelBounds"][0][1]),
                        max(item["card"]["pixelBounds"][1][1], item["stem"]["pixelBounds"][1][1])) for item in cases)
    return {"name": label, "width": width, "height": height,
            "camera": {"location": list(camera_world.translation), "right": list(camera_world.col[0][:3]),
                       "up": list(camera_world.col[1][:3]), "forward": [-v for v in camera_world.col[2][:3]],
                       "orthographicScale": scale,
                       "clipRange": [actual_camera.data.clip_start, actual_camera.data.clip_end]},
            "cases": cases, "minimumCaseGapPixels": min(intervals[i+1][0]-intervals[i][1] for i in range(len(intervals)-1))}


def render_alpha_contact(directory, failures):
    gaps, contacts, frames = [], [], []
    for obj in bpy.context.scene.objects:
        obj.hide_render = True
    for index, name in enumerate(("alpha-oak-0-0", "alpha-birch-2-1", "alpha-pine-0-0")):
        obj = bpy.data.objects[name]
        # Full-width cards must not overlap at their coplanar transparent bases.
        obj.location = (0, (index-1)*.65, 0)
        obj.hide_render = False
        data = P.MeshData()
        data.tube([(-.15, 0, 0), (0, 0, 0)], [.015, .015], 12, tip=False)
        stem = mesh_object("alpha-contact-stem-" + str(index), data, True)
        stem.location = obj.location
        stem.data.materials.append(bpy.data.materials["contact-stem"])
        contacts.append((obj, stem))
        bm = bmesh.new()
        try:
            bm.from_mesh(stem.data)
            # These two actual objects have identical translations. Measure the
            # SAME basal midpoint whose UV/alpha was checked, in their local frame.
            point = (obj.data.vertices[0].co + obj.data.vertices[5].co) * .5
            hit = BVHTree.FromBMesh(bm).find_nearest(point)
            gap = hit[3] if hit is not None else math.inf
            require(gap <= EPS_NATIVE, name + ":textured-stem-contact", failures)
            gaps.append(gap)
        finally:
            bm.free()
    scene = bpy.context.scene
    camera = scene.camera
    camera.hide_render = False
    camera.data.ortho_scale = 2.
    camera.rotation_mode = "QUATERNION"
    target = Vector((.425, 0, -.02875))
    # Both rays have dy=0, keeping the separated cases disjoint in projection.
    for name, location in (("foliage-alpha-front.png", (.425, 0, 3.97125)), ("foliage-alpha-oblique.png", (3.425, 0, 3.97125))):
        camera.location = location
        direction = (target - camera.location).normalized()
        right = direction.cross(Vector((0, 1, 0))).normalized()
        up = right.cross(direction).normalized()
        # Camera local -Z follows direction; world Y stays screen-up in both views.
        camera.rotation_quaternion = Matrix((right, up, -direction)).transposed().to_quaternion()
        frames.append(alpha_contact_frame(scene, camera, contacts, failures, name))
        scene.render.filepath = str(directory / name)
        bpy.ops.render.render(write_still=True)
    return gaps, frames


def render_contact(directory):
    stem = P.MeshData()
    stem.tube([(-.6, 0, 0), (0, 0, 0)], [.025, .025], 12, tip=False)
    wood = mesh_object("contact-stem", stem, True)
    card = P.MeshData()
    card.card((0, 0, 0), (1, 0, 0), (0, 0, 1), 1., .5, .005, P.atlas_rect(0, 0), bend=.1, droop=.08, cup=.12)
    leaf = mesh_object("contact-card", card, True)
    for obj, color in ((wood, (.25, .16, .09, 1)), (leaf, (.18, .42, .14, 1))):
        material = bpy.data.materials.new(obj.name)
        material.use_nodes = True
        material.diffuse_color = color
        shader = material.node_tree.nodes.get("Principled BSDF")
        shader.inputs["Base Color"].default_value = color
        shader.inputs["Roughness"].default_value = 1
        shader.inputs["Emission Color"].default_value = color
        shader.inputs["Emission Strength"].default_value = .5
        obj.data.materials.append(material)
    bm = bmesh.new()
    try:
        bm.from_mesh(wood.data)
        point = (leaf.data.vertices[0].co + leaf.data.vertices[5].co) * .5
        nearest = BVHTree.FromBMesh(bm).find_nearest(point)
        gap = nearest[3] if nearest is not None else math.inf
    finally:
        bm.free()
    scene = bpy.context.scene
    # Use the already required CPU renderer, without requiring a hosted GPU or
    # introducing an optional runtime/render capability probe.
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 4
    scene.cycles.use_denoising = False
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (.2, .2, .2, 1)
    background.inputs["Strength"].default_value = .5
    camera = bpy.data.objects.new("contact-camera", bpy.data.cameras.new("contact-camera"))
    scene.collection.objects.link(camera)
    camera.data.type, camera.data.ortho_scale = "ORTHO", 1.9
    scene.camera = camera
    for name, location in [("foliage-front.png", (.15, -3., .2)), ("foliage-side.png", (.15, 0, 3.))]:
        camera.location = location
        camera.rotation_euler = (Vector((.15, 0, 0)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = str(directory / name)
        bpy.ops.render.render(write_still=True)
    return gap


def run(args):
    global P
    directory = Path(args.directory).resolve(strict=True)
    if tuple(bpy.app.version) != (5, 2, 3):
        raise RuntimeError("Native fixture requires the reviewed Blender 5.2.3 runtime")
    if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != args.worker_sha256:
        raise RuntimeError("Production worker bytes changed before import verification")
    spec = importlib.util.spec_from_file_location("arcane_actual_foliage", SOURCE)
    P = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(P)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    failures, cases, snapshots = [], [], {}
    frames = [(0., 0., 0.), (.4, -.7, 1.2), (-.8, .3, -.6), (1.3, .2, .9)]
    for species in ("oak", "birch", "pine"):
        style = P.CANOPY[species]
        for scale in (.1, 1., 2.5):
            for number, angles in enumerate(frames):
                rotation = Euler(angles, 'XYZ').to_matrix()
                axis, face = tuple(rotation @ Vector((1, 0, 0))), tuple(rotation @ Vector((0, 0, 1)))
                root = (.35, -.7, .2)
                length, width, thickness = scale, scale * .5, scale * .005
                data = P.MeshData()
                data.card(root, axis, face, length, width, thickness, P.atlas_rect(2, 1), bend=.1, droop=.08, cup=style["cup"])
                name = "card-" + species + "-" + str(scale) + "-" + str(number)
                obj, result, actual = check_card(data, root, axis, face, length, width, thickness, style["cup"], .1, .08, failures, name)
                cases.append(result)
                snapshots[obj.name] = actual
        data = P.MeshData()
        data.card((0, 0, 0), (1, 0, 0), (0, 0, 1), 1., .5, .005, P.atlas_rect(2, 1), bend=.1, droop=.08, cup=0)
        obj, result, actual = check_card(data, (0, 0, 0), (1, 0, 0), (0, 0, 1), 1., .5, .005, 0., .1, .08, failures, "zero-cup-" + species)
        cases.append(result)
        snapshots[obj.name] = actual
    alpha, alpha_snapshots = alpha_probes(directory, args, failures)
    path = directory / "attachment.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(path), check_existing=False)
    bpy.ops.wm.open_mainfile(filepath=str(path), use_scripts=False)
    for name, before in snapshots.items():
        obj = bpy.data.objects.get(name)
        require(obj is not None and snapshot(obj) == before, name + ":save-reopen", failures)
    T = load_checked_module("arcane_reopened_textures", SOURCE.with_name("textures.py"), args.textures_sha256)
    for name, before in alpha_snapshots.items():
        obj = bpy.data.objects.get(name)
        require(obj is not None and snapshot(obj) == before["mesh"]
                and T.surface_evidence(obj.data.materials[0]) == before["surface"], name + ":textured-save-reopen", failures)
    gap = render_contact(directory)
    require(gap <= EPS_NATIVE, "native-capped-stem-contact", failures)
    alpha["renderedContactGapsMeters"], alpha["renderedFrames"] = render_alpha_contact(directory, failures)
    return {"schemaVersion": 1, "version": bpy.app.version_string, "versionTuple": list(bpy.app.version), "complete": not failures, "cases": cases,
            "workerSha256": args.worker_sha256, "texturesSha256": hashlib.sha256(SOURCE.with_name("textures.py").read_bytes()).hexdigest(),
            "failures": failures, "savedSceneReopened": True, "contactGapMeters": gap,
            "atlasDiagnostics": atlas_diagnostics(), "alphaContact": alpha, "nativeStudioVerified": False,
            "limitations": ["Declared card base anchor only", "Virtual twig/rendered wood connection not proved",
                            "Filtered alpha/native exported UV checks concern the declared card root only",
                            "Actual textured contact renders require inspection; no whole-tree quality acceptance"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--worker-sha256", required=True)
    parser.add_argument("--textures-sha256", required=True)
    parser.add_argument("--baseline-sha256", required=True)
    parser.add_argument("--exporter-sha256", required=True)
    parser.add_argument("--audit-sha256", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    report = run(args)
    encoded = json.dumps(report, allow_nan=False, sort_keys=True)
    if len(encoded.encode("utf-8")) > 65536:
        raise RuntimeError("Native foliage diagnostic exceeds its fixed bound")
    with (Path(args.directory) / "native-foliage.json").open("x", encoding="utf-8") as stream:
        stream.write(encoded)
    print("ARCANE_RESULT " + json.dumps({"complete": report["complete"], "cases": len(report["cases"])}), flush=True)
    if not report["complete"]:
        raise RuntimeError("Native foliage declared-root regression failed")
