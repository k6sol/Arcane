"""Variant families for the bundled procedural generators (procedural.py). Pure Python, stdlib only.

A request with ``procedural.variant = [i, n]`` builds member ``i`` of the ``n``-member family of
its seed and parameters. Members are not independent random rolls:

* Sampling: a digit-scrambled Halton sequence (low discrepancy) over the kind's parameter space,
  so a family covers each range evenly instead of clumping.
* Structure: a one-factor Gaussian copula couples the parameters (an older tree is taller, wider, mossier,
  darker-barked and more often damaged) while keeping every marginal uniform over its range.
* Difference: members are taken in sequence order, skipping any candidate closer than
  ``MIN_DIFFERENCE`` (weighted parameter distance) to an accepted one: no near-duplicates.
* Strata: a Latin-hypercube pass keeps the Halton ranks but gives each member its own 1/n stratum
  of every parameter, so even a 4-member family spans each range.
* Order: members are sorted by their first parameter (tree age, else overall size), so ``i = 1``
  is the youngest/smallest and ``i = n`` the oldest/largest. Scene placement relies on this.

Geometry varies through generator parameters plus mesh post-deformations (crown spread, a bent
lean towards local +X so the placement yaw chooses its direction, canopy damage that removes whole
leaf cards). Colour varies only in the authored natural-finish textures: the material factor stays
the requested colour, which is the generation/validation contract; the flat finish keeps colour.
Run in the job directory as the flat file ``variation.py`` (the pipeline copies this file there).
"""
import colorsys
import hashlib
import math
import random
from statistics import NormalDist

MAX_MEMBERS = 16
# Weighted, normalised distance floor between any two members of one family (see distance()).
MIN_DIFFERENCE = 0.2
PRIMES = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37)
_NORMAL = NormalDist()

# Per kind: (name, low, high, perceptual weight). The first dimension orders the family.
SPACES = {
    "tree": (("age", 0.0, 1.0, .8), ("height", .74, 1.28, 1.0), ("crown", .8, 1.24, 1.0), ("lean", 0.0, 7.0, .8),
             ("branch", 0.0, 1.0, .6), ("bark", .78, 1.12, .5), ("hue", -.035, .035, .5), ("sat", .8, 1.2, .4),
             ("moss", 0.0, 1.0, .5), ("damage", 0.0, 1.0, .6)),
    "rock": (("size", .75, 1.3, 1.0), ("aspect", .78, 1.28, .8), ("flat", .78, 1.2, .8), ("rough", -.2, .2, .6),
             ("tone", .84, 1.12, .5), ("moss", 0.0, 1.0, .5)),
    "foliage": (("size", .75, 1.3, 1.0), ("height", .8, 1.22, .8), ("density", .8, 1.15, .6), ("hue", -.035, .035, .5),
                ("sat", .84, 1.16, .4), ("tone", .86, 1.1, .4)),
    "log": (("size", .8, 1.25, 1.0), ("length", .75, 1.3, .9), ("tone", .82, 1.1, .5), ("moss", 0.0, 1.0, .6)),
    "stump": (("size", .8, 1.25, 1.0), ("height", .75, 1.3, .9), ("tone", .82, 1.1, .5), ("moss", 0.0, 1.0, .6)),
}
# Gaussian copula structure: each parameter's loading on the family's first dimension (tree age, else
# overall size), so e.g. an old tree is taller, wider, mossier, darker and more often damaged, plus a few
# direct residual couplings. A one-factor model keeps the latent correlation matrix positive definite.
LOADINGS = {
    "tree": {"height": .7, "crown": .45, "moss": .6, "bark": -.55, "damage": .3, "lean": .2},
    "rock": {"moss": .35, "aspect": .1},
    "foliage": {"height": .55, "density": .2},
    "log": {"length": .4, "moss": .25},
    "stump": {"height": .3, "moss": .25},
}
RESIDUALS = {"tree": {("branch", "damage"): -.2, ("moss", "bark"): -.1}, "rock": {("rough", "tone"): -.2},
             "foliage": {("density", "sat"): .3}, "log": {("moss", "tone"): -.3}, "stump": {("moss", "tone"): -.3}}
MOSS = (0.17, 0.23, 0.08)


def _hash(*parts):
    return int.from_bytes(hashlib.sha256(":".join(str(p) for p in parts).encode()).digest()[:8], "big")


def clamp(value, low, high):
    return max(low, min(high, value))


def halton(count, dims, seed):
    """``count`` points of a random-digit-scrambled Halton sequence in [0, 1)^dims (deterministic per seed)."""
    if dims > len(PRIMES):
        raise ValueError("Too many variation dimensions")
    rng = random.Random(_hash("halton", seed, dims))
    tables = []
    for d in range(dims):
        base = PRIMES[d]
        levels = int(math.ceil(40 * math.log(2) / math.log(base)))
        tables.append([rng.sample(range(base), base) for _ in range(levels)])
    points = []
    for k in range(1, count + 1):
        row = []
        for d in range(dims):
            base, table, n, f, x = PRIMES[d], tables[d], k, 1.0 / PRIMES[d], 0.0
            for perm in table:
                x += perm[n % base] * f
                n //= base
                f /= base
            row.append(min(x, 1 - 1e-12))
        points.append(row)
    return points


def cholesky(matrix):
    n = len(matrix)
    low = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1):
            s = matrix[i][j] - sum(low[i][k] * low[j][k] for k in range(j))
            if i == j:
                if s <= 1e-9:
                    raise ValueError("Variation correlations are not positive definite")
                low[i][i] = math.sqrt(s)
            else:
                low[i][j] = s / low[j][j]
    return low


def correlation(kind):
    names = [d[0] for d in SPACES[kind]]
    matrix = [[1.0 if i == j else 0.0 for j in range(len(names))] for i in range(len(names))]
    load = [1.0] + [LOADINGS[kind].get(name, 0.0) for name in names[1:]]
    for i in range(len(names)):
        for j in range(len(names)):
            if i != j:
                matrix[i][j] = load[i] * load[j]
    for (a, b), rho in RESIDUALS[kind].items():
        i, j = names.index(a), names.index(b)
        matrix[i][j] = matrix[j][i] = matrix[i][j] + rho
    return matrix


def couple(kind, points):
    """Gaussian copula: uniform Halton rows -> correlated rows with uniform marginals."""
    low = cholesky(correlation(kind))
    out = []
    for row in points:
        z = [_NORMAL.inv_cdf(clamp(u, 1e-9, 1 - 1e-9)) for u in row]
        y = [sum(low[i][k] * z[k] for k in range(i + 1)) for i in range(len(z))]
        out.append([_NORMAL.cdf(v) for v in y])
    return out


def distance(kind, a, b):
    """Weighted RMS difference of two coupled rows (0 identical .. 1 opposite corners)."""
    weights = [d[3] for d in SPACES[kind]]
    return math.sqrt(sum(w * (x - y) ** 2 for w, x, y in zip(weights, a, b)) / sum(weights))


def family_latent(kind, seed, count):
    """(latent Halton rows, coupled rows) of an n-member family, ordered by the first dimension.

    Members are taken in Halton order, so the family keeps the sequence's even coverage; a candidate
    closer than MIN_DIFFERENCE (in coupled space) to an accepted member is skipped. Should a long run
    of candidates fail (never seen for <= 16 members), the farthest remaining candidate is taken.
    """
    if kind not in SPACES:
        raise ValueError("This procedural kind has no variant family")
    if not 2 <= count <= MAX_MEMBERS:
        raise ValueError("A variant family has 2..16 members")
    dims = len(SPACES[kind])
    latent = halton(64 * count, dims, _hash(kind, seed))
    pool = couple(kind, latent)
    chosen = []
    for k, row in enumerate(pool):
        if all(distance(kind, row, pool[j]) >= MIN_DIFFERENCE for j in chosen):
            chosen.append(k)
            if len(chosen) == count:
                break
    while len(chosen) < count:
        chosen.append(max((k for k in range(len(pool)) if k not in chosen), key=lambda k: min(distance(kind, pool[k], pool[j]) for j in chosen)))
    rows, coupled = [latent[k] for k in chosen], [pool[k] for k in chosen]
    # Latin-hypercube refinement: keep each parameter's Halton ranks but put the members in distinct
    # 1/n strata, so even a small family spans every range; kept only if no pair gets too close.
    strata = [list(r) for r in rows]
    for d in range(dims):
        for rank, k in enumerate(sorted(range(count), key=lambda k: rows[k][d])):
            strata[k][d] = (rank + (rows[k][d] * count) % 1.0) / count
    refined = couple(kind, strata)
    if all(distance(kind, a, b) >= MIN_DIFFERENCE for i, a in enumerate(refined) for b in refined[i + 1:]):
        rows, coupled = strata, refined
    order = sorted(range(count), key=lambda k: coupled[k][0])
    return [rows[k] for k in order], [coupled[k] for k in order]


def family_rows(kind, seed, count):
    """The coupled unit rows of an n-member family, ordered by their first dimension."""
    return family_latent(kind, seed, count)[1]


def family(kind, seed, count):
    """Members as {name: value} in each parameter's own range, ordered youngest/smallest first."""
    rows = family_rows(kind, seed, count)
    space = SPACES[kind]
    return [{name: low + u * (high - low) for (name, low, high, _), u in zip(space, row)} for row in rows]


def min_difference(kind, seed, count):
    rows = family_rows(kind, seed, count)
    return min(distance(kind, a, b) for i, a in enumerate(rows) for b in rows[i + 1:])


def member_seed(seed, index):
    return _hash("member", seed, index) % 2147483647


def resolve(params, seed, species_radius=None):
    """Concrete generator params, geometry seed and post-deformation for member ``params.variant``."""
    index, count = params["variant"]
    kind = params["kind"]
    if not 1 <= index <= count:
        raise ValueError("Variant index is outside its family")
    v = family(kind, seed, count)[index - 1]
    p = {k: value for k, value in params.items() if k != "variant"}
    post = {"lean": 0.0, "crown": 1.0, "damage": 0.0, "seed": member_seed(seed, index)}
    if kind == "tree":
        p["height"] = clamp(params["height"] * v["height"], 2, 20)
        girth = .85 + .35 * v["age"]
        if params.get("trunkRadius"):
            p["trunkRadius"] = clamp(params["trunkRadius"] * girth, .03, 1.5)
        elif species_radius:
            p["trunkRadius"] = clamp(p["height"] * species_radius * girth, .03, 1.5)
        if params["leafDensity"] > 0:
            p["leafDensity"] = clamp(params["leafDensity"] * (.86 + .26 * v["branch"]), .05, 1)
        if params["branchLevels"] >= 2:
            p["branchLevels"] = 3 if v["branch"] > .45 else 2
        p["trunkTaper"] = clamp(params["trunkTaper"] * (1.08 - .18 * v["age"]), .2, .95)
        post.update(lean=v["lean"], crown=v["crown"], damage=.35 * v["damage"] ** 1.6)
    elif kind == "rock":
        aspect = math.sqrt(v["aspect"])
        x, y, z = params["size"]
        p["size"] = [clamp(x * v["size"] * aspect, .1, 12), clamp(y * v["size"] / aspect, .1, 12), clamp(z * v["size"] * v["flat"], .1, 12)]
        p["roughness"] = clamp(params["roughness"] + v["rough"], 0, 1)
    elif kind == "foliage":
        p["radius"] = clamp(params["radius"] * v["size"], .1, 5)
        p["height"] = clamp(params["height"] * v["height"], .1, 5)
        p["density"] = clamp(params["density"] * v["density"], 0, 1)
    elif kind == "log":
        p["radius"] = clamp(params["radius"] * v["size"], .05, 1.2)
        p["length"] = clamp(params["length"] * v["length"], .5, 12)
    elif kind == "stump":
        p["radius"] = clamp(params["radius"] * v["size"], .05, 1.5)
        p["height"] = clamp(params["height"] * v["height"], .1, 2.5)
    return p, post["seed"], post


def _smooth(t):
    t = clamp(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def deform(parts, post):
    """Crown spread, bent lean (towards local +X) and canopy damage on planned (key, material, MeshData) parts."""
    if post["crown"] == 1 and post["lean"] == 0 and post["damage"] == 0:
        return
    zs = [v[2] for _, _, data in parts for v in data.vertices]
    z0, height = min(zs), max(1e-6, max(zs) - min(zs))
    slope = math.tan(math.radians(post["lean"]))

    def move(c):
        t = (c[2] - z0) / height
        s = 1 + (post["crown"] - 1) * _smooth((t - .3) / .35)
        return (c[0] * s + slope * height * t ** 1.5, c[1] * s, c[2])

    for key, _, data in parts:
        if key == "leaves" and post["damage"] > 0:
            _damage(data, post, z0, height)
        data.vertices = [move(c) for c in data.vertices]
        if data.wood is not None:
            data.wood["samples"] = [(move(c), r) for c, r in data.wood["samples"]]
            data.wood["junctions"] = [(move(c), r, rp) for c, r, rp in data.wood["junctions"]]


def _damage(data, post, z0, height):
    """Remove whole leaf cards (connected components) in one upper canopy sector: a broken-limb gap."""
    parent = list(range(len(data.vertices)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for face in data.faces:
        for other in face[1:]:
            ra, rb = find(face[0]), find(other)
            if ra != rb:
                parent[rb] = ra
    rng = random.Random(post["seed"])
    heading, band = rng.random() * math.tau, math.radians(55)
    groups = {}
    for index, face in enumerate(data.faces):
        groups.setdefault(find(face[0]), []).append(index)
    drop = set()
    for root, faces in groups.items():
        points = [data.vertices[i] for f in faces for i in data.faces[f]]
        cx, cy, cz = (sum(p[k] for p in points) / len(points) for k in range(3))
        t = (cz - z0) / height
        off = abs((math.atan2(cy, cx) - heading + math.pi) % math.tau - math.pi)
        weight = _smooth((band - off) / (band * .5)) * _smooth((t - .4) / .2)
        if weight > 0 and rng.random() < min(.95, post["damage"] * 2.6 * weight):
            drop.add(root)
    if not drop or len(drop) >= len(groups):
        return
    keep = [i for i, face in enumerate(data.faces) if find(face[0]) not in drop]
    used = sorted({i for f in keep for i in data.faces[f]})
    remap = {old: new for new, old in enumerate(used)}
    data.vertices = [data.vertices[i] for i in used]
    if data.normals is not None:
        data.normals = [data.normals[i] for i in used]
    data.faces = [tuple(remap[i] for i in data.faces[f]) for f in keep]
    data.smooth = [data.smooth[f] for f in keep]
    data.uvs = [data.uvs[f] for f in keep]


def _hsv(color, hue, sat, value=1.0):
    h, s, v = colorsys.rgb_to_hsv(*color)
    return [clamp(c, 0, 1) for c in colorsys.hsv_to_rgb((h + hue) % 1.0, clamp(s * sat, 0, 1), clamp(v * value, 0, 1))]


def tint_surfaces(params, seed, materials):
    """Natural-finish texture colours (and moss flags) for one member; factor colours stay as requested."""
    if not params.get("variant"):
        return materials
    index, count = params["variant"]
    v = family(params["kind"], seed, count)[index - 1]
    out = []
    for data in materials:
        data = dict(data)
        color = list(data["color"])
        if params["kind"] == "tree" and data["id"] == "Bark":
            toned = [c * v["bark"] for c in color]
            mix = .32 * v["moss"] ** 1.3
            data["color"] = [clamp(c * (1 - mix) + m * mix * (.6 + .4 * v["bark"]), 0, 1) for c, m in zip(toned, MOSS)]
        elif data["id"] in ("Leaves", "Foliage"):
            data["color"] = _hsv(color, v["hue"], v["sat"], v.get("tone", 1.0) if params["kind"] == "foliage" else 1 - .1 * v["age"])
        else:
            data["color"] = [clamp(c * v["tone"], 0, 1) for c in color]
            if "moss" in data and v["moss"] > .6:
                data["moss"] = True
        out.append(data)
    return out


def texture_seed(params, seed):
    return member_seed(seed, params["variant"][0]) if params.get("variant") else seed
