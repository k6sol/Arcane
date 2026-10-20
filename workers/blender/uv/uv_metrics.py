"""UV quality metrics and audit thresholds for any mesh (plain lists; Blender optional).

``measure`` reports, for one mesh/material:
- distortion: area-weighted angle distortion (sigma1/sigma2 - 1, capped at 9, mean and p95), the
  stretched area share (sigma1/sigma2 > 3), area distortion
  (mean |ln(local / global density)|) and Sander L2 stretch (1 = isometric up to scale);
- texel density in px/m (mean, area-weighted coefficient of variation, island max/min ratio);
- overlap (faces sharing texels with another face), flipped (mirrored) faces, island-to-island
  gap and island-to-border padding in pixels, measured on a texel raster;
- UV space utilisation (covered texels / all texels) and seam length ratio (seam edge length /
  interior edge length) with the visible share of the seams.

``assess`` turns a report into (errors, warnings) for the asset audit. Thresholds depend on the
UV intent: ``unique`` (engine atlases: no overlap, padded, equal density), ``periodic`` (engine
tile mode: world-scale repeats, square texels, overlap by design), ``tiled`` (authored repeating
periodic tiles such as bark and rock regions: overlap by design, density and stretch still held)
and ``atlas`` (cutout cards over a shared atlas, mirrored backs by design: stretch only).
"""
import math
from collections import defaultdict

try:
    import numpy as _np
except ImportError:  # pragma: no cover
    _np = None

UP = (0.0, 0.0, 1.0)
VIEW = (-0.52, 0.70, -0.46)

THRESHOLDS = {
    "unique": {
        "fail": {"foldedFaces": 0, "mirroredFaces": 0, "overlapFaces": 0, "angleDistortion": .35, "stretchedShare": .02, "densityCV": .35, "islandGapPx": 1.0, "borderPx": .5, "utilization": .2},
        "warn": {"angleDistortion": .12, "angleDistortionP95": .5, "densityCV": .12, "islandGapPx": None, "utilization": .45, "smoothSeamRatio": .2, "visibleSeamShare": .55},
    },
    # Engine tile mode (world-scale periodic textures): square texels, overlap by design.
    "periodic": {
        "fail": {"foldedFaces": 0, "mirroredFaces": 0, "angleDistortion": .35, "stretchedShare": .02, "angleDistortionP95": 1.5, "densityCV": .35},
        "warn": {"angleDistortion": .12, "angleDistortionP95": .5, "densityCV": .15, "smoothSeamRatio": .25, "visibleSeamShare": .55},
    },
    # Authored repeating tiles: tapering tubes and flares stretch a fixed number of repeats round a branch
    # and boolean junctions leave slivers, so moderate anisotropy is expected; texture smeared over a
    # quarter of the surface (sigma1/sigma2 > 3), a mean above 2.25:1 or folds fail. (Natural pine bark
    # measures 0.91-0.99 / 10-14%: union fairing stretches the bark round its whorl junctions.)
    "tiled": {
        "fail": {"foldedFraction": .005, "angleDistortion": 1.25, "stretchedShare": .25},
        "warn": {"angleDistortion": .35, "angleDistortionP95": 2.0, "stretchedShare": .05, "densityCV": .5, "mirroredFaces": 0, "smoothSeamRatio": .3},
    },
    # Two-sided cutout cards: front and back share one tile (the back is mirrored by design).
    "atlas": {
        "fail": {"angleDistortion": 1.0, "stretchedShare": .2},
        "warn": {"angleDistortion": .35, "angleDistortionP95": 2.0, "stretchedShare": .05},
    },
}


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _len(a):
    return math.sqrt(_dot(a, a))


def _sigma(pa, pb, pc, ua, ub, uc):
    e1, e2 = _sub(pb, pa), _sub(pc, pa)
    l1 = _len(e1)
    n = _cross(e1, e2)
    area = _len(n) / 2
    if l1 < 1e-14 or area < 1e-16:
        return None
    x = (e1[0] / l1, e1[1] / l1, e1[2] / l1)
    nn = _len(n)
    nu = (n[0] / nn, n[1] / nn, n[2] / nn)
    y = _cross(nu, x)
    q2 = (_dot(e2, x), _dot(e2, y))
    d1 = (ub[0] - ua[0], ub[1] - ua[1])
    d2 = (uc[0] - ua[0], uc[1] - ua[1])
    det_q = l1 * q2[1]
    j00 = (d1[0] * q2[1] - d2[0] * 0.0) / det_q
    j10 = (d1[1] * q2[1]) / det_q
    j01 = (-d1[0] * q2[0] + d2[0] * l1) / det_q
    j11 = (-d1[1] * q2[0] + d2[1] * l1) / det_q
    return (j00, j01, j10, j11), area


def _singular(j, k=1.0):
    """Singular values and determinant of diag(k, 1) * J."""
    j00, j01, j10, j11 = j[0] * k, j[1] * k, j[2], j[3]
    det = j00 * j11 - j01 * j10
    fro = j00 * j00 + j01 * j01 + j10 * j10 + j11 * j11
    disc = math.sqrt(max(0.0, fro * fro - 4 * det * det))
    return math.sqrt(max(0.0, (fro + disc) / 2)), math.sqrt(max(0.0, (fro - disc) / 2)), det


def _percentile(pairs, q):
    pairs = sorted(pairs)
    total = sum(w for _, w in pairs)
    run = 0.0
    for v, w in pairs:
        run += w
        if run >= q * total:
            return v
    return pairs[-1][0] if pairs else 0.0


def ear_clip(points):
    """Triangles (local corner index triples) of a planar polygon: a fan when convex, ear clipping
    when concave (boolean n-gons), so no triangle covers area outside the polygon."""
    n = len(points)
    if n <= 3:
        return [(0, 1, 2)] if n == 3 else []
    nx, ny, nz = 0.0, 0.0, 0.0
    for i, p in enumerate(points):
        q = points[(i + 1) % n]
        nx += (p[1] - q[1]) * (p[2] + q[2])
        ny += (p[2] - q[2]) * (p[0] + q[0])
        nz += (p[0] - q[0]) * (p[1] + q[1])
    ln = math.sqrt(nx * nx + ny * ny + nz * nz)
    fan_ = [(0, i, i + 1) for i in range(1, n - 1)]
    if ln < 1e-18:
        return fan_
    nrm = (nx / ln, ny / ln, nz / ln)
    helper = (1.0, 0.0, 0.0) if abs(nrm[0]) < .9 else (0.0, 1.0, 0.0)
    ax = (nrm[1] * helper[2] - nrm[2] * helper[1], nrm[2] * helper[0] - nrm[0] * helper[2], nrm[0] * helper[1] - nrm[1] * helper[0])
    la = math.sqrt(ax[0] ** 2 + ax[1] ** 2 + ax[2] ** 2)
    ax = (ax[0] / la, ax[1] / la, ax[2] / la)
    ay = (nrm[1] * ax[2] - nrm[2] * ax[1], nrm[2] * ax[0] - nrm[0] * ax[2], nrm[0] * ax[1] - nrm[1] * ax[0])
    p2 = [(p[0] * ax[0] + p[1] * ax[1] + p[2] * ax[2], p[0] * ay[0] + p[1] * ay[1] + p[2] * ay[2]) for p in points]

    def turn(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    scale = max(1e-30, max(abs(c) for p in p2 for c in p) ** 2)
    if all(turn(p2[i - 1], p2[i], p2[(i + 1) % n]) >= -1e-12 * scale for i in range(n)):
        return fan_
    eps = 1e-12 * scale

    def blocked(i0, i1, i2):
        # Any other vertex inside or on the ear (boolean keyholes touch) blocks it.
        corners = {p2[i0], p2[i1], p2[i2]}
        return any(p2[j] not in corners and turn(p2[i0], p2[i1], p2[j]) >= -eps and turn(p2[i1], p2[i2], p2[j]) >= -eps
                   and turn(p2[i2], p2[i0], p2[j]) >= -eps for j in idx if j not in (i0, i1, i2))
    idx, out = list(range(n)), []
    while len(idx) > 3:
        m = len(idx)
        ear = next((k for k in range(m) if turn(p2[idx[k - 1]], p2[idx[k]], p2[idx[(k + 1) % m]]) > eps
                    and not blocked(idx[k - 1], idx[k], idx[(k + 1) % m])), None)
        if ear is None:
            # Straight runs (boolean output): drop a collinear vertex with a zero-area triangle.
            ear = next((k for k in range(m) if abs(turn(p2[idx[k - 1]], p2[idx[k]], p2[idx[(k + 1) % m]])) <= eps), None)
        if ear is None:
            out += [(idx[0], idx[i], idx[i + 1]) for i in range(1, m - 1)]
            return out
        out.append((idx[ear - 1], idx[ear], idx[(ear + 1) % m]))
        idx.pop(ear)
    out.append(tuple(idx))
    return out


def islands(faces, uvs, eps=1e-6):
    """UV-connected face groups: faces sharing a mesh edge with matching UVs at both ends."""
    parent = list(range(len(faces)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    edges = defaultdict(list)
    for fi, f in enumerate(faces):
        for k in range(len(f)):
            a, b = f[k], f[(k + 1) % len(f)]
            edges[(a, b) if a < b else (b, a)].append((fi, k))
    seam_keys = set()
    for key, uses in edges.items():
        if len(uses) != 2:
            continue
        (f, i), (g, j) = uses
        fa = {faces[f][i]: uvs[f][i], faces[f][(i + 1) % len(faces[f])]: uvs[f][(i + 1) % len(faces[f])]}
        ga = {faces[g][j]: uvs[g][j], faces[g][(j + 1) % len(faces[g])]: uvs[g][(j + 1) % len(faces[g])]}
        if all(abs(fa[v][0] - ga[v][0]) <= eps and abs(fa[v][1] - ga[v][1]) <= eps for v in key):
            ra, rb = find(f), find(g)
            if ra != rb:
                parent[max(ra, rb)] = min(ra, rb)
        else:
            seam_keys.add(key)
    ids, out = {}, []
    for f in range(len(faces)):
        r = find(f)
        if r not in ids:
            ids[r] = len(ids)
        out.append(ids[r])
    return out, edges, seam_keys


def _raster(faces, uvs, island, size, tris):
    """Texel raster: coverage count, owning island, and faces that share texels with another face."""
    if _np is None:  # pragma: no cover
        return None
    count = _np.zeros((size, size), dtype=_np.int32)
    owner = _np.full((size, size), -1, dtype=_np.int32)
    spans = []
    for fi, f in enumerate(faces):
        pts = uvs[fi]
        for ia, ib, ic in tris[fi]:
            a, b, c = pts[ia], pts[ib], pts[ic]
            x0 = max(0, int(math.floor(min(a[0], b[0], c[0]) * size - .5)))
            x1 = min(size - 1, int(math.ceil(max(a[0], b[0], c[0]) * size - .5)))
            y0 = max(0, int(math.floor(min(a[1], b[1], c[1]) * size - .5)))
            y1 = min(size - 1, int(math.ceil(max(a[1], b[1], c[1]) * size - .5)))
            if x1 < x0 or y1 < y0:
                continue
            xs = (_np.arange(x0, x1 + 1) + .5) / size
            ys = (_np.arange(y0, y1 + 1) + .5) / size
            X, Y = _np.meshgrid(xs, ys)
            d = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])
            if abs(d) < 1e-18:
                continue
            w1 = ((b[0] - X) * (c[1] - Y) - (c[0] - X) * (b[1] - Y)) / d
            w2 = ((c[0] - X) * (a[1] - Y) - (a[0] - X) * (c[1] - Y)) / d
            w3 = 1 - w1 - w2
            inside = (w1 > 1e-9) & (w2 > 1e-9) & (w3 > 1e-9)
            if not inside.any():
                continue
            iy, ix = _np.nonzero(inside)
            iy = iy + y0
            ix = ix + x0
            count[iy, ix] += 1
            owner[iy, ix] = island[fi]
            spans.append((fi, iy, ix))
    overlapped = set()
    for fi, iy, ix in spans:
        if (count[iy, ix] > 1).any():
            overlapped.add(fi)
    return count, owner, overlapped


def _gap(owner, limit):
    """Smallest centre distance (px) between texels of two different islands, up to ``limit``."""
    best = math.inf
    size = owner.shape[0]
    r = int(math.ceil(limit))
    for dy in range(0, r + 1):
        for dx in range(-r, r + 1):
            if (dy == 0 and dx <= 0) or dx * dx + dy * dy > limit * limit:
                continue
            d = math.hypot(dx, dy)
            if d >= best:
                continue
            a = owner[0:size - dy, max(0, -dx):size - max(0, dx)]
            b = owner[dy:size, max(0, dx):size - max(0, -dx)]
            if ((a >= 0) & (b >= 0) & (a != b)).any():
                best = d
    return best


def measure(vertices, faces, uvs, *, texture_size=512, up=UP, view=VIEW, raster=None, texel_aspect=1.0):
    """Quality report for one UV layout (``uvs``: per-face corner tuples).

    ``texel_aspect`` is the texture's designed world aspect (metres per u unit / metres per v unit
    is 1 / aspect): repeating bark tiles are authored non-square (an oak tile covers 0.42 m round
    the branch and 1 m along it). "auto" estimates it as the area-weighted median |grad v| / |grad u|
    so distortion is measured against the texture's own design; engine atlases use 1."""
    faces = [tuple(f) for f in faces]
    uvs = [tuple(tuple(map(float, p)) for p in pts) for pts in uvs]
    island, edges, seam_keys = islands(faces, uvs)
    tris = []
    flipped_faces, degenerate = set(), 0
    area3 = area2 = 0.0
    local = [ear_clip([vertices[i] for i in f]) for f in faces]
    for fi, f in enumerate(faces):
        for idx in local[fi]:
            s = _sigma(*(vertices[f[i]] for i in idx), *(uvs[fi][i] for i in idx))
            if s is None:
                degenerate += 1
                continue
            j, area = s
            tris.append((fi, j, area))
    aspect_of = {}
    if texel_aspect == "auto":
        # Strip-aware: repeating bark textures stack horizontal strips of different heights, each
        # with its own designed aspect, so the median is taken per v band (16 bands), falling back
        # to the global median where a band has under 2% of the area.
        ratio = [(fi, math.hypot(j[2], j[3]) / max(math.hypot(j[0], j[1]), 1e-12), area) for fi, j, area in tris]
        texel_aspect = _percentile([(r, a) for _, r, a in ratio], .5) if ratio else 1.0
        bands = defaultdict(list)
        for fi, r, a in ratio:
            bands[min(15, max(0, int(sum(p[1] for p in uvs[fi]) / len(uvs[fi]) * 16)))].append((r, a))
        total = sum(a for _, _, a in ratio) or 1.0
        band_aspect = {b: _percentile(v, .5) for b, v in bands.items() if sum(a for _, a in v) >= .02 * total}
        for fi, _, _ in ratio:
            aspect_of[fi] = band_aspect.get(min(15, max(0, int(sum(p[1] for p in uvs[fi]) / len(uvs[fi]) * 16))), texel_aspect)
    measured = []
    for fi, j, area in tris:
        raw = _singular(j)[2]
        s1, s2, det = _singular(j, aspect_of.get(fi, texel_aspect))
        if det <= 0:
            flipped_faces.add(fi)
        measured.append((fi, s1, s2, abs(det), abs(raw), area))
        area3 += area
        area2 += abs(det) * area
    rho2 = area2 / max(area3, 1e-18)
    # Folds: faces flipped against their own island's orientation (a UV fold/overlap). Whole
    # mirrored islands are legal (glTF tangent sign), so they are counted separately.
    orient = defaultdict(lambda: [0, 0])
    for fi in range(len(faces)):
        orient[island[fi]][fi in flipped_faces] += 1
    folded = sum(min(pos, neg) for pos, neg in orient.values())
    mirrored = sum(neg for pos, neg in orient.values() if neg > pos)
    angle, dens, stretch, area_log = [], [], 0.0, 0.0
    island_acc = defaultdict(lambda: [0.0, 0.0])
    stretched = 0.0
    for fi, s1, s2, det, raw, area in measured:
        ratio = s1 / max(s2, 1e-12)
        # Capped at 10: boolean slivers reach ratios of 1000+ on a few mm^2 and would swamp the mean.
        angle.append((min(ratio, 10.0) - 1, area))
        stretched += area if ratio > 3 else 0.0
        d = math.sqrt(raw) * texture_size
        dens.append((d, area))
        stretch += area * (s1 * s1 + s2 * s2) / 2
        area_log += area * abs(math.log(max(det, 1e-30) / max(rho2, 1e-30)))
        island_acc[island[fi]][0] += d * area
        island_acc[island[fi]][1] += area
    mean_d = sum(d * w for d, w in dens) / max(area3, 1e-18)
    cv = math.sqrt(sum(w * (d - mean_d) ** 2 for d, w in dens) / max(area3, 1e-18)) / max(mean_d, 1e-12)
    big = [acc[0] / acc[1] for acc in island_acc.values() if acc[1] >= .01 * area3]
    # Seams: interior manifold edges whose UVs differ across the edge.
    seam_len = interior_len = seam_vis = smooth_seam = smooth_len = 0.0
    normals = {}
    for fi, f in enumerate(faces):
        pts = [vertices[i] for i in f]
        n = (0.0, 0.0, 0.0)
        for i in range(len(pts)):
            p, q = pts[i], pts[(i + 1) % len(pts)]
            n = (n[0] + (p[1] - q[1]) * (p[2] + q[2]), n[1] + (p[2] - q[2]) * (p[0] + q[0]), n[2] + (p[0] - q[0]) * (p[1] + q[1]))
        ln = _len(n)
        normals[fi] = (n[0] / ln, n[1] / ln, n[2] / ln) if ln > 1e-18 else (0.0, 0.0, 1.0)
    for key, uses in edges.items():
        if len(uses) != 2:
            continue
        el = math.dist(vertices[key[0]], vertices[key[1]])
        interior_len += el
        # Seams on hard creases (> 40 degrees) cost nothing: the shading already breaks there.
        smooth = _dot(normals[uses[0][0]], normals[uses[1][0]]) > math.cos(math.radians(40))
        smooth_len += el if smooth else 0.0
        if key in seam_keys:
            seam_len += el
            smooth_seam += el if smooth else 0.0
            n = tuple((normals[uses[0][0]][k] + normals[uses[1][0]][k]) / 2 for k in range(3))
            ln = _len(n) or 1.0
            n = (n[0] / ln, n[1] / ln, n[2] / ln)
            vis = max(0.0, min(1.0, .5 - .35 * _dot(n, view) + .3 * _dot(n, up)))
            seam_vis += el * vis
    all_uv = [p for pts in uvs for p in pts]
    border = min(min(u, v, 1 - u, 1 - v) for u, v in all_uv) * texture_size if all_uv else 0.0
    report = {
        "faces": len(faces), "islands": len(set(island)), "degenerateTriangles": degenerate,
        "flippedFaces": len(flipped_faces), "foldedFaces": folded, "foldedFraction": folded / max(len(faces), 1), "mirroredFaces": mirrored,
        "angleDistortion": sum(a * w for a, w in angle) / max(area3, 1e-18), "angleDistortionP95": _percentile(angle, .95),
        "stretchedShare": stretched / max(area3, 1e-18),
        "areaDistortion": area_log / max(area3, 1e-18),
        "stretchL2": math.sqrt(stretch / max(area3, 1e-18)) / max(math.sqrt(rho2), 1e-12),
        "texelsPerMetre": mean_d, "densityCV": cv,
        "islandDensityRatio": (max(big) / max(min(big), 1e-12)) if big else 1.0,
        "seamRatio": seam_len / max(interior_len, 1e-18), "smoothSeamRatio": smooth_seam / max(smooth_len, 1e-18), "visibleSeamShare": seam_vis / max(seam_len, 1e-18) if seam_len else 0.0,
        "borderPx": border, "textureSize": texture_size, "texelAspect": texel_aspect,
    }
    size = raster or min(1024, texture_size)
    rast = _raster(faces, uvs, island, size, local)
    if rast is not None:
        count, owner, overlapped = rast
        scale = texture_size / size
        report["overlapFaces"] = len(overlapped)
        report["overlapTexels"] = int((count > 1).sum())
        report["utilization"] = float((count > 0).sum()) / (size * size)
        gap = _gap(owner, 12 / scale)
        # Empty texels between the nearest texels of two different islands.
        report["islandGapPx"] = (gap - 1) * scale if math.isfinite(gap) else None
    return {k: (round(v, 6) if isinstance(v, float) else v) for k, v in report.items()}


def assess(report, intent, padding_px=None):
    """(errors, warnings) for one report under its intent's thresholds."""
    table = THRESHOLDS[intent]
    errors, warnings = [], []
    lower = {"islandGapPx", "borderPx", "utilization"}
    for level, out in (("fail", errors), ("warn", warnings)):
        for key, limit in table[level].items():
            if key == "islandGapPx" and limit is None:
                limit = (padding_px - 1.5) if padding_px else None
            value = report.get(key)
            if limit is None or value is None:
                continue
            bad = value < limit if key in lower else value > limit
            if bad and not (level == "warn" and any(key in e for e in errors)):
                out.append("UV %s %s %s (%s)" % (key, _fmt(value), "below" if key in lower else "above", _fmt(limit)))
    return errors, warnings


def _fmt(v):
    return ("%.3g" % v) if isinstance(v, float) else str(v)


def blender_arrays(mesh):
    """(vertices, faces, uvs) from a Blender mesh's active UV layer (evaluated or original)."""
    vertices = [tuple(v.co) for v in mesh.vertices]
    layer = mesh.uv_layers.active
    faces, uvs = [], []
    for poly in mesh.polygons:
        faces.append(tuple(mesh.loops[i].vertex_index for i in poly.loop_indices))
        uvs.append(tuple(tuple(layer.data[i].uv) for i in poly.loop_indices) if layer else tuple((0.0, 0.0) for _ in poly.loop_indices))
    return vertices, faces, uvs


def report(vertices, faces, uvs, intent, texture_size=512, padding_px=None, **hints):
    """Measure under an intent and attach its verdict: unique layouts are checked at texel
    resolution with square texels; tiled/atlas layouts against their own texel aspect on a
    coarser raster (they overlap by design)."""
    unique = intent == "unique"
    result = measure(vertices, faces, uvs, texture_size=texture_size, raster=None if unique else 128,
                     texel_aspect=1.0 if intent in ("unique", "periodic") else "auto", **hints)
    result["intent"] = intent
    errors, warnings = assess(result, intent, padding_px if padding_px is not None else max(2, int(round(texture_size / 128))))
    result["errors"], result["warnings"] = errors, warnings
    return result
