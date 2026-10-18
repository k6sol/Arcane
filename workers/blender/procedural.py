"""Bundled, parameterised procedural generators: tree, rock, column and foliage.

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
GENERATORS = ("tree", "rock", "column", "foliage")
HARD_TRIANGLE_LIMIT = 20000
TUBE_MIN_RADIUS = 0.004


def tube_triangles(sides, rings, tip):
    # Side quads, a bottom n-gon cap and a top cone tip or n-gon cap.
    return 2 * sides * (rings - 1) + (sides - 2) + (sides if tip else sides - 2)


def leaf_triangles():
    return 8


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
class MeshData:
    """Plain vertex/face lists for one material; converted to bmesh by build()."""

    def __init__(self):
        self.vertices = []
        self.faces = []
        self.smooth = []

    def vertex(self, co):
        self.vertices.append((float(co[0]), float(co[1]), float(co[2])))
        return len(self.vertices) - 1

    def face(self, indices, smooth=True):
        self.faces.append(tuple(indices))
        self.smooth.append(smooth)

    def triangles(self):
        return sum(len(f) - 2 for f in self.faces)

    def tube(self, spine, radii, sides, tip=True, flare=None):
        """Closed tapered tube along a polyline with parallel-transport frames."""
        if len(spine) < 2 or len(spine) != len(radii):
            raise ValueError("Tube spine/radius mismatch")
        tangents = []
        for i in range(len(spine)):
            a = spine[max(0, i - 1)]
            b = spine[min(len(spine) - 1, i + 1)]
            tangents.append(norm(sub(b, a)))
        normal = perpendicular(tangents[0])
        rings = []
        last = len(spine) - (1 if tip else 0)
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
        for a, b in zip(rings, rings[1:]):
            for j in range(sides):
                k = (j + 1) % sides
                self.face((a[j], a[k], b[k], b[j]))
        self.face(tuple(reversed(rings[0])), smooth=False)
        if tip:
            apex = self.vertex(spine[-1])
            top = rings[-1]
            for j in range(sides):
                self.face((top[j], top[(j + 1) % sides], apex))
        else:
            self.face(tuple(rings[-1]), smooth=False)

    def leaf(self, base, axis, face_normal, length, width, thickness):
        """Thin closed diamond slab (8 triangles): a leaf or needle-spray card."""
        axis = norm(axis)
        side = cross(axis, face_normal)
        side = norm(side) if dot(side, side) > 1e-6 else perpendicular(axis)
        up = norm(cross(side, axis))
        mid = add(base, mul(axis, length * 0.42))
        tip = add(base, mul(axis, length))
        left = add(mid, mul(side, width * 0.5))
        right = add(mid, mul(side, -width * 0.5))
        # Gentle cup: the centre ridge rises, so the card reads as curved.
        top = add(add(base, mul(axis, length * 0.45)), mul(up, thickness * 0.5 + length * 0.04))
        bottom = add(add(base, mul(axis, length * 0.45)), mul(up, -thickness * 0.5 + length * 0.04))
        v = [self.vertex(p) for p in (base, left, tip, right, top, bottom)]
        b, l, t, r, hi, lo = v
        for a, c in ((b, l), (l, t), (t, r), (r, b)):
            self.face((a, c, hi))
            self.face((c, a, lo))

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
        for a, b in zip(rings, rings[1:]):
            for j in range(segments):
                k = (j + 1) % segments
                self.face((a[j], a[k], b[k], b[j]))
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
        trunk_length = height * rng.uniform(0.42, 0.5)
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
    tip = species in ("pine", "birch")

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
            count = rng.randint(4, 6)
        start_t = spec["crown"] if level == 1 else 0.25
        sides = {1: 7, 2: 5, 3: 4}[level]
        steps = {1: 5, 2: 4, 3: 3}[level]
        for n in range(count):
            t = start_t + (1 - start_t) * ((n + rng.uniform(0.15, 0.85)) / count)
            if species == "oak" and level == 1:
                t = 1.0 - rng.uniform(0.0, 0.12)
            index = min(len(points) - 2, int(t * (len(points) - 1)))
            frac = t * (len(points) - 1) - index
            origin = add(points[index], mul(sub(points[index + 1], points[index]), frac))
            parent_dir = norm(sub(points[index + 1], points[index]))
            parent_radius = radii[index] * (1 - frac) + radii[index + 1] * frac
            yaw = (n * 2.39996 + rng.uniform(-0.4, 0.4)) if level == 1 else rng.uniform(0, 2 * math.pi)
            low, high = spec["pitch"]
            pitch = math.radians(rng.uniform(low, high))
            if level == 1:
                heading = direction(yaw, pitch)
            else:
                side = perpendicular(parent_dir)
                side = rotate(side, parent_dir, yaw)
                heading = norm(add(mul(parent_dir, 0.6), mul(side, 0.8)))
                if species == "pine":
                    heading = norm(add(heading, (0, 0, -0.15)))
            if species == "pine" and level == 1:
                length = height * spec["spread"] * (1 - t) ** 0.9 * rng.uniform(0.8, 1.1) + height * 0.04
            elif level == 1:
                length = height * spec["spread"] * rng.uniform(0.38, 0.55) * scale
            else:
                length = sum(math.dist(a, b) for a, b in zip(points, points[1:])) * rng.uniform(0.35, 0.6)
            radius = max(TUBE_MIN_RADIUS * 1.5, min(parent_radius * 0.72, parent_radius * (0.55 if level == 1 else 0.6)))
            if species == "oak" and level == 1:
                radius = parent_radius * rng.uniform(0.5, 0.68)
            gravity = 0.06 if species in ("pine", "birch") else 0.02
            spine = spine_points(origin, heading, length, steps, rng, 0.12, gravity * (1 if level < 3 else 2))
            child_radii = [radius * (1 - 0.85 * (i / steps)) for i in range(steps + 1)]
            cost = tube_triangles(sides, len(spine), True)
            if not budget.take(cost):
                return children
            bark.tube(spine, child_radii, sides, tip=True)
            children.append((spine, child_radii, level + 1))
            for i in range(1, len(spine)):
                if i / len(spine) >= (0.25 if species == "pine" else 0.4):
                    anchors.append((spine[i], norm(sub(spine[i], spine[i - 1])), 1.0))
        return children

    if species == "palm":
        # Crown of arching fronds: spine with leaflet pairs, no woody branches.
        crown = trunk[-1]
        fronds = 10 + int(density * 6)
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
                anchors.append((spine[i], norm(sub(spine[i], spine[i - 1])), 1.0 - 0.6 * (i / len(spine))))
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
        for i in range(int(len(trunk) * spec["crown"]), len(trunk)):
            anchors.append((trunk[i], (0, 0, 1), 0.8))

    # Leaves fill the remaining budget, scaled by density.
    remaining = max(0, budget_total - budget.used)
    capacity = remaining // leaf_triangles()
    wanted = int(capacity * (0.35 + 0.65 * density))
    if not anchors or wanted <= 0:
        raise ValueError("Tree has no foliage anchors within budget")
    leaf_length, leaf_width = spec["leaf"]
    # Cards stand for leaf clusters: grow with the tree so the crown reads full within budget.
    leaf_length *= max(0.8, min(3.0, height / 5.0))
    leaf_width *= max(0.8, min(3.0, height / 5.0))
    for n in range(wanted):
        position, along, scale = anchors[rng.randrange(len(anchors))]
        if species == "palm":
            side = norm(cross(along, (0, 0, 1)))
            sign = 1 if n % 2 else -1
            axis = norm(add(mul(side, sign), add(mul(along, 0.35), (0, 0, -0.25))))
            base = add(position, mul(along, rng.uniform(-0.15, 0.15) * leaf_length))
            leaves.leaf(base, axis, (0, 0, 1), leaf_length * scale * rng.uniform(0.75, 1.1), leaf_width, leaf_width * 0.12)
            continue
        jitter = (rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.6, 1))
        spread = leaf_length * (0.35 if species == "pine" else 1.6)
        base = add(position, mul(norm(jitter), spread * rng.random() ** 0.5))
        if species == "pine":
            # Needle sprays: flat, near-horizontal cards fanned out along the bough.
            flat = norm((along[0], along[1], 0.0)) if abs(along[0]) + abs(along[1]) > 1e-3 else (1.0, 0.0, 0.0)
            axis = norm(add(rotate(flat, (0.0, 0.0, 1.0), rng.uniform(-1.1, 1.1)), (0.0, 0.0, rng.uniform(-0.25, 0.08))))
            face = norm((rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), 1))
        else:
            axis = norm(add(mul(along, 0.4), (rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.7, 0.5))))
            face = norm((rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), 1))
        size = rng.uniform(0.75, 1.2) * scale
        leaves.leaf(base, axis, face, leaf_length * size, leaf_width * size, max(0.004, leaf_width * 0.06))
    return bark, leaves


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
        rock.face(f)
    return rock


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


# ----------------------------------------------------------- dispatcher ------
def plan(request):
    """Return [(source_key, material_key, MeshData, smooth)] for the validated request."""
    params = request["procedural"]
    kind, seed = params["kind"], request["seed"]
    budget = min(request["triangleBudget"], HARD_TRIANGLE_LIMIT)
    if kind not in GENERATORS:
        raise ValueError("Unknown procedural generator")
    if kind == "tree":
        bark, leaves = plan_tree(params, seed, budget)
        parts = [("bark", "primary", bark), ("leaves", "secondary", leaves)]
    elif kind == "rock":
        parts = [("rock", "primary", plan_rock(params, seed, budget))]
    elif kind == "column":
        parts = [("stone", "primary", plan_column(params, seed, budget))]
    else:
        parts = [("foliage", "primary", plan_foliage(params, seed, budget))]
    total = sum(p[2].triangles() for p in parts)
    if total > budget or any(not p[2].faces for p in parts):
        raise ValueError("Procedural mesh exceeded its triangle budget or is empty")
    # Floor pivot: the lowest vertex of the whole asset rests exactly on z = 0.
    floor = min(v[2] for p in parts for v in p[2].vertices)
    for p in parts:
        p[2].vertices = [(x, y, z - floor) for x, y, z in p[2].vertices]
    return parts


MATERIALS = {
    # kind/part -> (metallic, roughness)
    "bark": (0.0, 0.92), "leaves": (0.0, 0.62), "rock": (0.0, 0.88), "stone": (0.0, 0.55), "foliage": (0.0, 0.6),
}


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
        mat = make_material("MAT_" + key.capitalize(), colors[color_key], metallic, roughness)
        mesh = bpy.data.meshes.new("SM_" + request["name"] + "_" + key + "_Mesh")
        mesh.from_pydata(data.vertices, [], data.faces)
        if mesh.validate(verbose=False):
            raise ValueError("Procedural mesh required structural repair")
        for polygon, smooth in zip(mesh.polygons, data.smooth):
            polygon.use_smooth = smooth
        bm = bmesh.new()
        try:
            bm.from_mesh(mesh)
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            bm.to_mesh(mesh)
        finally:
            bm.free()
        obj = bpy.data.objects.new("SM_" + request["name"] + "_" + key, mesh)
        group.objects.link(obj)
        obj["arcane_role"] = "render"
        obj["arcane_source_key"] = key
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
