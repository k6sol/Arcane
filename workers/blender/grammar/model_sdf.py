"""Signed distance fields, seeded noise and a watertight mesher for the model spec.

Primitives (sphere, box, capsule/round cone, torus, cone, cylinder, ellipsoid) combine in
list order with smooth union/subtract/intersect. Noise is seeded fBm value noise with
optional domain warp. Meshing is marching tetrahedra on a Freudenthal (Kuhn) split of a
uniform grid: unambiguous, so the output is always a closed 2-manifold. Only grid blocks
the distance bound cannot exclude are sampled (narrow band). Pure Python, deterministic.
"""
import math

from model_geom import Mesh, euler, inverse, apply

MASK = 0xFFFFFFFF


def hash3(x, y, z, seed):
    h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144665) & MASK
    h = ((h ^ (h >> 13)) * 1274126177) & MASK
    return ((h ^ (h >> 16)) & 0xFFFF) / 32767.5 - 1.0


def value_noise(x, y, z, seed):
    ix, iy, iz = math.floor(x), math.floor(y), math.floor(z)
    fx, fy, fz = x - ix, y - iy, z - iz
    ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
    uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
    uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10)
    c000, c100 = hash3(ix, iy, iz, seed), hash3(ix + 1, iy, iz, seed)
    c010, c110 = hash3(ix, iy + 1, iz, seed), hash3(ix + 1, iy + 1, iz, seed)
    c001, c101 = hash3(ix, iy, iz + 1, seed), hash3(ix + 1, iy, iz + 1, seed)
    c011, c111 = hash3(ix, iy + 1, iz + 1, seed), hash3(ix + 1, iy + 1, iz + 1, seed)
    x00 = c000 + (c100 - c000) * ux
    x10 = c010 + (c110 - c010) * ux
    x01 = c001 + (c101 - c001) * ux
    x11 = c011 + (c111 - c011) * ux
    y0 = x00 + (x10 - x00) * uy
    y1 = x01 + (x11 - x01) * uy
    return y0 + (y1 - y0) * uz


def fbm(p, scale, octaves, seed):
    """fBm in about [-1, 1] at feature size `scale` metres."""
    x, y, z = p[0] / scale, p[1] / scale, p[2] / scale
    total, amp, norm_ = 0.0, 1.0, 0.0
    for o in range(octaves):
        total += amp * value_noise(x, y, z, seed + 31 * o)
        norm_ += amp
        x, y, z = x * 2.03 + 17.1, y * 2.03 + 3.7, z * 2.03 + 9.2
        amp *= .5
    return total / norm_


def noise_field(spec, seed):
    """Closure p -> displacement in metres (fBm with optional domain warp)."""
    amp, scale, octaves, warp = spec["amp"], spec["scale"], spec["octaves"], spec["warp"]
    s = (seed * 7919 + spec["seed"] * 104729) & 0xFFFF

    def field(p):
        if warp > 0:
            q = (p[0] + warp * scale * fbm(p, scale * 1.7, 2, s + 101), p[1] + warp * scale * fbm(p, scale * 1.7, 2, s + 202),
                 p[2] + warp * scale * fbm(p, scale * 1.7, 2, s + 303))
        else:
            q = p
        return amp * fbm(q, scale, octaves, s)
    return field


def noise_mask(spec):
    m = spec.get("mask")
    if not m:
        return None
    axis = "xyz".index(m["axis"])
    lo, hi = m["from"], m["to"]

    def mask(p):
        t = (p[axis] - lo) / (hi - lo)
        t = max(0.0, min(1.0, t))
        return t * t * (3 - 2 * t)
    return mask


# -------------------------------------------------------------- primitives --
def _len2(x, y):
    return math.sqrt(x * x + y * y)


def _len3(x, y, z):
    return math.sqrt(x * x + y * y + z * z)


def prim_distance(s):
    """Return (local distance closure, local bounds half-extent, approx surface area)."""
    kind, rnd = s["prim"], s.get("round", 0.0)
    if kind == "sphere":
        r = s["r"]
        return (lambda x, y, z: _len3(x, y, z) - r), (r, r, r), 4 * math.pi * r * r
    if kind == "box":
        hx, hy, hz = (c / 2 - rnd for c in s["size"])

        def box(x, y, z):
            qx, qy, qz = abs(x) - hx, abs(y) - hy, abs(z) - hz
            return _len3(max(qx, 0), max(qy, 0), max(qz, 0)) + min(max(qx, qy, qz), 0) - rnd
        sx, sy, sz = s["size"]
        return box, (sx / 2, sy / 2, sz / 2), 2 * (sx * sy + sy * sz + sx * sz)
    if kind == "capsule":
        ax, ay, az = s["a"]
        bx, by, bz = s["b"]
        r1, r2 = s["r"], s["r2"]
        dx, dy, dz = bx - ax, by - ay, bz - az
        l2 = dx * dx + dy * dy + dz * dz
        ln = math.sqrt(l2)

        def capsule(x, y, z):
            px, py, pz = x - ax, y - ay, z - az
            t = (px * dx + py * dy + pz * dz) / l2 if l2 > 1e-18 else 0.0
            # Tapered capsule: radius interpolates along the segment (bound-safe approximation).
            t = max(0.0, min(1.0, t))
            return _len3(px - dx * t, py - dy * t, pz - dz * t) - (r1 + (r2 - r1) * t)
        lo = [min(a, b) - max(r1, r2) for a, b in zip(s["a"], s["b"])]
        hi = [max(a, b) + max(r1, r2) for a, b in zip(s["a"], s["b"])]
        centre = [(a + b) / 2 for a, b in zip(lo, hi)]
        half = tuple((b - a) / 2 for a, b in zip(lo, hi))
        area = 2 * math.pi * (r1 + r2) / 2 * ln + 2 * math.pi * (r1 * r1 + r2 * r2)
        return capsule, half, area, tuple(centre)
    if kind == "torus":
        R, r = s["r"], s["r2"]
        return (lambda x, y, z: _len2(_len2(x, y) - R, z) - r), (R + r, R + r, r), 4 * math.pi * math.pi * R * r
    if kind in ("cone", "cylinder"):
        r1, r2, h = s["r"] - rnd, s["r2"] - rnd, s["h"] / 2 - rnd
        r1, r2 = max(r1, 0.0), max(r2, 0.0)
        k2x, k2y = r2 - r1, 2 * h
        k2l = k2x * k2x + k2y * k2y

        def cone(x, y, z):
            # Capped (truncated) cone along z from -h (radius r1) to +h (radius r2); exact (iq).
            q = _len2(x, y)
            ax = q - min(q, r1 if z < 0 else r2)
            ay = abs(z) - h
            t = max(0.0, min(1.0, ((r2 - q) * k2x + (h - z) * k2y) / k2l)) if k2l > 0 else 0.0
            bx = q - r2 + k2x * t
            by = z - h + k2y * t
            sign = -1.0 if (bx < 0 and ay < 0) else 1.0
            return sign * math.sqrt(min(ax * ax + ay * ay, bx * bx + by * by)) - rnd
        R = max(s["r"], s["r2"])
        slant = math.hypot(s["h"], s["r"] - s["r2"])
        return cone, (R, R, s["h"] / 2), math.pi * (s["r"] + s["r2"]) * slant + math.pi * (s["r"] ** 2 + s["r2"] ** 2)
    rx, ry, rz = s["radii"]

    def ellipsoid(x, y, z):
        k0 = _len3(x / rx, y / ry, z / rz)
        k1 = _len3(x / (rx * rx), y / (ry * ry), z / (rz * rz))
        return k0 * (k0 - 1) / k1 if k1 > 1e-12 else -min(rx, ry, rz)
    p = 1.6075
    area = 4 * math.pi * (((rx * ry) ** p + (rx * rz) ** p + (ry * rz) ** p) / 3) ** (1 / p)
    return ellipsoid, (rx, ry, rz), area


def smin(a, b, k):
    if k <= 0:
        return min(a, b)
    h = max(k - abs(a - b), 0.0) / k
    return min(a, b) - h * h * k * .25


def smax(a, b, k):
    return -smin(-a, -b, k)


class Field:
    """The combined field of one sdf part (local coordinates)."""

    def __init__(self, shapes, noise=None, seed=0):
        self.items, lo, hi, self.area = [], [1e9] * 3, [-1e9] * 3, 0.0
        self.min_feature = 1e9
        for s in shapes:
            got = prim_distance(s)
            dist, half, area = got[0], got[1], got[2]
            centre = got[3] if len(got) > 3 else (0.0, 0.0, 0.0)
            m = inverse(euler(s["rot"]))
            ax, ay, az = s["at"]
            rot = tuple(tuple(m[r][c] for c in range(3)) for r in range(3))
            self.items.append((dist, rot, (ax, ay, az), s["op"], s["blend"]))
            if s["op"] == "union":
                self.area += area
                # Rotated bounds: conservative box of the rotated half extents.
                fwd = euler(s["rot"])
                ext = [sum(abs(fwd[r][c]) * half[c] for c in range(3)) for r in range(3)]
                cw = apply(fwd, centre)
                for k in range(3):
                    lo[k] = min(lo[k], s["at"][k] + cw[k] - ext[k] - s["blend"])
                    hi[k] = max(hi[k], s["at"][k] + cw[k] + ext[k] + s["blend"])
            self.min_feature = min(self.min_feature, min(half))
        self.noise = noise_field(noise, seed) if noise else None
        self.mask = noise_mask(noise) if noise else None
        pad = (noise["amp"] * 1.2 if noise else 0.0)
        self.lo = tuple(v - pad for v in lo)
        self.hi = tuple(v + pad for v in hi)
        self.margin = pad * 2

    def __call__(self, p):
        x0, y0, z0 = p
        d = None
        for dist, r, at, op, k in self.items:
            x, y, z = x0 - at[0], y0 - at[1], z0 - at[2]
            lx = r[0][0] * x + r[0][1] * y + r[0][2] * z
            ly = r[1][0] * x + r[1][1] * y + r[1][2] * z
            lz = r[2][0] * x + r[2][1] * y + r[2][2] * z
            di = dist(lx, ly, lz)
            if d is None:
                d = di
            elif op == "union":
                d = smin(d, di, k)
            elif op == "subtract":
                d = smax(d, -di, k)
            else:
                d = smax(d, di, k)
        if self.noise is not None:
            d -= self.noise(p) * (self.mask(p) if self.mask else 1.0)
        return d


# Freudenthal split of the unit cube along the 0-7 diagonal; corner c = x + 2y + 4z.
TETS = ((0, 1, 3, 7), (0, 1, 5, 7), (0, 2, 3, 7), (0, 2, 6, 7), (0, 4, 5, 7), (0, 4, 6, 7))
CORNERS = tuple(((c & 1), (c >> 1) & 1, (c >> 2) & 1) for c in range(8))


def mesh_field(field, cell, max_cells=96):
    """Marching tetrahedra over the field's padded bounds with cubic cells of `cell` metres."""
    lo = [v - 2 * cell for v in field.lo]
    hi = [v + 2 * cell for v in field.hi]
    dims = [max(4, int(math.ceil((b - a) / cell))) for a, b in zip(lo, hi)]
    if max(dims) > max_cells:
        cell = max((b - a) for a, b in zip(lo, hi)) / max_cells
        dims = [max(4, int(math.ceil((b - a) / cell))) for a, b in zip(lo, hi)]
    nx, ny, nz = dims
    values = {}

    def value(i, j, k):
        key = (i, j, k)
        v = values.get(key)
        if v is None:
            if i <= 0 or j <= 0 or k <= 0 or i >= nx or j >= ny or k >= nz:
                v = cell  # The padded border is always outside: the surface closes.
            else:
                v = field((lo[0] + i * cell, lo[1] + j * cell, lo[2] + k * cell))
                if v == 0.0:
                    v = 1e-12
            values[key] = v
        return v
    mesh = Mesh()
    mesh.auto_uv = True
    edge_vertex = {}

    def vertex(a, b, va, vb):
        key = (a, b) if a < b else (b, a)
        idx = edge_vertex.get(key)
        if idx is None:
            t = va / (va - vb)
            t = min(.98, max(.02, t))
            p = tuple(lo[n] + (a[n] + (b[n] - a[n]) * t) * cell for n in range(3))
            idx = mesh.v(p)
            edge_vertex[key] = idx
        return idx
    block = 4
    half_diag = cell * block * math.sqrt(3) / 2
    for bi in range(0, nx, block):
        for bj in range(0, ny, block):
            for bk in range(0, nz, block):
                c = (lo[0] + (bi + block / 2) * cell, lo[1] + (bj + block / 2) * cell, lo[2] + (bk + block / 2) * cell)
                if abs(field(c)) > half_diag + field.margin + cell:
                    continue
                for i in range(bi, min(bi + block, nx)):
                    for j in range(bj, min(bj + block, ny)):
                        for k in range(bk, min(bk + block, nz)):
                            grid = [(i + dx, j + dy, k + dz) for dx, dy, dz in CORNERS]
                            vals = [value(*g) for g in grid]
                            neg = sum(1 for v in vals if v < 0)
                            if neg == 0 or neg == 8:
                                continue
                            for tet in TETS:
                                tv = [vals[t] for t in tet]
                                inside = [n for n in range(4) if tv[n] < 0]
                                if not inside or len(inside) == 4:
                                    continue
                                outside = [n for n in range(4) if tv[n] >= 0]
                                g = [grid[t] for t in tet]
                                if len(inside) == 1 or len(outside) == 1:
                                    lone = inside[0] if len(inside) == 1 else outside[0]
                                    others = [n for n in range(4) if n != lone]
                                    tri = [vertex(g[lone], g[o], tv[lone], tv[o]) for o in others]
                                    _orient(mesh, tri, [g[n] for n in inside], [g[n] for n in outside])
                                else:
                                    a, b = inside
                                    c2, d2 = outside
                                    quad = [vertex(g[a], g[c2], tv[a], tv[c2]), vertex(g[a], g[d2], tv[a], tv[d2]),
                                            vertex(g[b], g[d2], tv[b], tv[d2]), vertex(g[b], g[c2], tv[b], tv[c2])]
                                    _orient(mesh, quad[:3], [g[a], g[b]], [g[c2], g[d2]])
                                    _orient(mesh, [quad[0], quad[2], quad[3]], [g[a], g[b]], [g[c2], g[d2]])
    return mesh, cell


def _orient(mesh, tri, inside, outside):
    p = [mesh.verts[i] for i in tri]
    n = ((p[1][1] - p[0][1]) * (p[2][2] - p[0][2]) - (p[1][2] - p[0][2]) * (p[2][1] - p[0][1]),
         (p[1][2] - p[0][2]) * (p[2][0] - p[0][0]) - (p[1][0] - p[0][0]) * (p[2][2] - p[0][2]),
         (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]))
    ci = [sum(v[k] for v in inside) / len(inside) for k in range(3)]
    co = [sum(v[k] for v in outside) / len(outside) for k in range(3)]
    if n[0] * (co[0] - ci[0]) + n[1] * (co[1] - ci[1]) + n[2] * (co[2] - ci[2]) < 0:
        tri = [tri[0], tri[2], tri[1]]
    mesh.faces.append(tuple(tri))
    mesh.uvs.append(((0.0, 0.0), (1.0, 0.0), (0.0, 1.0)))
