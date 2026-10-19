"""Original bounded tileable PBR images authored in the isolated Blender worker.
No source images, downloads, arbitrary nodes, object bakes or external libraries.
The same UV0 tile can be shared safely by multiple independently unwrapped parts.
"""
import hashlib
import json
import math
import random
import bpy

ROLES = [("baseColor", "BaseColor", "sRGB"), ("normal", "Normal", "Non-Color"),
         ("metallicRoughness", "MetallicRoughness", "Non-Color")]


def clamp(value):
    return max(0.0, min(1.0, value))


def srgb(value):
    return 12.92 * value if value <= .0031308 else 1.055 * value ** (1 / 2.4) - .055


def pattern(profile, phases, u, v):
    tau = math.tau
    # Integer UV frequencies make every component periodic in both directions.
    fine = (math.sin(tau * (13 * u + 9 * v) + phases[0]) + math.sin(tau * (7 * u - 11 * v) + phases[1])) * .25 + .5
    broad = (math.sin(tau * (3 * u + 2 * v) + phases[2]) + math.cos(tau * (5 * u - 3 * v) + phases[3])) * .25 + .5
    if profile == "bark":
        groove = .5 + .5 * math.sin(tau * (9 * u + .18 * math.sin(tau * 2 * v)) + phases[0])
        height = .65 * groove ** .45 + .2 * broad + .15 * fine
    elif profile == "leaf":
        vein = max(0, math.cos(tau * (u + .07 * math.sin(tau * v)))) ** 26
        branches = max(0, math.cos(tau * (5 * v + 3 * u))) ** 18
        height = .48 + .22 * vein + .14 * branches + .16 * broad
    elif profile == "stone":
        height = .45 * broad + .3 * fine + .25 * abs(math.sin(tau * (4 * u + 5 * v) + phases[1]))
    else:
        chips = max(0, .5 + .5 * math.sin(tau * (6 * u + 5 * v) + phases[2])) ** 5
        height = .45 * broad + .25 * fine + .3 * chips
    return height, clamp(.6 * height + .25 * broad + .15 * fine)


def author_surfaces(request, directory, objects):
    for obj in objects:
        if not obj.data.uv_layers or len(obj.data.uv_layers) != 1:
            raise ValueError("Textured parts require exactly one generated UV layer")
        obj.data.uv_layers[0].name = "UVMap"
    for data in request["recipe"]["materials"]:
        surface = data.get("surface")
        if not surface:
            continue
        profile, size = surface["profile"], surface["resolution"]
        if profile not in ["bark", "stone", "leaf", "weathered"] or size not in [128, 256, 512]:
            raise ValueError("Unsupported bounded texture profile")
        seed = int.from_bytes(hashlib.sha256((str(request["seed"]) + ":" + data["id"]).encode()).digest()[:8], "big")
        phases = [random.Random(seed + index).random() * math.tau for index in range(4)]
        pixels = {role: [] for role, _, _ in ROLES}
        step = 1 / (size - 1)
        for y in range(size):
            v = (y % (size - 1)) * step
            for x in range(size):
                u = (x % (size - 1)) * step
                height, variation = pattern(profile, phases, u, v)
                dx = (pattern(profile, phases, u + step, v)[0] - pattern(profile, phases, u - step, v)[0]) / (2 * step)
                dy = (pattern(profile, phases, u, v + step)[0] - pattern(profile, phases, u, v - step)[0]) / (2 * step)
                nx, ny = -dx * .035, -dy * .035
                length = math.sqrt(nx * nx + ny * ny + 1)
                pixels["baseColor"].extend([srgb(clamp(channel * (.65 + .5 * variation))) for channel in data["color"]] + [1])
                pixels["normal"].extend([nx / length * .5 + .5, ny / length * .5 + .5, .5 / length + .5, 1])
                pixels["metallicRoughness"].extend([1, clamp(data["roughness"] * (.72 + .28 * variation)), clamp(data["metallic"] * (.7 + .3 * height)), 1])
        mat = bpy.data.materials["MAT_" + data["id"]]
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        shader = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
        uv = nodes.new("ShaderNodeUVMap"); uv.name, uv.uv_map = "Arcane_UV0", "UVMap"
        textures = {}
        for role, suffix, space in ROLES:
            name = "T_" + data["id"] + "_" + suffix
            image = bpy.data.images.new(name, width=size, height=size, alpha=True)
            image.colorspace_settings.name = space
            image.pixels.foreach_set(pixels[role])
            image.filepath_raw = str(directory / ".worker" / (name + ".png"))
            image.file_format = "PNG"
            image.save(); image.pack()
            texture = nodes.new("ShaderNodeTexImage")
            texture.name, texture.image, texture.extension, texture.interpolation = "Arcane_" + suffix, image, "REPEAT", "Linear"
            links.new(uv.outputs["UV"], texture.inputs["Vector"])
            textures[role] = texture
        links.new(textures["baseColor"].outputs["Color"], shader.inputs["Base Color"])
        channels = nodes.new("ShaderNodeSeparateColor"); channels.name, channels.mode = "Arcane_MR_Channels", "RGB"
        links.new(textures["metallicRoughness"].outputs["Color"], channels.inputs["Color"])
        links.new(channels.outputs["Green"], shader.inputs["Roughness"])
        links.new(channels.outputs["Blue"], shader.inputs["Metallic"])
        normal = nodes.new("ShaderNodeNormalMap"); normal.name, normal.space, normal.uv_map = "Arcane_TangentNormal", "TANGENT", "UVMap"
        normal.inputs["Strength"].default_value = 1
        links.new(textures["normal"].outputs["Color"], normal.inputs["Color"])
        links.new(normal.outputs["Normal"], shader.inputs["Normal"])
        mat["arcane_surface"] = json.dumps({"profile": profile, "resolution": size, "generator": "arcane-tile-v1", "texCoord": 0})
        # Custom ID evidence must reach the evaluated material used by mesh audits.
        mat.update_tag()


def surface_evidence(mat):
    result = json.loads(mat["arcane_surface"])
    nodes = mat.node_tree.nodes
    uv = nodes.get("Arcane_UV0")
    if uv is None or uv.uv_map != "UVMap":
        raise ValueError("Generated material lost its explicit UV0 binding")
    images = []
    for role, suffix, space in ROLES:
        node = nodes.get("Arcane_" + suffix)
        if node is None or node.extension != "REPEAT" or node.interpolation != "Linear" or not node.inputs["Vector"].is_linked or node.inputs["Vector"].links[0].from_node != uv:
            raise ValueError("Generated material texture mapping changed")
        image = node.image
        if image is None or not image.packed_file or image.colorspace_settings.name != space or list(image.size) != [result["resolution"]] * 2:
            raise ValueError("Generated material packed image evidence changed")
        images.append({"role": role, "name": image.name, "width": image.size[0], "height": image.size[1], "colorSpace": space,
                       "sha256": hashlib.sha256(image.packed_file.data).hexdigest()})
    result["images"] = images
    return result
