"""Arcane general UV engine: seams, charts, per-chart unwrap, texel density and packing.

Works on plain lists (``vertices`` [(x, y, z)], ``faces`` [(i, j, k, ...)], optional per-face
``labels`` for material/part boundaries) so any mesh the pipeline produces can be unwrapped, in
or out of Blender, deterministically. Output is one UV tuple per face corner (the MeshData /
Blender loop layout).

Stages (``unwrap``):
1. Seams from geometry: non-manifold/boundary edges, label (material/part) boundaries and feature
   edges (dihedral angle) bound smooth *patches*. Surfaces of revolution (cylinders, cones, lathe
   bands, logs) are detected by an axis fit and cut once along the axis on the least visible
   side. Other patches are cut into topological disks: annuli along the cheapest path between
   their boundary loops, handles with a tree-cotree cut graph, closed blobs by visibility-biased
   normal clustering, so seams fall on concave creases, the underside and the back (away from
   ``view``, below ``up``).
2. Unwrap per chart type: planar charts are projected (box projection, world-up = +v),
   cylindrical charts are unrolled into straight rectangles (angle x mean radius, meridian arc
   length), freeform charts use least-squares conformal maps (LSCM). Charts that fold or distort
   too much are split and unwrapped again.
3. Texel density: every chart is scaled to world metres, so one global scale gives the same
   px/m on every chart; ``target_ppm`` / ``fixed_scale`` equalise several materials.
4. Packing (``mode="atlas"``): skyline packing of chart outlines with 90-degree rotation for charts
   whose orientation is free (up-locked charts keep strata level), padding in pixels that grows
   with the texture size, and the largest scale that fits the unit square.
   ``mode="tile"`` instead keeps world-scale periodic coordinates (trim/tileable textures): charts
   are cut into one-repeat pieces along mesh edge rows and overlap by design.

UV1/lightmap channels are not produced: the Roblox import path accepts TEXCOORD_0 only.
"""
import heapq
import math
from collections import defaultdict, deque

try:  # Blender and the test interpreter both ship numpy; the pure-Python path is a fallback.
    import numpy as _np
except ImportError:  # pragma: no cover
    _np = None

UP = (0.0, 0.0, 1.0)
# Main review camera direction (preview-hero looks from -Y, above): seams prefer the far side.
VIEW = (-0.52, 0.70, -0.46)


# ----------------------------------------------------------------- vectors ---
def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def mul(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def length(a):
    return math.sqrt(dot(a, a))


def unit(a, fallback=(0.0, 0.0, 1.0)):
    n = length(a)
    return (a[0] / n, a[1] / n, a[2] / n) if n > 1e-15 else fallback


def perpendicular(a):
    helper = (1.0, 0.0, 0.0) if abs(a[0]) < .9 else (0.0, 1.0, 0.0)
    return unit(cross(a, helper))


def newell(points):
    n = [0.0, 0.0, 0.0]
    for i, p in enumerate(points):
        q = points[(i + 1) % len(points)]
        n[0] += (p[1] - q[1]) * (p[2] + q[2])
        n[1] += (p[2] - q[2]) * (p[0] + q[0])
        n[2] += (p[0] - q[0]) * (p[1] + q[1])
    return tuple(n)


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


def fan(face):
    return [(face[0], face[i], face[i + 1]) for i in range(1, len(face) - 1)]


def symmetric_eigen(m):
    """Eigen-decomposition of a symmetric 3x3 matrix (ascending eigenvalues), Jacobi sweeps."""
    a = [list(row) for row in m]
    v = [[1.0 if i == j else 0.0 for j in range(3)] for i in range(3)]
    for _ in range(32):
        off = abs(a[0][1]) + abs(a[0][2]) + abs(a[1][2])
        if off < 1e-15:
            break
        for p, q in ((0, 1), (0, 2), (1, 2)):
            if abs(a[p][q]) < 1e-18:
                continue
            theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
            t = (1.0 if theta >= 0 else -1.0) / (abs(theta) + math.sqrt(theta * theta + 1))
            c = 1 / math.sqrt(t * t + 1)
            s = t * c
            for k in range(3):
                akp, akq = a[k][p], a[k][q]
                a[k][p], a[k][q] = c * akp - s * akq, s * akp + c * akq
            for k in range(3):
                apk, aqk = a[p][k], a[q][k]
                a[p][k], a[q][k] = c * apk - s * aqk, s * apk + c * aqk
            for k in range(3):
                vkp, vkq = v[k][p], v[k][q]
                v[k][p], v[k][q] = c * vkp - s * vkq, s * vkp + c * vkq
    pairs = sorted(((a[i][i], (v[0][i], v[1][i], v[2][i])) for i in range(3)), key=lambda e: e[0])
    return [p[0] for p in pairs], [unit(p[1]) for p in pairs]


# ---------------------------------------------------------------- topology ---
class Topology:
    """Faces, normals, areas and the edge -> faces map for one mesh."""

    def __init__(self, vertices, faces, labels=None):
        self.vertices = [tuple(float(c) for c in v) for v in vertices]
        self.faces = [tuple(f) for f in faces]
        self.labels = list(labels) if labels is not None else [0] * len(self.faces)
        self.normals, self.areas, self.centroids = [], [], []
        for f in self.faces:
            pts = [self.vertices[i] for i in f]
            n = newell(pts)
            a = length(n) / 2
            self.normals.append(unit(n))
            self.areas.append(a)
            self.centroids.append(mul((sum(p[0] for p in pts), sum(p[1] for p in pts), sum(p[2] for p in pts)), 1 / len(pts)))
        self.edges = defaultdict(list)
        for fi, f in enumerate(self.faces):
            for k in range(len(f)):
                a, b = f[k], f[(k + 1) % len(f)]
                if a != b:
                    self.edges[(a, b) if a < b else (b, a)].append(fi)
        # Per-face triangulation (local corner triples); concave n-gons are ear clipped.
        self.tris = [ear_clip([self.vertices[i] for i in f]) for f in self.faces]
        self.vertex_faces = defaultdict(list)
        for fi, f in enumerate(self.faces):
            for v in f:
                self.vertex_faces[v].append(fi)
        # Smooth per-vertex normal (area weighted) for visibility.
        acc = defaultdict(lambda: (0.0, 0.0, 0.0))
        for fi, f in enumerate(self.faces):
            w = mul(self.normals[fi], self.areas[fi])
            for v in f:
                acc[v] = add(acc[v], w)
        self.vertex_normals = {v: unit(n) for v, n in acc.items()}

    def edge_length(self, key):
        return math.dist(self.vertices[key[0]], self.vertices[key[1]])

    def manifold(self, key):
        faces = self.edges[key]
        if len(faces) != 2:
            return False
        # Opposite traversal in the two faces (consistent winding).
        a, b = key
        f, g = (self.faces[i] for i in faces)
        return _direction(f, a, b) == -_direction(g, a, b) != 0

    def dihedral(self, key):
        f, g = self.edges[key][:2]
        return math.acos(max(-1.0, min(1.0, dot(self.normals[f], self.normals[g]))))

    def concave(self, key):
        f, g = self.edges[key][:2]
        p = self.vertices[key[0]]
        other = [v for v in self.faces[g] if v not in key]
        if not other:
            return False
        return dot(sub(self.vertices[other[0]], p), self.normals[f]) > 1e-12


def _direction(face, a, b):
    for k in range(len(face)):
        if face[k] == a and face[(k + 1) % len(face)] == b:
            return 1
        if face[k] == b and face[(k + 1) % len(face)] == a:
            return -1
    return 0


def visibility(normal, up=UP, view=VIEW):
    """0 (hidden: underside, back) .. 1 (faces the viewer and the sky)."""
    return max(0.0, min(1.0, .5 - .35 * dot(normal, view) + .3 * dot(normal, up)))


# -------------------------------------------------------------- chart graph ---
class ChartMesh:
    """A set of faces with cut edges: corners joined across uncut interior edges into chart vertices."""

    def __init__(self, topo, faces, cuts=frozenset()):
        self.topo, self.faces, self.cuts = topo, list(faces), set(cuts)
        fset = set(self.faces)
        parent = {}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        for f in self.faces:
            for i in range(len(topo.faces[f])):
                parent[(f, i)] = (f, i)
        self.interior = []
        for f in self.faces:
            face = topo.faces[f]
            for k in range(len(face)):
                a, b = face[k], face[(k + 1) % len(face)]
                key = (a, b) if a < b else (b, a)
                linked = topo.edges[key]
                if key in self.cuts or len(linked) != 2 or not topo.manifold(key):
                    continue
                g = linked[1] if linked[0] == f else linked[0]
                if g not in fset or g < f:
                    continue
                if topo.labels[f] != topo.labels[g]:
                    continue
                other = topo.faces[g]
                for v in key:
                    parent_a = find((f, face.index(v)))
                    parent_b = find((g, other.index(v)))
                    if parent_a != parent_b:
                        parent[max(parent_a, parent_b)] = min(parent_a, parent_b)
                self.interior.append(key)
        roots, self.corner = {}, {}
        self.vertex_of = []  # chart vertex -> mesh vertex
        for f in self.faces:
            for i, v in enumerate(topo.faces[f]):
                r = find((f, i))
                if r not in roots:
                    roots[r] = len(self.vertex_of)
                    self.vertex_of.append(v)
                self.corner[(f, i)] = roots[r]
        self.points = [topo.vertices[v] for v in self.vertex_of]

    def face_vertices(self, f):
        return [self.corner[(f, i)] for i in range(len(self.topo.faces[f]))]

    def half_edges(self):
        """Directed chart-vertex edges with their faces; boundary = unmatched."""
        out = defaultdict(list)
        for f in self.faces:
            cv = self.face_vertices(f)
            for k in range(len(cv)):
                out[(cv[k], cv[(k + 1) % len(cv)])].append(f)
        return out

    def boundary_loops(self):
        half = self.half_edges()
        boundary = [e for e in half if (e[1], e[0]) not in half]
        nxt = defaultdict(list)
        for a, b in boundary:
            nxt[a].append(b)
        seen, loops = set(), []
        for start in boundary:
            if start in seen:
                continue
            loop, e = [], start
            while e not in seen:
                seen.add(e)
                loop.append(e[0])
                cands = [b for b in nxt[e[1]] if (e[1], b) not in seen]
                if not cands:
                    break
                e = (e[1], cands[0])
            loops.append(loop)
        return loops

    def euler(self):
        half = self.half_edges()
        edges = set((min(a, b), max(a, b)) for a, b in half)
        return len(self.vertex_of) - len(edges) + len(self.faces)

    def is_disk(self):
        return self.euler() == 1 and len(self.boundary_loops()) == 1

    def neighbours(self):
        """Chart vertex adjacency over edges (cost graph for cuts)."""
        adj = defaultdict(set)
        for a, b in self.half_edges():
            adj[a].add(b)
            adj[b].add(a)
        return adj


# --------------------------------------------------------------- patches ---
def patches(topo, feature_angle):
    """Smooth patches bounded by feature edges, label boundaries and non-manifold edges."""
    limit = math.radians(feature_angle)
    seen, result = set(), []
    for start in range(len(topo.faces)):
        if start in seen or topo.areas[start] <= 1e-14:
            continue
        seen.add(start)
        group, queue = [], deque([start])
        while queue:
            f = queue.popleft()
            group.append(f)
            face = topo.faces[f]
            for k in range(len(face)):
                a, b = face[k], face[(k + 1) % len(face)]
                key = (a, b) if a < b else (b, a)
                linked = topo.edges[key]
                if len(linked) != 2 or not topo.manifold(key):
                    continue
                g = linked[1] if linked[0] == f else linked[0]
                if g in seen or topo.areas[g] <= 1e-14 or topo.labels[g] != topo.labels[f] or topo.dihedral(key) > limit:
                    continue
                seen.add(g)
                queue.append(g)
        result.append(sorted(group))
    # Zero-area faces join any neighbour so every face gets UVs.
    lost = [f for f in range(len(topo.faces)) if f not in seen]
    if lost:
        owner = {f: i for i, g in enumerate(result) for f in g}
        for f in lost:
            near = [owner[g] for v in topo.faces[f] for g in topo.vertex_faces[v] if g in owner]
            if near:
                result[near[0]].append(f)
                owner[f] = near[0]
            else:
                result.append([f])
                owner[f] = len(result) - 1
    return result


def planar_spread(topo, faces):
    total = sum(topo.areas[f] for f in faces) or 1.0
    mean = unit(mul((sum(topo.normals[f][0] * topo.areas[f] for f in faces), sum(topo.normals[f][1] * topo.areas[f] for f in faces),
                     sum(topo.normals[f][2] * topo.areas[f] for f in faces)), 1 / total))
    worst = max((math.degrees(math.acos(max(-1.0, min(1.0, dot(topo.normals[f], mean))))) for f in faces if topo.areas[f] > 1e-14), default=0.0)
    return mean, worst


# ------------------------------------------------------- revolution charts ---
def fit_revolution(topo, faces):
    """Fit an axis of revolution: returns dict(axis, centre, residual, coverage, radii) or None."""
    total = sum(topo.areas[f] for f in faces)
    if total <= 1e-12 or len(faces) < 8:
        return None
    cov = [[0.0] * 3 for _ in range(3)]
    pts = [[0.0] * 3 for _ in range(3)]
    centroid = mul(tuple(sum(topo.centroids[f][k] * topo.areas[f] for f in faces) for k in range(3)), 1 / total)
    for f in faces:
        n, w = topo.normals[f], topo.areas[f]
        d = sub(topo.centroids[f], centroid)
        for i in range(3):
            for j in range(3):
                cov[i][j] += w * n[i] * n[j]
                pts[i][j] += w * d[i] * d[j]
    _, nvec = symmetric_eigen(cov)
    _, pvec = symmetric_eigen(pts)
    best = None
    for axis in [nvec[0], pvec[2], (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)]:
        axis = unit(axis)
        # Least squares centre c (in the plane normal to axis): n . (axis x (p - c)) = 0.
        e1 = perpendicular(axis)
        e2 = cross(axis, e1)
        ata = [[0.0, 0.0], [0.0, 0.0]]
        atb = [0.0, 0.0]
        for f in faces:
            n, w = topo.normals[f], topo.areas[f]
            p = sub(topo.centroids[f], centroid)
            wv = cross(n, axis)  # n . (axis x c) = c . (n x axis)
            row = (dot(wv, e1), dot(wv, e2))
            rhs = dot(n, cross(axis, p))
            for i in range(2):
                atb[i] += w * row[i] * rhs
                for j in range(2):
                    ata[i][j] += w * row[i] * row[j]
        det = ata[0][0] * ata[1][1] - ata[0][1] * ata[1][0]
        if abs(det) < 1e-18:
            continue
        cx = (atb[0] * ata[1][1] - atb[1] * ata[0][1]) / det
        cy = (ata[0][0] * atb[1] - ata[1][0] * atb[0]) / det
        centre = add(centroid, add(mul(e1, cx), mul(e2, cy)))
        residual, axial, radii, bins = 0.0, 0.0, [], [0.0] * 36
        for f in faces:
            n, w = topo.normals[f], topo.areas[f]
            r = sub(topo.centroids[f], centre)
            r = sub(r, mul(axis, dot(r, axis)))
            rl = length(r)
            if rl < 1e-9:
                residual += w
                continue
            radii.append((rl, w))
            tangent = unit(cross(axis, r))
            residual += w * abs(dot(n, tangent))
            axial += w * abs(dot(n, axis))
            # Angular coverage from each face's span (not its centroid), so gaps are real.
            phi = math.atan2(dot(r, e2), dot(r, e1))
            spans = []
            for vi in topo.faces[f]:
                q = sub(sub(topo.vertices[vi], centre), mul(axis, dot(sub(topo.vertices[vi], centre), axis)))
                a = math.atan2(dot(q, e2), dot(q, e1))
                spans.append(phi + (a - phi + math.pi) % (2 * math.pi) - math.pi)
            first = int(math.floor((min(spans) + math.pi) / (2 * math.pi) * 36))
            last = int(math.floor((max(spans) + math.pi) / (2 * math.pi) * 36 - 1e-9))
            for k in range(first, max(first, last) + 1):
                bins[k % 36] += w
        residual /= total
        axial /= total
        coverage = sum(1 for b in bins if b > 0) / 36
        if axial > .8:
            continue
        score = residual
        if best is None or score < best["residual"]:
            best = {"axis": axis, "centre": centre, "e1": e1, "e2": e2, "residual": residual, "axial": axial, "coverage": coverage, "bins": bins,
                    "radius": sum(r * w for r, w in radii) / max(sum(w for _, w in radii), 1e-12),
                    "rmin": min((r for r, _ in radii), default=0.0), "rmax": max((r for r, _ in radii), default=0.0)}
    return best


def revolution_chart(topo, faces, fit, up, view):
    """Unroll a surface of revolution into a straight rectangle; seam on the least visible side."""
    axis, centre, e1, e2 = fit["axis"], fit["centre"], fit["e1"], fit["e2"]
    # Seam angle: least visible radial direction among covered angles, or the middle of the
    # largest uncovered gap for an open band.
    bins = fit["bins"]
    empty = [i for i, b in enumerate(bins) if b <= 0]
    if empty:
        best_gap, run, start = (0, 0), 0, 0
        for i in range(72):
            if bins[i % 36] <= 0:
                if run == 0:
                    start = i
                run += 1
                if run > best_gap[0]:
                    best_gap = (run, start)
            else:
                run = 0
        cut = ((best_gap[1] + best_gap[0] / 2) % 36) / 36 * 2 * math.pi - math.pi
    else:
        candidates = []
        for i in range(72):
            phi = -math.pi + 2 * math.pi * i / 72
            radial = add(mul(e1, math.cos(phi)), mul(e2, math.sin(phi)))
            candidates.append((visibility(radial, up, view) + .001 * i / 72, phi))
        cut = min(candidates)[1]
    # Snap the cut onto the nearest existing vertex column so the seam follows mesh edges.
    verts = sorted(set(v for f in faces for v in topo.faces[f]))

    def angle(p):
        r = sub(p, centre)
        return math.atan2(dot(r, e2), dot(r, e1))

    def wrap(a):
        return (a + math.pi) % (2 * math.pi) - math.pi
    nearest = min(verts, key=lambda v: (abs(wrap(angle(topo.vertices[v]) - cut)), v))
    cut = angle(topo.vertices[nearest]) - 1e-7
    # Meridian arc length s(h) from the radius profile (cones/bells keep true length).
    samples = sorted((dot(sub(topo.vertices[v], centre), axis), length(sub(sub(topo.vertices[v], centre), mul(axis, dot(sub(topo.vertices[v], centre), axis))))) for v in verts)
    hs = [samples[0][0]]
    rs = [[samples[0][1]]]
    tol = 1e-6 + 1e-4 * (samples[-1][0] - samples[0][0])
    for h, r in samples[1:]:
        if h - hs[-1] > tol:
            hs.append(h)
            rs.append([r])
        else:
            rs[-1].append(r)
    rm = [sum(r) / len(r) for r in rs]
    arc = [0.0]
    for i in range(1, len(hs)):
        arc.append(arc[-1] + math.hypot(hs[i] - hs[i - 1], rm[i] - rm[i - 1]))
    flat = (hs[-1] - hs[0]) < 1e-9

    def meridian(p):
        rel = sub(p, centre)
        h = dot(rel, axis)
        if flat:
            return length(sub(rel, mul(axis, h)))
        i = max(0, min(len(hs) - 2, _bisect(hs, h) - 1))
        t = (h - hs[i]) / max(hs[i + 1] - hs[i], 1e-12)
        return arc[i] + t * (arc[i + 1] - arc[i])
    radius = fit["radius"]
    # Orientation: v along +axis; if the axis points down flip it, so strata/bark run level.
    flip = 1.0 if dot(axis, up) >= -1e-9 else -1.0
    uvs = {}
    for f in faces:
        face = topo.faces[f]
        c = (angle(topo.centroids[f]) - cut) % (2 * math.pi)
        out = []
        for v in face:
            a = (angle(topo.vertices[v]) - cut) % (2 * math.pi)
            while a - c > math.pi:
                a -= 2 * math.pi
            while c - a > math.pi:
                a += 2 * math.pi
            out.append((flip * a * radius, flip * meridian(topo.vertices[v])))
        uvs[f] = out
    return uvs, 2 * math.pi * radius


def _bisect(values, x):
    lo, hi = 0, len(values)
    while lo < hi:
        mid = (lo + hi) // 2
        if values[mid] <= x:
            lo = mid + 1
        else:
            hi = mid
    return lo


# --------------------------------------------------------------- disk cuts ---
def vertex_cost(topo, chart, cv, up, view):
    v = chart.vertex_of[cv]
    return .15 + visibility(topo.vertex_normals.get(v, UP), up, view)


def dijkstra(chart, costs, sources):
    adj = chart.neighbours()
    dist, prev, heap = {}, {}, []
    for s in sources:
        dist[s] = 0.0
        heap.append((0.0, s))
    heapq.heapify(heap)
    while heap:
        d, a = heapq.heappop(heap)
        if d > dist.get(a, math.inf):
            continue
        for b in sorted(adj[a]):
            w = math.dist(chart.points[a], chart.points[b]) * (costs[a] + costs[b]) / 2
            if d + w < dist.get(b, math.inf) - 1e-15:
                dist[b] = d + w
                prev[b] = a
                heapq.heappush(heap, (d + w, b))
    return dist, prev


def mesh_key(chart, a, b):
    x, y = chart.vertex_of[a], chart.vertex_of[b]
    return (x, y) if x < y else (y, x)


def cut_annulus(topo, chart, up, view):
    """Cut paths joining every boundary loop to the first, through the least visible vertices."""
    loops = chart.boundary_loops()
    costs = [vertex_cost(topo, chart, cv, up, view) for cv in range(len(chart.vertex_of))]
    cuts = set(chart.cuts)
    joined = set(loops[0])
    for loop in loops[1:]:
        dist, prev = dijkstra(chart, costs, sorted(joined))
        target = min(loop, key=lambda v: (dist.get(v, math.inf), v))
        if target not in dist:
            return None
        node = target
        while node in prev:
            cuts.add(mesh_key(chart, prev[node], node))
            node = prev[node]
        joined |= set(loop)
    return cuts


def cut_handles(topo, chart, up, view):
    """Tree-cotree cut graph through the least visible vertices: a closed genus-g patch becomes a disk."""
    costs = [vertex_cost(topo, chart, cv, up, view) for cv in range(len(chart.vertex_of))]
    root = min(range(len(chart.vertex_of)), key=lambda v: (costs[v], v))
    dist, prev = dijkstra(chart, costs, [root])
    tree = set((min(a, b), max(a, b)) for b, a in prev.items())
    # Dual spanning tree over edges not in the primal tree.
    half = chart.half_edges()
    edge_faces = defaultdict(list)
    for (a, b), fs in half.items():
        edge_faces[(min(a, b), max(a, b))].extend(fs)
    dual = defaultdict(list)
    for e, fs in edge_faces.items():
        if e not in tree and len(fs) == 2:
            dual[fs[0]].append((fs[1], e))
            dual[fs[1]].append((fs[0], e))
    seen, cotree = {chart.faces[0]}, set()
    queue = deque([chart.faces[0]])
    while queue:
        f = queue.popleft()
        for g, e in sorted(dual[f]):
            if g not in seen:
                seen.add(g)
                cotree.add(e)
                queue.append(g)
    leftover = [e for e in sorted(edge_faces) if e not in tree and e not in cotree and len(edge_faces[e]) == 2]
    cuts = set(chart.cuts)
    for a, b in leftover:
        cuts.add(mesh_key(chart, a, b))
        for node in (a, b):
            while node in prev:
                cuts.add(mesh_key(chart, prev[node], node))
                node = prev[node]
    return cuts


def cluster_split(topo, faces, up, view, count=6):
    """Visibility-biased normal clustering: the front and top grow past their silhouettes so
    cluster borders (seams) sit at the back and underside."""
    front = unit((-view[0], -view[1], 0.0), (0.0, -1.0, 0.0))
    side = unit(cross(up, front))
    dirs = [(front, .22), (up, .12), (side, .05), (mul(side, -1), .05), (mul(front, -1), -.08), (mul(up, -1), -.18)][:count]
    label = {}
    for f in faces:
        n = topo.normals[f]
        label[f] = max(range(len(dirs)), key=lambda k: (dot(n, dirs[k][0]) + dirs[k][1], -k))
    fset = set(faces)
    for _ in range(3):
        changed = {}
        for f in faces:
            votes = defaultdict(float)
            face = topo.faces[f]
            for k in range(len(face)):
                a, b = face[k], face[(k + 1) % len(face)]
                key = (a, b) if a < b else (b, a)
                for g in topo.edges[key]:
                    if g != f and g in fset:
                        votes[label[g]] += topo.edge_length(key)
            if votes:
                best = max(sorted(votes), key=lambda k: votes[k])
                if best != label[f] and votes[best] > 1.6 * votes.get(label[f], 0.0):
                    changed[f] = best
        label.update(changed)
    return components(topo, faces, label, merge=True)


def components(topo, faces, label, merge=False):
    fset, seen, out = set(faces), set(), []
    for f in faces:
        if f in seen:
            continue
        seen.add(f)
        group, queue = [], deque([f])
        while queue:
            x = queue.popleft()
            group.append(x)
            face = topo.faces[x]
            for k in range(len(face)):
                a, b = face[k], face[(k + 1) % len(face)]
                for g in topo.edges[(a, b) if a < b else (b, a)]:
                    if g in fset and g not in seen and label[g] == label[x]:
                        seen.add(g)
                        queue.append(g)
        out.append(sorted(group))
    # Merge slivers (< 4 faces or < 2% of the area) into the neighbour sharing the longest border.
    total = sum(topo.areas[f] for f in faces) or 1.0
    while len(out) > 1:
        small = [i for i, g in enumerate(out) if len(g) < 4 or sum(topo.areas[f] for f in g) < .02 * total]
        if not small:
            break
        i = min(small, key=lambda k: (sum(topo.areas[f] for f in out[k]), k))
        owner = {f: k for k, g in enumerate(out) for f in g}
        border = defaultdict(float)
        for f in out[i]:
            face = topo.faces[f]
            for k in range(len(face)):
                a, b = face[k], face[(k + 1) % len(face)]
                key = (a, b) if a < b else (b, a)
                for g in topo.edges[key]:
                    if g in owner and owner[g] != i:
                        border[owner[g]] += topo.edge_length(key)
        if not border:
            break
        j = max(sorted(border), key=lambda k: border[k])
        out[j] = sorted(out[j] + out[i])
        out.pop(i)
    return merge_strips(topo, out) if merge else out


def merge_strips(topo, groups):
    """Fold thin strips (a plank's edge, a bevel band) onto the larger neighbour they share most of
    their long side with: the fold along a straight edge unfolds without distortion, and a strip a
    few texels wide packed alone would cost more in padding than it holds."""
    groups = [list(g) for g in groups]
    while len(groups) > 1:
        owner = {f: k for k, g in enumerate(groups) for f in g}
        areas = [sum(topo.areas[f] for f in g) for g in groups]
        best = None
        for i, g in enumerate(groups):
            border, rim = defaultdict(float), 0.0
            for f in g:
                face = topo.faces[f]
                for k in range(len(face)):
                    a, b = face[k], face[(k + 1) % len(face)]
                    key = (a, b) if a < b else (b, a)
                    others = [owner[h] for h in topo.edges[key] if h in owner and owner[h] != i]
                    if others or len(topo.edges[key]) != 2:
                        rim += topo.edge_length(key)
                    for o in set(others):
                        border[o] += topo.edge_length(key)
            if not border:
                continue
            j = max(sorted(border), key=lambda k: border[k])
            # Thin: the shared side is most of half the strip's rim, and the strip is much smaller.
            if border[j] >= .4 * rim and areas[i] <= .3 * areas[j] and (best is None or areas[i] < best[0]):
                best = (areas[i], i, j)
        if best is None:
            break
        _, i, j = best
        groups[j] = sorted(groups[j] + groups[i])
        groups.pop(i)
    return groups


def bisect_faces(topo, faces):
    """Split along the longest principal axis of the face centroids."""
    total = sum(topo.areas[f] for f in faces) or 1.0
    c = mul(tuple(sum(topo.centroids[f][k] * topo.areas[f] for f in faces) for k in range(3)), 1 / total)
    m = [[0.0] * 3 for _ in range(3)]
    for f in faces:
        d = sub(topo.centroids[f], c)
        for i in range(3):
            for j in range(3):
                m[i][j] += topo.areas[f] * d[i] * d[j]
    _, vec = symmetric_eigen(m)
    axis = vec[2]
    label = {f: int(dot(sub(topo.centroids[f], c), axis) > 0) for f in faces}
    return components(topo, faces, label)


# -------------------------------------------------------------- parameterize ---
def project_chart(topo, chart, normal, up):
    if abs(dot(normal, up)) < .9:
        v_axis = unit(sub(up, mul(normal, dot(up, normal))))
    else:
        # Horizontal: v towards world +Y (or -Y for an underside), u along +X.
        v_axis = unit(sub((0.0, 1.0, 0.0), mul(normal, normal[1])))
    u_axis = cross(v_axis, normal)
    return [(dot(p, u_axis), dot(p, v_axis)) for p in chart.points]


def lscm(topo, chart, initial):
    """Least-squares conformal map of a disk chart (CGLS); two farthest vertices pinned."""
    n = len(chart.vertex_of)
    tris = []
    for f in chart.faces:
        cv = chart.face_vertices(f)
        for a, b, c in topo.tris[f]:
            tris.append((cv[a], cv[b], cv[c]))
    # Pins: extremes of the initial layout along its principal direction.
    mu = (sum(p[0] for p in initial) / n, sum(p[1] for p in initial) / n)
    sxx = sum((p[0] - mu[0]) ** 2 for p in initial)
    syy = sum((p[1] - mu[1]) ** 2 for p in initial)
    sxy = sum((p[0] - mu[0]) * (p[1] - mu[1]) for p in initial)
    theta = .5 * math.atan2(2 * sxy, sxx - syy)
    d = (math.cos(theta), math.sin(theta))
    proj = [(p[0] - mu[0]) * d[0] + (p[1] - mu[1]) * d[1] for p in initial]
    p0 = min(range(n), key=lambda i: (proj[i], i))
    p1 = max(range(n), key=lambda i: (proj[i], -i))
    if p0 == p1:
        return initial
    pinned = {p0: initial[p0], p1: initial[p1]}
    free = [i for i in range(n) if i not in pinned]
    index = {v: k for k, v in enumerate(free)}
    m = len(free)
    rows, cols, vals, rhs = [], [], [], []
    r = 0
    for a, b, c in tris:
        pa, pb, pc = chart.points[a], chart.points[b], chart.points[c]
        e1 = sub(pb, pa)
        l1 = length(e1)
        nrm = cross(e1, sub(pc, pa))
        area2 = length(nrm)
        if l1 < 1e-14 or area2 < 1e-16:
            continue
        x = mul(e1, 1 / l1)
        y = unit(cross(unit(nrm), x))
        q = [(0.0, 0.0), (l1, 0.0), (dot(sub(pc, pa), x), dot(sub(pc, pa), y))]
        s = 1 / math.sqrt(area2)
        ids = (a, b, c)
        # W_j = (x_{j+2} - x_{j+1}) + i (y_{j+2} - y_{j+1})
        re_row, im_row, b_re, b_im = [], [], 0.0, 0.0
        for j in range(3):
            wa = (q[(j + 2) % 3][0] - q[(j + 1) % 3][0]) * s
            wb = (q[(j + 2) % 3][1] - q[(j + 1) % 3][1]) * s
            v = ids[j]
            # Re: wa*u - wb*v ; Im: wb*u + wa*v
            if v in pinned:
                pu, pv = pinned[v]
                b_re -= wa * pu - wb * pv
                b_im -= wb * pu + wa * pv
            else:
                k = index[v]
                re_row += [(k, wa), (m + k, -wb)]
                im_row += [(k, wb), (m + k, wa)]
        for row, value in ((re_row, b_re), (im_row, b_im)):
            for col, val in row:
                rows.append(r)
                cols.append(col)
                vals.append(val)
            rhs.append(value)
            r += 1
    if not free or r == 0:
        return initial
    x0 = [initial[v][0] for v in free] + [initial[v][1] for v in free]
    solution = _cgls(rows, cols, vals, rhs, x0, r, 2 * m)
    out = list(initial)
    for v, k in index.items():
        out[v] = (solution[k], solution[m + k])
    for v, p in pinned.items():
        out[v] = p
    return out


def arap(chart, points, iterations=12):
    """As-rigid-as-possible local/global refinement (Liu et al. 2008) of a 2D chart layout:
    per-triangle best rotations, then a cotangent-Laplacian solve with one vertex pinned."""
    np = _np
    tris, local, cots = [], [], []
    for f in chart.faces:
        cv = chart.face_vertices(f)
        for a, b, c in chart.topo.tris[f]:
            ids = (cv[a], cv[b], cv[c])
            pa, pb, pc = (chart.points[i] for i in ids)
            e1 = sub(pb, pa)
            l1 = length(e1)
            nrm = cross(e1, sub(pc, pa))
            if l1 < 1e-14 or length(nrm) < 1e-16:
                continue
            x = mul(e1, 1 / l1)
            y = unit(cross(unit(nrm), x))
            q = ((0.0, 0.0), (l1, 0.0), (dot(sub(pc, pa), x), dot(sub(pc, pa), y)))
            w = []
            for k in range(3):
                o, i, j = q[k], q[(k + 1) % 3], q[(k + 2) % 3]
                u1, u2 = (i[0] - o[0], i[1] - o[1]), (j[0] - o[0], j[1] - o[1])
                cr = abs(u1[0] * u2[1] - u1[1] * u2[0])
                w.append(max(1e-3, (u1[0] * u2[0] + u1[1] * u2[1]) / max(cr, 1e-15)) / 2)
            tris.append(ids)
            local.append(q)
            cots.append(w)  # w[k]: weight of the edge opposite corner k
    if not tris:
        return points
    T = np.asarray(tris)
    X = np.asarray(local)
    Wt = np.asarray(cots)
    n = len(points)
    U = np.asarray(points, dtype=np.float64)
    # Edge (i, j) opposite corner k: i = (k+1)%3, j = (k+2)%3.
    I = np.concatenate([T[:, (k + 1) % 3] for k in range(3)])
    J = np.concatenate([T[:, (k + 2) % 3] for k in range(3)])
    Wv = np.concatenate([Wt[:, k] for k in range(3)])
    dX = np.concatenate([X[:, (k + 1) % 3] - X[:, (k + 2) % 3] for k in range(3)])
    diag = np.bincount(I, weights=Wv, minlength=n) + np.bincount(J, weights=Wv, minlength=n)
    pin = int(np.argmin(np.arange(n)))
    free = np.ones(n, dtype=bool)
    free[pin] = False
    m = len(T)

    def L(x):
        y = diag * x - np.bincount(I, weights=Wv * x[J], minlength=n) - np.bincount(J, weights=Wv * x[I], minlength=n)
        y[~free] = x[~free]
        return y
    for _ in range(iterations):
        dU = np.concatenate([U[T[:, (k + 1) % 3]] - U[T[:, (k + 2) % 3]] for k in range(3)])
        S = np.zeros((m, 2, 2))
        for k in range(3):
            sl = slice(k * m, (k + 1) * m)
            S += Wv[sl, None, None] * dU[sl, :, None] * dX[sl, None, :]
        Uu, _, Vt = np.linalg.svd(S)
        R = Uu @ Vt
        bad = np.linalg.det(R) < 0
        if bad.any():
            Uu[bad, :, 1] *= -1
            R = Uu @ Vt
        Rk = np.concatenate([R, R, R])
        rx = np.einsum("nij,nj->ni", Rk, dX) * Wv[:, None]
        b = np.zeros((n, 2))
        np.add.at(b, I, rx)
        np.add.at(b, J, -rx)
        new = U.copy()
        for axis in range(2):
            rhs = b[:, axis].copy()
            rhs[pin] = U[pin, axis]
            x = U[:, axis].copy()
            r = rhs - L(x)
            p_ = r.copy()
            rr = float(r @ r)
            r0 = rr
            for _cg in range(600):
                if rr <= 1e-18 * max(r0, 1e-30):
                    break
                Ap = L(p_)
                alpha = rr / max(float(p_ @ Ap), 1e-300)
                x += alpha * p_
                r -= alpha * Ap
                rn = float(r @ r)
                p_ = r + (rn / rr) * p_
                rr = rn
            new[:, axis] = x
        U = new
    return [tuple(map(float, p)) for p in U]


def _cgls(rows, cols, vals, rhs, x0, nrows, ncols, tol=1e-9, maxiter=4000):
    if _np is not None:
        R = _np.asarray(rows, dtype=_np.int64)
        C = _np.asarray(cols, dtype=_np.int64)
        V = _np.asarray(vals, dtype=_np.float64)
        b = _np.asarray(rhs, dtype=_np.float64)
        x = _np.asarray(x0, dtype=_np.float64)

        def A(p):
            return _np.bincount(R, weights=V * p[C], minlength=nrows)

        def At(q):
            return _np.bincount(C, weights=V * q[R], minlength=ncols)
        res = b - A(x)
        s = At(res)
        p = s.copy()
        gamma = float(s @ s)
        g0 = gamma
        for _ in range(maxiter):
            if gamma <= tol * tol * max(g0, 1e-30):
                break
            q = A(p)
            qq = float(q @ q)
            if qq <= 1e-300:
                break
            alpha = gamma / qq
            x += alpha * p
            res -= alpha * q
            s = At(res)
            gnew = float(s @ s)
            p = s + (gnew / gamma) * p
            gamma = gnew
        return [float(v) for v in x]
    x = list(x0)  # pragma: no cover - pure Python fallback

    def A(p):
        out = [0.0] * nrows
        for r_, c_, v_ in zip(rows, cols, vals):
            out[r_] += v_ * p[c_]
        return out

    def At(q):
        out = [0.0] * ncols
        for r_, c_, v_ in zip(rows, cols, vals):
            out[c_] += v_ * q[r_]
        return out
    ax = A(x)
    res = [bi - ai for bi, ai in zip(rhs, ax)]
    s = At(res)
    p = list(s)
    gamma = sum(v * v for v in s)
    g0 = gamma
    for _ in range(maxiter):
        if gamma <= tol * tol * max(g0, 1e-30):
            break
        q = A(p)
        qq = sum(v * v for v in q)
        if qq <= 1e-300:
            break
        alpha = gamma / qq
        x = [xi + alpha * pi for xi, pi in zip(x, p)]
        res = [ri - alpha * qi for ri, qi in zip(res, q)]
        s = At(res)
        gnew = sum(v * v for v in s)
        p = [si + (gnew / gamma) * pi for si, pi in zip(s, p)]
        gamma = gnew
    return x


def chart_quality(topo, faces, uvs):
    """(flipped faces, area-weighted angle distortion sigma1/sigma2 - 1, density spread p90/p10)."""
    flipped, weighted, total, dens = 0, 0.0, 0.0, []
    for f in faces:
        face = topo.faces[f]
        for a, b, c in topo.tris[f]:
            pa, pb, pc = (topo.vertices[face[i]] for i in (a, b, c))
            ua, ub, uc = uvs[f][a], uvs[f][b], uvs[f][c]
            sig = jacobian(pa, pb, pc, ua, ub, uc)
            if sig is None:
                continue
            s1, s2, det, area = sig
            if det <= 0:
                flipped += 1
                continue
            weighted += area * (s1 / max(s2, 1e-12) - 1)
            total += area
            dens.append((math.sqrt(det), area))
    dens.sort()
    spread = 1.0
    if dens:
        acc, cut10, cut90, run = sum(w for _, w in dens), None, None, 0.0
        for d, w in dens:
            run += w
            if cut10 is None and run >= .1 * acc:
                cut10 = d
            if cut90 is None and run >= .9 * acc:
                cut90 = d
        spread = (cut90 or 1.0) / max(cut10 or 1.0, 1e-12)
    return flipped, weighted / max(total, 1e-15), spread


def jacobian(pa, pb, pc, ua, ub, uc):
    e1 = sub(pb, pa)
    e2 = sub(pc, pa)
    l1 = length(e1)
    nrm = cross(e1, e2)
    area = length(nrm) / 2
    if l1 < 1e-14 or area < 1e-16:
        return None
    x = mul(e1, 1 / l1)
    y = unit(cross(unit(nrm), x))
    q1 = (l1, 0.0)
    q2 = (dot(e2, x), dot(e2, y))
    d1 = (ub[0] - ua[0], ub[1] - ua[1])
    d2 = (uc[0] - ua[0], uc[1] - ua[1])
    # J * [q1 q2] = [d1 d2]
    det_q = q1[0] * q2[1] - q2[0] * q1[1]
    inv = ((q2[1] / det_q, -q2[0] / det_q), (-q1[1] / det_q, q1[0] / det_q))
    j00 = d1[0] * inv[0][0] + d2[0] * inv[1][0]
    j01 = d1[0] * inv[0][1] + d2[0] * inv[1][1]
    j10 = d1[1] * inv[0][0] + d2[1] * inv[1][0]
    j11 = d1[1] * inv[0][1] + d2[1] * inv[1][1]
    det = j00 * j11 - j01 * j10
    fro = j00 * j00 + j01 * j01 + j10 * j10 + j11 * j11
    disc = math.sqrt(max(0.0, fro * fro - 4 * det * det))
    s1 = math.sqrt(max(0.0, (fro + disc) / 2))
    s2 = math.sqrt(max(0.0, (fro - disc) / 2))
    return s1, s2, det, area


class Chart:
    def __init__(self, faces, uvs, kind, locked, around=None):
        self.faces, self.uvs, self.kind, self.locked, self.around = faces, uvs, kind, locked, around


def metre_scale(topo, faces, uvs):
    """Factor that makes a chart's UV area equal its surface area (1 UV unit = 1 m)."""
    a3 = sum(topo.areas[f] for f in faces)
    a2 = 0.0
    for f in faces:
        pts = uvs[f]
        a2 += abs(sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(pts, pts[1:] + pts[:1]))) / 2
    return math.sqrt(a3 / a2) if a2 > 1e-18 else 1.0


def to_metres(topo, faces, uvs):
    s = metre_scale(topo, faces, uvs)
    return {f: [(u * s, v * s) for u, v in pts] for f, pts in uvs.items()}


def orient_up(topo, faces, uvs, up):
    """Rotate so the world-up gradient points along +v (strata and bark level). Returns locked."""
    gx = gy = 0.0
    for f in faces:
        face = topo.faces[f]
        for a, b, c in topo.tris[f]:
            pa, pb, pc = (topo.vertices[face[i]] for i in (a, b, c))
            ua, ub, uc = uvs[f][a], uvs[f][b], uvs[f][c]
            # Gradient of height h over the UV triangle.
            d1 = (ub[0] - ua[0], ub[1] - ua[1])
            d2 = (uc[0] - ua[0], uc[1] - ua[1])
            det = d1[0] * d2[1] - d2[0] * d1[1]
            if abs(det) < 1e-18:
                continue
            h1, h2 = dot(sub(pb, pa), up), dot(sub(pc, pa), up)
            grad = ((h1 * d2[1] - h2 * d1[1]) / det, (d1[0] * h2 - d2[0] * h1) / det)
            w = abs(det) / 2
            gx += grad[0] * w
            gy += grad[1] * w
    area = sum(topo.areas[f] for f in faces) or 1.0
    if math.hypot(gx, gy) < .35 * area:
        return uvs, False
    angle = math.atan2(gx, gy)  # rotate gradient onto +v
    c, s = math.cos(angle), math.sin(angle)
    return {f: [(c * u - s * v, s * u + c * v) for u, v in pts] for f, pts in uvs.items()}, True


def chart_from_points(chart, points):
    return {f: [points[cv] for cv in chart.face_vertices(f)] for f in chart.faces}


def parameterize(topo, faces, up, view, depth=0, cuts=frozenset(), max_angle=.22, max_spread=3.0):
    """Return [Chart] for one patch: planar, cylindrical or LSCM freeform disks."""
    faces = sorted(faces)
    if not faces:
        return []
    if len(faces) == 1:
        f = faces[0]
        normal = topo.normals[f]
        chart = ChartMesh(topo, faces, cuts)
        uvs, locked = orient_up(topo, faces, to_metres(topo, faces, chart_from_points(chart, project_chart(topo, chart, normal, up))), up)
        return [Chart(faces, uvs, "planar", locked)]
    normal, spread = planar_spread(topo, faces)
    if spread <= 14:
        chart = ChartMesh(topo, faces, cuts)
        uvs = to_metres(topo, faces, chart_from_points(chart, project_chart(topo, chart, normal, up)))
        flipped, distortion, _ = chart_quality(topo, faces, uvs)
        if not flipped:
            uvs, locked = orient_up(topo, faces, uvs, up)
            return [Chart(faces, uvs, "planar", locked)]
    if depth == 0 and not cuts:
        fit = fit_revolution(topo, faces)
        if fit and fit["residual"] < .07 and fit["coverage"] > .3 and fit["rmin"] > 1e-4 and fit["rmax"] / max(fit["rmin"], 1e-9) < 1.6:
            uvs, around = revolution_chart(topo, faces, fit, up, view)
            uvs = {f: list(p) for f, p in uvs.items()}
            flipped, distortion, dens = chart_quality(topo, faces, uvs)
            if not flipped and distortion < .2 and dens < 1.6:
                # v runs along the axis (lying logs too), so bark and strata stay straight.
                k = metre_scale(topo, faces, uvs)
                return [Chart(faces, {f: [(u * k, v * k) for u, v in p] for f, p in uvs.items()}, "cylindrical", True, around * k)]
    chart = ChartMesh(topo, faces, cuts)
    if not chart.is_disk():
        loops = chart.boundary_loops()
        euler = chart.euler()
        genus = (2 - euler - len(loops)) // 2
        new_cuts = None
        if genus > 0 and not loops and depth < 2:
            new_cuts = cut_handles(topo, chart, up, view)
        elif genus == 0 and len(loops) >= 2:
            new_cuts = cut_annulus(topo, chart, up, view)
        if new_cuts is not None and new_cuts != chart.cuts:
            trial = ChartMesh(topo, faces, new_cuts)
            if trial.is_disk():
                charts = _freeform(topo, trial, up, view, depth, max_angle, max_spread)
                if charts is not None:
                    return charts
        return _split(topo, faces, up, view, depth, cuts, max_angle, max_spread)
    charts = _freeform(topo, chart, up, view, depth, max_angle, max_spread)
    if charts is not None:
        return charts
    return _split(topo, faces, up, view, depth, cuts, max_angle, max_spread)


def _freeform(topo, chart, up, view, depth, max_angle, max_spread):
    normal, _ = planar_spread(topo, chart.faces)
    initial = project_chart(topo, chart, normal, up)
    points = lscm(topo, chart, initial)
    uvs = chart_from_points(chart, points)
    flipped, distortion, spread = chart_quality(topo, chart.faces, uvs)
    if not flipped and spread > 1.25 and _np is not None:
        # Conformal maps keep angles but let texel density drift (bent tubes, blobs); ARAP
        # refinement trades a little angle for even density. Kept only if it stays unfolded
        # and lowers the combined distortion.
        refined = arap(chart, points)
        r_uvs = chart_from_points(chart, refined)
        r_flipped, r_distortion, r_spread = chart_quality(topo, chart.faces, r_uvs)
        if not r_flipped and r_distortion + math.log(r_spread) < distortion + math.log(spread):
            uvs, distortion, spread = r_uvs, r_distortion, r_spread
    if flipped:
        return None
    if (distortion > max_angle or spread > max_spread) and depth < 5 and len(chart.faces) > 12:
        return None
    uvs = to_metres(topo, chart.faces, uvs)
    uvs, locked = orient_up(topo, chart.faces, uvs, up)
    return [Chart(chart.faces, uvs, "freeform", locked)]


def _split(topo, faces, up, view, depth, cuts, max_angle, max_spread):
    parts = cluster_split(topo, faces, up, view) if depth < 2 else []
    if len(parts) < 2:
        parts = bisect_faces(topo, faces)
    if len(parts) < 2:
        # Coincident or symmetric centroids can defeat the geometric split.
        # Keep cutting the rejected chart instead of projecting folded faces.
        ordered = sorted(faces)
        if len(ordered) <= 1:
            return parameterize(topo, ordered, up, view, depth + 1, cuts, max_angle, max_spread)
        middle = len(ordered) // 2
        parts = [ordered[:middle], ordered[middle:]]
    out = []
    for part in parts:
        out += parameterize(topo, part, up, view, depth + 1, frozenset(), max_angle, max_spread)
    return out


def principal_axis(chart):
    """Unit direction of the chart's longest extent in UV (point covariance)."""
    pts = [p for f in chart.faces for p in chart.uvs[f]]
    mx = sum(p[0] for p in pts) / len(pts)
    my = sum(p[1] for p in pts) / len(pts)
    sxx = sum((p[0] - mx) ** 2 for p in pts)
    syy = sum((p[1] - my) ** 2 for p in pts)
    sxy = sum((p[0] - mx) * (p[1] - my) for p in pts)
    theta = .5 * math.atan2(2 * sxy, sxx - syy)
    return (math.cos(theta), math.sin(theta))


def split_long(topo, chart, aspect=3.0, depth=0, limit=None):
    """Cut long strips (tubes, bands) and skewed charts that fill under half of their box along
    their principal axis into pieces that pack well. With ``limit`` (UV units: about half the
    expected atlas side) a strip is cut only when it is longer than that, into the fewest pieces
    under it: a short thin strip (a plank's bevel or edge) packs whole, since every extra piece
    costs a padding ring that many small islands cannot afford."""
    d = principal_axis(chart)
    n = (-d[1], d[0])
    along = {f: [p[0] * d[0] + p[1] * d[1] for p in chart.uvs[f]] for f in chart.faces}
    across = [p[0] * n[0] + p[1] * n[1] for f in chart.faces for p in chart.uvs[f]]
    lo = min(min(v) for v in along.values())
    span = max(max(v) for v in along.values()) - lo
    width = max(across) - min(across)
    area = sum(_tri_area((pts[0], pts[i], pts[i + 1])) for pts in chart.uvs.values() for i in range(1, len(pts) - 1))
    skewed = area < .5 * span * width and len(chart.faces) >= 32 and depth < 3
    if (span < aspect * max(width, 1e-9) and not skewed) or len(chart.faces) < 8:
        return [chart]
    if limit is not None and not skewed and span <= limit:
        return [chart]
    pieces = max(2, int(round(span / max(width, 1e-9) / 1.5)))
    if limit is not None and not skewed:
        pieces = max(2, int(math.ceil(span / limit)))
    groups = defaultdict(list)
    for f in chart.faces:
        c = sum(along[f]) / len(along[f])
        groups[min(pieces - 1, int((c - lo) / span * pieces))].append(f)
    out = []
    for k in sorted(groups):
        label = {f: 0 for f in groups[k]}
        for comp in components(topo, groups[k], label):
            piece = Chart(comp, {f: chart.uvs[f] for f in comp}, chart.kind, chart.locked, None)
            out += split_long(topo, piece, aspect, depth + 1, limit) if skewed else [piece]
    return out


def _box_fill(chart):
    pts = [p for f in chart.faces for p in chart.uvs[f]]
    w = max(p[0] for p in pts) - min(p[0] for p in pts)
    h = max(p[1] for p in pts) - min(p[1] for p in pts)
    area = sum(_tri_area((pts[0], pts[i], pts[i + 1])) for pts in chart.uvs.values() for i in range(1, len(pts) - 1))
    return area / max(w * h, 1e-18)


def unlock_skewed(chart):
    """An up-locked chart that lies diagonally (a brace, a sloped strip) fills a sliver of its box;
    in a many-part atlas it is freed to lie along u when that at least doubles the fill, trading
    level strata on that one strip for the whole atlas's resolution."""
    if not chart.locked or len(chart.faces) < 2:
        return chart
    fill = _box_fill(chart)
    if fill >= .45:
        return chart
    free = align_free(Chart(chart.faces, dict(chart.uvs), chart.kind, False, chart.around))
    return free if _box_fill(free) >= 2 * fill else chart


def align_free(chart):
    """Free (not up-locked) charts lie along u before packing, so 90-degree turns can nest them."""
    if chart.locked:
        return chart
    d = principal_axis(chart)
    c, s = d[0], -d[1]
    chart.uvs = {f: [(c * u - s * v, s * u + c * v) for u, v in pts] for f, pts in chart.uvs.items()}
    return chart


# ------------------------------------------------------------------ packing ---
def _rotate(points, quarter):
    if quarter == 0:
        return points
    if quarter == 1:
        return [(-v, u) for u, v in points]
    if quarter == 2:
        return [(-u, -v) for u, v in points]
    return [(v, -u) for u, v in points]


def _profile(chart_tris, scale, grid, pad):
    """Bottom/top occupancy per grid column for a chart at ``scale`` (grid cells), dilated by pad."""
    xs = [p[0] for t in chart_tris for p in t]
    ys = [p[1] for t in chart_tris for p in t]
    x0, y0 = min(xs), min(ys)
    width = int(math.floor((max(xs) - x0) * scale * grid)) + 1
    bottom = [math.inf] * width
    top = [-math.inf] * width
    for tri in chart_tris:
        q = [((p[0] - x0) * scale * grid, (p[1] - y0) * scale * grid) for p in tri]
        for i in range(3):
            a, b = q[i], q[(i + 1) % 3]
            steps = int(abs(b[0] - a[0])) + 1
            for s in range(steps + 1):
                t = s / steps
                x, y = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
                col = min(width - 1, int(x))
                if y < bottom[col]:
                    bottom[col] = y
                if y > top[col]:
                    top[col] = y
    # Fill interior columns (a chart is connected; empty columns take neighbours).
    for col in range(width):
        if bottom[col] == math.inf:
            bottom[col] = bottom[col - 1] if col else 0.0
            top[col] = top[col - 1] if col else 0.0
    p = int(math.ceil(pad))
    dil_b, dil_t = [], []
    for c in range(-p, width + p):
        lo_c, hi_c = max(0, c - p), min(width, c + p + 1)
        if lo_c >= hi_c:
            dil_b.append(math.inf)
            dil_t.append(-math.inf)
        else:
            dil_b.append(min(bottom[lo_c:hi_c]) - pad)
            dil_t.append(max(top[lo_c:hi_c]) + pad)
    return x0, y0, p, dil_b, dil_t


def _place(sky, bottom, top, grid, border):
    w = len(bottom)
    limit = grid - border
    best = None
    if _np is not None:
        sky_a = _np.asarray(sky)
        b = _np.asarray(bottom)
        positions = int(limit - border - w + 1)
        if positions <= 0:
            return None
        ys = _np.full(positions, -_np.inf)
        for j in range(w):
            ys = _np.maximum(ys, sky_a[border + j:border + j + positions] - b[j])
        ys = _np.maximum(ys, border - min(bottom))
        tops = ys + max(top)
        ok = _np.nonzero(tops <= limit + 1e-9)[0]
        if not len(ok):
            return None
        k = int(ok[_np.argmin(ys[ok])])
        return border + k, float(ys[k])
    for x in range(border, limit - w + 1):  # pragma: no cover
        y = max(max(sky[x + j] - bottom[j] for j in range(w)), border - min(bottom))
        if y + max(top) <= limit + 1e-9 and (best is None or y < best[1] - 1e-12):
            best = (x, y)
    return best


def pack(charts, pad_uv, grid=256, fixed_scale=None, rotate=True):
    """Skyline packing into the unit square. Returns (scale UV/m, {chart index: (quarter, dx, dy)})."""
    tris = []
    for ch in charts:
        t = []
        for f in ch.faces:
            pts = ch.uvs[f]
            for a, b, c in fan(list(range(len(pts)))):
                t.append((pts[a], pts[b], pts[c]))
        tris.append(t)
    area = sum(_tri_area(t) for ts in tris for t in ts)
    pad = pad_uv * grid
    border = int(math.ceil(pad / 2))
    order = sorted(range(len(charts)), key=lambda i: (-_extent(tris[i])[1] * _extent(tris[i])[0], i))

    def attempt(scale):
        sky = [0.0] * (grid + 2)
        placed = {}
        for i in order:
            options = [0, 1, 2, 3] if rotate and not charts[i].locked else [0]
            best = None
            for q in options:
                rt = [tuple(_rotate(list(t), q)) for t in tris[i]]
                x0, y0, p, bottom, top = _profile(rt, scale, grid, pad / 2)
                spot = _place(sky, bottom, top, grid, border)
                if spot is None:
                    continue
                key = (spot[1] + max(top), spot[1], q)
                if best is None or key < best[0]:
                    best = (key, q, spot, x0, y0, p, bottom, top)
            if best is None:
                return None
            _, q, (x, y), x0, y0, p, bottom, top = best
            for j in range(len(top)):
                sky[x + j] = max(sky[x + j], y + top[j])
            # UV offset: grid column x corresponds to profile column -p.
            placed[i] = (q, (x + p) / grid - x0 * scale, y / grid - y0 * scale)
        return placed
    if fixed_scale is not None:
        return fixed_scale, attempt(fixed_scale)
    lo, hi = 0.0, 1.0 / math.sqrt(max(area, 1e-12))
    result = None
    for _ in range(16):
        mid = (lo + hi) / 2 if result is not None or lo > 0 else hi / 2
        placed = attempt(mid)
        if placed is None:
            hi = mid
        else:
            lo, result = mid, placed
    if result is None:
        lo = hi / 64
        result = attempt(lo)
    return lo, result


def _tri_area(t):
    a, b, c = t
    return abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2


def _extent(ts):
    xs = [p[0] for t in ts for p in t]
    ys = [p[1] for t in ts for p in t]
    return max(xs) - min(xs), max(ys) - min(ys)


def apply_pack(charts, scale, placed):
    out = {}
    for i, ch in enumerate(charts):
        q, dx, dy = placed[i]
        for f in ch.faces:
            out[f] = [(u * scale + dx, v * scale + dy) for u, v in _rotate(ch.uvs[f], q)]
    return out


# --------------------------------------------------------------- tile mode ---
def tile_layout(topo, charts, tile_m):
    """World-scale periodic UVs: 1 UV unit = ``tile_m`` metres. Charts longer than one repeat are
    cut into pieces at clean vertex rows/columns (no face crosses them) nearest each repeat, and
    each interior run is stretched to exactly one repeat so the periodic texture stays continuous
    across the cut; a closed cylinder gets a whole number of repeats round its circumference so
    its own seam is invisible when that keeps the repeat within 15%. Pieces whose faces cross a
    cut that could not be placed on clean edges are translated (or, if longer than a repeat,
    scaled) to fit, never clamped. A face cannot wrap inside UV0's 0..1, so the repeat grows to
    at least the largest face. Returns (uvs, effective tile metres)."""
    out = {}
    largest = max((max(p[k] for p in ch.uvs[f]) - min(p[k] for p in ch.uvs[f]) for ch in charts for f in ch.faces for k in (0, 1)), default=0.0)
    tile_m = max(tile_m, largest * 1.0001)
    for ch in charts:
        faces = ch.faces
        coords = {f: list(ch.uvs[f]) for f in faces}
        scale = 1.0 / tile_m
        if ch.around:
            # Wrap a whole number of repeats round a cylinder (invisible seam) only when that
            # changes the repeat by <= 15%; texels stay square either way.
            n = max(1, int(round(ch.around / tile_m)))
            if abs(math.log(n * tile_m / ch.around)) <= math.log(1.15):
                scale = n / ch.around
        # Round an unwrapped cylinder the leftover part-repeat is split over both ends, so every
        # cut lies near the axial seam on the hidden side instead of facing the viewer.
        axes = [_cuts(faces, coords, 0, scale, centred=bool(ch.around) and abs(scale * ch.around - round(scale * ch.around)) > 1e-6),
                _cuts(faces, coords, 1, scale)]
        cell = {}
        for f in faces:
            pts = coords[f]
            cell[f] = tuple(max(0, min(len(cuts) - 2, _bisect(cuts, sum(p[k] for p in pts) / len(pts)) - 1)) for k, (cuts, _) in enumerate(axes))
        groups = defaultdict(list)
        for f in faces:
            groups[cell[f]].append(f)
        for key, members in sorted(groups.items()):
            maps = []
            for k, (cuts, scale) in enumerate(axes):
                a, b = cuts[key[k]], cuts[key[k] + 1]
                lo = min(p[k] for f in members for p in coords[f])
                hi = max(p[k] for f in members for p in coords[f])
                interior = key[k] < len(cuts) - 2
                if lo >= a - 1e-9 and hi <= b + 1e-9:
                    # Whole interior runs span exactly one repeat; part runs (the ends) keep the
                    # tile scale unless slightly longer than one repeat.
                    full = interior and .65 <= (b - a) * scale <= 1.35
                    span = (b - a) if full else max(b - a - 1e-9, 1.0 / scale)
                    maps.append((a, 1.0 / max(span, 1e-12)))
                elif (hi - lo) * scale <= 1.0:
                    maps.append((lo, scale))
                else:
                    maps.append((lo, 1.0 / (hi - lo)))
            for f in members:
                out[f] = [(min(1.0, max(0.0, (p[0] - maps[0][0]) * maps[0][1])), min(1.0, max(0.0, (p[1] - maps[1][0]) * maps[1][1]))) for p in coords[f]]
    return out, tile_m


def _cuts(faces, coords, axis, scale, centred=False):
    """Cut levels along one axis (metres): clean vertex levels nearest each repeat."""
    values = sorted(set(round(p[axis], 9) for f in faces for p in coords[f]))
    lo, hi = values[0], values[-1]
    if (hi - lo) * scale <= 1.0 + 1e-9:
        return [lo, hi + 1e-9], scale
    starts = sorted((min(p[axis] for p in coords[f]), max(p[axis] for p in coords[f])) for f in faces)
    # Sweep: a level is clean when no face spans across it.
    clean, k, active = [], 0, []
    for x in values:
        while k < len(starts) and starts[k][0] < x - 1e-9:
            heapq.heappush(active, starts[k][1])
            k += 1
        while active and active[0] <= x + 1e-9:
            heapq.heappop(active)
        if not active:
            clean.append(x)
    period = 1.0 / scale
    cuts = [lo]
    if centred:
        lead = ((hi - lo) - math.floor((hi - lo) / period) * period) / 2
        if lead > .05 * period:
            near = [x for x in clean if lo < x < lo + 2 * lead]
            cuts.append(min(near, key=lambda x: (abs(x - lo - lead), x)) if near else lo + lead)
    while hi - cuts[-1] > period * 1.1:
        target = cuts[-1] + period
        cands = [x for x in clean if cuts[-1] + .6 * period <= x <= cuts[-1] + 1.25 * period and x < hi - .05 * period]
        cuts.append(min(cands, key=lambda x: (abs(x - target), x)) if cands else target)
    cuts.append(hi + 1e-9)
    return cuts, scale


# ---------------------------------------------------------------- top level ---
# Atlases of at least this many charts (many-part models) cut strips only by atlas length.
ATLAS_MANY_CHARTS = 24


def padding_px(texture_size):
    """Island padding in pixels: grows with the texture (2 px @256, 4 px @512, 8 px @1024)."""
    return max(2, int(round(texture_size / 128)))


def unwrap(vertices, faces, labels=None, *, up=UP, view=VIEW, feature_angle=58.0, texture_size=512, mode="atlas",
           tile_m=1.0, target_ppm=None, fixed_scale=None, rotate=True, padding=None):
    """Unwrap a mesh. Returns dict(uvs=[per-face corner tuples], charts=[...], scale=UV/m, ...)."""
    topo = Topology(vertices, faces, labels)
    up, view = unit(up), unit(view)
    charts = []
    for patch in patches(topo, feature_angle):
        charts += parameterize(topo, patch, up, view)
    kinds = defaultdict(int)
    for ch in charts:
        kinds[ch.kind] += 1
    info = {"mode": mode, "chartKinds": dict(sorted(kinds.items())), "textureSize": texture_size}
    if mode == "tile":
        uvs, tile_m = tile_layout(topo, charts, tile_m)
        info.update({"charts": len(charts), "tileMetres": tile_m, "texelsPerMetre": texture_size / tile_m})
    else:
        pieces = []
        areas = [sum(topo.areas[f] for f in ch.faces) for ch in charts]
        total = sum(areas) or 1.0
        # Expected atlas side in chart units (metres) at a typical 60% fill: strips longer than
        # half of it are cut, shorter ones pack whole (see split_long).
        uv_area = sum(_tri_area((pts[0], pts[i], pts[i + 1])) for ch in charts for pts in ch.uvs.values() for i in range(1, len(pts) - 1))
        limit = .5 * math.sqrt(max(uv_area, 1e-12) / .6) if len(charts) >= ATLAS_MANY_CHARTS else None
        if limit is not None:
            charts = [unlock_skewed(ch) for ch in charts]
        for ch, a in zip(charts, areas):
            # A chart that dominates the atlas caps its resolution unless it is near square.
            pieces += [align_free(piece) for piece in split_long(topo, ch, 1.8 if a > .4 * total else 3.0, 0, limit)]
        pad_uv = (padding if padding is not None else padding_px(texture_size)) / texture_size
        grid = max(128, min(512, texture_size))
        if target_ppm is not None and fixed_scale is None:
            fit, _ = pack(pieces, pad_uv, grid, None, rotate)
            fixed_scale = min(fit, target_ppm / texture_size)
        scale, placed = pack(pieces, pad_uv, grid, fixed_scale, rotate)
        if placed is None:
            raise ValueError("UV charts do not fit the requested texel density")
        uvs = apply_pack(pieces, scale, placed)
        charts = pieces
        info.update({"charts": len(pieces), "scale": scale, "texelsPerMetre": scale * texture_size, "paddingPx": pad_uv * texture_size})
    ordered = []
    for f in range(len(topo.faces)):
        pts = uvs.get(f)
        if pts is None:
            pts = [(0.0, 0.0)] * len(topo.faces[f])
        ordered.append(tuple((min(1.0, max(0.0, u)), min(1.0, max(0.0, v))) for u, v in pts))
    info["uvs"] = ordered
    info["chartFaces"] = [ch.faces for ch in charts]
    return info


def equalize(parts, mode="atlas"):
    """Per-material texel density: ``parts`` [(vertices, faces, labels, texture_size, options)].
    Every part gets the lowest achievable px/m so textures never change scale between parts."""
    first = [unwrap(v, f, l, texture_size=size, mode=mode, **opts) for v, f, l, size, opts in parts]
    if mode == "tile":
        return first
    ppm = min(r["texelsPerMetre"] for r in first)
    return [unwrap(v, f, l, texture_size=size, mode=mode, fixed_scale=ppm / size, **opts) for v, f, l, size, opts in parts]
