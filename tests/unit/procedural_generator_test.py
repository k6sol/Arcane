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
    natural(s, h, lv, d) for s in ("oak", "birch") for h, lv, d in ((2.0, 1, .5), (9.0, 2, .7), (9.0, 3, 0.0), (20.0, 3, 1.0))]


def request(params, budget=20000, seed=7):
    return {"procedural": params, "seed": seed, "triangleBudget": budget, "name": "fixture", "color": [0.3, 0.2, 0.1]}


# Natural broadleaf (bark, leaves) triangle counts at 16000, seed 7, height 9, three levels.
BASELINE = {("oak", 0.7): (6178, 6444), ("oak", 0.0): (10934,), ("birch", 0.7): (6468, 6216), ("birch", 0.0): (12362,)}


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
        for species, finish in [(s, None) for s in ("pine", "oak", "birch", "palm")] + [("oak", "natural"), ("birch", "natural")]:
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
        # Scanline proxy in front and side orthographic views: covered share of each row's crown span.
        # Oak is a full crown (70-85%); birch is deliberately airier.
        for species, seeds, low, high in (("oak", (101, 102, 103, 104, 105, 106), .7, .86), ("birch", (201, 202, 203), .55, .72)):
            for seed in seeds:
                leaves = procedural.plan(request(natural(species), 16000, seed))[1][2]
                for keep in (0, 1):
                    with self.subTest(species=species, seed=seed, view=keep):
                        self.assertTrue(low <= canopy_coverage(leaves, keep, rows=True) <= high)
                        self.assertGreater(canopy_coverage(leaves, keep), low - .12)

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

    def test_natural_canopy_stays_in_budget_and_in_the_tonal_strip(self):
        for species in ("oak", "birch"):
            for height, budget in ((2.0, 4000), (9.0, 16000), (20.0, 20000)):
                with self.subTest(species=species, height=height, budget=budget):
                    parts = procedural.plan(request(natural(species, height, density=1.0), budget, 31))
                    bark, leaves = parts[0][2], parts[1][2]
                    self.assertLessEqual(bark.wood["triangleLimit"] + leaves.triangles(), budget)
                    self.assertTrue(all(data.triangles() <= procedural.HARD_TRIANGLE_LIMIT for _, _, data in parts))
                    self.assertEqual(leaves.triangles() % procedural.leaf_triangles(), 0)
                    u = [point[0] for uv in leaves.uvs for point in uv]
                    self.assertGreaterEqual(min(u), .5 - 1e-9)
                    self.assertLessEqual(max(u), 1 + 1e-9)
        # Interior clusters and inner masses use the shaded half of the strip, sunlit ones the light half.
        u = [uv[0][0] for uv in procedural.plan(request(natural("oak"), 16000, 102))[1][2].uvs]
        self.assertGreater(sum(x < .75 for x in u), len(u) * .1)
        self.assertGreater(sum(x > .75 for x in u), len(u) * .1)
        self.assertAlmostEqual(procedural.tone_band(0.0) + procedural.TONE_BAND / 2, .75)
        self.assertAlmostEqual(procedural.tone_band(-1.0) + procedural.TONE_BAND / 2, .625)
        self.assertAlmostEqual(procedural.tone_band(1.0) + procedural.TONE_BAND / 2, .875)

    def test_natural_oak_clusters_carry_shaded_inner_masses_birch_stays_airy(self):
        original, cores = procedural.MeshData.blob, collections.Counter()

        def counted(mesh, ring, top, bottom, band):
            cores[species] += 1
            return original(mesh, ring, top, bottom, band)
        with patch.object(procedural.MeshData, "blob", counted):
            for species in ("oak", "birch"):
                procedural.plan(request(natural(species), 16000, 103))
        self.assertGreater(cores["oak"], 20)
        self.assertEqual(cores["birch"], 0)
        blob = procedural.MeshData()
        blob.blob([(math.cos(a), math.sin(a), 0.0) for a in (2 * math.pi * k / 12 for k in range(12))], (0, 0, .7), (0, 0, -.4), (.55, .035))
        self.assertEqual(blob.triangles(), procedural.CORE_UNITS * procedural.leaf_triangles())

    def test_positive_density_scales_complete_leaves_linearly_without_a_minimum_floor(self):
        for species, make in [(s, tree) for s in ("pine", "oak", "birch")] + [(s, natural) for s in ("oak", "birch")]:
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
        self.assertLessEqual(imported, {"math", "random", "heapq", "bpy", "bmesh", "textures", "author_surfaces"})
        texture_imports = [node for node in ast.walk(tree_ast) if isinstance(node, ast.ImportFrom) and node.module == "textures"]
        self.assertEqual([[alias.name for alias in node.names] for node in texture_imports], [["author_surfaces"]])


if __name__ == "__main__":
    unittest.main()
