"""Spatial-math operators for the model spec: curves, 2D shapes and closed mesh builders.

Pure Python (tuples only) so triangle budgets, determinism and watertightness can be
tested without Blender. Every builder returns a closed, consistently outward-wound,
vertex-welded Mesh whose per-corner UVs are in metres (later packed into one atlas).
"""
import math

EPS = 1e-9


# ------------------------------------------------------------------ vectors --
def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def mul(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def length(a):
    return math.sqrt(dot(a, a))


def norm(a):
    n = length(a)
    return (a[0] / n, a[1] / n, a[2] / n) if n > EPS else (0.0, 0.0, 1.0)


def lerp(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def perpendicular(t):
    axis = (1.0, 0.0, 0.0) if abs(t[0]) < .9 else (0.0, 1.0, 0.0)
    return norm(cross(t, axis))


# ----------------------------------------------------------------- matrices --
# 4x4 row-major tuples of rows. Points are columns: p' = M p.
IDENTITY = ((1.0, 0.0, 0.0, 0.0), (0.0, 1.0, 0.0, 0.0), (0.0, 0.0, 1.0, 0.0), (0.0, 0.0, 0.0, 1.0))


def matmul(a, b):
    return tuple(tuple(sum(a[r][k] * b[k][c] for k in range(4)) for c in range(4)) for r in range(4))


def translate(v):
    return ((1.0, 0.0, 0.0, v[0]), (0.0, 1.0, 0.0, v[1]), (0.0, 0.0, 1.0, v[2]), (0.0, 0.0, 0.0, 1.0))


def scaling(s):
    return ((s[0], 0.0, 0.0, 0.0), (0.0, s[1], 0.0, 0.0), (0.0, 0.0, s[2], 0.0), (0.0, 0.0, 0.0, 1.0))


def rot_axis(axis, degrees):
    a = math.radians(degrees)
    c, s = math.cos(a), math.sin(a)
    if axis == "x":
        r = ((1, 0, 0), (0, c, -s), (0, s, c))
    elif axis == "y":
        r = ((c, 0, s), (0, 1, 0), (-s, 0, c))
    else:
        r = ((c, -s, 0), (s, c, 0), (0, 0, 1))
    return tuple(tuple(float(x) for x in row) + (0.0,) for row in r) + ((0.0, 0.0, 0.0, 1.0),)


def euler(deg):
    # Blender XYZ Euler: R = Rz * Ry * Rx.
    return matmul(rot_axis("z", deg[2]), matmul(rot_axis("y", deg[1]), rot_axis("x", deg[0])))


def frame(origin, x, y, z):
    return ((x[0], y[0], z[0], origin[0]), (x[1], y[1], z[1], origin[1]), (x[2], y[2], z[2], origin[2]), (0.0, 0.0, 0.0, 1.0))


def compose(at, rot, scale):
    return matmul(translate(at), matmul(euler(rot), scaling(scale)))


def apply(m, p):
    return (m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2] + m[0][3],
            m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2] + m[1][3],
            m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2] + m[2][3])


def apply_dir(m, d):
    return (m[0][0] * d[0] + m[0][1] * d[1] + m[0][2] * d[2], m[1][0] * d[0] + m[1][1] * d[1] + m[1][2] * d[2],
            m[2][0] * d[0] + m[2][1] * d[1] + m[2][2] * d[2])


def determinant(m):
    return (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))


def inverse(m):
    """Inverse of an affine matrix."""
    d = determinant(m)
    if abs(d) < 1e-15:
        raise ValueError("Model spec: a transform collapses to zero volume")
    a = [[m[r][c] for c in range(3)] for r in range(3)]
    inv = [[(a[(c + 1) % 3][(r + 1) % 3] * a[(c + 2) % 3][(r + 2) % 3] - a[(c + 1) % 3][(r + 2) % 3] * a[(c + 2) % 3][(r + 1) % 3]) / d
            for c in range(3)] for r in range(3)]
    t = [-(inv[r][0] * m[0][3] + inv[r][1] * m[1][3] + inv[r][2] * m[2][3]) for r in range(3)]
    return tuple(tuple(inv[r]) + (t[r],) for r in range(3)) + ((0.0, 0.0, 0.0, 1.0),)


# ------------------------------------------------------------------- curves --
def catmull_rom(points, per_span, closed=False):
    """Centripetal Catmull-Rom through all points; per_span samples per segment."""
    n = len(points)
    if n < 2:
        return list(points)
    pts = list(points)
    if closed:
        ext = [pts[-1]] + pts + [pts[0], pts[1]]
        spans = n
    else:
        first = tuple(2 * a - b for a, b in zip(pts[0], pts[1]))
        last = tuple(2 * a - b for a, b in zip(pts[-1], pts[-2]))
        ext = [first] + pts + [last]
        spans = n - 1
    out = []
    for i in range(spans):
        p0, p1, p2, p3 = ext[i], ext[i + 1], ext[i + 2], ext[i + 3]

        def knot(t, a, b):
            return t + max(math.dist(a, b), 1e-9) ** .5
        t0 = 0.0
        t1 = knot(t0, p0, p1)
        t2 = knot(t1, p1, p2)
        t3 = knot(t2, p2, p3)
        for s in range(per_span):
            t = t1 + (t2 - t1) * s / per_span
            a1 = lerp(p0, p1, (t - t0) / (t1 - t0))
            a2 = lerp(p1, p2, (t - t1) / (t2 - t1))
            a3 = lerp(p2, p3, (t - t2) / (t3 - t2))
            b1 = lerp(a1, a2, (t - t0) / (t2 - t0))
            b2 = lerp(a2, a3, (t - t1) / (t3 - t1))
            out.append(lerp(b1, b2, (t - t1) / (t2 - t1)))
    if not closed:
        out.append(tuple(pts[-1]))
    return out


def bezier(points, per_span, closed=False):
    """Cubic Bezier chain: anchor, handle, handle, anchor, ... (closed: last span returns to the first anchor)."""
    pts = list(points) + ([points[0]] if closed else [])
    out = []
    for i in range(0, len(pts) - 1, 3):
        a, b, c, d = pts[i], pts[i + 1], pts[i + 2], pts[i + 3]
        for s in range(per_span):
            t = s / per_span
            u = 1 - t
            out.append(tuple(u * u * u * w + 3 * u * u * t * x + 3 * u * t * t * y + t * t * t * z for w, x, y, z in zip(a, b, c, d)))
    if not closed:
        out.append(tuple(pts[-1]))
    return out


def polyline_length(points, closed=False):
    total = sum(math.dist(a, b) for a, b in zip(points, points[1:]))
    return total + (math.dist(points[-1], points[0]) if closed else 0.0)


def sample_path(path, edge):
    """Sample a validated path at roughly `edge` metre spacing (bounded)."""
    pts, closed, curve = path["points"], path["closed"], path["curve"]
    spans = len(pts) if closed else len(pts) - 1
    if curve == "linear":
        return list(pts)
    if curve == "bezier":
        spans = max(1, (len(pts) - (0 if closed else 1)) // 3)
    rough = polyline_length(pts, closed)
    per = max(2, min(24, int(math.ceil(rough / max(edge, 1e-4) / spans))))
    return (bezier if curve == "bezier" else catmull_rom)(pts, per, closed)


def eval_curve(samples, t, default=1.0):
    """Piecewise-linear [[t, value]] curve (clamped)."""
    if not samples:
        return default
    if t <= samples[0][0]:
        return samples[0][1]
    for (t0, v0), (t1, v1) in zip(samples, samples[1:]):
        if t <= t1:
            return v0 + (v1 - v0) * (t - t0) / max(t1 - t0, 1e-12)
    return samples[-1][1]


# --------------------------------------------------------------- 2D shapes --
def area2(pts):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1])) / 2


def fillet(pts, radius, segs):
    """Round every corner of a CCW polygon by `radius` (clamped to half the shorter adjacent edge)."""
    if radius <= 0:
        return pts
    n, out = len(pts), []
    for i in range(n):
        p0, p1, p2 = pts[i - 1], pts[i], pts[(i + 1) % n]
        a = (p0[0] - p1[0], p0[1] - p1[1])
        b = (p2[0] - p1[0], p2[1] - p1[1])
        la, lb = math.hypot(*a), math.hypot(*b)
        if la < EPS or lb < EPS:
            continue
        a, b = (a[0] / la, a[1] / la), (b[0] / lb, b[1] / lb)
        cos = max(-1.0, min(1.0, a[0] * b[0] + a[1] * b[1]))
        half = math.acos(cos) / 2
        if half < 1e-4 or abs(half - math.pi / 2) < 1e-4:
            out.append(p1)
            continue
        dist = min(radius / math.tan(half), .49 * la, .49 * lb)
        r = dist * math.tan(half)
        s = (p1[0] + a[0] * dist, p1[1] + a[1] * dist)
        e = (p1[0] + b[0] * dist, p1[1] + b[1] * dist)
        bis = (a[0] + b[0], a[1] + b[1])
        bl = math.hypot(*bis)
        c = (p1[0] + bis[0] / bl * r / math.sin(half), p1[1] + bis[1] / bl * r / math.sin(half))
        a0 = math.atan2(s[1] - c[1], s[0] - c[0])
        a1 = math.atan2(e[1] - c[1], e[0] - c[0])
        turn = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        for k in range(segs + 1):
            ang = a0 + turn * k / segs
            out.append((c[0] + math.cos(ang) * r, c[1] + math.sin(ang) * r))
    return out


def shape_points(s, edge, segments=0):
    """CCW 2D outline of a validated shape, resolved for target edge length `edge`."""
    def circle_n(r):
        return segments or max(6, min(128, int(round(2 * math.pi * r / edge / 2)) * 2))
    kind = s["type"]
    round_segs = max(2, min(8, int(math.ceil(s["round"] * math.pi / 2 / edge)))) if s["round"] > 0 else 0
    if kind == "circle":
        n = circle_n(s["r"])
        return [(math.cos(2 * math.pi * i / n) * s["r"], math.sin(2 * math.pi * i / n) * s["r"]) for i in range(n)]
    if kind == "ellipse":
        n = circle_n(max(s["rx"], s["ry"]))
        return [(math.cos(2 * math.pi * i / n) * s["rx"], math.sin(2 * math.pi * i / n) * s["ry"]) for i in range(n)]
    if kind == "rect":
        w, h = s["w"] / 2, s["h"] / 2
        pts = [(w, -h), (w, h), (-w, h), (-w, -h)]
    elif kind == "ngon":
        n = s["n"]
        pts = [(math.cos(2 * math.pi * i / n) * s["r"], math.sin(2 * math.pi * i / n) * s["r"]) for i in range(n)]
    elif kind == "star":
        n = s["n"]
        pts = [(math.cos(math.pi * i / n) * (s["r"] if i % 2 == 0 else s["r2"]), math.sin(math.pi * i / n) * (s["r"] if i % 2 == 0 else s["r2"])) for i in range(2 * n)]
    else:
        pts = [tuple(p) for p in s["points"]]
        if area2(pts) < 0:
            pts.reverse()
    return fillet(pts, s["round"], round_segs) if round_segs else pts


def resample_closed(pts, n):
    """n points at equal arc length round a closed outline, starting nearest the +X ray from its centroid."""
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    start = min(range(len(pts)), key=lambda i: (abs(math.atan2(pts[i][1] - cy, pts[i][0] - cx)), i))
    ring = pts[start:] + pts[:start]
    ring = ring + [ring[0]]
    lengths = [0.0]
    for a, b in zip(ring, ring[1:]):
        lengths.append(lengths[-1] + math.dist(a, b))
    total = lengths[-1]
    out, seg = [], 0
    for k in range(n):
        target = total * k / n
        while lengths[seg + 1] < target:
            seg += 1
        t = (target - lengths[seg]) / max(lengths[seg + 1] - lengths[seg], 1e-12)
        out.append(lerp(ring[seg], ring[seg + 1], t))
    return out


def offset_polygon(pts, d):
    """Miter offset of a CCW polygon (d < 0 shrinks). Raises when the result folds over."""
    if d == 0:
        return list(pts)
    n, out = len(pts), []
    for i in range(n):
        p0, p1, p2 = pts[i - 1], pts[i], pts[(i + 1) % n]
        e0 = norm((p1[0] - p0[0], p1[1] - p0[1], 0))
        e1 = norm((p2[0] - p1[0], p2[1] - p1[1], 0))
        n0, n1 = (e0[1], -e0[0]), (e1[1], -e1[0])
        m = (n0[0] + n1[0], n0[1] + n1[1])
        ml = math.hypot(*m)
        if ml < 1e-6:
            m, scale = n1, 1.0
        else:
            m = (m[0] / ml, m[1] / ml)
            scale = 1.0 / max(.25, m[0] * n1[0] + m[1] * n1[1])
        out.append((p1[0] + m[0] * d * scale, p1[1] + m[1] * d * scale))
    for i in range(n):
        a0 = (pts[(i + 1) % n][0] - pts[i][0], pts[(i + 1) % n][1] - pts[i][1])
        a1 = (out[(i + 1) % n][0] - out[i][0], out[(i + 1) % n][1] - out[i][1])
        if a0[0] * a1[0] + a0[1] * a1[1] <= 0:
            raise ValueError("Model spec: a bevel or inset is too large for its footprint")
    if area2(out) <= 0:
        raise ValueError("Model spec: a bevel or inset is too large for its footprint")
    return out


def triangulate(pts):
    """Ear clipping of a simple CCW polygon -> index triangles (CCW)."""
    idx = list(range(len(pts)))
    tris = []

    def inside(p, a, b, c):
        def s(p1, p2, p3):
            return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
        d1, d2, d3 = s(p, a, b), s(p, b, c), s(p, c, a)
        return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))
    guard = 0
    while len(idx) > 3 and guard < 100000:
        guard += 1
        best = None
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            a, b, c = pts[i0], pts[i1], pts[i2]
            cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if cr <= 1e-14:
                continue
            if any(inside(pts[j], a, b, c) for j in idx if j not in (i0, i1, i2) and pts[j] not in (a, b, c)):
                continue
            # Prefer the fattest ear for well-shaped caps.
            la, lb, lc = math.dist(a, b), math.dist(b, c), math.dist(c, a)
            quality = cr / max(la * la + lb * lb + lc * lc, 1e-18)
            if best is None or quality > best[0] + 1e-12:
                best = (quality, k)
        if best is None:
            raise ValueError("Model spec: a footprint or section outline self-intersects")
        k = best[1]
        tris.append((idx[k - 1], idx[k], idx[(k + 1) % len(idx)]))
        idx.pop(k)
    tris.append(tuple(idx))
    return tris


# --------------------------------------------------------------------- mesh --
class Mesh:
    """Welded polygon mesh with per-corner UVs (metres) and an optional 'auto' UV flag."""

    def __init__(self):
        self.verts = []
        self.faces = []
        self.uvs = []
        self.auto_uv = False
        self.tones = None  # optional per-face tone ids (masonry blocks): 0 = the part's own tone

    def v(self, p):
        self.verts.append((float(p[0]), float(p[1]), float(p[2])))
        return len(self.verts) - 1

    def f(self, idx, uv=None):
        self.faces.append(tuple(idx))
        self.uvs.append(tuple(uv) if uv is not None else self.planar_uv(idx))

    def planar_uv(self, idx):
        pts = [self.verts[i] for i in idx]
        nrm = (0.0, 0.0, 0.0)
        for i in range(1, len(pts) - 1):
            nrm = add(nrm, cross(sub(pts[i], pts[0]), sub(pts[i + 1], pts[0])))
        axis = max(range(3), key=lambda k: abs(nrm[k]))
        # Right-handed (u, v) per axis so no projected face is mirrored: u x v = +normal.
        a, b = ((1, 2), (2, 0), (0, 1))[axis]
        if nrm[axis] < 0:
            a, b = b, a
        return [(p[a], p[b]) for p in pts]

    def triangles(self):
        return sum(len(f) - 2 for f in self.faces)

    def extend(self, other, m=IDENTITY):
        if self.tones is not None or other.tones is not None:
            self.tones = (self.tones if self.tones is not None else [0] * len(self.faces)) + \
                (list(other.tones) if other.tones is not None else [0] * len(other.faces))
        base = len(self.verts)
        flip = determinant(m) < 0
        self.verts.extend(apply(m, p) for p in other.verts)
        for face, uv in zip(other.faces, other.uvs):
            face = tuple(i + base for i in face)
            if flip:
                # Mirrored copy: reverse the winding and flip U so UV islands are never mirrored.
                face, uv = tuple(reversed(face)), tuple((-p[0], p[1]) for p in reversed(uv))
            self.faces.append(face)
            self.uvs.append(uv)
        self.auto_uv = self.auto_uv or other.auto_uv

    def transformed(self, m):
        out = Mesh()
        out.extend(self, m)
        out.auto_uv = self.auto_uv
        return out

    def bounds(self):
        return tuple(min(v[k] for v in self.verts) for k in range(3)), tuple(max(v[k] for v in self.verts) for k in range(3))

    def edge_report(self):
        """(boundary/non-manifold edge count, orientation conflicts) for a closed-solid check."""
        uses = {}
        for face in self.faces:
            for a, b in zip(face, face[1:] + face[:1]):
                uses.setdefault((min(a, b), max(a, b)), []).append((a, b))
        open_edges = sum(1 for u in uses.values() if len(u) != 2)
        flipped = sum(1 for u in uses.values() if len(u) == 2 and u[0] == u[1])
        return open_edges, flipped

    def closed(self):
        open_edges, flipped = self.edge_report()
        return open_edges == 0 and flipped == 0 and bool(self.faces)

    def volume(self):
        total = 0.0
        for face in self.faces:
            p0 = self.verts[face[0]]
            for i in range(1, len(face) - 1):
                total += dot(p0, cross(self.verts[face[i]], self.verts[face[i + 1]])) / 6
        return total

    def area(self):
        total = 0.0
        for face in self.faces:
            p0 = self.verts[face[0]]
            for i in range(1, len(face) - 1):
                total += length(cross(sub(self.verts[face[i]], p0), sub(self.verts[face[i + 1]], p0))) / 2
        return total

    def vertex_normals(self):
        acc = [(0.0, 0.0, 0.0)] * len(self.verts)
        for face in self.faces:
            p0 = self.verts[face[0]]
            for i in range(1, len(face) - 1):
                n = cross(sub(self.verts[face[i]], p0), sub(self.verts[face[i + 1]], p0))
                for j in (face[0], face[i], face[i + 1]):
                    acc[j] = add(acc[j], n)
        return [norm(n) for n in acc]


def ring_strip(mesh, rings, us, vs, closed_ring=True):
    """Quads between consecutive rings (each a vertex index list, CCW about +axis) -> outward faces.
    us[r][j] gives the U of ring r vertex j (len n+1 including the seam), vs[r] the V of ring r."""
    for r in range(len(rings) - 1):
        a, b = rings[r], rings[r + 1]
        n = len(a)
        for j in range(n if closed_ring else n - 1):
            k = (j + 1) % n
            mesh.f((a[j], a[k], b[k], b[j]), ((us[r][j], vs[r]), (us[r][j + 1], vs[r]), (us[r + 1][j + 1], vs[r + 1]), (us[r + 1][j], vs[r + 1])))


def cap(mesh, ring, outline2d, top, center=None):
    """Close a ring with an ear-clipped cap. `outline2d` is the ring in its own plane (CCW seen from +axis)."""
    tris = triangulate(outline2d)
    for t in tris:
        idx = [ring[i] for i in t]
        uv = [outline2d[i] for i in t]
        if not top:
            idx.reverse()
            uv = [(-p[0], p[1]) for p in reversed(uv)]
        mesh.f(idx, uv)


def pole_fan(mesh, ring, pole, top, us, v_ring, v_pole):
    n = len(ring)
    for j in range(n):
        k = (j + 1) % n
        if top:
            mesh.f((ring[j], ring[k], pole), ((us[j], v_ring), (us[j + 1], v_ring), ((us[j] + us[j + 1]) / 2, v_pole)))
        else:
            mesh.f((ring[k], ring[j], pole), ((us[j + 1], v_ring), (us[j], v_ring), ((us[j] + us[j + 1]) / 2, v_pole)))


def arc_us(points3):
    us = [0.0]
    for a, b in zip(points3, points3[1:] + points3[:1]):
        us.append(us[-1] + math.dist(a, b))
    return us


def flute_radius(r, theta, z, flutes):
    if not flutes or flutes["depth"] <= 0 or r <= 0:
        return r
    count, width = flutes["count"], flutes["width"]
    half = math.pi * r * width / count
    depth = flutes["depth"] * half
    lo, hi = flutes["from"], flutes["to"]
    if z < lo or z > hi:
        return r
    # Rounded flute ends: the channel shallows over one half-width at each end.
    ramp = min(1.0, (z - lo) / max(half, 1e-6), (hi - z) / max(half, 1e-6))
    ramp = math.sqrt(max(0.0, ramp * (2 - ramp)))
    s = (theta * count / (2 * math.pi)) % 1.0
    x = (s - .5) / (width / 2)
    if abs(x) >= 1:
        return r
    return r - depth * ramp * math.sqrt(1 - x * x)


def revolve(profile, edge, curve="linear", flutes=None, segments=0, closed=False):
    if closed:
        return revolve_loop(profile, edge, curve, flutes, segments)
    prof = [tuple(p) for p in profile]
    if curve == "smooth" and len(prof) > 2:
        span = polyline_length(prof)
        per = max(2, min(16, int(math.ceil(span / max(edge, 1e-4) / (len(prof) - 1)))))
        prof = catmull_rom(prof, per)
        prof = [(max(0.0, r), z) for r, z in prof]
    # Interior radii stay positive (a pinch to the axis would make a non-manifold vertex).
    prof = [(r if i in (0, len(prof) - 1) else max(r, 1e-4), z) for i, (r, z) in enumerate(prof)]
    # Orientation: the closed (r,z) outline including the axis must run counter-clockwise.
    outline = [(0.0, prof[0][1])] + prof + [(0.0, prof[-1][1])]
    if area2(outline) < 0:
        prof.reverse()
    rmax = max(r for r, _ in prof)
    n = segments or max(6, min(128, int(round(2 * math.pi * rmax / edge / 2)) * 2))
    if flutes and flutes["depth"] > 0:
        # Rings across each flute end so the channels terminate in rounded stops.
        half = math.pi * rmax * flutes["width"] / flutes["count"]
        zs = [flutes["from"] + half * i / 4 for i in range(5)] + [flutes["to"] - half * i / 4 for i in range(5)]
        out = [prof[0]]
        for a, b in zip(prof, prof[1:]):
            lo, hi = sorted((a[1], b[1]))
            inner = sorted(z for z in zs if lo + 1e-6 < z < hi - 1e-6)
            if b[1] < a[1]:
                inner.reverse()
            for z in inner:
                t = (z - a[1]) / (b[1] - a[1])
                out.append((a[0] + (b[0] - a[0]) * t, z))
            out.append(b)
        prof = out
    if flutes:
        # 4..8 segments per flute, finer as the budget allows (each flute keeps a rounded channel).
        pitch = 2 * math.pi * rmax / flutes["count"]
        per = max(4, min(8, int(round(2 * pitch / max(edge, 1e-6)))))
        n = max(n, flutes["count"] * (per if flutes["depth"] > 0 else 4))
        n = int(math.ceil(n / flutes["count"])) * flutes["count"]
        n = min(n, 256)
    mesh = Mesh()
    vs = [0.0]
    for a, b in zip(prof, prof[1:]):
        vs.append(vs[-1] + math.dist(a, b))
    circumference = 2 * math.pi * rmax
    us_ring = [circumference * j / n for j in range(n + 1)]
    rings, ring_rows, poles = [], [], {}
    for i, (r, z) in enumerate(prof):
        if r <= 1e-9 and i in (0, len(prof) - 1):
            poles[i] = mesh.v((0.0, 0.0, z))
            continue
        ring = []
        for j in range(n):
            theta = 2 * math.pi * j / n
            rr = flute_radius(r, theta, z, flutes)
            ring.append(mesh.v((math.cos(theta) * rr, math.sin(theta) * rr, z)))
        rings.append(ring)
        ring_rows.append(i)
    if not rings:
        raise ValueError("Model spec: a revolve profile needs a nonzero radius")
    ring_strip(mesh, rings, [us_ring] * len(rings), [vs[i] for i in ring_rows])
    first, last = ring_rows[0], ring_rows[-1]
    for end, ring, row, top in ((0, rings[0], first, False), (len(prof) - 1, rings[-1], last, True)):
        if end in poles:
            pole_fan(mesh, ring, poles[end], top, us_ring, vs[row], vs[end])
        else:
            r, z = prof[row]
            outline = [(mesh.verts[i][0], mesh.verts[i][1]) for i in ring]
            cap(mesh, ring, outline, top)
    return mesh


def revolve_loop(profile, edge, curve, flutes, segments):
    """Closed (r, z) loop revolved about +Z: rings, hoops, rims (torus topology, no caps)."""
    prof = [tuple(p) for p in profile]
    if curve == "smooth":
        span = polyline_length(prof, True)
        per = max(2, min(16, int(math.ceil(span / max(edge, 1e-4) / len(prof)))))
        prof = catmull_rom(prof, per, True)
    if area2(prof) < 0:
        prof.reverse()
    rmax = max(r for r, _ in prof)
    n = segments or max(6, min(128, int(round(2 * math.pi * rmax / edge / 2)) * 2))
    if flutes:
        pitch = 2 * math.pi * rmax / flutes["count"]
        per = max(4, min(8, int(round(2 * pitch / max(edge, 1e-6)))))
        n = int(math.ceil(max(n, flutes["count"] * per) / flutes["count"])) * flutes["count"]
    mesh = Mesh()
    rings = []
    for r, z in prof:
        rings.append([mesh.v((math.cos(2 * math.pi * j / n) * flute_radius(r, 2 * math.pi * j / n, z, flutes),
                              math.sin(2 * math.pi * j / n) * flute_radius(r, 2 * math.pi * j / n, z, flutes), z)) for j in range(n)])
    vs = [0.0]
    for a, b in zip(prof, prof[1:] + prof[:1]):
        vs.append(vs[-1] + math.dist(a, b))
    us_ring = [2 * math.pi * rmax * j / n for j in range(n + 1)]
    ring_strip(mesh, rings + [rings[0]], [us_ring] * (len(rings) + 1), vs)
    return mesh


def extrude(outline, height, bevel=0.0, inset=None, edge=.05, max_segments=6):
    """Prism over a CCW footprint (z = 0..height) with quarter-round top/bottom bevels and an optional inset step."""
    stations = []
    if bevel > 0:
        k = max(1, min(max_segments, 6, int(math.ceil(bevel * math.pi / 2 / edge))))
        for i in range(k + 1):
            a = math.pi / 2 * i / k
            stations.append((-bevel + bevel * math.sin(a), bevel - bevel * math.cos(a)))
        for i in range(k + 1):
            a = math.pi / 2 * i / k
            stations.append((-bevel + bevel * math.cos(a), height - bevel + bevel * math.sin(a)))
    else:
        stations = [(0.0, 0.0), (0.0, height)]
    if inset:
        w, d = inset["width"], inset["depth"]
        top_offset = stations[-1][0]
        stations.append((top_offset - w, height))
        if abs(d) > 1e-6:
            stations.append((top_offset - w, height + d))
    mesh = Mesh()
    rings, outlines, vs = [], [], [0.0]
    for i, (off, z) in enumerate(stations):
        ring2 = offset_polygon(outline, off)
        outlines.append(ring2)
        rings.append([mesh.v((p[0], p[1], z)) for p in ring2])
        if i:
            prev = stations[i - 1]
            vs.append(vs[-1] + math.hypot(off - prev[0], z - prev[1]))
    us = [arc_us([(p[0], p[1], 0.0) for p in o]) for o in outlines]
    ring_strip(mesh, rings, us, vs)
    cap(mesh, rings[0], outlines[0], False)
    cap(mesh, rings[-1], outlines[-1], True)
    return mesh


def box(size, bevel=0.0, edge=.05, max_segments=6, grid=0.0):
    """Box centred on the origin. `bevel` rounds every edge and corner (at most `max_segments` segments);
    `grid` > 0 also subdivides the flat faces into cells of about that size (for micro relief)."""
    x, y, z = size[0] / 2, size[1] / 2, size[2] / 2
    if bevel <= 0 and grid <= 0:
        mesh = Mesh()
        c = [mesh.v(p) for p in [(-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z), (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z)]]
        for face in ((3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
            mesh.f(tuple(c[i] for i in face))
        return mesh
    # Rounded box: a box-surface grid (dense only inside the bevel bands) pushed onto the
    # sphere-swept surface of the inner box, so every edge and corner is evenly rounded.
    bevel = max(0.0, bevel)
    k = max(1, min(max_segments, 6, int(math.ceil(bevel * math.pi / 2 / edge)))) if bevel > 0 else 0
    half = (x, y, z)

    def ticks(h):
        inner = h - bevel
        n = max(1, int(math.ceil(2 * inner / grid))) if grid > 0 else 1
        mid = [-inner + 2 * inner * i / n for i in range(n + 1)]
        band = [inner + bevel * math.sin(math.pi / 2 * i / k) for i in range(1, k + 1)] if k else []
        return [-t for t in reversed(band)] + mid + band
    axes_ticks = [ticks(h) for h in half]
    mesh = Mesh()
    index = {}

    def vert(p):
        key = tuple(round(c, 9) for c in p)
        if key not in index:
            inner = tuple(max(-(h - bevel), min(h - bevel, c)) for c, h in zip(p, half))
            d = sub(p, inner)
            q = add(inner, mul(norm(d), bevel)) if length(d) > 1e-12 and bevel > 0 else p
            index[key] = mesh.v(q)
        return index[key]
    for axis in range(3):
        a, b = [k2 for k2 in range(3) if k2 != axis]
        for sign in (-1, 1):
            ta, tb = axes_ticks[a], axes_ticks[b]
            for i in range(len(ta) - 1):
                for j in range(len(tb) - 1):
                    corners = []
                    for (ii, jj) in ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)):
                        p = [0.0, 0.0, 0.0]
                        p[axis], p[a], p[b] = sign * half[axis], ta[ii], tb[jj]
                        corners.append(tuple(p))
                    # (a, b, axis) is right-handed for axis x->(y,z), y->(x,z) flips, z->(x,y).
                    right = (axis != 1)
                    if (sign > 0) != right:
                        corners.reverse()
                    ids = [vert(c) for c in corners]
                    if len(set(ids)) == 4:
                        mesh.f(ids, [(c[a], c[b]) if (sign > 0) == right else (-c[a], c[b]) for c in corners])
    return mesh


def chamfer_box(size, chamfer):
    """Cheapest crafted box: every edge cut by one flat chamfer (6 faces + 12 edge strips + 8
    corner triangles = 44 triangles), centred on the origin. Used for masonry blocks."""
    h = (size[0] / 2, size[1] / 2, size[2] / 2)
    c = max(0.0, min(chamfer, min(h) * .45))
    if c <= 0:
        return box(size)
    mesh = Mesh()
    ids = {}
    for ax in range(3):
        a, b = [k for k in range(3) if k != ax]
        for s in (-1, 1):
            for sa in (-1, 1):
                for sb in (-1, 1):
                    p = [0.0, 0.0, 0.0]
                    p[ax], p[a], p[b] = s * h[ax], sa * (h[a] - c), sb * (h[b] - c)
                    ids[(ax, s, sa, sb)] = mesh.v(p)

    def key(ax, signs):
        a, b = [k for k in range(3) if k != ax]
        return ids[(ax, signs[ax], signs[a], signs[b])]

    def outward(face):
        pts = [mesh.verts[i] for i in face]
        nrm = (0.0, 0.0, 0.0)
        for i in range(1, len(pts) - 1):
            nrm = add(nrm, cross(sub(pts[i], pts[0]), sub(pts[i + 1], pts[0])))
        centre = mul(add(add(pts[0], pts[1]), pts[2]), 1 / 3)
        mesh.f(tuple(reversed(face)) if dot(nrm, centre) < 0 else tuple(face))
    for ax in range(3):
        a, b = [k for k in range(3) if k != ax]
        for s in (-1, 1):
            outward([ids[(ax, s, -1, -1)], ids[(ax, s, 1, -1)], ids[(ax, s, 1, 1)], ids[(ax, s, -1, 1)]])
    for i in range(3):
        for j in range(i + 1, 3):
            k = 3 - i - j
            for si in (-1, 1):
                for sj in (-1, 1):
                    quad = []
                    for sk in (-1, 1):
                        signs = [0, 0, 0]
                        signs[i], signs[j], signs[k] = si, sj, sk
                        quad.append((key(i, signs), key(j, signs)))
                    outward([quad[0][0], quad[1][0], quad[1][1], quad[0][1]])
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                signs = (sx, sy, sz)
                outward([key(0, signs), key(1, signs), key(2, signs)])
    return mesh


def cylinder(radius, height, radius_top=None, bevel=0.0, edge=.05, segments=0, max_segments=6):
    rt = radius if radius_top is None else radius_top
    h = height / 2
    prof = [(0.0, -h)]
    if bevel > 0:
        k = max(1, min(max_segments, 6, int(math.ceil(bevel * math.pi / 2 / edge))))
        for i in range(k + 1):
            a = math.pi / 2 * i / k
            prof.append((radius - bevel + bevel * math.sin(a), -h + bevel - bevel * math.cos(a)))
        if rt > 0:
            for i in range(k + 1):
                a = math.pi / 2 * i / k
                prof.append((rt - bevel + bevel * math.cos(a), h - bevel + bevel * math.sin(a)))
    else:
        prof += [(radius, -h), (rt, h)] if rt > 0 else [(radius, -h)]
    prof.append((0.0, h))
    return revolve(prof, edge, "linear", None, segments)


def sphere(radius, edge=.05, segments=0):
    n = segments or max(4, min(48, int(round(math.pi * radius / edge / 2)) * 2))
    prof = [(math.sin(math.pi * i / n) * radius, -math.cos(math.pi * i / n) * radius) for i in range(n + 1)]
    prof[0], prof[-1] = (0.0, -radius), (0.0, radius)
    return revolve(prof, edge, "linear", None, segments or 2 * n)


def loft(sections, edge=.05, curve="linear", segments=0):
    # Shared resolution: every ring gets the same point count.
    perim = 0.0
    outlines = []
    for s in sections:
        pts = shape_points(s["shape"], edge)
        outlines.append(pts)
        sx, sy = s["scale"]
        perim = max(perim, polyline_length([(p[0] * sx, p[1] * sy, 0) for p in pts], True))
    n = segments or max(6, min(128, int(round(perim / edge / 2)) * 2))
    rings3 = []
    for s, pts in zip(sections, outlines):
        res = resample_closed(pts, n)
        c, si = math.cos(math.radians(s["rot"])), math.sin(math.radians(s["rot"]))
        sx, sy = s["scale"]
        ring = []
        for p in res:
            x, y = p[0] * sx, p[1] * sy
            ring.append((x * c - y * si + s["at"][0], x * si + y * c + s["at"][1], s["z"]))
        rings3.append(ring)
    if curve == "smooth" and len(rings3) > 2:
        span = max(math.dist(a[0], b[0]) for a, b in zip(rings3, rings3[1:]))
        per = max(2, min(12, int(math.ceil(span / max(edge, 1e-4)))))
        columns = [catmull_rom([r[j] for r in rings3], per) for j in range(n)]
        rings3 = [[columns[j][i] for j in range(n)] for i in range(len(columns[0]))]
    mesh = Mesh()
    points = [s["scale"] for s in sections]
    bottom_pole = min(points[0]) == 0
    top_pole = min(points[-1]) == 0
    body = rings3[1 if bottom_pole else 0: len(rings3) - (1 if top_pole else 0)]
    if not body:
        raise ValueError("Model spec: a loft needs at least one section with area")
    rings = [[mesh.v(p) for p in ring] for ring in body]
    centres = [tuple(sum(p[k] for p in ring) / n for k in range(3)) for ring in rings3]
    vs = [0.0]
    for a, b in zip(centres, centres[1:]):
        vs.append(vs[-1] + max(math.dist(a, b), 1e-6))
    offset = 1 if bottom_pole else 0
    us = [arc_us(ring) for ring in body]
    ring_strip(mesh, rings, us, vs[offset: offset + len(body)])
    if bottom_pole:
        pole = mesh.v(centres[0])
        pole_fan(mesh, rings[0], pole, False, us[0], vs[1], vs[0])
    else:
        cap(mesh, rings[0], [(p[0], p[1]) for p in body[0]], False)
    if top_pole:
        pole = mesh.v(centres[-1])
        pole_fan(mesh, rings[-1], pole, True, us[-1], vs[offset + len(body) - 1], vs[-1])
    else:
        cap(mesh, rings[-1], [(p[0], p[1]) for p in body[-1]], True)
    return mesh


def rmf_frames(points, closed):
    """Rotation-minimizing frames (double reflection); closed paths spread the closure twist."""
    n = len(points)
    tangents = []
    for i in range(n):
        if closed:
            a, b = points[i - 1], points[(i + 1) % n]
        else:
            a, b = points[max(0, i - 1)], points[min(n - 1, i + 1)]
        tangents.append(norm(sub(b, a)))
    normals = [perpendicular(tangents[0])]
    for i in range(n - 1):
        v1 = sub(points[i + 1], points[i])
        c1 = dot(v1, v1)
        if c1 < 1e-18:
            normals.append(normals[-1])
            continue
        rl = sub(normals[i], mul(v1, 2 / c1 * dot(v1, normals[i])))
        tl = sub(tangents[i], mul(v1, 2 / c1 * dot(v1, tangents[i])))
        v2 = sub(tangents[i + 1], tl)
        c2 = dot(v2, v2)
        normals.append(norm(sub(rl, mul(v2, 2 / c2 * dot(v2, rl))) if c2 > 1e-18 else rl))
    if closed:
        # Rotate the frames progressively so the last frame meets the first.
        end = normals[-1]
        v1 = sub(points[0], points[-1])
        c1 = dot(v1, v1)
        if c1 > 1e-18:
            rl = sub(end, mul(v1, 2 / c1 * dot(v1, end)))
            tl = sub(tangents[-1], mul(v1, 2 / c1 * dot(v1, tangents[-1])))
            v2 = sub(tangents[0], tl)
            c2 = dot(v2, v2)
            end = norm(sub(rl, mul(v2, 2 / c2 * dot(v2, rl))) if c2 > 1e-18 else rl)
        b0 = cross(tangents[0], normals[0])
        angle = math.atan2(dot(end, b0), dot(end, normals[0]))
        for i in range(n):
            a = -angle * i / n
            t, nn = tangents[i], normals[i]
            bb = cross(t, nn)
            normals[i] = norm(add(mul(nn, math.cos(a)), mul(bb, math.sin(a))))
    return [(t, nn, cross(t, nn)) for t, nn in zip(tangents, normals)]


def sweep(path_points, closed, outline, twist=0.0, taper=None, segments_hint=None):
    n = len(outline)
    frames = rmf_frames(path_points, closed)
    dist = [0.0]
    for a, b in zip(path_points, path_points[1:]):
        dist.append(dist[-1] + math.dist(a, b))
    total = dist[-1] + (math.dist(path_points[-1], path_points[0]) if closed else 0.0)
    mesh = Mesh()
    rings, ring_v, poles = [], [], {}
    count = len(path_points)
    for i, (p, (t, nn, bb)) in enumerate(zip(path_points, frames)):
        u = dist[i] / max(total, 1e-9)
        s = eval_curve(taper, u)
        a = math.radians(twist) * u
        c, si = math.cos(a), math.sin(a)
        if s <= 1e-6 and not closed and i in (0, count - 1):
            poles[i] = mesh.v(p)
            continue
        ring = []
        for q in outline:
            x, y = (q[0] * c - q[1] * si) * s, (q[0] * si + q[1] * c) * s
            ring.append(mesh.v(add(p, add(mul(nn, x), mul(bb, y)))))
        rings.append(ring)
        ring_v.append(dist[i])
    if len(rings) < 1 or (len(rings) < 2 and not poles):
        raise ValueError("Model spec: a sweep needs a profile with area along its path")
    perim = arc_us([(q[0], q[1], 0.0) for q in outline])
    if closed:
        rings.append(rings[0])
        ring_v.append(total)
    ring_strip(mesh, rings, [perim] * len(rings), ring_v)
    if not closed:
        for end, ring, top in ((0, rings[0], False), (count - 1, rings[-1], True)):
            if end in poles:
                pole_fan(mesh, ring, poles[end], top, perim, ring_v[0] if not top else ring_v[-1], dist[end])
            else:
                cap(mesh, ring, outline, top)
    return mesh


def displace(mesh, field, mask=None):
    """Move every vertex along its normal by field(p) * mask(p); welded topology stays closed."""
    normals = mesh.vertex_normals()
    mesh.verts = [add(p, mul(nrm, field(p) * (mask(p) if mask else 1.0))) for p, nrm in zip(mesh.verts, normals)]
    return mesh
