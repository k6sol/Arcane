"""Synthetic generator contract tests: pure-Python planning only, no bpy import/process.

Loads workers/blender/procedural.py by path (its Blender-only build() imports bpy
lazily) and checks every generator's closed manifold topology, triangle budget,
determinism and duplicate-vertex rule that the Blender audit enforces later.
This is not Blender export, render or Studio acceptance evidence.
"""
import ast
import collections
import importlib.util
import math
import random
import sys
import unittest
from unittest.mock import patch
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "workers" / "blender" / "procedural.py"
import worker_paths  # noqa: E402,F401  (job layout: every workers/blender subpackage importable flat)
spec = importlib.util.spec_from_file_location("arcane_procedural_under_test", SOURCE)
procedural = importlib.util.module_from_spec(spec)
spec.loader.exec_module(procedural)


def tree(species, height=9.0, levels=2, density=0.7):
    return {"kind": "tree", "species": species, "height": height, "trunkTaper": 0.55, "branchLevels": levels,
            "leafDensity": density, "trunkRadius": None, "secondaryColor": [0.1, 0.3, 0.1]}


def natural(species, height=9.0, levels=3, density=0.7):
    return {**tree(species, height, levels, density), "finish": "natural"}


SKELETONS = {}


def skeleton(species, seed, height=9.0, levels=3):
    # Pure and deterministic, so each grown skeleton is shared by the read-only checks below.
    key = (species, seed, height, levels)
    if key not in SKELETONS:
        SKELETONS[key] = procedural.broadleaf_skeleton(natural(species, height, levels), random.Random(seed))
    return SKELETONS[key]


SEEDS = (7, 31, 101, 102, 103, 104, 105, 106, 201, 202, 203)


def canopy_coverage(mesh, keep=0, cells=72, rows=False):
    """Silhouette coverage proxy: share of grid cells inside the projected convex hull of the
    foliage that its triangles cover, in an orthographic side view keeping axis ``keep`` and z."""
    pts = [(v[keep], v[2]) for v in mesh.vertices]
    ordered = sorted(set(pts))

    def turn(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for q in ordered:
        while len(lower) >= 2 and turn(lower[-2], lower[-1], q) <= 0:
            lower.pop()
        lower.append(q)
    for q in reversed(ordered):
        while len(upper) >= 2 and turn(upper[-2], upper[-1], q) <= 0:
            upper.pop()
        upper.append(q)
    hull = lower[:-1] + upper[:-1]
    lo = [min(q[k] for q in pts) for k in (0, 1)]
    step = max(max(q[k] for q in pts) - lo[k] for k in (0, 1)) / cells
    covered = set()
    for face in mesh.faces:
        for i in range(1, len(face) - 1):
            tri = [pts[face[0]], pts[face[i]], pts[face[i + 1]]]
            area = turn(*tri)
            if abs(area) < 1e-12:
                continue
            x0, x1 = (int((min(q[0] for q in tri) - lo[0]) / step), int((max(q[0] for q in tri) - lo[0]) / step))
            y0, y1 = (int((min(q[1] for q in tri) - lo[1]) / step), int((max(q[1] for q in tri) - lo[1]) / step))
            for gx in range(x0, x1 + 1):
                for gy in range(y0, y1 + 1):
                    c = (lo[0] + (gx + .5) * step, lo[1] + (gy + .5) * step)
                    w = [turn(tri[0], tri[1], c), turn(tri[1], tri[2], c), turn(tri[2], tri[0], c)]
                    if all(x >= 0 for x in w) or all(x <= 0 for x in w):
                        covered.add((gx, gy))
    if rows:
        # Scanline variant: the span between the outermost covered cells of each row.
        spans = collections.defaultdict(list)
        for gx, gy in covered:
            spans[gy].append(gx)
        return len(covered) / max(1, sum(max(xs) - min(xs) + 1 for xs in spans.values()))
    inside = 0
    for gx in range(cells + 1):
        for gy in range(cells + 1):
            c = (lo[0] + (gx + .5) * step, lo[1] + (gy + .5) * step)
            if all(turn(a, b, c) >= 0 for a, b in zip(hull, hull[1:] + hull[:1])):
                inside += 1
    return len(covered) / max(1, inside)


CASES = [tree(s, h, lv) for s in ("pine", "oak", "birch", "palm") for h, lv in ((2.0, 1), (9.0, 2), (20.0, 3))] + [
    {"kind": "rock", "size": [2.0, 1.5, 1.2], "roughness": r} for r in (0.0, 0.5, 1.0)] + [
    {"kind": "column", "radius": 0.4, "height": 5.0, "flutes": f, "base": b, "capital": c}
    for f in (0, 8, 32) for b in ("none", "plinth", "attic") for c in ("none", "doric", "ionic", "corinthian")] + [
    {"kind": "foliage", "style": s, "radius": 0.8, "height": 0.9, "density": d} for s in ("bush", "grass", "fern") for d in (0.0, 1.0)] + [
    natural(s, h, lv, d) for s in ("oak", "birch", "pine") for h, lv, d in ((2.0, 1, .5), (9.0, 2, .7), (9.0, 3, 0.0), (20.0, 3, 1.0))] + [
    {"kind": "log", "species": s, "length": L, "radius": r, "ends": e, "moss": m} for s in ("oak", "birch") for L, r in ((.5, .05), (3.0, .25), (12.0, 1.2))
    for e, m in (("cut", False), ("broken", True), ("mixed", False))] + [
    {"kind": "stump", "species": s, "radius": r, "height": h, "top": t, "moss": m} for s in ("oak", "birch") for r, h in ((.05, .1), (.35, .5), (1.5, 2.5))
    for t, m in (("cut", True), ("broken", False))] + [
    {"kind": "rock", "size": size, "roughness": r, "form": f, "moss": m, "finish": "natural"} for f, size in (("boulder", [1.8, 1.4, 1.1]), ("outcrop", [6.0, 2.6, 4.2]), ("cave", [6.5, 3.2, 4.6]),
                                                                                              ("boulder", [.1, .1, .1]), ("cave", [12.0, .1, 12.0]))
    for r, m in ((0.0, False), (1.0, True))]


def request(params, budget=20000, seed=7):
    return {"procedural": params, "seed": seed, "triangleBudget": budget, "name": "fixture", "color": [0.3, 0.2, 0.1]}


# Natural broadleaf (bark, leaves) triangle counts at 16000, seed 7, height 9, three levels.
BASELINE = {("oak", 0.7): (9514, 3864), ("oak", 0.0): (10934,), ("birch", 0.7): (9952, 3528), ("birch", 0.0): (12362,)}


class GeneratorContract(unittest.TestCase):
    def test_every_generator_is_closed_manifold_within_budget(self):
        for params in CASES:
            for budget in (20000, 12000):
                with self.subTest(params=params, budget=budget):
                    parts = procedural.plan(request(params, budget))
                    self.assertLessEqual(sum(data.triangles() for _, _, data in parts), budget)
                    for key, _, data in parts:
                        self.assertTrue(data.faces, key)
                        undirected, directed = collections.Counter(), collections.Counter()
                        for face in data.faces:
                            self.assertGreaterEqual(len(face), 3)
                            for a, b in zip(face, face[1:] + face[:1]):
                                undirected[(min(a, b), max(a, b))] += 1
                                directed[(a, b)] += 1
                        self.assertTrue(all(count == 2 for count in undirected.values()), key + " has open or non-manifold edges")
                        self.assertTrue(all(count == 1 for count in directed.values()), key + " has inconsistent winding")
                        rounded = {tuple(round(c, 6) for c in v) for v in data.vertices}
                        self.assertEqual(len(rounded), len(data.vertices), key + " has duplicate vertices")
                        self.assertGreaterEqual(min(v[2] for v in data.vertices), -1e-6, key + " dips below the floor pivot")

    def test_tree_parts_are_joined_per_material_and_deterministic(self):
        first = procedural.plan(request(tree("oak")))
        again = procedural.plan(request(tree("oak")))
        other = procedural.plan(request(tree("oak"), seed=8))
        self.assertEqual([key for key, _, _ in first], ["bark", "leaves"])
        self.assertEqual([d.vertices for _, _, d in first], [d.vertices for _, _, d in again])
        self.assertNotEqual([d.vertices for _, _, d in first], [d.vertices for _, _, d in other])

    def test_natural_broadleaf_is_deterministic_with_baselined_counts(self):
        # Re-baseline deliberately when the natural wood anatomy changes.
        expected = BASELINE
        for (species, density), counts in expected.items():
            with self.subTest(species=species, density=density):
                first = procedural.plan(request(natural(species, density=density), 16000))
                again = procedural.plan(request(natural(species, density=density), 16000))
                self.assertEqual([(d.vertices, d.faces, d.uvs) for _, _, d in first], [(d.vertices, d.faces, d.uvs) for _, _, d in again])
                self.assertEqual(tuple(d.triangles() for _, _, d in first), counts)
                bark = first[0][2]
                self.assertEqual(bark.wood["triangleLimit"], math.floor(bark.triangles() * procedural.UNION_RESERVE))
                self.assertLessEqual(bark.wood["triangleLimit"] + sum(d.triangles() for _, _, d in first[1:]), 16000)
                self.assertLess(bark.wood["trunkFaces"], len(bark.faces))

    def test_legacy_trees_keep_the_tube_planner(self):
        for species in ("oak", "birch"):
            for finish in (None, "flat"):
                params = tree(species, levels=3)
                if finish:
                    params["finish"] = finish
                self.assertIsNone(procedural.plan(request(params, 16000))[0][2].wood)

    def test_natural_wood_axes_never_start_below_one_centimetre(self):
        for species in ("oak", "birch"):
            for seed in SEEDS:
                for height in (2.0, 9.0, 20.0) if seed in SEEDS[:3] else (9.0,):
                    with self.subTest(species=species, seed=seed, height=height):
                        axes, anchors, scale = skeleton(species, seed, height)
                        wood = [a for a in axes if a["kept"]]
                        self.assertTrue(wood and wood[0]["order"] == 0)
                        self.assertGreaterEqual(min(2 * a["radii"][0] * scale for a in wood), procedural.PRUNE_DIAMETER - 1e-9)
                        self.assertTrue(any(order >= 4 for _, order, _ in anchors), "pruned twigs survive only as foliage anchors")
                        for a in wood[1:]:
                            parent = axes[a["parent"]]
                            self.assertTrue(parent["kept"])
                            self.assertLessEqual(a["attach"], parent["woodCount"] - 3)
                            self.assertLessEqual(a["radii"][0], .8 * parent["radii"][a["attach"]] + 1e-12)

    def test_natural_wood_radius_is_continuous_away_from_the_tip(self):
        for species in ("oak", "birch"):
            for seed in SEEDS:
                with self.subTest(species=species, seed=seed):
                    axes, _, _ = skeleton(species, seed)
                    worst = 0.0
                    for a in (a for a in axes if a["kept"]):
                        points, radii = a["points"][:a["woodCount"]], a["radii"][:a["woodCount"]]
                        cum = [0.0]
                        for p, q in zip(points, points[1:]):
                            cum.append(cum[-1] + math.dist(p, q))
                        for i in range(1, len(radii)):
                            self.assertLessEqual(radii[i], radii[i - 1] + 1e-12, "monotone along each axis")
                            if cum[i] < cum[-1] * (1 - procedural.TIP_TAPER):
                                worst = max(worst, (radii[i - 1] - radii[i]) / radii[i - 1])
                    self.assertLess(worst, .25)

    def test_natural_tips_ease_to_the_prune_diameter(self):
        for seed in SEEDS:
            axes, _, scale = skeleton("oak", seed)
            for a in (a for a in axes if a["kept"]):
                with self.subTest(seed=seed, axis=a["id"]):
                    self.assertLessEqual(2 * a["radii"][a["woodCount"] - 1] * scale, procedural.PRUNE_DIAMETER * 1.05)

    def test_natural_scaffolds_are_separated_in_azimuth_and_space(self):
        for species in ("oak", "birch"):
            for seed in SEEDS:
                with self.subTest(species=species, seed=seed):
                    axes, _, _ = skeleton(species, seed)
                    scaffolds = [a for a in axes if a["order"] == 1]
                    self.assertGreaterEqual(len(scaffolds), 4)
                    skip = int(1.0 / procedural.V5_STEP)
                    for i, a in enumerate(scaffolds):
                        for b in scaffolds[i + 1:]:
                            if abs(a["points"][0][2] - b["points"][0][2]) < 1.3:
                                da, db = a["departure"], b["departure"]
                                turn = abs(math.atan2(da[1], da[0]) - math.atan2(db[1], db[0])) % (2 * math.pi)
                                self.assertGreaterEqual(math.degrees(min(turn, 2 * math.pi - turn)), 70.0)
                            gap = min(math.dist(p, q) for p in a["points"][skip:] for q in b["points"][skip:])
                            self.assertGreater(gap, .9)

    def test_natural_departures_are_shallow(self):
        for species in ("oak", "birch"):
            for seed in SEEDS:
                with self.subTest(species=species, seed=seed):
                    axes, _, _ = skeleton(species, seed)
                    for a in (a for a in axes if a["kept"] and a["parent"] is not None):
                        t = procedural.polyline_tangent(axes[a["parent"]]["points"], a["attach"])
                        d = procedural.norm(procedural.sub(a["points"][1], a["points"][0]))
                        self.assertLessEqual(math.degrees(math.acos(max(-1.0, min(1.0, procedural.dot(t, d))))), 50.0)

    def test_natural_oak_base_flare_ratio(self):
        gain = sum(procedural.flare_gain(2 * math.pi * k / 720, 0.0, procedural.BROADLEAF["oak"]["flare"]) for k in range(720)) / 720
        for seed in SEEDS:
            with self.subTest(seed=seed):
                trunk = skeleton("oak", seed)[0][0]
                breast = trunk["radii"][int(round(1.3 / procedural.V5_STEP))]
                self.assertTrue(1.5 <= trunk["radii"][0] * (1 + gain) / breast <= 2.2)

    def test_zero_density_emits_only_nonempty_closed_wood_for_every_tree_species(self):
        for species, finish in [(s, None) for s in ("pine", "oak", "birch", "palm")] + [("oak", "natural"), ("birch", "natural"), ("pine", "natural")]:
            with self.subTest(species=species, finish=finish):
                params = tree(species, density=0.0)
                if finish:
                    params["finish"] = finish
                parts = procedural.plan(request(params, 16000))
                self.assertEqual([key for key, _, _ in parts], ["bark"])
                mesh = parts[0][2]
                self.assertTrue(mesh.faces)
                edges = collections.Counter(tuple(sorted((a, b))) for face in mesh.faces
                                            for a, b in zip(face, face[1:] + face[:1]))
                self.assertTrue(all(count == 2 for count in edges.values()))
                self.assertGreater(mesh.triangles(), 0)
                self.assertLessEqual(mesh.triangles(), 16000)
                params["finish"] = "natural"
                self.assertEqual([m["id"] for m in procedural.surface_materials(request(params))], ["Bark"])
                self.assertEqual(mesh.wood is not None, finish == "natural")

    def test_natural_canopy_fills_the_crown_silhouette_at_default_density(self):
        # Scanline proxy in front and side orthographic views: share of each row's crown span covered by
        # card geometry. Cards are cutouts (the atlas leaves cover about a third of each), so the cards
        # themselves must span most of the crown without becoming one solid hull. Every spray is rooted on a
        # twig, so the crown reads as clumpy lobes with some sky between them where no twig grows.
        for species, seeds, low, high in (("oak", (101, 102, 103, 104, 105, 106), .76, .95), ("birch", (201, 202, 203), .78, .95)):
            for seed in seeds:
                leaves = procedural.plan(request(natural(species), 16000, seed))[1][2]
                for keep in (0, 1):
                    with self.subTest(species=species, seed=seed, view=keep):
                        self.assertTrue(low <= canopy_coverage(leaves, keep, rows=True) <= high)
                        self.assertGreater(canopy_coverage(leaves, keep), low - .15)

    def test_natural_canopy_coverage_rises_with_density(self):
        for species, seed in (("oak", 102), ("birch", 202)):
            with self.subTest(species=species):
                parts = [procedural.plan(request(natural(species, density=d), 16000, seed)) for d in (0.0, .3, .7, 1.0)]
                self.assertEqual([key for key, _, _ in parts[0]], ["bark"])
                covered = [canopy_coverage(p[1][2], 0, rows=True) for p in parts[1:]]
                self.assertLess(covered[0], covered[1])
                self.assertLess(covered[1], covered[2])
                # Any positive density keeps the same wood.
                self.assertEqual(len({tuple(p[0][2].vertices) for p in parts[1:]}), 1)

    def test_natural_canopy_is_deterministic_with_soft_unit_normals(self):
        first = procedural.plan(request(natural("oak"), 16000, 104))
        again = procedural.plan(request(natural("oak"), 16000, 104))
        other = procedural.plan(request(natural("oak"), 16000, 105))
        leaves = first[1][2]
        self.assertEqual((leaves.vertices, leaves.faces, leaves.uvs, leaves.normals), (again[1][2].vertices, again[1][2].faces, again[1][2].uvs, again[1][2].normals))
        self.assertNotEqual(leaves.vertices, other[1][2].vertices)
        self.assertEqual(len(leaves.normals), len(leaves.vertices))
        self.assertTrue(all(abs(math.sqrt(procedural.dot(n, n)) - 1) < 1e-9 for n in leaves.normals))
        self.assertIsNone(first[0][2].normals)
        for species in ("oak", "birch", "pine", "palm"):
            self.assertIsNone(procedural.plan(request(tree(species), 16000))[1][2].normals, "legacy leaves keep their shading")

    def test_natural_canopy_cards_map_whole_atlas_tiles_within_budget(self):
        tiles = [procedural.atlas_rect(c, r) for r in range(procedural.ATLAS_ROWS) for c in range(procedural.ATLAS_COLS)]
        for species in ("oak", "birch"):
            for height, budget in ((2.0, 4000), (9.0, 16000), (20.0, 20000)):
                with self.subTest(species=species, height=height, budget=budget):
                    parts = procedural.plan(request(natural(species, height, density=1.0), budget, 31))
                    bark, leaves = parts[0][2], parts[1][2]
                    self.assertLessEqual(bark.wood["triangleLimit"] + leaves.triangles(), budget)
                    self.assertTrue(all(data.triangles() <= procedural.HARD_TRIANGLE_LIMIT for _, _, data in parts))
                    self.assertEqual(leaves.triangles() % procedural.leaf_triangles(), 0)
                    self.assertLessEqual(leaves.triangles() // procedural.leaf_triangles(), procedural.CANOPY[species]["cards"])
                    # Every card is one closed lens over exactly one atlas tile: 12 faces sharing a tile.
                    for first in range(0, len(leaves.uvs), 12):
                        points = [pt for uv in leaves.uvs[first:first + 12] for pt in uv]
                        inside = [t for t in tiles if all(t[0] - 1e-9 <= u <= t[2] + 1e-9 and t[1] - 1e-9 <= v <= t[3] + 1e-9 for u, v in points)]
                        self.assertEqual(len(inside), 1)
                        self.assertAlmostEqual(min(u for u, _ in points), inside[0][0])
                        self.assertAlmostEqual(max(v for _, v in points), inside[0][3])
        # Deep and inner clusters use the shade row, the rest the sunlit row.
        rows = collections.Counter(int(uv[0][1] * procedural.ATLAS_ROWS) for uv in procedural.plan(request(natural("oak"), 16000, 102))[1][2].uvs[::12])
        self.assertGreater(rows[0], sum(rows.values()) * .2)
        self.assertGreater(rows[1], sum(rows.values()) * .1)

    def test_natural_canopy_uses_fewer_larger_cards_than_the_budget_allows(self):
        for species, seed in (("oak", 103), ("birch", 202)):
            with self.subTest(species=species):
                parts = procedural.plan(request(natural(species, density=1.0), 16000, seed))
                bark, leaves = parts[0][2], parts[1][2]
                cards = leaves.triangles() // procedural.leaf_triangles()
                self.assertEqual(cards, procedural.CANOPY[species]["cards"])
                self.assertLess(cards, (16000 - bark.wood["triangleLimit"]) // procedural.leaf_triangles())
                # Cards are curved: the twig line of each card is bent, never one flat plane.
                card = leaves.vertices[:8]
                normal = procedural.norm(procedural.cross(procedural.sub(card[2], card[0]), procedural.sub(card[5], card[0])))
                self.assertGreater(abs(procedural.dot(procedural.sub(card[1], card[0]), normal)), 1e-4)

    def test_natural_wood_cap_uv_winding_preserves_geometry_and_other_authored_uvs(self):
        def signed(points):
            return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1])) / 2

        original_face = procedural.MeshData.face
        mirrored_controls, positive_controls = 0, 0
        directions = ((0, 0, 1), (0, 0, -1), (1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (1, 2, 3))
        for direction in directions:
            along = procedural.norm(direction)
            spine = [procedural.mul(along, distance) for distance in (0.0, .5, 1.0)]
            for sides in (8, 24):
                with self.subTest(direction=direction, sides=sides):
                    natural, legacy = procedural.MeshData(), procedural.MeshData()
                    authored = []

                    def observe_face(mesh, *args, **kwargs):
                        result = original_face(mesh, *args, **kwargs)
                        if mesh is natural:
                            authored.append(mesh.uvs[-1])
                        return result

                    options = {"spine": spine, "radii": [.3, .19, .075], "sides": sides, "blunt": True}
                    with patch.object(procedural.MeshData, "face", observe_face):
                        natural.tube(**options, wood_uv={"around": 1, "period": 1.0})
                    legacy.tube(**options)
                    self.assertEqual((natural.vertices, natural.faces, natural.smooth), (legacy.vertices, legacy.faces, legacy.smooth))
                    cap = (len(spine) - 1) * sides
                    self.assertEqual(authored[cap], legacy.uvs[cap], "General face projection remains unchanged")
                    self.assertGreater(signed(natural.uvs[cap]), 0)
                    for index in range(1, sides - 1):
                        triangle = (natural.uvs[cap][0], natural.uvs[cap][index], natural.uvs[cap][index + 1])
                        self.assertGreater(signed(triangle), 0, "Every convex cap triangle must keep positive UV winding")
                    for index, uv in enumerate(natural.uvs):
                        self.assertTrue(all(0 <= coordinate <= 1 for point in uv for coordinate in point))
                        if index != cap:
                            self.assertEqual(uv, authored[index], "Side/apex UVs retain their original authored values")
                    if signed(authored[cap]) < 0:
                        mirrored_controls += 1
                        self.assertLess(signed(legacy.uvs[cap]), 0)
                        self.assertNotEqual(natural.uvs[cap], authored[cap])
                    else:
                        positive_controls += 1
                        self.assertEqual(natural.uvs[cap], authored[cap])
        self.assertGreater(mirrored_controls, 0, "The original negative cap is a real regression control")
        self.assertGreater(positive_controls, 0, "Already positive projections must remain untouched")

    def test_natural_bark_tile_repeats_along_branches_inside_uv0(self):
        for species in ("oak", "birch"):
            bark = procedural.plan(request(natural(species, density=0.0), 16000, 103))[0][2]
            with self.subTest(species=species):
                points = [pt for uv in bark.uvs for pt in uv]
                self.assertTrue(all(-1e-9 <= c <= 1 + 1e-9 for pt in points for c in pt))
                areas = [abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(uv, uv[1:] + uv[:1]))) for uv in bark.uvs]
                self.assertGreater(min(areas), 1e-12)
        # One synthetic tube: repeats land on stations, the texture coordinate is continuous across
        # faces modulo the tile, and the tile repeats a divisor-of-sides number of times around.
        spine = [(0.0, 0.0, z) for z in (0.0, .3, .7, 1.2, 1.5, 2.1, 2.6, 3.0)]
        uv = procedural.wood_tile_uvs([p[2] for p in spine] + [3.1], 8, {"around": 2, "period": 1.0})
        for index in range(len(spine) - 1):
            for j in range(8):
                face = uv(index, j)
                self.assertTrue(all(0 <= c <= 1 for pt in face for c in pt))
                if index:
                    # The ring shared with the face below: the same tile coordinate, or one repeat on.
                    step = uv(index - 1, j)[2][1] - face[0][1]
                    self.assertTrue(min(abs(step), abs(step - 1)) < 1e-9)
                if j:
                    step = uv(index, j - 1)[1][0] - face[0][0]
                    self.assertTrue(min(abs(step), abs(step - 1)) < 1e-9)
        with self.assertRaises(ValueError):
            procedural.wood_tile_uvs([0.0, 1.0, 1.1], 5, {"around": 2, "period": 1.0})
        # Birch trunk: whole repeats change strip, in trunk order base -> fall -> patched -> rise -> clean, the
        # same all round the trunk, so the grading strips (not a hard band edge) carry every change.
        order = ("base", "fall", "patched", "rise", "clean")
        for seed in (201, 202, 203):
            birch = procedural.plan(request(natural("birch", density=0.0), 16000, seed))[0][2]
            sides, trunk = birch.wood["preset"][0], birch.wood["trunkFaces"]
            quads = [k for k in range(trunk) if len(birch.uvs[k]) == 4]
            self.assertEqual(quads, list(range(len(quads))))

            def strip(uv):
                v = min(c for _, c in uv)
                return next(n for n in order if procedural.BIRCH_STRIPS[n][0] - 1e-9 <= v <= sum(procedural.BIRCH_STRIPS[n]) + 1e-9)
            rings = [{strip(birch.uvs[k]) for k in quads[r * sides:(r + 1) * sides]} for r in range(len(quads) // sides)]
            self.assertTrue(all(len(names) == 1 for names in rings), "strips never vary round the trunk")
            ranks = [order.index(next(iter(names))) for names in rings]
            self.assertIn(ranks[0], (0, 1))
            self.assertEqual(ranks[-1], 4)
            # Allowed changes meet on matching content (fall and rise both end on patched bark).
            allowed = {(0, 1), (1, 2), (1, 3), (2, 3), (3, 4)} | {(k, k) for k in range(5)}
            self.assertTrue(all(pair in allowed for pair in zip(ranks, ranks[1:])), ranks)
            self.assertIn(1, ranks)
            self.assertIn(3, ranks)

    def test_natural_spray_cards_are_rooted_on_twigs(self):
        # Every leaf-spray card starts on a twig chain or wood axis (no free-floating sprays at the crown edge).
        for species, seed, density in (("oak", 106, 1.0), ("oak", 103, .7), ("birch", 201, .7)):
            with self.subTest(species=species, seed=seed):
                params = natural(species, density=density)
                leaves = procedural.plan_broadleaf(params, seed, 16000)[1]
                axes, _, scale = procedural.broadleaf_skeleton(params, random.Random(seed))
                grid = collections.defaultdict(list)
                for a in axes:
                    for q in a["points"]:
                        p = procedural.mul(q, scale)
                        grid[tuple(math.floor(c / .25) for c in p)].append(p)
                for first in range(0, len(leaves.vertices), 8):
                    card = leaves.vertices[first:first + 8]
                    base = procedural.mul(procedural.add(card[0], card[5]), .5)
                    key = tuple(math.floor(c / .25) for c in base)
                    near = min((math.dist(base, p) for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)
                                for p in grid.get((key[0] + dx, key[1] + dy, key[2] + dz), ())), default=math.inf)
                    self.assertLess(near, .12)

    def test_natural_pine_is_bounded_deterministic_and_maps_whole_needle_tiles(self):
        tiles = [procedural.atlas_rect(c, r) for r in range(procedural.ATLAS_ROWS) for c in range(procedural.ATLAS_COLS)]
        for height, budget in ((2.0, 4000), (9.0, 12000), (9.0, 16000), (20.0, 20000)):
            for seed in (7, 31):
                with self.subTest(height=height, budget=budget, seed=seed):
                    params = natural("pine", height, density=1.0)
                    parts = procedural.plan(request(params, budget, seed))
                    again = procedural.plan(request(params, budget, seed))
                    self.assertEqual([(d.vertices, d.faces, d.uvs, d.normals) for _, _, d in parts], [(d.vertices, d.faces, d.uvs, d.normals) for _, _, d in again])
                    self.assertNotEqual(parts[1][2].vertices, procedural.plan(request(params, budget, seed + 1))[1][2].vertices)
                    self.assertEqual([key for key, _, _ in parts], ["bark", "leaves"])
                    bark, leaves = parts[0][2], parts[1][2]
                    self.assertIsNotNone(bark.wood)
                    self.assertEqual(bark.wood["triangleLimit"], math.floor(bark.triangles() * procedural.UNION_RESERVE))
                    self.assertLessEqual(bark.wood["triangleLimit"] + leaves.triangles(), budget)
                    self.assertTrue(all(data.triangles() <= procedural.HARD_TRIANGLE_LIMIT for _, _, data in parts))
                    self.assertLessEqual(leaves.triangles() // procedural.leaf_triangles(), procedural.CANOPY["pine"]["cards"])
                    self.assertEqual(len(leaves.normals), len(leaves.vertices))
                    self.assertTrue(all(abs(math.sqrt(procedural.dot(n, n)) - 1) < 1e-9 for n in leaves.normals))
                    for first in range(0, len(leaves.uvs), 12):
                        points = [pt for uv in leaves.uvs[first:first + 12] for pt in uv]
                        inside = [t for t in tiles if all(t[0] - 1e-9 <= u <= t[2] + 1e-9 and t[1] - 1e-9 <= v <= t[3] + 1e-9 for u, v in points)]
                        self.assertEqual(len(inside), 1)
        # Inner, low sprays use the shade row, the rest the sunlit row.
        rows = collections.Counter(int(uv[0][1] * procedural.ATLAS_ROWS) for uv in procedural.plan(request(natural("pine"), 16000, 7))[1][2].uvs[::12])
        self.assertGreater(rows[0], sum(rows.values()) * .2)
        self.assertGreater(rows[1], sum(rows.values()) * .1)

    def test_natural_pine_density_keeps_the_wood_and_scales_needle_cards(self):
        bare = procedural.plan(request(natural("pine", density=0.0), 16000, 7))
        self.assertEqual([key for key, _, _ in bare], ["bark"])
        self.assertIsNotNone(bare[0][2].wood)
        parts = [procedural.plan(request(natural("pine", density=d), 16000, 7)) for d in (1e-8, .35, .7, 1.0)]
        self.assertEqual(len({tuple(p[0][2].vertices) for p in parts}), 1, "any positive density keeps the same wood")
        cards = [p[1][2].triangles() // procedural.leaf_triangles() for p in parts]
        self.assertEqual(cards[0], 1)
        self.assertEqual(cards[1:], [math.ceil(cards[-1] * d) for d in (.35, .7, 1.0)])
        # A density prefix: the sparser canopy is exactly the first cards of the denser one.
        sparse, dense = parts[1][1][2], parts[3][1][2]
        self.assertEqual(sparse.vertices, dense.vertices[:len(sparse.vertices)])
        covered = [canopy_coverage(p[1][2], 0, rows=True) for p in parts[1:]]
        self.assertLess(covered[0], covered[2])

    def test_natural_pine_anatomy(self):
        for seed in (7, 31, 101, 102, 103):
            with self.subTest(seed=seed):
                axes, _, scale = procedural.conifer_skeleton(natural("pine"), random.Random(seed))
                trunk = axes[0]
                self.assertTrue(trunk["kept"])
                # Straight monopodial trunk: continuous, monotone taper to the leader, a butt flare.
                radii = trunk["radii"][:trunk["woodCount"]]
                self.assertTrue(all(b <= a + 1e-12 for a, b in zip(radii, radii[1:])))
                body = radii[:int(len(radii) * (1 - procedural.TIP_TAPER))]
                self.assertLess(max((a - b) / a for a, b in zip(body, body[1:])), .1)
                self.assertGreater(radii[0], 1.1 * trunk["radii"][int(round(1.3 / procedural.V5_STEP))])
                top = trunk["points"][-1]
                self.assertLess(math.hypot(top[0], top[1]), .06 * top[2])
                # Whorls: several branches share each socket height.
                branches = [a for a in axes if a["kind"] == "branch"]
                whorls = collections.Counter(a["attach"] for a in branches)
                self.assertGreaterEqual(sum(n >= 3 for n in whorls.values()), 8)
                # Dead, bare stubs below the living crown: short, kept as dark wood, never needled.
                dead = [a for a in axes if a["kind"] == "dead"]
                self.assertTrue(dead)
                lowest_living = min(trunk["points"][a["attach"]][2] for a in branches)
                self.assertTrue(all(trunk["points"][a["attach"]][2] < lowest_living + .65 for a in dead))
                self.assertTrue(all(sum(math.dist(p, q) for p, q in zip(a["points"], a["points"][1:])) <= .5 + 1e-9 for a in dead))
                self.assertFalse(any(c["parent"] == a["id"] for a in dead for c in axes))
                # Branches droop with age: low whorls depart lower and reach further than the top ones.
                ordered = sorted(branches, key=lambda a: a["attach"])
                third = len(ordered) // 3
                low, high = ordered[:third], ordered[-third:]
                self.assertLess(sum(a["departure"][2] for a in low) / third, sum(a["departure"][2] for a in high) / third - .3)
                self.assertGreater(sum(len(a["points"]) for a in low), 1.5 * sum(len(a["points"]) for a in high))
                # Conical crown: the widest reach sits in the lower half of the living crown.
                reach = [(a["points"][0][2], max(math.hypot(p[0], p[1]) for p in a["points"])) for a in branches]
                widest = max(reach, key=lambda r: r[1])[0]
                self.assertLess(widest, (lowest_living + top[2]) / 2)

    def test_natural_pine_needle_cards_are_rooted_on_living_shoots(self):
        for seed, density in ((7, 1.0), (31, .7)):
            with self.subTest(seed=seed):
                params = natural("pine", density=density)
                leaves = procedural.plan_broadleaf(params, seed, 16000)[1]
                axes, _, scale = procedural.conifer_skeleton(params, random.Random(seed))
                living, dead = collections.defaultdict(list), []
                for a in axes:
                    for q in a["points"]:
                        p = procedural.mul(q, scale)
                        if a["kind"] == "dead":
                            dead.append(p)
                        else:
                            living[tuple(math.floor(c / .25) for c in p)].append(p)
                for first in range(0, len(leaves.vertices), 8):
                    card = leaves.vertices[first:first + 8]
                    base = procedural.mul(procedural.add(card[0], card[5]), .5)
                    key = tuple(math.floor(c / .25) for c in base)
                    near = min((math.dist(base, p) for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)
                                for p in living.get((key[0] + dx, key[1] + dy, key[2] + dz), ())), default=math.inf)
                    self.assertLess(near, .12)

    def test_natural_pine_bark_strips_grade_up_the_trunk(self):
        order = ("plated", "grade", "upper")
        for seed in (7, 31, 101):
            bark = procedural.plan(request(natural("pine", density=0.0), 16000, seed))[0][2]
            sides, trunk = bark.wood["preset"][0], bark.wood["trunkFaces"]
            quads = [k for k in range(trunk) if len(bark.uvs[k]) == 4]

            def strip(uv):
                v = min(c for _, c in uv)
                return next(n for n in order if procedural.PINE_STRIPS[n][0] - 1e-9 <= v <= sum(procedural.PINE_STRIPS[n]) + 1e-9)
            rings = [{strip(bark.uvs[k]) for k in quads[r * sides:(r + 1) * sides]} for r in range(len(quads) // sides)]
            self.assertTrue(all(len(names) == 1 for names in rings))
            ranks = [order.index(next(iter(names))) for names in rings]
            self.assertEqual(ranks[0], 0)
            self.assertEqual(ranks[-1], 2)
            self.assertEqual(ranks, sorted(ranks))
            self.assertIn(1, ranks)
            # Living limbs wear the thin upper bark.
            limbs = {strip(uv) for uv in bark.uvs[trunk:] if len(uv) == 4}
            self.assertIn("upper", limbs)

    def test_deadwood_logs_and_stumps_are_bounded_deterministic_bark(self):
        def log(**kw):
            return {"kind": "log", "species": "oak", "length": 3.0, "radius": .25, "ends": "mixed", "moss": False, **kw}

        def stump(**kw):
            return {"kind": "stump", "species": "birch", "radius": .35, "height": .5, "top": "cut", "moss": False, **kw}
        for params in (log(), log(ends="broken", moss=True), log(length=12.0, radius=1.2), stump(), stump(top="broken", moss=True), stump(radius=1.5, height=2.5)):
            with self.subTest(params=params):
                parts = procedural.plan(request(params, 20000, 5))
                self.assertEqual([(key, material) for key, material, _ in parts], [("bark", "primary")])
                mesh = parts[0][2]
                self.assertLessEqual(mesh.triangles(), procedural.DEADWOOD_TRIANGLES)
                self.assertEqual(mesh.vertices, procedural.plan(request(params, 20000, 5))[0][2].vertices)
                self.assertNotEqual(mesh.vertices, procedural.plan(request(params, 20000, 6))[0][2].vertices)
                band = procedural.LOG_BANDS["moss" if params["moss"] else "plain"]
                for uv in mesh.uvs:
                    vs = [v for _, v in uv]
                    self.assertTrue(all(0 <= c <= 1 for pt in uv for c in pt))
                    # Bark faces stay in the selected band; end caps map inside the end-grain disc row.
                    self.assertTrue(band[0] <= min(vs) and max(vs) <= band[0] + band[1] or min(vs) >= procedural.LOG_DISC_ROW)
                xs = [v[0] for v in mesh.vertices]
                if params["kind"] == "log":
                    self.assertGreater(max(xs) - min(xs), params["length"] * .98)
                    self.assertLess(max(xs) - min(xs), params["length"] + 1.2 * params["radius"] * (2 if params["ends"] != "cut" else .4))
                else:
                    top = max(v[2] for v in mesh.vertices)
                    self.assertGreaterEqual(top, params["height"] * .95)
                    if params["top"] == "broken":
                        self.assertGreater(top, params["height"] + .2 * params["radius"])
                    # Root flare: the foot is wider than the bole.
                    foot = [math.hypot(v[0], v[1]) for v in mesh.vertices if v[2] < .02]
                    self.assertGreater(max(foot), params["radius"] * 1.4)
        # A tight budget still fits; natural deadwood names its species log texture and packed repeats.
        self.assertLessEqual(procedural.plan(request(log(length=12.0, radius=1.2, ends="broken"), 2500))[0][2].triangles(), 2500)
        materials = procedural.surface_materials(request({**log(), "finish": "natural"}))
        self.assertEqual([(m["id"], m["pattern"], m["surface"], m["repeats"], m["moss"]) for m in materials], [("Bark", "oak-log", {"profile": "bark", "resolution": 512}, 3, False)])
        self.assertTrue(procedural.surface_materials(request({**stump(moss=True), "finish": "natural"}))[0]["moss"])
        # Natural deadwood maps its bark into the single LOG_BAND, LOG_CYCLES tile lengths per band repeat.
        for params in ({**log(moss=True), "finish": "natural"}, {**stump(), "finish": "natural"}):
            mesh = procedural.plan(request(params, 20000, 5))[0][2]
            band = procedural.LOG_BAND
            for uv in mesh.uvs:
                vs = [v for _, v in uv]
                self.assertTrue(band[0] <= min(vs) and max(vs) <= band[0] + band[1] or min(vs) >= procedural.LOG_DISC_ROW)
            self.assertNotEqual(mesh.uvs, procedural.plan(request({**params, "finish": "flat"}, 20000, 5))[0][2].uvs)
        self.assertEqual(procedural.surface_materials(request({**stump(), "finish": "flat"})), [])
        self.assertEqual([procedural.log_repeats(log(radius=r)) for r in (.05, 1.2)], [1, 8])

    def test_natural_surfaces_select_species_patterns_and_keep_other_finishes(self):
        for species in ("oak", "birch", "pine"):
            materials = procedural.surface_materials(request(natural(species)))
            self.assertEqual([(m["id"], m["pattern"], m["surface"]) for m in materials],
                             [("Bark", species + "-bark", {"profile": "bark", "resolution": 512}), ("Leaves", species + "-leaves", {"profile": "leaf", "resolution": 512})])
        for params in ({**tree("palm"), "finish": "natural"}, {"kind": "rock", "size": [2.0, 1.5, 1.2], "roughness": .5, "finish": "natural"}):
            self.assertTrue(all("pattern" not in m and m["surface"]["resolution"] == 256 for m in procedural.surface_materials(request(params))))

    def test_natural_rock_forms_are_bounded_deterministic_sized_and_uniquely_charted(self):
        def rock(form, size=(6.0, 2.6, 4.2), moss=True, **kw):
            return {"kind": "rock", "size": list(size), "roughness": .6, "form": form, "moss": moss, "finish": "natural", **kw}

        def components(mesh):
            parent = list(range(len(mesh.vertices)))

            def find(i):
                while parent[i] != i:
                    parent[i] = parent[parent[i]]
                    i = parent[i]
                return i
            for a, b, c in mesh.faces:
                parent[find(b)] = find(a)
                parent[find(c)] = find(a)
            return len({find(i) for i in range(len(parent))})
        for form in procedural.ROCK_FORMS:
            for budget in (2500, 6000, 20000):
                with self.subTest(form=form, budget=budget):
                    (key, _, mesh), = procedural.plan(request(rock(form), budget, 5))
                    self.assertEqual(key, "rock")
                    self.assertLessEqual(mesh.triangles(), min(budget, procedural.ROCK_TRIANGLES))
                    self.assertGreater(mesh.triangles(), .8 * min(budget, procedural.ROCK_TRIANGLES))
                    again = procedural.plan(request(rock(form), budget, 5))[0][2]
                    self.assertEqual((mesh.vertices, mesh.faces, mesh.uvs, mesh.bake), (again.vertices, again.faces, again.uvs, again.bake))
                    self.assertNotEqual(mesh.vertices, procedural.plan(request(rock(form), budget, 6))[0][2].vertices)
                    for axis, size in enumerate((6.0, 2.6, 4.2)):
                        values = [v[axis] for v in mesh.vertices]
                        self.assertAlmostEqual(max(values) - min(values), size, places=6)
                    self.assertAlmostEqual(min(v[2] for v in mesh.vertices), 0.0, places=6)
                    # Flat base: a ring of vertices rests within 2% of the height on the ground.
                    self.assertGreater(sum(v[2] < .02 * 4.2 for v in mesh.vertices), 20)
                    # Unique UV layout: every triangle lies inside its own chart; charts never overlap
                    # and keep a gutter, so the baked texture never repeats or bleeds.
                    bake, rects = mesh.bake, mesh.bake["charts"]
                    self.assertEqual(len(bake["chartOf"]), len(mesh.faces))
                    for uv, chart in zip(mesh.uvs, bake["chartOf"]):
                        u0, v0, u1, v1 = rects[chart]
                        self.assertTrue(all(u0 - 1e-9 <= u <= u1 + 1e-9 and v0 - 1e-9 <= v <= v1 + 1e-9 for u, v in uv))
                    gap = 2 * procedural.ROCK_GUTTER / procedural.ROCK_ATLAS - 1e-9
                    for i, (a0, b0, a1, b1) in enumerate(rects):
                        self.assertTrue(0 < a0 < a1 < 1 and 0 < b0 < b1 < 1)
                        for c0, d0, c1, d1 in rects[i + 1:]:
                            self.assertTrue(a1 + gap <= c0 or c1 + gap <= a0 or b1 + gap <= d0 or d1 + gap <= b0)
                    # The charts fill most of the texture.
                    self.assertGreater(sum((a1 - a0) * (b1 - b0) for a0, b0, a1, b1 in rects), .6)
                    for name in ("normals", "mossNormals", "cavity", "tunnel"):
                        self.assertEqual(len(bake[name]), len(mesh.vertices))
                    self.assertTrue(all(-1 <= c <= 1 for c in bake["cavity"]) and all(0 <= t <= 1 for t in bake["tunnel"]))
                    self.assertEqual(max(bake["tunnel"]) > .5, form == "cave")
                    # Outcrops carry scree: separate closed stones at the foot of the mass.
                    if form == "boulder":
                        self.assertEqual(components(mesh), 1)
                    else:
                        self.assertGreater(components(mesh), 3)
        # The outcrop is a merged rock mass, not a box: its front foot line wanders and its skyline
        # rises and falls along the width.
        outcrop = procedural.plan(request(rock("outcrop"), 6000, 7))[0][2]
        shell = [v for v in outcrop.vertices if v[2] > .25]
        bins = collections.defaultdict(list)
        for x, y, z in shell:
            bins[min(5, int((x + 3.0) / 1.0))].append((y, z))
        fronts = [min(y for y, _ in b) for b in bins.values()]
        tops = [max(z for _, z in b) for b in bins.values()]
        self.assertGreater(max(fronts) - min(fronts), .1 * 2.6)
        self.assertGreater(max(tops) - min(tops), .2 * 4.2)
        # The cave mouth is carved back into the front (-Y) face of the same outcrop.
        outcrop, cave = (procedural.plan(request(rock(form, (6.5, 3.2, 4.6)), 6000, 8))[0][2] for form in ("outcrop", "cave"))

        def front_depth(mesh):
            middle = [v for v in mesh.vertices if abs(v[0]) < .6 and .3 < v[2] < 1.5]
            return min(middle, key=lambda v: v[1])[1] if middle else math.inf
        self.assertGreater(front_depth(cave) - front_depth(outcrop), .5)
        # Fracture planes: the boulder has broad near-flat facets (many coplanar neighbour normals).
        boulder = procedural.plan(request(rock("boulder", (1.8, 1.4, 1.1), moss=False), 6000, 5))[0][2]
        normals = []
        for face in boulder.faces:
            a, b, c = (boulder.vertices[i] for i in face)
            normals.append(procedural.norm(procedural.cross(procedural.sub(b, a), procedural.sub(c, a))))
        flat = sum(1 for n, m in zip(normals, normals[1:]) if procedural.dot(n, m) > .995)
        self.assertGreater(flat, .2 * len(normals))
        materials = procedural.surface_materials(request(rock("cave", (6.5, 3.2, 4.6))))
        self.assertEqual([(m["id"], m["pattern"], m["surface"], m["extent"], m["moss"]) for m in materials],
                         [("Rock", "rock-outcrop", {"profile": "stone", "resolution": 512}, 6.5, True)])
        self.assertEqual(procedural.surface_materials(request(rock("boulder", finish="flat"))), [])
        self.assertEqual(procedural.surface_materials(request(rock("boulder", moss=False)))[0]["pattern"], "rock-boulder")

    def test_positive_density_scales_complete_leaves_linearly_without_a_minimum_floor(self):
        for species, make in [(s, tree) for s in ("pine", "oak", "birch")] + [(s, natural) for s in ("oak", "birch", "pine")]:
            dense = procedural.plan(request(make(species, density=1.0), 16000))[1][2]
            capacity = dense.triangles() // procedural.leaf_triangles()
            for density in (1e-8, .1, .25, .7, 1.0):
                with self.subTest(species=species, natural=make is natural, density=density):
                    parts = procedural.plan(request(make(species, density=density), 16000))
                    self.assertEqual([key for key, _, _ in parts], ["bark", "leaves"])
                    self.assertEqual(parts[1][2].triangles(), math.ceil(capacity * density) * procedural.leaf_triangles())
                    self.assertLessEqual(sum(mesh.triangles() for _, _, mesh in parts), 16000)

    def test_palm_fronds_scale_from_zero_and_positive_tiny_density_remains_nonempty(self):
        original = procedural.MeshData.tube
        for density in (0., 1e-8, .25, .7, 1.):
            fronds = []
            def counted(mesh, spine, radii, sides, **kwargs):
                if sides == 4 and len(spine) == 9:
                    fronds.append(spine)
                return original(mesh, spine, radii, sides, **kwargs)
            with self.subTest(density=density), patch.object(procedural.MeshData, "tube", counted):
                parts = procedural.plan(request(tree("palm", density=density), 16000))
                self.assertEqual(len(fronds), math.ceil(16 * density))
                self.assertEqual([key for key, _, _ in parts], ["bark"] if density == 0 else ["bark", "leaves"])
                self.assertTrue(all(mesh.faces for _, _, mesh in parts))

    def test_rock_respects_requested_size_and_flat_base(self):
        (_, _, rock), = procedural.plan(request({"kind": "rock", "size": [3.0, 2.0, 1.0], "roughness": 0.7}, 6000))
        for axis, size in enumerate((3.0, 2.0, 1.0)):
            values = [v[axis] for v in rock.vertices]
            self.assertAlmostEqual(max(values) - min(values), size, places=5)
        self.assertAlmostEqual(min(v[2] for v in rock.vertices), 0.0, places=6)

    def test_impossible_requests_fail_before_blender(self):
        with self.assertRaises(ValueError):
            procedural.plan(request({"kind": "column", "radius": 0.4, "height": 5.0, "flutes": 32, "base": "attic", "capital": "corinthian"}, 3000))
        with self.assertRaises(ValueError):
            procedural.plan(request({"kind": "column", "radius": 1.0, "height": 1.5, "flutes": 0, "base": "attic", "capital": "corinthian"}))
        with self.assertRaises(ValueError):
            procedural.plan(request({"kind": "teapot"}))

    def test_source_has_no_dynamic_code_paths_or_io(self):
        tree_ast = ast.parse(SOURCE.read_text(encoding="utf-8"))
        names = {node.id for node in ast.walk(tree_ast) if isinstance(node, ast.Name)}
        self.assertFalse(names & {"eval", "exec", "compile", "open", "__import__", "getattr", "globals"})
        imported = {alias.name.split(".")[0] for node in ast.walk(tree_ast) if isinstance(node, (ast.Import, ast.ImportFrom))
                    for alias in node.names} | {node.module for node in ast.walk(tree_ast) if isinstance(node, ast.ImportFrom) and node.module}
        # Standard library, Blender, and the bundled worker modules (flat in a job; see worker_paths).
        local = imported - {"math", "random", "heapq", "bpy", "bmesh", "mathutils", "Vector", "author_surfaces"}
        self.assertLessEqual(local, set(worker_paths.MODULES) - {"asset_worker", "probe", "procedural"})
        texture_imports = [node for node in ast.walk(tree_ast) if isinstance(node, ast.ImportFrom) and node.module == "textures"]
        self.assertEqual([[alias.name for alias in node.names] for node in texture_imports], [["author_surfaces"]])



try:
    import numpy  # noqa: F401  (bundled with Blender; the natural tree texture patterns use it)
except ImportError:
    numpy = None


@unittest.skipIf(numpy is None, "NumPy is bundled with Blender, not every host Python")
class NaturalTreeTextures(unittest.TestCase):
    """Pixel contract of textures.tree_surface (no bpy: author_surfaces imports it lazily)."""

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("arcane_textures_under_test", ROOT / "workers" / "blender" / "textures.py")
        cls.textures = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.textures)

    def test_patterns_are_deterministic_original_maps(self):
        for pattern, color in (("oak-bark", [.22, .18, .14]), ("birch-bark", [.82, .8, .75]), ("pine-bark", [.24, .14, .09]),
                               ("oak-leaves", [.12, .25, .06]), ("birch-leaves", [.24, .42, .1]), ("pine-leaves", [.05, .16, .07])):
            with self.subTest(pattern=pattern):
                rgb, alpha, normal, rough = self.textures.tree_surface(pattern, color, 99, 512)
                again = self.textures.tree_surface(pattern, color, 99, 512)
                other = self.textures.tree_surface(pattern, color, 100, 512)
                self.assertTrue(all((a == b).all() for a, b in zip((rgb, alpha, normal, rough), again)))
                self.assertFalse((rgb == other[0]).all())
                self.assertEqual(rgb.shape, (512, 512, 3))
                self.assertTrue(numpy.isfinite(rgb).all() and (rough >= 0).all() and (rough <= 1).all())
                self.assertTrue(numpy.allclose(numpy.linalg.norm(normal, axis=-1), 1))
                if pattern.endswith("bark"):
                    self.assertTrue((alpha == 1).all())
                else:
                    # Cutout coverage: real holes and solid leaves in every tile, opaque nowhere else.
                    for row in range(2):
                        for col in range(4):
                            tile = alpha[row * 256:(row + 1) * 256, col * 128:(col + 1) * 128]
                            self.assertTrue(.15 < (tile >= .5).mean() < .6)
                            # Leaves stay inside their tile: the outer texel ring is transparent.
                            ring = numpy.concatenate([tile[0], tile[-1], tile[:, 0], tile[:, -1]])
                            self.assertLess((ring >= .5).mean(), .02)

    def test_birch_strips_repeat_within_themselves_and_bark_wraps_round(self):
        rgb, _, normal, _ = self.textures.tree_surface("birch-bark", [.82, .8, .75], 5, 512)
        rows = {name: (first, count) for name, first, count in self.textures.BIRCH_ROWS}
        for name in ("base", "patched", "clean"):
            first, count = rows[name]
            self.assertTrue((rgb[first] == rgb[first + count - 1]).all())
            self.assertTrue((normal[first] == normal[first + count - 1]).all())
        # Trunk order bottom up with guard rows, so neighbouring texel rows continue each strip's edge, and
        # every strip change on the trunk is continuous: each strip's last row is the next one's first.
        guard = self.textures.BIRCH_GUARD
        self.assertEqual([n for n, _, _ in self.textures.BIRCH_ROWS], ["base", "fall", "patched", "rise", "clean"])
        self.assertEqual(self.textures.BIRCH_ROWS[0][1], guard)
        self.assertEqual(sum(c for _, _, c in self.textures.BIRCH_ROWS) + 2 * guard, 512)
        for (_, a, ca), (_, b, _) in zip(self.textures.BIRCH_ROWS, self.textures.BIRCH_ROWS[1:]):
            self.assertEqual(a + ca, b)
        step = numpy.abs(rgb[1:] - rgb[:-1]).mean()
        for low, high in (("base", "fall"), ("fall", "patched"), ("patched", "rise"), ("rise", "clean"), ("patched", "patched"), ("clean", "clean")):
            self.assertLess(numpy.abs(rgb[sum(rows[low]) - 1] - rgb[rows[high][0]]).mean(), step * 1e-3, (low, high))
            self.assertLess(numpy.abs(normal[sum(rows[low]) - 1] - normal[rows[high][0]]).mean(), .02, (low, high))
        # Grading strips really grade: dark patch cover falls from the base to the clean bark.
        dark = {name: (rgb[f:f + c].mean(axis=2) < .25).mean() for name, (f, c) in rows.items()}
        self.assertGreater(dark["base"], dark["fall"])
        self.assertGreater(dark["fall"], dark["patched"])
        self.assertGreater(dark["patched"], dark["rise"])
        for name, (first, count) in rows.items():
            self.assertEqual(procedural.BIRCH_STRIPS[name], (first / 512, count / 512))
        rgb, _, _, _ = self.textures.tree_surface("oak-bark", [.22, .18, .14], 5, 512)
        seam = numpy.abs(rgb[:, 0] - rgb[:, -1]).mean()
        inner = numpy.abs(rgb[:, 1:] - rgb[:, :-1]).mean()
        self.assertLess(seam, inner * 3)
        self.assertLess(numpy.abs(rgb[0] - rgb[-1]).mean(), numpy.abs(rgb[1:] - rgb[:-1]).mean() * 3)
        self.assertEqual(self.textures.BARK_SIZE, procedural.BARK_TILE)

    def test_pine_strips_repeat_within_themselves_and_grade_plates_into_upper_bark(self):
        rgb, _, normal, _ = self.textures.tree_surface("pine-bark", [.24, .14, .09], 5, 512)
        rows = {name: (first, count) for name, first, count in self.textures.PINE_ROWS}
        for name in ("plated", "upper"):
            first, count = rows[name]
            self.assertTrue((rgb[first] == rgb[first + count - 1]).all())
            self.assertTrue((normal[first] == normal[first + count - 1]).all())
        guard = self.textures.PINE_GUARD
        self.assertEqual([n for n, _, _ in self.textures.PINE_ROWS], ["plated", "grade", "upper"])
        self.assertEqual(self.textures.PINE_ROWS[0][1], guard)
        self.assertEqual(sum(c for _, _, c in self.textures.PINE_ROWS) + 2 * guard, 512)
        for (_, a, ca), (_, b, _) in zip(self.textures.PINE_ROWS, self.textures.PINE_ROWS[1:]):
            self.assertEqual(a + ca, b)
        step = numpy.abs(rgb[1:] - rgb[:-1]).mean()
        for low, high in (("plated", "grade"), ("grade", "upper"), ("plated", "plated"), ("upper", "upper")):
            self.assertLess(numpy.abs(rgb[sum(rows[low]) - 1] - rgb[rows[high][0]]).mean(), step * 1e-3, (low, high))
            self.assertLess(numpy.abs(normal[sum(rows[low]) - 1] - normal[rows[high][0]]).mean(), .02, (low, high))
        # Dark deep plates low on the trunk, lighter thin bark above, with relief falling away.
        light = {name: rgb[f:f + c].mean() for name, (f, c) in rows.items()}
        self.assertLess(light["plated"], light["grade"])
        self.assertLess(light["grade"], light["upper"])
        relief = {name: 1 - normal[f:f + c, :, 2].mean() for name, (f, c) in rows.items()}
        self.assertGreater(relief["plated"], 2 * relief["upper"])
        for name, (first, count) in rows.items():
            self.assertEqual(procedural.PINE_STRIPS[name], (first / 512, count / 512))
        seam = numpy.abs(rgb[:, 0] - rgb[:, -1]).mean()
        self.assertLess(seam, numpy.abs(rgb[:, 1:] - rgb[:, :-1]).mean() * 3)

    def test_log_texture_holds_one_girth_wide_bark_band_and_end_grain_discs(self):
        (_, band, rows), (_, discs, _) = self.textures.LOG_ROWS
        for species, color in (("oak", [.22, .18, .14]), ("birch", [.82, .8, .75])):
            for moss in (False, True):
                with self.subTest(species=species, moss=moss):
                    rgb, alpha, normal, rough = self.textures.tree_surface(species + "-log", color, 9, 512, 3, moss)
                    again = self.textures.tree_surface(species + "-log", color, 9, 512, 3, moss)
                    self.assertTrue(all((a == b).all() for a, b in zip((rgb, alpha, normal, rough), again)))
                    self.assertFalse((rgb == self.textures.tree_surface(species + "-log", color, 9, 512, 2, moss)[0]).all())
                    self.assertEqual(rgb.shape, (512, 512, 3))
                    self.assertTrue((alpha == 1).all() and (rough >= 0).all() and (rough <= 1).all())
                    self.assertTrue(numpy.allclose(numpy.linalg.norm(normal, axis=-1), 1))
                    self.assertTrue((rgb[band] == rgb[band + rows - 1]).all())
                    # Moss is green and sits round u = .5 (the top of a log), never at the seam.
                    green = rgb[band:band + rows, :, 1] - rgb[band:band + rows, :, 0]
                    if moss:
                        self.assertGreater(green[:, 200:312].mean(), green[:, :40].mean() + .02)
                    else:
                        self.assertLess(abs(green[:, 200:312].mean() - green[:, :40].mean()), .02)
                    # Each disc tile has wood inside and the bark rim colour at its corners.
                    tile = 512 - discs
                    for k in range(4):
                        block = rgb[discs:, k * tile:(k + 1) * tile]
                        self.assertGreater(numpy.abs(block[tile // 2, tile // 2] - block[1, 1]).sum(), .05)
        # Oak log bark is generated round the whole girth (no copied tile columns) and its exact repeat
        # spans LOG_CYCLES tile lengths; it is weathered: lower contrast than the living tree's bark.
        rgb = self.textures.tree_surface("oak-log", [.22, .18, .14], 9, 512, 3)[0][band:band + rows]
        third = 512 // 3
        self.assertGreater(numpy.abs(rgb[:, :third] - rgb[:, third:2 * third]).mean(), .005)
        half = (rows - 1) // 2
        self.assertGreater(numpy.abs(rgb[:half] - rgb[half:2 * half]).mean(), .005)
        tree = self.textures.tree_surface("oak-bark", [.22, .18, .14], 9, 512)[0]
        self.assertLess(rgb.mean(axis=2).std(), .75 * tree.mean(axis=2).std())
        self.assertEqual(procedural.LOG_BAND, (band / 512, rows / 512))
        self.assertEqual(procedural.LOG_CYCLES, self.textures.LOG_CYCLES)
        self.assertEqual((procedural.LOG_DISC_ROW, procedural.LOG_DISC_TILE), (discs / 512, (512 - discs) / 512))
        with self.assertRaises(ValueError):
            self.textures.tree_surface("oak-log", [.2, .2, .2], 1, 512, 9)

    def test_pine_needle_atlas_is_dense_dark_radial_bundles(self):
        rgb, alpha, normal, _ = self.textures.tree_surface("pine-leaves", [.05, .16, .07], 3, 512)
        for row in range(2):
            for col in range(4):
                tile = (slice(row * 256, (row + 1) * 256), slice(col * 128, (col + 1) * 128))
                covered = alpha[tile] >= .5
                # A full bottle-brush spray: wide (needles all round each shoot) and dense, still with gaps.
                self.assertGreater(covered.mean(), .3)
                self.assertGreater(covered.any(axis=0).mean(), .7)
                # Dark green: green leads, blue no darker than half the red.
                leaf = rgb[tile][covered]
                self.assertTrue(leaf[:, 1].mean() > leaf[:, 0].mean() and leaf[:, 2].mean() >= .5 * leaf[:, 0].mean())
                self.assertLess(leaf.mean(), .12)
                # Lighter new growth at the shoot tips (upper tile) than at the base of the spray.
                rows = numpy.nonzero(covered.any(axis=1))[0]
                top, low = covered[rows[-1] - 40:rows[-1]], covered[rows[0]:rows[0] + 80]
                tips = rgb[tile][rows[-1] - 40:rows[-1]][top][:, 1].mean()
                base = rgb[tile][rows[0]:rows[0] + 80][low][:, 1].mean()
                self.assertGreater(tips, base)
        # Shade row darker than the sunlit row.
        self.assertLess(rgb[256:][alpha[256:] >= .5].mean(), rgb[:256][alpha[:256] >= .5].mean())

    def test_rock_texture_is_baked_in_world_space_with_soft_moss_and_a_dark_tunnel(self):
        def bake(form, size, moss=True, seed=8):
            params = {"kind": "rock", "size": size, "roughness": .6, "form": form, "moss": moss, "finish": "natural"}
            mesh = procedural.plan(request(params, 6000, seed))[0][2]
            return procedural.rock_bake(mesh), procedural.rock_pattern(params)
        boulder, pattern = bake("boulder", [1.8, 1.4, 1.1], seed=11)
        rgb, alpha, normal, rough = self.textures.tree_surface(pattern, [.2, .19, .17], 9, 512, moss=True, extent=1.8, bake=boulder)
        again = self.textures.tree_surface(pattern, [.2, .19, .17], 9, 512, moss=True, extent=1.8, bake=boulder)
        self.assertTrue(all((a == b).all() for a, b in zip((rgb, alpha, normal, rough), again)))
        self.assertFalse((rgb == self.textures.tree_surface(pattern, [.2, .19, .17], 10, 512, moss=True, extent=1.8, bake=boulder)[0]).all())
        self.assertTrue((alpha == 1).all() and numpy.isfinite(rgb).all() and (rough >= 0).all() and (rough <= 1).all())
        self.assertTrue(numpy.allclose(numpy.linalg.norm(normal, axis=-1), 1))
        self.assertGreater((normal[..., 2] < .995).mean(), .05)
        # Moss settles on the boulder: green, rough texels, with a soft fringe of partial cover
        # between moss and bare stone instead of a hard stair-stepped edge.
        green = rgb[..., 1] - rgb[..., 0]
        moss = green > .02
        self.assertGreater(moss.mean(), .05)
        self.assertGreater(rough[moss].mean(), rough[green < 0].mean())
        partial = (green > .004) & (green < .016)
        self.assertGreater(partial.sum(), .08 * moss.sum())
        bare = self.textures.tree_surface(pattern, [.2, .19, .17], 9, 512, moss=False, extent=1.8, bake=boulder)[0]
        self.assertLess(((bare[..., 1] - bare[..., 0]) > .02).mean(), .01)
        # The cave mouth darkens inward: texels deep in the tunnel are far darker than the rim.
        cave, pattern = bake("cave", [6.5, 3.2, 4.6])
        rgb = self.textures.tree_surface(pattern, [.2, .19, .17], 9, 512, moss=True, extent=6.5, bake=cave)[0]
        maps, filled, texels = self.textures._rasterise(numpy, cave, 512)
        tunnel = maps[..., 10].reshape(512, 512)
        texels = texels.reshape(512, 512)
        deep, rim = texels & (tunnel > .7), texels & (tunnel > .02) & (tunnel < .15)
        self.assertTrue(deep.any() and rim.any())
        self.assertLess(rgb[deep].mean(), .5 * rgb[rim].mean())
        # Outcrop strata are world-space bands with soft partings, never thin regular texel stripes:
        # no row-to-row jump along the texture is larger than the stone's own variation.
        self.assertLess(numpy.abs(numpy.diff(rgb.mean(axis=2), axis=0)).mean(), .02)
        # Rock textures need their planned mesh, a 512 px layout and a bounded extent.
        with self.assertRaises(ValueError):
            self.textures.tree_surface("rock-boulder", [.2, .2, .2], 1, 512, extent=1.8)
        for extent in (.01, 30.0, math.inf):
            with self.assertRaises(ValueError):
                self.textures.tree_surface("rock-boulder", [.2, .2, .2], 1, 512, extent=extent, bake=boulder)


if __name__ == "__main__":
    unittest.main()
