"""Deterministic static starter assets. Fixed templates and bundled parameterised
procedural generators (procedural.py) only; no arbitrary Python input.

Generation runs only in a new job directory. Audit mode opens our saved scene with
autoexec disabled and writes nothing. This process is supervised, not sandboxed.
"""
import argparse
import hashlib
import json
import math
import random
import struct
import sys

# Blender's isolated Python can ignore PYTHONDONTWRITEBYTECODE. Disable cache
# writes explicitly before local audit/assembly imports in either worker mode.
sys.dont_write_bytecode = True

from pathlib import Path
import bpy
import bmesh
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
# Model spec compiler modules (grammar/ in the repository; flat beside this file in a job).
sys.path.insert(1, str(Path(__file__).resolve().parent / "grammar"))
# General UV engine modules (uv/ in the repository; flat beside this file in a job).
sys.path.insert(2, str(Path(__file__).resolve().parent / "uv"))
# Procedural PBR material library (materials/ in the repository; flat beside this file in a job).
sys.path.insert(3, str(Path(__file__).resolve().parent / "materials"))
from audit import audit_scene, render_metrics


_failure_stage = "request-validation"
_failure_artifact = "request.json"
_failure_metrics = None
_failure_audit = False
_failure_mesh_reason = None


def event(stage, artifact=None):
    global _failure_stage, _failure_artifact
    _failure_stage = stage
    _failure_artifact = artifact
    print("ARCANE_EVENT " + json.dumps({"stage": stage}), flush=True)


def mesh_audit_reason(meshes, errors):
    """Classify only measured, exclusively material errors; never exception text."""
    categories = {"Missing named node material": "MESH_MATERIAL_NODE",
                  "Invalid material node link": "MESH_MATERIAL_LINK",
                  "Material surface is disconnected": "MESH_MATERIAL_SURFACE",
                  "Missing PBR shader": "MESH_MATERIAL_PBR",
                  "Invalid PBR Metallic": "MESH_MATERIAL_PBR",
                  "Invalid PBR Roughness": "MESH_MATERIAL_PBR"}
    if type(meshes) is not list or type(errors) is not list or not errors or any(type(error) is not str for error in errors):
        return "MESH_AUDIT"
    expected, reasons = [], set()
    for mesh in meshes:
        if type(mesh) is not dict or type(mesh.get("name")) is not str or type(mesh.get("errors")) is not list:
            return "MESH_AUDIT"
        for error in mesh["errors"]:
            if type(error) is not str or error not in categories:
                return "MESH_AUDIT"
            expected.append(mesh["name"] + ": " + error)
            reasons.add(categories[error])
    # audit_scene appends global budget/LOD errors after this exact flattening.
    if errors != expected or len(reasons) != 1:
        return "MESH_AUDIT"
    return next(iter(reasons))


def failure_report(error):
    # Compare known bundled messages but never serialize exception text, tracebacks, paths or input.
    text = str(error)
    if text == "Request byte provenance gate failed":
        code = "REQUEST_PROVENANCE"
    elif text == "Windows asset path has no verified short directory alias":
        code = "WINDOWS_PATH_LIMIT"
    elif text.startswith("Asset mesh gate failed:") or text == "Saved scene failed structural audit":
        code = "MESH_AUDIT"
        if (_failure_audit and _failure_stage == "mesh-validation" and _failure_metrics is not None
                and type(_failure_mesh_reason) is str and _failure_mesh_reason in
                ("MESH_MATERIAL_NODE", "MESH_MATERIAL_LINK", "MESH_MATERIAL_SURFACE", "MESH_MATERIAL_PBR")):
            code = _failure_mesh_reason
    elif text.endswith("mesh required repair") or text in ["Input mesh required structural repair", "Procedural mesh required structural repair"]:
        code = "MESH_REPAIR"
    elif text in ["Review render is empty, uniform or nonfinite", "Tree structure render dimensions changed"]:
        code = "RENDER_CONTENT"
    elif text in ["Foliage has no emitted wood skin", "Foliage has no emitted wood skin at its planned root",
                  "Foliage root moved outside its emitted branch skin"]:
        code = "FOLIAGE_ATTACHMENT"
    elif text == "Saved scene failed reopen validation":
        code = "SCENE_REOPEN"
    elif text.endswith(" export round trip failed"):
        code = "EXPORT_ROUNDTRIP"
    elif text in ["Tree has no foliage anchors within budget", "Column is too short for its base and capital",
                  "Column exceeds its triangle budget; reduce flutes", "Procedural mesh exceeded its triangle budget or is empty"] or text.startswith("Model spec:"):
        code = "PROCEDURAL_LIMIT"
    elif _failure_stage in ["identity", "export-identity"] and isinstance(error, ValueError):
        code = "IMPORT_IDENTITY"
    elif isinstance(error, FileNotFoundError):
        code = "FILE_MISSING"
    elif isinstance(error, (PermissionError, OSError)):
        code = "FILE_ACCESS"
    elif isinstance(error, MemoryError):
        code = "MEMORY_LIMIT"
    elif isinstance(error, (AttributeError, ImportError, NotImplementedError)):
        code = "BLENDER_API"
    elif isinstance(error, RuntimeError):
        code = "BLENDER_CONTEXT" if "poll()" in text or "context is incorrect" in text else "BLENDER_OPERATION"
    elif isinstance(error, (TypeError, KeyError, IndexError, ZeroDivisionError)):
        code = "INTERNAL_TYPE"
    else:
        code = "INVALID_DATA"
    known = {"ValueError", "RuntimeError", "TypeError", "AttributeError", "KeyError", "IndexError", "FileNotFoundError",
             "PermissionError", "OSError", "MemoryError", "ImportError", "ModuleNotFoundError", "ZeroDivisionError", "NotImplementedError"}
    name = type(error).__name__
    result = {"schemaVersion": 1, "stage": _failure_stage, "reasonCode": code,
              "exceptionType": name if name in known else "Exception"}
    if _failure_artifact:
        result["artifactPath"] = _failure_artifact
    if code in ("MESH_AUDIT", "MESH_MATERIAL_NODE", "MESH_MATERIAL_LINK", "MESH_MATERIAL_SURFACE", "MESH_MATERIAL_PBR") and _failure_metrics is not None:
        result["metrics"] = _failure_metrics
    if _failure_audit:
        result["auditPath"] = "audit.json"
    return result


def select(objects):
    for obj in list(bpy.context.selected_objects):
        obj.select_set(False)
    for obj in objects:
        obj.select_set(True)
    if objects:
        bpy.context.view_layer.objects.active = objects[0]


def blender_path(path):
    """Keep Blender's fixed file operations on the identical owned directory.
    Extended paths work for Python I/O but Blender's scene rename and exporters
    require ordinary short spelling. Existing aliases are queried, never created.
    """
    import os
    value = str(path)
    if os.name != "nt":
        return value
    namespace = "\\\\?\\"

    def ordinary(value):
        if value[:8].upper() == namespace + "UNC\\":
            return "\\\\" + value[8:]
        return value[4:] if value.startswith(namespace) else value

    def windows_length(value):
        return len(value.encode("utf-16-le")) // 2

    value = ordinary(value)
    # Scene saving appends '@' to its temporary filename before atomic rename.
    if windows_length(value) < 259:
        return value
    try:
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        short_path = kernel.GetShortPathNameW
        short_path.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
        short_path.restype = ctypes.c_uint
        buffer = ctypes.create_unicode_buffer(32768)
        count = short_path(str(path.parent), buffer, len(buffer))
        if not count or count >= len(buffer):
            raise ValueError()
        alias = Path(buffer.value)
        if not alias.is_absolute() or alias.resolve(strict=True) != path.parent.resolve(strict=True):
            raise ValueError()
        result = ordinary(str(alias / path.name))
        if windows_length(result) >= 259:
            raise ValueError()
        return result
    except (OSError, ValueError, AttributeError):
        raise ValueError("Windows asset path has no verified short directory alias") from None


def material(name, color, metallic, roughness):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    mat.diffuse_color = (*color, 1)
    return mat


def box(collection, name, dimensions, center, mat=None, bevel=0.0, role="render", source_key=None):
    mesh = bpy.data.meshes.new(name + "_Mesh")
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    for vert in bm.verts:
        vert.co.x *= dimensions[0]
        vert.co.y *= dimensions[1]
        vert.co.z *= dimensions[2]
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    # Bake centers into mesh coordinates: each component's pivot remains at floor.
    for vert in mesh.vertices:
        vert.co += Vector(center)
    obj["arcane_role"] = role
    if source_key is not None:
        obj["arcane_source_key"] = source_key
    if mat:
        mesh.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Edge bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        select([obj])
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def unwrap(obj):
    select([obj])
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.025, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode="OBJECT")


def finalize(obj):
    # Bake triangulation for identical source/export triangle counts.
    select([obj])
    mod = obj.modifiers.new("Game triangulation", "TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=mod.name)
    if obj.data.validate(verbose=False):
        raise ValueError(obj.name + " mesh required repair")
    if obj["arcane_role"] != "collision" and not obj.get("arcane_surface_uv"):
        unwrap(obj)


def collection(name):
    result = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(result)
    return result


def hero(request, mats):
    x, y, z = request["sizeMeters"]
    group = collection("COL_HeroProp")
    rng = random.Random(request["seed"])
    main = [box(group, "SM_" + request["name"] + "_body", (x, y, z * 0.8), (0, 0, z * 0.4), mats[0], min(x, y, z) * 0.035, source_key="body")]
    # Raised lid, protected corner posts, inset plaque and a carrying handle.
    main.append(box(group, "SM_" + request["name"] + "_lid", (x * 1.035, y * 1.035, z * 0.12), (0, 0, z * 0.85), mats[1], min(x, y, z) * 0.02, source_key="lid"))
    for i, (sx, sy) in enumerate([(-1, -1), (-1, 1), (1, -1), (1, 1)]):
        main.append(box(group, "SM_" + request["name"] + "_post" + str(i), (x * 0.07, y * 0.07, z * 0.82), (sx * x * 0.47, sy * y * 0.47, z * 0.41), mats[1], min(x, y, z) * 0.008, source_key="post" + str(i)))
    main.append(box(group, "SM_" + request["name"] + "_plaque", (x * 0.45, y * 0.035, z * 0.19), (0, -y * 0.508, z * (0.47 + rng.uniform(-0.025, 0.025))), mats[2], min(x, y, z) * 0.006, source_key="plaque"))
    main.append(box(group, "SM_" + request["name"] + "_handle", (x * 0.42, y * 0.08, z * 0.055), (0, 0, z * 0.973), mats[1], min(x, y, z) * 0.012, source_key="handle"))
    for i, sx in enumerate([-1, 1]):
        main.append(box(group, "SM_" + request["name"] + "_handle_support" + str(i), (x * 0.05, y * 0.08, z * 0.08), (sx * x * 0.18, 0, z * 0.925), mats[1], min(x, y, z) * 0.006, source_key="handle_support" + str(i)))
    lod_group = collection("COL_LOD1")
    lods = []
    for obj in main:
        copy = obj.copy()
        copy.data = obj.data.copy()
        copy.name = obj.name + "_LOD1"
        copy["arcane_role"] = "lod1"
        lod_group.objects.link(copy)
        select([copy])
        mod = copy.modifiers.new("LOD reduction", "DECIMATE")
        mod.ratio = 0.45
        bpy.ops.object.modifier_apply(modifier=mod.name)
        lods.append(copy)
    collisions = collection("COL_Collision")
    proxy = box(collisions, "COL_" + request["name"], (x * 1.035, y * 1.035, z), (0, 0, z / 2), role="collision", source_key="body_proxy")
    return main, lods, [proxy]


def environment(request, mats):
    x, y, z = request["sizeMeters"]
    group = collection("COL_EnvironmentKit")
    # Four independently named modules on a deterministic demonstration grid.
    parts = [
        ("floor", (x, y, z * 0.07), (0, 0, z * 0.035), 0),
        ("wall", (x, y * 0.08, z), (0, y * 0.46, z / 2), 0),
        ("pillar", (x * 0.14, y * 0.14, z * 1.04), (-x * 0.43, y * 0.40, z * 0.52), 1),
        ("step", (x * 0.58, y * 0.28, z * 0.16), (x * 0.1, -y * 0.25, z * 0.08), 2),
    ]
    main, proxies = [], []
    collisions = collection("COL_Collision")
    for name, dimensions, center, index in parts:
        main.append(box(group, "SM_" + request["name"] + "_" + name, dimensions, center, mats[index], min(dimensions) * 0.08, source_key=name))
        proxies.append(box(collisions, "COL_" + request["name"] + "_" + name, dimensions, center, role="collision", source_key=name))
    return main, [], proxies


def lookdev(main, request):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = request["renderSamples"]
    scene.cycles.seed = request["seed"]
    scene.cycles.use_denoising = True
    scene.render.resolution_x = request["renderResolution"]
    scene.render.resolution_y = request["renderResolution"]
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.055, 0.07, 0.10, 1)
    scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0.4
    bpy.context.view_layer.update()
    coordinates = [obj.matrix_world @ v.co for obj in main for v in obj.data.vertices]
    low = Vector(tuple(min(v[k] for v in coordinates) for k in range(3)))
    high = Vector(tuple(max(v[k] for v in coordinates) for k in range(3)))
    x, y, z = high - low
    target = (low + high) / 2
    span = max(x, y, z)
    group = collection("COL_Preview")
    backdrop = box(group, "PreviewGround", (span * 200, span * 200, span * 0.04), (target.x, target.y, low.z - span * 0.0205), material("PreviewGroundMaterial", (0.08, 0.10, 0.14), 0, 0.7))
    # Preview helpers excluded from all mesh budgets and exports.
    backdrop["arcane_role"] = "preview"
    for name, position, power, color in [
        ("Key", (span * 2, -span * 3, span * 4), 700, (1, 0.86, 0.7)),
        ("Fill", (-span * 2, -span, span * 2), 400, (0.62, 0.78, 1)),
        ("Rim", (span, span * 3, span * 3), 850, (0.7, 0.86, 1)),
    ]:
        data = bpy.data.lights.new("LGT_" + name, "AREA")
        data.energy = power * span ** 2
        data.color = color
        data.shape = "DISK"
        data.size = span * 2
        obj = bpy.data.objects.new("LGT_" + name, data)
        group.objects.link(obj)
        obj.location = target + Vector(position)
        obj.rotation_euler = (target - obj.location).to_track_quat('-Z', 'Y').to_euler()
    data = bpy.data.cameras.new("CAM_Review")
    camera = bpy.data.objects.new("CAM_Review", data)
    group.objects.link(camera)
    scene.camera = camera
    data.type = 'ORTHO'
    data.ortho_scale = span * 1.8
    return camera, target, span


def export_glb(path, objects, with_materials=True):
    event("export", path.name)
    select(objects)
    bpy.ops.export_scene.gltf(filepath=blender_path(path), export_format="GLB", use_selection=True,
                              export_yup=True, export_extras=True, export_animations=False,
                              export_materials="EXPORT" if with_materials else "NONE")


def semantic_id(request, role, key):
    # Explicit producer namespace, independent of display names, order and job UUID.
    source = "\0".join(["arcane-semantic-v1", request["template"], request["name"], role, key])
    return "arcane_" + hashlib.sha256(source.encode("utf-8")).hexdigest()


def stamp_import_identity(request, main_objects, lods, collision, sockets):
    seen = set()
    for obj in main_objects + lods + collision:
        key = obj.get("arcane_source_key")
        if not isinstance(key, str) or not key or len(key) > 64:
            raise ValueError("Missing explicit producer source key")
        stable = semantic_id(request, obj["arcane_role"], key)
        if stable in seen:
            raise ValueError("Duplicate producer source identity")
        seen.add(stable)
        obj["arcane_source_object_id"] = stable
        obj["arcane_identity_scheme"] = "arcane-semantic-v1"
        # All bundled meshes bake their centers into geometry, preserving floor pivot.
        obj["arcane_pivot"] = [0.0, 0.0, 0.0]
    for obj in main_objects + collision:
        # Custom recipes currently define model-level proxies, not per-part pairing.
        # Environment-kit has explicit matching module keys; hero uses one model proxy.
        targets = []
        if obj["arcane_role"] == "collision":
            targets = [p["arcane_source_object_id"] for p in main_objects
                       if request["template"] != "environment-kit" or p["arcane_source_key"] == obj["arcane_source_key"]]
        obj["arcane_collision_for"] = json.dumps(sorted(targets), separators=(",", ":"))
    for obj in sockets:
        if obj.parent not in main_objects:
            raise ValueError("Import anchor must belong to a render part")
        obj["arcane_source_anchor_id"] = semantic_id(request, "anchor", obj["arcane_socket_id"])
        obj["arcane_identity_scheme"] = "arcane-semantic-v1"
        obj["arcane_source_key"] = obj["arcane_socket_id"]
        obj["arcane_source_object_id"] = obj.parent["arcane_source_object_id"]


def exported_import_evidence(path, objects, sockets):
    event("export-identity", path.name)
    # Read only our two fixed exports. Bound allocation before parsing actual GLB JSON.
    size = path.stat().st_size
    if not 20 <= size <= 128 * 1024 * 1024:
        raise ValueError("Import evidence GLB size exceeded")
    with path.open("rb") as stream:
        header = stream.read(20)
        magic, version, length, json_size, chunk = struct.unpack("<IIIII", header)
        if (magic, version, length, chunk) != (0x46546C67, 2, size, 0x4E4F534A) or not 1 <= json_size <= 1024 * 1024 or json_size % 4:
            raise ValueError("Import evidence GLB header failed")
        raw = stream.read(json_size)
        doc = json.loads(raw.decode("utf-8"))
        digest = hashlib.sha256(header + raw)
        remaining = size - 20 - len(raw)
        while remaining > 0:
            block = stream.read(min(remaining, 64 * 1024))
            if not block:
                raise ValueError("Import evidence GLB changed during read")
            digest.update(block)
            remaining -= len(block)
        if stream.read(1):
            raise ValueError("Import evidence GLB grew during read")
    nodes = doc.get("nodes", [])
    if not isinstance(nodes, list) or len(nodes) > 4096:
        raise ValueError("Import evidence node count exceeded")
    rows, anchors = [], []
    expected = {obj["arcane_source_object_id"]: obj for obj in objects}
    expected_anchors = {obj["arcane_source_anchor_id"]: obj for obj in sockets}
    for index, node in enumerate(nodes):
        extra = node.get("extras", {})
        if "mesh" in node:
            stable = extra.get("arcane_source_object_id")
            obj = expected.pop(stable, None)
            if obj is None or extra.get("arcane_identity_scheme") != "arcane-semantic-v1" or extra.get("arcane_role") != obj["arcane_role"] or extra.get("arcane_source_key") != obj["arcane_source_key"] or extra.get("arcane_pivot") != list(obj["arcane_pivot"]) or extra.get("arcane_collision_for") != obj["arcane_collision_for"]:
                raise ValueError("Export lost producer object identity")
            rows.append({"sourceObjectId": stable, "sourceKey": obj["arcane_source_key"], "nodeIndex": index,
                         "role": obj["arcane_role"], "pivot": list(obj["arcane_pivot"]),
                         "collisionFor": json.loads(obj["arcane_collision_for"])})
        if extra.get("arcane_source_anchor_id"):
            stable = extra["arcane_source_anchor_id"]
            obj = expected_anchors.pop(stable, None)
            if obj is None or extra.get("arcane_source_object_id") != obj["arcane_source_object_id"]:
                raise ValueError("Export lost producer anchor identity")
            # Convert observed Blender world transform to glTF Y-up; column-major.
            from mathutils import Matrix
            convert = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
            world = convert @ obj.matrix_world @ convert.inverted()
            anchors.append({"sourceAnchorId": stable, "sourceKey": obj["arcane_source_key"],
                            "sourceObjectId": obj["arcane_source_object_id"], "nodeIndex": index,
                            "kind": obj["arcane_socket_kind"], "transform": [float(world[r][c]) for c in range(4) for r in range(4)]})
    if expected or expected_anchors:
        raise ValueError("Export omitted producer identities")
    return {"path": path.name, "sha256": digest.hexdigest(), "byteLength": size,
            "generator": doc["asset"]["generator"], "objects": rows, "anchors": anchors}


def export_metrics(path, expected, recipe=None):
    event("export-roundtrip", path.name)
    # Reimport actual exported bytes into a temporary scene. Original scene stays intact.
    old = bpy.context.scene
    temp = bpy.data.scenes.new("ExportAudit")
    bpy.context.window.scene = temp
    try:
        if path.suffix == ".glb":
            bpy.ops.import_scene.gltf(filepath=blender_path(path))
        else:
            bpy.ops.import_scene.fbx(filepath=blender_path(path), use_anim=False, use_custom_props=True, use_image_search=False)
        bpy.context.view_layer.update()
        objects = [obj for obj in temp.objects if obj.type == "MESH"]
        triangles = 0
        finite = True
        mats = set()
        for obj in objects:
            obj.data.calc_loop_triangles()
            triangles += len(obj.data.loop_triangles)
            finite = finite and all(math.isfinite(c) for v in obj.data.vertices for c in v.co)
            mats.update(m.name for m in obj.data.materials if m)
        if not objects or triangles != expected or not finite:
            raise ValueError(path.name + " export round trip failed")
        report = {"path": path.name, "objects": len(objects), "triangles": triangles, "materials": len(mats), "finitePositions": finite}
        if recipe is not None:
            from assembly import socket_metrics
            report["sockets"] = socket_metrics(temp)
        return report
    finally:
        bpy.context.window.scene = old
        for obj in list(temp.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.scenes.remove(temp)


def write_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)


def main():
    global _failure_metrics, _failure_audit, _failure_mesh_reason
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["generate", "audit"], required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--request-sha256", required=True)
    parser.add_argument("--recipe-sha256")
    parser.add_argument("--estimated-triangles")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    directory = Path(args.directory).resolve(strict=True)
    request_bytes = (directory / "request.json").read_bytes()
    if len(request_bytes) > 256 * 1024 or hashlib.sha256(request_bytes).hexdigest() != args.request_sha256:
        raise ValueError("Request byte provenance gate failed")
    request = json.loads(request_bytes)
    tree_review = None
    if request.get("template") == "procedural" and request.get("procedural", {}).get("kind") == "tree" and request["procedural"].get("finish") == "natural":
        import tree_structure_review as tree_review
    if request["template"] == "custom-assembly":
        request["_recipeSha256"] = args.recipe_sha256
        request["_estimatedTriangles"] = json.loads(args.estimated_triangles)
        from assembly import build_assembly, assembly_evidence
    if args.mode == "audit":
        event("scene-reopen", "asset.blend")
        bpy.ops.wm.open_mainfile(filepath=blender_path(directory / "asset.blend"), use_scripts=False)
        objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.get("arcane_role") in ["render", "lod1", "collision"]]
        meshes, totals, errors = audit_scene(objects, request)
        if tree_review is not None:
            retained = tree_review.retained_structure(directory, args.request_sha256)
            if retained is not None:
                tree_review.enrich_tree_meshes(request, objects, meshes, semantic_id, bpy.context.evaluated_depsgraph_get())
                if retained != tree_review.structure_metadata(request, [obj for obj in objects if obj.get("arcane_role") == "render"], meshes, args.request_sha256, semantic_id):
                    raise ValueError("Tree structure retained audit changed")
        report = {"meshes": meshes, "totals": totals, "errors": errors}
        if request["template"] == "custom-assembly":
            report["assembly"] = assembly_evidence(request)
        print("ARCANE_RESULT " + json.dumps(report, allow_nan=False), flush=True)
        if errors:
            raise ValueError("Saved scene failed structural audit")
        return
    event("blockout")
    # Factory startup in a separate worker process; only that worker's default scene is cleared.
    bpy.data.objects.remove(bpy.data.objects["Cube"], do_unlink=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1
    sockets = []
    if request["template"] == "custom-assembly":
        main_objects, lods, collision, sockets = build_assembly(request, material, collection, select)
    elif request["template"] == "procedural":
        if request["procedural"]["kind"] == "spec":
            from model_build import build as build_procedural
        else:
            from procedural import build as build_procedural
        main_objects, lods, collision, sockets = build_procedural(request, material, collection, select, box)
    else:
        mats = [material("MAT_Body", request["color"], 0.15, 0.42),
                material("MAT_Frame", (0.12, 0.15, 0.18), 0.8, 0.3),
                material("MAT_Accent", (0.8, 0.43, 0.11), 0.45, 0.36)]
        main_objects, lods, collision = hero(request, mats) if request["template"] == "hero-prop" else environment(request, mats)
    event("identity")
    stamp_import_identity(request, main_objects, lods, collision, sockets)
    event("checkpoint-save", "blockout.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blender_path(directory / "blockout.blend"), check_existing=False)
    event("mesh-validation")
    for obj in main_objects + lods + collision:
        finalize(obj)
    if any(data.get("surface") or data.get("library") for data in request.get("recipe", {}).get("materials", [])):
        event("texture-authoring")
        from textures import author_surfaces
        author_surfaces(request, directory, main_objects + lods)
    elif request.get("procedural", {}).get("finish") == "natural":
        event("texture-authoring")
        if request["procedural"]["kind"] == "spec":
            from model_build import author_finish
        else:
            from procedural import author_finish
        author_finish(request, directory, main_objects + lods)
    event("mesh-validation")
    meshes, totals, errors = audit_scene(main_objects + lods + collision, request)
    if tree_review is not None:
        tree_review.enrich_tree_meshes(request, main_objects + lods + collision, meshes, semantic_id, bpy.context.evaluated_depsgraph_get())
    if errors:
        _failure_mesh_reason = mesh_audit_reason(meshes, errors)
        _failure_metrics = {"renderTriangles": totals["renderTriangles"], "triangleBudget": request["triangleBudget"],
                            "collisionTriangles": totals["collisionTriangles"], "errorCount": len(errors),
                            "invalidMeshes": sum(bool(mesh["errors"]) for mesh in meshes)}
        write_json(directory / "audit.json", {"errors": errors, "meshes": meshes, "totals": totals})
        _failure_audit = True
        raise ValueError("Asset mesh gate failed: " + "; ".join(errors))
    event("review-render")
    for obj in lods + collision:
        obj.hide_render = True
    camera, target, span = lookdev(main_objects, request)
    if request["template"] == "procedural":
        # Large organic assets: keep albedo readable under the span-scaled preview lights.
        scene.view_settings.exposure = -1.4
    renders, review, tree_structure = [], None, None
    if request.get("procedural", {}).get("kind") == "spec":
        # Model spec self-check: hero render, 2x2 review sheet and measured review metrics.
        from model_build import review as spec_review
        event("review-render", "preview-hero.png")
        renders, review = spec_review(request, directory, camera, target, span, render_metrics)
    for name, offset in [] if review is not None else [("preview-hero.png", (2.6, -3.5, 2.3)), ("preview-side.png", (-4.0, 0, 0.5))]:
        event("review-render", name)
        camera.location = target + Vector(offset) * span
        camera.rotation_euler = (target - camera.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = str(directory / name)
        bpy.ops.render.render(write_still=True)
        renders.append(render_metrics(directory / name))
    if tree_review is not None:
        event("review-render", "preview-structure.png")
        metrics, tree_structure = tree_review.render_tree_structure(bpy, request, directory, camera, main_objects, meshes,
                                                                   args.request_sha256, semantic_id, render_metrics)
        renders.append(metrics)
        checked, checked_totals, checked_errors = audit_scene(main_objects + lods + collision, request)
        tree_review.enrich_tree_meshes(request, main_objects + lods + collision, checked, semantic_id, bpy.context.evaluated_depsgraph_get())
        if checked != meshes or checked_totals != totals or checked_errors != errors:
            raise ValueError("Tree structure source audit changed")
    event("scene-save", "asset.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blender_path(directory / "asset.blend"), check_existing=False)
    event("export")
    export_glb(directory / "asset.glb", main_objects + sockets)
    event("export", "asset.fbx")
    select(main_objects + sockets)
    bpy.ops.export_scene.fbx(filepath=blender_path(directory / "asset.fbx"), use_selection=True, object_types={'MESH', 'EMPTY'}, use_custom_props=True,
                              apply_unit_scale=True, apply_scale_options='FBX_SCALE_ALL', axis_forward='-Z', axis_up='Y',
                              bake_anim=False, add_leaf_bones=False)
    export_glb(directory / "collision.glb", collision, False)
    if lods:
        export_glb(directory / "asset-lod1.glb", lods)
    event("export-identity")
    import_evidence = {"schemaVersion": 1, "identityScheme": "arcane-semantic-v1",
                       "assetId": semantic_id(request, "asset", "root"), "blenderVersion": bpy.app.version_string,
                       "requestSha256": args.request_sha256,
                       "models": [exported_import_evidence(directory / "asset.glb", main_objects, sockets),
                                  exported_import_evidence(directory / "collision.glb", collision, [])]}
    event("export-roundtrip")
    exports = [export_metrics(directory / "asset.glb", totals["renderTriangles"], request.get("recipe")),
               export_metrics(directory / "asset.fbx", totals["renderTriangles"], request.get("recipe")),
               export_metrics(directory / "collision.glb", totals["collisionTriangles"])]
    if lods:
        exports.append(export_metrics(directory / "asset-lod1.glb", totals["lod1Triangles"]))
    event("scene-reopen", "asset.blend")
    bpy.ops.wm.open_mainfile(filepath=blender_path(directory / "asset.blend"), use_scripts=False)
    reopened = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.get("arcane_role") in ["render", "lod1", "collision"]]
    again, again_totals, again_errors = audit_scene(reopened, request)
    if tree_review is not None:
        tree_review.enrich_tree_meshes(request, reopened, again, semantic_id, bpy.context.evaluated_depsgraph_get())
    if again_errors or again_totals != totals or again != meshes:
        raise ValueError("Saved scene failed reopen validation")
    report = {"schemaVersion": 1, "template": request["template"], "meshes": meshes, "totals": totals,
              "renders": renders, "exports": exports, "studioImport": import_evidence, "savedSceneReopened": True, "errors": [],
              "warnings": ["UV overlap/texel density, inter-object intersections and visual quality require human review.",
                           "Roblox import, scale mapping and collision behavior are unverified."]}
    if any("uvQuality" in mesh for mesh in meshes):
        # Measured UV quality (workers/blender/uv) replaces the generic UV review note.
        report["warnings"][0] = "Inter-object intersections and visual quality require human review; UV quality is measured per mesh (uvQuality)."
        report["warnings"] += [mesh["name"] + ": " + line for mesh in meshes for line in mesh.get("uvQuality", {}).get("warnings", [])][:32]
    if request["template"] == "custom-assembly":
        report["assembly"] = assembly_evidence(request)
        write_json(directory / "assembly.json", report["assembly"])
    if review is not None:
        report["review"] = review
    if tree_structure is not None:
        report["treeStructure"] = tree_structure
    event("audit-write", "audit.json")
    write_json(directory / "audit.json", report)
    print("ARCANE_RESULT " + json.dumps({"audit": "audit.json"}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("ARCANE_FAILURE " + json.dumps(failure_report(error), allow_nan=False), flush=True)
        raise
