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


def unwrap_blender_mesh(obj, mode="atlas", texture_size=512, pack="engine", tile_m=1.0):
    """Unwrap a Blender mesh object with the engine (labels = material slots). ``pack`` "blender"
    re-packs the engine charts with Blender's pack islands, "best" keeps whichever layout scores
    better (no errors first, then utilisation). Returns the uvQuality report of the kept layout."""
    import bpy
    mesh = obj.data
    vertices = [tuple(v.co) for v in mesh.vertices]
    faces = [tuple(mesh.loops[i].vertex_index for i in p.loop_indices) for p in mesh.polygons]
    labels = [p.material_index for p in mesh.polygons]
    result = uv_engine.unwrap(vertices, faces, labels, texture_size=texture_size, mode=mode, tile_m=tile_m)
    layer = mesh.uv_layers.active or mesh.uv_layers.new(name="UVMap")
    for poly, pts in zip(mesh.polygons, result["uvs"]):
        for loop, point in zip(poly.loop_indices, pts):
            layer.data[loop].uv = point
    intent = "unique" if mode == "atlas" else "periodic"
    # The asset audit (audit.py) measures and gates every object the engine unwrapped.
    obj["arcane_uv_intent"], obj["arcane_uv_texture"] = intent, int(texture_size)
    best = audit_quality(mesh, intent, texture_size)
    best["packer"] = "engine"
    if mode != "atlas" or pack == "engine":
        return best
    saved = [tuple(d.uv) for d in layer.data]
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.select_all(action="SELECT")
    margin = uv_engine.padding_px(texture_size) / texture_size
    try:
        bpy.ops.uv.pack_islands(rotate=True, rotate_method="ANY", margin_method="FRACTION", margin=margin, shape_method="CONCAVE")
    except TypeError:  # older operator signature
        bpy.ops.uv.pack_islands(rotate=True, margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")
    other = audit_quality(mesh, intent, texture_size)
    other["packer"] = "blender"
    better = (len(other["errors"]), -other.get("utilization", 0)) < (len(best["errors"]), -best.get("utilization", 0))
    if pack == "blender" or better:
        return other
    # Edit mode rebuilt the mesh layers: the old layer reference is stale, fetch it again.
    layer = mesh.uv_layers.active
    for d, uv in zip(layer.data, saved):
        d.uv = uv
    return best
