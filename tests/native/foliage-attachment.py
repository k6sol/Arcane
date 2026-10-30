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
from mathutils import Euler, Vector
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
    # The visible stalk may be laterally offset inside the unchanged tile.
    # Report actual production alpha; never equate card-centre contact with
    # visible-petiole contact or whole-tree/wood connectivity.
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
    path = directory / "attachment.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(path), check_existing=False)
    bpy.ops.wm.open_mainfile(filepath=str(path), use_scripts=False)
    for name, before in snapshots.items():
        obj = bpy.data.objects.get(name)
        require(obj is not None and snapshot(obj) == before, name + ":save-reopen", failures)
    gap = render_contact(directory)
    require(gap <= EPS_NATIVE, "native-capped-stem-contact", failures)
    return {"schemaVersion": 1, "version": bpy.app.version_string, "versionTuple": list(bpy.app.version), "complete": not failures, "cases": cases,
            "workerSha256": args.worker_sha256, "texturesSha256": hashlib.sha256(SOURCE.with_name("textures.py").read_bytes()).hexdigest(),
            "failures": failures, "savedSceneReopened": True, "contactGapMeters": gap,
            "atlasDiagnostics": atlas_diagnostics(), "nativeStudioVerified": False,
            "limitations": ["Declared card base anchor only", "Virtual twig/rendered wood connection not proved",
                            "Atlas offsets are diagnostic; alpha-visible petiole contact not certified",
                            "Neutral contact renders require inspection; no whole-tree quality acceptance"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--worker-sha256", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    report = run(args)
    with (Path(args.directory) / "native-foliage.json").open("x", encoding="utf-8") as stream:
        json.dump(report, stream, allow_nan=False, sort_keys=True)
    print("ARCANE_RESULT " + json.dumps({"complete": report["complete"], "cases": len(report["cases"])}), flush=True)
    if not report["complete"]:
        raise RuntimeError("Native foliage declared-root regression failed")
