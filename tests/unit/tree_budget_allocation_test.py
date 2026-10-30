"""Real pure generator regressions; no Blender, render or Studio acceptance.

The seed-31 oak previously spent 126/322 cards on tips and emitted no tertiary
wood. 171 roots were on virtual-only guide stations; the retained original GLB
matched all 2,576 unique planned leaf positions. These checks exercise production
allocation/geometry and its final-skin refusal boundary, not a replacement model.
"""
import collections
import copy
import importlib.util
import math
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
import worker_paths  # noqa: E402,F401

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("arcane_tree_budget", ROOT / "workers/blender/procedural.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def request(species="oak", height=9, budget=16000, density=.7, levels=3, seed=31, variant=None):
    params = {"kind": "tree", "species": species, "height": height, "trunkTaper": .55,
              "branchLevels": levels, "leafDensity": density, "trunkRadius": None,
              "secondaryColor": [.12, .25, .06], "finish": "natural"}
    if variant is not None:
        params["variant"] = variant
    return {"template": "procedural", "name": "tree-budget", "seed": seed,
            "triangleBudget": budget, "color": [.22, .18, .14], "procedural": params}


def snapshot(data):
    return copy.deepcopy((data.vertices, data.faces, data.smooth, data.uvs, data.normals))


class TreeBudgetAllocation(unittest.TestCase):
    def assert_skin_bindings(self, bark, leaves):
        self.assertEqual(len(leaves.attachments), len(leaves.vertices) // 8)
        axis_orders = {a["id"]: a["order"] for a in bark.wood["axisDetails"]}
        for card, attachment in enumerate(leaves.attachments):
            first = attachment["first"]
            self.assertEqual(first, card * 8)
            self.assertEqual(attachment["root"], bark.vertices[attachment["vertex"]])
            self.assertGreaterEqual(attachment["vertex"], bark.wood["trunkVertices"])
            self.assertGreater(axis_orders[attachment["axis"]], 0, "the trunk is not a fallback foliage anchor")
            self.assertGreater(attachment["radius"], 0)
            base = p.mul(p.add(leaves.vertices[first], leaves.vertices[first + 5]), .5)
            self.assertLess(math.dist(base, attachment["root"]), 1e-9)

    def test_inspected_oak_retains_real_tertiary_wood_and_all_canopy_regions(self):
        bark, leaves = [part[2] for part in p.plan(request())]
        orders = collections.Counter(a["order"] for a in bark.wood["axisDetails"])
        self.assertEqual((orders[0], orders[1], orders[2]), (1, 5, 20))
        self.assertGreaterEqual(orders[3], 25, "the old fixed wood share discarded every tertiary branch")
        self.assertGreaterEqual(bark.wood["axisDetails"][0]["sides"], 24)
        self.assertGreater(len({tuple(a["preset"]) for a in bark.wood["axisDetails"]}), 1)
        kinds = collections.Counter(leaves.canopy_kinds)
        self.assertEqual(sum(kinds.values()), 322)
        self.assertGreaterEqual(kinds["shell"], 322 * .5)
        self.assertTrue(322 * .15 <= kinds["tip"] <= 322 * .25)
        self.assertTrue(322 * .15 <= kinds["inner"] <= 322 * .25)
        self.assert_skin_bindings(bark, leaves)
        self.assertGreater(sum(a["axis"] in {x["id"] for x in bark.wood["axisDetails"] if x["order"] == 3}
                               for a in leaves.attachments), len(leaves.attachments) * .25)
        self.assertLessEqual(bark.wood["triangleLimit"] + 460 * p.leaf_triangles(), 16000)
        self.assertEqual(bark.wood["triangleLimit"], math.floor(bark.triangles() * p.UNION_RESERVE))

    def test_every_positive_density_keeps_original_wood_and_a_complete_card_prefix(self):
        rows = [p.plan(request(density=d)) for d in (1e-8, .1, .7, 1.0)]
        self.assertTrue(all(snapshot(row[0][2]) == snapshot(rows[0][0][2]) for row in rows))
        dense = rows[-1][1][2]
        for density, row in zip((1e-8, .1, .7, 1.0), rows):
            bark, leaves = row[0][2], row[1][2]
            count = math.ceil(460 * density)
            self.assertEqual(len(leaves.vertices), count * 8)
            self.assertEqual(leaves.triangles(), count * 12)
            self.assertEqual(leaves.vertices, dense.vertices[:count * 8])
            self.assertEqual(leaves.faces, dense.faces[:count * 12])
            self.assertEqual(leaves.uvs, dense.uvs[:count * 12])
            self.assert_skin_bindings(bark, leaves)

    def test_small_large_and_shallow_trees_keep_actual_skin_and_unchanged_hard_budget(self):
        for species in ("oak", "birch"):
            for height, budget, levels in ((2, 2500, 1), (2, 4000, 3), (9, 12000, 2),
                                           (9, 16000, 3), (20, 20000, 1), (20, 20000, 3)):
                with self.subTest(species=species, height=height, budget=budget, levels=levels):
                    parts = p.plan(request(species, height, budget, 1, levels))
                    bark, leaves = parts[0][2], parts[1][2]
                    self.assertLessEqual(bark.wood["triangleLimit"] + leaves.triangles(), budget)
                    self.assertLessEqual(sum(row[2].triangles() for row in parts), budget)
                    self.assertGreater(leaves.triangles(), 0)
                    self.assert_skin_bindings(bark, leaves)
                    for data in (bark, leaves):
                        edges = collections.Counter(tuple(sorted((a, b))) for face in data.faces
                                                    for a, b in zip(face, face[1:] + face[:1]))
                        self.assertTrue(all(n == 2 for n in edges.values()), "planned tubes and cards stay closed")

    def test_deterministic_seeded_geometry_and_unrelated_tree_routes_remain_distinct(self):
        first, again, other = [p.plan(request(seed=seed)) for seed in (31, 31, 32)]
        self.assertEqual([snapshot(x[2]) for x in first], [snapshot(x[2]) for x in again])
        self.assertNotEqual(first[0][2].vertices, other[0][2].vertices)
        for species, count in (("oak", 10934), ("birch", 12362)):
            bare = p.plan(request(species, density=0, seed=7))
            self.assertEqual(len(bare), 1)
            self.assertEqual(bare[0][2].triangles(), count)
        pine = p.plan(request("pine"))
        self.assertIsNone(pine[1][2].attachments)

    def test_variants_keep_survivor_bindings_and_original_single_deformation(self):
        import variation
        original = variation.deform
        observed = []
        def once(parts, post):
            cards_before = len(parts[1][2].vertices) // 8
            reference = copy.deepcopy(parts)
            original(reference, post)
            original(parts, post)
            self.assertEqual([snapshot(d) for _, _, d in parts], [snapshot(d) for _, _, d in reference])
            observed.append({**post, "removedCards": cards_before - len(parts[1][2].vertices) // 8})
        for species in ("oak", "birch"):
            for variant in ([1, 4], [4, 4]):
                with self.subTest(species=species, variant=variant), patch.object(variation, "deform", once):
                    before = len(observed)
                    parts = p.plan(request(species, seed=701, variant=variant))
                    self.assertEqual(len(observed), before + 1)
                    self.assertGreater(observed[-1]["damage"], 0)
                    self.assert_skin_bindings(parts[0][2], parts[1][2])
                    self.assertLessEqual(parts[0][2].wood["triangleLimit"] + parts[1][2].triangles(), 16000)
        self.assertGreater(sum(row["removedCards"] for row in observed), 0, "survivor remapping must exercise actual card removal")

    def test_final_skin_projection_is_local_atomic_and_preserves_topology_and_uvs(self):
        _, leaves = [row[2] for row in p.plan(request(density=.1))]
        before = snapshot(leaves)
        seen = []
        def refused(root):
            seen.append(root)
            return p.add(root, (.00001, 0, 0)) if len(seen) == 1 else p.add(root, (1, 0, 0))
        with self.assertRaisesRegex(ValueError, "outside its emitted branch skin"):
            p.attach_leaf_cards(leaves, refused)
        self.assertEqual(snapshot(leaves), before, "a late refusal cannot leave partially moved cards")
        for invalid in (None, (math.inf, 0, 0), (0, 0)):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                p.attach_leaf_cards(leaves, lambda root: invalid)
            self.assertEqual(snapshot(leaves), before)
        p.attach_leaf_cards(leaves, lambda root: p.add(root, (.00001, 0, 0)))
        self.assertEqual((leaves.faces, leaves.smooth, leaves.uvs, leaves.normals), before[1:])
        for old, new in zip(before[0], leaves.vertices):
            self.assertLess(math.dist(p.add(old, (.00001, 0, 0)), new), 1e-12)


if __name__ == "__main__":
    unittest.main()
