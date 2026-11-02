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


tile_pattern = pattern


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
        leaf_scale = _checked_leaf_scale(data.get("pattern"), data.get("leaf_scale", 1.0))
        if data.get("library"):
            # New requests only: a named library material (materials/mat_library) as a tile.
            library_surface(request, directory, data)
            continue
        surface = data.get("surface")
        if not surface:
            continue
        profile, size = surface["profile"], surface["resolution"]
        if profile not in ["bark", "stone", "leaf", "weathered"] or size not in [128, 256, 512]:
            raise ValueError("Unsupported bounded texture profile")
        seed = int.from_bytes(hashlib.sha256((str(request["seed"]) + ":" + data["id"]).encode()).digest()[:8], "big")
        # Natural oak/birch/pine, deadwood and rock forms only (procedural.surface_materials): species bark tiles, leaf atlases, baked rock textures.
        pattern = data.get("pattern")
        stone = pattern is not None and pattern.startswith("rock-")
        if pattern is not None and (pattern not in TREE_PATTERNS or size != 512 or stone != (profile == "stone") or (not stone and pattern.endswith("leaves") == (profile == "bark"))):
            raise ValueError("Unsupported natural tree pattern")
        cutout = pattern is not None and pattern.endswith("leaves")
        phases = [random.Random(seed + index).random() * math.tau for index in range(4)]
        pixels = {role: [] for role, _, _ in ROLES}
        step = 1 / (size - 1)
        if pattern is not None:
            extra = {"leaf_scale": leaf_scale} if leaf_scale < 1.0 else {}
            pixels = tree_pixels(pattern, data["color"], data["metallic"], seed, size, data.get("repeats", 1), data.get("moss", False), data.get("extent", 1.0), data.get("bake"), **extra)
        for y in range(size if pattern is None else 0):
            v = (y % (size - 1)) * step
            for x in range(size):
                u = (x % (size - 1)) * step
                # tile_pattern: the local ``pattern`` (natural pattern name) shadows pattern().
                height, variation = tile_pattern(profile, phases, u, v)
                dx = (tile_pattern(profile, phases, u + step, v)[0] - tile_pattern(profile, phases, u - step, v)[0]) / (2 * step)
                dy = (tile_pattern(profile, phases, u, v + step)[0] - tile_pattern(profile, phases, u, v - step)[0]) / (2 * step)
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


def library_surface(request, directory, data):
    """Bind a library material request {"name", "params"?, "resolution"?, "tileMetres"?} to
    MAT_<id>: tileable maps (UV0 = tile_m metres) under the shared texture contract."""
    import bpy
    import mat_blender
    import mat_library
    lib = data["library"]
    size = lib.get("resolution", 512)
    seed = int.from_bytes(hashlib.sha256((str(request["seed"]) + ":" + data["id"]).encode()).digest()[:4], "big") & 0x7FFFFFFF
    result = mat_library.tile(lib["name"], lib.get("params"), size=size, tile_m=lib.get("tileMetres"), seed=seed)
    if result["evidence"]["metrics"]["errors"]:
        raise ValueError("Library material failed its own validation")
    mat_blender.write_material(bpy.data.materials["MAT_" + data["id"]], result, directory / ".worker", data["id"])


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
# Species bark tiles and leaf-spray (pine: needle-spray) atlases for the natural-finish oak/birch/pine
# and the log/stump textures (procedural.py).
# Pixel arrays only (NumPy, bundled with Blender); rows run bottom (v = 0) to top like
# bpy image pixels. Deterministic for the material seed; periodic where UVs repeat.
TREE_PATTERNS = ("oak-bark", "birch-bark", "pine-bark", "oak-leaves", "birch-leaves", "pine-leaves", "oak-log", "birch-log", "rock-boulder", "rock-outcrop")
# Physical size (around, along) in metres of one bark repeat; must match procedural.BARK_TILE.
BARK_SIZE = {"oak": (.42, 1.0), "birch": (.5, .6), "pine": (.5, .8)}
# Birch strips (first row, rows) at 512 px; must match procedural.BIRCH_STRIPS.
# Bottom up in trunk order, so the texel rows beside each strip continue its own edge content (mip
# filtering never bleeds a foreign strip in); BIRCH_GUARD rows below base / above clean continue them.
BIRCH_ROWS = (("base", 4, 68), ("fall", 72, 68), ("patched", 140, 76), ("rise", 216, 92), ("clean", 308, 200))
BIRCH_GUARD = 4
# Natural log/stump texture rows (name, first row, rows) at 512 px: one bark band (mossy when the
# asset asks for moss) and four end-grain discs; must match procedural.LOG_BAND / LOG_DISC_*.
LOG_ROWS = (("bark", 0, 384), ("discs", 384, 128))
# Bark tile lengths one log band spans along the log, so its exact repeat is that much longer;
# must match procedural.LOG_CYCLES.
LOG_CYCLES = {"oak": 2, "birch": 2}
# Leaf atlas tiles: 4 x 2 of 128 x 256 px at 512 (row 0 sunlit, row 1 shade); must match procedural.ATLAS_*.
ATLAS = (4, 2)


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


def _oak_bark(np, rng, color, size, rows=None, around_tiles=1, cycles=1, weathered=0.0):
    """Furrowed oak: deep warped vertical furrows between corky ridges, broken into plates by
    staggered, partial cross cracks. Defaults give the tree tile (one repeat on size x size). A log
    band passes ``rows`` (period rows - 1, last row repeating the first), ``around_tiles`` tile widths
    round the whole girth and ``cycles`` tile lengths along it, all generated afresh (no copied
    tiles), and ``weathered`` (0..1) for the lower-contrast, softer-relief bark of dead wood."""
    around, along = BARK_SIZE["oak"]
    n = size if rows is None else rows - 1
    u, v = np.meshgrid((np.arange(size) + .5) / size, (np.arange(n) + .5) / n)
    a, c = around_tiles, cycles
    columns = 7 * a
    warp = (_fbm(np, rng, u, v, 3 * a, 3 * c, 3) - .5) * 2.2 + (_fbm(np, rng, u, v, 8 * a, 6 * c, 2) - .5) * .7
    w = columns * u + warp
    ridge_index = np.floor(w).astype(np.int64) % columns
    s = w - np.floor(w)
    edge = np.minimum(s, 1 - s)
    furrow = .2 + .22 * _fbm(np, rng, u, v, columns, 10 * c, 2)
    plate = _smooth(np, .02, furrow + .04, edge)
    crown = np.clip(edge / .5, 0, 1)
    cracks = rng.integers(5, 11, columns) * c
    phase = rng.random(columns)
    position = cracks[ridge_index] * v + phase[ridge_index] + .35 * (_fbm(np, rng, u, v, 10 * a, 6 * c, 2) - .5)
    gate = _smooth(np, .35, .55, _value_noise(np, rng, u, v, columns * 2, 18 * c))
    crack = (1 - _smooth(np, 0.0, .07, np.abs(_wrap(np, position)))) * gate
    plate = plate * (1 - .75 * crack)
    # Plate index modulo its ridge's crack count, so plate tones repeat with the tile.
    cell = (ridge_index * 31 + (np.floor(position).astype(np.int64) % cracks[ridge_index]) * 7) % 97
    tone = (.82 + .3 * rng.random(97))[cell]
    grain = _fbm(np, rng, u, v, 20 * a, 24 * c, 3)
    fine = _value_noise(np, rng, u, v, 110 * a, 90 * c)
    height = plate * (.75 + .25 * crown) + .14 * grain * plate + .05 * fine
    metres = .025 * (1 - .45 * weathered) * height
    normal = _normals(np, metres, around * a / size, along * c / n)
    base = np.array(color, dtype=np.float64)
    top = (base * .62 + np.array([.03, .028, .026])) * tone[..., None]
    deep = base * (.07 + .3 * weathered)
    lit = np.clip(plate * (.7 + .3 * crown) + .15 * (grain - .5), 0, 1)[..., None]
    rgb = deep + (top - deep) * lit
    lichen = _smooth(np, .64, .74, _fbm(np, rng, u, v, 4 * a, 6 * c, 3))[..., None] * lit * .3
    rgb = rgb + (np.array([.28, .31, .24]) - rgb) * lichen
    rgb = rgb * (.85 + .3 * grain * (.6 + .4 * fine))[..., None]
    rough = .78 + .2 * (1 - lit[..., 0])
    if weathered:
        # Dead wood: furrow and plate tones pulled towards their mean, so the bark reads as one
        # weathered surface rather than black and white stripes.
        mean = rgb.reshape(-1, 3).mean(axis=0)
        rgb = mean + (rgb - mean) * (1 - .45 * weathered)
    if rows is not None:
        rgb, normal, rough = (np.concatenate([x, x[:1]], axis=0) for x in (rgb, normal, rough))
    return rgb, np.ones(rgb.shape[:2]), normal, rough


LENTICELS = 150
# Per strip: (patch level at the strip foot, at its top, lenticel count at foot, at top). Levels
# above every field value leave clean white bark; lower levels grow the dark rugged patches.
BIRCH_GRADES = {"clean": (2.0, 2.0, 150, 150), "rise": (.6, 1.2, 60, 150), "patched": (.6, .6, 60, 60),
                "fall": (.36, .6, 14, 60), "base": (.36, .36, 14, 14), "log": (.62, .62, 90, 90)}


def _birch_strip(np, seed, color, size, name, rows):
    """One birch strip of ``rows`` px covering one repeat (period rows - 1, so a periodic strip's
    last row repeats its first). Every strip samples the same fields (same seed) at strip-relative
    v, so strips that meet where the tile wraps agree: clean white papery bark with horizontal
    lenticels, patched (dark rugged patches on white), the dark fissured base, and the grading
    strips whose patch level and lenticel count ramp from one neighbour to the other."""
    rng = np.random.default_rng(seed)
    around, along = BARK_SIZE["birch"]
    period = rows - 1
    x = (np.arange(size) + .5) / size
    # One extra row beyond each end for the non-periodic gradient of the grading strips.
    t = np.arange(-1, period + 2) / period
    u, v = np.meshgrid(x, t)
    lo_level, hi_level, lo_count, hi_count = BIRCH_GRADES[name]
    # Ragged grading: the ramp is displaced by noise that vanishes at both strip ends.
    ragged = _value_noise(np, rng, u, v, 5, 2) - .5
    ramp = np.clip(v + 1.1 * ragged * np.sin(np.pi * np.clip(v, 0.0, 1.0)), 0.0, 1.0)
    level = lo_level + (hi_level - lo_level) * ramp
    count = lo_count + (hi_count - lo_count) * ramp
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
    for k in range(LENTICELS):
        cx, cy = rng.random(), rng.random()
        half = rng.uniform(.015, .07) * (1.8 if rng.random() < .15 else 1)
        thick = rng.uniform(.004, .009) / along
        strength = rng.uniform(.6, 1)
        du = _wrap(np, u - cx) / half
        dv = _wrap(np, v - cy - .02 * du * du * half) / thick
        mark = np.clip(1.6 * (1 - du * du - dv * dv), 0, 1) * strength * np.clip(count - k, 0, 1)
        dark = np.maximum(dark, mark)
    field = _fbm(np, rng, u, v, 4, 4, 4) + .14 * (_fbm(np, rng, u, v, 16, 14, 2) - .5)
    patch = np.clip((field - level) / .025, 0.0, 1.0)
    patch = patch * patch * (3 - 2 * patch)
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
    gx = (np.roll(metres, -1, axis=1) - np.roll(metres, 1, axis=1)) / (2 * around / size)
    gy = (metres[2:] - metres[:-2]) / (2 * along / period)
    gx = gx[1:-1]
    length = np.sqrt(gx * gx + gy * gy + 1)
    normal = np.stack([-gx / length, -gy / length, 1 / length], axis=-1)
    out = [rgb[1:-1], np.ones_like(u[1:-1]), normal, rough[1:-1]]
    if lo_level == hi_level:
        # Periodic strip: its last row is exactly its first.
        for a in out:
            a[-1] = a[0]
    return tuple(out)


def _birch_bark(np, rng, color, size):
    if size != 512:
        raise ValueError("Birch strips are laid out for 512 px")
    seed = int(rng.integers(2 ** 62))
    parts = [_birch_strip(np, seed, color, size, name, rows) for name, _, rows in BIRCH_ROWS]
    g = BIRCH_GUARD
    # Guards: the base period just below its first row, the clean period just above its last.
    below = [a[-1 - g:-1] for a in parts[0]]
    above = [a[1:1 + g] for a in parts[-1]]
    return tuple(np.concatenate([below[k]] + [p[k] for p in parts] + [above[k]], axis=0) for k in range(4))


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

    def stroke(self, points, widths, colors, lift=0.0):
        """A thin rounded stroke (a needle) whose colour runs along it from point to point; ``lift``
        raises it in the height field (needles nearer the viewer stand proud of the shoot)."""
        np = self.np
        for (a, b), (wa, wb), (ca, cb) in zip(zip(points, points[1:]), zip(widths, widths[1:]), zip(colors, colors[1:])):
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
            rgb = (ca + (cb - ca) * t[..., None]) * (.72 + .4 * round_)[..., None]
            self.put(y0, x0, alpha, rgb, round_ * r * .08 + lift, np.full(alpha.shape, .8))


def _shoot(start, heading, length, steps, curve):
    points = [start]
    for k in range(1, steps):
        angle = heading + curve * k / steps
        last = points[-1]
        points.append((last[0] + math.cos(angle) * length / (steps - 1), last[1] + math.sin(angle) * length / (steps - 1)))
    return points


def _spray(np, rng, species, color, width, height, shade, *, leaf_scale=1.0):
    """One original leaf spray: a branching shoot with species leaves, kept inside the tile."""
    canvas = _Canvas(np, width, height)
    leaf_color = np.array(color) * (np.array([.6, .66, .8]) if shade else 1.0)
    bark = np.array([.09, .065, .045]) if species == "oak" else np.array([.14, .06, .04])
    oak = species == "oak"
    leaf_scale = _checked_leaf_scale(species + "-leaves", leaf_scale)
    dense = leaf_scale < 1.0
    # Nearest integer, with halves rounded up. More shoots and cohorts partly
    # replace the area of smaller glyphs; coverage is not guaranteed. At s>=.45:
    # <=7 side shoots, <=30 main + 7*18 side leaves =156 calls/tile (1248/atlas).
    def count(value):
        return math.floor(value / leaf_scale + .5) if dense else value
    sides = count(3) if oak else 4
    main = _shoot((width * rng.uniform(.44, .56), 2.0), math.pi / 2 + rng.uniform(-.07, .07), height * (.66 if oak else .82), 14, rng.uniform(-.22, .22))
    shoots = [(main, 2.6 * leaf_scale if dense else 2.6 if oak else 1.7)]
    for k in range(sides):
        f = .12 + .38 * (k + rng.uniform(.1, .9)) / sides if dense else rng.uniform(.12, .5) if oak else rng.uniform(.15, .65)
        index = int(f * (len(main) - 1))
        side = 1 if k % 2 == 0 else -1
        if rng.random() < .5:
            side = -side
        heading = math.pi / 2 + side * rng.uniform(.45, .8)
        shoots.append((_shoot(main[index], heading, height * rng.uniform(.25, .36) * (1 if oak else 1.1), 8, -side * rng.uniform(.1, .4)), 1.6 * leaf_scale if dense else 1.6 if oak else 1.1))
    for number, (points, w) in enumerate(shoots):
        # Only the painted basal endpoint follows the card's fixed UV root.
        # Keep generated shoots and their random consumers unchanged.
        painted = [np.array(p) for p in points]
        if number == 0:
            painted[0] = np.array((width * .5, 2.0))
        widths = [w * (1 - .55 * k / (len(points) - 1)) for k in range(len(points))]
        if dense and number == 0:
            # Only the basal raster footprint needs this small floor: bilinear
            # sampling at the declared UV root must remain opaque. All later
            # stations retain the scaled twig radius (no broad painted stems).
            widths[0] = max(widths[0], 1.25)
        canvas.twig(painted, widths, bark)
    leaves = []
    for number, (points, _) in enumerate(shoots):
        n = len(points) - 1
        scale = 1.0 if number == 0 else .85
        if oak:
            # Keep a small terminal rosette, with the remaining tip cohort
            # stratified along the outer shoot instead of sharing one base.
            for k in range(count(rng.integers(3, 5) if number else rng.integers(4, 7))):
                f = rng.uniform(.15, .85)
                leaves.append((points, f, (1 if k % 2 else -1) * rng.uniform(.6, 1.2), scale * rng.uniform(.14, .19)))
            cohort = count(rng.integers(5, 8) if number == 0 else 4)
            terminal = 2 if number == 0 else 1
            spread = cohort - terminal
            for k in range(cohort):
                f = .68 + .28 * (k + .5) / spread if k < spread else 1.0
                leaves.append((points, f, rng.uniform(-1.2, 1.2), scale * rng.uniform(.16, .21)))
        else:
            # Birch: alternate leaves along thin, slightly drooping shoots.
            cohort = rng.integers(11, 15) if number == 0 else rng.integers(5, 8)
            for k in range(cohort):
                f = .12 + .88 * k / max(1, cohort - 1)
                leaves.append((points, f, (1 if k % 2 else -1) * rng.uniform(.5, 1.2), scale * rng.uniform(.11, .14)))
    if dense and len(leaves) > 156:
        raise ValueError("Oak leaf atlas density exceeds its trusted bound")
    for i in sorted(range(len(leaves)), key=lambda i: rng.random()):
        points, f, swing, size = leaves[i]
        if oak:
            position = f * (len(points) - 1)
            index = min(len(points) - 2, int(position))
            first, last = np.array(points[index]), np.array(points[index + 1])
            base = first + (last - first) * (position - index)
            ahead = last - first
        else:
            # Other species retain their original placement and RNG consumers.
            index = min(len(points) - 1, int(round(f * (len(points) - 1))))
            base = np.array(points[index])
            ahead = np.array(points[min(len(points) - 1, index + 1)]) - np.array(points[max(0, index - 1)])
        heading = math.atan2(ahead[1], ahead[0]) + swing
        length = size * height * leaf_scale if dense else size * height
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


# ------------------------------------------------------------------ pine ---
# Pine strips (first row, rows) at 512 px, bottom up in trunk order with PINE_GUARD rows below/above;
# must match procedural.PINE_STRIPS. Each strip's plate level ramps from its foot to its top: 1 is the
# deep plated lower-trunk bark, 0 the thin flaking upper bark that also covers the limbs.
PINE_ROWS = (("plated", 4, 224), ("grade", 228, 96), ("upper", 324, 184))
PINE_GUARD = 4
PINE_GRADES = {"plated": (1.0, 1.0), "grade": (1.0, 0.0), "upper": (0.0, 0.0)}


def _cells(np, rng, u, v, cu, cv, aspect):
    """Periodic jittered-grid cells (period 1 in u and v): nearest and second-nearest feature
    distances in u units (v distances scaled by ``aspect``) and the nearest cell's index."""
    jitter = rng.random((cv, cu, 2))
    f1, f2 = np.full(u.shape, 9.0), np.full(u.shape, 9.0)
    ident = np.zeros(u.shape, dtype=np.int64)
    for j in range(cv):
        for i in range(cu):
            d = np.hypot(_wrap(np, u - (i + .15 + .7 * jitter[j, i, 0]) / cu), _wrap(np, v - (j + .15 + .7 * jitter[j, i, 1]) / cv) * aspect)
            closer = d < f1
            f2 = np.where(closer, f1, np.minimum(f2, d))
            ident = np.where(closer, j * cu + i, ident)
            f1 = np.where(closer, d, f1)
    return f1, f2, ident


def _pine_strip(np, seed, color, size, name, rows):
    """One pine strip of ``rows`` px covering one repeat (period rows - 1). Lower trunk: thick
    reddish-brown plates with weathered grey-brown faces, fresh red-orange flake scars and deep dark
    fissures. Upper trunk and limbs: thin papery orange flakes with fine dark seams. Every strip
    samples the same fields (same seed) at strip-relative v, so strips meeting at a tile wrap agree."""
    rng = np.random.default_rng(seed)
    around, along = BARK_SIZE["pine"]
    aspect = along / around
    period = rows - 1
    x = (np.arange(size) + .5) / size
    t = np.arange(-1, period + 2) / period
    u, v = np.meshgrid(x, t)
    lo, hi = PINE_GRADES[name]
    ragged = _value_noise(np, rng, u, v, 5, 2) - .5
    ramp = np.clip(v + 1.1 * ragged * np.sin(np.pi * np.clip(v, 0.0, 1.0)), 0.0, 1.0)
    plated = lo + (hi - lo) * ramp
    base = np.array(color, dtype=np.float64)
    wu = (_fbm(np, rng, u, v, 6, 5, 3) - .5) * .13
    wv = (_fbm(np, rng, u, v, 6, 5, 3) - .5) * .07
    flakes = _fbm(np, rng, u, v, 24, 30, 3)
    fine = _value_noise(np, rng, u, v, 120, 150)
    # Lower trunk plates: cells about 12 x 27 cm, drawn out further along the trunk.
    f1, f2, ident = _cells(np, rng, u + wu, v + wv, 4, 3, aspect * .36)
    edge = (f2 - f1) * around
    fissure = 1 - _smooth(np, .006, .038, edge)
    shoulder = _smooth(np, .0, .07, edge)
    tone = (.78 + .44 * rng.random(15))[ident % 15]
    # Vertical fibrous layering across each plate face.
    terrace = _fbm(np, rng, u + .3 * wu, v, 64, 5, 2)
    # Layered scales on each plate: where an outer scale has flaked off, fresh red-brown bark shows.
    h1, h2, hid = _cells(np, rng, u + 1.6 * wu + .012 * (flakes - .5), v + 1.4 * wv, 14, 9, aspect * .7)
    subedge = (h2 - h1) * around
    subline = (1 - _smooth(np, .0005, .003, subedge)) * (1 - fissure) * _smooth(np, .35, .6, flakes)
    lost = (rng.random(126) > .6)[hid % 126]
    scar = lost * _smooth(np, .0008, .006, subedge) * (1 - fissure) * (.55 + .45 * _smooth(np, .3, .7, fine))
    grey = base * np.array([.68, .72, .8]) + .018
    fresh = base * np.array([1.35, .88, .68])
    mottle = _fbm(np, rng, u, v, 12, 16, 3)
    face = (grey + (fresh - grey) * scar[..., None]) * tone[..., None] * (.78 + .44 * mottle[..., None])
    face = face * (.86 + .14 * terrace[..., None]) * (.9 + .2 * fine[..., None]) * (.62 + .38 * shoulder[..., None]) * (1 - .2 * subline[..., None])
    deep = base * np.array([.3, .2, .16])
    wall = base * np.array([1.2, .78, .6])
    gap = deep + (wall - deep) * _smooth(np, .005, .03, edge)[..., None]
    lower = gap + (face - gap) * (1 - fissure)[..., None]
    lower_h = (1 - fissure) * (.55 + .3 * shoulder + .12 * flakes - .06 * terrace - .1 * scar - .08 * subline) + .05 * fine
    lower_r = .78 + .17 * fissure
    # Upper trunk: thin papery flakes, about 5 x 4.5 cm, peeling lighter at their edges.
    g1, g2, gid = _cells(np, rng, u + .5 * wu, v + .5 * wv, 10, 18, aspect)
    seam = 1 - _smooth(np, .0004, .004, (g2 - g1) * around)
    peel = _smooth(np, .55, .8, _fbm(np, rng, u, v, 14, 20, 2)) * _smooth(np, .002, .01, (g2 - g1) * around)
    orange = base * np.array([1.6, 1.22, .86])
    flake_tone = (.84 + .3 * rng.random(180))[gid % 180]
    upper = orange * flake_tone[..., None] * (.92 + .16 * fine[..., None])
    upper = upper + (orange * np.array([1.22, 1.2, 1.15]) - upper) * peel[..., None]
    upper = upper * (1 - .55 * seam[..., None])
    upper_h = .3 * (1 - seam) + .1 * flakes + .12 * peel
    upper_r = .66 + .12 * seam
    p = plated[..., None]
    rgb = upper + (lower - upper) * p
    height = upper_h + (lower_h - upper_h) * plated
    rough = upper_r + (lower_r - upper_r) * plated
    metres = (.004 + .018 * plated) * height
    gx = (np.roll(metres, -1, axis=1) - np.roll(metres, 1, axis=1)) / (2 * around / size)
    gy = (metres[2:] - metres[:-2]) / (2 * along / period)
    gx = gx[1:-1]
    length = np.sqrt(gx * gx + gy * gy + 1)
    normal = np.stack([-gx / length, -gy / length, 1 / length], axis=-1)
    out = [rgb[1:-1], np.ones_like(u[1:-1]), normal, np.clip(rough[1:-1], 0, 1)]
    if lo == hi:
        for a in out:
            a[-1] = a[0]
    return tuple(out)


def _pine_bark(np, rng, color, size):
    if size != 512:
        raise ValueError("Pine strips are laid out for 512 px")
    seed = int(rng.integers(2 ** 62))
    parts = [_pine_strip(np, seed, color, size, name, rows) for name, _, rows in PINE_ROWS]
    g = PINE_GUARD
    below = [a[-1 - g:-1] for a in parts[0]]
    above = [a[1:1 + g] for a in parts[-1]]
    return tuple(np.concatenate([below[k]] + [p[k] for p in parts] + [above[k]], axis=0) for k in range(4))


def _needle_spray(np, rng, color, width, height, shade):
    """One original pine branch end: a twig forking into three to five shoots, each a dense
    bottle-brush of fine needles set radially all round it (seen in projection, back needles in
    shade behind the twig, front ones lit over it), closing into a lighter new-growth tuft at
    every tip. Dark green with a slight blue-grey cast."""
    canvas = _Canvas(np, width, height)
    tone = np.array([.68, .7, .56]) * (np.array([.62, .66, .72]) if shade else 1.0)
    leaf = np.array(color) * tone + np.array([.006, .007, .009])
    fresh = leaf * np.array([1.9, 1.7, .95])
    bark = np.array([.13, .075, .045])
    reach = height * rng.uniform(.15, .17)
    main = _shoot((width * rng.uniform(.46, .54), 2.0), math.pi / 2 + rng.uniform(-.06, .06), height * rng.uniform(.8, .88), 18, rng.uniform(-.16, .16))
    shoots = [(main, 2.4, .1)]
    forks = int(rng.integers(4, 7))
    first = int(rng.integers(2))
    for k in range(forks):
        index = int((.14 + .46 * (k + rng.uniform(0, 1)) / forks) * (len(main) - 1))
        side = 1 if (k + first) % 2 else -1
        span = height - main[index][1] - 4
        # Low forks splay wide, high ones hug the leader, so the spray fills its tile.
        splay = rng.uniform(.5, .78) - .25 * k / forks
        shoots.append((_shoot(main[index], math.pi / 2 + side * splay, min(span, height * rng.uniform(.26, .44)), 12,
                              -side * rng.uniform(.15, .4)), 1.5, .0))
    marks = []
    for number, (points, w, bare) in enumerate(shoots):
        widths = [w * (1 - .6 * k / (len(points) - 1)) for k in range(len(points))]
        # Do not alter points: their arc length controls seeded needle counts.
        painted = [(width * .5, 2.0), *points[1:]] if number == 0 else points
        marks.append((0.0, "twig", (painted, widths)))
        arc = sum(math.dist(a, b) for a, b in zip(points, points[1:]))
        count = int(arc * (2.2 if number == 0 else 1.9))
        phi = 0.0
        # Along the shoot, then a crowded tuft of short new needles round the bud.
        for k in range(count + 16):
            f = bare + (1 - bare) * (k + rng.uniform(0, 1)) / count if k < count else rng.uniform(.9, 1.0)
            # Needles come in pairs from one sheath: the second keeps close to the first.
            phi = phi + rng.uniform(-.5, .5) if k % 2 else rng.uniform(0, 2 * math.pi)
            tip = _smooth(np, .8, 1.0, f)
            theta = rng.uniform(.7, 1.2) * (1 - .5 * tip)
            length = reach * rng.uniform(.78, 1.12) * (1 - .3 * tip) * (.9 if number else 1.0)
            position = f * (len(points) - 1)
            index = min(len(points) - 2, int(position))
            a, b = np.array(points[index]), np.array(points[index + 1])
            base = a + (b - a) * (position - index)
            t = (b - a) / max(np.linalg.norm(b - a), 1e-9)
            n = np.array([-t[1], t[0]])
            depth = math.sin(theta) * math.sin(phi)
            for _ in range(10):
                vec = t * length * math.cos(theta) + n * length * math.sin(theta) * math.cos(phi)
                end = base + vec
                if 2 <= end[0] <= width - 3 and 2 <= end[1] <= height - 3:
                    break
                length *= .88
            else:
                continue
            # Slight inward curve towards the shoot tip.
            mid = base + .5 * vec + t * .06 * length
            light = .52 + .48 * (.5 + .5 * depth) + rng.uniform(-.12, .12)
            root = leaf * light * .75
            end_colour = (leaf + (fresh - leaf) * float(tip)) * light * rng.uniform(1.05, 1.3)
            if rng.random() < .012:
                end_colour = np.array([.13, .09, .04])
            lift = .08 * length * math.sin(theta) * math.sin(phi)
            marks.append((depth, "needle", ([base, mid, end], [rng.uniform(.62, .8), .6, .42], [root, (root + end_colour) / 2, end_colour], lift)))
    order = sorted(range(len(marks)), key=lambda i: (marks[i][0], rng.random()))
    for i in order:
        _, kind, data = marks[i]
        if kind == "twig":
            points, widths = data
            canvas.twig([np.array(q) for q in points], widths, bark)
        else:
            canvas.stroke(*data)
    return canvas


def _leaf_atlas(np, rng, species, color, size, *, leaf_scale=1.0):
    leaf_scale = _checked_leaf_scale(species + "-leaves", leaf_scale)
    if size != 512:
        raise ValueError("Leaf atlas tiles are laid out for 512 px")
    cols, rows = ATLAS
    tw, th = size // cols, size // rows
    rgb, alpha = np.zeros((size, size, 3)), np.zeros((size, size))
    height, rough = np.zeros((size, size)), np.full((size, size), .7)
    for row in range(rows):
        for col in range(cols):
            extra = {"leaf_scale": leaf_scale} if leaf_scale < 1.0 else {}
            tile = _needle_spray(np, rng, color, tw, th, row == 1) if species == "pine" else _spray(np, rng, species, color, tw, th, row == 1, **extra)
            covered = tile.alpha > .5
            # Transparent texels carry the tile's mean leaf colour so filtering never darkens edges.
            if not covered.all():
                fill = tile.rgb[covered].mean(axis=0) if covered.any() else np.array(color)
                tile.rgb[~covered] = fill
            ys, xs = slice(row * th, (row + 1) * th), slice(col * tw, (col + 1) * tw)
            rgb[ys, xs], alpha[ys, xs], height[ys, xs], rough[ys, xs] = tile.rgb, tile.alpha, tile.height, tile.rough
    normal = _normals(np, height, 1.0, 1.0)
    return rgb, alpha, normal, rough


def _tile_columns(np, a, repeats):
    """``repeats`` copies of a u-periodic image across its width, box-filtered (still periodic)."""
    n = a.shape[1]
    index = (np.arange(n)[:, None] * repeats + np.arange(repeats)[None, :]) % n
    return a[:, index].mean(axis=2)


def _periodic_rows(np, a, rows):
    """Resample a v-periodic image to one period of rows - 1 rows plus a repeat of its first row."""
    n, period = a.shape[0], rows - 1
    position = np.arange(period) * n / period
    i0 = np.floor(position).astype(np.int64)
    f = (position - i0).reshape((-1,) + (1,) * (a.ndim - 1))
    out = a[i0 % n] * (1 - f) + a[(i0 + 1) % n] * f
    return np.concatenate([out, out[:1]], axis=0)


def _unit(np, normal):
    return normal / np.linalg.norm(normal, axis=-1, keepdims=True)


def _end_grain(np, rng, species, tile, broken):
    """One end-grain disc on a ``tile`` px square: annual rings round an off-centre pith with a
    warped, uneven spacing, sapwood and a bark rim, radial checks; broken discs are weathered grey,
    fibrous and split. Outside the disc the bark rim colour continues."""
    y, x = np.meshgrid(np.arange(tile) + .5, np.arange(tile) + .5, indexing="ij")
    c = tile / 2
    radius = .46 * tile
    dx, dy = (x - c) / radius, (y - c) / radius
    rho = np.sqrt(dx * dx + dy * dy)
    angle = np.arctan2(dy, dx)
    a = (angle / (2 * np.pi)) % 1.0
    px, py = rng.uniform(-.12, .12, 2)
    pith = np.sqrt((dx - px) ** 2 + (dy - py) ** 2)
    warp = (_fbm(np, rng, a, np.clip(rho, 0, 1), 6, 3, 3) - .5) * .9
    rings = rng.uniform(16, 26)
    phase = pith * rings * (1 + .25 * pith) + warp * 2.2
    line = 1 - _smooth(np, 0.0, .22, np.abs(_wrap(np, phase)))
    late = _smooth(np, .3, .8, phase - np.floor(phase))
    heart, sap = ({"oak": ([.40, .27, .15], [.66, .52, .33]), "birch": ([.74, .62, .45], [.84, .75, .58])})[species]
    heart, sap = np.array(heart), np.array(sap)
    inner = _smooth(np, .62, .74, rho)[..., None]
    wood = heart + (sap - heart) * inner
    rgb = wood * (1 - .12 * late[..., None] - .3 * line[..., None])
    fibre = _value_noise(np, rng, a, np.clip(rho, 0, 1), 90, 6)
    rgb = rgb * (.92 + .16 * fibre)[..., None]
    checks = np.zeros_like(rho)
    for _ in range(int(rng.integers(2, 5)) + (3 if broken else 0)):
        at = rng.uniform(0, 1)
        length = rng.uniform(.35, .85)
        width = rng.uniform(.006, .014) * (2.2 if broken else 1)
        gap = np.abs(_wrap(np, a - at - .02 * np.sin(rho * 9))) * 2 * np.pi * np.maximum(rho, .05)
        checks = np.maximum(checks, (1 - _smooth(np, 0.0, width * (1 - rho + .2), gap)) * _smooth(np, 1.0 - length, 1.0 - length + .08, rho) * (rho < .93))
    height = .4 + .15 * late - .25 * line + .1 * fibre - .9 * checks
    if broken:
        grey = np.array([.26, .22, .18]) * (.8 + .4 * fibre[..., None])
        rgb = rgb + (grey - rgb) * .6
        shards = _fbm(np, rng, a, np.clip(rho, 0, 1), 24, 4, 3)
        height = height + .6 * shards
        rgb = rgb * (.8 + .4 * shards[..., None])
    saw = .025 * np.sin((dx * .8 + dy * .6) * 60) if not broken else 0.0
    rgb = rgb * (1 + saw)[..., None] if not broken else rgb
    rgb = rgb * (1 - .75 * checks[..., None])
    bark = _smooth(np, .9, .96, rho)[..., None]
    barkc = np.array([.16, .12, .09]) if species == "oak" else np.array([.62, .6, .56])
    rgb = rgb + (barkc - rgb) * bark
    height = height * (1 - bark[..., 0]) + .55 * bark[..., 0]
    rough = .78 + .15 * checks + (.1 if broken else 0)
    return rgb, height, np.clip(rough, 0, 1)


def _moss(np, rng, band, normal, rough, height_px, cycles=1):
    """Moss over the top of a log band: centred on u = .5 with a patchy edge that thins out into
    scattered cushions and a faint green algal film, so it blends into the bark instead of ending."""
    rows, width = band.shape[:2]
    period = rows - 1
    u, v = np.meshgrid((np.arange(width) + .5) / width, np.arange(rows) / period)
    up = -np.cos(2 * np.pi * u)
    patchy = _fbm(np, rng, u, v, 14, 5 * cycles, 4)
    holes = _fbm(np, rng, u, v, 32, 12 * cycles, 3)
    reach = .5 * up + 1.3 * (patchy - .5)
    cover = _smooth(np, .0, .6, reach) * _smooth(np, .18, .5, holes + .2 * up)
    cover = cover ** 1.2
    film = _smooth(np, -.35, .45, reach) * .32
    tufts = _fbm(np, rng, u, v, 128, 48 * cycles, 2)
    tone = _smooth(np, .45, .65, _fbm(np, rng, u, v, 16, 8 * cycles, 3))[..., None]
    green = np.array([.045, .075, .02]) + np.array([.07, .08, .015]) * tufts[..., None]
    green = green + (np.array([.16, .17, .05]) - green) * tone * .5
    algae = band * np.array([.8, 1.0, .7]) * .9
    rgb = band + (algae - band) * film[..., None]
    rgb = rgb + (green - rgb) * cover[..., None]
    lift = .005 * tufts * cover
    gx = (np.roll(lift, -1, axis=1) - np.roll(lift, 1, axis=1)) / (2 * height_px[0])
    gy = (np.roll(lift, -1, axis=0) - np.roll(lift, 1, axis=0)) / (2 * height_px[1])
    bump = _unit(np, np.stack([-gx, -gy, np.ones_like(gx)], axis=-1))
    normal = _unit(np, normal * (1 - cover[..., None]) + bump * cover[..., None])
    rough = rough + (.96 - rough) * cover
    for a in (rgb, normal, rough):
        a[-1] = a[0]
    return rgb, normal, rough


def _log_surface(np, rng, species, color, size, repeats, moss):
    """Natural log/stump texture (rows bottom up, see LOG_ROWS): the species bark round the whole
    girth (``repeats`` bark tile widths) over LOG_CYCLES tile lengths, mossy on top when asked, then
    four end-grain discs."""
    if size != 512:
        raise ValueError("Log textures are laid out for 512 px")
    (_, _, rows), (_, _, disc_rows) = LOG_ROWS
    around, along = BARK_SIZE[species]
    cycles = LOG_CYCLES[species]
    if species == "oak":
        bark = _oak_bark(np, rng, color, size, rows, repeats, cycles, weathered=1.0)
        rgb, normal, rough = bark[0], bark[2], bark[3]
    else:
        # Birch: one fine-grained strip repeat per tile length, ``cycles`` of them along the band.
        strip = _birch_strip(np, int(rng.integers(2 ** 62)), color, size, "log", (rows - 1) // cycles + 1)
        rgb, normal, rough = (_periodic_rows(np, np.concatenate([a[:-1]] * cycles, axis=0), rows) for a in
                              (_tile_columns(np, a, repeats) for a in (strip[0], strip[2], strip[3])))
        normal = _unit(np, normal)
    if moss:
        texel = (around * repeats / size, along * cycles / (rows - 1))
        rgb, normal, rough = _moss(np, rng, rgb.copy(), normal.copy(), rough.copy(), texel, cycles)
    tile = disc_rows
    discs = [_end_grain(np, rng, species, tile, k >= 2) for k in range(size // tile)]
    drgb = np.concatenate([d[0] for d in discs], axis=1)
    dheight = np.concatenate([d[1] for d in discs], axis=1)
    drough = np.concatenate([d[2] for d in discs], axis=1)
    dnormal = _normals(np, .006 * dheight, .004, .004)
    out_rgb = np.concatenate([rgb, drgb], axis=0)
    out_normal = np.concatenate([normal, dnormal], axis=0)
    out_rough = np.concatenate([rough, drough], axis=0)
    if out_rgb.shape[0] != size:
        raise ValueError("Log texture rows changed")
    return out_rgb, np.ones(out_rgb.shape[:2]), out_normal, out_rough


# ------------------------------------------------------------------ rock ---
# Natural rock forms are baked, not tiled: procedural.plan_natural_rock gives every lattice face of
# the rock its own UV chart, and the bake inputs (positions, normals, cavity, tunnel recess) are
# rasterised over those charts so stone, strata, moss and shading are computed per texel from
# world-space position in metres. Moss edges are therefore soft and irregular at texel resolution,
# and nothing repeats or bands across the rock.
ROCK_GUTTER_FILL = 6


def _rasterise(np, bake, size):
    """Per-texel channels (position, normal, moss normal, cavity, tunnel, metres per texel along u
    and v) over the bake's UV triangles, with a 1.5 px linear extension and a nearest-texel fill over
    the gutters. Returns (channels HxWxC, filled HxW, texels HxW: inside a triangle)."""
    vertices = np.asarray(bake["vertices"], dtype=float)
    faces = np.asarray(bake["faces"], dtype=np.int64)
    uvs = np.asarray(bake["uvs"], dtype=float) * size - .5
    channels = np.concatenate([vertices, np.asarray(bake["normals"], dtype=float), np.asarray(bake["mossNormals"], dtype=float),
                               np.asarray(bake["cavity"], dtype=float)[:, None], np.asarray(bake["tunnel"], dtype=float)[:, None]], axis=1)
    if faces.ndim != 2 or faces.shape[1] != 3 or uvs.shape != (len(faces), 3, 2) or len(channels) != len(vertices):
        raise ValueError("Rock bake needs triangles with three UVs each")
    e1, e2 = uvs[:, 1] - uvs[:, 0], uvs[:, 2] - uvs[:, 0]
    area = e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]
    keep = np.abs(area) > 1e-9
    faces, uvs, e1, e2, area = faces[keep], uvs[keep], e1[keep], e2[keep], area[keep]
    # Metres per texel along u and v: the position gradient of each triangle.
    p = vertices[faces]
    du = np.stack([p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]], axis=2)
    inverse = np.stack([np.stack([e2[:, 1], -e2[:, 0]], axis=1), np.stack([-e1[:, 1], e1[:, 0]], axis=1)], axis=1) / area[:, None, None]
    gradient = du @ inverse
    metric = np.stack([np.linalg.norm(gradient[:, :, 0], axis=1), np.linalg.norm(gradient[:, :, 1], axis=1)], axis=1)
    lengths = np.stack([np.hypot(*(uvs[:, 2] - uvs[:, 1]).T), np.hypot(*e2.T), np.hypot(*e1.T)], axis=1)
    width = channels.shape[1] + 2
    out = np.zeros((size * size, width))
    filled = np.zeros(size * size, dtype=bool)
    texels = None
    for grow in (0.0, 1.5):
        low = np.floor(uvs.min(axis=1) - grow).astype(np.int64)
        span = np.ceil(uvs.max(axis=1) + grow).astype(np.int64) - low + 1
        extent = span.max(axis=1)
        # Batches of triangles by bounding box size, rasterised together.
        for bucket in (4, 8, 16, 32, 64, 128, 256, 512):
            pick = np.nonzero((extent <= bucket) & (extent > bucket // 2) if bucket > 4 else extent <= 4)[0]
            for start in range(0, len(pick), max(1, 400000 // (bucket * bucket))):
                ids = pick[start:start + max(1, 400000 // (bucket * bucket))]
                gy, gx = np.mgrid[0:bucket, 0:bucket]
                x = low[ids, 0][:, None, None] + gx
                y = low[ids, 1][:, None, None] + gy
                dx, dy = x - uvs[ids, 0, 0][:, None, None], y - uvs[ids, 0, 1][:, None, None]
                a = area[ids][:, None, None]
                b1 = (dx * e2[ids, 1][:, None, None] - dy * e2[ids, 0][:, None, None]) / a
                b2 = (e1[ids, 0][:, None, None] * dy - e1[ids, 1][:, None, None] * dx) / a
                b0 = 1 - b1 - b2
                slack = (grow * lengths[ids] / np.abs(area[ids])[:, None] if grow else np.full((len(ids), 3), 1e-9))[:, :, None, None]
                inside = (b0 >= -slack[:, 0]) & (b1 >= -slack[:, 1]) & (b2 >= -slack[:, 2]) & (x >= 0) & (y >= 0) & (x < size) & (y < size)
                t, yy, xx = np.nonzero(inside)
                index = y[t, yy, xx] * size + x[t, yy, xx]
                if grow:
                    fresh = ~filled[index]
                    t, yy, xx, index = t[fresh], yy[fresh], xx[fresh], index[fresh]
                weights = np.stack([b0[t, yy, xx], b1[t, yy, xx], b2[t, yy, xx]], axis=1)
                corner = channels[faces[ids[t]]]
                out[index] = np.concatenate([(weights[:, :, None] * corner).sum(axis=1), metric[ids[t]]], axis=1)
                filled[index] = True
        if texels is None:
            texels = filled.copy()
    # Nearest fill over the rest of each gutter: propagate the source texel index outward.
    source = np.where(filled, np.arange(size * size), -1).reshape(size, size)
    for _ in range(ROCK_GUTTER_FILL):
        grown = source.copy()
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
            shifted = np.full_like(source, -1)
            shifted[max(0, dy):size + min(0, dy), max(0, dx):size + min(0, dx)] = source[max(0, -dy):size + min(0, -dy), max(0, -dx):size + min(0, -dx)]
            grown = np.where((grown < 0) & (shifted >= 0), shifted, grown)
        source = grown
    source = source.ravel()
    filled = source >= 0
    out[filled] = out[source[filled]]
    return out, filled, texels


def _noise3(np, table, p):
    """Smooth 3D value noise in [0, 1] at lattice coordinates p (N, 3)."""
    cell = np.floor(p)
    f = p - cell
    s = f * f * (3 - 2 * f)
    i = cell.astype(np.int64)
    hx = (i[:, 0] * 73856093, (i[:, 0] + 1) * 73856093)
    hy = (i[:, 1] * 19349663, (i[:, 1] + 1) * 19349663)
    hz = (i[:, 2] * 83492791, (i[:, 2] + 1) * 83492791)

    def corner(a, b, c):
        return table[(hx[a] ^ hy[b] ^ hz[c]) & 4095]
    sx, sy, sz = s[:, 0], s[:, 1], s[:, 2]
    x00 = corner(0, 0, 0)
    x00 = x00 + (corner(1, 0, 0) - x00) * sx
    x10 = corner(0, 1, 0)
    x10 = x10 + (corner(1, 1, 0) - x10) * sx
    x01 = corner(0, 0, 1)
    x01 = x01 + (corner(1, 0, 1) - x01) * sx
    x11 = corner(0, 1, 1)
    x11 = x11 + (corner(1, 1, 1) - x11) * sx
    y0 = x00 + (x10 - x00) * sy
    return y0 + (x01 + (x11 - x01) * sy - y0) * sz


class _Field:
    """World-space noise layers in metres over N texels, each octave faded out above the texel's
    Nyquist limit (so fine detail never aliases where texels are coarse)."""

    def __init__(self, np, rng, position, texel):
        self.np, self.rng, self.p, self.texel = np, rng, position, texel

    def fade(self, frequency):
        return self.np.clip((.9 - frequency * self.texel) / .4, 0, 1)

    def fbm(self, frequency, octaves=1, gain=.5, stretch=(1.0, 1.0, 1.0)):
        np = self.np
        table = self.rng.random(4096)
        shift = self.rng.uniform(0, 500, 3)
        total, weight, w = np.zeros(len(self.p)), 0.0, 1.0
        for _ in range(octaves):
            fade = self.fade(frequency * max(stretch))
            if fade.any():
                total = total + w * (.5 + (_noise3(np, table, self.p * (frequency * np.array(stretch)) + shift) - .5) * fade)
            else:
                total = total + w * .5
            weight += w
            w *= gain
            frequency *= 2.03
            shift = shift + 17.3
        return total / weight

    def worley(self, density, warp=None):
        """Cellular F1, F2 in metres for jittered points ``density`` per metre."""
        np = self.np
        table = self.rng.random((4096, 3))
        q = (self.p if warp is None else warp) * density
        g = np.floor(q).astype(np.int64)
        f1 = np.full(len(q), 9.0)
        f2 = np.full(len(q), 9.0)
        for dx in (-1, 0, 1):
            hx = (g[:, 0] + dx) * 73856093
            for dy in (-1, 0, 1):
                hxy = hx ^ (g[:, 1] + dy) * 19349663
                for dz in (-1, 0, 1):
                    h = (hxy ^ (g[:, 2] + dz) * 83492791) & 4095
                    d = q - g - np.array([dx, dy, dz]) - table[h]
                    d = np.sqrt((d * d).sum(axis=1))
                    f2 = np.where(d < f1, f1, np.minimum(f2, d))
                    f1 = np.minimum(f1, d)
        return f1 / density, f2 / density


def _weathered_boulder_joints(np, crack, medium):
    """Interrupt broad joints with existing world-space weathering; consume no randomness."""
    return crack * _smooth(np, .46, .60, medium)


def _rock_surface(np, rng, color, size, form, extent, moss, bake):
    """Natural rock texture baked over the rock's unique UV charts (see _rasterise): world-space
    tone, iron staining, mineral grain, joints and hairline cracks, irregular strata on outcrops,
    rain streaks, lichen, crevice and ground-contact darkening, a tunnel that darkens inward, and
    moss settling on sky-facing rock and in crevices with a soft, irregular edge."""
    if size != 512:
        raise ValueError("Rock textures are laid out for 512 px")
    if not (isinstance(extent, (int, float)) and math.isfinite(extent) and .05 <= extent <= 20):
        raise ValueError("Rock texture extent must be .05..20 m")
    if not isinstance(bake, dict):
        raise ValueError("Rock textures are baked from the planned rock mesh")
    maps, filled, texels = _rasterise(np, bake, size)
    m = maps[filled]
    p, normal, soft = m[:, 0:3], m[:, 3:6], m[:, 6:9]
    cavity, tunnel, mu, mv = m[:, 9], m[:, 10], np.maximum(m[:, 11], 1e-5), np.maximum(m[:, 12], 1e-5)
    normal = normal / np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-9)
    soft = soft / np.maximum(np.linalg.norm(soft, axis=1, keepdims=True), 1e-9)
    up, soft_up = normal[:, 2], soft[:, 2]
    texel = np.maximum(mu, mv)
    field = _Field(np, rng, p, texel)
    outcrop = form == "outcrop"
    top = max(float(p[:, 2].max()) if len(p) else 1.0, .05)
    base = np.array(color)
    # Tone: macro and medium variation, iron staining, mineral grain and specks, a warm/cool drift.
    macro = field.fbm(.8 * min(1.0, 4.0 / extent) + .25, 3)
    medium = field.fbm(7.0, 2)
    grain = field.fbm(70.0, 1)
    speck = field.fbm(190.0, 1)
    tone = .4 + .5 * macro + .36 * (medium - .5)
    rgb = base * tone[:, None]
    stain = _smooth(np, .58, .8, field.fbm(1.6, 3))
    rgb = rgb + (rgb * np.array([1.25, 1.02, .75]) - rgb) * stain[:, None] * .45
    rgb = rgb * (1 + .28 * _smooth(np, .72, .9, speck)[:, None] - .3 * _smooth(np, .3, .12, speck)[:, None])
    rgb = rgb * (.94 + .12 * grain)[:, None]
    warm = field.fbm(.7, 2)
    rgb = rgb * (1 + (warm[:, None] - .5) * np.array([.22, .08, -.14]))
    pits = field.fbm(26.0, 2)
    rgb = rgb * (1 - .12 * _smooth(np, .55, .75, pits))[:, None]
    height = .006 * medium + .002 * grain - .0015 * _smooth(np, .5, .75, pits)
    rough = .8 + .1 * (grain - .5) - .06 * (macro - .5)
    # Joints and hairline fractures: edges of a warped 3D cellular network, only some of them open,
    # never thinner than about a texel so they do not shimmer.
    warp = p + .12 * (np.stack([field.fbm(2.5, 2), field.fbm(2.5, 2), field.fbm(2.5, 2)], axis=1) - .5)
    f1, f2 = field.worley(1.3 if outcrop else 2.0, warp * (np.array([1.0, 1.0, 1.6]) if outcrop else 1.0))
    openness = _smooth(np, .5, .68, field.fbm(1.3, 2))
    crack = (1 - _smooth(np, 0, np.maximum(.012, 1.3 * texel), f2 - f1)) * openness
    if form == "boulder":
        crack = _weathered_boulder_joints(np, crack, medium)
    hair = 0.0
    if (field.fade(6.0) > 0).any():
        h1, h2 = field.worley(6.0, warp)
        hair = (1 - _smooth(np, 0, np.maximum(.004, 1.1 * texel), h2 - h1)) * _smooth(np, .58, .72, field.fbm(3.0, 1)) * field.fade(6.0)
    rgb = rgb * (1 - .45 * crack * (.6 + .4 * medium) - .22 * hair)[:, None]
    height = height - .01 * crack - .003 * hair
    rough = rough + .12 * crack
    steep = 1 - _smooth(np, .55, .92, np.abs(up))
    # Strata: warped, dipping beds of uneven thickness in world metres, each bed its own tone; only
    # some partings open, and those at least two texels wide, so beds read as bands, not stripes.
    thickness = .45 if outcrop else .22
    bend = field.fbm(.5, 2)
    s = (p[:, 2] + .05 * p[:, 0] + .03 * p[:, 1] + 1.4 * thickness * (bend - .5)) / thickness
    s = s + .35 * np.sin(s * 2.1 + 1.3) + .2 * np.sin(s * 3.7)
    bed = np.floor(s)
    shade = rng.random(4096)[bed.astype(np.int64) % 4096]
    edge = np.minimum(s - bed, bed + 1 - s) * thickness
    parting = (1 - _smooth(np, 0, np.maximum(.025, 2.2 * texel), edge)) * _smooth(np, .4, .65, field.fbm(.9, 2))
    strength = (1.0 if outcrop else .15) * (.25 + .75 * steep)
    rgb = rgb * (1 + strength[:, None] * (.16 * (shade[:, None] - .5) - .2 * parting[:, None]))
    height = height + strength * (.005 * shade - .007 * parting)
    # Rain streaks: dark vertical stains on the steep faces.
    streak = field.fbm(1.6, 3, stretch=(2.5, 2.5, .2)) * _smooth(np, .3, .7, field.fbm(.5, 2))
    rgb = rgb * (1 - .28 * _smooth(np, .35, .62, streak) * steep)[:, None]
    # Lichen: pale and rust crusts in clusters; rosettes where texels are fine enough to show them.
    cover = _smooth(np, .56, .76, field.fbm(2.2, 3))
    show = field.fade(12.0)
    rosette = .45 * (1 - show)
    if (show > 0).any():
        l1, _ = field.worley(12.0)
        rosette = rosette + (1 - _smooth(np, .01, .04, l1)) * show
    spots = field.fbm(40.0, 1)
    lichen = rosette * cover * .4 * (.7 + .3 * spots) * (1 - _smooth(np, .02, .25, tunnel))
    pale = np.array([.2, .21, .17]) * (.85 + .3 * spots[:, None])
    rust = np.array([.34, .22, .07])
    hue = _smooth(np, .62, .75, field.fbm(5.0, 1))[:, None]
    rgb = rgb + (pale + (rust - pale) * hue * .6 - rgb) * lichen[:, None]
    height = height + .0008 * lichen
    rough = rough + .06 * lichen
    # Occlusion: crevices darken, exposed edges catch a little light, rock darkens where it meets the
    # ground, and the tunnel darkens toward its back.
    crevice, exposed = np.clip(cavity, 0, 1), np.clip(-cavity, 0, 1)
    contact = 1 - _smooth(np, 0, .06 * top + .03, p[:, 2])
    shadow = (1 - .38 * crevice) * (1 + .1 * exposed) * (1 - .3 * contact) * (1 - .86 * _smooth(np, 0, 1, tunnel) ** .8)
    rgb = rgb * shadow[:, None]
    if moss:
        # Moss mask from the smoothed up-facing normal, crevices and multi-octave world noise, with
        # a texel-resolution ragged fringe; never in the tunnel or under overhangs.
        lay = (.8 * _smooth(np, .1, .85, soft_up) + .45 * crevice * (soft_up > -.2) - .25 * exposed
               - .35 * (1 - _smooth(np, .02, .12, p[:, 2] / top)))
        patch = field.fbm(.9 * min(1.0, 3.0 / extent) + .3, 4)
        fringe = field.fbm(14.0, 2)
        amount = lay + 1.1 * (patch - .5) + .25 * (fringe - .5) - .5 * _smooth(np, .05, .4, tunnel)
        coverage = _smooth(np, .52, .66, amount) * _smooth(np, -.3, .2, soft_up)
        tufts = field.fbm(80.0, 2)
        clumps = field.fbm(6.0, 3)
        green = np.array([.025, .045, .012]) + np.array([.05, .065, .016]) * tufts[:, None]
        green = green + (np.array([.09, .1, .03]) - green) * _smooth(np, .5, .8, clumps)[:, None] * .5
        green = green * (1 - .35 * crevice)[:, None]
        rgb = rgb + (green - rgb) * coverage[:, None]
        height = height * (1 - coverage) + (.008 + .006 * tufts) * coverage
        rough = rough + (.96 - rough) * coverage
    rough = rough + (.95 - rough) * _smooth(np, .2, 1, tunnel) * .5
    # Back to the texture grid; unused atlas space is the mean stone, flat and matte.
    mean = rgb[texels[filled]].mean(axis=0) if texels.any() else base * .5
    grid_rgb = np.empty((size * size, 3))
    grid_rgb[:] = mean
    grid_rgb[filled] = rgb
    grid_height = np.zeros(size * size)
    grid_height[filled] = height
    grid_rough = np.full(size * size, .85)
    grid_rough[filled] = rough
    grid_mu, grid_mv = np.ones(size * size), np.ones(size * size)
    grid_mu[filled], grid_mv[filled] = mu, mv
    height, mu, mv = (a.reshape(size, size) for a in (grid_height, grid_mu, grid_mv))
    # Tangent-space normals (+X = +u, +Y = +v) from the height field, in metres per texel.
    gx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) / (2 * mu)
    gy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) / (2 * mv)
    tangent = np.stack([-gx, -gy, np.ones_like(gx)], axis=-1)
    tangent[~filled.reshape(size, size)] = (0.0, 0.0, 1.0)
    return (np.clip(grid_rgb.reshape(size, size, 3), 0, 1), np.ones((size, size)), _unit(np, tangent),
            np.clip(grid_rough.reshape(size, size), .4, 1.0))


def _checked_leaf_scale(pattern, value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not .45 <= value <= 1.0 or not math.isfinite(value) or (value != 1.0 and pattern != "oak-leaves"):
        raise ValueError("Invalid trusted oak leaf scale")
    return value


def tree_surface(pattern, color, seed, size, repeats=1, moss=False, extent=1.0, bake=None, *, leaf_scale=1.0):
    """(linear rgb HxWx3, alpha HxW, normal HxWx3, roughness HxW) for a natural tree pattern."""
    leaf_scale = _checked_leaf_scale(pattern, leaf_scale)
    np = _np()
    if pattern not in TREE_PATTERNS:
        raise ValueError("Unsupported natural tree pattern")
    rng = np.random.default_rng(seed)
    species, kind = pattern.split("-")
    if species == "rock":
        return _rock_surface(np, rng, color, size, kind, extent, bool(moss), bake)
    if kind == "log":
        if not isinstance(repeats, int) or not 1 <= repeats <= 8:
            raise ValueError("Log bark repeats must be 1..8")
        return _log_surface(np, rng, species, color, size, repeats, bool(moss))
    if kind == "bark":
        return {"oak": _oak_bark, "birch": _birch_bark, "pine": _pine_bark}[species](np, rng, color, size)
    extra = {"leaf_scale": leaf_scale} if leaf_scale < 1.0 else {}
    return _leaf_atlas(np, rng, species, color, size, **extra)


def tree_pixels(pattern, color, metallic, seed, size, repeats=1, moss=False, extent=1.0, bake=None, *, leaf_scale=1.0):
    """Flat float32 RGBA arrays (bpy pixel order) for the baseColor/normal/metallicRoughness roles.
    Base colour alpha is leaf coverage for the atlases and exactly 1 for bark."""
    leaf_scale = _checked_leaf_scale(pattern, leaf_scale)
    np = _np()
    extra = {"leaf_scale": leaf_scale} if leaf_scale < 1.0 else {}
    rgb, alpha, normal, rough = tree_surface(pattern, color, seed, size, repeats, moss, extent, bake, **extra)
    rgb = np.clip(rgb, 0, 1)
    encoded = np.where(rgb <= .0031308, 12.92 * rgb, 1.055 * np.power(rgb, 1 / 2.4) - .055)
    ones = np.ones(alpha.shape)
    base = np.dstack([encoded, np.clip(alpha, 0, 1)])
    normal_px = np.dstack([normal * .5 + .5, ones])
    mr = np.dstack([ones, np.clip(rough, 0, 1), np.full(alpha.shape, clamp(metallic)), ones])
    return {role: values.astype(np.float32).ravel() for role, values in (("baseColor", base), ("normal", normal_px), ("metallicRoughness", mr))}
