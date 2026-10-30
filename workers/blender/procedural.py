"""Bundled, parameterised procedural generators: tree, rock, column, foliage, log and stump.

Data-only recipes. The host validates every parameter (packages/asset-pipeline
src/procedural.ts) before this file runs. No eval/exec, file paths, imports or
network from input. Every generator is deterministic for its seed, builds closed
manifold components only (leaf cards are thin closed slabs, never open planes)
and bounds its own triangle count before any mesh exists in Blender.
"""
import math
import random

# Geometry helpers below use only plain tuples, so the triangle accounting and
# budget planner can be exercised without Blender (tests/unit/*_test.py).
GENERATORS = ("tree", "rock", "column", "foliage", "log", "stump")
HARD_TRIANGLE_LIMIT = 20000
TUBE_MIN_RADIUS = 0.004


def tube_triangles(sides, rings, tip):
    # Side quads, a bottom n-gon cap and a top cone tip or n-gon cap.
    return 2 * sides * (rings - 1) + (sides - 2) + (sides if tip else sides - 2)


def leaf_triangles():
    return 12


def lathe_triangles(segments, rings):
    return 2 * segments * (rings - 1) + 2 * (segments - 2)


def box_triangles():
    return 12


def icosphere_triangles(subdivisions):
    return 20 * 4 ** (subdivisions - 1)


# ---------------------------------------------------------------- vectors ---
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


def norm(a):
    length = math.sqrt(dot(a, a))
    if length < 1e-12:
        return (0.0, 0.0, 1.0)
    return (a[0] / length, a[1] / length, a[2] / length)


def perpendicular(t):
    helper = (1.0, 0.0, 0.0) if abs(t[0]) < 0.9 else (0.0, 1.0, 0.0)
    return norm(cross(t, helper))


def rotate(v, axis, angle):
    # Rodrigues rotation of v around a unit axis.
    c, s = math.cos(angle), math.sin(angle)
    return add(add(mul(v, c), mul(cross(axis, v), s)), mul(axis, dot(axis, v) * (1 - c)))


def direction(yaw, pitch):
    # pitch: angle above the horizontal plane.
    cp = math.cos(pitch)
    return (cp * math.cos(yaw), cp * math.sin(yaw), math.sin(pitch))


# ------------------------------------------------------------ mesh builder ---
def wood_tile_uvs(distances, sides, wood_uv):
    """Per-face bark UVs for one blunt tube: the periodic tile repeats along and around the branch.

    ``distances`` are the station arc lengths plus the apex. ``wood_uv`` is {"around": n,
    "period": metres, "strip": f(station, j) -> (v0, h, pad)}: n (a divisor of ``sides``) tile
    repeats round the circumference, and about one repeat every ``period`` metres along it.
    Repeat boundaries fall on stations (each run of whole segments closest to ``period`` spans
    exactly one repeat), so every face fits inside one tile copy: UV0 stays in 0..1 and the
    periodic texture stays continuous across faces. A strip is a horizontal band of the tile
    (v0, height h, inset by ``pad``) whose content repeats within it; default the whole tile.
    ``strip(first, last, j)`` is chosen once per repeat (its first and last station), so strips
    change only where the tile wraps: transition strips then keep the bark continuous."""
    n, period = wood_uv["around"], wood_uv["period"]
    if n < 1 or sides % n:
        raise ValueError("Bark tile repeats must divide the tube sides")
    m = len(distances) - 1
    level, group, i, g = [0.0] * (m + 1), [0] * m, 0, 0
    bounds = []
    while i < m:
        e = i + 1
        while e < m and distances[e + 1] - distances[i] <= period:
            e += 1
        if e < m and abs(distances[e + 1] - distances[i] - period) < abs(distances[e] - distances[i] - period):
            e += 1
        run = max(distances[e] - distances[i], 1e-9)
        span = run / period if e == m and run <= period else 1.0
        for x in range(i, e):
            level[x + 1] = g + span * (distances[x + 1] - distances[i]) / run
            group[x] = g
        bounds.append((i, e))
        g, i = g + 1, e
    strip = wood_uv.get("strip") or (lambda first, last, j: (0.0, 1.0, 0.0))

    def face(index, j):
        v0, h, pad = strip(*bounds[group[index]], j)
        k = (n * j) // sides
        ua, ub = n * j / sides - k, n * (j + 1) / sides - k
        va, vb = (v0 + pad + (h - 2 * pad) * (level[x] - group[index]) for x in (index, index + 1))
        if index == m - 1:
            # Blunt apex: the last segment closes on one point.
            return ((ua, va), (ub, va), ((ua + ub) / 2, vb))
        return ((ua, va), (ub, va), (ub, vb), (ua, vb))
    return face


class MeshData:
    """Plain vertex/face lists for one material; converted to bmesh by build()."""

    def __init__(self):
        self.vertices = []
        self.faces = []
        self.smooth = []
        self.uvs = []
        # Natural broadleaf bark only: trunk/branch split, radius samples and junctions
        # that build() needs for the blended union. None keeps the legacy path.
        self.wood = None
        # Natural canopy only: one soft shading normal per vertex (outward from its leaf cluster),
        # applied as custom split normals so clusters shade as masses, not single cards.
        self.normals = None
        # Natural finish only: UV intent and texture size from the UV stage (engine_uvs).
        self.uv_report = None
        # Natural rock forms only: per-vertex bake inputs and chart rects (see plan_natural_rock).
        self.bake = None

    def vertex(self, co):
        self.vertices.append((float(co[0]), float(co[1]), float(co[2])))
        return len(self.vertices) - 1

    def face(self, indices, smooth=True, uvs=None):
        self.faces.append(tuple(indices))
        self.smooth.append(smooth)
        if uvs is None:
            # Planar caps/boxes: pick the projection with the largest signed area.
            points = [self.vertices[index] for index in indices]
            normal = cross(sub(points[1], points[0]), sub(points[2], points[0]))
            axis = max(range(3), key=lambda k: abs(normal[k]))
            a, b = [k for k in range(3) if k != axis]
            low = [min(p[k] for p in points) for k in (a, b)]
            span = [max(p[k] for p in points) - low[n] for n, k in enumerate((a, b))]
            uvs = [((p[a] - low[0]) / max(span[0], 1e-9), (p[b] - low[1]) / max(span[1], 1e-9)) for p in points]
        self.uvs.append(tuple(uvs))

    def triangles(self):
        return sum(len(f) - 2 for f in self.faces)

    def tube(self, spine, radii, sides, tip=True, flare=None, collar=None, blunt=False, tangents=None, wood_uv=None):
        """Closed tapered tube along a polyline with parallel-transport frames.

        Natural wood options (all off for legacy callers): ``collar=(parent_radius,
        emerge_distance)`` swells the branch where it leaves its parent and keeps the
        buried part inside it; ``blunt`` keeps a ring at every station and closes the
        end with a short apex 0.9 r beyond the last ring; ``tangents`` overrides the
        finite-difference tangents for sparse adaptive stations. ``wood_uv`` (natural bark only)
        repeats the periodic bark tile along and around the branch instead of stretching one tile
        over it; see ``wood_tile_uvs``.
        """
        if len(spine) < 2 or len(spine) != len(radii):
            raise ValueError("Tube spine/radius mismatch")
        if tangents is None:
            tangents = []
            for i in range(len(spine)):
                a = spine[max(0, i - 1)]
                b = spine[min(len(spine) - 1, i + 1)]
                tangents.append(norm(sub(b, a)))
        normal = perpendicular(tangents[0])
        distances = [0.0]
        for a, b in zip(spine, spine[1:]):
            distances.append(distances[-1] + math.dist(a, b))
        distance = max(distances[-1], 1e-9)
        if blunt:
            apex_length = 0.9 * max(TUBE_MIN_RADIUS, radii[-1])
            distance = distances[-1] + apex_length
        if collar is not None:
            parent_radius, emerge = collar
            r0 = max(TUBE_MIN_RADIUS, radii[0])
            # A collar about a branch diameter wide: a thin limb on a thick parent must not swell
            # into a long cone along its first metre.
            width = 1.3 * r0 + .25 * min(parent_radius, 2.5 * r0)
            amplitude = .30 * (1 - .65 * min(1.0, r0 / parent_radius))
            radii = [r * (1 + amplitude * math.exp(-((s - emerge) / width) ** 2)) for r, s in zip(radii, distances)]
            radii = [min(r, .84 * parent_radius) if s < emerge else r for r, s in zip(radii, distances)]
        rings = []
        last = len(spine) - (1 if tip and not blunt else 0)
        for i in range(last):
            if i:
                axis = cross(tangents[i - 1], tangents[i])
                if dot(axis, axis) > 1e-12:
                    angle = math.acos(max(-1.0, min(1.0, dot(tangents[i - 1], tangents[i]))))
                    normal = norm(rotate(normal, norm(axis), angle))
            binormal = norm(cross(tangents[i], normal))
            radius = max(TUBE_MIN_RADIUS, radii[i])
            ring = []
            for j in range(sides):
                theta = 2 * math.pi * j / sides
                r = radius
                if flare is not None:
                    r *= flare(i, theta)
                offset = add(mul(normal, math.cos(theta) * r), mul(binormal, math.sin(theta) * r))
                ring.append(self.vertex(add(spine[i], offset)))
            rings.append(ring)
        if wood_uv is not None:
            if not (blunt and len(rings) == len(spine)):
                raise ValueError("Bark tile UVs require blunt tubes")
            uv_face = wood_tile_uvs(distances + [distance], sides, wood_uv)
        for index, (a, b) in enumerate(zip(rings, rings[1:])):
            for j in range(sides):
                k = (j + 1) % sides
                if wood_uv is not None:
                    self.face((a[j], a[k], b[k], b[j]), uvs=uv_face(index, j))
                    continue
                self.face((a[j], a[k], b[k], b[j]), uvs=((j / sides, distances[index] / distance), ((j + 1) / sides, distances[index] / distance),
                          ((j + 1) / sides, distances[index + 1] / distance), (j / sides, distances[index + 1] / distance)))
        self.face(tuple(reversed(rings[0])), smooth=False)
        if blunt and wood_uv is not None:
            apex = self.vertex(add(spine[-1], mul(tangents[-1], apex_length)))
            top = rings[-1]
            for j in range(sides):
                self.face((top[j], top[(j + 1) % sides], apex), uvs=uv_face(len(rings) - 1, j))
        elif blunt:
            apex = self.vertex(add(spine[-1], mul(tangents[-1], apex_length)))
            top = rings[-1]
            for j in range(sides):
                self.face((top[j], top[(j + 1) % sides], apex), uvs=((j / sides, distances[-1] / distance),
                          ((j + 1) / sides, distances[-1] / distance), ((j + .5) / sides, 1.0)))
        elif tip:
            apex = self.vertex(spine[-1])
            top = rings[-1]
            for j in range(sides):
                self.face((top[j], top[(j + 1) % sides], apex), uvs=((j / sides, distances[len(rings) - 1] / distance),
                          ((j + 1) / sides, distances[len(rings) - 1] / distance), ((j + .5) / sides, 1.0)))
        else:
            self.face(tuple(rings[-1]), smooth=False)

    def leaf(self, base, axis, face_normal, length, width, thickness):
        """Closed curved lanceolate leaf, with a continuous rim and explicit mirrored vein UVs.

        Six rim samples replace the old four-corner diamond. A cupped centre and gently
        curled tip read in silhouette; front/back share UV0 and remain opaque/manifold.
        """
        axis = norm(axis)
        side = cross(axis, face_normal)
        side = norm(side) if dot(side, side) > 1e-6 else perpendicular(axis)
        up = norm(cross(side, axis))
        rim = [(0, 0), (.32, .5), (.72, .38), (1, 0), (.72, -.38), (.32, -.5)]
        indices, uv = [], []
        for t, across in rim:
            curl = length * (.025 * t ** 3 - .008 * math.sin(math.pi * t))
            point = add(add(add(base, mul(axis, length * t)), mul(side, width * across)), mul(up, curl))
            indices.append(self.vertex(point))
            uv.append((abs(across), t))
        centre = add(add(base, mul(axis, length * .46)), mul(up, length * .012))
        hi, lo = self.vertex(add(centre, mul(up, thickness * .5))), self.vertex(add(centre, mul(up, -thickness * .5)))
        for n, a in enumerate(indices):
            k = (n + 1) % len(indices)
            self.face((a, indices[k], hi), uvs=(uv[n], uv[k], (0, .46)))
            self.face((indices[k], a, lo), uvs=(uv[k], uv[n], (0, .46)))

    def card(self, base, axis, face_normal, length, width, thickness, rect, bend=0.0, droop=0.0, cup=0.0):
        """Closed curved cutout card for one leaf-spray atlas tile: the leaf() lens (six rim samples,
        front/back apex, 12 triangles) on a rectangle. ``rect`` (u0, v0, u1, v1) is the tile: across
        maps to u, the twig (base -> tip) to v. ``bend`` arches the card along its length, ``droop``
        pulls the tip back and ``cup`` bends the long sides back, so no card is one flat plane."""
        axis = norm(axis)
        side = cross(axis, face_normal)
        side = norm(side) if dot(side, side) > 1e-6 else perpendicular(axis)
        up = norm(cross(side, axis))
        u0, v0, u1, v1 = rect

        def at(t, across):
            # Keep the basal edge centred on its declared root. The other sampled
            # stations (t=.5 and t=1) retain the original cup and tip shape.
            curl = length * (bend * 4 * t * (1 - t) - droop * t * t) - cup * width * across * across * smoothstep(2 * t)
            return add(add(add(base, mul(axis, length * t)), mul(side, width * across / 2)), mul(up, curl))
        rim = [(0, 1), (.5, 1), (1, 1), (1, -1), (.5, -1), (0, -1)]
        indices = [self.vertex(at(t, across)) for t, across in rim]
        uv = [(u0 + (u1 - u0) * (across + 1) / 2, v0 + (v1 - v0) * t) for t, across in rim]
        centre = at(.5, 0)
        hi, lo = self.vertex(add(centre, mul(up, thickness * .5))), self.vertex(add(centre, mul(up, -thickness * .5)))
        mid = ((u0 + u1) / 2, (v0 + v1) / 2)
        for n, a in enumerate(indices):
            k = (n + 1) % len(indices)
            self.face((a, indices[k], hi), uvs=(uv[n], uv[k], mid))
            self.face((indices[k], a, lo), uvs=(uv[k], uv[n], mid))

    def lathe(self, profile, segments, modulate=None):
        """Closed surface of revolution around +Z; profile is [(radius, z)] bottom->top."""
        rings = []
        for index, (radius, z) in enumerate(profile):
            ring = []
            for j in range(segments):
                theta = 2 * math.pi * j / segments
                r = radius * (modulate(index, z, theta) if modulate else 1.0)
                ring.append(self.vertex((math.cos(theta) * r, math.sin(theta) * r, z)))
            rings.append(ring)
        z0, z1 = profile[0][1], profile[-1][1]
        for index, (a, b) in enumerate(zip(rings, rings[1:])):
            for j in range(segments):
                k = (j + 1) % segments
                v0, v1 = (profile[index][1] - z0) / max(z1 - z0, 1e-9), (profile[index + 1][1] - z0) / max(z1 - z0, 1e-9)
                self.face((a[j], a[k], b[k], b[j]), uvs=((j / segments, v0), ((j + 1) / segments, v0), ((j + 1) / segments, v1), (j / segments, v1)))
        self.face(tuple(reversed(rings[0])), smooth=False)
        self.face(tuple(rings[-1]), smooth=False)

    def box(self, center, size):
        x, y, z = (size[0] / 2, size[1] / 2, size[2] / 2)
        corners = [(-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z), (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z)]
        v = [self.vertex(add(center, c)) for c in corners]
        for face in ((3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
            self.face(tuple(v[i] for i in face), smooth=False)


# -------------------------------------------------------------- tree ---------
SPECIES = {
    # trunk radius / height, crown start, branch pitch range (deg), leaf (length, width), leaf colour, bark colour
    "pine": {"radius": 0.022, "crown": 0.22, "pitch": (-28, 8), "leaf": (0.34, 0.15), "bark": (0.24, 0.14, 0.09), "leaves": (0.05, 0.16, 0.07), "spread": 0.42},
    "oak": {"radius": 0.045, "crown": 0.38, "pitch": (18, 55), "leaf": (0.34, 0.24), "bark": (0.22, 0.18, 0.14), "leaves": (0.12, 0.25, 0.06), "spread": 0.8},
    "birch": {"radius": 0.026, "crown": 0.3, "pitch": (35, 65), "leaf": (0.2, 0.14), "bark": (0.82, 0.8, 0.75), "leaves": (0.24, 0.42, 0.1), "spread": 0.5},
    "palm": {"radius": 0.03, "crown": 0.92, "pitch": (5, 30), "leaf": (0.7, 0.07), "bark": (0.42, 0.34, 0.24), "leaves": (0.14, 0.32, 0.08), "spread": 0.7},
}


def species_defaults(species):
    return SPECIES[species]


class Budget:
    def __init__(self, total, wood_share):
        self.total = total
        self.wood = int(total * wood_share)
        self.used = 0

    def take(self, triangles, wood=True):
        limit = self.wood if wood else self.total
        if self.used + triangles > limit:
            return False
        self.used += triangles
        return True


def spine_points(start, heading, length, steps, rng, wobble, gravity):
    points = [start]
    d = norm(heading)
    step = length / steps
    position = start
    for _ in range(steps):
        d = norm(add(add(d, (rng.uniform(-wobble, wobble), rng.uniform(-wobble, wobble), rng.uniform(-wobble, wobble))), (0, 0, -gravity)))
        position = add(position, mul(d, step))
        points.append(position)
    return points


def plan_tree(params, seed, budget_total):
    """Returns (bark MeshData, leaves MeshData). Pure Python; deterministic."""
    if params.get("finish") == "natural" and (params["species"] in BROADLEAF or params["species"] in CONIFER):
        return plan_broadleaf(params, seed, budget_total)
    rng = random.Random(seed)
    species = params["species"]
    spec = SPECIES[species]
    height = params["height"]
    levels = params["branchLevels"]
    density = params["leafDensity"]
    base_radius = params["trunkRadius"] or height * spec["radius"]
    taper = params["trunkTaper"]
    bark, leaves = MeshData(), MeshData()
    budget = Budget(budget_total, 0.3 if species != "palm" else 0.22)
    anchors = []  # (position, branch direction, scale)

    # Conifers/birches taper to a leader tip; oaks and palms keep girth where limbs/crown attach.
    pinch = 0.92 if species in ("pine", "birch") else 0.3

    def radius_at(r0, t):
        return r0 * (1 - (1 - taper) * t) * (1 - pinch * t ** 3)

    # Trunk.
    trunk_steps = 16 if species == "palm" else 12
    trunk_sides = 12
    lean = (rng.uniform(-1, 1) * (0.18 if species == "palm" else 0.04), rng.uniform(-1, 1) * (0.18 if species == "palm" else 0.04), 1)
    if species == "oak":
        trunk_length = height * rng.uniform(0.43, 0.48)
    else:
        trunk_length = height * (0.98 if species != "palm" else 0.94)
    trunk = spine_points((0.0, 0.0, 0.0), lean, trunk_length, trunk_steps, rng, 0.05 if species != "pine" else 0.015, 0.0)
    if species == "palm":
        # Palms arc: bend the upper trunk along the lean direction.
        bend = norm((lean[0], lean[1], 0)) if abs(lean[0]) + abs(lean[1]) > 1e-6 else (1, 0, 0)
        trunk = [add(p, mul(bend, height * 0.08 * (i / trunk_steps) ** 2)) for i, p in enumerate(trunk)]
    trunk[0] = (0.0, 0.0, 0.0)
    trunk_radii = [radius_at(base_radius, i / trunk_steps) for i in range(trunk_steps + 1)]
    if species == "palm":
        trunk_radii = [r * (1.0 + 0.06 * ((i % 2) * 2 - 1)) for i, r in enumerate(trunk_radii)]
    tip = species != "palm"

    def flare(i, theta):
        # Buttress roots at the base: lobed and widened over the first rings.
        if i > 2:
            return 1.0
        strength = (1 - i / 3.0)
        return 1.0 + strength * (0.35 + 0.18 * math.cos(5 * theta + seed % 7))

    bark.tube(trunk, trunk_radii, trunk_sides, tip=tip, flare=None if species == "palm" else flare)
    budget.take(tube_triangles(trunk_sides, len(trunk), tip))

    def grow(points, radii, level, scale):
        """Spawn child branches along a parent spine (breadth-first via queue)."""
        children = []
        if level > levels:
            return children
        count = {1: 9, 2: 5, 3: 4}[level] if species != "pine" else {1: 22, 2: 4, 3: 3}[level]
        if species == "oak" and level == 1:
            count = 7
        start_t = spec["crown"] if level == 1 else 0.25
        sides = {1: 7, 2: 5, 3: 4}[level]
        steps = {1: 5, 2: 4, 3: 3}[level]
        for n in range(count):
            t = start_t + (1 - start_t) * ((n + rng.uniform(0.15, 0.85)) / count)
            if species == "oak" and level == 1:
                # Stagger substantial limbs along the upper trunk, rather than a single umbrella joint.
                t = .48 + .5 * ((n + rng.uniform(.2, .8)) / count)
            index = min(len(points) - 2, int(t * (len(points) - 1)))
            frac = t * (len(points) - 1) - index
            origin = add(points[index], mul(sub(points[index + 1], points[index]), frac))
            parent_dir = norm(sub(points[index + 1], points[index]))
            parent_radius = radii[index] * (1 - frac) + radii[index + 1] * frac
            yaw = (n * 2.39996 + seed * .37 + rng.uniform(-0.22, 0.22)) if level == 1 else (n * 2.39996 + rng.uniform(-.5, .5))
            low, high = spec["pitch"]
            if species == "oak":
                low, high = 28, 65
            pitch = math.radians(rng.uniform(low, high))
            if level == 1:
                heading = direction(yaw, pitch)
            else:
                side = perpendicular(parent_dir)
                side = rotate(side, parent_dir, yaw)
                heading = norm(add(add(mul(parent_dir, 0.72), mul(side, 0.62)), (0, 0, .12 if species == "oak" else 0)))
                if species == "pine":
                    heading = norm(add(heading, (0, 0, -0.15)))
            if species == "pine" and level == 1:
                length = height * spec["spread"] * (1 - t) ** 0.9 * rng.uniform(0.8, 1.1) + height * 0.04
            elif level == 1:
                length = height * spec["spread"] * rng.uniform(0.4, 0.56) * scale
                if species == "oak":
                    length *= 1.08 - .36 * t
            else:
                length = sum(math.dist(a, b) for a, b in zip(points, points[1:])) * rng.uniform(0.35, 0.6)
            radius = max(TUBE_MIN_RADIUS * 1.5, min(parent_radius * 0.72, parent_radius * (0.55 if level == 1 else 0.6)))
            if species == "oak" and level == 1:
                radius = parent_radius * rng.uniform(0.5, 0.68)
            gravity = 0.06 if species in ("pine", "birch") else 0.02
            spine = spine_points(origin, heading, length, steps, rng, 0.12, gravity * (1 if level < 3 else 2))
            child_radii = [radius * max(.06, (1 - i / steps) ** 1.15) for i in range(steps + 1)]
            cost = tube_triangles(sides, len(spine), True)
            if not budget.take(cost):
                return children
            bark.tube(spine, child_radii, sides, tip=True)
            children.append((spine, child_radii, level + 1))
            for i in range(1, len(spine)):
                if i / len(spine) >= (0.25 if species == "pine" else 0.4):
                    # Keep leaves attached to the terminal branch spans. Save the segment, not an
                    # unconnected cloud centre; lower-level woody limbs stay readable through the crown.
                    if level == levels or level >= 2:
                        anchors.append((spine[i - 1], spine[i], 1.0))
        return children

    if species == "palm":
        # Crown of arching fronds: spine with leaflet pairs, no woody branches.
        crown = trunk[-1]
        fronds = math.ceil(16 * density)
        for n in range(fronds):
            yaw = n * 2 * math.pi / fronds + rng.uniform(-0.2, 0.2)
            pitch = math.radians(rng.uniform(15, 45))
            length = height * rng.uniform(0.32, 0.42)
            spine = spine_points(crown, direction(yaw, pitch), length, 8, rng, 0.02, 0.16)
            radii = [base_radius * 0.18 * (1 - 0.8 * i / 8) for i in range(9)]
            if not budget.take(tube_triangles(4, len(spine), True), wood=False):
                break
            leaves.tube(spine, radii, 4, tip=True)
            for i in range(1, len(spine)):
                anchors.append((spine[i - 1], spine[i], 1.0 - 0.6 * (i / len(spine))))
    else:
        # Level by level, shuffled, so an exhausted budget thins every limb evenly.
        current = [(trunk, trunk_radii, 1)]
        while current:
            following = []
            for points, radii, level in current:
                following.extend(grow(points, radii, level, 1.0))
            rng.shuffle(following)
            current = following
        # The trunk top is also foliage for broadleaf crowns.
        if not anchors or species in ("pine", "birch"):
            for i in range(max(1, int(len(trunk) * .7)), len(trunk)):
                anchors.append((trunk[i - 1], trunk[i], 0.8))

    # Zero means bare wood, including palms without frond stems or leaflets.
    if density == 0:
        return bark, leaves

    # Complete leaves scale linearly with density; a positive fraction requests
    # at least one leaf when capacity exists, with no hidden minimum percentage.
    remaining = max(0, budget_total - budget.used)
    capacity = remaining // leaf_triangles()
    wanted = math.ceil(capacity * density)
    if not anchors or wanted <= 0:
        raise ValueError("Tree has no foliage anchors within budget")
    leaf_length, leaf_width = spec["leaf"]
    # A bounded geometric leaf stands for a small leaf spray at game viewing distances.
    leaf_length *= max(.8, min(2.8, height / 5.0))
    leaf_width *= max(.8, min(2.8, height / 5.0))
    for n in range(wanted):
        start, end, scale = anchors[n % len(anchors)]
        along = norm(sub(end, start))
        position = add(start, mul(sub(end, start), rng.uniform(.1, 1.0)))
        if species == "palm":
            side = norm(cross(along, (0, 0, 1)))
            sign = 1 if n % 2 else -1
            axis = norm(add(mul(side, sign), add(mul(along, 0.35), (0, 0, -0.25))))
            base = add(position, mul(along, rng.uniform(-0.15, 0.15) * leaf_length))
            leaves.leaf(base, axis, (0, 0, 1), leaf_length * scale * rng.uniform(0.75, 1.1), leaf_width, leaf_width * 0.12)
            continue
        base = position
        if species == "pine":
            # Needle sprays: flat, near-horizontal cards fanned out along the bough.
            flat = norm((along[0], along[1], 0.0)) if abs(along[0]) + abs(along[1]) > 1e-3 else (1.0, 0.0, 0.0)
            axis = norm(add(rotate(flat, (0.0, 0.0, 1.0), rng.uniform(-1.1, 1.1)), (0.0, 0.0, rng.uniform(-0.25, 0.08))))
            face = norm((rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), 1))
        else:
            side = rotate(perpendicular(along), along, n * 2.39996 + rng.uniform(-.3, .3))
            axis = norm(add(add(mul(along, .35), mul(side, .9)), (0, 0, -.16)))
            face = norm((rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), 1))
        size = rng.uniform(0.75, 1.2) * scale
        leaves.leaf(base, axis, face, leaf_length * size, leaf_width * size, max(0.0008, leaf_width * 0.012))
    return bark, leaves


# ------------------------------------------------- natural broadleaf wood ---
# Finish "natural" oak/birch: space-aware growth from smooth direction fields, a
# length-supported pipe radius field, pruning to foliage anchors and swept tubes
# with collars and a buttressed base. Authored for a 7.5 m tree and scaled by
# height. Pure Python and deterministic; build() unions and fairs the result.
V5_HEIGHT = 7.5
V5_STEP = .08
V5_TIP_RADIUS = .0022
PRUNE_DIAMETER = max(.01, 2 * TUBE_MIN_RADIUS)
UP = (0.0, 0.0, 1.0)
# Generation-time wood radius proxy per order, so clearance is surface-to-centreline.
PROXY_RADIUS = {0: .20, 1: .09, 2: .035, 3: .015, 4: .004}
# The Exact union adds seam rings; reserve them so bark + leaves stay inside the budget.
UNION_RESERVE = 1.1
# Junction seam fairing: Taubin smoothing pairs over the seam band.
FAIR_PAIRS = 12
# Junction UV relaxation after fairing (relax_junction_uvs): on, and its harmonic Jacobi passes.
JUNCTION_UV_RELAX = True
JUNCTION_UV_PASSES = 8
# Union slivers shorter than this are collapsed before the structural gate.
SLIVER_DIST = 1e-5
# Order-3 wood inlet radius <= prune radius + slope * length, so short limbs read as slender
# shoots rather than thorn-like cones once their twigs are pruned to foliage anchors.
WHIP_SLOPE = .016
# Fraction of each wood axis whose radius eases down to the prune diameter.
TIP_TAPER = .22
# (trunk sides, side scale, station step scale), richest first.
WOOD_PRESETS = ((40, 1.0, 1.0), (32, 1.0, 1.2), (28, .86, 1.4), (24, .75, 1.7), (24, .64, 2.1), (24, .64, 2.6), (16, .6, 3.2), (12, .6, 4.0))

BROADLEAF = {
    # Lengths in metres for a 7.5 m tree. Spawn rows: (parent order, order, spacing, first, last,
    # departure deg, length rule (a, b, min, max) -> clamp(a*remaining+b), bend, wiggle, droop, min clearance).
    "oak": {"trunk": 5.7, "lean": .075, "crownCentre": 4.75, "crownRadius": (3.4, 2.75), "bh": .55, "flare": 1.0,
            "scaffolds": ((2.05, 3.5, .32), (2.55, 3.3, .42), (3.15, 3.0, .55), (3.75, 2.7, .70), (4.35, 2.3, .85)),
            "spawn": ((1, 2, .52, .30, .93, (36., 46.), (.52, .45, .6, 2.2), .65, .09, .12, .32),
                      (0, 2, .48, .80, .97, (34., 46.), (.6, .7, .7, 1.9), .6, .09, .08, .32),
                      (2, 3, .36, .18, .93, (36., 46.), (.5, .35, .45, 1.35), .45, .14, .12, .15)),
            "twigDroop": .05},
    "birch": {"trunk": 6.9, "lean": .05, "crownCentre": 4.7, "crownRadius": (2.1, 3.0), "bh": .6, "flare": .62,
              "scaffolds": ((2.3, 2.2, .62), (2.85, 2.05, .68), (3.4, 1.9, .74), (3.95, 1.75, .8), (4.5, 1.6, .86),
                            (5.05, 1.4, .92), (5.6, 1.2, .98)),
              "spawn": ((1, 2, .44, .28, .93, (34., 46.), (.45, .35, .5, 1.5), .55, .08, .30, .28),
                        (0, 2, .44, .74, .97, (30., 42.), (.5, .5, .5, 1.3), .5, .07, .12, .28),
                        (2, 3, .32, .18, .93, (36., 46.), (.45, .3, .35, 1.0), .4, .12, .38, .14)),
              "twigDroop": .25},
}
# Buttress lobes: (azimuth, strength, concentration, support height m). Unequal, five.
FLARE_LOBES = ((.35, 1.15, 22.0, 1.05), (1.55, .65, 28.0, .62), (2.70, .95, 24.0, .90), (3.95, .55, 30.0, .52), (5.10, .85, 20.0, .95))
FLARE_AMBIENT = (.20, .55)


def smoothstep(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def slerp(a, b, t):
    c = max(-1.0, min(1.0, dot(a, b)))
    w = math.acos(c)
    if w < 1e-6:
        return norm(add(mul(a, 1 - t), mul(b, t)))
    s = math.sin(w)
    return norm(add(mul(a, math.sin((1 - t) * w) / s), mul(b, math.sin(t * w) / s)))


def lateral_frame(t):
    """Lateral basis around tangent t; the first vector is the up-most perpendicular."""
    e1 = sub(UP, mul(t, dot(UP, t)))
    if dot(e1, e1) < 1e-6:
        e1 = sub((1.0, 0.0, 0.0), mul(t, t[0]))
    e1 = norm(e1)
    return e1, norm(cross(t, e1))


def polyline_tangent(points, i):
    return norm(sub(points[min(len(points) - 1, i + 1)], points[max(0, i - 1)]))


def grow_axis(start, d0, dT, length, bend, wiggle, wavelength, droop, phases):
    """Integrate a smooth direction field: d0 eases into dT over ``bend`` with a fading wiggle."""
    n = max(3, int(math.ceil(length / V5_STEP)))
    h = length / n
    u, w = lateral_frame(dT)
    points, p = [start], start
    for i in range(n):
        s = (i + .5) * h
        d = slerp(d0, dT, smoothstep(s / bend))
        fade = smoothstep(s / max(bend * .6, 1e-6))
        wig = add(mul(u, wiggle * math.sin(2 * math.pi * s / wavelength + phases[0])),
                  mul(w, .75 * wiggle * math.sin(2 * math.pi * s / (wavelength * 1.37) + phases[1])))
        d = norm(add(add(d, mul(wig, fade)), (0.0, 0.0, -droop * (s / length) ** 2)))
        p = add(p, mul(d, h))
        points.append(p)
    return points


class Clearance:
    """Hash grid of accepted wood/twig samples with per-order proxy radii."""

    def __init__(self, cell=.3):
        self.cell, self.grid = cell, {}

    def key(self, p):
        return (math.floor(p[0] / self.cell), math.floor(p[1] / self.cell), math.floor(p[2] / self.cell))

    def insert(self, p, axis, radius):
        self.grid.setdefault(self.key(p), []).append((p, axis, radius))

    def clearance(self, p, exclude, cap):
        k, reach, best = self.key(p), int(math.ceil(cap / self.cell)), cap
        for dx in range(-reach, reach + 1):
            for dy in range(-reach, reach + 1):
                for dz in range(-reach, reach + 1):
                    for q, axis, radius in self.grid.get((k[0] + dx, k[1] + dy, k[2] + dz), ()):
                        if axis not in exclude:
                            best = min(best, math.dist(p, q) - radius)
        return best


def grow_broadleaf(profile, rng):
    """Axes (dicts with order/parent/attach/points) for a 7.5 m broadleaf; order 4 is twig only."""
    space = Clearance()
    axes = []
    centre = (0.0, 0.0, profile["crownCentre"])
    reach = (profile["crownRadius"][0], profile["crownRadius"][0], profile["crownRadius"][1])

    def inside(p, pad=0.0):
        return sum(((p[k] - centre[k]) / (reach[k] + pad)) ** 2 for k in range(3)) <= 1.0

    def register(axis):
        axis["id"] = len(axes)
        axes.append(axis)
        for p in axis["points"][1:]:
            space.insert(p, axis["id"], PROXY_RADIUS[axis["order"]])
        return axis

    yaw = rng.uniform(0, 2 * math.pi)
    lean = norm((profile["lean"] * math.cos(yaw), profile["lean"] * math.sin(yaw), 1.0))
    trunk = register({"order": 0, "parent": None, "attach": None, "kind": "trunk", "points": grow_axis(
        (0.0, 0.0, 0.0), UP, lean, profile["trunk"], 3.0, .045, 3.1, 0.0, (rng.uniform(0, 6.28), rng.uniform(0, 6.28)))})

    def lateral(parent, index, azimuth, departure, elevation, total, bend, wiggle, droop, order):
        pts = parent["points"]
        t = polyline_tangent(pts, index)
        if order == 1:
            # World-anchored azimuth on the near-vertical trunk, so the 75 degree scaffold
            # separation holds in plan view and not just in a lean-dependent local frame.
            e1 = norm(sub((1.0, 0.0, 0.0), mul(t, t[0])))
            e2 = norm(cross(t, e1))
        else:
            e1, e2 = lateral_frame(t)
        side = norm(add(mul(e1, math.cos(azimuth)), mul(e2, math.sin(azimuth))))
        d0 = norm(add(mul(t, math.cos(departure)), mul(side, math.sin(departure))))
        if order == 1:
            flat = norm((side[0], side[1], 0.0)) if math.hypot(side[0], side[1]) > 1e-3 else (1.0, 0.0, 0.0)
            target = norm(add(mul(flat, math.cos(elevation)), mul(UP, math.sin(elevation))))
        else:
            # Keep turning away from the parent, with a phototropic lift.
            out = norm(add(mul(t, math.cos(departure + elevation)), mul(side, math.sin(departure + elevation))))
            target = norm(add(out, (0.0, 0.0, .22)))
        path = grow_axis(pts[index], d0, target, total, bend, wiggle, rng.uniform(1.1, 1.9) * max(total, .4),
                         droop, (rng.uniform(0, 6.28), rng.uniform(0, 6.28)))
        return path, d0

    def score(path, parent_id, skip, cap):
        clear, outside = cap, 0
        for p in path[skip:]:
            clear = min(clear, space.clearance(p, {parent_id}, cap))
            if not inside(p, .15) and p[2] > 1.2:
                outside += 1
        return clear, outside / max(1, len(path) - skip)

    def trim(path, keep):
        for i, p in enumerate(path):
            if i * V5_STEP > keep and not inside(p, .1):
                return path[:max(i, 3)]
        return path

    # Scaffolds: azimuths at least 75 degrees apart, 30-34 degree departure, outward turn.
    golden = 2.39996
    phase = rng.uniform(0, 2 * math.pi)
    used = []
    for n, (height, total, elevation) in enumerate(profile["scaffolds"]):
        height += rng.uniform(-.12, .12)
        total *= rng.uniform(.9, 1.06)
        index = min(len(trunk["points"]) - 2, int(round(height / V5_STEP)))
        best = None
        for k in range(12):
            azimuth = (phase + n * golden + k * math.radians(30.0)) % (2 * math.pi)
            separation = min([math.pi - abs(abs(azimuth - a) % (2 * math.pi) - math.pi) for a, z in used if abs(z - height) < 1.3] or [math.pi])
            if separation < math.radians(75.0):
                continue
            path, d0 = lateral(trunk, index, azimuth, math.radians(rng.uniform(30.0, 34.0)), elevation, total, 1.7, .07, .05, 1)
            clear, out = score(path, 0, 8, .9)
            value = clear - 1.5 * out - .08 * k
            if best is None or value > best[0]:
                best = (value, azimuth, path, d0)
        if best is None:
            continue
        used.append((best[1], height))
        register({"order": 1, "parent": 0, "attach": index, "kind": "scaffold", "points": trim(best[2], 1.5), "departure": best[3]})

    def spawn(parent, order, spacing, first, last, departure, rule, bend, wiggle, droop, min_clear):
        pts = parent["points"]
        total = (len(pts) - 1) * V5_STEP
        s = first * total + rng.uniform(0.0, spacing * .5)
        spiral = rng.uniform(0, 2 * math.pi)
        a, b, low, high = rule
        while s < last * total:
            index = min(len(pts) - 2, max(1, int(round(s / V5_STEP))))
            want = min(high, max(low, a * (total - s) + b)) * rng.uniform(.85, 1.12)
            spiral += golden
            best = None
            for k in (0, 1, -1, 2, -2, 3, -3):
                azimuth = spiral + k * math.radians(32.0)
                dep = math.radians(rng.uniform(*departure))
                path, d0 = lateral(parent, index, azimuth, dep, math.radians(rng.uniform(8.0, 22.0)), want, bend, wiggle, droop, order)
                if d0[2] < -.35:
                    continue
                radial_dir = (pts[index][0], pts[index][1], 0.0)
                flat = (d0[0], d0[1], 0.0)
                radial = math.sqrt(dot(radial_dir, radial_dir))
                inward_dot = dot(norm(flat), norm(radial_dir)) if radial > .05 and math.sqrt(dot(flat, flat)) > .2 else 0.0
                # Laterals near the trunk that head back inward cross the crown core: penalise them.
                inward = inward_dot < (.25 if radial < 1.4 else -.45)
                clear, out = score(path, parent["id"], max(2, int(math.ceil((PROXY_RADIUS[order - 1] + .06) / V5_STEP))), .6)
                value = clear - 1.2 * out - (.6 if inward else 0.0) - .02 * abs(k)
                if best is None or value > best[0]:
                    best = (value, clear, out, path, d0)
            if best and best[1] >= min_clear and best[2] < .35:
                path = trim(best[3], .35) if order < 4 else best[3]
                if len(path) >= 3:
                    register({"order": order, "parent": parent["id"], "attach": index, "points": path, "departure": best[4],
                              "kind": "twig" if order == 4 else "branch"})
            s += spacing * rng.uniform(.8, 1.2)

    for parent_order, order, *row in profile["spawn"]:
        for parent in [x for x in axes if x["order"] == parent_order]:
            spawn(parent, order, *row)
    # Order-4 twigs bear foliage only; they are never wood.
    for parent in [x for x in axes if x["order"] in (2, 3)]:
        spawn(parent, 4, .15, .25 if parent["order"] == 3 else .6, .98, (42.0, 56.0), (.3, .1, .13, .3), .12, .06, profile["twigDroop"], .07)
    return axes


def pipe_radii(axes, base_radius, taper=.55):
    """Length-supported pipe field; Gaussian-smoothed along arc length, monotone, child <= 0.8 parent.

    ``base_radius`` is the breast-height (1.3 m at 7.5 m scale) trunk radius in the same units as
    the axes. ``trunkTaper`` scales the trunk field around its 0.55 default.
    """
    children = [[] for _ in axes]
    for a in axes:
        if a["parent"] is not None:
            children[a["parent"]].append(a)
    sub_length = [0.0] * len(axes)
    for a in sorted(axes, key=lambda a: -a["order"]):
        sub_length[a["id"]] = (len(a["points"]) - 1) * V5_STEP + sum(sub_length[c["id"]] for c in children[a["id"]])
    support = []
    for a in axes:
        n = len(a["points"])
        extra = [0.0] * n
        for c in children[a["id"]]:
            for i in range(c["attach"] + 1):
                extra[i] += sub_length[c["id"]]
        support.append([(n - 1 - i) * V5_STEP + extra[i] for i in range(n)])
    bh = support[0][min(len(support[0]) - 1, int(round(1.3 / V5_STEP)))]
    k = (base_radius ** 2 - V5_TIP_RADIUS ** 2) / max(bh, 1e-9)
    sigma_by_order = {0: .38, 1: .30, 2: .16, 3: .09, 4: .05}
    for a in axes:
        raw = [math.sqrt(V5_TIP_RADIUS ** 2 + k * length) for length in support[a["id"]]]
        sigma = sigma_by_order[a["order"]]
        reach = int(math.ceil(3 * sigma / V5_STEP))
        squared = [r * r for r in raw]
        smooth = []
        for i in range(len(raw)):
            num = den = 0.0
            for j in range(max(0, i - reach), min(len(raw), i + reach + 1)):
                w = math.exp(-.5 * ((j - i) * V5_STEP / sigma) ** 2)
                num += w * squared[j]
                den += w
            smooth.append(math.sqrt(num / den))
        for i in range(1, len(smooth)):
            smooth[i] = min(smooth[i], smooth[i - 1])
        if a["order"] == 0:
            count = max(1, len(smooth) - 1)
            smooth = [r * max(.3, (1 - (1 - taper) * i / count) / (1 - .45 * i / count)) * (1 + .11 * max(0.0, 1 - p[2] / 1.7) ** 2)
                      for i, (r, p) in enumerate(zip(smooth, a["points"]))]
        a["radii"] = smooth
    for a in sorted(axes, key=lambda a: a["order"]):
        if a["parent"] is not None:
            cap = .80 * axes[a["parent"]]["radii"][a["attach"]]
            if a["radii"][0] > cap:
                f = cap / a["radii"][0]
                a["radii"] = [r * f for r in a["radii"]]
    return axes


def prune_wood(axes, max_order, prune_radius):
    """Mark wood axes, truncate each where it thins below the prune diameter and ease its tip.

    Returns foliage anchor chains: every pruned axis and the remainder past each wood tip.
    """
    anchors = []
    for a in axes:
        parent_kept = a["parent"] is None or axes[a["parent"]]["kept"]
        if a["parent"] is not None and parent_kept:
            parent = axes[a["parent"]]
            # Wood children sit on the parent's wood with margin and keep their inlet under the
            # 0.8 cap of the parent's final (tip-eased) radius; tip forks stay foliage, never stubs.
            parent_kept = a["attach"] <= parent["woodCount"] - 3
            cap = .8 * parent["radii"][a["attach"]]
            if a["radii"][0] > cap:
                a["radii"] = [r * cap / a["radii"][0] for r in a["radii"]]
        a["kept"] = parent_kept and a["order"] <= max_order and a["radii"][0] >= prune_radius
        if not a["kept"]:
            a["woodCount"] = 0
            anchors.append((a["id"], a["order"], a["points"]))
            continue
        last = max(i for i, r in enumerate(a["radii"]) if r >= prune_radius or i == 0)
        a["woodCount"] = min(len(a["points"]), max(3, last + 2))
        taper_tip(a, prune_radius)
        tail = a["points"][a["woodCount"] - 1:]
        if len(tail) >= 2:
            anchors.append((a["id"], a["order"] + 1, tail))
    return anchors


def taper_tip(axis, prune_radius):
    """Ease the last TIP_TAPER of the wood length smoothly down to the prune radius."""
    points, radii, count = axis["points"], axis["radii"], axis["woodCount"]
    cum = [0.0]
    for a, b in zip(points[:count], points[1:count]):
        cum.append(cum[-1] + math.dist(a, b))
    total = cum[-1]
    start = total * (1 - TIP_TAPER)
    eased = list(radii)
    for i in range(count):
        if cum[i] > start and total > start:
            w = smoothstep((cum[i] - start) / (total - start))
            eased[i] = min(radii[i], radii[i] * (1 - w) + prune_radius * w) if radii[i] > prune_radius else radii[i]
    axis["radii"] = eased


# Natural bark tile (textures.bark_tile): physical size of one repeat (around, along) in metres.
BARK_TILE = {"oak": (.42, 1.0), "birch": (.5, .6), "pine": (.5, .8)}
# Birch tile strips (v0, height) of the 512 px texture: clean white bark with lenticels, white bark
# with dark patches and the dark rugged base, each repeating within itself (inset half a texel),
# plus two grading strips: "rise" (patched at its foot, clean at its top) and "fall" (base -> patched).
BIRCH_STRIPS = {"base": (4 / 512, 68 / 512), "fall": (72 / 512, 68 / 512), "patched": (140 / 512, 76 / 512), "rise": (216 / 512, 92 / 512),
                "clean": (308 / 512, 200 / 512)}
# Pine tile strips (v0, height): deep reddish-brown plates of the lower trunk, a grading strip and the
# thin, lighter flaking bark of the upper trunk and limbs; must match textures.PINE_ROWS.
PINE_STRIPS = {"plated": (4 / 512, 224 / 512), "grade": (228 / 512, 96 / 512), "upper": (324 / 512, 184 / 512)}
BARK_RESOLUTION = 512


def bark_tile(species, order, spine, radius, sides, rng, dead=False):
    """Tube ``wood_uv`` for natural bark: tile repeats round the branch from its circumference (a
    divisor of its sides), isotropic repeat length on thin axes, and birch trunk strips by height."""
    around_m, along_m = BARK_TILE[species]
    circumference = 2 * math.pi * max(radius, TUBE_MIN_RADIUS)
    around = min((d for d in range(1, sides + 1) if sides % d == 0), key=lambda d: (abs(math.log(d * around_m / circumference)), d))
    period = along_m * min(1.0, circumference / (around * around_m))
    result = {"around": around, "period": period}
    if species == "pine":
        return pine_bark_strips(result, order, spine, rng, dead)
    if species != "birch":
        return result
    pad = .5 / BARK_RESOLUTION

    def band(name):
        v0, h = BIRCH_STRIPS[name]
        return (v0, h, pad)
    if order > 0:
        # Thin young twigs are darker and blotched; limbs keep the clean white bark.
        name = "patched" if radius < .014 else "clean"
        result["strip"] = lambda first, last, j: band(name)
        return result
    z0 = spine[0][2]
    height = spine[-1][2] - z0
    # Whole repeats change strip: dark base, a "fall" repeat that grades base into patched bark,
    # patched repeats, a "rise" repeat that grades into clean white bark, then clean. The grading
    # (and its ragged edge) lives in the texture, so the trunk shows no horizontal step.
    reach = (.09 + .03 * rng.uniform(-1, 1)) * height
    patch = max(reach + 2 * period, (.2 + .04 * rng.uniform(-1, 1)) * height)

    def strip(first, last, j):
        zs, ze = (spine[min(s, len(spine) - 1)][2] - z0 for s in (first, last))
        name = "base" if ze < reach else "fall" if zs < reach else "patched" if ze < patch else "rise" if zs < patch else "clean"
        return band(name)
    result["strip"] = strip
    return result


def bark_uv_bands(species):
    """The v bands one bark tile copy may use (each strip inset by half a texel, else the whole tile):
    junction UV relaxation keeps every corner inside its own band, so no strip bleeds into another."""
    strips = {"birch": BIRCH_STRIPS, "pine": PINE_STRIPS}.get(species)
    if strips is None:
        return [(0.0, 1.0)]
    pad = .5 / BARK_RESOLUTION
    return [(v0 + pad, v0 + h - pad) for v0, h in sorted(strips.values())]


def pine_bark_strips(result, order, spine, rng, dead=False):
    """Pine trunk: plated bark up to about 40% of the trunk, one grading repeat, then the thin upper
    bark, which every living limb also wears (dead stubs keep the dark plated bark). Whole repeats
    change strip, as on birch."""
    pad = .5 / BARK_RESOLUTION

    def band(name):
        v0, h = PINE_STRIPS[name]
        return (v0, h, pad)
    if order > 0:
        result["strip"] = lambda first, last, j: band("plated" if dead else "upper")
        return result
    z0 = spine[0][2]
    top = (.4 + .06 * rng.uniform(-1, 1)) * (spine[-1][2] - z0)

    def strip(first, last, j):
        zs, ze = (spine[min(s, len(spine) - 1)][2] - z0 for s in (first, last))
        return band("plated" if ze < top else "grade" if zs < top else "upper")
    result["strip"] = strip
    return result


def wood_stations(axis, parent, step_scale, trunk):
    """Adaptive stations (arc length) by distance, turn and radius change, plus forced flare/collar/tip rings."""
    points, radii = axis["points"][:axis["woodCount"]], axis["radii"][:axis["woodCount"]]
    cum = [0.0]
    for a, b in zip(points, points[1:]):
        cum.append(cum[-1] + math.dist(a, b))
    total = cum[-1]
    # Leaner presets keep fewer forced rings so the budget goes to more limbs, not denser ones.
    lean = step_scale >= 1.6
    forced = {total * f for f in ((1 - TIP_TAPER, 1 - TIP_TAPER * .4) if lean else (1 - TIP_TAPER, 1 - TIP_TAPER * .55, 1 - TIP_TAPER * .22))}
    if trunk:
        heights = (0.0, .05, .12, .22, .36, .55, .8, 1.05) if lean else (0.0, .03, .07, .12, .19, .28, .39, .52, .67, .84, 1.03, 1.25)
        forced |= {z for z in heights if z < total}
    if parent is not None:
        emerge, rc = parent["emerge"], radii[0]
        offsets = ((.6, 0), (1, .9), (1, 2.6)) if lean else ((.45, 0), (.8, 0), (1, 0), (1, .9), (1, 2.0), (1, 3.5))
        forced |= {s for s in (emerge * a + b * rc for a, b in offsets) if s < total * .8}
    for index, rc, wide in axis.get("sockets", ()):
        # A ring at every child socket keeps the buried child start on the parent's swept
        # centreline (sparse chords would expose it). On trunk and scaffolds, rings around the
        # socket keep the seam's split triangles short so shading cannot streak a crease.
        if index < len(cum):
            offsets = ((-1.2, 0.0, 1.5) if step_scale >= 1.6 else (-1.2, 0.0, 1.2, 3.2)) if wide else (0.0,)
            forced |= {cum[index] + k * rc for k in offsets if 0 < cum[index] + k * rc < total * .9}
    out, last = [0.0], 0
    for i in range(1, len(points) - 1):
        step = min(.42, max(.09, 4.5 * radii[i])) * step_scale
        ta = norm(sub(points[last + 1], points[last]))
        tb = norm(sub(points[i + 1], points[i]))
        turn = math.degrees(math.acos(max(-1.0, min(1.0, dot(ta, tb)))))
        if cum[i] - out[-1] >= step or turn >= 11.0 * math.sqrt(step_scale) or radii[last] - radii[i] > .2 * radii[last]:
            out.append(cum[i])
            last = i
    merged = []
    for s in sorted(set(out) | forced):
        if not merged or s - merged[-1] > .012:
            merged.append(s)
    while len(merged) > 1 and total - merged[-1] < .03:
        merged.pop()
    merged.append(total)

    def at(s):
        s = min(max(s, 0.0), total)
        for i in range(1, len(cum)):
            if s <= cum[i]:
                t = (s - cum[i - 1]) / max(cum[i] - cum[i - 1], 1e-12)
                return add(points[i - 1], mul(sub(points[i], points[i - 1]), t)), radii[i - 1] + (radii[i] - radii[i - 1]) * t
        return points[-1], radii[-1]
    return [(s,) + at(s) + (norm(sub(at(s + .04)[0], at(s - .04)[0])),) for s in merged]


def wood_sides(radius, order, trunk_sides, scale):
    if order == 0:
        return trunk_sides
    base = 12 if radius >= .06 else 9 if radius >= .03 else 7 if radius >= .016 else 6 if radius >= .009 else 5
    return max(5, int(round(base * scale)))


def flare_gain(theta, z, strength=1.0):
    """Buttress swell: five unequal von-Mises lobes that narrow with height, plus an ambient term."""
    if z >= 1.05:
        return 0.0

    def fade(h, e=1.5):
        return max(0.0, 1 - max(z, 0.0) / h) ** e
    gain = FLARE_AMBIENT[0] * fade(FLARE_AMBIENT[1], 2.4)
    for phase, lobe, concentration, h in FLARE_LOBES:
        k = concentration * (1 + 1.6 * min(1.0, max(z, 0.0) / h))
        gain += lobe * math.exp(k * (math.cos(theta - phase) - 1)) * fade(h)
    return gain * strength


def broadleaf_skeleton(params, rng):
    """Grown, radius-fielded and pruned axes in 7.5 m units: (axes, foliage anchor chains, scale)."""
    species = params["species"]
    spec, profile = SPECIES[species], BROADLEAF[species]
    height = params["height"]
    scale = height / V5_HEIGHT
    base_radius = params["trunkRadius"] or height * spec["radius"]
    axes = grow_broadleaf(profile, rng)
    pipe_radii(axes, base_radius * profile["bh"] / scale, params["trunkTaper"])
    prune_radius = PRUNE_DIAMETER / 2 / scale
    for a in axes:
        if a["order"] >= 3:
            cap = prune_radius + WHIP_SLOPE * (len(a["points"]) - 1) * V5_STEP
            if a["radii"][0] > cap:
                a["radii"] = [r * cap / a["radii"][0] for r in a["radii"]]
    anchors = prune_wood(axes, params["branchLevels"], prune_radius)
    wood_joints(axes)
    return axes, anchors, scale


def wood_joints(axes):
    """Collar joints of kept child axes: parent radius at the socket and where the child emerges."""
    for a in axes:
        if a["kept"] and a["parent"] is not None:
            p = axes[a["parent"]]
            rp = p["radii"][a["attach"]]
            tp = polyline_tangent(p["points"], a["attach"])
            tc = norm(sub(a["points"][1], a["points"][0]))
            a["joint"] = {"rp": rp, "emerge": min(3 * rp, rp / max(.2, math.sin(math.acos(max(-1.0, min(1.0, dot(tp, tc)))))))}
            if a["radii"][0] > .8 * rp:
                f = .8 * rp / a["radii"][0]
                a["radii"] = [r * f for r in a["radii"]]


def plan_broadleaf(params, seed, budget_total):
    """Natural-finish oak/birch/pine: (bark, leaves) with bark.wood set for the union in build()."""
    rng = random.Random(seed)
    conifer = params["species"] in CONIFER
    spec, profile = SPECIES[params["species"]], (CONIFER if conifer else BROADLEAF)[params["species"]]
    height, density = params["height"], params["leafDensity"]
    axes, anchors, scale = (conifer_skeleton if conifer else broadleaf_skeleton)(params, rng)

    # Wood budget: a larger share than legacy tubes (blended limbs must stay connected to their
    # foliage), or nearly all of it for bare wood. Reserve union seams.
    share = profile.get("woodShare", .45) if density > 0 else .9
    limit = int(budget_total * share / UNION_RESERVE)

    def cost(axis, preset):
        stations = wood_stations(axis, axis.get("joint"), preset[2], axis["order"] == 0)
        n = wood_sides(axis["radii"][0], axis["order"], preset[0], preset[1])
        return 2 * n * (len(stations) - 1) + n + (n - 2)

    def sockets():
        for a in axes:
            a["sockets"] = []
        for a in axes:
            if a["kept"] and a["parent"] is not None:
                rp = axes[a["parent"]]["radii"][a["attach"]]
                axes[a["parent"]]["sockets"].append((a["attach"], a["radii"][0], axes[a["parent"]]["order"] <= 1 and a["radii"][0] >= profile.get("wideSocket", .3) * rp))
    sockets()
    kept = [a for a in axes if a["kept"]]

    def fit(preset, lowest):
        # Drop the thinnest of the deepest wood order first (deterministic), never the trunk.
        costs = {a["id"]: cost(a, preset) for a in kept}
        total, dropped = sum(costs.values()), set()
        for a in sorted(kept, key=lambda a: (-a["order"], a["radii"][0], a["id"])):
            if total <= limit or a["order"] < lowest:
                break
            if a["id"] in dropped:
                continue
            stack = [a]
            while stack:
                x = stack.pop()
                if x["kept"] and x["id"] not in dropped:
                    dropped.add(x["id"])
                    total -= costs[x["id"]]
                    stack.extend(c for c in kept if c["parent"] == x["id"])
        return total <= limit, dropped
    floor = 4
    attempts = [(p, 9) for p in WOOD_PRESETS[:floor + 1]] + [(p, 2) for p in WOOD_PRESETS[floor:]] + [(WOOD_PRESETS[-1], 1)]
    for preset, lowest in attempts:
        ok, dropped = fit(preset, lowest)
        if ok:
            break
    if not ok:
        raise ValueError("Procedural mesh exceeded its triangle budget or is empty")
    chosen = preset
    for a in kept:
        if a["id"] in dropped:
            a["kept"], a["dropped"] = False, True
    sockets()

    bark, leaves = MeshData(), MeshData()
    samples, junctions, trunk_vertices, trunk_faces = [], [], 0, 0
    strength = profile["flare"]
    turn = rng.uniform(0, 2 * math.pi)
    # Bark-only stream: the strip boundary jitter must not shift the canopy's random draws.
    bark_rng = random.Random(seed * 7919 + 17)
    for a in axes:
        if not a["kept"]:
            continue
        stations = wood_stations(a, a.get("joint"), chosen[2], a["order"] == 0)
        n = wood_sides(a["radii"][0], a["order"], chosen[0], chosen[1])
        spine = [mul(c, scale) for _, c, _, _ in stations]
        radii = [r * scale for _, _, r, _ in stations]
        heights = [c[2] for _, c, _, _ in stations]
        flare = None
        if a["order"] == 0:
            def flare(i, theta, heights=heights):
                return 1.0 + flare_gain(theta + turn, heights[i], strength)
        joint = a.get("joint")
        collar = (joint["rp"] * scale, joint["emerge"] * scale) if joint else None
        uv = bark_tile(params["species"], a["order"], spine, radii[0], n, bark_rng, a.get("kind") == "dead")
        bark.tube(spine, radii, n, tip=True, flare=flare, collar=collar, blunt=True, tangents=[t for _, _, _, t in stations], wood_uv=uv)
        samples += list(zip(spine, radii))
        if joint:
            junctions.append((spine[0], radii[0], joint["rp"] * scale))
        if a["order"] == 0:
            trunk_vertices, trunk_faces = len(bark.vertices), len(bark.faces)
    bark.wood = {"trunkVertices": trunk_vertices, "trunkFaces": trunk_faces, "samples": samples, "junctions": junctions, "scale": scale,
                 "triangleLimit": int(math.floor(bark.triangles() * UNION_RESERVE)),
                 "preset": list(chosen), "woodAxes": sum(a["kept"] for a in axes), "uvBands": bark_uv_bands(params["species"])}

    if density == 0:
        return bark, leaves
    remaining = max(0, budget_total - bark.wood["triangleLimit"])
    # Atlas cards each carry a whole leaf spray: fewer, larger cards than the budget would allow.
    capacity = min(remaining // leaf_triangles(), CANOPY[params["species"]]["cards"])
    wanted = math.ceil(capacity * density)
    if conifer:
        if wanted <= 0:
            raise ValueError("Tree has no foliage anchors within budget")
        needle_canopy(leaves, CANOPY[params["species"]], axes, anchors, scale, capacity, wanted, rng)
        return bark, leaves

    def attached(axis_id):
        # Foliage only where its chain reaches kept wood: never on limbs dropped for budget.
        while axis_id is not None:
            if axes[axis_id].get("dropped"):
                return False
            if axes[axis_id]["kept"]:
                return True
            axis_id = axes[axis_id]["parent"]
        return True
    chains, tips, limbs, shoots = [], [], [], []
    for axis_id, order, chain in anchors:
        if attached(axis_id):
            chains.append((order, [mul(p, scale) for p in chain]))
    for a in axes:
        if a["kept"]:
            tips.append(mul(a["points"][a["woodCount"] - 1], scale))
        if a["kept"] and a["parent"] is not None:
            # Inner shoots on scaffolds and limbs (outer half of each wood axis) carry shade foliage.
            count = a["woodCount"]
            limbs += [mul(q, scale) for q in a["points"][count // 2:count - 1:3]]
            shoots += [(mul(a["points"][i], scale), polyline_tangent(a["points"], i)) for i in range(count // 2, count - 1)]
    if not chains or wanted <= 0:
        raise ValueError("Tree has no foliage anchors within budget")
    canopy(leaves, CANOPY[params["species"]], chains, tips, limbs, capacity, wanted, rng, shoots)
    return bark, leaves


# ------------------------------------------------- natural broadleaf canopy ---
# Leaf-spray cards (one 12-triangle closed cutout card each, the budget unit) are grouped into
# clusters on the pruned twigs and the order-2/3 remainders. Each card shows one tile of the
# species leaf-spray atlas (textures.tree_surface), so many leaves ride on few cards. Card size
# comes from the density-1 capacity, so density only chooses how many clusters (a spread-out
# prefix) are kept and coverage scales linearly. Cluster centres: wood tips first (they never
# poke out), then a farthest-point order over the crown shell interleaved with interior clusters
# for depth. Deep and inner clusters use the atlas's shade row, the rest the sunlit row.
CANOPY = {
    # size: cluster size range; per: cards per unit cluster; up/droop: facing bias; cap: dome
    # half-angle (deg); flat: dome depth along its pole; spread: dome radius per card length and
    # sqrt(cards); aspect: card width/length (the atlas tile's); cup: side bend; shell: shell
    # share of clusters; depth: normalised depth where interior starts; area: total card area /
    # crown silhouette at density 1 (sets the card length); out: outward push; hang: sag of
    # drooping clusters; cards: card cap at density 1; bend/tipdrop: card arch and tip droop.
    "oak": {"size": (.7, 1.35), "per": 6, "up": .55, "droop": .1, "cap": 115, "flat": .75, "spread": .5, "aspect": .5,
            "cup": .12, "shell": .75, "depth": .3, "area": 17.0, "out": .3, "hang": 0.0, "reach": .45, "shell_dirs": 160, "soft": .35, "shell_r": (.45, .9),
            "cards": 460, "bend": .1, "tipdrop": .08},
    "birch": {"size": (.7, 1.3), "per": 5, "up": .05, "droop": .55, "cap": 120, "flat": .8, "spread": .36, "aspect": .5,
              "cup": .08, "shell": .75, "depth": .3, "area": 11.5, "out": .2, "hang": 1.2, "reach": .25, "shell_dirs": 160, "soft": .25, "shell_r": (.6, 1.0),
              "cards": 420, "bend": .06, "tipdrop": .2},
    # Pine needle sprays (needle_canopy): outer: share of each whorl branch left bare near the trunk;
    # leader: needled leader length; cover: card length per card share of shoot length; size: card
    # length bounds per height unit; shade: tone below which a card uses the shade row.
    # droop/sag: spray pitch below its shoot at the leader / extra at the crown base.
    "pine": {"cards": 700, "aspect": .5, "outer": .35, "leader": .9, "cover": 10.0, "size": (.3, .9), "droop": .06, "sag": .5,
             "bend": .08, "tipdrop": .14, "cup": .1, "shade": .55},
}
# Leaf-spray atlas: 4 x 2 tiles of 128 x 256 px at 512 (textures.ATLAS); row 0 sunlit, row 1 shade.
ATLAS_COLS, ATLAS_ROWS, ATLAS_PAD = 4, 2, 2 / 512


def atlas_rect(col, row):
    """UV rectangle (u0, v0, u1, v1) of one atlas tile, inset two texels against filter bleed."""
    return (col / ATLAS_COLS + ATLAS_PAD, row / ATLAS_ROWS + ATLAS_PAD, (col + 1) / ATLAS_COLS - ATLAS_PAD, (row + 1) / ATLAS_ROWS - ATLAS_PAD)


def farthest_order(points, count, seeds=()):
    """Deterministic farthest-point order (indices) over points, continuing from seed points."""
    if not points or count <= 0:
        return []
    best = [math.inf] * len(points)
    for q in seeds:
        for i, p in enumerate(points):
            best[i] = min(best[i], math.dist(p, q))
    order = []
    for _ in range(min(count, len(points))):
        i = max(range(len(points)), key=lambda k: (best[k], -k)) if seeds or order else 0
        if best[i] <= 0:
            break
        order.append(i)
        q = points[i]
        for k, p in enumerate(points):
            d = math.dist(p, q)
            if d < best[k]:
                best[k] = d
    return order


class TwigAnchors:
    """Hash grid of foliage anchors (point, unit tangent) on twig chains and outer limb wood. Each
    spray card is rooted on one, so no spray floats free of a twig; reuse is penalised so sprays
    spread along the twigs instead of stacking on one point."""

    def __init__(self, items, cell):
        self.items, self.cell, self.grid, self.uses = items, cell, {}, [0] * len(items)
        for index, (p, _) in enumerate(items):
            self.grid.setdefault(self.key(p), []).append(index)

    def key(self, p):
        return (math.floor(p[0] / self.cell), math.floor(p[1] / self.cell), math.floor(p[2] / self.cell))

    def take(self, q, penalty):
        k = self.key(q)
        near = [i for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1) for i in self.grid.get((k[0] + dx, k[1] + dy, k[2] + dz), ())]
        best = min(near or range(len(self.items)), key=lambda i: (math.dist(self.items[i][0], q) + penalty * self.uses[i], i))
        self.uses[best] += 1
        return self.items[best]


def canopy(leaves, style, chains, tips, limbs, capacity, wanted, rng, shoots=()):
    points = []
    for order, chain in chains:
        points += chain[1::2] if len(chain) > 2 else chain[-1:]
    twigs = [(p, polyline_tangent(chain, i)) for _, chain in chains if len(chain) >= 2 for i, p in enumerate(chain)]
    low = [min(p[k] for p in points) for k in range(3)]
    high = [max(p[k] for p in points) for k in range(3)]
    centre = ((low[0] + high[0]) / 2, (low[1] + high[1]) / 2, low[2] + .45 * (high[2] - low[2]))
    # Star-shaped crown envelope: furthest twig per direction bin, softened by its neighbours.
    az_bins, el_bins = 12, 6

    def bin_of(p):
        d = sub(p, centre)
        az = int((math.atan2(d[1], d[0]) + math.pi) / (2 * math.pi) * az_bins) % az_bins
        el = min(el_bins - 1, int((math.asin(max(-1.0, min(1.0, norm(d)[2]))) + math.pi / 2) / math.pi * el_bins))
        return az, el
    reach = {}
    for p in points:
        b = bin_of(p)
        reach[b] = max(reach.get(b, 0.0), math.dist(p, centre))
    soft = {}
    for (az, el), r in reach.items():
        near = [reach.get(((az + i) % az_bins, el + j), 0.0) for i in (-1, 0, 1) for j in (-1, 0, 1)]
        soft[(az, el)] = max(r, .85 * max(near))

    widest = max(soft.values())

    def depth(p):
        # Bins without twigs fall back to the widest reach (a point there is near the outside).
        return max(0.0, 1 - math.dist(p, centre) / max(soft.get(bin_of(p), widest), 1e-6))
    inner = [p for p in points + limbs if depth(p) >= style["depth"] and p[2] > low[2] + .12 * (high[2] - low[2])]
    # Crown-envelope fill: Fibonacci directions out to the furthest twig within a cone, held
    # within ``reach`` of a twig so every shell cluster stays on (or right at) the wood.
    sample = [(sub(p, centre), p) for p in points[::3]]
    reach = style["reach"] * min((high[0] - low[0] + high[1] - low[1]) / 4, (high[2] - low[2]) / 2)
    cone = math.cos(math.radians(24))
    shell, count = [], style["shell_dirs"]
    for i in range(count):
        z = 1 - 1.6 * (i + .5) / count
        r = math.sqrt(max(0.0, 1 - z * z))
        u = (r * math.cos(i * 2.39996), r * math.sin(i * 2.39996), z)
        extent = max([dot(v, u) for v, _ in sample if dot(v, u) > cone * math.sqrt(dot(v, v))] or [0.0])
        if extent <= 0:
            continue
        q = add(centre, mul(u, extent * (1 - style["depth"] * .35)))
        near = min(sample, key=lambda item: math.dist(item[1], q))[1]
        gap = math.dist(near, q)
        shell.append(q if gap <= reach else add(near, mul(sub(q, near), reach / gap)))
    # Spray length from the density-1 capacity: all sprays together are ``area`` x the front silhouette.
    radii = (high[0] - low[0] + high[1] - low[1]) / 4, (high[2] - low[2]) / 2
    silhouette = math.pi * radii[0] * radii[1]
    spray = math.sqrt(style["area"] * silhouette / (max(1, capacity) * style["aspect"]))
    roots = TwigAnchors(twigs + list(shoots), spray)
    seed_tips = [tips[i] for i in farthest_order(tips, len(tips))]
    shell_order = [shell[i] for i in farthest_order(shell, len(shell), seed_tips)] if shell else []
    inner_order = [inner[i] for i in farthest_order(inner, len(inner), seed_tips + shell_order[:8])] if inner else []
    # Clusters until the density-1 capacity is used; density keeps a prefix of this order.
    queue, si, ii, ti, used = [], 0, 0, 0, 0
    while used < capacity:
        if ti < len(seed_tips):
            p, kind = seed_tips[ti], "tip"
            ti += 1
        elif ii < len(inner_order) and (si >= len(shell_order) or ii * style["shell"] < (si + ti) * (1 - style["shell"])):
            p, kind = inner_order[ii], "inner"
            ii += 1
        elif si < len(shell_order):
            p, kind = shell_order[si], "shell"
            si += 1
        else:
            # Every candidate is used (very small trees): cycle again with fresh jitter.
            si = ii = 0
            ti = len(seed_tips)
            if not shell_order and not inner_order:
                ti = 0
            continue
        size = rng.uniform(*style["size"]) * (.82 if kind == "inner" else 1.0)
        n = max(4, int(round(style["per"] * size * size)))
        queue.append((p, kind, size, n))
        used += n
    remaining = wanted
    for p, kind, size, n in queue:
        if remaining <= 0:
            break
        n = min(n, remaining)
        remaining -= n
        cluster(leaves, style, p, kind, spray, n, centre, depth(p), rng, roots)


def cluster(leaves, style, p, kind, spray, n, centre, deep, rng, roots):
    rho = spray * style["spread"] * math.sqrt(n)
    out = sub(p, centre)
    out = norm((out[0], out[1], out[2] * .6)) if dot(out, out) > 1e-9 else UP
    pole = norm(add(out, mul(UP, style["up"])))
    c = add(p, mul(out, rho * style["out"]))
    if style["hang"]:
        c = add(c, mul(UP, -rho * .25 * style["hang"]))
    # Tone: deep interior clusters darker, high outer clusters lighter, with per-cluster jitter.
    height = max(-1.0, min(1.0, out[2]))
    tone = -1.6 * max(0.0, deep - .1) + .55 * height * (1 - max(0.0, deep)) + rng.uniform(-.4, .4)
    if kind == "inner":
        tone -= .45
    # Shaded clusters use the shade row of the atlas.
    row = 1 if tone < -.35 else 0
    e1 = perpendicular(pole)
    e2 = cross(pole, e1)
    core = sub(c, mul(pole, rho * .45))
    if leaves.normals is None:
        leaves.normals = []
    cap = math.cos(math.radians(style["cap"]))
    spin = rng.uniform(0, 2 * math.pi)
    for i in range(n):
        # Fibonacci dome around the pole: cos(theta) from 1 down to the cap.
        z = 1 - (1 - cap) * (i + .5) / n
        r = math.sqrt(max(0.0, 1 - z * z))
        phi = spin + i * 2.39996
        d = norm(add(add(mul(pole, z), mul(e1, r * math.cos(phi))), mul(e2, r * math.sin(phi))))
        d = norm(add(d, (rng.uniform(-.15, .15), rng.uniform(-.15, .15), rng.uniform(-.15, .15))))
        lift = dot(d, pole)
        q = add(c, mul(sub(d, mul(pole, lift * (1 - style["flat"]))), rho * rng.uniform(*style["shell_r"])))
        if style["hang"]:
            # Drooping species: sprays hang in a curtain below the cluster centre.
            q = add(q, (0.0, 0.0, -rho * style["hang"] * (i + .5) / n))
        # Root the spray on the twig nearest its dome spot, fanned off the twig towards that spot
        # and pulled down for drooping species: lobes grow along the twigs, never free-floating.
        root, tangent = roots.take(q, .6 * spray)
        side = sub(q, root)
        side = sub(side, mul(tangent, dot(side, tangent)))
        side = norm(side) if dot(side, side) > 1e-9 else perpendicular(tangent)
        fan = rng.uniform(.35, 1.0)
        t = norm(add(add(mul(tangent, math.cos(fan)), mul(side, math.sin(fan))), (0.0, 0.0, -style["droop"])))
        length = spray * rng.uniform(.85, 1.15)
        width = length * style["aspect"] * rng.uniform(.92, 1.08)
        # The spray lies in the plane of its twig and its fan (a flat shoot), turned to the light.
        sky = norm(add(out, UP))
        flat = cross(tangent, side)
        flat = mul(flat, -1.0) if dot(flat, sky) < 0 else flat
        face = norm(add(flat, mul(sky, .6)))
        if abs(dot(face, t)) > .98:
            face = perpendicular(t)
        base = root
        rect = atlas_rect(rng.randrange(ATLAS_COLS), row)
        first = len(leaves.vertices)
        leaves.card(base, t, face, length, width, max(.0008, width * .01), rect, bend=style["bend"] * rng.uniform(.4, 1.6),
                    droop=style["tipdrop"] * rng.uniform(.5, 1.5), cup=style["cup"])
        # Soft mass shading: outward from the cluster's core, leaning to the crown's outside and sky,
        # plus a per-spray tilt so neighbouring sprays catch the light differently.
        mottle = mul(face, rng.uniform(-.1, .35))
        for v in leaves.vertices[first:]:
            leaves.normals.append(norm(add(add(add(norm(sub(v, core)), mul(out, style["soft"])), mul(UP, .25)), mottle)))


# ------------------------------------------------------- natural conifer ---
# Finish "natural" pine: a straight monopodial trunk with a continuous taper and a butt flare, whorls
# of branches that droop with age, bare dead stubs below an irregular living crown and order-2
# laterals. Grown in the broadleaf 7.5 m units (scaled by height); wood fitting, tubes and the
# blended union are shared with the broadleaf path. Foliage is needle-spray cards on the outer,
# young part of every living shoot (pine keeps its needles a few years only).
CONIFER = {
    # trunk length; lean; flare strength; living crown base and lowest stub whorl (shares of the trunk);
    # whorl spacing; branches per living whorl; widest branch reach; lateral spacing; wood budget share;
    # child/parent radius ratio for socket ring pairs (whorl branches stay single rings).
    "pine": {"trunk": 7.3, "lean": .03, "flare": .35, "crown": .4, "stubs": .1, "internode": (.36, .52), "whorl": (4, 6),
             "reach": 1.95, "lateral": (.24, .34), "woodShare": .55, "wideSocket": .55},
}


def grow_conifer(profile, rng):
    """Axes for a 7.5 m pine: trunk, whorled branches (kind branch/dead) and order-2 laterals."""
    axes = []

    def register(axis):
        axis["id"] = len(axes)
        axes.append(axis)
        return axis

    def phases():
        return (rng.uniform(0, 6.28), rng.uniform(0, 6.28))
    yaw = rng.uniform(0, 2 * math.pi)
    lean = norm((profile["lean"] * math.cos(yaw), profile["lean"] * math.sin(yaw), 1.0))
    top = profile["trunk"]
    trunk = register({"order": 0, "parent": None, "attach": None, "kind": "trunk",
                      "points": grow_axis((0.0, 0.0, 0.0), UP, lean, top, 3.0, .018, 2.6, 0.0, phases())})
    pts = trunk["points"]
    base = profile["crown"] * top
    z = profile["stubs"] * top + rng.uniform(0, .25)
    spin = rng.uniform(0, 2 * math.pi)
    while z < top - .3:
        index = min(len(pts) - 3, int(round(z / V5_STEP)))
        living = z >= base + rng.uniform(-.35, .25)
        # Age: 0 at the leader, 1 at the crown base. Old whorls reach furthest and droop most.
        age = min(1.0, max(0.0, (top - z) / (top - base)))
        count = rng.randint(*profile["whorl"]) if living else rng.randint(2, 4)
        spin += rng.uniform(.5, 1.6)
        for k in range(count):
            azimuth = spin + 2 * math.pi * k / count + rng.uniform(-.3, .3)
            if not living:
                # Dead lower branches: short bare stubs, roughly level or hanging.
                length = rng.uniform(.14, .5)
                d0 = direction(azimuth, math.radians(rng.uniform(-28.0, 4.0)))
                register({"order": 1, "parent": 0, "attach": index, "kind": "dead", "departure": d0,
                          "points": grow_axis(pts[index], d0, d0, length, 1.0, .01, 1.0, .03, phases())})
                continue
            if count > 4 and rng.random() < .1:
                continue
            length = (.16 + profile["reach"] * age ** .8 * (1 - .2 * age ** 4)) * rng.uniform(.72, 1.15)
            rise = math.radians(45 - 70 * age + rng.uniform(-7, 7))
            tip = math.radians(8 + 20 * (1 - age) + rng.uniform(-5, 5))
            d0, dT = direction(azimuth, rise), direction(azimuth + rng.uniform(-.15, .15), tip)
            register({"order": 1, "parent": 0, "attach": index, "kind": "branch", "departure": d0, "age": age,
                      "points": grow_axis(pts[index], d0, dT, length, .8 * length, .03, max(length, .5) * 1.3, .1 + .25 * age, phases())})
        z += rng.uniform(*profile["internode"])
    for b in [a for a in axes if a["kind"] == "branch"]:
        p = b["points"]
        total = (len(p) - 1) * V5_STEP
        s = total * rng.uniform(.14, .24)
        side = 1 if rng.random() < .5 else -1
        while s < total * .9:
            i = min(len(p) - 2, max(1, int(round(s / V5_STEP))))
            t = polyline_tangent(p, i)
            flat = cross(UP, t)
            flat = mul(norm(flat) if dot(flat, flat) > 1e-6 else perpendicular(t), side)
            dep = math.radians(rng.uniform(46, 64))
            d0 = norm(add(add(mul(t, math.cos(dep)), mul(flat, math.sin(dep))), (0.0, 0.0, rng.uniform(-.25, .35))))
            dT = norm(add(add(mul(t, .75), mul(flat, .55)), (0.0, 0.0, .12)))
            length = min(.8, max(.1, .1 + .4 * (total - s))) * rng.uniform(.8, 1.15)
            register({"order": 2, "parent": b["id"], "attach": i, "kind": "lateral", "departure": d0,
                      "points": grow_axis(p[i], d0, dT, length, .5 * length, .02, max(length, .3), .08 + .2 * b["age"], phases())})
            side = -side
            s += rng.uniform(*profile["lateral"])
    return axes


def conifer_skeleton(params, rng):
    """Grown, radius-fielded and pruned pine axes in 7.5 m units: (axes, foliage anchor chains, scale)."""
    spec, profile = SPECIES[params["species"]], CONIFER[params["species"]]
    height = params["height"]
    scale = height / V5_HEIGHT
    base_radius = (params["trunkRadius"] or height * spec["radius"]) / scale
    axes = grow_conifer(profile, rng)
    trunk = axes[0]
    n = len(trunk["points"])
    # Continuous monopodial taper (trunkTaper bends it from a cone towards a paraboloid) plus a butt swell.
    power = 1.1 - .6 * params["trunkTaper"]
    trunk["radii"] = [max(V5_TIP_RADIUS, base_radius * (1 - i / (n - 1)) ** power * (1 + .14 * max(0.0, 1 - p[2] / .9) ** 2))
                      for i, p in enumerate(trunk["points"])]
    for a in axes[1:]:
        rp = axes[a["parent"]]["radii"][a["attach"]]
        m = len(a["points"])
        length = (m - 1) * V5_STEP
        if a["kind"] == "dead":
            r0, fall = min(.3 * rp, .008 + .03 * length), .4
        elif a["kind"] == "branch":
            r0, fall = min(.42 * rp, .007 + .02 * length), .82
        else:
            r0, fall = min(.6 * rp, .003 + .009 * length), .82
        a["radii"] = [r0 * (1 - fall * i / (m - 1)) for i in range(m)]
    anchors = prune_wood(axes, params["branchLevels"], PRUNE_DIAMETER / 2 / scale)
    for a in axes:
        if a["kind"] == "dead" and a["kept"]:
            # Broken stubs stay blunt rather than easing to a point.
            r0 = a["radii"][0]
            a["radii"] = [r0 * (1 - .4 * i / (len(a["radii"]) - 1)) for i in range(len(a["radii"]))]
    wood_joints(axes)
    return axes, anchors, scale


def radical_inverse(k):
    """Base-2 van der Corput value of k: a low-discrepancy order, so every prefix spreads evenly."""
    value, f = 0.0, .5
    while k:
        if k & 1:
            value += f
        k >>= 1
        f *= .5
    return value


def needle_canopy(leaves, style, axes, anchors, scale, capacity, wanted, rng):
    """Needle-spray cards rooted on the young outer shoots of every living whorl branch, its
    laterals and the leader. Positions follow a van der Corput order over the total foliated shoot
    length, so density keeps an evenly spread prefix; inner, low sprays use the shade row."""

    def alive(a):
        while a is not None:
            if a["kind"] == "dead" or (a.get("dropped") and a["order"] <= 1):
                return False
            a = axes[a["parent"]] if a["parent"] is not None else None
        return True
    chains = []
    for a in axes:
        if not alive(a):
            continue
        p = a["points"]
        if a["kind"] == "branch":
            chains.append(p[int(len(p) * style["outer"]):])
        elif a["kind"] == "lateral":
            chains.append(p[int(len(p) * .15):])
    top = axes[0]["points"]
    chains.append(top[max(0, len(top) - 1 - int(style["leader"] / V5_STEP)):])
    chains = [[mul(q, scale) for q in c] for c in chains if len(c) >= 2]
    starts, total = [], 0.0
    for c in chains:
        starts.append(total)
        total += sum(math.dist(a, b) for a, b in zip(c, c[1:]))
    zs = [q[2] for c in chains for q in c]
    low, high = min(zs), max(zs)
    reach = max(math.hypot(q[0], q[1]) for c in chains for q in c) or 1.0
    length = min(max(style["cover"] * total / max(1, capacity), style["size"][0] * scale), style["size"][1] * scale)
    if leaves.normals is None:
        leaves.normals = []
    for k in range(wanted):
        s = (radical_inverse(k + 1) + rng.uniform(-.3, .3) / max(1, capacity)) % 1.0 * total
        c = max(i for i in range(len(chains)) if starts[i] <= s)
        chain, s = chains[c], s - starts[c]
        i = 0
        while i < len(chain) - 2 and s > math.dist(chain[i], chain[i + 1]):
            s -= math.dist(chain[i], chain[i + 1])
            i += 1
        f = min(1.0, s / max(math.dist(chain[i], chain[i + 1]), 1e-9))
        root = add(chain[i], mul(sub(chain[i + 1], chain[i]), f))
        t = norm(sub(chain[i + 1], chain[i]))
        side = cross(UP, t)
        side = norm(side) if dot(side, side) > 1e-6 else perpendicular(t)
        side = mul(side, 1 if k % 2 else -1)
        # Age: 0 at the leader, 1 at the crown base. Old, low sprays sag further below their branch.
        age = 1 - (root[2] - low) / max(high - low, 1e-6)
        fan = rng.uniform(.1, .85)
        sag = style["droop"] + style["sag"] * age * rng.uniform(.6, 1.3)
        axis = norm(add(add(mul(t, math.cos(fan)), mul(side, math.sin(fan))), (0.0, 0.0, rng.uniform(-.15, .2) - sag)))
        # Layered roll about the spray: flat pads facing the sky, then sprays turned half and
        # nearly fully towards the side, so overlapping cards give the crown depth from any view.
        lift = sub(UP, mul(axis, dot(UP, axis)))
        lift = norm(lift) if dot(lift, lift) > 1e-6 else perpendicular(axis)
        roll = (rng.uniform(0, .35), rng.uniform(.55, .9), rng.uniform(1.0, 1.35))[(k // 2) % 3] * (1 if rng.random() < .5 else -1)
        face = norm(add(mul(lift, math.cos(roll)), mul(cross(axis, lift), math.sin(roll))))
        size = length * rng.uniform(.85, 1.15)
        width = size * style["aspect"] * rng.uniform(.92, 1.08)
        radial = math.hypot(root[0], root[1]) / reach
        tone = .9 * radial + .5 * (root[2] - low) / max(high - low, 1e-6) + rng.uniform(-.25, .25)
        rect = atlas_rect(rng.randrange(ATLAS_COLS), 1 if tone < style["shade"] else 0)
        first = len(leaves.vertices)
        leaves.card(root, axis, face, size, width, max(.0008, width * .01), rect, bend=style["bend"] * rng.uniform(.4, 1.6),
                    droop=style["tipdrop"] * (.5 + age) * rng.uniform(.6, 1.4), cup=style["cup"])
        out = norm((root[0], root[1], 0.0)) if radial > 1e-3 else UP
        mottle = mul(face, rng.uniform(-.1, .35))
        for v in leaves.vertices[first:]:
            ring = (v[0], v[1], 0.0)
            ring = norm(ring) if dot(ring, ring) > 1e-9 else out
            leaves.normals.append(norm(add(add(add(mul(ring, .55), mul(out, .35)), mul(UP, .55)), mottle)))


# -------------------------------------------------------------- rock ---------
def value_noise(seed):
    rng = random.Random(seed)
    lattice = [rng.uniform(-1, 1) for _ in range(512)]

    def hashed(ix, iy, iz):
        return lattice[(ix * 73856093 ^ iy * 19349663 ^ iz * 83492791) & 511]

    def smooth(t):
        return t * t * (3 - 2 * t)

    def sample(p):
        x, y, z = p
        ix, iy, iz = math.floor(x), math.floor(y), math.floor(z)
        fx, fy, fz = smooth(x - ix), smooth(y - iy), smooth(z - iz)
        total = 0.0
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    w = (fx if dx else 1 - fx) * (fy if dy else 1 - fy) * (fz if dz else 1 - fz)
                    total += w * hashed(ix + dx, iy + dy, iz + dz)
        return total
    return sample


def icosphere(subdivisions):
    t = (1 + math.sqrt(5)) / 2
    verts = [norm(v) for v in [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t),
                                (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]]
    faces = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8),
             (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
    for _ in range(subdivisions - 1):
        cache = {}

        def midpoint(a, b):
            key = (min(a, b), max(a, b))
            if key not in cache:
                verts.append(norm(mul(add(verts[a], verts[b]), 0.5)))
                cache[key] = len(verts) - 1
            return cache[key]
        refined = []
        for a, b, c in faces:
            ab, bc, ca = midpoint(a, b), midpoint(b, c), midpoint(c, a)
            refined += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        faces = refined
    return verts, faces


def plan_rock(params, seed, budget_total):
    rng = random.Random(seed)
    sx, sy, sz = params["size"]
    roughness = params["roughness"]
    subdivisions = 5 if budget_total >= icosphere_triangles(5) else 4 if budget_total >= icosphere_triangles(4) else 3
    verts, faces = icosphere(subdivisions)
    noise = value_noise(seed)
    offset = (rng.uniform(0, 50), rng.uniform(0, 50), rng.uniform(0, 50))
    planes = [(norm((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.4, 1))), rng.uniform(0.62, 0.86)) for _ in range(3 + int(roughness * 7))]
    shaped = []
    for v in verts:
        p = v
        amplitude = 0.08 + 0.22 * roughness
        n = 0.0
        frequency, weight = 1.6, 1.0
        for _ in range(4):
            n += weight * noise(add(mul(p, frequency), offset))
            frequency *= 2.1
            weight *= 0.48
        p = mul(p, 1 + amplitude * n)
        # Soft facet planes: chiselled faces without collapsing vertices.
        for normal, distance in planes:
            excess = dot(p, normal) - distance
            if excess > 0:
                p = sub(p, mul(normal, excess * 0.82))
        shaped.append(p)
    low = min(p[2] for p in shaped)
    cut = low + (max(p[2] for p in shaped) - low) * 0.18
    flattened = [(p[0], p[1], cut + (p[2] - cut) * 0.06) if p[2] < cut else p for p in shaped]
    xs = [p[0] for p in flattened]
    ys = [p[1] for p in flattened]
    zs = [p[2] for p in flattened]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    scale = (sx / (max(xs) - min(xs)), sy / (max(ys) - min(ys)), sz / (max(zs) - min(zs)))
    rock = MeshData()
    for p in flattened:
        rock.vertex(((p[0] - cx) * scale[0], (p[1] - cy) * scale[1], (p[2] - min(zs)) * scale[2]))
    for f in faces:
        points = [rock.vertices[i] for i in f]
        normal = cross(sub(points[1], points[0]), sub(points[2], points[0]))
        axis = max(range(3), key=lambda k: abs(normal[k]))
        a, b = [k for k in range(3) if k != axis]
        bounds = [(-sx / 2, sx), (-sy / 2, sy), (0, sz)]
        uv = []
        for p in points:
            u, v = (p[a] - bounds[a][0]) / bounds[a][1], (p[b] - bounds[b][0]) / bounds[b][1]
            coordinate = (p[0] / sx + .5, p[1] / sy + .5, p[2] / sz)
            # Smooth bounded domain warping breaks the tile's regular alignment on a natural rock.
            # The fade preserves unit-square boundaries and keeps every UV inside the audited range.
            u += .09 * 4 * u * (1 - u) * noise(add(mul(coordinate, 4.7), (17, 3, 29)))
            v += .09 * 4 * v * (1 - v) * noise(add(mul(coordinate, 4.7), (37, 23, 7)))
            uv.append((u, v))
        rock.face(f, uvs=uv)
    return rock


# ------------------------------------------------------ natural rock ---------
# Natural rock forms (procedural.form): a weathered boulder, a steep cliff-face outcrop (front -Y,
# sloped back for setting into a hillside) and the same outcrop with a recessed cave mouth.
# Requests without a form keep plan_rock above byte for byte.
ROCK_FORMS = ("boulder", "outcrop", "cave")
ROCK_TRIANGLES = 6000
# Unique UV layout: every lattice face of every closed shell is its own chart, packed into the
# 512 px texture with a gutter, so textures.py can bake world-space stone, moss and shading.
ROCK_ATLAS = 512
ROCK_GUTTER = 3
# Hidden faces resting on the ground get less texture.
ROCK_GROUND_CHART = .35
# Scree stones at the foot of an outcrop: a small closed lattice each (48 triangles).
SCREE_TRIANGLES = 48


def rock_extent(params):
    """Metres of the rock's largest dimension (bounds the texture's world-space scales)."""
    return max(params["size"])


def rock_lattice(dims, charts=None):
    """Closed box lattice on [-1, 1]^3 with nx x ny x nz cells: (points, quads wound outward).
    ``charts`` (a list) receives one {axis, side, grid, quads} per box face: grid[i][j] is the vertex
    at cell corner (i, j) and quads[k] = (quad index, [(i, j) of each ring corner])."""
    index, points, quads = {}, [], []

    def vid(c):
        key = tuple(c)
        if key not in index:
            index[key] = len(points)
            points.append(tuple(2 * c[k] / dims[k] - 1 for k in range(3)))
        return index[key]
    for axis in range(3):
        a, b = [k for k in range(3) if k != axis]
        for side in (0, dims[axis]):
            flip = (side == 0) != (axis == 1)
            grid = [[0] * (dims[b] + 1) for _ in range(dims[a] + 1)]
            cells = []
            for i in range(dims[a]):
                for j in range(dims[b]):
                    ring, corners = [], []
                    for di, dj in ((0, 0), (1, 0), (1, 1), (0, 1)):
                        c = [0, 0, 0]
                        c[axis], c[a], c[b] = side, i + di, j + dj
                        ring.append(vid(c))
                        grid[i + di][j + dj] = ring[-1]
                        corners.append((i + di, j + dj))
                    cells.append((len(quads), corners[::-1] if flip else corners))
                    quads.append(tuple(reversed(ring)) if flip else tuple(ring))
            if charts is not None:
                charts.append({"axis": axis, "side": side, "grid": grid, "quads": cells})
    return points, quads


def rock_pattern(params):
    """Texture pattern of a natural rock form: the cave mouth wears the outcrop texture."""
    return "rock-boulder" if params["form"] == "boulder" else "rock-outcrop"


def rock_dims(size, cap):
    """Lattice cells per axis (at least 3) for near-square cells within ``cap`` triangles."""
    step, best = max(size) / 3, None
    while step > 1e-3:
        dims = [max(3, int(math.ceil(s / step))) for s in size]
        if 4 * (dims[0] * dims[1] + dims[1] * dims[2] + dims[0] * dims[2]) > cap:
            break
        best, step = dims, step * .97
    if best is None:
        raise ValueError("Rock exceeded its triangle budget")
    return best


def smin(a, b, k):
    """Smooth minimum: a bevelled fillet of width ~k where two faces meet."""
    h = max(0.0, min(1.0, .5 + .5 * (b - a) / k))
    return b + (a - b) * h - k * h * (1 - h)


def vsum(vectors, indices):
    x = y = z = 0.0
    for i in indices:
        v = vectors[i]
        x, y, z = x + v[0], y + v[1], z + v[2]
    return (x, y, z)


def rock_lobes(rng, w, d, h):
    """Outcrop rock mass: overlapping, tilted and yawed strata slabs (wide low beds, narrower set-back
    upper blocks, one crowning block) merged with rounded masses, in metres (front -Y, base z = 0)."""
    lobes = []

    def slab(cx, front, back, bottom, top, half_width, turn):
        lobes.append(("box", (cx, (front + back) / 2, (bottom + top) / 2), (half_width, (back - front) / 2, (top - bottom) / 2), turn))

    def tilt(amount):
        return (rng.uniform(-.35, .35), rng.uniform(-amount, amount), rng.uniform(-amount, amount))
    low = 2 + rng.randrange(2)
    for k in range(low):
        cx = (-.5 + (k + .5) / low) * w + rng.uniform(-.06, .06) * w
        slab(cx, -d / 2 + rng.uniform(-.02, .2) * d, d / 2 - rng.uniform(0, .12) * d, -.3 * h, h * rng.uniform(.35, .62),
             w / low * rng.uniform(.6, .74), tilt(.12))
    mid = 2 + rng.randrange(3)
    for k in range(mid):
        cx = (-.5 + (k + rng.uniform(.25, .75)) / mid) * w * .8
        slab(cx, -d / 2 + rng.uniform(-.06, .24) * d, d * rng.uniform(.0, .3), .2 * h, h * rng.uniform(.66, .92),
             w * rng.uniform(.14, .25), tilt(.22))
    slab(rng.uniform(-.2, .2) * w, -d / 2 + rng.uniform(-.04, .16) * d, d * rng.uniform(.05, .25), .45 * h, h,
         w * rng.uniform(.18, .28), tilt(.3))
    for _ in range(2 + rng.randrange(2)):
        lobes.append(("ellipsoid", (rng.uniform(-.42, .42) * w, rng.uniform(-.15, .15) * d, h * rng.uniform(.05, .4)),
                      (w * rng.uniform(.12, .22), d * rng.uniform(.3, .45), h * rng.uniform(.25, .42)), tilt(.4)))
    return lobes


def lobe_exit(lobe, origin, ray, rounding, soft):
    """Distance at which ``ray`` (unit) from ``origin`` leaves one lobe: rounded box edges via a smooth
    minimum of the slab exits; fades to 0 as the chord through the lobe vanishes (a grazing miss)."""
    kind, centre, half, (yaw, pitch, roll) = lobe

    def local(v):
        # Into the lobe frame: undo yaw (about z), then pitch (about x), then roll (about y).
        x, y, z = v
        x, y = math.cos(yaw) * x + math.sin(yaw) * y, -math.sin(yaw) * x + math.cos(yaw) * y
        y, z = math.cos(pitch) * y + math.sin(pitch) * z, -math.sin(pitch) * y + math.cos(pitch) * z
        x, z = math.cos(roll) * x - math.sin(roll) * z, math.sin(roll) * x + math.cos(roll) * z
        return (x, y, z)
    o, r = local(sub(origin, centre)), local(ray)
    if kind == "box":
        near, far = -1e18, None
        k_round = min(rounding, .45 * min(half))
        for k in range(3):
            if abs(r[k]) < 1e-12:
                if abs(o[k]) > half[k]:
                    return 0.0
                continue
            t1, t2 = (-half[k] - o[k]) / r[k], (half[k] - o[k]) / r[k]
            near = max(near, min(t1, t2))
            far = max(t1, t2) if far is None else smin(far, max(t1, t2), k_round)
    else:
        oo = tuple(o[k] / half[k] for k in range(3))
        rr = tuple(r[k] / half[k] for k in range(3))
        a, b, c = dot(rr, rr), dot(oo, rr), dot(oo, oo) - 1
        disc = b * b - a * c
        if disc <= 0:
            return 0.0
        s = math.sqrt(disc)
        near, far = (-b - s) / a, (-b + s) / a
    if far is None or far <= 0:
        return 0.0
    return far * smoothstep((far - near) / soft)


def rock_stone(rng, noise, centre, radius, flat):
    """One scree stone: a 2x2x2 lattice shell, rounded, chipped and partly sunk into the ground."""
    charts = []
    lattice, quads = rock_lattice((2, 2, 2), charts)
    power = rng.uniform(2.6, 4.0)
    stretch = (rng.uniform(.8, 1.3), rng.uniform(.8, 1.3), rng.uniform(.45, .7))
    yaw = rng.uniform(0, 2 * math.pi)
    cuts = [(norm((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-.2, 1))), rng.uniform(.45, .75)) for _ in range(2)]
    shift = tuple(rng.uniform(0, 40) for _ in range(3))
    points = []
    for q in lattice:
        length = sum(abs(c) ** power for c in q) ** (1 / power)
        p = mul(q, (1 + .18 * noise(add(mul(q, 1.7), shift))) / length)
        for n, dist in cuts:
            e = dot(p, n) - dist
            if e > 0:
                p = sub(p, mul(n, e * .92))
        x, y, z = p[0] * stretch[0] * radius, p[1] * stretch[1] * radius, p[2] * stretch[2] * radius
        x, y = x * math.cos(yaw) - y * math.sin(yaw), x * math.sin(yaw) + y * math.cos(yaw)
        z = centre[2] + z
        points.append((centre[0] + x, centre[1] + y, z if z > flat else flat + (z - flat) * .04))
    return points, quads, charts


def pack_charts(sizes, atlas=ROCK_ATLAS, gutter=ROCK_GUTTER):
    """Skyline-pack (width m, height m) charts into an atlas px square, each with a gutter px border,
    turning charts a quarter where that packs lower: (px per metre, [(x, y, turned) per chart])."""
    def skyline(scale, order):
        sky = [[0.0, 0.0, float(atlas)]]
        spots = [None] * len(sizes)
        for k in order:
            best = None
            for turned in (False, True):
                w, h = sizes[k][::-1] if turned else sizes[k]
                w, h = w * scale + 2 * gutter, h * scale + 2 * gutter
                for i, (x, _, _) in enumerate(sky):
                    if x + w > atlas + 1e-9:
                        break
                    y, j, reach = 0.0, i, x + w
                    while j < len(sky) and sky[j][0] < reach - 1e-9:
                        y = max(y, sky[j][1])
                        j += 1
                    if y + h <= atlas + 1e-9 and (best is None or (y + h, x) < (best[0], best[1])):
                        best = (y + h, x, y, w, turned)
            if best is None:
                return None
            top, x, y, w, turned = best
            spots[k] = (x, y, turned)
            right, merged = x + w, []
            for sx, sy, sw in sky:
                if sx + sw <= x + 1e-9 or sx >= right - 1e-9:
                    merged.append([sx, sy, sw])
                    continue
                if sx < x:
                    merged.append([sx, sy, x - sx])
                if sx + sw > right:
                    merged.append([right, sy, sx + sw - right])
            merged.append([x, top, w])
            merged.sort()
            sky = []
            for seg in merged:
                if sky and abs(sky[-1][1] - seg[1]) < 1e-9:
                    sky[-1][2] += seg[2]
                else:
                    sky.append(seg)
        return spots
    orders = [sorted(range(len(sizes)), key=key) for key in (
        lambda k: (-max(sizes[k]), -min(sizes[k]), k),
        lambda k: (-sizes[k][0] * sizes[k][1], k),
        lambda k: (-sizes[k][1], -sizes[k][0], k))]
    best = (0.0, None)
    for order in orders:
        low, high = best[0], max(best[0] * 1.5, 1.0)
        while skyline(high, order) is not None:
            low, high = high, high * 2
        if low <= best[0] and skyline(low, order) is None:
            continue
        for _ in range(30):
            middle = (low + high) / 2
            low, high = (middle, high) if skyline(middle, order) is not None else (low, middle)
        if low > best[0]:
            best = (low, skyline(low, order))
    if best[1] is None:
        raise ValueError("Rock charts do not fit the texture")
    return best


def plan_natural_rock(params, seed, budget_total):
    """Natural boulder / outcrop / cave mouth on a flat base, scaled to the exact requested size.
    The boulder is a closed lattice shell shaped by a superellipsoid, lumps, bevelled fracture planes
    and fine fracture noise. The outcrop is a merged mass of yawed strata slabs and rounded shoulders
    (an irregular footprint, varied heights, an overhanging brow), cast as a closed radial shell,
    with scree stones at its foot; the cave carves a tunnel mouth back into its front face. Each
    lattice face is one chart of a unique UV layout; ``bake`` carries smoothed normals, cavity and
    tunnel depth per vertex so textures.py can bake moss, stone and shading in world space."""
    rng = random.Random(seed)
    noise = value_noise(seed + 3301)
    form, rough = params["form"], params["roughness"]
    sx, sy, sz = params["size"]
    cap = min(budget_total, ROCK_TRIANGLES)
    cliff = form != "boulder"
    stones = min(14, int(cap * .12) // SCREE_TRIANGLES) if cliff else 0
    dims = rock_dims((sx, sy, sz), cap - stones * SCREE_TRIANGLES)
    charts = []
    lattice, quads = rock_lattice(dims, charts)
    half = (sx / 2, sy / 2, sz / 2)
    radius = min(sx, sy) / 2
    if not cliff:
        power = rng.uniform(2.3, 3.0)
        offset = tuple(rng.uniform(0, 60) for _ in range(3))

        def fbm(p, frequency, octaves, gain=.5):
            total, weight, w = 0.0, 0.0, 1.0
            for _ in range(octaves):
                total += w * noise(add(mul(p, frequency), offset))
                weight += w
                frequency *= 2.03
                w *= gain
            return total / weight
        planes = []
        for _ in range(5 + int(rough * 5) + rng.randrange(2)):
            planes.append((norm((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-.35, 1))), rng.uniform(.5, .76), rng.uniform(.025, .06)))
        dip = (rng.uniform(-.12, .12), rng.uniform(-.12, .12))
        layer = rng.uniform(.14, .26)
        strata = rng.uniform(0, .35) * (.6 + .4 * rough)
        layer_offsets = [rng.uniform(-1, 1) for _ in range(64)]
        shaped = []
        for q in lattice:
            length = sum(abs(c) ** power for c in q) ** (1 / power)
            p = mul(q, 1 / length)
            p = mul(p, 1 + (.07 + .1 * rough) * fbm(p, 1.1, 3))
            for n, dist, k in planes:
                e = dot(p, n) - dist
                if e > -2 * k:
                    p = sub(p, mul(n, e - smin(e, 0.0, k)))
            shaped.append(p)
        points = []
        for p in shaped:
            x = (p[0] * half[0], p[1] * half[1], p[2] * half[2])
            # Faint bedding: each bed of the boulder stands a little in or out, partings grooved.
            horizontal = (x[0], x[1], 0.0)
            flat = math.sqrt(dot(horizontal, horizontal))
            if flat > 1e-9:
                s = (x[2] + dip[0] * x[0] + dip[1] * x[1]) / layer + .35 * noise(mul(x, 1.7 / layer))
                bed = math.floor(s)
                parting = 1 - smoothstep(min(s - bed, bed + 1 - s) / .14)
                facing = flat / math.sqrt(dot(x, x))
                step = radius * strata * (.035 * layer_offsets[bed % 64] - .03 * parting) * facing ** 2
                x = add(x, mul(horizontal, step / flat))
            grain = radius * (.012 + .02 * rough) * fbm(mul(x, 1 / max(radius, .05)), 4.0, 3)
            size = math.sqrt(dot(x, x))
            if size > 1e-9:
                x = add(x, mul(x, grain / size))
            points.append(x)
        low = min(p[2] for p in points)
        cut = low + (max(p[2] for p in points) - low) * .16
        points = [(p[0], p[1], cut + (p[2] - cut) * .05) if p[2] < cut else p for p in points]
    else:
        # Shaped at a bounded aspect (no side under .35 of the longest), then scaled linearly to the
        # exact size below, so very thin or flat requests squash cleanly instead of folding.
        shape = tuple(max(s, .35 * max(sx, sy, sz)) for s in (sx, sy, sz))
        points = rock_mass(rng, noise, lattice, quads, shape, rough)
    tunnel = [0.0] * len(points)
    mouth = None
    if form == "cave":
        mouth = carve_cave(rng, noise, lattice, charts, points, tunnel, shape)
        untangle(points, quads, lattice_links(len(points), quads))
    shells = [(points, quads, charts, tunnel)]
    if stones:
        shells += scree(rng, noise, points, shape, stones, mouth)
    # One vertex list; exact requested size with the lowest point on z = 0.
    vertices, offsets = [], []
    for shell in shells:
        offsets.append(len(vertices))
        vertices += shell[0]
    xs, ys, zs = ([p[k] for p in vertices] for k in range(3))
    mid = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)
    scale = (sx / (max(xs) - min(xs)), sy / (max(ys) - min(ys)), sz / (max(zs) - min(zs)))
    floor = min(zs)
    vertices = [((p[0] - mid[0]) * scale[0], (p[1] - mid[1]) * scale[1], (p[2] - floor) * scale[2]) for p in vertices]
    rock = MeshData()
    for p in vertices:
        rock.vertex(p)
    # Charts: per box face, column/row spacing from the mean shaped edge lengths (less stretch).
    faces_uv = []
    for s, (_, _, faces, _) in enumerate(shells):
        for chart in faces:
            grid, base = chart["grid"], offsets[s]
            na, nb = len(grid) - 1, len(grid[0]) - 1
            us, vs = [0.0], [0.0]
            for i in range(na):
                us.append(us[-1] + sum(math.dist(vertices[base + grid[i][j]], vertices[base + grid[i + 1][j]]) for j in range(nb + 1)) / (nb + 1))
            for j in range(nb):
                vs.append(vs[-1] + sum(math.dist(vertices[base + grid[i][j]], vertices[base + grid[i][j + 1]]) for i in range(na + 1)) / (na + 1))
            weight = ROCK_GROUND_CHART if chart["axis"] == 2 and chart["side"] == 0 else 1.0
            faces_uv.append((s, chart, [u * weight for u in us], [v * weight for v in vs]))
    # Large faces are cut into pieces at cell boundaries so the charts pack the square tightly.
    limit = .3 * math.sqrt(sum(us[-1] * vs[-1] for _, _, us, vs in faces_uv))

    def cuts(along):
        pieces = min(len(along) - 1, max(1, int(math.ceil(along[-1] / max(limit, 1e-9) - 1e-9))))
        marks = [0] + [min(range(1, len(along) - 1), key=lambda i: abs(along[i] - along[-1] * k / pieces)) for k in range(1, pieces)] + [len(along) - 1]
        return sorted(set(marks))
    sizes, layout = [], []
    for s, chart, us, vs in faces_uv:
        ucut, vcut = cuts(us), cuts(vs)
        for ia, ib in zip(ucut, ucut[1:]):
            for ja, jb in zip(vcut, vcut[1:]):
                sizes.append((max(us[ib] - us[ia], 1e-6), max(vs[jb] - vs[ja], 1e-6)))
                layout.append((s, chart, us, vs, ia, ib, ja, jb))
    px, spots = pack_charts(sizes)
    rects, chart_of = [], []
    for (s, chart, us, vs, ia, ib, ja, jb), (x0, y0, turned), (w, h) in zip(layout, spots, sizes):
        ox, oy = x0 + ROCK_GUTTER, y0 + ROCK_GUTTER
        if turned:
            w, h = h, w
        rects.append((ox / ROCK_ATLAS, oy / ROCK_ATLAS, (ox + w * px) / ROCK_ATLAS, (oy + h * px) / ROCK_ATLAS))
        base = offsets[s]
        quad_list = shells[s][1]
        # Charts keep the surface's winding (no mirrored texels): the quads' ring order in (i, j).
        ring = chart["quads"][0][1]
        winding = sum(ring[k][0] * ring[k - 1][1] - ring[k - 1][0] * ring[k][1] for k in range(4))
        mirror = (winding > 0) != turned
        for q, corners in chart["quads"]:
            if not (ia <= min(i for i, _ in corners) < ib and ja <= min(j for _, j in corners) < jb):
                continue
            a, b, c, d = (base + i for i in quad_list[q])
            uv = {}
            for n, (i, j) in enumerate(corners):
                cu, cv = us[i] - us[ia], vs[j] - vs[ja]
                if turned:
                    cu, cv = cv, cu
                if mirror:
                    cu = w - cu
                uv[base + quad_list[q][n]] = ((ox + cu * px) / ROCK_ATLAS, (oy + cv * px) / ROCK_ATLAS)
            # Shorter diagonal after shaping keeps fracture edges crisp.
            tris = ((a, b, c), (a, c, d)) if math.dist(vertices[a], vertices[c]) <= math.dist(vertices[b], vertices[d]) else ((a, b, d), (b, c, d))
            for tri in tris:
                rock.face(tri, uvs=[uv[i] for i in tri])
                chart_of.append(len(rects) - 1)
    if rock.triangles() > cap:
        raise ValueError("Rock exceeded its triangle budget")
    tunnels = []
    for shell in shells:
        tunnels += shell[3]
    rock.bake = rock_shading(rock, tunnels, (sx, sy, sz))
    rock.bake.update(charts=rects, chartOf=chart_of)
    return rock


def lattice_links(count, quads):
    """Sorted neighbour lists of a quad lattice."""
    links = [set() for _ in range(count)]
    for quad in quads:
        for k in range(4):
            links[quad[k]].update((quad[k - 1], quad[(k + 1) % 4]))
    return [sorted(n) for n in links]


def lattice_normals(points, quads):
    normals = [(0.0, 0.0, 0.0)] * len(points)
    for a, b, c, d in quads:
        n = cross(sub(points[c], points[a]), sub(points[d], points[b]))
        for i in (a, b, c, d):
            normals[i] = add(normals[i], n)
    return [norm(n) if dot(n, n) > 1e-24 else UP for n in normals]


def relax(points, links, normals, rounds, rate, floor=None):
    """Tangential relaxation: slide vertices toward their neighbours' centroid within the surface,
    evening out cells stretched by the cast; vertices on the ground stay on it."""
    for _ in range(rounds):
        moved = []
        for i, p in enumerate(points):
            step = sub(mul(vsum(points, links[i]), 1 / len(links[i])), p)
            step = sub(step, mul(normals[i], dot(step, normals[i])))
            q = add(p, mul(step, rate))
            if floor is not None and p[2] <= floor:
                q = (q[0], q[1], p[2])
            moved.append(q)
        points[:] = moved


def untangle(points, quads, links, rounds=8):
    """Smooth away folded cells (a cell facing against its vertices' normals) where shaping overlapped."""
    for _ in range(rounds):
        normals = lattice_normals(points, quads)
        bad = set()
        for quad in quads:
            a, b, c, d = quad
            n = cross(sub(points[c], points[a]), sub(points[d], points[b]))
            for tri in ((a, b, c), (a, c, d), (a, b, d), (b, c, d)):
                t = cross(sub(points[tri[1]], points[tri[0]]), sub(points[tri[2]], points[tri[0]]))
                if dot(t, n) <= 0 or any(dot(t, normals[i]) <= 0 for i in tri):
                    bad.update(quad)
                    break
        if not bad:
            return
        for i in sorted(bad):
            ring = set(links[i])
            centre = mul(vsum(points, links[i]), 1 / len(links[i]))
            points[i] = add(mul(points[i], .3), mul(centre, .7)) if ring else points[i]


def rock_mass(rng, noise, lattice, quads, size, rough):
    """Outcrop shell: each lattice point cast from an interior origin onto the merged lobes, clipped by
    the ground and relaxed along the surface, then pushed along its normal by large-scale noise, joint
    planes bevel it, and beds step in or out (metres)."""
    w, d, h = size
    lobes = rock_lobes(rng, w, d, h)
    offset = tuple(rng.uniform(0, 60) for _ in range(3))
    planes = []
    for _ in range(4 + int(rough * 4) + rng.randrange(2)):
        planes.append((norm((rng.uniform(-1, 1), rng.uniform(-1, .3), rng.uniform(-.2, .7))), rng.uniform(.68, .9), rng.uniform(.03, .07)))
    dip = (rng.uniform(-.1, .1), rng.uniform(-.06, .06))
    layer = min(.3 * h, max(.08 * h, rng.uniform(.45, .8)))
    layer_offsets = [rng.uniform(-1, 1) for _ in range(64)]
    least = min(w, d, h)
    origin = (0.0, -.04 * d, .3 * h)
    rounding, soft, union = .2 * least, .12 * least, .18 * least

    def fbm(p, frequency, octaves, gain=.5):
        total, weight, k = 0.0, 0.0, 1.0
        for _ in range(octaves):
            total += k * noise(add(mul(p, frequency), offset))
            weight += k
            frequency *= 2.03
            k *= gain
        return total / weight
    points = []
    for q in lattice:
        target = (q[0] * w / 2, q[1] * d / 2, (q[2] + 1) / 2 * h)
        ray = norm(sub(target, origin))
        reach = 0.0
        for lobe in lobes:
            reach = -smin(-reach, -lobe_exit(lobe, origin, ray, rounding, soft), union)
        if ray[2] < 0:
            reach = smin(reach, origin[2] / -ray[2], .02 * h)
        points.append(add(origin, mul(ray, reach)))
    links = lattice_links(len(points), quads)
    relax(points, links, lattice_normals(points, quads), 4, .5, floor=.005 * h)
    normals = lattice_normals(points, quads)
    shaped = []
    for p, n in zip(points, normals):
        unit = (p[0] / (w / 2), p[1] / (d / 2), (p[2] - h / 2) / (h / 2))
        # Large-scale breakup of the silhouette, then medium lumps, along the surface normal.
        bump = .16 * least * fbm(unit, .8, 3) + .05 * least * fbm(unit, 2.9, 2)
        p = add(p, mul(n, bump * smoothstep(p[2] / (.04 * h))))
        # Joint planes bevel the footprint's corners and the skyline into fresh faces.
        unit = (p[0] / (w / 2), p[1] / (d / 2), (p[2] - h / 2) / (h / 2))
        for jn, dist, k in planes:
            e = dot(unit, jn) - dist
            if e > -2 * k:
                unit = sub(unit, mul(jn, e - smin(e, 0.0, k)))
        p = (unit[0] * w / 2, unit[1] * d / 2, unit[2] * h / 2 + h / 2)
        # Bedding: each bed of the face stands in or out, with a soft step between beds.
        horizontal = (n[0], n[1], 0.0)
        flat = math.sqrt(dot(horizontal, horizontal))
        if flat > 1e-9 and p[2] > .03 * h:
            s = (p[2] + dip[0] * p[0] + dip[1] * p[1]) / layer + .3 * noise(mul(p, 1.3 / layer))
            bed = math.floor(s)
            t = smoothstep((s - bed) / .3)
            stand = layer_offsets[bed % 64] * (1 - t) + layer_offsets[(bed + 1) % 64] * t
            p = add(p, mul(horizontal, .06 * least * stand * flat))
        shaped.append(p)
    low = min(p[2] for p in shaped)
    cut = low + (max(p[2] for p in shaped) - low) * .03
    shaped = [(p[0], p[1], cut + (p[2] - cut) * .05) if p[2] < cut else p for p in shaped]
    untangle(shaped, quads, links)
    return shaped


def carve_cave(rng, noise, lattice, charts, points, tunnel, size):
    """Carve a tunnel mouth back into the front (-Y) face from the ground: an arch whose walls and
    ceiling recede up to 60% of the local thickness, under an overhanging brow. ``tunnel`` gets each
    vertex's recess (0 at the rim, 1 deepest). Returns (centre x, half width) of the mouth in metres."""
    w, d, h = size
    middle, width = rng.uniform(-.14, .14), rng.uniform(.17, .22)
    crown = rng.uniform(.42, .58)
    depth = rng.uniform(.5, .6)
    brow = rng.uniform(.06, .1) * min(w, d, h)
    high = max(p[2] for p in points)
    front = next(c for c in charts if c["axis"] == 1 and c["side"] == 0)["grid"]
    back = next(c for c in charts if c["axis"] == 1 and c["side"] != 0)["grid"]
    xs = [p[0] for p in points]
    span = (min(xs), max(xs))
    centre = span[0] + (span[1] - span[0]) * (.5 + middle)
    half_width = (span[1] - span[0]) * width
    moved = {}
    for i, column in enumerate(front):
        for j, v in enumerate(column):
            p = points[v]
            rx = (p[0] - centre + .12 * half_width * (noise(mul(p, 1.1)) - .5)) / half_width
            rz = p[2] / (crown * high)
            shape = 1 - rx * rx - rz ** 3
            mask = smoothstep(shape / .45) * smoothstep(p[2] / (.05 * high))
            thickness = points[back[i][j]][1] - p[1]
            recess = mask * depth * thickness * (1 + .12 * (noise(mul(p, 2.3)) - .5))
            # The brow: rock just above the arch leans forward over the mouth.
            lip = brow * smoothstep((shape + 1.1) / .55) * (1 - smoothstep((shape + .05) / .4)) * smoothstep((rz - .8) / .3) * (1 - smoothstep((abs(rx) - .6) / .6))
            moved[v] = (p[0], p[1] + recess - lip, p[2] - .35 * mask * mask * p[2] * smoothstep(1 - rz))
            tunnel[v] = mask * mask
    for v, p in moved.items():
        points[v] = p
    return centre, half_width


def scree(rng, noise, points, size, count, mouth):
    """Scree: fallen stones along the foot of the front and sides, kept clear of a cave mouth."""
    w, d, h = size
    base = [p for p in points if p[2] < .06 * h]
    stones = []
    for k in range(count * 6):
        if len(stones) == count:
            break
        angle = rng.uniform(math.radians(-170), math.radians(-10))
        r = min(w, d, h) * rng.uniform(.04, .1) * (1.7 if rng.random() < .3 else 1.0)
        direction2 = (math.cos(angle), math.sin(angle))
        foot = max(base, key=lambda p: p[0] * direction2[0] + p[1] * direction2[1] - .4 * abs(p[0] * direction2[1] - p[1] * direction2[0]))
        centre = (foot[0] + direction2[0] * r * rng.uniform(.2, 1.4), foot[1] + direction2[1] * r * rng.uniform(.2, 1.4), r * rng.uniform(.15, .45))
        if mouth is not None and abs(centre[0] - mouth[0]) < mouth[1] * .85:
            continue
        if any(math.dist(centre, other) < (r + other_r) * .9 for other, other_r in ((s[4], s[5]) for s in stones)):
            continue
        shell = rock_stone(rng, noise, centre, r, 0.0)
        stones.append((shell[0], shell[1], shell[2], [0.0] * len(shell[0]), centre, r))
    return [s[:4] for s in stones]


def rock_shading(mesh, tunnel, size):
    """Per-vertex bake inputs: area-weighted normals, a twice-smoothed normal for moss (so moss
    follows the form, not every chip), and signed cavity (+ crevice, - exposed edge) from how far
    each vertex sits below its Laplacian-smoothed neighbourhood."""
    count = len(mesh.vertices)
    normals = [(0.0, 0.0, 0.0)] * count
    neighbours = [set() for _ in range(count)]
    for face in mesh.faces:
        ps = [mesh.vertices[i] for i in face]
        n = cross(sub(ps[1], ps[0]), sub(ps[2], ps[0]))
        for k, i in enumerate(face):
            normals[i] = add(normals[i], n)
            neighbours[i].update((face[(k + 1) % 3], face[(k + 2) % 3]))
    normals = [norm(n) if dot(n, n) > 1e-24 else UP for n in normals]
    neighbours = [sorted(n) for n in neighbours]
    soft = normals
    for _ in range(2):
        soft = [norm(add(mul(soft[i], 2.0), mul(vsum(soft, neighbours[i]), 2.0 / max(1, len(neighbours[i]))))) for i in range(count)]
    smooth = mesh.vertices
    for _ in range(6):
        smooth = [add(mul(smooth[i], .4), mul(vsum(smooth, neighbours[i]), .6 / max(1, len(neighbours[i])))) for i in range(count)]
    scale = .02 * sum(size) / 3
    cavity = [max(-1.0, min(1.0, dot(sub(smooth[i], mesh.vertices[i]), normals[i]) / scale)) for i in range(count)]
    return {"normals": normals, "mossNormals": soft, "cavity": cavity, "tunnel": list(tunnel)}


def rock_bake(mesh):
    """World-space bake inputs for textures.tree_pixels (rock patterns): triangles with their UVs."""
    bake = dict(mesh.bake)
    bake.update(vertices=mesh.vertices, faces=mesh.faces, uvs=mesh.uvs)
    return bake


# ------------------------------------------------------------ column ---------
def plan_column(params, seed, budget_total):
    radius, height = params["radius"], params["height"]
    flutes, base_style, capital = params["flutes"], params["base"], params["capital"]
    stone = MeshData()
    segments = max(32, flutes * 4) if flutes else 32
    base_h = 0.0 if base_style == "none" else radius * (0.55 if base_style == "plinth" else 0.75)
    cap_h = {"none": 0.0, "doric": radius * 0.7, "ionic": radius * 0.8, "corinthian": radius * 1.9}[capital]
    shaft_bottom, shaft_top = base_h, height - cap_h
    if shaft_top - shaft_bottom < radius:
        raise ValueError("Column is too short for its base and capital")
    # Base: square plinth plus torus-like mouldings (attic) or a single plinth.
    if base_style != "none":
        plinth_h = base_h * (0.45 if base_style == "attic" else 1.0)
        stone.box((0, 0, plinth_h / 2), (radius * 2.7, radius * 2.7, plinth_h))
        if base_style == "attic":
            profile = []
            for i in range(9):
                t = i / 8
                z = plinth_h * 0.98 + t * (base_h - plinth_h * 0.98)
                r = radius * (1.18 + 0.12 * math.sin(math.pi * min(1, t * 2.2)) - 0.12 * t)
                profile.append((r, z))
            stone.lathe(profile, 32)
    # Shaft with entasis and optional flutes fading into fillets at both ends.
    rings = 26
    profile = []
    for i in range(rings + 1):
        t = i / rings
        z = shaft_bottom - radius * 0.02 + t * (shaft_top - shaft_bottom + radius * 0.04)
        r = radius * (1.0 - 0.14 * t) * (1 + 0.035 * math.sin(math.pi * t))
        profile.append((r, z))

    def fluting(index, z, theta):
        if not flutes:
            return 1.0
        t = index / rings
        fade = min(1.0, t / 0.06, (1 - t) / 0.06)
        groove = max(0.0, math.cos(flutes * theta)) ** 0.6
        return 1.0 - 0.07 * fade * groove
    stone.lathe(profile, segments, fluting)
    # Capital.
    if capital == "doric":
        echinus = [(radius * (0.86 + 0.3 * math.sin(math.pi * 0.5 * i / 6)), shaft_top + cap_h * 0.55 * i / 6) for i in range(7)]
        stone.lathe(echinus, 32)
        stone.box((0, 0, shaft_top + cap_h * 0.775), (radius * 2.5, radius * 2.5, cap_h * 0.45))
    elif capital == "ionic":
        stone.lathe([(radius * 0.88, shaft_top), (radius * 1.02, shaft_top + cap_h * 0.3), (radius * 1.05, shaft_top + cap_h * 0.5)], 32)
        stone.box((0, 0, shaft_top + cap_h * 0.6), (radius * 2.6, radius * 1.6, cap_h * 0.3))
        stone.box((0, 0, shaft_top + cap_h * 0.875), (radius * 2.4, radius * 2.4, cap_h * 0.25))
        for sign in (-1, 1):
            # Volute scroll: a spiral tube on each face of the capital.
            spine = []
            for i in range(25):
                a = i / 24 * 2.6 * math.pi
                rr = radius * 0.42 * (1 - 0.75 * i / 24)
                spine.append((sign * (radius * 1.15 + rr * math.sin(a)) - sign * radius * 0.0, -radius * 0.72 + i / 24 * radius * 1.44, shaft_top + cap_h * 0.55 - rr * math.cos(a)))
            stone.tube(spine, [radius * 0.09 * (1 - 0.5 * i / 24) for i in range(25)], 6, tip=True)
    elif capital == "corinthian":
        bell = [(radius * (0.86 + 0.42 * (i / 10) ** 1.6), shaft_top + cap_h * 0.82 * i / 10) for i in range(11)]
        stone.lathe(bell, 32)
        stone.box((0, 0, shaft_top + cap_h * 0.91), (radius * 2.6, radius * 2.6, cap_h * 0.18))
        rng = random.Random(seed)
        for row, (height_t, count) in enumerate(((0.38, 8), (0.62, 8))):
            for n in range(count):
                yaw = (n + 0.5 * row) * 2 * math.pi / count
                out = (math.cos(yaw), math.sin(yaw), 0.0)
                base = (out[0] * radius * 0.9, out[1] * radius * 0.9, shaft_top + cap_h * 0.04 + row * cap_h * 0.18)
                axis = norm(add((0, 0, 1), mul(out, 0.35 + 0.1 * rng.random())))
                stone.leaf(base, axis, out, cap_h * height_t, radius * 0.5, radius * 0.05)
        for n in range(4):
            yaw = math.pi / 4 + n * math.pi / 2
            out = (math.cos(yaw), math.sin(yaw), 0.0)
            spine = [(out[0] * radius * (0.95 + 0.4 * i / 8), out[1] * radius * (0.95 + 0.4 * i / 8), shaft_top + cap_h * (0.5 + 0.32 * i / 8) - radius * 0.12 * math.sin(math.pi * i / 8)) for i in range(9)]
            stone.tube(spine, [radius * 0.08 * (1 - 0.4 * i / 8) for i in range(9)], 6, tip=True)
    elif capital == "none":
        pass
    if stone.triangles() > budget_total:
        raise ValueError("Column exceeds its triangle budget; reduce flutes")
    return stone


# ----------------------------------------------------------- foliage ---------
def plan_foliage(params, seed, budget_total):
    rng = random.Random(seed)
    style, radius, height, density = params["style"], params["radius"], params["height"], params["density"]
    plant = MeshData()
    if style == "grass":
        per_blade = tube_triangles(3, 5, True)
        count = int(min(budget_total // per_blade, 900) * (0.3 + 0.7 * density))
        for _ in range(count):
            angle, distance = rng.uniform(0, 2 * math.pi), radius * math.sqrt(rng.random())
            root = (math.cos(angle) * distance, math.sin(angle) * distance, 0.0)
            lean = (math.cos(angle) * rng.uniform(0.1, 0.5), math.sin(angle) * rng.uniform(0.1, 0.5), 1)
            length = height * rng.uniform(0.55, 1.0)
            spine = spine_points(root, lean, length, 4, rng, 0.04, 0.05)
            spine[0] = root
            width = height * 0.025
            plant.tube(spine, [width * (1 - 0.7 * i / 4) for i in range(5)], 3, tip=True)
        return plant
    if style == "fern":
        fronds = 7 + int(density * 8)
        per_frond = tube_triangles(4, 9, True)
        leaflets = max(4, min(30, (budget_total // fronds - per_frond) // (2 * leaf_triangles())))
        for n in range(fronds):
            yaw = n * 2 * math.pi / fronds + rng.uniform(-0.25, 0.25)
            spine = spine_points((0.0, 0.0, 0.0), direction(yaw, math.radians(rng.uniform(40, 70))), height * rng.uniform(1.0, 1.4), 8, rng, 0.02, 0.12)
            plant.tube(spine, [height * 0.012 * (1 - 0.8 * i / 8) for i in range(9)], 4, tip=True)
            for i in range(leaflets):
                t = 0.15 + 0.8 * i / leaflets
                k = min(7, int(t * 8))
                point = add(spine[k], mul(sub(spine[k + 1], spine[k]), t * 8 - k))
                along = norm(sub(spine[k + 1], spine[k]))
                side = norm(cross(along, (0, 0, 1)))
                size = height * 0.28 * (1 - 0.7 * t)
                for sign in (-1, 1):
                    plant.leaf(add(point, mul(side, sign * size * 0.03)), norm(add(mul(side, sign), mul(along, 0.4))), (0, 0, 1), size, size * 0.3, size * 0.05)
        return plant
    # Bush: several woody stems with leaf clusters (wood/leaf share one material).
    stems = 5 + int(density * 4)
    anchors = []
    for n in range(stems):
        yaw = n * 2.39996
        spine = spine_points((math.cos(yaw) * radius * 0.1, math.sin(yaw) * radius * 0.1, 0.0), direction(yaw, math.radians(rng.uniform(50, 75))), height * rng.uniform(0.7, 0.95), 4, rng, 0.15, 0.02)
        plant.tube(spine, [height * 0.02 * (1 - 0.8 * i / 4) for i in range(5)], 5, tip=True)
        anchors.extend(spine[1:])
    capacity = max(0, budget_total - plant.triangles()) // leaf_triangles()
    for _ in range(int(capacity * (0.35 + 0.65 * density))):
        point = anchors[rng.randrange(len(anchors))]
        jitter = norm((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.4, 1)))
        base = add(point, mul(jitter, radius * 0.28 * rng.random() ** 0.5))
        axis = norm((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.4, 0.9)))
        size = height * 0.17 * rng.uniform(0.7, 1.2)
        plant.leaf(base, axis, norm((rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), 1)), size, size * 0.65, size * 0.05)
    return plant


# ------------------------------------------------------- fallen log / stump ---
# Natural deadwood in oak or birch bark: one closed bark mesh within DEADWOOD_TRIANGLES. Its
# species log texture (textures "<species>-log") holds one bark band round the whole girth,
# ``log_repeats`` bark tile widths wide and LOG_CYCLES tile lengths long (mossy on top, centred on
# u = .5, when the asset asks for moss), and four end-grain discs: 0-1 sawn, 2-3 broken. Rows
# (v0, height) at 512 px; must match textures.LOG_ROWS / LOG_CYCLES.
DEADWOOD_TRIANGLES = 4000
LOG_BAND = (0.0, .75)
LOG_CYCLES = {"oak": 2, "birch": 2}
# Flat (untextured) deadwood keeps its original bark band mapping.
LOG_BANDS = {"plain": (0.0, .375), "moss": (.375, .375)}
LOG_DISC_ROW, LOG_DISC_TILE, LOG_DISC_RADIUS = .75, .25, .46


def log_repeats(params):
    """Bark tiles packed round the log texture: the species tile count round the mean girth."""
    radius = params["radius"] * (.91 if params["kind"] == "log" else 1.0)
    return max(1, min(8, int(round(2 * math.pi * radius / BARK_TILE[params["species"]][0]))))


def deadwood_body(mesh, spine, radius_at, sides, params, rng, ends, up):
    """Closed bark body on ``spine`` with end caps. ``radius_at(i, theta)`` gives the ring radius;
    theta = pi (u = .5, the mossy side) faces ``up``. ``ends`` (start, end) are "cut" (a slightly
    tilted sawn face), "broken" (splintered, ragged rim) or "foot" (a flat hidden base)."""
    count = len(spine)
    tangents = [polyline_tangent(spine, i) for i in range(count)]
    normal = sub(mul(up, -1.0), mul(tangents[0], dot(mul(up, -1.0), tangents[0])))
    normal = norm(normal) if dot(normal, normal) > 1e-9 else perpendicular(tangents[0])
    frames = []
    for i in range(count):
        if i:
            axis = cross(tangents[i - 1], tangents[i])
            if dot(axis, axis) > 1e-12:
                normal = norm(rotate(normal, norm(axis), math.acos(max(-1.0, min(1.0, dot(tangents[i - 1], tangents[i]))))))
        frames.append((normal, norm(cross(tangents[i], normal))))
    thetas = [2 * math.pi * j / sides for j in range(sides)]
    mean = sum(radius_at(count // 2, t) for t in thetas) / sides
    # Splinter heights round a broken rim: squared noise, smoothed, longer on one side.
    jags = {}
    for which, style in zip((0, count - 1), ends):
        if style == "broken":
            raw = [rng.random() ** 3 for _ in range(sides)]
            lean = rng.uniform(0, 2 * math.pi)
            jags[which] = [(.7 * raw[j] + .15 * (raw[j - 1] + raw[(j + 1) % sides])) * (.3 + .7 * (.5 + .5 * math.cos(thetas[j] - lean))) for j in range(sides)]
        elif style == "cut":
            tilt, phase = math.tan(math.radians(rng.uniform(2.0, 9.0))), rng.uniform(0, 2 * math.pi)
            jags[which] = [tilt * math.cos(t - phase) for t in thetas]
    rings = []
    for i in range(count):
        n, b = frames[i]
        out = -1.0 if i == 0 else 1.0
        ring = []
        for j, t in enumerate(thetas):
            r = radius_at(i, t)
            offset = add(mul(n, math.cos(t) * r), mul(b, math.sin(t) * r))
            shift = 0.0
            if i in jags and ends[0 if i == 0 else 1] == "broken":
                shift = .6 * mean * jags[i][j]
            elif i in jags:
                shift = r * jags[i][j]
            ring.append(mesh.vertex(add(add(spine[i], offset), mul(tangents[i], out * shift))))
        rings.append(ring)
    distances = [0.0]
    for a, c in zip(spine, spine[1:]):
        distances.append(distances[-1] + math.dist(a, c))
    around_m, along_m = BARK_TILE[params["species"]]
    girth = 2 * math.pi * mean
    natural = params.get("finish") == "natural"
    band = LOG_BAND if natural else LOG_BANDS["moss" if params.get("moss") else "plain"]
    cycles = LOG_CYCLES[params["species"]] if natural else 1
    pad = .5 / BARK_RESOLUTION
    uv = wood_tile_uvs(distances + [distances[-1] + 1e-6], sides, {"around": 1, "period": cycles * along_m * girth / (log_repeats(params) * around_m),
                                                                    "strip": lambda first, last, j: (band[0], band[1], pad)})
    for index in range(count - 1):
        a, c = rings[index], rings[index + 1]
        for j in range(sides):
            k = (j + 1) % sides
            mesh.face((a[j], a[k], c[k], c[j]), uvs=uv(index, j))

    def disc(tile, f, t):
        cu, cv = (tile + .5) * LOG_DISC_TILE, LOG_DISC_ROW + .5 * LOG_DISC_TILE
        rho = LOG_DISC_RADIUS * LOG_DISC_TILE * f
        return (cu + rho * math.cos(t), cv + rho * math.sin(t))
    for which, style in zip((0, count - 1), ends):
        n, b = frames[which]
        rim, out = rings[which], (-1.0 if which == 0 else 1.0)
        tile = 2 + rng.randrange(2) if style == "broken" else rng.randrange(2)
        layers = [(1.0, rim)]
        if style == "broken":
            # Two inner rings of splinters above the rim, then a lower, torn heart.
            for f, rise in ((.64, 1.5), (.3, .7)):
                ring = []
                for j, t in enumerate(thetas):
                    r = radius_at(which, t) * f
                    lift = mean * (.08 + .75 * rise * jags[which][j] + .1 * rng.random())
                    ring.append(mesh.vertex(add(add(spine[which], add(mul(n, math.cos(t) * r), mul(b, math.sin(t) * r))), mul(tangents[which], out * lift))))
                layers.append((f, ring))
            centre = mesh.vertex(add(spine[which], mul(tangents[which], out * mean * rng.uniform(.1, .3))))
        else:
            centre = mesh.vertex(spine[which])
        for (fa, outer), (fb, inner) in zip(layers, layers[1:]):
            for j in range(sides):
                k = (j + 1) % sides
                quad = (outer[j], outer[k], inner[k], inner[j])
                uvs = (disc(tile, fa, thetas[j]), disc(tile, fa, thetas[k]), disc(tile, fb, thetas[k]), disc(tile, fb, thetas[j]))
                if out > 0:
                    mesh.face(quad, uvs=uvs)
                else:
                    mesh.face(tuple(reversed(quad)), uvs=tuple(reversed(uvs)))
        f, last = layers[-1]
        for j in range(sides):
            k = (j + 1) % sides
            if out > 0:
                mesh.face((last[j], last[k], centre), uvs=(disc(tile, f, thetas[j]), disc(tile, f, thetas[k]), disc(tile, 0.0, 0.0)))
            else:
                mesh.face((last[k], last[j], centre), uvs=(disc(tile, f, thetas[k]), disc(tile, f, thetas[j]), disc(tile, 0.0, 0.0)))
    return mesh


def deadwood_cap_triangles(style, sides):
    return 5 * sides if style == "broken" else sides


def plan_log(params, seed, budget_total):
    """Fallen log along +X: natural taper, a root swell at the butt, a slight bend, oval bark
    bumps, and sawn or broken ends; ``ends`` "mixed" saws the butt and snaps the top."""
    rng = random.Random(seed)
    noise = value_noise(seed + 7741)
    length, radius = params["length"], params["radius"]
    ends = {"cut": ("cut", "cut"), "broken": ("broken", "broken"), "mixed": ("cut", "broken")}[params["ends"]]
    sides = 24 if radius >= .12 else 16
    budget = min(budget_total, DEADWOOD_TRIANGLES) - sum(deadwood_cap_triangles(e, sides) for e in ends)
    count = max(6, min(budget // (2 * sides) + 1, int(math.ceil(length / min(.12, max(.05, radius * .45)))) + 1))
    bend, phase, sag = length * rng.uniform(.015, .04), rng.uniform(0, 2 * math.pi), rng.uniform(.005, .015) * length
    spine = []
    for i in range(count):
        s = i / (count - 1)
        spine.append((length * (s - .5), bend * math.sin(math.pi * s) + .3 * bend * math.sin(2 * math.pi * s + phase), -sag * math.sin(math.pi * s)))
    oval, turn = rng.uniform(.03, .07), rng.uniform(0, 2 * math.pi)

    def radius_at(i, theta):
        s = i / (count - 1)
        x = s * length
        swell = 1 + .22 * math.exp(-x / max(1.2 * radius, 1e-6))
        lumps = 1 + .05 * noise((math.cos(theta) * 1.4, math.sin(theta) * 1.4, x / max(radius, .05) * .6)) + .025 * noise((math.cos(theta) * 4, math.sin(theta) * 4, x / max(radius, .05) * 2.2))
        return radius * (1 - .18 * s) * swell * (1 + oval * math.cos(2 * (theta - turn))) * lumps
    mesh = deadwood_body(MeshData(), spine, radius_at, sides, params, rng, ends, UP)
    if mesh.triangles() > min(budget_total, DEADWOOD_TRIANGLES):
        raise ValueError("Log exceeded its triangle budget")
    return mesh


def plan_stump(params, seed, budget_total):
    """Stump with buttress root flare (the v5 lobes), a slight lean, and a sawn or broken top."""
    rng = random.Random(seed)
    noise = value_noise(seed + 9157)
    radius, height = params["radius"], params["height"]
    ends = ("foot", params["top"])
    sides = 40 if radius >= .12 else 24
    budget = min(budget_total, DEADWOOD_TRIANGLES) - sides - deadwood_cap_triangles(params["top"], sides)
    # Rings: dense through the flare, then about one per radius up the bole.
    zs = sorted({-.04 * radius} | {radius * f for f in (0.0, .04, .1, .18, .28, .4, .55, .75, 1.0)} | {height * k / 8 for k in range(1, 9)})
    zs = [z for z in zs if z <= height]
    if zs[-1] < height:
        zs.append(height)
    merged = []
    for z in zs:
        if not merged or z - merged[-1] > .02 * radius:
            merged.append(z)
    if len(merged) - 1 > budget // (2 * sides):
        raise ValueError("Stump exceeded its triangle budget")
    lean = (rng.uniform(-.04, .04), rng.uniform(-.04, .04))
    spine = [(lean[0] * z, lean[1] * z, z) for z in merged]
    turn = rng.uniform(0, 2 * math.pi)
    scale = 1.05 / max(1.25 * radius, 1e-6)

    def radius_at(i, theta):
        z = max(0.0, merged[i])
        lumps = 1 + .04 * noise((math.cos(theta) * 1.6, math.sin(theta) * 1.6, z / radius))
        # Softened buttresses: the v5 lobes averaged over a few degrees read as roots, not fins.
        gain = sum(flare_gain(theta + turn + d, z * scale, .75) for d in (-.22, -.11, 0.0, .11, .22)) / 5
        return radius * (1 + gain + .12 * max(0.0, 1 - z / (.6 * radius)) ** 2) * lumps
    north = (math.cos(turn), math.sin(turn), 0.0)
    return deadwood_body(MeshData(), spine, radius_at, sides, params, rng, ends, north)


# ----------------------------------------------------------- dispatcher ------
def plan(request):
    """Return [(source_key, material_key, MeshData, smooth)] for the validated request."""
    params = request["procedural"]
    kind, seed = params["kind"], request["seed"]
    budget = min(request["triangleBudget"], HARD_TRIANGLE_LIMIT)
    if kind not in GENERATORS:
        raise ValueError("Unknown procedural generator")
    post = None
    if params.get("variant"):
        # Variant family member (workers/blender/variation, copied as variation.py): concrete params, own seed, post-deformation.
        import variation
        params, seed, post = variation.resolve(params, seed, SPECIES[params["species"]]["radius"] if kind == "tree" else None)
    if kind == "tree":
        bark, leaves = plan_tree(params, seed, budget)
        parts = [("bark", "primary", bark)]
        if params["leafDensity"] > 0:
            parts.append(("leaves", "secondary", leaves))
    elif kind == "rock":
        parts = [("rock", "primary", (plan_natural_rock if params.get("form") else plan_rock)(params, seed, budget))]
    elif kind == "column":
        parts = [("stone", "primary", plan_column(params, seed, budget))]
    elif kind in ("log", "stump"):
        parts = [("bark", "primary", (plan_log if kind == "log" else plan_stump)(params, seed, budget))]
    else:
        parts = [("foliage", "primary", plan_foliage(params, seed, budget))]
    if post is not None:
        variation.deform(parts, post)
    total = sum(p[2].triangles() for p in parts)
    if total > budget or any(not p[2].faces for p in parts):
        raise ValueError("Procedural mesh exceeded its triangle budget or is empty")
    # Floor pivot: the lowest vertex of the whole asset rests exactly on z = 0.
    floor = min(v[2] for p in parts for v in p[2].vertices)
    for p in parts:
        p[2].vertices = [(x, y, z - floor) for x, y, z in p[2].vertices]
        if p[2].wood is not None:
            p[2].wood["samples"] = [((c[0], c[1], c[2] - floor), r) for c, r in p[2].wood["samples"]]
            p[2].wood["junctions"] = [((c[0], c[1], c[2] - floor), r, rp) for c, r, rp in p[2].wood["junctions"]]
    if params.get("finish") == "natural":
        engine_uvs(request, parts)
    return parts


def engine_uvs(request, parts):
    """General UV stage (workers/blender/uv; uv_*.py flat beside this file in a job): unwraps the
    parts without deliberate generator UVs and tags every part's UV intent for the audit."""
    import uv_stage
    uv_stage.finish_uvs(request, parts, surface_materials(request), tuple(BARK_TILE))


MATERIALS = {
    # kind/part -> (metallic, roughness)
    "bark": (0.0, 0.92), "leaves": (0.0, 0.62), "rock": (0.0, 0.88), "stone": (0.0, 0.55), "foliage": (0.0, 0.6),
}


# Last natural wood union outcome, for native review harnesses only (never exported).
WOOD_UNION = {}


def wood_part_mesh(name, vertices, faces, smooth, uvs):
    import bpy
    import bmesh
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    if mesh.validate(verbose=False):
        raise ValueError("Procedural mesh required structural repair")
    for polygon, flag in zip(mesh.polygons, smooth):
        polygon.use_smooth = flag
    uv = mesh.uv_layers.new(name="UVMap")
    for polygon, points in zip(mesh.polygons, uvs):
        for loop, point in zip(polygon.loop_indices, points):
            uv.data[loop].uv = point
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bm.to_mesh(mesh)
    finally:
        bm.free()
    return mesh


def union_wood(data, name):
    """Exact self-union of the trunk (base) and branch tubes (operand), then seam fairing.

    Returns the blended mesh, or None unless it is one closed, consistently wound solid
    with positive volume, clean faces/UVs and within the planned bark triangle limit.
    """
    import bpy
    wood = data.wood
    tv, tf = wood["trunkVertices"], wood["trunkFaces"]
    WOOD_UNION.clear()
    if tf >= len(data.faces):
        WOOD_UNION.update(state="single-axis")
        return None
    trunk = wood_part_mesh(name + "_Trunk", data.vertices[:tv], data.faces[:tf], data.smooth[:tf], data.uvs[:tf])
    branches = wood_part_mesh(name + "_Branches", data.vertices[tv:], [tuple(i - tv for i in f) for f in data.faces[tf:]],
                              data.smooth[tf:], data.uvs[tf:])
    original = {tuple(v.co) for v in trunk.vertices} | {tuple(v.co) for v in branches.vertices}
    base = bpy.data.objects.new(name + "_UnionBase", trunk)
    operand = bpy.data.objects.new(name + "_UnionOperand", branches)
    scene = bpy.context.scene
    scene.collection.objects.link(base)
    scene.collection.objects.link(operand)
    try:
        mod = base.modifiers.new("Union", "BOOLEAN")
        mod.operation, mod.solver, mod.object = "UNION", "EXACT", operand
        mod.use_self, mod.use_hole_tolerant = True, False
        bpy.context.view_layer.update()
        graph = bpy.context.evaluated_depsgraph_get()
        mesh = bpy.data.meshes.new_from_object(base.evaluated_get(graph), preserve_all_data_layers=True, depsgraph=graph)
    finally:
        bpy.data.objects.remove(base, do_unlink=True)
        bpy.data.objects.remove(operand, do_unlink=True)
        bpy.data.meshes.remove(trunk)
        bpy.data.meshes.remove(branches)
    mesh.name = name
    report = fair_wood(mesh, original, wood["samples"], wood["scale"], wood.get("uvBands", [(0.0, 1.0)]))
    bounds = [(min(v[k] for v in data.vertices), max(v[k] for v in data.vertices)) for k in range(3)]
    report.update(wood_gate(mesh, wood["triangleLimit"], bounds))
    WOOD_UNION.update(report)
    if report["errors"]:
        WOOD_UNION["state"] = "fallback"
        bpy.data.meshes.remove(mesh)
        return None
    WOOD_UNION["state"] = "union"
    return mesh


def fair_wood(mesh, original, samples, scale, uv_bands=((0.0, 1.0),)):
    """Blend every junction band: weighted Laplacian over a geodesic band around the union seams.

    The band half-width follows the thinner participating axis plus a share of the thicker
    one, so a thin limb on a thick trunk still blends over the trunk side instead of creasing.
    """
    import bmesh
    import heapq
    cell = .3 * scale
    grid = {}
    for c, r in samples:
        grid.setdefault((math.floor(c[0] / cell), math.floor(c[1] / cell), math.floor(c[2] / cell)), []).append((c, r))
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        # Triangulate the union's planar polygons before fairing bends them: splitting a warped
        # polygon later can reuse an existing edge and leave it non-manifold.
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3], quad_method="BEAUTY", ngon_method="EAR_CLIP")
        bm.verts.ensure_lookup_table()
        bm.verts.index_update()
        bm.faces.index_update()
        seam = [v for v in bm.verts if tuple(v.co) not in original]
        union_nonmanifold = sum(not e.is_manifold for e in bm.edges)
        best, width, heap = {}, {}, []
        reach = int(math.ceil(.6 * scale / cell))
        for v in seam:
            p = tuple(v.co)
            k = (math.floor(p[0] / cell), math.floor(p[1] / cell), math.floor(p[2] / cell))
            thin = thick = None
            for dx in range(-reach, reach + 1):
                for dy in range(-reach, reach + 1):
                    for dz in range(-reach, reach + 1):
                        for c, r in grid.get((k[0] + dx, k[1] + dy, k[2] + dz), ()):
                            if abs(math.dist(p, c) - r) <= .35 * r + .004 * scale:
                                thin = r if thin is None else min(thin, r)
                                thick = r if thick is None else max(thick, r)
            thin = thin or .02 * scale
            thick = thick or thin
            rho = min(.32 * scale, max(.016 * scale, 1.5 * thin + .4 * (thick - thin)))
            best[v.index], width[v.index] = 0.0, rho
            heapq.heappush(heap, (0.0, v.index, rho))
        while heap:
            t, i, rho = heapq.heappop(heap)
            if t > best.get(i, 9.0):
                continue
            for e in bm.verts[i].link_edges:
                o = e.other_vert(bm.verts[i])
                nt = t + e.calc_length() / rho
                if nt < 1.0 and nt < best.get(o.index, 9.0):
                    best[o.index], width[o.index] = nt, rho
                    heapq.heappush(heap, (nt, o.index, rho))
        weight = {i: (1 - t) ** 2 * (1 + 2 * t) for i, t in best.items()}
        band = [bm.verts[i] for i in sorted(weight)]
        start = {v.index: v.co.copy() for v in band}
        bm.normal_update()
        normals = {f.index: f.normal.copy() for v in band for f in v.link_faces}
        band_faces = sorted({f for v in band for f in v.link_faces}, key=lambda f: f.index)
        # Taubin pairs (shrink, then inflate) blend the crotch without necking thin limbs. Each
        # pass is guarded locally: a move that would flip a face is undone for that face only,
        # so one sliver cannot hold the whole junction band at its sharp union shape.
        for factor in (.5, -.53) * FAIR_PAIRS:
            moved, before = {}, {}
            for v in band:
                ring = [e.other_vert(v).co for e in v.link_edges]
                avg = ring[0].copy()
                for co in ring[1:]:
                    avg += co
                avg /= len(ring)
                target = v.co + (avg - v.co) * (factor * weight[v.index])
                # Never travel further than a third of the local band width from the union
                # surface: inflation on a sliver fan must not throw a needle out of the bark.
                offset, bound = target - start[v.index], width[v.index] / 3
                moved[v.index] = start[v.index] + offset * (bound / offset.length) if offset.length > bound else target
            for v in band:
                before[v.index] = v.co.copy()
                v.co = moved[v.index]
            for _ in range(3):
                undone = 0
                for f in band_faces:
                    f.normal_update()
                    if f.calc_area() > 1e-12 and f.normal.dot(normals[f.index]) < .05:
                        for w in f.verts:
                            if w.index in before and w.co != before[w.index]:
                                w.co = before[w.index].copy()
                                undone += 1
                if not undone:
                    break
        bm.normal_update()
        flips = 0
        for attempt in range(8):
            bad = [f for f in bm.faces if f.index in normals and f.normal.dot(normals[f.index]) < .05 and f.calc_area() > 1e-12]
            flips = len(bad)
            if not bad:
                break
            for f in bad:
                for v in f.verts:
                    if v.index in start:
                        # Halve back toward the union position; the last attempts restore it fully.
                        v.co = v.co.lerp(start[v.index], .5 if attempt < 5 else 1.0)
            bm.normal_update()
        relaxed = relax_junction_uvs(bm, start, weight, {v.index for v in seam}, uv_bands) if JUNCTION_UV_RELAX else 0
        bmesh.ops.dissolve_degenerate(bm, dist=SLIVER_DIST, edges=list(bm.edges))
        # Collapsing slivers can merge triangles back into polygons; keep the mesh all triangles
        # so later game triangulation cannot create new zero-area UV faces.
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3], quad_method="BEAUTY", ngon_method="BEAUTY")
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bm.normal_update()
        repaired = repair_wood_uvs(bm)
        bm.to_mesh(mesh)
    finally:
        bm.free()
    mesh.update()
    return {"unionNonManifoldEdges": union_nonmanifold, "seamVertices": len(seam), "bandVertices": len(weight), "fairingPasses": 2 * FAIR_PAIRS, "residualFlippedFaces": flips, "repairedUVFaces": repaired, "relaxedUVs": relaxed}


def _uv_jacobian(points, uvs):
    """2x3 map J of one triangle with J (P_i - P_0) = uv_i - uv_0 and J n = 0, or None if degenerate."""
    e1, e2 = points[1] - points[0], points[2] - points[0]
    g00, g01, g11 = e1.dot(e1), e1.dot(e2), e2.dot(e2)
    det = g00 * g11 - g01 * g01
    if det <= 1e-20 * max(g00 * g11, 1e-30):
        return None
    d1, d2 = uvs[1] - uvs[0], uvs[2] - uvs[0]
    # J = D G^-1 E^T with D = [d1 d2], E = [e1 e2], G = E^T E.
    i00, i01, i11 = g11 / det, -g01 / det, g00 / det
    a = (d1.x * i00 + d2.x * i01, d1.x * i01 + d2.x * i11)
    b = (d1.y * i00 + d2.y * i01, d1.y * i01 + d2.y * i11)
    return (e1 * a[0] + e2 * a[1], e1 * b[0] + e2 * b[1])


def _uv_signed_area(uvs):
    return ((uvs[1].x - uvs[0].x) * (uvs[2].y - uvs[0].y) - (uvs[2].x - uvs[0].x) * (uvs[1].y - uvs[0].y)) / 2


def relax_junction_uvs(bm, start, weight, hard=frozenset(), bands=((0.0, 1.0),)):
    """Junction UV relaxation after seam fairing (natural bark only).

    Fairing moves junction-band vertices but keeps their authored branch-aligned bark UVs, so the
    band's texture stretches (pine crotches measured about 1.4:1 against 0.86 elsewhere). Two steps,
    with everything outside the band (``start``, falloff ``weight``) pinned:

    1. Transfer: each band UV corner (a vertex's loops sharing one UV) moves by its faces' authored
       UV map J over the pre-fairing positions, J (P' - P): the bark stays where it was painted on
       the union surface instead of sliding with the moved vertex. The corners of a vertex on a
       tile-copy or strip seam take one mean shift, so the repeating bark stays continuous there.
    2. Local/global relaxation (``JUNCTION_UV_PASSES`` Jacobi passes): each triangle's target UV
       shape is its authored map applied to its faired shape, rotated back onto the authored
       triangle; single-UV corners and both sides of the trunk/branch union seam (``hard``; never
       continuous) move to the area-weighted mean of their targets, damped by the band falloff.

    Every corner stays inside its own tile copy (u 0..1) and strip band (``bands``), and a move
    that would fold or collapse a UV triangle is undone. Deterministic (fixed vertex/UV order).
    Returns the number of corner moves accepted."""
    from mathutils import Vector
    layer = bm.loops.layers.uv.active
    if layer is None or not start:
        return 0

    def original(v):
        return start.get(v.index, v.co)
    corners = []  # (vertex, [loops]) per band UV corner, in vertex then UV order
    for index in sorted(start):
        v = bm.verts[index]
        groups = {}
        for loop in v.link_loops:
            uv = loop[layer].uv
            groups.setdefault((round(uv.x, 7), round(uv.y, 7)), []).append(loop)
        for key in sorted(groups):
            corners.append((v, groups[key]))
    uv_of = {}
    for v, loops in corners:
        for loop in loops:
            uv_of[loop] = loop[layer].uv.copy()

    authored = {loop: uv.copy() for loop, uv in uv_of.items()}

    def face_uvs(f):
        return [uv_of.get(loop, loop[layer].uv) for loop in f.loops]

    def box(loops):
        # The tile copy (u 0..1) and the strip band holding every face of this corner; a corner whose
        # faces straddle bands (a repair patch) keeps the UV box of its own faces.
        pts = [p for loop in loops for p in face_uvs(loop.face)]
        lo_u, lo_v, hi_u, hi_v = min(p.x for p in pts), min(p.y for p in pts), max(p.x for p in pts), max(p.y for p in pts)
        if lo_u < -1e-6 or hi_u > 1 + 1e-6:
            return lo_u, lo_v, hi_u, hi_v
        for lo, hi in bands:
            if lo - 1e-6 <= lo_v and hi_v <= hi + 1e-6:
                return 0.0, lo, 1.0, hi
        return lo_u, lo_v, hi_u, hi_v
    boxes = [box(loops) for _, loops in corners]

    def place(cis, targets):
        """Move corners together (each boxed); undo all if any of their faces would fold or collapse."""
        loops = [loop for ci in cis for loop in corners[ci][1]]
        saved = [uv_of[loop].copy() for loop in loops]
        faces = list({loop.face: None for loop in loops})
        before = [_uv_signed_area(face_uvs(f)) for f in faces]
        for ci, target in zip(cis, targets):
            lo_u, lo_v, hi_u, hi_v = boxes[ci]
            target = Vector((min(hi_u, max(lo_u, target.x)), min(hi_v, max(lo_v, target.y))))
            for loop in corners[ci][1]:
                uv_of[loop] = target.copy()
        for f, area in zip(faces, before):
            after = _uv_signed_area(face_uvs(f))
            if area * after <= 0 or abs(after) < .25 * abs(area):
                for back, uv in zip(loops, saved):
                    uv_of[back] = uv
                return False
        return True

    def transfer(ci, delta):
        """UV shift of corner ci for a 3D move ``delta``: its faces' pre-fairing Jacobian, by area."""
        ju, jv, total = Vector((0.0, 0.0, 0.0)), Vector((0.0, 0.0, 0.0)), 0.0
        for loop in corners[ci][1]:
            f = loop.face
            if len(f.verts) != 3:
                continue
            points = [original(w) for w in f.verts]
            j = _uv_jacobian(points, [Vector(authored.get(loop, loop[layer].uv)) for loop in f.loops])
            if j is None:
                continue
            area = (points[1] - points[0]).cross(points[2] - points[0]).length
            ju, jv, total = ju + j[0] * area, jv + j[1] * area, total + area
        return Vector((ju.dot(delta) / total, jv.dot(delta) / total)) if total > 0 else None
    moved = set()
    by_vertex = {}
    for ci, (v, _) in enumerate(corners):
        by_vertex.setdefault(v.index, []).append(ci)

    def shift_vertex(index, shifts):
        """Apply per-corner UV shifts of one vertex. Corners of a tile-copy or strip seam take their
        mean shift, so the repeating bark stays continuous across it (each corner still boxed); the
        two sides of the trunk/branch union seam (``hard``) were never continuous and move apart."""
        cis = by_vertex[index]
        if index not in hard and len(cis) > 1:
            known = [x for x in shifts if x is not None]
            if not known:
                return
            mean = sum(known, Vector((0.0, 0.0))) / len(known)
            shifts = [mean] * len(cis)
        if index not in hard and len(cis) > 1:
            if place(cis, [uv_of[corners[ci][1][0]] + x for ci, x in zip(cis, shifts)]):
                moved.update(cis)
            return
        for ci, x in zip(cis, shifts):
            if x is not None and place([ci], [uv_of[corners[ci][1][0]] + x]):
                moved.add(ci)
    # 1. Transfer: the moved vertex reads the bark painted at its pre-fairing surface point.
    for index in sorted(by_vertex):
        v = corners[by_vertex[index][0]][0]
        delta = v.co - original(v)
        if delta.length > 1e-9:
            shift_vertex(index, [transfer(ci, delta) for ci in by_vertex[index]])
    # 2. Local/global relaxation against each triangle's authored UV map: a triangle's target UV
    # shape is its rest map A (pre-fairing 3D -> authored UV) applied to its faired shape, rotated
    # back onto the rest triangle; each free corner moves to the area-weighted mean of its targets.
    rest = {}
    for f in {loop.face: None for _, loops in corners for loop in loops}:
        if len(f.verts) != 3:
            continue
        points = [original(w) for w in f.verts]
        e1, e2 = points[1] - points[0], points[2] - points[0]
        n = e1.cross(e2)
        if e1.length <= 1e-9 or n.length <= 1e-12:
            continue
        x = e1.normalized()
        y = n.normalized().cross(x)
        a, b, c = e1.length, e2.dot(x), e2.dot(y)
        if c <= .1 * max(a, abs(b), abs(b - a)):  # slivers have no reliable rest map
            continue
        uvs = [Vector(authored.get(loop, loop[layer].uv)) for loop in f.loops]
        d1, d2 = uvs[1] - uvs[0], uvs[2] - uvs[0]
        # A [a b; 0 c] = [d1 d2]
        m = ((d1.x / a, (d2.x - d1.x * b / a) / c), (d1.y / a, (d2.y - d1.y * b / a) / c))
        o = [(0.0, 0.0), (a, 0.0), (b, c)]
        rest[f] = (m, o, n.length / 2)
    # Tile-copy and strip seam vertices keep their transfer: averaging two sides' targets drags both.
    free = [index for index in sorted(by_vertex) if weight.get(index, 0) > 0 and (len(by_vertex[index]) == 1 or index in hard)]
    for _ in range(JUNCTION_UV_PASSES):
        targets = {}
        for f, (m, o, area) in rest.items():
            q = [w.co for w in f.verts]
            e1, e2 = q[1] - q[0], q[2] - q[0]
            n = e1.cross(e2)
            if e1.length <= 1e-9 or n.length <= 1e-12:
                continue
            x = e1.normalized()
            y = n.normalized().cross(x)
            p = [(0.0, 0.0), (e1.length, 0.0), (e2.dot(x), e2.dot(y))]
            pc = ((p[1][0] + p[2][0]) / 3, (p[1][1] + p[2][1]) / 3)
            oc = ((o[1][0] + o[2][0]) / 3, (o[1][1] + o[2][1]) / 3)
            sx = sy = 0.0
            for (px, py), (ox, oy) in zip(p, o):
                px, py, ox, oy = px - pc[0], py - pc[1], ox - oc[0], oy - oc[1]
                sx += px * ox + py * oy
                sy += px * oy - py * ox
            t = math.atan2(sy, sx)
            cs, sn = math.cos(t), math.sin(t)
            loops = list(f.loops)
            current = [Vector(uv_of.get(loop, loop[layer].uv)) for loop in loops]
            centre = (current[0] + current[1] + current[2]) / 3
            for loop, (px, py) in zip(loops, p):
                if loop not in uv_of:
                    continue
                rx, ry = cs * (px - pc[0]) - sn * (py - pc[1]), sn * (px - pc[0]) + cs * (py - pc[1])
                goal = centre + Vector((m[0][0] * rx + m[0][1] * ry, m[1][0] * rx + m[1][1] * ry))
                acc = targets.setdefault(loop, [Vector((0.0, 0.0)), 0.0])
                acc[0] += goal * area
                acc[1] += area
        for index in free:
            shifts = []
            for ci in by_vertex[index]:
                loops = corners[ci][1]
                total = sum(targets[loop][1] for loop in loops if loop in targets)
                if total <= 0:
                    shifts.append(None)
                    continue
                goal = sum((targets[loop][0] for loop in loops if loop in targets), Vector((0.0, 0.0))) / total
                shifts.append((goal - uv_of[loops[0]]) * weight[index])
            shift_vertex(index, shifts)
    for v, loops in corners:
        for loop in loops:
            loop[layer].uv = uv_of[loop]
    return len(moved)


def repair_wood_uvs(bm):
    """Union seam slivers can inherit collapsed or out-of-range UVs; give them a tiny local projection."""
    layer = bm.loops.layers.uv.active
    if layer is None:
        return -1
    repaired = 0
    for f in bm.faces:
        loops = list(f.loops)
        for loop in loops:
            u, v = loop[layer].uv
            loop[layer].uv = (min(1.0, max(0.0, u)), min(1.0, max(0.0, v)))
        points = [loop[layer].uv.copy() for loop in loops]
        area = abs(sum(a.x * b.y - b.x * a.y for a, b in zip(points, points[1:] + points[:1]))) / 2
        longest = max((a - b).length for a, b in zip(points, points[1:] + points[:1]))
        # Near-collinear slivers too: game triangulation re-interpolates UVs by about one ulp,
        # which can collapse a thin UV triangle that passed an absolute area floor.
        if area > 1e-8 and area > 1e-4 * longest * longest:
            continue
        repaired += 1
        cu = min(.997, max(.003, sum(p.x for p in points) / len(points)))
        cv = min(.997, max(.003, sum(p.y for p in points) / len(points)))
        n = f.normal
        a = (n.cross((1.0, 0.0, 0.0)) if abs(n.x) < .9 else n.cross((0.0, 1.0, 0.0))).normalized()
        b = n.cross(a)
        projected = [(loop.vert.co.dot(a), loop.vert.co.dot(b)) for loop in loops]
        lo = (min(p[0] for p in projected), min(p[1] for p in projected))
        span = max(max(p[0] for p in projected) - lo[0], max(p[1] for p in projected) - lo[1], 1e-9)
        patch = [(cu + .002 * (x - lo[0]) / span, cv + .002 * (y - lo[1]) / span) for x, y in projected]
        if abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(patch, patch[1:] + patch[:1]))) / 2 <= 1e-8:
            # A needle in 3D projects to a needle: use a fixed tiny fan instead.
            patch = [(cu + .002 * math.cos(2 * math.pi * k / len(loops)), cv + .002 * math.sin(2 * math.pi * k / len(loops))) for k in range(len(loops))]
            patch = [(min(1.0, max(0.0, u)), min(1.0, max(0.0, v))) for u, v in patch]
        for loop, point in zip(loops, patch):
            loop[layer].uv = point
    return repaired


def wood_gate(mesh, limit, bounds):
    """The structural facts the asset audit later enforces, checked before the union is accepted."""
    import bmesh
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        unseen, components = set(bm.verts), 0
        while unseen:
            components += 1
            todo = [unseen.pop()]
            while todo:
                for e in todo.pop().link_edges:
                    for w in e.verts:
                        if w in unseen:
                            unseen.remove(w)
                            todo.append(w)
        layer = bm.loops.layers.uv.active
        degenerate_uv = 0
        if layer is not None:
            for f in bm.faces:
                points = [loop[layer].uv for loop in f.loops]
                if abs(sum(a.x * b.y - b.x * a.y for a, b in zip(points, points[1:] + points[:1]))) / 2 <= 1e-9:
                    degenerate_uv += 1
        result = {
            "components": components,
            "triangles": sum(len(f.verts) - 2 for f in bm.faces),
            "polygons": sum(len(f.verts) > 3 for f in bm.faces),
            "boundaryEdges": sum(e.is_boundary for e in bm.edges),
            "nonManifoldEdges": sum(not e.is_manifold for e in bm.edges),
            "inconsistentNormals": sum(e.is_manifold and not e.is_contiguous for e in bm.edges),
            "degenerateFaces": sum(f.calc_area() <= 1e-10 for f in bm.faces),
            "duplicateVertices": len(bm.verts) - len({tuple(round(c, 6) for c in v.co) for v in bm.verts}),
            "degenerateUVFaces": degenerate_uv, "uvLayers": layer is not None,
            "volume": bm.calc_volume(signed=True),
            # No vertex may leave the planned tubes' box (a stray seam vertex reads as a needle).
            "outsideBounds": sum(any(not lo - 1e-4 <= v.co[k] <= hi + 1e-4 for k, (lo, hi) in enumerate(bounds)) for v in bm.verts),
        }
    finally:
        bm.free()
    errors = [k for k in ("boundaryEdges", "nonManifoldEdges", "inconsistentNormals", "degenerateFaces", "duplicateVertices", "degenerateUVFaces", "polygons", "outsideBounds") if result[k]]
    if result["components"] != 1:
        errors.append("components")
    if result["volume"] <= 0:
        errors.append("volume")
    if result["triangles"] > limit:
        errors.append("triangles")
    if not result["uvLayers"]:
        errors.append("uvLayers")
    result["errors"] = errors
    return result


def build(request, make_material, make_collection, select, make_box):
    """Blender side: convert planned meshes into named, floor-pivoted objects."""
    import bpy
    import bmesh
    params = request["procedural"]
    group = make_collection("COL_Procedural")
    colors = {"primary": request["color"], "secondary": params.get("secondaryColor") or request["color"]}
    main = []
    for key, color_key, data in plan(request):
        metallic, roughness = MATERIALS[key]
        if params.get("finish") == "natural" and key in ("leaves", "foliage", "stone"):
            roughness = .8
        mat = make_material("MAT_" + key.capitalize(), colors[color_key], metallic, roughness)
        mesh = None
        if key == "bark" and data.wood is not None and params.get("finish") == "natural":
            # One blended solid; any union that is not a single closed solid within budget
            # falls back to the individually closed tubes below.
            mesh = union_wood(data, "SM_" + request["name"] + "_" + key + "_Mesh")
        if mesh is None:
            mesh = bpy.data.meshes.new("SM_" + request["name"] + "_" + key + "_Mesh")
            mesh.from_pydata(data.vertices, [], data.faces)
            if mesh.validate(verbose=False):
                raise ValueError("Procedural mesh required structural repair")
            for polygon, smooth in zip(mesh.polygons, data.smooth):
                polygon.use_smooth = smooth
            uv = mesh.uv_layers.new(name="UVMap")
            for polygon, points in zip(mesh.polygons, data.uvs):
                for loop, point in zip(polygon.loop_indices, points):
                    uv.data[loop].uv = point
            bm = bmesh.new()
            try:
                bm.from_mesh(mesh)
                bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
                if key in ("leaves", "foliage"):
                    # Split the front/back rim normal: averaging opposite faces makes a thin
                    # leaf read like an inflated diamond even when its physical thickness is low.
                    bm.normal_update()
                    for edge in bm.edges:
                        if len(edge.link_faces) == 2 and edge.calc_face_angle(0) > math.radians(80):
                            edge.smooth = False
                bm.to_mesh(mesh)
            finally:
                bm.free()
        if data.normals is not None and len(data.normals) == len(mesh.vertices):
            # Canopy clusters shade as soft masses (exported as glTF normals).
            mesh.normals_split_custom_set_from_vertices(data.normals)
        obj = bpy.data.objects.new("SM_" + request["name"] + "_" + key, mesh)
        group.objects.link(obj)
        obj["arcane_role"] = "render"
        obj["arcane_source_key"] = key
        obj["arcane_surface_uv"] = True
        if data.uv_report:
            obj["arcane_uv_intent"], obj["arcane_uv_texture"] = data.uv_report["intent"], data.uv_report["textureSize"]
        mesh.materials.append(mat)
        main.append(obj)
    bpy.context.view_layer.update()
    points = [v.co for obj in main for v in obj.data.vertices]
    low = [min(p[k] for p in points) for k in range(3)]
    high = [max(p[k] for p in points) for k in range(3)]
    collisions = make_collection("COL_Collision")
    if params["kind"] == "tree":
        # Players collide with the trunk only, never the canopy.
        radius = (params["trunkRadius"] or params["height"] * SPECIES[params["species"]]["radius"]) * 1.2
        size = (radius * 2, radius * 2, (high[2] - low[2]) * (0.45 if params["species"] == "oak" else 0.9))
        center = (0, 0, size[2] / 2)
    else:
        size = tuple(max(0.02, high[k] - low[k]) for k in range(3))
        center = ((low[0] + high[0]) / 2, (low[1] + high[1]) / 2, (low[2] + high[2]) / 2)
    proxy = make_box(collisions, "COL_" + request["name"], size, center, role="collision", source_key="proxy")
    return main, [], [proxy], []


def surface_materials(request):
    """Trusted adapter into the shared opaque PNG author, never a public recipe/code payload."""
    if request["procedural"].get("finish") != "natural":
        return []
    kind = request["procedural"]["kind"]
    keys = (["bark"] if request["procedural"]["leafDensity"] == 0 else ["bark", "leaves"]) if kind == "tree" else ["stone" if kind == "column" else "rock" if kind == "rock" else "foliage"]
    profiles = {"bark": "bark", "leaves": "leaf", "rock": "stone", "stone": "weathered", "foliage": "leaf"}
    species = request["procedural"].get("species")
    # Natural oak/birch/pine: species bark tile and leaf/needle-spray cutout atlas at 512 px (textures.tree_pixels).
    tree = kind == "tree" and species in BARK_TILE
    # Natural log/stump: one bark mesh with the species log texture (bark bands + end-grain discs).
    deadwood = kind in ("log", "stump")
    if deadwood:
        keys = ["bark"]
    # Natural rock forms: one 512 px texture baked in world space over the rock's unique UV charts.
    stone = kind == "rock" and request["procedural"].get("form") in ROCK_FORMS
    return [{"id": key.capitalize(), "color": request["procedural"]["secondaryColor"] if key == "leaves" else request["color"],
             "metallic": MATERIALS[key][0], "roughness": .8 if key in ("leaves", "foliage", "stone") else MATERIALS[key][1],
             "surface": {"profile": profiles[key], "resolution": BARK_RESOLUTION if tree or deadwood or stone else 256},
             **({"pattern": species + "-" + key} if tree else {}),
             **({"pattern": species + "-log", "repeats": log_repeats(request["procedural"]), "moss": bool(request["procedural"].get("moss"))} if deadwood else {}),
             **({"pattern": rock_pattern(request["procedural"]), "extent": rock_extent(request["procedural"]), "moss": bool(request["procedural"].get("moss"))} if stone else {})}
            for key in keys]


def author_finish(request, directory, objects):
    from textures import author_surfaces
    relief = {"tree": .008, "rock": .005, "column": .006, "foliage": .007, "log": .008, "stump": .008}[request["procedural"]["kind"]]
    materials = surface_materials(request)
    if materials and request["procedural"]["kind"] == "rock" and request["procedural"].get("form") in ROCK_FORMS:
        # The rock texture is baked from the (deterministic) planned mesh: world-space stone and moss.
        materials[0]["bake"] = rock_bake(plan(request)[0][2])
    seed = request["seed"]
    if request["procedural"].get("variant"):
        import variation
        materials, seed = variation.tint_surfaces(request["procedural"], seed, materials), variation.texture_seed(request["procedural"], seed)
    author_surfaces({"seed": seed, "recipe": {"materials": materials}}, directory, objects, normal_relief=relief)
