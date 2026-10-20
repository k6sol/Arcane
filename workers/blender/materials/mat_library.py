"""Arcane procedural PBR material library: request a material by name plus parameters.

    import mat_library as L
    tiled = L.tile("stone-ashlar", {"wear": .4}, size=512, tile_m=4.0, seed=7)
    baked = L.bake("wood-planks", samples, {"dirt": .5}, seed=7, frame="axis", axis=(0, 0, 1))

Families (mat_families.CATALOG): woods (wood-planks, wood-endgrain, wood-painted, wood-weathered),
stones (stone-cobble, stone-ashlar, stone-slate, stone-marble, stone-sandstone, concrete, brick),
metals (metal-iron, metal-rusted, metal-brass, metal-steel, metal-gold), fabric, leather, ceramic,
glass (opaque, stylised; optional inner glow), ground-foliage, sand, snow, ice, emissive-runes.
Parameters: color (linear RGB), scale (feature size multiplier), wear, dirt, moss, age, snow
(0..1); glass and runes also take glow (linear RGB) and strength (emission).

Output modes:
- ``tile``: a tileable texture covering ``tile_m`` metres (the UV engine's world-scale tile mode,
  1 UV unit = tile_m metres, +v up), so ``texelsPerMetre`` = size / tile_m matches the engine's.
- ``bake``: a unique texture over an asset's own UV charts (samples from mat_bake), with edge wear
  from convexity, cavity dirt from occlusion and up-facing moss/snow from world normals.

Both return ``{"maps": {role: (H, W, 4) floats}, "evidence": {...}}`` with the delivered roles
baseColor (sRGB), normal (OpenGL tangent space), metallicRoughness (R ambient occlusion,
G roughness, B metallic), optional emissive, and measured metrics (mat_metrics).
Deterministic for (name, params, size, seed). NumPy only; no bpy.
"""
import json

import mat_core as C
import mat_families as F
import mat_metrics as M

GENERATOR = "arcane-material-v1"
NAMES = F.NAMES
MaterialError = C.MaterialError


def _np():
    import numpy
    return numpy


def describe():
    """Catalogue for tools and schemas: name -> group, tile metres and default parameters."""
    out = {}
    for name, (_, group, profile, tile_m, defaults) in F.CATALOG.items():
        out[name] = {"group": group, "profile": profile, "tileMetres": tile_m,
                     "params": {k: (list(v) if isinstance(v, tuple) else v) for k, v in defaults.items()}}
    return out


def resolve(name, params=None):
    if name not in F.CATALOG:
        raise MaterialError("Unknown library material")
    fn, group, profile, tile_m, defaults = F.CATALOG[name]
    return fn, group, profile, tile_m, C.validate_params(defaults, params)


def _seed(seed):
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2 ** 31:
        raise MaterialError("Material seed must be an integer 0..2^31")
    return seed


def _run(np, name, dom, prm, group, profile, extra):
    fn = F.CATALOG[name][0]
    layers = fn(np, dom, prm)
    masks = C.weather(np, dom, layers, prm)
    maps = C.encode(np, dom, layers, masks)
    alpha_mode = maps.pop("_alphaMode")
    strength = maps.pop("_emissiveStrength", 0.0)
    height = maps.pop("_height")
    metrics = M.measure(np, maps, dom.mode, None if dom.valid is None else dom.valid, alpha_mode)
    evidence = {"generator": GENERATOR, "material": name, "group": group, "profile": profile, "mode": dom.mode,
                "resolution": dom.shape[0], "params": {k: (list(v) if isinstance(v, tuple) else v) for k, v in sorted(prm.items())},
                "alphaMode": alpha_mode, "alphaCutoff": .5, "normalConvention": "OpenGL", "colorSpace": {"baseColor": "sRGB", "normal": "Non-Color",
                "metallicRoughness": "Non-Color", "emissive": "sRGB"}, "channels": {"metallicRoughness": ["occlusion", "roughness", "metallic", "one"]},
                "emissiveStrength": round(float(strength), 4), "metrics": metrics,
                "coverage": {"worn": float(masks["worn"].mean()), "dirty": float(masks["dirty"].mean()),
                             "mossy": float(masks["mossy"].mean()), "snowy": float(masks["snowy"].mean())}}
    evidence["coverage"] = {k: round(v, 4) for k, v in evidence["coverage"].items()}
    evidence.update(extra)
    return {"maps": maps, "height": height, "evidence": evidence}


def tile(name, params=None, size=512, tile_m=None, seed=0):
    """Tileable maps for ``name`` over ``tile_m`` metres (default: the family's tile size)."""
    np = _np()
    _, group, profile, default_tile, prm = resolve(name, params)
    tile_m = default_tile * prm["scale"] if tile_m is None else tile_m
    dom = C.tile_domain(np, size, float(tile_m), _seed(seed))
    return _run(np, name, dom, prm, group, profile, {"tileMetres": float(tile_m), "texelsPerMetre": round(size / float(tile_m), 3)})


def bake(name, samples, params=None, seed=0, frame="box", axis=(0, 0, 1), centre=(0, 0, 0), radius=None):
    """Unique maps for ``name`` over an asset's UV charts. ``samples`` (mat_bake.rasterise plus
    optional mat_bake masks): position, normal, mu, mv, filled, edge, cavity [, local] grids."""
    np = _np()
    _, group, profile, _, prm = resolve(name, params)
    size = samples["filled"].shape[0]
    if size not in C.SIZES or samples["filled"].shape != (size, size):
        raise MaterialError("Baked textures must be square 128..1024 px")
    dom = C.bake_domain(np, samples, _seed(seed), frame, axis, centre, radius)
    ppm = float(np.median(1.0 / dom.texel)) if dom.count else 0.0
    return _run(np, name, dom, prm, group, profile, {"frame": frame, "texelsPerMetre": round(ppm, 2), "coveredTexels": int(dom.count)})


def evidence_json(result):
    return json.dumps(result["evidence"], sort_keys=True, separators=(",", ":"))
