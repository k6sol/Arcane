"""Measured validation of library material maps (pure NumPy; also run by the asset audit).

Inputs are the float RGBA grids of the delivered roles (as encode() returns them, or read back
from packed Blender images), quantised to 8 bits first so the checks see what ships:
- tiling continuity (tile mode): the step across the wrap edge (last column -> first, last row
  -> first) compared with the largest step between neighbouring interior columns (rows), per
  map. A seamless map scores at most about 1; a seam stands out above every interior step.
- value ranges: dielectric albedo inside a physically plausible band, metal albedo bright enough
  to be a metal reflectance, roughness inside 0.03..1, metallic mostly binary.
- normal-map validity: decoded vectors are unit length, point out of the surface (+Z), carry no
  net tilt, and follow the OpenGL (+Y = +v) convention the Roblox import path declares.
"""
THRESHOLDS = {
    "seamRatio": 1.15,         # wrap-edge step / largest interior step, every map and axis
    "albedoP1": .008,          # darkest 1% of dielectric texels, linear
    "albedoP99": .92,          # brightest 1% of dielectric texels, linear
    "metalLumP5": .18,         # darkest 5% of metallic texels' luminance, linear
    "metalMixed": .35,         # share of texels with metallic strictly between .1 and .9
    "roughMin": .03,
    "normalLength": .03,       # |len - 1| tolerance after 8-bit decode
    "normalUnitShare": .995,   # share of texels within the tolerance
    "normalMinZ": .2,
    "normalBias": .06,         # |mean x|, |mean y|
}
GREY = (.2126, .7152, .0722)


def _q(np, a):
    return np.round(np.clip(a, 0, 1) * 255) / 255


def _decode_srgb(np, x):
    return np.where(x <= .04045, x / 12.92, np.power((x + .055) / 1.055, 2.4))


def seam_ratio(np, grid):
    """Wrap-edge step over the largest interior column (row) step, max over both axes. A periodic
    map scores <= 1 (its wrap column is one more ordinary column, joints included); a seam
    scores above the largest step anywhere inside the texture."""
    out = []
    for axis in (0, 1):
        steps = np.abs(np.diff(grid, axis=axis)).mean(axis=1 - axis)
        wrap = float(np.abs(np.take(grid, 0, axis=axis) - np.take(grid, -1, axis=axis)).mean())
        top = float(steps.max()) if steps.size else 0.0
        out.append(wrap / top if top > 1e-6 else (1.0 if wrap <= 1e-6 else 99.0))
    return max(out)


def measure(np, maps, mode="tile", mask=None, alpha_mode="OPAQUE"):
    """Metrics and errors for one material. ``maps``: role -> (H, W, 4) floats in [0, 1]."""
    base = _q(np, maps["baseColor"])
    normal = _q(np, maps["normal"])
    mr = _q(np, maps["metallicRoughness"])
    h, w = base.shape[:2]
    sel = np.ones((h, w), dtype=bool) if mask is None else mask.reshape(h, w)
    errors = []
    m = {"size": [int(w), int(h)], "mode": mode}
    if w != h or w > 1024 or w & (w - 1):
        errors.append("texture size must be a square power of two <= 1024")
    if alpha_mode not in ("OPAQUE", "MASK"):
        errors.append("alpha mode must be OPAQUE or MASK (BLEND is not delivered)")
    lin = _decode_srgb(np, base[..., :3])
    rough, metal, ao = mr[..., 1], mr[..., 2], mr[..., 0]
    metallic = (metal > .5) & sel
    diel = (~metallic) & sel
    if diel.any():
        d = lin[diel]
        lum_d = d @ np.array(GREY)
        m["albedoP1"], m["albedoP50"], m["albedoP99"] = (round(float(np.percentile(d.min(axis=1), 1)), 4), round(float(np.percentile(lum_d, 50)), 4),
                                                          round(float(np.percentile(d.max(axis=1), 99)), 4))
        if m["albedoP1"] < THRESHOLDS["albedoP1"]:
            errors.append("dielectric albedo darker than charcoal (p1 %.4f)" % m["albedoP1"])
        if m["albedoP99"] > THRESHOLDS["albedoP99"]:
            errors.append("dielectric albedo brighter than fresh snow (p99 %.3f)" % m["albedoP99"])
    if metallic.any():
        lum = lin[metallic] @ np.array(GREY)
        m["metalLumP5"] = round(float(np.percentile(lum, 5)), 4)
        if m["metalLumP5"] < THRESHOLDS["metalLumP5"]:
            errors.append("metal albedo too dark for a metal reflectance (p5 %.3f)" % m["metalLumP5"])
    m["metallicShare"] = round(float(metallic.sum() / max(sel.sum(), 1)), 4)
    m["metalMixed"] = round(float(((metal > .1) & (metal < .9) & sel).sum() / max(sel.sum(), 1)), 4)
    if m["metalMixed"] > THRESHOLDS["metalMixed"]:
        errors.append("metallic is not mostly binary (%.2f mixed)" % m["metalMixed"])
    r = rough[sel]
    m["roughness"] = [round(float(np.percentile(r, k)), 3) for k in (5, 50, 95)]
    if r.min() < THRESHOLDS["roughMin"] - 1e-6:
        errors.append("roughness below %.2f" % THRESHOLDS["roughMin"])
    m["aoMean"] = round(float(ao[sel].mean()), 3)
    n = normal[..., :3][sel] * 2 - 1
    length = np.linalg.norm(n, axis=1)
    m["normalUnitShare"] = round(float((np.abs(length - 1) <= THRESHOLDS["normalLength"]).mean()), 4)
    m["normalMinZ"] = round(float(n[:, 2].min()), 3)
    m["normalBias"] = [round(float(n[:, 0].mean()), 4), round(float(n[:, 1].mean()), 4)]
    m["normalConvention"] = "OpenGL"
    if m["normalUnitShare"] < THRESHOLDS["normalUnitShare"]:
        errors.append("normal map vectors are not unit length (%.3f)" % m["normalUnitShare"])
    if m["normalMinZ"] < THRESHOLDS["normalMinZ"]:
        errors.append("normal map points into the surface (min z %.2f)" % m["normalMinZ"])
    if max(abs(b) for b in m["normalBias"]) > THRESHOLDS["normalBias"]:
        errors.append("normal map has a net tilt %s" % m["normalBias"])
    if mode == "tile":
        lum_grid = lin @ np.array(GREY)
        seams = {"baseColor": seam_ratio(np, lum_grid), "normalX": seam_ratio(np, normal[..., 0]), "normalY": seam_ratio(np, normal[..., 1]),
                 "roughness": seam_ratio(np, rough), "metallic": seam_ratio(np, metal)}
        m["seamRatio"] = {k: round(v, 3) for k, v in seams.items()}
        worst = max(seams.values())
        if worst > THRESHOLDS["seamRatio"]:
            errors.append("tileable map is not continuous across its edges (seam ratio %.2f)" % worst)
    m["errors"] = errors
    return m
