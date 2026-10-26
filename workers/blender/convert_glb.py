"""Fixed owned static conversion worker. Native execution is supervised by host.

This script is not a caller-selected Blender program. It admits only fixed files
in the fresh host job directory, stamps observed host-marked objects, and refuses
loss rather than simplifying source geometry/materials to pass delivery gates.
"""
import sys
sys.dont_write_bytecode = True

import argparse
import contextlib
import json
import math
import os
from pathlib import Path

# Blender --python places the fixed script directory first. Do not import helpers
# from the process working directory or a caller-provided Python search path.
SCRIPT_DIRECTORY = Path(__file__).absolute().parent
sys.path.insert(0, str(SCRIPT_DIRECTORY))
import conversion_audit as audit

STAGES = ("input", "source-import", "source-map", "collision", "scene-save",
          "export", "scene-reopen", "export-roundtrip", "review-render", "audit-write")
stage = "input"


def event(value):
    global stage
    audit.require(value in STAGES)
    stage = value
    print("ARCANE_EVENT " + json.dumps({"stage": value}, separators=(",", ":")), flush=True)


@contextlib.contextmanager
def quiet_native():
    # Operators may print source paths; keep Python-level operator chatter out of
    # the structured worker stream. The host still owns/bounds native child logs.
    with open(os.devnull, "w", encoding="utf-8") as sink:
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            yield


def operate(operator, arguments):
    properties = set(operator.get_rna_type().properties.keys())
    audit.require(set(arguments) <= properties, "FEATURE")
    with quiet_native():
        result = operator(**arguments)
    audit.require(result == {"FINISHED"}, "NATIVE")


def import_model(bpy, path):
    operate(bpy.ops.import_scene.gltf, {"filepath": str(path), "import_pack_images": True,
        "merge_vertices": False, "import_shading": "NORMALS", "import_select_created_objects": True,
        "import_scene_extras": True})
    bpy.context.view_layer.update()


def select_objects(bpy, objects):
    bpy.context.view_layer.objects.active = None
    for obj in bpy.context.view_layer.objects:
        obj.select_set(False)
    for obj in objects:
        audit.require(obj.name in bpy.context.view_layer.objects, "EXPORT")
        obj.hide_set(False)
        obj.select_set(True)
    if objects:
        bpy.context.view_layer.objects.active = objects[0]


def export_model(bpy, directory, filename, objects, materials):
    path = directory / filename
    audit.require(not path.exists() and not path.is_symlink(), "IO_EXISTS")
    select_objects(bpy, objects)
    operate(bpy.ops.export_scene.gltf, {"filepath": str(path), "check_existing": False,
        "export_format": "GLB", "use_selection": True, "export_extras": True,
        "export_yup": True, "export_apply": False, "export_texcoords": True,
        "export_normals": True, "export_tangents": True, "export_materials": materials,
        "export_vertex_color": "ACTIVE", "export_all_vertex_colors": True,
        "export_active_vertex_color_when_no_material": True, "export_attributes": True,
        "export_image_format": "AUTO", "export_animations": False, "export_skins": False,
        "export_morph": False, "export_cameras": False, "export_lights": False,
        "export_gpu_instances": False, "export_draco_mesh_compression_enable": False,
        "export_use_gltfpack": False})
    return audit.read_owned(path, audit.EXPORT_BYTES, 20)


def mapped_objects(scene, parts, source_hash, stamped):
    markers = {p["originMarker"]: p for p in parts}
    found = {}
    for obj in scene.objects:
        audit.require(obj.type in ("MESH", "EMPTY"), "FEATURE")
        if obj.type != "MESH":
            audit.require(obj.get(audit.ORIGIN) is None, "MAP")
            continue
        if stamped and obj.get("arcane_role") == "collision":
            audit.require(obj.get("arcane_source_object_id") == audit.object_id(source_hash, "collision", "proxy"), "MAP")
            continue
        marker = obj.get(audit.ORIGIN)
        audit.require(type(marker) is str and marker in markers and marker not in found, "MAP")
        part = markers[marker]
        if stamped:
            assert_identity(obj, part, source_hash)
        found[marker] = obj
    audit.require(set(found) == set(markers), "MAP")
    return {p["sourceKey"]: found[p["originMarker"]] for p in parts}


def clear_properties(block):
    for key in list(block.keys()):
        del block[key]


def stamp(obj, source_hash, role, key, collision_for, origin=None):
    clear_properties(obj)
    obj["arcane_identity_scheme"] = audit.IDENTITY
    obj["arcane_source_object_id"] = audit.object_id(source_hash, role, key)
    obj["arcane_source_key"] = key
    obj["arcane_role"] = role
    obj["arcane_pivot"] = [0.0, 0.0, 0.0]
    obj["arcane_collision_for"] = audit.canonical(collision_for).decode("ascii")
    if origin is not None:
        obj[audit.ORIGIN] = origin


def assert_identity(obj, part, source_hash):
    audit.require(obj.get("arcane_identity_scheme") == audit.IDENTITY and
        obj.get("arcane_source_object_id") == audit.object_id(source_hash, "render", part["sourceKey"]) and
        obj.get("arcane_source_key") == part["sourceKey"] and obj.get("arcane_role") == "render" and
        list(obj.get("arcane_pivot", [])) == [0, 0, 0] and obj.get("arcane_collision_for") == "[]" and
        obj.get(audit.ORIGIN) == part["originMarker"], "MAP")


def assert_proxy_identity(obj, mapping, request):
    targets = sorted(audit.object_id(request["sourceSha256"], "render", p["sourceKey"]) for p in mapping["parts"])
    audit.require(obj.get("arcane_identity_scheme") == audit.IDENTITY and
        obj.get("arcane_source_object_id") == audit.object_id(request["sourceSha256"], "collision", "proxy") and
        obj.get("arcane_source_key") == "proxy" and obj.get("arcane_role") == "collision" and
        list(obj.get("arcane_pivot", [])) == [0,0,0] and obj.get(audit.ORIGIN) is None and
        obj.get("arcane_collision_for") == audit.canonical(targets).decode("ascii"), "MAP")


def hierarchy_signature(doc):
    """Name/order-independent selected hierarchy, retaining even empty leaves.

    Original host-marked mesh leaves identify the branches. Actual local affine
    matrices and child structure must survive; world-position agreement alone
    cannot silently excuse flattening/reparenting.
    """
    nodes = doc.get("nodes", [])
    audit.worlds(doc)  # Also rejects cycles, repeated/foreign scene nodes.
    scene = audit.ref(doc.get("scenes", []), doc.get("scene", 0))
    def branch(index, depth):
        audit.require(depth <= 256, "MAP")
        node = audit.ref(nodes, index)
        marker = node.get("extras", {}).get(audit.ORIGIN)
        audit.require(("mesh" in node) == (marker is not None), "MAP")
        return audit.sha(audit.canonical({"matrix": [audit.quantize(v) for v in audit.matrix_local(node)],
            "origin": marker, "children": sorted(branch(child, depth + 1) for child in node.get("children", []))}))
    return sorted(branch(index, 0) for index in scene.get("nodes", []))


def source_evidence(request, mapping, original, imported):
    source_doc, source_bin = audit.glb(original)
    import_doc, import_bin = audit.glb(imported)
    audit.require(source_bin == import_bin, "SOURCE")
    audit.require(len(source_doc.get("scenes", [])) == mapping["declaredSceneCount"] and
        source_doc.get("scene", 0) == mapping["sourceSceneIndex"], "MAP")
    source_world = audit.worlds(source_doc, mapping["sourceSceneIndex"])
    actual_parts = set()
    for index in source_world:
        node = source_doc["nodes"][index]
        if "mesh" in node:
            mesh = audit.ref(source_doc.get("meshes", []), node["mesh"])
            actual_parts.update((index, primitive) for primitive in range(len(mesh["primitives"])))
    audit.require(actual_parts == {(p["sourceNodeIndex"], p["sourcePrimitiveIndex"]) for p in mapping["parts"]}, "MAP")
    expected = {}
    marked = {index: node for index, node in enumerate(import_doc.get("nodes", [])) if audit.ORIGIN in node.get("extras", {})}
    audit.require(set(marked) == {p["importNodeIndex"] for p in mapping["parts"]}, "MAP")
    for part in mapping["parts"]:
        node = audit.ref(source_doc["nodes"], part["sourceNodeIndex"])
        audit.require(node.get("mesh") == part["sourceMeshIndex"], "MAP")
        primitive = audit.ref(audit.ref(source_doc["meshes"], node["mesh"])["primitives"], part["sourcePrimitiveIndex"])
        audit.require(primitive.get("material") == part["sourceMaterialIndex"], "MAP")
        digest, semantics, triangles, world = audit.primitive_geometry(source_doc, source_bin, part["sourceNodeIndex"], part["sourcePrimitiveIndex"], scene_index=mapping["sourceSceneIndex"])
        audit.require(triangles == part["triangles"] and all(abs(a-b) <= 1e-9 for a,b in zip(world, part["worldMatrix"])), "MAP")
        imported_node = marked[part["importNodeIndex"]]
        audit.require(imported_node.get("extras") == {audit.ORIGIN: part["originMarker"]}, "MAP")
        imported_mesh = audit.ref(import_doc.get("meshes", []), imported_node.get("mesh"))
        audit.require(len(imported_mesh.get("primitives", [])) == 1, "MAP")
        comparison, copied_semantics, copied_triangles, copied_world = audit.primitive_geometry(import_doc, import_bin, part["importNodeIndex"], 0)
        audit.require((comparison, copied_semantics, copied_triangles) == (digest, semantics, triangles) and
            all(abs(a-b) <= 1e-9 for a,b in zip(world, copied_world)), "SOURCE")
        audit.require(imported_mesh["primitives"][0].get("material") == part["sourceMaterialIndex"], "MAP")
        expected[part["sourceKey"]] = {"geometry": digest, "semantics": semantics, "material": part["sourceMaterialIndex"]}
    return source_doc, source_bin, expected, hierarchy_signature(import_doc)


def measured_rows(bpy, objects, mapping, request, expected):
    rows = []
    for part in mapping["parts"]:
        row = audit.measure(objects[part["sourceKey"]], part, request["sourceSha256"], expected[part["sourceKey"]]["semantics"], bpy)
        audit.require(row["triangles"] == part["triangles"], "GEOMETRY_TRIANGLES")
        audit.require(row["geometrySha256"] == expected[part["sourceKey"]]["geometry"], "GEOMETRY_HASH")
        rows.append(row)
    return sorted(rows, key=lambda row: row["sourceKey"])


def render_ancestors(scene, objects):
    result = set(objects)
    result.update(obj for obj in scene.objects if obj.type == "EMPTY")
    for obj in objects:
        parent = obj.parent
        while parent is not None:
            audit.require(parent.type == "EMPTY" or parent in result, "MAP")
            result.add(parent)
            parent = parent.parent
    return sorted(result, key=lambda obj: obj.as_pointer())  # Order never supplies identity.


def proxy_geometry(obj, bpy):
    import bmesh
    bm = bmesh.new()
    try:
        bm.from_mesh(obj.data)
        audit.require(4 <= len(bm.verts) <= 60000 and 4 <= len(bm.faces) <= 20000 and
            all(edge.is_manifold for edge in bm.edges) and all(len(face.verts) == 3 for face in bm.faces), "COLLISION")
        bm.normal_update()
        volume = abs(bm.calc_volume(signed=True))
        audit.require(math.isfinite(volume) and volume > 1e-12, "COLLISION")
        rows = []
        for face in bm.faces:
            corners = []
            points = []
            for vertex in face.verts:
                p = obj.matrix_world @ vertex.co
                value = [float(p.x), float(p.z), -float(p.y)]
                points.append(value)
                corners.append({"POSITION": [audit.quantize(n) for n in value]})
            a,b,c = points
            u=[b[k]-a[k] for k in range(3)]; v=[c[k]-a[k] for k in range(3)]
            audit.require(math.hypot(u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]) > 1e-10, "COLLISION")
            rows.append(audit.triangle_key(corners))
        return audit.geometry_hash(rows), len(bm.faces)
    finally:
        bm.free()


def make_proxy(bpy, objects, source_hash, render_triangles):
    import bmesh
    bm = bmesh.new()
    try:
        points = set()
        for obj in objects.values():
            for vertex in obj.data.vertices:
                p = obj.matrix_world @ vertex.co
                value = tuple(audit.finite(float(n)) for n in p)
                points.add(value)
        audit.require(4 <= len(points) <= 300000, "COLLISION")
        for p in sorted(points):
            bm.verts.new(p)
        bmesh.ops.convex_hull(bm, input=list(bm.verts), use_existing_faces=False)
        # Only the actual computed hull is retained. Original render meshes never
        # enter this bmesh and are neither welded nor modified.
        hull = {vertex for face in bm.faces for vertex in face.verts}
        discard = [vertex for vertex in bm.verts if vertex not in hull]
        if discard:
            bmesh.ops.delete(bm, geom=discard, context="VERTS")
        audit.require(bool(bm.faces) and all(edge.is_manifold for edge in bm.edges), "COLLISION")
        bmesh.ops.triangulate(bm, faces=list(bm.faces), quad_method="BEAUTY", ngon_method="BEAUTY")
        bm.normal_update()
        audit.require(4 <= len(bm.faces) <= 20000 and render_triangles + len(bm.faces) <= 100000 and
            abs(bm.calc_volume(signed=True)) > 1e-12, "COLLISION")
        mesh = bpy.data.meshes.new("conversion-collision")
        bm.to_mesh(mesh); mesh.update()
    finally:
        bm.free()
    obj = bpy.data.objects.new("conversion-collision", mesh)
    bpy.context.scene.collection.objects.link(obj)
    render_ids = sorted(audit.object_id(source_hash, "render", key) for key in objects)
    stamp(obj, source_hash, "collision", "proxy", render_ids)
    bpy.context.view_layer.update()
    proxy_geometry(obj, bpy)
    return obj


def exported_evidence(raw, filename, request, mapping, expected, source_doc, source_bin, decoder, source_hierarchy=None, proxy_hash=None):
    doc, binary = audit.glb(raw, audit.EXPORT_BYTES)
    generator = doc.get("asset", {}).get("generator")
    audit.require(type(generator) is str and 1 <= len(generator) <= 256 and all(32 <= ord(c) <= 126 for c in generator), "EXPORT")
    world = audit.worlds(doc)
    if filename == "asset.glb":
        audit.require(hierarchy_signature(doc) == source_hierarchy, "EXPORT")
    meshes = [(index, node) for index, node in enumerate(doc.get("nodes", [])) if "mesh" in node]
    audit.require(all(index in world for index, _node in meshes), "EXPORT")
    parts = {p["sourceKey"]: p for p in mapping["parts"]}
    want = set(parts) if filename == "asset.glb" else {"proxy"}
    found = set(); rows = []
    for index, node in meshes:
        audit.natural(index, 4095)
        extras = node.get("extras", {})
        key = extras.get("arcane_source_key")
        audit.require(type(key) is str and key in want and key not in found and extras.get("arcane_identity_scheme") == audit.IDENTITY, "EXPORT")
        role = "render" if filename == "asset.glb" else "collision"
        targets = [] if role == "render" else sorted(audit.object_id(request["sourceSha256"], "render", k) for k in parts)
        origin = parts[key]["originMarker"] if role == "render" else None
        audit.require(extras.get("arcane_source_object_id") == audit.object_id(request["sourceSha256"], role, key) and
            extras.get("arcane_role") == role and extras.get("arcane_pivot") == [0,0,0] and
            extras.get("arcane_collision_for") == audit.canonical(targets).decode("ascii") and extras.get(audit.ORIGIN) == origin, "EXPORT")
        mesh = audit.ref(doc.get("meshes", []), node["mesh"])
        audit.require(len(mesh.get("primitives", [])) == 1, "EXPORT")
        primitive = mesh["primitives"][0]
        if role == "render":
            part = parts[key]; evidence = expected[key]
            digest, _semantics, triangles, _matrix = audit.primitive_geometry(doc, binary, index, 0, evidence["semantics"])
            audit.require(digest == evidence["geometry"] and triangles == part["triangles"], "GEOMETRY")
            before = audit.material_semantics(source_doc, source_bin, evidence["material"], decoder)
            after = audit.material_semantics(doc, binary, primitive.get("material"), decoder)
            audit.require(before == after, "MATERIAL")
        else:
            digest, _semantics, triangles, _matrix = audit.primitive_geometry(doc, binary, index, 0, ("POSITION",))
            audit.require(digest == proxy_hash and 4 <= triangles <= 20000 and "material" not in primitive, "COLLISION")
        rows.append({"sourceObjectId": extras["arcane_source_object_id"], "sourceKey": key, "nodeIndex": index,
                     "role": role, "pivot": [0,0,0], "collisionFor": targets, "originMarker": origin})
        found.add(key)
    audit.require(found == want and len(meshes) == len(want), "EXPORT")
    return {"path": filename, "sha256": audit.sha(raw), "byteLength": len(raw), "generator": generator,
            "objects": sorted(rows, key=lambda row: row["sourceKey"]), "anchors": []}


def roundtrip(bpy, directory, mapping, request, expected, reopened, proxy_hash):
    original_scene = bpy.context.scene
    window = bpy.context.window
    audit.require(window is not None, "FEATURE")
    temporary = bpy.data.scenes.new("conversion-roundtrip")
    before_objects = set(bpy.data.objects)
    try:
        window.scene = temporary
        import_model(bpy, directory / "asset.glb")
        objects = mapped_objects(temporary, mapping["parts"], request["sourceSha256"], True)
        rows = measured_rows(bpy, objects, mapping, request, expected)
        # Blender may split vertices at an export seam; compare the canonical
        # per-corner semantics/material graph, not transient vertex numbering.
        by_key = {row["sourceKey"]: row for row in reopened}
        for row in rows:
            prior = by_key[row["sourceKey"]]
            audit.require(row["geometrySha256"] == prior["geometrySha256"] and row["materialSha256"] == prior["materialSha256"] and
                row["triangles"] == prior["triangles"] and row["uvLayers"] == prior["uvLayers"], "REOPEN")
        if request["collision"] == "convex-hull":
            for obj in list(temporary.objects):
                bpy.data.objects.remove(obj, do_unlink=True)
            import_model(bpy, directory / "collision.glb")
            meshes = [obj for obj in temporary.objects if obj.type == "MESH"]
            audit.require(len(meshes) == 1 and meshes[0].get("arcane_source_object_id") == audit.object_id(request["sourceSha256"], "collision", "proxy"), "COLLISION")
            assert_proxy_identity(meshes[0], mapping, request)
            digest, _count = proxy_geometry(meshes[0], bpy)
            audit.require(digest == proxy_hash, "COLLISION")
    finally:
        window.scene = original_scene
        for obj in list(bpy.data.objects):
            if obj not in before_objects:
                bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.scenes.remove(temporary)
        # Remove only unreferenced roundtrip data, not reopened source resources.
        for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
            for block in list(collection):
                if block.users == 0:
                    collection.remove(block)
        bpy.context.view_layer.update()


def review_renders(bpy, directory, objects, request):
    from mathutils import Vector
    scene = bpy.context.scene
    points = [obj.matrix_world @ vertex.co for obj in objects.values() for vertex in obj.data.vertices]
    audit.require(bool(points), "RENDER")
    low = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    high = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    center = (low + high) / 2
    radius = max((point - center).length for point in points)
    audit.require(math.isfinite(radius) and radius > 0, "RENDER")
    for obj in scene.objects:
        if obj.type == "MESH":
            obj.hide_render = obj not in set(objects.values())
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = request["renderSamples"]
    scene.render.threads_mode = "FIXED"; scene.render.threads = 2
    scene.render.resolution_x = scene.render.resolution_y = request["renderResolution"]
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.film_transparent = False
    scene.render.use_file_extension = True
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.exposure = 0; scene.view_settings.gamma = 1
    world = bpy.data.worlds.new("conversion-review-world")
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    audit.require(background is not None, "RENDER")
    background.inputs["Color"].default_value = (0.08,0.08,0.08,1)
    background.inputs["Strength"].default_value = 0.6
    scene.world = world
    for index, direction in enumerate(((3,-4,5),(-4,-1,2),(1,4,3))):
        data = bpy.data.lights.new("conversion-review-light", type="AREA")
        data.energy = (700 if index == 0 else 450) * radius * radius
        data.shape = "DISK"; data.size = radius * 3
        light = bpy.data.objects.new("conversion-review-light", data)
        scene.collection.objects.link(light)
        light.location = center + Vector(direction).normalized() * radius * 4
        light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()
    camera_data = bpy.data.cameras.new("conversion-review-camera")
    camera = bpy.data.objects.new("conversion-review-camera", camera_data)
    scene.collection.objects.link(camera); scene.camera = camera
    camera_data.type = "PERSP"; camera_data.lens = 45
    camera_data.clip_start = max(0.0001, radius / 10000)
    camera_data.clip_end = max(100, radius * 100)
    distance = radius / math.sin(min(camera_data.angle_x, camera_data.angle_y) / 2) * 1.2
    rows = []
    for filename, direction in (("preview-hero.png", (2.6,-3.5,2.3)), ("preview-side.png", (-4,0,0.7))):
        path = directory / filename
        audit.require(not path.exists() and not path.is_symlink(), "IO_EXISTS")
        camera.location = center + Vector(direction).normalized() * distance
        camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = str(path)
        bpy.context.view_layer.update()
        operate(bpy.ops.render.render, {"write_still": True})
        row = audit.render_metrics(path, bpy)
        audit.require(row["width"] == request["renderResolution"] and row["height"] == request["renderResolution"], "RENDER")
        rows.append(row)
    return rows


def run():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    class FixedParser(argparse.ArgumentParser):
        def error(self, _message):
            raise audit.ConversionFailure("INPUT")
    parser = FixedParser(add_help=False, allow_abbrev=False)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--request-sha256", required=True)
    options = parser.parse_args(argv)
    directory = Path(options.directory)
    audit.require(directory.is_absolute(), "INPUT")
    audit.no_links(directory, directory=True)
    audit.no_links(SCRIPT_DIRECTORY, directory=True)
    # Windows CLI directory arguments use extended-length spelling even when
    # __file__ uses the ordinary spelling. Compare actual admitted identities,
    # never relax custody to a string prefix or a guessed normalization.
    audit.require(os.path.samefile(directory, SCRIPT_DIRECTORY), "INPUT")
    for filename in ("convert_glb.py", "conversion_audit.py", "probe.py"):
        audit.read_owned(directory / filename, 1024 * 1024)
    helper = Path(audit.__file__).absolute()
    audit.no_links(helper)
    audit.require(os.path.samefile(helper, directory / "conversion_audit.py"), "INPUT")
    audit.no_links(directory, directory=True)
    audit.no_links(SCRIPT_DIRECTORY, directory=True)
    for filename in ("asset.blend", "asset.glb", "collision.glb", "preview-hero.png", "preview-side.png", "conversion-audit.json"):
        audit.require(not (directory / filename).exists() and not (directory / filename).is_symlink(), "IO_EXISTS")
    request, mapping, original, marked = audit.validate_inputs(directory, options.request_sha256)
    source_doc, source_bin, expected, source_hierarchy = source_evidence(request, mapping, original, marked)

    import bpy
    audit.require(bpy.app.background and not bpy.app.autoexec_fail, "FEATURE")
    version = str(bpy.app.version_string)
    audit.require(1 <= len(version) <= 128 and all(32 <= ord(c) <= 126 for c in version), "FEATURE")
    decoder = audit.ImageDecoder(bpy, directory)
    # Decode/compare source-present channels before importing arbitrary scene data.
    for evidence in expected.values():
        audit.material_semantics(source_doc, source_bin, evidence["material"], decoder)
    event("source-import")
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)
    import_model(bpy, directory / "import-source.glb")
    event("source-map")
    objects = mapped_objects(bpy.context.scene, mapping["parts"], request["sourceSha256"], False)
    # C31 strips metadata in JSON. Also clear actual ID properties before stamping
    # trusted correspondence, without touching UV/color/mesh attribute data.
    for collection in (bpy.data.scenes, bpy.data.collections, bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for block in collection:
            clear_properties(block)
    for part in mapping["parts"]:
        stamp(objects[part["sourceKey"]], request["sourceSha256"], "render", part["sourceKey"], [], part["originMarker"])
    bpy.context.view_layer.update()
    imported_rows = measured_rows(bpy, objects, mapping, request, expected)
    event("collision")
    proxy = make_proxy(bpy, objects, request["sourceSha256"], sum(row["triangles"] for row in imported_rows)) if request["collision"] == "convex-hull" else None
    proxy_hash = proxy_geometry(proxy, bpy)[0] if proxy is not None else None
    event("scene-save")
    for image in bpy.data.images:
        if image.source == "FILE" and not image.packed_file:
            image.pack()
        audit.require(image.source in ("FILE", "GENERATED") and (image.source != "FILE" or image.packed_file is not None), "MATERIAL")
    operate(bpy.ops.wm.save_as_mainfile, {"filepath": str(directory / "asset.blend"), "check_existing": False})
    saved_scene_hash = audit.sha(audit.read_owned(directory / "asset.blend", audit.BLEND_BYTES))
    event("export")
    render_raw = export_model(bpy, directory, "asset.glb", render_ancestors(bpy.context.scene, list(objects.values())), "EXPORT")
    models = [exported_evidence(render_raw, "asset.glb", request, mapping, expected, source_doc, source_bin, decoder, source_hierarchy)]
    collision_raw = None
    if proxy is not None:
        collision_raw = export_model(bpy, directory, "collision.glb", [proxy], "NONE")
        models.append(exported_evidence(collision_raw, "collision.glb", request, mapping, expected, source_doc, source_bin, decoder, proxy_hash=proxy_hash))
    audit.require(len({model["generator"] for model in models}) == 1, "EXPORT")
    event("scene-reopen")
    operate(bpy.ops.wm.open_mainfile, {"filepath": str(directory / "asset.blend"), "load_ui": False, "use_scripts": False})
    objects = mapped_objects(bpy.context.scene, mapping["parts"], request["sourceSha256"], True)
    reopened_rows = measured_rows(bpy, objects, mapping, request, expected)
    audit.require(imported_rows == reopened_rows, "REOPEN")
    collision_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.get("arcane_role") == "collision"]
    audit.require(len(collision_objects) == int(request["collision"] == "convex-hull"), "REOPEN")
    if collision_objects:
        assert_proxy_identity(collision_objects[0], mapping, request)
        audit.require(proxy_geometry(collision_objects[0], bpy)[0] == proxy_hash, "REOPEN")
    event("export-roundtrip")
    roundtrip(bpy, directory, mapping, request, expected, reopened_rows, proxy_hash)
    audit.require(audit.read_owned(directory / "asset.glb", audit.EXPORT_BYTES, 20) == render_raw, "SOURCE")
    if collision_raw is not None:
        audit.require(audit.read_owned(directory / "collision.glb", audit.EXPORT_BYTES, 20) == collision_raw, "SOURCE")
    event("review-render")
    renders = review_renders(bpy, directory, objects, request)
    event("audit-write")
    # Inputs remain immutable through actual reopen/export/render; no source or
    # request can be replaced while an observation is being assembled.
    again = audit.validate_inputs(directory, options.request_sha256)
    audit.require(again[0] == request and again[1] == mapping and again[2] == original and again[3] == marked, "SOURCE")
    audit.require(audit.sha(audit.read_owned(directory / "asset.blend", audit.BLEND_BYTES)) == saved_scene_hash, "SOURCE")
    warnings = ["delivery-support-pending"]
    if any(row["boundaryEdges"] for row in imported_rows): warnings.append("open-render-surfaces")
    if request["collision"] == "none": warnings.append("no-collision-proxy")
    result = {"schemaVersion": 1, "kind": "arcane-glb-conversion-audit", "jobId": request["jobId"],
        "parentJobId": request["parentJobId"], "parentManifestSha256": request["parentManifestSha256"],
        "requestSha256": options.request_sha256, "sourceSha256": request["sourceSha256"], "importSha256": request["importSha256"],
        "sourceMapSha256": request["sourceMapSha256"], "identityScheme": audit.IDENTITY,
        "assetId": audit.asset_id(request["sourceSha256"]), "blenderVersion": version, "collision": request["collision"],
        "importedParts": imported_rows, "reopenedParts": reopened_rows, "models": models, "renders": renders,
        "savedSceneReopened": True, "errors": [], "warnings": warnings}
    raw = audit.canonical(result)
    audit.require(len(raw) <= audit.JSON_BYTES, "IO")
    audit.write_new(directory / "conversion-audit.json", raw)
    print('ARCANE_RESULT {"audit":"conversion-audit.json"}', flush=True)


if __name__ == "__main__":
    try:
        run()
    except (Exception, SystemExit) as failure:
        reason = failure.reason if isinstance(failure, audit.ConversionFailure) else "IO_ACCESS" if isinstance(failure, OSError) else "NATIVE"
        print("ARCANE_FAILURE " + json.dumps({"stage": stage, "reason": reason,
            "type": "conversion-refused"}, separators=(",", ":")), flush=True)
        raise SystemExit(1) from None
