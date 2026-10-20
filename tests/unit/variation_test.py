"""Variant family contract tests (workers/blender/variation): pure Python, no bpy.

Checks determinism, low-discrepancy coverage, copula correlations, the minimum pairwise
difference, and that family members plan as distinct, closed, in-budget generator meshes.
This is not Blender export, render or Studio evidence.
"""
import importlib.util
import math
import random
import statistics
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / "workers" / "blender"
sys.path.insert(0, str(WORKER))
sys.path.insert(1, str(WORKER / "uv"))  # UV engine modules (natural finish; flat in a job)
import variation  # noqa: E402  (the package directory; jobs copy it as a flat variation.py)

spec = importlib.util.spec_from_file_location("arcane_procedural_under_variation", WORKER / "procedural.py")
procedural = importlib.util.module_from_spec(spec)
spec.loader.exec_module(procedural)


def cd2(points):
    """Hickernell centred L2 discrepancy (lower = more even coverage of the unit cube)."""
    n, d = len(points), len(points[0])
    a = (13 / 12) ** d
    b = sum(math.prod(1 + .5 * abs(x - .5) - .5 * (x - .5) ** 2 for x in p) for p in points) * 2 / n
    c = sum(math.prod(1 + .5 * abs(x - .5) + .5 * abs(y - .5) - .5 * abs(x - y) for x, y in zip(p, q)) for p in points for q in points) / n ** 2
    return math.sqrt(max(0.0, a - b + c))


def tree(species, variant=None, seed=11):
    params = {"kind": "tree", "species": species, "height": 6 if species == "oak" else 8, "trunkTaper": .55, "branchLevels": 2,
              "leafDensity": .7, "trunkRadius": None, "secondaryColor": [.12, .25, .06], "finish": "natural"}
    if variant:
        params["variant"] = variant
    return {"name": species, "seed": seed, "color": [.22, .18, .14], "triangleBudget": 16000, "procedural": params}


class FamilyTest(unittest.TestCase):
    def test_deterministic(self):
        for kind in variation.SPACES:
            self.assertEqual(variation.family(kind, 701, 6), variation.family(kind, 701, 6))
            self.assertNotEqual(variation.family(kind, 701, 6), variation.family(kind, 702, 6))
        params = tree("oak", [3, 6])["procedural"]
        self.assertEqual(variation.resolve(params, 9, .045), variation.resolve(params, 9, .045))

    def test_low_discrepancy_coverage(self):
        rng = random.Random(5)
        for kind, space in variation.SPACES.items():
            d = len(space)
            pool = variation.halton(256, d, 3)
            randoms = [cd2([[rng.random() for _ in range(d)] for _ in range(256)]) for _ in range(12)]
            self.assertLess(cd2(pool), min(randoms), kind + ": the sampling pool covers the space more evenly than random")
            for n in (6, 12):
                fam = variation.family_latent(kind, 41, n)[0]
                iid = sorted(cd2([[rng.random() for _ in range(d)] for _ in range(n)]) for _ in range(40))
                self.assertLess(cd2(fam), statistics.median(iid), f"{kind} x{n}: family coverage beats the median random set")
                for k in range(d):  # every parameter spans most of its range, not one clump
                    values = [row[k] for row in fam]
                    self.assertGreater(max(values) - min(values), .45, f"{kind} x{n} {space[k][0]} spread")

    def test_correlations(self):
        pool = variation.couple("tree", variation.halton(512, len(variation.SPACES["tree"]), 8))
        names = [s[0] for s in variation.SPACES["tree"]]
        col = lambda name: [row[names.index(name)] for row in pool]
        self.assertGreater(statistics.correlation(col("age"), col("height")), .55)
        self.assertGreater(statistics.correlation(col("age"), col("moss")), .45)
        self.assertLess(statistics.correlation(col("age"), col("bark")), -.4, "older bark is darker")
        self.assertLess(abs(statistics.correlation(col("hue"), col("lean"))), .15, "independent pairs stay independent")
        for row in pool:  # marginals stay inside the unit range
            self.assertTrue(all(0 <= u <= 1 for u in row))

    def test_min_difference(self):
        for kind in variation.SPACES:
            for n in (2, 4, 6, 9, 16):
                for seed in (1, 701, 9001):
                    self.assertGreaterEqual(variation.min_difference(kind, seed, n), variation.MIN_DIFFERENCE, f"{kind} x{n} seed {seed}")
        fam = variation.family("tree", 701, 6)
        self.assertEqual([m["age"] for m in fam], sorted(m["age"] for m in fam), "members are ordered youngest first")
        with self.assertRaises(ValueError):
            variation.family("column", 1, 4)
        with self.assertRaises(ValueError):
            variation.family("tree", 1, 17)


class MemberPlanTest(unittest.TestCase):
    def test_members_plan_distinct_closed_in_budget(self):
        for species in ("oak", "pine"):
            bounds = []
            for i in range(1, 7):
                request = tree(species, [i, 6])
                parts = procedural.plan(request)
                self.assertLessEqual(sum(p[2].triangles() for p in parts), request["triangleBudget"])
                for _, _, data in parts:
                    used = {v for f in data.faces for v in f}
                    self.assertEqual(used, set(range(len(data.vertices))), "no orphan vertices after damage")
                    if data.normals is not None:
                        self.assertEqual(len(data.normals), len(data.vertices))
                    edges = {}
                    for f in data.faces:
                        for a, b in zip(f, f[1:] + f[:1]):
                            edges[(min(a, b), max(a, b))] = edges.get((min(a, b), max(a, b)), 0) + 1
                    if data is parts[-1][2]:  # leaf cards stay closed: removal takes whole components
                        self.assertTrue(all(c == 2 for c in edges.values()), species + " leaves closed")
                verts = [v for p in parts for v in p[2].vertices]
                box = tuple(round(max(v[k] for v in verts) - min(v[k] for v in verts), 3) for k in range(3))
                bounds.append(box)
                self.assertEqual(procedural.plan(tree(species, [i, 6]))[0][2].vertices[:50], parts[0][2].vertices[:50], "deterministic member")
            self.assertEqual(len(set(bounds)), 6, f"{species} members differ: {bounds}")
            heights = [b[2] for b in bounds]
            self.assertGreater(heights[-1], heights[0], f"{species}: the oldest member is taller than the youngest {heights}")

    def test_lean_points_to_local_x(self):
        data = procedural.MeshData()
        for z in range(11):
            data.vertex((0, 0, z))
        variation.deform([("bark", "primary", data)], {"lean": 5.0, "crown": 1.0, "damage": 0.0, "seed": 1})
        self.assertAlmostEqual(data.vertices[-1][0], 10 * math.tan(math.radians(5)), places=6)
        self.assertEqual(data.vertices[0], (0, 0, 0), "the base stays planted")
        self.assertTrue(all(v[1] == 0 for v in data.vertices), "lean is along local +X only; placement yaw sets its heading")

    def test_textures_tint_only_with_variant(self):
        request = tree("oak", [2, 6])
        materials = [{"id": "Bark", "color": [.22, .18, .14]}, {"id": "Leaves", "color": [.12, .25, .06]}]
        tinted = variation.tint_surfaces(request["procedural"], 11, materials)
        self.assertNotEqual(tinted[0]["color"], materials[0]["color"])
        self.assertEqual(materials[0]["color"], [.22, .18, .14], "inputs are not mutated")
        self.assertIs(variation.tint_surfaces(tree("oak")["procedural"], 11, materials), materials)
        colours = {tuple(round(c, 4) for c in variation.tint_surfaces(tree("oak", [i, 6])["procedural"], 11, materials)[1]["color"]) for i in range(1, 7)}
        self.assertEqual(len(colours), 6, "each member has its own leaf tone")


if __name__ == "__main__":
    unittest.main()
