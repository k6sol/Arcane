"""Pipeline stage for the UV engine: which parts it unwraps, and the audit/Blender adapters.

Generators that author UVs deliberately (repeating bark tiles, rock region atlases, deadwood
bands, cutout leaf cards) keep them and are only measured. Every other natural-finish part is
unwrapped by ``uv_engine``: periodic surface profiles (stone, weathered, generic bark) in tile
mode at a shared world texel density, anything else as a packed unique atlas. Legacy (no finish)
requests never reach this stage, so their bytes are unchanged.
"""
import uv_engine
import uv_metrics

# World metres per repeat of the periodic surface profiles (textures.pattern), for tile mode.
TILE_METRES = {"stone": 1.6, "weathered": 1.6, "bark": .9, "leaf": .5}


def policy(kind, key, params, tiled_species=()):
    """('authored', intent) for deliberate generator UVs, else ('engine', mode)."""
    if key in ("leaves", "foliage"):
        return "authored", "atlas"
    if kind == "tree" and key == "bark":
        return ("authored", "tiled") if params.get("species") in tiled_species else ("engine", "tile")
    if kind in ("rock", "log", "stump"):
        return "authored", "tiled"
    if kind == "column":
        return "engine", "tile"
    return "engine", "atlas"


def finish_uvs(request, parts, surfaces, tiled_species=()):
    """Unwrap engine-owned parts in place and tag every part with its UV intent.

    ``parts`` are procedural.plan() tuples (key, colour key, MeshData); ``surfaces`` the
    procedural.surface_materials() entries (id, surface profile/resolution)."""
    params = request["procedural"]
    by_key = {s["id"].lower(): s["surface"] for s in surfaces}
    plans = []
    for key, _, mesh in parts:
        owner, how = policy(params["kind"], key, params, tiled_species)
        surface = by_key.get(key, {"profile": "weathered", "resolution": 256})
        plans.append((key, mesh, owner, how, surface))
    # One world texel density for every engine-tiled part (per-material density equalisation).
    tiled = [s for _, _, owner, how, s in plans if owner == "engine" and how == "tile"]
    ppm = min((s["resolution"] / TILE_METRES.get(s["profile"], 1.0) for s in tiled), default=None)
    for key, mesh, owner, how, surface in plans:
        size = surface["resolution"]
        if owner == "engine":
            if how == "tile":
                result = uv_engine.unwrap(mesh.vertices, mesh.faces, texture_size=size, mode="tile", tile_m=size / ppm)
            else:
                result = uv_engine.unwrap(mesh.vertices, mesh.faces, texture_size=size, mode="atlas")
            mesh.uvs = [tuple(p) for p in result["uvs"]]
            intent = "periodic" if how == "tile" else "unique"
        else:
            intent = how
        mesh.uv_report = {"intent": intent, "textureSize": size, "engine": owner == "engine"}
    return parts


# ------------------------------------------------------------------ Blender ---
def audit_quality(mesh, intent, texture_size):
    """uvQuality block for audit.py from a (triangulated, evaluated) Blender mesh."""
    vertices, faces, uvs = uv_metrics.blender_arrays(mesh)
    return uv_metrics.report(vertices, faces, uvs, intent, int(texture_size))


def _uv_name(mesh):
    """The active UV layer's name (created as "UVMap" when the mesh has none)."""
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    return mesh.uv_layers.active.name


def _get_uvs(mesh, name):
    flat = [0.0] * (2 * len(mesh.loops))
    mesh.uv_layers[name].data.foreach_get("uv", flat)
    return flat


def _set_uvs(mesh, name, flat):
    mesh.uv_layers[name].data.foreach_set("uv", flat)
    mesh.update()


def unwrap_blender_mesh(obj, mode="atlas", texture_size=512, pack="engine", tile_m=1.0):
    """Unwrap a Blender mesh object with the engine (labels = material slots). ``pack`` "blender"
    re-packs the engine charts with Blender's pack islands, "best" keeps whichever layout scores
    better (no errors first, then utilisation). Returns the uvQuality report of the kept layout.

    No Python reference to a mesh UV layer (or its data) is kept across an operator call: edit
    mode rebuilds the layers, and a stale reference held by a frame (an exception traceback, for
    one) crashes Blender when it is freed. UVs are read and written by layer name with
    foreach_get/foreach_set. Blender's packer needs the object in the view layer; otherwise, or if
    the operator fails, the engine layout is kept (with a ``packNote``)."""
    import bpy
    mesh = obj.data
    vertices = [tuple(v.co) for v in mesh.vertices]
    faces = [tuple(mesh.loops[i].vertex_index for i in p.loop_indices) for p in mesh.polygons]
    labels = [p.material_index for p in mesh.polygons]
    result = uv_engine.unwrap(vertices, faces, labels, texture_size=texture_size, mode=mode, tile_m=tile_m)
    name = _uv_name(mesh)
    flat = [c for pts in result["uvs"] for p in pts for c in (float(p[0]), float(p[1]))]
    _set_uvs(mesh, name, flat)
    intent = "unique" if mode == "atlas" else "periodic"
    # The asset audit (audit.py) measures and gates every object the engine unwrapped.
    obj["arcane_uv_intent"], obj["arcane_uv_texture"] = intent, int(texture_size)
    best = audit_quality(mesh, intent, texture_size)
    best["packer"] = "engine"
    if mode != "atlas" or pack == "engine":
        return best
    bpy.context.view_layer.update()  # sync newly linked collections into the view layer
    if obj.name not in bpy.context.view_layer.objects:
        best["packNote"] = "object is not in the view layer; engine packing kept"
        return best
    saved = _get_uvs(mesh, name)
    previous = bpy.context.view_layer.objects.active
    try:
        for o in bpy.context.selected_objects:
            o.select_set(False)
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.mode_set(mode="EDIT")
        try:
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.uv.select_all(action="SELECT")
            margin = uv_engine.padding_px(texture_size) / texture_size
            try:
                bpy.ops.uv.pack_islands(rotate=True, rotate_method="ANY", margin_method="FRACTION", margin=margin, shape_method="CONCAVE")
            except TypeError:  # older operator signature
                bpy.ops.uv.pack_islands(rotate=True, margin=margin)
        finally:
            bpy.ops.object.mode_set(mode="OBJECT")
    except RuntimeError as error:
        _set_uvs(obj.data, name, saved)
        best["packNote"] = "Blender pack failed (%s); engine packing kept" % str(error)[:80]
        return best
    finally:
        if previous is not None and previous.name in bpy.context.view_layer.objects:
            bpy.context.view_layer.objects.active = previous
    mesh = obj.data
    other = audit_quality(mesh, intent, texture_size)
    other["packer"] = "blender"
    better = (len(other["errors"]), -other.get("utilization", 0)) < (len(best["errors"]), -best.get("utilization", 0))
    if pack == "blender" or better:
        return other
    _set_uvs(mesh, name, saved)
    return best
