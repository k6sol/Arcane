"""Material library core: evaluation domains, parameters, weathering, normals and Roblox encoding.

A material family (mat_families) is a function of a ``Domain`` (where the texels are, in metres)
and its parameters, returning ``Layers`` (linear albedo, height in metres, roughness, metallic,
optional emission/alpha, a pattern ``recess`` mask where dirt and moss collect, and what wear
reveals). This module then weathers the layers with mesh-aware or height-derived masks, derives
tangent-space normals from the height, and encodes the Roblox SurfaceAppearance-ready maps.

Two domains:
- ``tile_domain``: a size x size grid covering ``tile_m`` metres; every frequency is snapped to a
  whole number of cells per tile and the noise lattice wraps, so the maps repeat exactly. This is
  the UV engine's world-scale ``mode="tile"`` convention: 1 UV unit = tile_m metres, +v = up.
- ``bake_domain``: per-texel samples rasterised from an asset's own UV charts (world position,
  normal, edge convexity, cavity occlusion, metres per texel), so effects follow the mesh.

Roblox conventions (verified against packages/asset-pipeline/src/studio-import-textures.ts and
plugin/src/AssetMaterials.luau): ColorMap is sRGB; NormalMap is tangent-space OpenGL (+Y = +v,
no green flip, normal scale 1); roughness/metalness are read from the G/B channels of the glTF
metallicRoughness image (R carries ambient occlusion, ORM order, and is ignored by the importer);
1024 px per axis at most; alpha OPAQUE or MASK (cutoff .5), BLEND is rejected.
"""
import math

from mat_noise import seed_of, fbm, ridge, cells, smooth, box_blur

SIZES = (128, 256, 512, 1024)
MAX_SIZE = 1024
ALPHA_MODES = ("OPAQUE", "MASK")
PARAM_BOUNDS = {"scale": (.25, 4.0), "wear": (0.0, 1.0), "dirt": (0.0, 1.0), "moss": (0.0, 1.0), "age": (0.0, 1.0),
                "snow": (0.0, 1.0), "strength": (0.0, 20.0), "joints": (0.0, 1.0), "seams": (0.0, 1.0)}
VECTOR_PARAMS = ("color", "glow")
DIRT = (.075, .058, .04)
MOSS_DARK, MOSS_LIGHT = (.03, .055, .012), (.11, .14, .035)
SNOW = (.8, .83, .88)
GREY = (.2126, .7152, .0722)


class MaterialError(ValueError):
    """Bounded validation message for material requests."""


def validate_params(defaults, params):
    """Merge ``params`` over the family defaults with bounds; unknown keys are rejected."""
    params = dict(params or {})
    out = dict(defaults)
    for key, value in params.items():
        if key not in defaults:
            raise MaterialError("Unknown material parameter " + str(key)[:24])
        if key in VECTOR_PARAMS:
            if not isinstance(value, (list, tuple)) or len(value) != 3 or not all(isinstance(c, (int, float)) and not isinstance(c, bool) and math.isfinite(c) and 0 <= c <= 1 for c in value):
                raise MaterialError("Material " + key + " must be three linear values in 0..1")
            out[key] = tuple(float(c) for c in value)
        else:
            low, high = PARAM_BOUNDS[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
                raise MaterialError("Material " + key + " must be within %g..%g" % (low, high))
            out[key] = float(value)
    return out


class Domain:
    """Texel positions for one evaluation. ``p`` world metres (N, 3); ``f`` the surface frame
    (along/horizontal, across/vertical, depth) in metres; ``n`` world normals or None (tile);
    ``texel`` metres per texel (scalar or (N,)); ``tile`` the period in metres or None."""

    def __init__(self, np, mode, p, f, n, texel, seed, tile=None, shape=None, edge=None, cavity=None, mu=None, mv=None, valid=None):
        self.np, self.mode, self.p, self.f, self.n = np, mode, p, f, n
        self.texel, self.seed, self.tile, self.shape = texel, int(seed), tile, shape
        self.edge, self.cavity, self.mu, self.mv, self.valid = edge, cavity, mu, mv, valid
        self.count = len(p)

    def key(self, name):
        return seed_of(self.seed, name)

    def snap(self, freq):
        """(frequency, lattice period) for a periodic axis: whole cells per tile."""
        if self.tile is None:
            return freq, 0
        n = max(1, int(round(freq * self.tile)))
        return n / self.tile, n

    def fit(self, length, multiple=1):
        """A feature length that divides the tile a whole (``multiple``) number of times."""
        if self.tile is None:
            return length
        n = max(multiple, int(round(self.tile / length / multiple)) * multiple)
        return self.tile / n

    def count_of(self, length):
        """Whole repeats of ``length`` per tile (period in feature units), or 0 when not tiling."""
        return 0 if self.tile is None else max(1, int(round(self.tile / length)))

    def _lattice(self, coords, freq, stretch):
        np = self.np
        fr, per = [], []
        for k in range(3):
            if k < 2 and self.tile is not None:
                a, b = self.snap(freq * stretch[k])
            else:
                a, b = freq * stretch[k], 0
            fr.append(a)
            per.append(b)
        q = coords * np.array(fr)
        texel = self.texel * max(fr)
        return q, tuple(per), texel

    def noise(self, name, freq, octaves=1, gain=.5, stretch=(1.0, 1.0, 1.0), space="p"):
        """Fractal noise in [0, 1] at ``freq`` cycles per metre (``space`` p: world, f: frame)."""
        q, per, texel = self._lattice(self.p if space == "p" else self.f, freq, stretch)
        return fbm(self.np, q, self.key(name), octaves, per, gain, texel)

    def ridges(self, name, freq, octaves=1, stretch=(1.0, 1.0, 1.0), space="p"):
        q, per, texel = self._lattice(self.p if space == "p" else self.f, freq, stretch)
        return ridge(self.np, q, self.key(name), octaves, per, texel)

    def voronoi(self, name, freq, stretch=(1.0, 1.0), jitter=.85, warp=None):
        """2D cells over the frame axes (a, b); distances are returned in metres."""
        np = self.np
        fa, pa = self.snap(freq * stretch[0])
        fb, pb = self.snap(freq * stretch[1])
        coords = self.f[:, :2] if warp is None else self.f[:, :2] + warp
        q = coords * np.array([fa, fb])
        c = cells(np, q, self.key(name), (pa, pb), jitter)
        unit = 1.0 / math.sqrt(fa * fb)
        c["f1"], c["edge"] = c["f1"] * unit, c["edge"] * unit
        return c

    def aa(self, width):
        """A transition width (metres) never narrower than about 1.5 texels."""
        return self.np.maximum(width, 1.5 * self.texel)


def tile_domain(np, size, tile_m, seed):
    if size not in SIZES:
        raise MaterialError("Texture size must be one of 128, 256, 512, 1024")
    if not (isinstance(tile_m, (int, float)) and math.isfinite(tile_m) and .05 <= tile_m <= 16):
        raise MaterialError("Tile size must be .05..16 metres")
    t = (np.arange(size) + .5) / size * tile_m
    b, a = np.meshgrid(t, t, indexing="ij")
    a, b = a.ravel(), b.ravel()
    zero = np.zeros_like(a)
    p = np.stack([a, b, zero], axis=1)
    return Domain(np, "tile", p, p.copy(), None, tile_m / size, seed, tile=float(tile_m), shape=(size, size))


def box_frame(np, p, n):
    """Box projection frame per texel: (horizontal, vertical, depth) on the dominant normal axis,
    reading left to right as seen from outside the face."""
    ax, ay, az = np.abs(n[:, 0]), np.abs(n[:, 1]), np.abs(n[:, 2])
    sx, sy, sz = np.sign(n[:, 0] + 1e-12), np.sign(n[:, 1] + 1e-12), np.sign(n[:, 2] + 1e-12)
    top = (az >= ax) & (az >= ay)
    side_x = ~top & (ax >= ay)
    a = np.where(top, p[:, 0], np.where(side_x, p[:, 1] * sx, -p[:, 0] * sy))
    b = np.where(top, p[:, 1] * sz, p[:, 2])
    c = np.where(top, p[:, 2], np.where(side_x, p[:, 0], p[:, 1]))
    return np.stack([a, b, c], axis=1)


def axis_frame(np, p, axis, centre, radius):
    """Cylindrical frame round a world axis: (along the axis, arc length at ``radius``, radial
    depth). Grain runs along the axis; plank seams fall at fixed angles (barrel staves)."""
    axis = np.asarray(axis, dtype=float)
    axis = axis / np.linalg.norm(axis)
    helper = np.array([1.0, 0, 0]) if abs(axis[0]) < .9 else np.array([0, 1.0, 0])
    e1 = np.cross(axis, helper)
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(axis, e1)
    rel = p - np.asarray(centre, dtype=float)
    x, y = rel @ e1, rel @ e2
    r = np.sqrt(x * x + y * y)
    return np.stack([rel @ axis, np.arctan2(y, x) * radius, r - radius], axis=1)


def bake_domain(np, samples, seed, frame="box", axis=(0, 0, 1), centre=(0, 0, 0), radius=None):
    """Domain over the covered texels of a baked chart atlas (see mat_bake.rasterise)."""
    m = samples["filled"].ravel()
    p = samples["position"].reshape(-1, 3)[m]
    n = samples["normal"].reshape(-1, 3)[m]
    n = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    mu, mv = samples["mu"].ravel()[m], samples["mv"].ravel()[m]
    texel = np.maximum(np.maximum(mu, mv), 1e-5)
    if frame == "box":
        f = box_frame(np, p, n)
    elif frame == "axis":
        if radius is None:
            rel = p - np.asarray(centre, dtype=float)
            ax = np.asarray(axis, dtype=float) / np.linalg.norm(axis)
            radius = float(np.median(np.linalg.norm(rel - np.outer(rel @ ax, ax), axis=1)))
        f = axis_frame(np, p, axis, centre, max(radius, 1e-3))
        # Caps (faces across the axis: barrel heads) take the box frame: parallel boards.
        cap = np.abs(n @ (np.asarray(axis, dtype=float) / np.linalg.norm(axis))) > .7
        f[cap] = box_frame(np, p[cap], n[cap])
    elif frame == "parts":
        # Each connected part's own principal axes: grain along its longest side (planks,
        # braces, blades), across its width, depth through its thinnest dimension.
        pid = samples["part"].ravel()[m]
        rel = p - samples["partCentres"][pid]
        f = np.einsum("nij,nj->ni", samples["partAxes"][pid], rel)
    elif frame == "local":
        f = samples["local"].reshape(-1, 3)[m]
    else:
        raise MaterialError("Unknown bake frame")
    edge = samples.get("edge")
    cavity = samples.get("cavity")
    return Domain(np, "bake", p, f, n, texel, seed, shape=samples["filled"].shape,
                  edge=None if edge is None else edge.ravel()[m], cavity=None if cavity is None else cavity.ravel()[m],
                  mu=mu, mv=mv, valid=m)


class Layers:
    """What a family returns. Arrays are (N,) or (N, 3) over the domain's texels."""

    def __init__(self, albedo, height, rough, metal, *, emit=None, alpha=None, recess=None, under=None, aged=None,
                 chip=.0006, moss_ok=1.0, wear_shape=None):
        self.albedo, self.height, self.rough, self.metal = albedo, height, rough, metal
        self.emit, self.alpha, self.recess = emit, alpha, recess
        # What wear reveals: dict(albedo, rough, metal); default a lighter, smoother edge.
        self.under = under
        # What age turns the surface into: dict(albedo, rough, metal).
        self.aged = aged
        self.chip = chip
        self.moss_ok = moss_ok
        self.wear_shape = wear_shape


def luminance(np, rgb):
    return rgb @ np.array(GREY)


def desaturate(np, rgb, amount):
    lum = luminance(np, rgb)[:, None]
    return rgb + (lum - rgb) * amount


def mix(a, b, t):
    return a + (b - a) * t


def _grid(np, dom, values, fill=0.0):
    """(N,) or (N, C) texel values back onto the domain grid (H, W[, C])."""
    h, w = dom.shape
    if dom.valid is None:
        return values.reshape((h, w) + values.shape[1:])
    out = np.full((h * w,) + values.shape[1:], fill, dtype=float)
    out[dom.valid] = values
    return out.reshape((h, w) + values.shape[1:])


def micro_masks(np, dom, height):
    """Height-derived convexity and cavity in [0, 1] (ridges vs. hollows of the material's own
    relief, a few millimetres across), periodic in tile mode."""
    grid = _grid(np, dom, height, float(height.mean()) if len(height) else 0.0)
    radius = max(1, int(round(.006 / float(np.mean(dom.texel)))))
    radius = min(radius, 6)
    blurred = box_blur(np, grid, radius, periodic=dom.mode == "tile")
    wide = box_blur(np, grid, radius * 3, periodic=dom.mode == "tile")
    diff = (grid - blurred) + .6 * (grid - wide)
    if dom.valid is not None:
        diff = diff.ravel()[dom.valid]
    else:
        diff = diff.ravel()
    spread = max(float(np.percentile(np.abs(diff), 90)), .0005)
    return np.clip(diff / spread, 0, 1), np.clip(-diff / spread, 0, 1)


def weather(np, dom, L, prm):
    """Apply age, edge wear, cavity dirt, moss and snow to the layers in place."""
    n = dom.count
    conv, hollow = micro_masks(np, dom, L.height)
    recess = np.zeros(n) if L.recess is None else L.recess
    if dom.mode == "bake":
        edge = np.clip(dom.edge if dom.edge is not None else np.zeros(n), 0, 1)
        cav = np.clip(dom.cavity if dom.cavity is not None else np.zeros(n), 0, 1)
        edge = np.maximum(edge, .35 * conv)
        cav = np.maximum(cav, .45 * hollow)
        up = dom.n[:, 2]
    else:
        edge = .55 * conv
        cav = .6 * hollow
        up = None
    breakup = dom.noise("wear-breakup", 9.0, 3)
    fine = dom.noise("wear-fine", 55.0, 2)
    grime = dom.noise("grime", 3.0, 4)
    albedo, rough, metal, height = L.albedo, L.rough, L.metal, L.height
    # Age: the family's aged look (weathered grey wood, tarnish, faded paint) in patches.
    age = prm.get("age", 0.0)
    if age > 0:
        aged = L.aged or {}
        target = aged.get("albedo", desaturate(np, albedo, .45) * .78)
        amount = np.clip(age * (.75 + .5 * (dom.noise("age-patch", 4.0, 4) - .5)), 0, 1)
        albedo = mix(albedo, target, amount[:, None])
        rough = mix(rough, aged.get("rough", np.minimum(rough + .18, 1.0)), amount)
        metal = mix(metal, aged.get("metal", metal), amount)
    # Edge wear: convex edges chip and polish, broken up by noise so it never reads as a stroke.
    wear = prm.get("wear", 0.0)
    worn = np.zeros(n)
    if wear > 0:
        threshold = 1.0 - .75 * wear
        shape = edge * (.55 + .75 * breakup + .3 * (fine - .5))
        # Never more than a wear-proportional share of the surface: thin parts (bars, grips,
        # rivets) are convex everywhere, but only their most exposed arrises should wear.
        if n:
            share = .04 + .22 * wear
            threshold = max(threshold, float(np.quantile(shape, 1 - share)) - .02)
        worn = smooth(np, threshold - .12, threshold + .08, shape) * smooth(np, 0, .12, wear)
        if L.wear_shape is not None:
            worn = worn * L.wear_shape
        under = L.under or {}
        albedo = mix(albedo, under.get("albedo", np.clip(albedo * 1.35, 0, 1)), worn[:, None])
        rough = mix(rough, under.get("rough", np.clip(rough - .12, .05, 1)), worn)
        metal = mix(metal, under.get("metal", metal), worn)
        height = height - L.chip * worn * smooth(np, .45, .6, fine)
    # Cavity dirt: occluded creases, pattern recesses (mortar, gaps) and broad grime.
    dirt = prm.get("dirt", 0.0)
    dirty = np.zeros(n)
    if dirt > 0:
        shape = cav * (.75 + .5 * grime) + .55 * recess + .25 * (grime - .5)
        dirty = np.clip(smooth(np, .18, .75, shape) * (.35 + .65 * dirt) * smooth(np, 0, .1, dirt) + .1 * dirt * smooth(np, .5, .8, grime), 0, 1)
        dirty = dirty * (1 - .6 * worn)
        tint = np.array(DIRT) * (.7 + .6 * dom.noise("dirt-tone", 12.0, 2))[:, None]
        albedo = mix(albedo, tint, (.82 * dirty)[:, None])
        rough = mix(rough, np.full(n, .9), dirty)
        metal = metal * (1 - dirty)
    # Moss: sky-facing surfaces (baked), creases and recesses, in soft irregular patches.
    moss = prm.get("moss", 0.0)
    mossy = np.zeros(n)
    if moss > 0:
        upness = smooth(np, .05, .85, up) if up is not None else np.full(n, .45)
        under_side = smooth(np, -.25, .15, up) if up is not None else np.ones(n)
        patch = dom.noise("moss-patch", 2.4, 4)
        fringe = dom.noise("moss-fringe", 28.0, 2)
        lay = .75 * upness + .45 * cav + .3 * recess + 1.1 * (patch - .5) + .3 * (fringe - .5) - .55 * (1 - moss)
        mossy = smooth(np, .42, .58, lay) * under_side * smooth(np, 0, .1, moss) * L.moss_ok
        tufts = dom.noise("moss-tufts", 160.0, 2)
        clumps = dom.noise("moss-clumps", 14.0, 3)
        green = mix(np.array(MOSS_DARK), np.array(MOSS_LIGHT), (.35 * tufts + .65 * clumps)[:, None])
        green = green * (1 - .3 * cav)[:, None]
        albedo = mix(albedo, green, mossy[:, None])
        rough = mix(rough, np.full(n, .95), mossy)
        metal = metal * (1 - mossy)
        height = height + mossy * (.0015 + .002 * tufts)
    # Snow: settles on up-facing surfaces (baked) and fills hollows.
    snow = prm.get("snow", 0.0)
    snowy = np.zeros(n)
    if snow > 0:
        upness = smooth(np, .3, .75, up) if up is not None else np.full(n, .5)
        drift = dom.noise("snow-drift", 3.0, 4)
        lay = 1.1 * upness + .5 * cav + .4 * recess + .8 * (drift - .5) - 1.0 * (1 - snow)
        snowy = smooth(np, .35, .5, lay) * L.moss_ok
        sparkle = dom.noise("snow-sparkle", 220.0, 1)
        white = np.array(SNOW) * (.94 + .1 * sparkle)[:, None]
        white = mix(white, white * np.array([.9, .95, 1.0]), (.5 * cav)[:, None])
        albedo = mix(albedo, white, snowy[:, None])
        rough = mix(rough, .72 + .12 * sparkle, snowy)
        metal = metal * (1 - snowy)
        height = height + snowy * (.002 + .002 * drift)
    emit = L.emit
    if emit is not None:
        emit = emit * (1 - mossy - snowy).clip(0, 1)[:, None] * (1 - .5 * dirty)[:, None]
    L.albedo, L.rough, L.metal, L.height, L.emit = np.clip(albedo, 0, 1), np.clip(rough, .03, 1), np.clip(metal, 0, 1), height, emit
    ao = np.clip(1 - .55 * hollow - (.65 * np.clip(dom.cavity, 0, 1) if dom.mode == "bake" and dom.cavity is not None else 0), .15, 1)
    return {"worn": worn, "dirty": dirty, "mossy": mossy, "snowy": snowy, "ao": ao}


def normals(np, dom, height, max_slope=2.5):
    """Tangent-space unit normals (+X = +u, +Y = +v: OpenGL) from the height in metres.

    Tile mode differentiates periodically (np.roll) so the normal map tiles exactly. Bake mode
    differentiates over the atlas grid in metres per texel, using a neighbour only when its world
    position is about one texel away (same chart); otherwise the one-sided difference, so chart
    borders never produce false creases."""
    h_grid = _grid(np, dom, height, 0.0)
    if dom.mode == "tile":
        step = dom.texel
        gx = (np.roll(h_grid, -1, 1) - np.roll(h_grid, 1, 1)) / (2 * step)
        gy = (np.roll(h_grid, -1, 0) - np.roll(h_grid, 1, 0)) / (2 * step)
        gx, gy = gx.ravel(), gy.ravel()
    else:
        h, w = dom.shape
        pos = _grid(np, dom, dom.p, 0.0)
        mu, mv = _grid(np, dom, dom.mu, 1.0), _grid(np, dom, dom.mv, 1.0)
        ok = dom.valid.reshape(h, w)

        def deriv(axis, metric):
            fwd_h, back_h = np.roll(h_grid, -1, axis), np.roll(h_grid, 1, axis)
            fwd_p, back_p = np.roll(pos, -1, axis), np.roll(pos, 1, axis)
            fwd_ok, back_ok = np.roll(ok, -1, axis), np.roll(ok, 1, axis)
            df = np.linalg.norm(fwd_p - pos, axis=-1)
            db = np.linalg.norm(back_p - pos, axis=-1)
            good_f = fwd_ok & (df > .3 * metric) & (df < 2.2 * metric)
            good_b = back_ok & (db > .3 * metric) & (db < 2.2 * metric)
            both = good_f & good_b
            g = np.where(both, (fwd_h - back_h) / (2 * metric), np.where(good_f, (fwd_h - h_grid) / metric, np.where(good_b, (h_grid - back_h) / metric, 0.0)))
            return g
        gx = deriv(1, mu).ravel()[dom.valid]
        gy = deriv(0, mv).ravel()[dom.valid]
    gx, gy = np.clip(gx, -max_slope, max_slope), np.clip(gy, -max_slope, max_slope)
    length = np.sqrt(gx * gx + gy * gy + 1)
    return np.stack([-gx / length, -gy / length, 1 / length], axis=1)


def srgb_encode(np, x):
    x = np.clip(x, 0, 1)
    return np.where(x <= .0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - .055)


def srgb_decode(np, x):
    x = np.clip(x, 0, 1)
    return np.where(x <= .04045, x / 12.92, np.power((x + .055) / 1.055, 2.4))


def encode(np, dom, L, masks, ao_in_albedo=.5):
    """Float RGBA grids (H, W, 4; rows bottom-up like bpy pixels) for the delivered roles plus the
    optional emissive and height maps. AO also multiplies the colour map (``ao_in_albedo``)
    because Roblox SurfaceAppearance has no occlusion slot."""
    h, w = dom.shape
    ao = masks["ao"]
    albedo = L.albedo * (1 - ao_in_albedo * (1 - ao))[:, None]
    # Physically plausible dielectric band (charcoal .012 .. fresh snow .9, linear); metals keep
    # their reflectance colour.
    dielectric = (L.metal < .5)[:, None]
    albedo = np.where(dielectric, np.clip(albedo, .012, .9), albedo)
    n = normals(np, dom, L.height)
    fill_albedo = albedo.mean(axis=0) if len(albedo) else np.full(3, .5)
    alpha = np.ones(dom.count) if L.alpha is None else np.where(L.alpha >= .5, 1.0, 0.0)
    base = np.concatenate([srgb_encode(np, albedo), alpha[:, None]], axis=1)
    normal = np.concatenate([n * .5 + .5, np.ones((dom.count, 1))], axis=1)
    mr = np.stack([ao, L.rough, L.metal, np.ones(dom.count)], axis=1)
    fills = {"baseColor": list(srgb_encode(np, fill_albedo)) + [1.0], "normal": [.5, .5, 1.0, 1.0],
             "metallicRoughness": [1.0, float(np.median(L.rough)) if len(L.rough) else .8, float(np.median(L.metal)) if len(L.metal) else 0.0, 1.0]}
    out = {}
    for role, values in (("baseColor", base), ("normal", normal), ("metallicRoughness", mr)):
        grid = np.empty((h * w, 4))
        grid[:] = fills[role]
        if dom.valid is None:
            grid[:] = values
        else:
            grid[dom.valid] = values
        out[role] = grid.reshape(h, w, 4)
    if L.emit is not None:
        e = np.zeros((h * w, 4))
        e[:, 3] = 1
        peak = max(float(L.emit.max()), 1e-6)
        values = np.concatenate([srgb_encode(np, L.emit / peak), np.ones((dom.count, 1))], axis=1)
        if dom.valid is None:
            e[:] = values
        else:
            e[dom.valid] = values
        out["emissive"] = e.reshape(h, w, 4)
        out["_emissiveStrength"] = peak
    hg = np.zeros(h * w)
    if dom.valid is None:
        hg[:] = L.height
    else:
        hg[dom.valid] = L.height
    out["_height"] = hg.reshape(h, w)
    out["_alphaMode"] = "MASK" if L.alpha is not None and (alpha < 1).any() else "OPAQUE"
    return out
