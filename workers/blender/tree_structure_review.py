"""Same-job natural-tree structure review; never builds or replaces source geometry.

The sheet is human review evidence, not an artistic verdict or import approval.
Blender imports are confined to the rendering boundary so the identity, framing
and restoration rules can also be exercised with explicit controlled doubles.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import struct
import tempfile


PATH = "preview-structure.png"
VIEWS = ("front", "side", "oblique", "roots")


def natural_tree(request):
    params = request.get("procedural", {})
    return request.get("template") == "procedural" and params.get("kind") == "tree" and params.get("finish") == "natural"


def original_tree_objects(request, objects, semantic_id):
    expected = {"bark"} if request["procedural"]["leafDensity"] == 0 else {"bark", "leaves"}
    found = {}
    for obj in objects:
        key = obj.get("arcane_source_key")
        if (obj.type != "MESH" or obj.get("arcane_role") != "render" or key not in expected or key in found
                or obj.get("arcane_identity_scheme") != "arcane-semantic-v1"
                or obj.get("arcane_source_object_id") != semantic_id(request, "render", key)):
            raise ValueError("Tree structure source identity changed")
        found[key] = obj
    if set(found) != expected or len({obj.as_pointer() for obj in found.values()}) != len(expected):
        raise ValueError("Tree structure source identity changed")
    return found


def _digest(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def enrich_tree_meshes(request, objects, meshes, semantic_id, depsgraph):
    """Use audit.py's existing canonical geometry domain on the actual evaluated meshes."""
    render = [obj for obj in objects if obj.get("arcane_role") == "render"]
    sources = original_tree_objects(request, render, semantic_id)
    for obj in sources.values():
        rows = [row for row in meshes if row["name"] == obj.name and row["role"] == "render"]
        if len(rows) != 1:
            raise ValueError("Tree structure source audit changed")
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            mesh.calc_loop_triangles()
            geometry = {"vertices": [[round(float(c), 6) for c in v.co] for v in mesh.vertices],
                        "triangles": [list(t.vertices) for t in mesh.loop_triangles]}
            rows[0]["geometrySha256"] = _digest(geometry)
        finally:
            evaluated.to_mesh_clear()
    return sources


def structure_metadata(request, objects, meshes, request_sha256, semantic_id):
    sources = original_tree_objects(request, objects, semantic_id)
    bark = sources["bark"]
    rows = [row for row in meshes if row["name"] == bark.name and row["role"] == "render"]
    digest = rows[0].get("geometrySha256") if len(rows) == 1 else None
    if (not isinstance(request_sha256, str) or len(request_sha256) != 64 or any(c not in "0123456789abcdef" for c in request_sha256)
            or not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest)):
        raise ValueError("Tree structure source audit changed")
    return {"schemaVersion": 1, "path": PATH, "requestSha256": request_sha256,
            "sourceObjects": [{"sourceKey": "bark", "sourceObjectId": bark["arcane_source_object_id"], "geometrySha256": digest}],
            "views": list(VIEWS)}


def retained_structure(directory, request_sha256):
    """Old audits keep their exact rows; malformed new markers never become legacy."""
    path = directory / "audit.json"
    with path.open("rb") as stream:
        raw = stream.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError("Tree structure retained audit exceeded")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Tree structure retained audit changed")
            result[key] = value
        return result

    audit = json.loads(raw, object_pairs_hook=unique)
    if not isinstance(audit, dict):
        raise ValueError("Tree structure retained audit changed")
    if "treeStructure" not in audit:
        return None
    marker = audit["treeStructure"]
    if (not isinstance(marker, dict) or set(marker) != {"schemaVersion", "path", "requestSha256", "sourceObjects", "views"}
            or type(marker["schemaVersion"]) is not int or marker["schemaVersion"] != 1 or marker["path"] != PATH
            or marker["requestSha256"] != request_sha256 or marker["views"] != list(VIEWS)
            or not isinstance(marker["sourceObjects"], list) or len(marker["sourceObjects"]) != 1):
        raise ValueError("Tree structure retained audit changed")
    source = marker["sourceObjects"][0]
    if (not isinstance(source, dict) or set(source) != {"sourceKey", "sourceObjectId", "geometrySha256"}
            or source["sourceKey"] != "bark" or not isinstance(source["sourceObjectId"], str)
            or not isinstance(source["geometrySha256"], str) or len(source["geometrySha256"]) != 64
            or any(c not in "0123456789abcdef" for c in source["geometrySha256"])):
        raise ValueError("Tree structure retained audit changed")
    return marker


def _values(value):
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Tree structure source is nonfinite")
        return value
    return [_values(item) for item in value]


def _material_state(mat):
    if mat is None:
        return None
    nodes = []
    for node in mat.node_tree.nodes:
        properties = {}
        for prop in node.bl_rna.properties:
            if not prop.is_readonly and prop.type in {"BOOLEAN", "INT", "FLOAT", "STRING", "ENUM"}:
                properties[prop.identifier] = _values(getattr(node, prop.identifier))
        image = getattr(node, "image", None)
        packed = image.packed_file if image else None
        nodes.append({"name": node.name, "type": node.type, "properties": properties,
                      "inputs": [(socket.identifier, _values(socket.default_value)) for socket in node.inputs if hasattr(socket, "default_value")],
                      "image": None if image is None else [image.as_pointer(), image.name, list(image.size), image.colorspace_settings.name,
                          image.is_dirty, hashlib.sha256(packed.data).hexdigest() if packed else None]})
    return {"pointer": mat.as_pointer(), "name": mat.name, "diffuse": list(mat.diffuse_color),
            "useNodes": mat.use_nodes, "backface": mat.use_backface_culling,
            "nodes": nodes, "links": [(link.from_node.name, link.from_socket.identifier, link.to_node.name, link.to_socket.identifier) for link in mat.node_tree.links]}


def exact_source_fingerprint(objects, depsgraph):
    """Private full-precision geometry/UV/material snapshot; no rounded audit equivalence."""
    result = []
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            result.append({"object": obj.as_pointer(), "data": obj.data.as_pointer(), "name": obj.name,
                           "identity": [obj.get(key) for key in ("arcane_role", "arcane_source_key", "arcane_source_object_id", "arcane_identity_scheme")],
                           "world": [list(row) for row in obj.matrix_world],
                           "vertices": [[list(v.co), list(v.normal)] for v in mesh.vertices],
                           "faces": [[list(p.vertices), p.material_index, p.use_smooth] for p in mesh.polygons],
                           "normals": [list(n.vector) for n in mesh.corner_normals],
                           "uv": [[layer.name, [list(value.uv) for value in layer.data]] for layer in mesh.uv_layers],
                           "materials": [_material_state(mat) for mat in mesh.materials]})
        finally:
            evaluated.to_mesh_clear()
    return _digest(result)


def sheet_layout(resolution):
    if type(resolution) is not int or not 128 <= resolution <= 1024:
        raise ValueError("Tree structure render resolution changed")
    half = resolution // 2
    # Blender pixels run bottom-up. Preserve every pixel for odd valid resolutions too.
    return [("front", 0, half, half, resolution - half), ("side", half, half, resolution - half, resolution - half),
            ("oblique", 0, 0, half, half), ("roots", half, 0, resolution - half, half)]


def view_plan(points, name, width, height):
    if name not in VIEWS or not points or any(len(p) != 3 or not all(math.isfinite(c) for c in p) for p in points):
        raise ValueError("Tree structure bounds changed")
    low = [min(p[k] for p in points) for k in range(3)]
    high = [max(p[k] for p in points) for k in range(3)]
    span = max(high[k] - low[k] for k in range(3))
    if span <= 1e-6:
        raise ValueError("Tree structure bounds changed")
    selected = [p for p in points if p[2] <= low[2] + .55 * (high[2] - low[2])] if name == "roots" else points
    direction = {"front": (0, -1, .08), "side": (1, 0, .08), "oblique": (1, -1, .35), "roots": (0, -1, .12)}[name]
    length = math.sqrt(sum(c * c for c in direction))
    direction = [c / length for c in direction]
    right = [-direction[1], direction[0], 0]
    length = math.sqrt(sum(c * c for c in right))
    right = [c / length for c in right]
    up = [-direction[2] * right[1], direction[2] * right[0], direction[0] * right[1] - direction[1] * right[0]]
    axes = (right, up, direction)
    ranges = [(min(sum(p[k] * axis[k] for k in range(3)) for p in selected),
               max(sum(p[k] * axis[k] for k in range(3)) for p in selected)) for axis in axes]
    centre = [sum((low + high) * .5 * axis[k] for (low, high), axis in zip(ranges, axes)) for k in range(3)]
    extents = [max(sum(p[k] * axis[k] for k in range(3)) for p in selected) - min(sum(p[k] * axis[k] for k in range(3)) for p in selected) for axis in (right, up)]
    aspect = width / height
    scale = max(*extents, 1e-3) * 1.2 * max(aspect, 1 / aspect)
    return {"target": centre, "location": [centre[k] + direction[k] * max(span * 4, 1) for k in range(3)],
            "scale": scale, "clipStart": .001, "clipEnd": max(span * 20, 10)}


def _owned_exr(path, original):
    current = path.lstat()
    if (not stat.S_ISREG(current.st_mode) or current.st_nlink != 1
            or (current.st_dev, current.st_ino) != (original.st_dev, original.st_ino)):
        raise ValueError("Tree structure temporary image ownership changed")
    return current


def _check_exr(path, original, width, height):
    """Bound the owned float RGBA carrier before Blender allocates decoded pixels."""
    current = _owned_exr(path, original)
    if not 1 <= width <= 1024 or not 1 <= height <= 1024 or not 8 < current.st_size <= width * height * 16 + 256 * 1024:
        raise ValueError("Tree structure temporary image exceeded")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_size) != (current.st_dev, current.st_ino, current.st_size):
            raise ValueError("Tree structure temporary image ownership changed")
        raw = stream.read(64 * 1024 + 1)
    if len(raw) < 9 or struct.unpack_from('<I', raw)[0] != 20000630 or struct.unpack_from('<I', raw, 4)[0] not in (2, 2 | 0x400):
        raise ValueError("Tree structure temporary image format changed")
    cursor, attributes = 8, {}

    def name():
        nonlocal cursor
        end = raw.find(b'\0', cursor, min(len(raw), cursor + 256))
        if end < 0:
            raise ValueError("Tree structure temporary image header changed")
        value, cursor = raw[cursor:end], end + 1
        return value

    while True:
        key = name()
        if not key:
            break
        kind = name()
        if not kind or key in attributes or len(attributes) >= 128 or cursor + 4 > len(raw):
            raise ValueError("Tree structure temporary image header changed")
        size = struct.unpack_from('<i', raw, cursor)[0]
        cursor += 4
        if size < 0 or cursor + size > min(len(raw), 64 * 1024):
            raise ValueError("Tree structure temporary image header exceeded")
        attributes[key] = (kind, raw[cursor:cursor + size])
        cursor += size
    window = struct.pack('<iiii', 0, 0, width - 1, height - 1)
    if (attributes.get(b'dataWindow') != (b'box2i', window) or attributes.get(b'displayWindow') != (b'box2i', window)
            or attributes.get(b'compression') != (b'compression', b'\0')):
        raise ValueError("Tree structure temporary image dimensions changed")
    kind, channels = attributes.get(b'channels', (None, b''))
    found, offset = set(), 0
    while offset < len(channels) and channels[offset] != 0:
        end = channels.find(b'\0', offset, min(len(channels), offset + 256))
        if end < 0 or end + 17 > len(channels):
            raise ValueError("Tree structure temporary image channels changed")
        channel = channels[offset:end]
        pixel_type, _, reserved, x_sampling, y_sampling = struct.unpack_from('<iB3sii', channels, end + 1)
        if channel not in {b'R', b'G', b'B', b'A'} or channel in found or pixel_type != 2 or reserved != b'\0\0\0' or x_sampling != 1 or y_sampling != 1:
            raise ValueError("Tree structure temporary image channels changed")
        found.add(channel)
        offset = end + 17
    if kind != b'chlist' or found != {b'R', b'G', b'B', b'A'} or channels[offset:] != b'\0':
        raise ValueError("Tree structure temporary image channels changed")
    return current


def _scene_linear_pixels(bpy, directory, width, height):
    """Render Result pixels can be empty in background Blender; use one owned EXR."""
    scene = bpy.context.scene
    settings = scene.render.image_settings
    fields = ("file_format", "color_mode", "color_depth", "exr_codec")
    original_settings = tuple(getattr(settings, field) for field in fields)
    path, descriptor, original, image = None, None, None, None
    try:
        descriptor, filename = tempfile.mkstemp(prefix=".tree-structure-", suffix=".exr", dir=directory)
        path = Path(filename)
        original = os.fstat(descriptor)
        os.close(descriptor)
        descriptor = None
        _owned_exr(path, original)
        settings.file_format, settings.color_mode, settings.color_depth, settings.exr_codec = 'OPEN_EXR', 'RGBA', '32', 'NONE'
        result = bpy.data.images.get("Render Result")
        if result is None:
            raise ValueError("Tree structure render result missing")
        result.save_render(str(path), scene=scene)
        saved = _check_exr(path, original, width, height)
        image = bpy.data.images.load(str(path), check_existing=False)
        current = _owned_exr(path, original)
        if (current.st_size, current.st_mtime_ns) != (saved.st_size, saved.st_mtime_ns):
            raise ValueError("Tree structure temporary image ownership changed")
        if tuple(image.size) != (width, height) or image.channels != 4 or not image.is_float or len(image.pixels) != width * height * 4:
            raise ValueError("Tree structure render dimensions changed")
        return image.pixels[:]
    finally:
        failures = []

        def attempt(action):
            try:
                action()
            except BaseException as error:
                failures.append(error)

        if descriptor is not None:
            attempt(lambda: os.close(descriptor))
        if image is not None:
            attempt(lambda: bpy.data.images.remove(image))
        for field, value in zip(fields, original_settings):
            attempt(lambda field=field, value=value: setattr(settings, field, value))
        if path is not None:
            def remove():
                try:
                    if original is None:
                        raise ValueError("Tree structure temporary image ownership unavailable")
                    _owned_exr(path, original)
                except FileNotFoundError:
                    return
                path.unlink()
            attempt(remove)
        if failures:
            raise ValueError("Tree structure temporary image cleanup failed") from failures[0]
        if tuple(getattr(settings, field) for field in fields) != original_settings:
            raise ValueError("Tree structure temporary image settings restoration failed")


def _render_tile(bpy, directory, camera, plan, width, height):
    from mathutils import Vector
    import numpy as np
    scene = bpy.context.scene
    camera.location = plan["location"]
    camera.rotation_euler = (Vector(plan["target"]) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type, camera.data.ortho_scale = 'ORTHO', plan["scale"]
    camera.data.clip_start, camera.data.clip_end = plan["clipStart"], plan["clipEnd"]
    scene.render.resolution_x, scene.render.resolution_y = width, height
    bpy.context.view_layer.update()
    bpy.ops.render.render(write_still=False)
    pixels = np.array(_scene_linear_pixels(bpy, directory, width, height), dtype=np.float32).reshape(height, width, 4)
    luminance = pixels[..., 0] * .2126 + pixels[..., 1] * .7152 + pixels[..., 2] * .0722
    if not np.isfinite(pixels).all() or float(luminance.max() - luminance.min()) < .05 or float(luminance.std()) < .005:
        raise ValueError("Review render is empty, uniform or nonfinite")
    return pixels


def _render_sheet(bpy, directory, camera, points, resolution):
    import numpy as np
    out = None
    try:
        sheet = np.zeros((resolution, resolution, 4), dtype=np.float32)
        for name, x, y, width, height in sheet_layout(resolution):
            sheet[y:y + height, x:x + width] = _render_tile(bpy, directory, camera, view_plan(points, name, width, height), width, height)
        half = resolution // 2
        sheet[half - 1:half + 1, :, :3] = .3
        sheet[:, half - 1:half + 1, :3] = .3
        sheet[..., 3] = 1
        out = bpy.data.images.new("ArcaneTreeStructure", width=resolution, height=resolution, alpha=True, float_buffer=True)
        out.pixels.foreach_set(sheet.ravel())
        out.save_render(str(directory / PATH), scene=bpy.context.scene)
    finally:
        if out is not None:
            bpy.data.images.remove(out)


def render_tree_structure(bpy, request, directory, camera, objects, meshes, request_sha256, semantic_id, render_metrics):
    scene, layer = bpy.context.scene, bpy.context.view_layer
    sources = original_tree_objects(request, objects, semantic_id)
    metadata = structure_metadata(request, objects, meshes, request_sha256, semantic_id)
    if scene.camera != camera or camera.parent is not None or camera.rotation_mode != 'XYZ' or layer.material_override is not None:
        raise ValueError("Tree structure review camera changed")
    depsgraph = bpy.context.evaluated_depsgraph_get()
    before = exact_source_fingerprint(objects, depsgraph)
    evaluated = sources["bark"].evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        points = [tuple(sources["bark"].matrix_world @ vertex.co) for vertex in mesh.vertices]
    finally:
        evaluated.to_mesh_clear()
    render, settings = scene.render, scene.render.image_settings
    state = {"camera": scene.camera, "location": tuple(camera.location), "rotation": tuple(camera.rotation_euler),
             "cameraData": (camera.data.type, camera.data.ortho_scale, camera.data.clip_start, camera.data.clip_end),
             "render": (render.resolution_x, render.resolution_y, render.resolution_percentage, render.pixel_aspect_x, render.pixel_aspect_y),
             "settings": (settings.file_format, settings.color_mode, settings.color_depth, settings.exr_codec),
             "hidden": [(obj, obj.hide_render) for obj in scene.objects]}
    try:
        for obj, _ in state["hidden"]:
            if obj.type == "MESH" and obj != sources["bark"] and obj.get("arcane_role") != "preview":
                obj.hide_render = True
        sources["bark"].hide_render = False
        render.resolution_percentage, render.pixel_aspect_x, render.pixel_aspect_y = 100, 1, 1
        settings.file_format, settings.color_mode, settings.color_depth = 'PNG', 'RGBA', '8'
        _render_sheet(bpy, directory, camera, points, request["renderResolution"])
    finally:
        failed = []

        def attempt(action):
            try:
                action()
            except BaseException as error:
                failed.append(error)

        for obj, hidden in state["hidden"]:
            attempt(lambda obj=obj, hidden=hidden: setattr(obj, "hide_render", hidden))
        attempt(lambda: setattr(scene, "camera", state["camera"]))
        attempt(lambda: setattr(camera, "location", state["location"]))
        attempt(lambda: setattr(camera, "rotation_euler", state["rotation"]))
        for name, value in zip(("type", "ortho_scale", "clip_start", "clip_end"), state["cameraData"]):
            attempt(lambda name=name, value=value: setattr(camera.data, name, value))
        for name, value in zip(("resolution_x", "resolution_y", "resolution_percentage", "pixel_aspect_x", "pixel_aspect_y"), state["render"]):
            attempt(lambda name=name, value=value: setattr(render, name, value))
        for name, value in zip(("file_format", "color_mode", "color_depth", "exr_codec"), state["settings"]):
            attempt(lambda name=name, value=value: setattr(settings, name, value))
        attempt(layer.update)
        if failed:
            raise ValueError("Tree structure review state restoration failed") from failed[0]
        if (scene.camera != state["camera"] or tuple(camera.location) != state["location"] or tuple(camera.rotation_euler) != state["rotation"]
                or tuple(getattr(camera.data, name) for name in ("type", "ortho_scale", "clip_start", "clip_end")) != state["cameraData"]
                or tuple(getattr(render, name) for name in ("resolution_x", "resolution_y", "resolution_percentage", "pixel_aspect_x", "pixel_aspect_y")) != state["render"]
                or tuple(getattr(settings, name) for name in ("file_format", "color_mode", "color_depth", "exr_codec")) != state["settings"]
                or any(obj.hide_render != hidden for obj, hidden in state["hidden"])
                or exact_source_fingerprint(objects, bpy.context.evaluated_depsgraph_get()) != before):
            raise ValueError("Tree structure review state restoration failed")
    metrics = render_metrics(directory / PATH)
    if metrics["path"] != PATH or metrics["width"] != request["renderResolution"] or metrics["height"] != request["renderResolution"]:
        raise ValueError("Tree structure render dimensions changed")
    return metrics, metadata
