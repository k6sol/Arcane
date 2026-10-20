"""Original bounded tileable PBR images authored in the isolated Blender worker.
No source images, downloads, arbitrary nodes, object bakes or external libraries
(the natural tree patterns use the NumPy bundled with Blender).
The same UV0 tile can be shared safely by multiple independently unwrapped parts.
"""
import hashlib
import json
import math
import random

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


def author_surfaces(request, directory, objects, *, normal_relief=.035):
    # Trusted generator composition only; public recipes expose bounded profiles/resolutions.
    import bpy
    if isinstance(normal_relief, bool) or not isinstance(normal_relief, (int, float)) or not math.isfinite(normal_relief) or not .001 <= normal_relief <= .035:
        raise ValueError("Generated normal relief is outside its trusted bound")
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
        # Natural oak/birch only (procedural.surface_materials): species bark tiles and leaf atlases.
        pattern = data.get("pattern")
        if pattern is not None and (pattern not in TREE_PATTERNS or size != 512 or pattern.endswith("bark") != (profile == "bark")):
            raise ValueError("Unsupported natural tree pattern")
        cutout = pattern is not None and pattern.endswith("leaves")
        phases = [random.Random(seed + index).random() * math.tau for index in range(4)]
        pixels = {role: [] for role, _, _ in ROLES}
        step = 1 / (size - 1)
        if pattern is not None:
            pixels = tree_pixels(pattern, data["color"], data["metallic"], seed, size)
        for y in range(size if pattern is None else 0):
            v = (y % (size - 1)) * step
            for x in range(size):
                u = (x % (size - 1)) * step
                height, variation = pattern(profile, phases, u, v)
                dx = (pattern(profile, phases, u + step, v)[0] - pattern(profile, phases, u - step, v)[0]) / (2 * step)
                dy = (pattern(profile, phases, u, v + step)[0] - pattern(profile, phases, u, v - step)[0]) / (2 * step)
                nx, ny = -dx * normal_relief, -dy * normal_relief
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
        if cutout:
            # Alpha cutout: rounding the coverage exports as glTF alphaMode MASK (cutoff 0.5).
            clip = nodes.new("ShaderNodeMath"); clip.name, clip.operation = "Arcane_AlphaClip", "ROUND"
            links.new(textures["baseColor"].outputs["Alpha"], clip.inputs[0])
            links.new(clip.outputs["Value"], shader.inputs["Alpha"])
            mat.use_backface_culling = False
        channels = nodes.new("ShaderNodeSeparateColor"); channels.name, channels.mode = "Arcane_MR_Channels", "RGB"
        links.new(textures["metallicRoughness"].outputs["Color"], channels.inputs["Color"])
        links.new(channels.outputs["Green"], shader.inputs["Roughness"])
        links.new(channels.outputs["Blue"], shader.inputs["Metallic"])
        normal = nodes.new("ShaderNodeNormalMap"); normal.name, normal.space, normal.uv_map = "Arcane_TangentNormal", "TANGENT", "UVMap"
        normal.inputs["Strength"].default_value = 1
        links.new(textures["normal"].outputs["Color"], normal.inputs["Color"])
        links.new(normal.outputs["Normal"], shader.inputs["Normal"])
        evidence = {"profile": profile, "resolution": size, "generator": "arcane-tile-v1", "texCoord": 0}
        if pattern is not None:
            evidence.update(pattern=pattern, alphaMode="MASK" if cutout else "OPAQUE")
        mat["arcane_surface"] = json.dumps(evidence)
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
        if role == "baseColor" and result.get("alphaMode") == "MASK":
            clip = nodes.get("Arcane_AlphaClip")
            if clip is None or clip.operation != "ROUND" or not clip.inputs[0].is_linked or clip.inputs[0].links[0].from_node != node or not clip.outputs["Value"].is_linked:
                raise ValueError("Generated cutout material lost its alpha clip")
        if image is None or not image.packed_file or image.colorspace_settings.name != space or list(image.size) != [result["resolution"]] * 2:
            raise ValueError("Generated material packed image evidence changed")
        images.append({"role": role, "name": image.name, "width": image.size[0], "height": image.size[1], "colorSpace": space,
                       "sha256": hashlib.sha256(image.packed_file.data).hexdigest()})
    result["images"] = images
    return result


# ----------------------------------------------------- natural tree surfaces ---
# Species bark tiles and leaf-spray atlases for the natural-finish oak/birch (procedural.py).
# Pixel arrays only (NumPy, bundled with Blender); rows run bottom (v = 0) to top like
# bpy image pixels. Deterministic for the material seed; periodic where UVs repeat.
TREE_PATTERNS = ("oak-bark", "birch-bark", "oak-leaves", "birch-leaves")
# Physical size (around, along) in metres of one bark repeat; must match procedural.BARK_TILE.
BARK_SIZE = {"oak": (.42, 1.0), "birch": (.5, .6)}
# Birch strips (first row, rows) at 512 px; must match procedural.BIRCH_STRIPS.
BIRCH_ROWS = (("clean", 0, 256), ("patched", 256, 128), ("base", 384, 128))
# Leaf atlas tiles: 4 x 2 of 128 x 256 px at 512; must match procedural.ATLAS_* and MASS_TILE.
ATLAS = (4, 2)
MASS = (3, 1)


def _np():
    import numpy
    return numpy


def _value_noise(np, rng, u, v, cu, cv):
    """Periodic (period 1 in u and v) smooth value noise on a cu x cv lattice, in [0, 1]."""
    lattice = rng.random((cv, cu))
    x, y = u * cu, v * cv
    x0, y0 = np.floor(x), np.floor(y)
    fx, fy = x - x0, y - y0
    sx, sy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    i0, j0 = x0.astype(np.int64) % cu, y0.astype(np.int64) % cv
    i1, j1 = (i0 + 1) % cu, (j0 + 1) % cv
    a, b, c, d = lattice[j0, i0], lattice[j0, i1], lattice[j1, i0], lattice[j1, i1]
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy


def _fbm(np, rng, u, v, cu, cv, octaves, gain=.5):
    total, amplitude, weight = 0.0, 1.0, 0.0
    for octave in range(octaves):
        total = total + amplitude * _value_noise(np, rng, u, v, cu << octave, cv << octave)
        weight += amplitude
        amplitude *= gain
    return total / weight


def _smooth(np, a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _normals(np, height, dx, dy, periodic_rows=True):
    """Tangent-space (OpenGL, +Y = +v) normals from a periodic height field in metres."""
    gx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) / (2 * dx)
    gy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) / (2 * dy)
    length = np.sqrt(gx * gx + gy * gy + 1)
    return np.stack([-gx / length, -gy / length, 1 / length], axis=-1)


def _wrap(np, d):
    return d - np.round(d)


def _oak_bark(np, rng, color, size):
    """Furrowed oak: deep warped vertical furrows between corky ridges, broken into plates by
    staggered, partial cross cracks."""
    around, along = BARK_SIZE["oak"]
    x = (np.arange(size) + .5) / size
    u, v = np.meshgrid(x, x)
    columns = 9
    warp = (_fbm(np, rng, u, v, 3, 3, 3) - .5) * 2.2 + (_fbm(np, rng, u, v, 8, 6, 2) - .5) * .7
    w = columns * u + warp
    ridge_index = np.floor(w).astype(np.int64) % columns
    s = w - np.floor(w)
    edge = np.minimum(s, 1 - s)
    furrow = .12 + .2 * _fbm(np, rng, u, v, columns, 10, 2)
    plate = _smooth(np, .02, furrow + .04, edge)
    crown = np.clip(edge / .5, 0, 1)
    cracks = rng.integers(5, 11, columns)
    phase = rng.random(columns)
    position = cracks[ridge_index] * v + phase[ridge_index] + .35 * (_fbm(np, rng, u, v, 10, 6, 2) - .5)
    gate = _smooth(np, .35, .55, _value_noise(np, rng, u, v, columns * 2, 18))
    crack = (1 - _smooth(np, 0.0, .07, np.abs(_wrap(np, position)))) * gate
    plate = plate * (1 - .75 * crack)
    cell = (ridge_index * 31 + np.floor(position).astype(np.int64) * 7) % 97
    tone = (.82 + .3 * rng.random(97))[cell]
    grain = _fbm(np, rng, u, v, 20, 24, 3)
    fine = _value_noise(np, rng, u, v, 110, 90)
    height = plate * (.75 + .25 * crown) + .14 * grain * plate + .05 * fine
    metres = .025 * height
    normal = _normals(np, metres, around / size, along / size)
    base = np.array(color, dtype=np.float64)
    top = (base * .85 + np.array([.2, .19, .175]) * .5) * tone[..., None]
    deep = base * .16
    lit = np.clip(plate * (.7 + .3 * crown) + .15 * (grain - .5), 0, 1)[..., None]
    rgb = deep + (top - deep) * lit
    lichen = _smooth(np, .62, .72, _fbm(np, rng, u, v, 4, 6, 3))[..., None] * lit * .5
    rgb = rgb + (np.array([.28, .31, .24]) - rgb) * lichen
    rgb = rgb * (.85 + .3 * grain * (.6 + .4 * fine))[..., None]
    rough = .78 + .2 * (1 - lit[..., 0])
    return rgb, np.ones((size, size)), normal, rough


def _birch_strip(np, rng, color, size, name, rows):
    """One periodic birch strip (``rows`` px, period rows - 1 so its last row repeats its first).
    Clean: white papery bark with horizontal lenticels; patched: dark rugged patches on white;
    base: dark fissured bark with a few white remnants."""
    around, along = BARK_SIZE["birch"]
    period = rows - 1
    x = (np.arange(size) + .5) / size
    t = np.arange(period) / period
    u, v = np.meshgrid(x, t)
    white = np.array(color, dtype=np.float64)
    band = _fbm(np, rng, u, v, 3, 20, 3)
    streak = np.abs(np.sin(np.pi * (v * 40 + .8 * _fbm(np, rng, u, v, 3, 4, 2))))
    rgb = white * (.88 + .14 * band)[..., None]
    rgb = rgb * (1 - .06 * _smooth(np, .92, 1.0, streak))[..., None]
    warm = _smooth(np, .55, .75, _fbm(np, rng, u, v, 4, 5, 2))[..., None]
    rgb = rgb + (white * np.array([.97, .88, .76]) - rgb) * warm * .35
    height = .2 * band
    rough = .55 + .1 * band
    dark = np.zeros_like(u)
    count = {"clean": 85, "patched": 40, "base": 14}[name]
    for _ in range(count):
        cx, cy = rng.random(), rng.random()
        half = rng.uniform(.01, .055) * (1.8 if rng.random() < .15 else 1)
        thick = rng.uniform(.0035, .0075) / along
        du = _wrap(np, u - cx) / half
        dv = _wrap(np, v - cy - .02 * du * du * half) / thick
        mark = np.clip(1.6 * (1 - du * du - dv * dv), 0, 1) * rng.uniform(.6, 1)
        dark = np.maximum(dark, mark)
    if name != "clean":
        field = _fbm(np, rng, u, v, 4, 4, 4) + .14 * (_fbm(np, rng, u, v, 16, 14, 2) - .5)
        level = .6 if name == "patched" else .36
        patch = _smooth(np, level, level + .025, field)
        fissure = 1 - np.abs(2 * _fbm(np, rng, u, v, 14, 4, 3) - 1)
        rugged = fissure ** 1.5
        grey = np.array([.025, .023, .021]) + np.array([.14, .13, .12]) * rugged[..., None]
        rgb = rgb + (grey - rgb) * patch[..., None]
        height = height + patch * (.9 * rugged + .4)
        rough = rough + (.95 - rough) * patch
        dark = dark * (1 - patch)
    lenticel = np.array([.05, .04, .036])
    rgb = rgb + (lenticel - rgb) * dark[..., None]
    height = height + .3 * dark
    rough = rough + (.88 - rough) * dark
    metres = .008 * height
    normal = _normals(np, metres, around / size, along / period)
    cat = lambda a: np.concatenate([a, a[:1]], axis=0)
    return cat(rgb), cat(np.ones_like(u)), cat(normal), cat(rough)


def _birch_bark(np, rng, color, size):
    if size != 512:
        raise ValueError("Birch strips are laid out for 512 px")
    parts = [_birch_strip(np, rng, color, size, name, rows) for name, _, rows in BIRCH_ROWS]
    return tuple(np.concatenate([p[k] for p in parts], axis=0) for k in range(4))


def _leaf_shape(np, species, s, side, lobes):
    """Half-width (in leaf lengths) of an original leaf outline at midrib position s in [0, 1]."""
    if species == "oak":
        q = np.clip((s - .07) / .93, 0, 1)
        envelope = .3 * np.sin(np.pi * q) ** .7 * (.72 + .4 * q)
        lobe = .5 + .5 * np.abs(np.sin(np.pi * (lobes * q + np.where(side > 0, .15, .55)))) ** .55
        return np.where(s < .07, .014, envelope * lobe + .006)
    q = np.clip((s - .1) / .9, 0, 1)
    envelope = .78 * q ** .42 * (1 - q) ** 1.05
    teeth = 1 - .08 * np.sin(np.pi * 30 * q) ** 2
    return np.where(s < .1, .012, envelope * teeth + .004)


class _Canvas:
    def __init__(self, np, width, height):
        self.np = np
        self.rgb = np.zeros((height, width, 3))
        self.alpha = np.zeros((height, width))
        self.height = np.zeros((height, width))
        self.rough = np.full((height, width), .7)

    def put(self, y0, x0, alpha, rgb, height, rough):
        np = self.np
        h, w = alpha.shape
        ys, xs = slice(y0, y0 + h), slice(x0, x0 + w)
        a = alpha[..., None]
        # Leaves drawn earlier sink into shade under newer ones.
        self.rgb[ys, xs] = self.rgb[ys, xs] * (1 - a) + rgb * a
        self.height[ys, xs] = self.height[ys, xs] * (1 - alpha) + height * alpha
        self.rough[ys, xs] = self.rough[ys, xs] * (1 - alpha) + rough * alpha
        self.alpha[ys, xs] = np.maximum(self.alpha[ys, xs], alpha)

    def window(self, points, margin):
        np = self.np
        h, w = self.alpha.shape
        lo = np.floor(np.min(points, axis=0) - margin).astype(int)
        hi = np.ceil(np.max(points, axis=0) + margin).astype(int)
        x0, y0 = max(0, lo[0]), max(0, lo[1])
        x1, y1 = min(w, hi[0]), min(h, hi[1])
        if x1 <= x0 or y1 <= y0:
            return None
        X, Y = np.meshgrid(np.arange(x0, x1) + .5, np.arange(y0, y1) + .5)
        return x0, y0, X, Y

    def leaf(self, species, rng, base, angle, length, color):
        np = self.np
        direction = np.array([np.cos(angle), np.sin(angle)])
        normal = np.array([-direction[1], direction[0]])
        tip = base + direction * length
        found = self.window(np.array([base, tip]), length * .45)
        if found is None:
            return
        x0, y0, X, Y = found
        dx, dy = X - base[0], Y - base[1]
        s = (dx * direction[0] + dy * direction[1]) / length
        y = (dx * normal[0] + dy * normal[1]) / length
        half = _leaf_shape(np, species, s, y, rng.uniform(3.6, 4.6))
        alpha = np.clip((half - np.abs(y)) * length + .5, 0, 1) * np.clip(s * length + .5, 0, 1) * np.clip((1 - s) * length + .5, 0, 1)
        if not alpha.any():
            return
        span = np.maximum(half, 1e-3)
        across = np.clip(np.abs(y) / span, 0, 1)
        vein_count = 7 if species == "oak" else 9
        vein = _smooth(np, .82, .97, np.abs(np.cos(np.pi * vein_count * (s - .9 * np.abs(y)))))
        midrib = _smooth(np, .045, .0, np.abs(y)) * (s < .96)
        shade = rng.uniform(.72, 1.18)
        tint = np.array(color) * shade
        yellow = rng.uniform(0, .35)
        tint = tint + (tint * np.array([1.25, 1.15, .45]) - tint) * yellow
        rgb = np.broadcast_to(tint, alpha.shape + (3,)).copy()
        rgb *= (.86 + .2 * s)[..., None]
        rgb *= (1 - .18 * _smooth(np, .75, 1.0, across))[..., None]
        light = (midrib * .45 + vein * .16 * (1 - midrib))[..., None]
        rgb = rgb + (tint * np.array([1.45, 1.45, 1.05]) - rgb) * light
        # Fold along the midrib, sunken veins and a per-leaf tilt: varied normals across the spray.
        tilt = rng.uniform(-.5, .5, 2)
        height = .5 * across - .12 * vein - .2 * midrib + tilt[0] * s + tilt[1] * y / .3
        rough = .58 + .12 * across + .1 * rng.random()
        self.put(y0, x0, alpha, rgb, height * length * .2, rough)

    def twig(self, points, widths, color):
        np = self.np
        for (a, b), (wa, wb) in zip(zip(points, points[1:]), zip(widths, widths[1:])):
            found = self.window(np.array([a, b]), max(wa, wb) + 1)
            if found is None:
                continue
            x0, y0, X, Y = found
            ab = b - a
            t = np.clip(((X - a[0]) * ab[0] + (Y - a[1]) * ab[1]) / max(ab @ ab, 1e-9), 0, 1)
            d = np.hypot(X - (a[0] + ab[0] * t), Y - (a[1] + ab[1] * t))
            r = wa + (wb - wa) * t
            alpha = np.clip(r - d + .5, 0, 1)
            round_ = np.sqrt(np.clip(1 - (d / np.maximum(r, .5)) ** 2, 0, 1))
            rgb = np.array(color)[None, None, :] * (.6 + .5 * round_)[..., None]
            self.put(y0, x0, alpha, rgb, round_ * r * .05, np.full(alpha.shape, .85))


def _shoot(start, heading, length, steps, curve):
    points = [start]
    for k in range(1, steps):
        angle = heading + curve * k / steps
        last = points[-1]
        points.append((last[0] + math.cos(angle) * length / (steps - 1), last[1] + math.sin(angle) * length / (steps - 1)))
    return points


def _spray(np, rng, species, color, width, height, shade):
    """One original leaf spray: a branching shoot with species leaves, kept inside the tile."""
    canvas = _Canvas(np, width, height)
    leaf_color = np.array(color) * (np.array([.6, .66, .8]) if shade else 1.0)
    bark = np.array([.09, .065, .045]) if species == "oak" else np.array([.14, .06, .04])
    oak = species == "oak"
    main = _shoot((width * rng.uniform(.42, .58), 2.0), math.pi / 2 + rng.uniform(-.12, .12), height * (.62 if oak else .82), 14, rng.uniform(-.35, .35))
    shoots = [(main, 2.6 if oak else 1.7)]
    for k in range(2 if oak else 3):
        f = rng.uniform(.25, .6) if oak else rng.uniform(.2, .7)
        index = int(f * (len(main) - 1))
        side = 1 if k % 2 == 0 else -1
        if rng.random() < .5:
            side = -side
        heading = math.pi / 2 + side * rng.uniform(.45, .8)
        shoots.append((_shoot(main[index], heading, height * rng.uniform(.25, .36) * (1 if oak else 1.1), 8, -side * rng.uniform(.1, .4)), 1.6 if oak else 1.1))
    for points, w in shoots:
        canvas.twig([np.array(p) for p in points], [w * (1 - .55 * k / (len(points) - 1)) for k in range(len(points))], bark)
    leaves = []
    for number, (points, _) in enumerate(shoots):
        n = len(points) - 1
        scale = 1.0 if number == 0 else .85
        if oak:
            # Oak leaves crowd at shoot tips (a rosette) with a few along the shoot.
            for k in range(rng.integers(2, 4) if number else rng.integers(3, 5)):
                f = rng.uniform(.3, .8)
                leaves.append((points, f, (1 if k % 2 else -1) * rng.uniform(.6, 1.1), scale * rng.uniform(.18, .23)))
            for k in range(rng.integers(4, 6) if number == 0 else 3):
                leaves.append((points, 1.0, rng.uniform(-1.1, 1.1), scale * rng.uniform(.2, .27)))
        else:
            # Birch: alternate leaves along thin, slightly drooping shoots.
            count = rng.integers(8, 11) if number == 0 else rng.integers(4, 6)
            for k in range(count):
                f = .15 + .85 * k / max(1, count - 1)
                leaves.append((points, f, (1 if k % 2 else -1) * rng.uniform(.5, 1.15), scale * rng.uniform(.13, .17)))
    for i in sorted(range(len(leaves)), key=lambda i: rng.random()):
        points, f, swing, size = leaves[i]
        index = min(len(points) - 1, int(round(f * (len(points) - 1))))
        base = np.array(points[index])
        ahead = np.array(points[min(len(points) - 1, index + 1)]) - np.array(points[max(0, index - 1)])
        heading = math.atan2(ahead[1], ahead[0]) + swing
        length = size * height
        # Keep every leaf inside its tile: swing it towards its shoot, then shorten it.
        for _ in range(12):
            tip = base + length * np.array([math.cos(heading), math.sin(heading)])
            margin = length * .3
            if margin + 2 <= tip[0] <= width - margin - 2 and tip[1] <= height - margin - 2 and tip[1] >= 2:
                break
            heading -= swing * .2
            length *= .93
        canvas.leaf(species, rng, base, heading, length, leaf_color)
    return canvas


def _mass(np, rng, species, color, width, height):
    """Opaque packed-leaf tile for inner volumes: shaded leaves over a deep green ground."""
    canvas = _Canvas(np, width, height)
    canvas.rgb[:] = np.array(color) * .3
    canvas.alpha[:] = 1.0
    canvas.height[:] = 0.0
    leaf_color = np.array(color) * np.array([.55, .62, .78])
    for _ in range(70 if species == "oak" else 90):
        base = np.array([rng.uniform(-10, width + 10), rng.uniform(-10, height + 10)])
        canvas.leaf(species, rng, base, rng.uniform(0, 2 * np.pi), rng.uniform(.12, .2) * height, leaf_color)
    canvas.alpha[:] = 1.0
    return canvas


def _leaf_atlas(np, rng, species, color, size):
    if size != 512:
        raise ValueError("Leaf atlas tiles are laid out for 512 px")
    cols, rows = ATLAS
    tw, th = size // cols, size // rows
    rgb, alpha = np.zeros((size, size, 3)), np.zeros((size, size))
    height, rough = np.zeros((size, size)), np.full((size, size), .7)
    for row in range(rows):
        for col in range(cols):
            tile = _mass(np, rng, species, color, tw, th) if (col, row) == MASS else _spray(np, rng, species, color, tw, th, row == 1)
            covered = tile.alpha > .5
            # Transparent texels carry the tile's mean leaf colour so filtering never darkens edges.
            if not covered.all():
                fill = tile.rgb[covered].mean(axis=0) if covered.any() else np.array(color)
                tile.rgb[~covered] = fill
            ys, xs = slice(row * th, (row + 1) * th), slice(col * tw, (col + 1) * tw)
            rgb[ys, xs], alpha[ys, xs], height[ys, xs], rough[ys, xs] = tile.rgb, tile.alpha, tile.height, tile.rough
    normal = _normals(np, height, 1.0, 1.0)
    return rgb, alpha, normal, rough


def tree_surface(pattern, color, seed, size):
    """(linear rgb HxWx3, alpha HxW, normal HxWx3, roughness HxW) for a natural tree pattern."""
    np = _np()
    if pattern not in TREE_PATTERNS:
        raise ValueError("Unsupported natural tree pattern")
    rng = np.random.default_rng(seed)
    species, kind = pattern.split("-")
    if kind == "bark":
        return (_oak_bark if species == "oak" else _birch_bark)(np, rng, color, size)
    return _leaf_atlas(np, rng, species, color, size)


def tree_pixels(pattern, color, metallic, seed, size):
    """Flat float32 RGBA arrays (bpy pixel order) for the baseColor/normal/metallicRoughness roles.
    Base colour alpha is leaf coverage for the atlases and exactly 1 for bark."""
    np = _np()
    rgb, alpha, normal, rough = tree_surface(pattern, color, seed, size)
    rgb = np.clip(rgb, 0, 1)
    encoded = np.where(rgb <= .0031308, 12.92 * rgb, 1.055 * np.power(rgb, 1 / 2.4) - .055)
    ones = np.ones(alpha.shape)
    base = np.dstack([encoded, np.clip(alpha, 0, 1)])
    normal_px = np.dstack([normal * .5 + .5, ones])
    mr = np.dstack([ones, np.clip(rough, 0, 1), np.full(alpha.shape, clamp(metallic)), ones])
    return {role: values.astype(np.float32).ravel() for role, values in (("baseColor", base), ("normal", normal_px), ("metallicRoughness", mr))}
