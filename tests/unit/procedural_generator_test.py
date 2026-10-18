"""Synthetic generator contract tests: pure-Python planning only, no bpy import/process.

Loads workers/blender/procedural.py by path (its Blender-only build() imports bpy
lazily) and checks every generator's closed manifold topology, triangle budget,
determinism and duplicate-vertex rule that the Blender audit enforces later.
This is not Blender export, render or Studio acceptance evidence.
"""
import ast
import collections
import importlib.util
import sys
import unittest
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


CASES = [tree(s, h, lv) for s in ("pine", "oak", "birch", "palm") for h, lv in ((2.0, 1), (9.0, 2), (20.0, 3))] + [
    {"kind": "rock", "size": [2.0, 1.5, 1.2], "roughness": r} for r in (0.0, 0.5, 1.0)] + [
    {"kind": "column", "radius": 0.4, "height": 5.0, "flutes": f, "base": b, "capital": c}
    for f in (0, 8, 32) for b in ("none", "plinth", "attic") for c in ("none", "doric", "ionic", "corinthian")] + [
    {"kind": "foliage", "style": s, "radius": 0.8, "height": 0.9, "density": d} for s in ("bush", "grass", "fern") for d in (0.0, 1.0)]


def request(params, budget=20000, seed=7):
    return {"procedural": params, "seed": seed, "triangleBudget": budget, "name": "fixture", "color": [0.3, 0.2, 0.1]}


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

    def test_leaf_density_and_budget_scale_foliage(self):
        sparse = procedural.plan(request(tree("birch", density=0.0), 16000))[1][2].triangles()
        dense = procedural.plan(request(tree("birch", density=1.0), 16000))[1][2].triangles()
        self.assertLess(sparse, dense)

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
        self.assertLessEqual(imported, {"math", "random", "bpy", "bmesh"})


if __name__ == "__main__":
    unittest.main()
