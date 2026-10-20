"""Blender adapters for the material library: write maps into a material, audit them back.

``write_material`` follows the shared texture contract of textures.author_surfaces /
surface_evidence (T_<Id>_BaseColor sRGB, T_<Id>_Normal and T_<Id>_MetallicRoughness Non-Color,
packed PNGs, REPEAT/Linear, bound to UV0 "UVMap"; G roughness, B metallic; a ROUND alpha clip
for MASK cutouts), so the existing glTF export, studio import and audit paths read it unchanged.
An optional T_<Id>_Emissive (sRGB) drives Emission Color. Library evidence (name, parameters,
measured metrics) is stored as ``arcane_material`` and re-measured from the packed images by
``audit_material`` (wired into audit.py).
"""
import json

ROLES = [("baseColor", "BaseColor", "sRGB"), ("normal", "Normal", "Non-Color"), ("metallicRoughness", "MetallicRoughness", "Non-Color")]


def _np():
    import numpy
    return numpy


def write_material(mat, result, directory, mid):
    """Bind library ``result`` maps to ``mat`` (its Principled BSDF) under image prefix T_<mid>_."""
    import bpy
    np = _np()
    ev = result["evidence"]
    maps = result["maps"]
    size = ev["resolution"]
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    shader = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
    uv = nodes.new("ShaderNodeUVMap")
    uv.name, uv.uv_map = "Arcane_UV0", "UVMap"
    textures = {}
    roles = ROLES + ([("emissive", "Emissive", "sRGB")] if "emissive" in maps else [])
    for role, suffix, space in roles:
        name = "T_" + mid + "_" + suffix
        old = bpy.data.images.get(name)
        if old is not None:
            bpy.data.images.remove(old)
        image = bpy.data.images.new(name, width=size, height=size, alpha=True)
        image.colorspace_settings.name = space
        image.pixels.foreach_set(maps[role].astype(np.float32).ravel())
        if directory is not None:
            image.filepath_raw = str(directory / (name + ".png"))
            image.file_format = "PNG"
            image.save()
        image.pack()
        tex = nodes.new("ShaderNodeTexImage")
        tex.name, tex.image, tex.extension, tex.interpolation = "Arcane_" + suffix, image, "REPEAT", "Linear"
        links.new(uv.outputs["UV"], tex.inputs["Vector"])
        textures[role] = tex
    links.new(textures["baseColor"].outputs["Color"], shader.inputs["Base Color"])
    if ev["alphaMode"] == "MASK":
        clip = nodes.new("ShaderNodeMath")
        clip.name, clip.operation = "Arcane_AlphaClip", "ROUND"
        links.new(textures["baseColor"].outputs["Alpha"], clip.inputs[0])
        links.new(clip.outputs["Value"], shader.inputs["Alpha"])
        mat.use_backface_culling = False
    channels = nodes.new("ShaderNodeSeparateColor")
    channels.name, channels.mode = "Arcane_MR_Channels", "RGB"
    links.new(textures["metallicRoughness"].outputs["Color"], channels.inputs["Color"])
    links.new(channels.outputs["Green"], shader.inputs["Roughness"])
    links.new(channels.outputs["Blue"], shader.inputs["Metallic"])
    nmap = nodes.new("ShaderNodeNormalMap")
    nmap.name, nmap.space, nmap.uv_map = "Arcane_TangentNormal", "TANGENT", "UVMap"
    nmap.inputs["Strength"].default_value = 1
    links.new(textures["normal"].outputs["Color"], nmap.inputs["Color"])
    links.new(nmap.outputs["Normal"], shader.inputs["Normal"])
    if "emissive" in textures:
        links.new(textures["emissive"].outputs["Color"], shader.inputs["Emission Color"])
        shader.inputs["Emission Strength"].default_value = float(ev["emissiveStrength"])
    mat["arcane_surface"] = json.dumps({"profile": ev["profile"], "resolution": size, "generator": "arcane-tile-v1", "texCoord": 0,
                                        "pattern": "library-" + ev["material"], "alphaMode": ev["alphaMode"]})
    mat["arcane_material"] = json.dumps(ev, sort_keys=True, separators=(",", ":"))
    mat.update_tag()
    return mat


def _pixels(np, image):
    w, h = image.size
    px = np.zeros(w * h * 4, dtype=np.float32)
    image.pixels.foreach_get(px)
    return px.reshape(h, w, 4)


def audit_material(mat):
    """Re-measure a library material from its packed images (mat_metrics); returns the metrics
    with ``errors`` and the stored evidence's name/mode."""
    import mat_metrics
    np = _np()
    ev = json.loads(mat["arcane_material"])
    nodes = mat.node_tree.nodes
    maps = {}
    for role, suffix, space in ROLES:
        node = nodes.get("Arcane_" + suffix)
        if node is None or node.image is None:
            return {"material": ev.get("material"), "errors": ["library material lost its " + suffix + " image"]}
        if node.image.colorspace_settings.name != space:
            return {"material": ev.get("material"), "errors": ["library " + suffix + " image colour space changed"]}
        maps[role] = _pixels(np, node.image)
    mask = None
    if ev.get("mode") == "bake":
        # Gutter texels are a flat fill; measure the covered texels only.
        n = maps["normal"]
        mask = ~((np.abs(n[..., 0] - .5) < 1e-3) & (np.abs(n[..., 1] - .5) < 1e-3) & (np.abs(n[..., 2] - 1) < 1e-3))
        if mask.sum() < 64:
            mask = None
    m = mat_metrics.measure(np, maps, ev.get("mode", "tile"), mask, ev.get("alphaMode", "OPAQUE"))
    m["material"] = ev.get("material")
    return m
