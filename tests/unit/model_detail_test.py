"""Model spec compiler, automatic detail hierarchy (pure stage, no bpy).

Checks workers/blender/grammar/model_detail.py through the planner: material-class bevels
(stone wider than metal, explicit values win), masonry courses on large stone boxes, the
triangle budget respected with every tier on (tiers degrade instead of overflowing), surface
details (nails, caps, studs) standing proud of their host, buried declared details failing with
a hint, scatter never landing on hidden faces, autoDetail:false switching the tiers off, and the
whole pass deterministic for (spec, seed). Blender-side tiers (edge bevels of CSG cuts,
weighted normals) are render evidence, not covered here.
"""
import copy
import json
import math
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "workers" / "blender" / "grammar"))
import model_detail as D  # noqa: E402
import model_geom as G  # noqa: E402
import model_plan  # noqa: E402

FIXTURES = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in (ROOT / "tests" / "fixtures" / "model-specs").glob("*.json")}


def request(spec, seed=1, budget=8000, name="t"):
    return {"name": name, "seed": seed, "triangleBudget": budget, "procedural": copy.deepcopy(spec)}


def fixture(name, seed=1, budget=None, **top):
    data = FIXTURES[name]
    spec = copy.deepcopy(data["spec"])
    spec.update(top)
    return model_plan.plan(request(spec, seed, budget or data["triangleBudget"], data["name"]))


def one(parts, materials=None, size=(1, 1, 1), budget=6000, **top):
    spec = {"kind": "spec", "size": list(size), "materials": materials or [{"id": "stone", "finish": "stone"}], "parts": parts}
    spec.update(top)
    return model_plan.plan(request(spec, budget=budget))


def signature(plan):
    return [(i.key, round(sum(v[0] + 2 * v[1] + 3 * v[2] for v in i.mesh.verts), 9), len(i.mesh.faces)) for i in plan.instances]


def host_height(detail, hosts):
    """Highest point of `detail` above the nearest host surface (along that surface normal)."""
    lo, hi = detail.mesh.bounds()
    centre = tuple((a + b) / 2 for a, b in zip(lo, hi))
    best = None
    for h in hosts:
        for a, b, c in D.tri_list(h.mesh):
            q = D.closest_on_triangle(centre, a, b, c)
            n = G.cross(G.sub(b, a), G.sub(c, a))
            if G.length(n) < 1e-14:
                continue
            d = math.dist(q, centre)
            if best is None or d < best[0]:
                best = (d, q, G.norm(n))
    _, q, n = best
    heights = [G.dot(G.sub(v, q), n) for v in detail.mesh.verts]
    return max(heights), max(heights) - min(heights)


class Bevels(unittest.TestCase):
    def test_unbevelled_parts_get_material_class_bevels_and_explicit_values_win(self):
        parts = [{"id": "slab", "op": "box", "material": "stone", "size": [.4, .4, .2], "at": [-.5, 0, .1]},
                 {"id": "bar", "op": "box", "material": "iron", "size": [.4, .4, .2], "at": [0, 0, .1]},
                 {"id": "flat", "op": "box", "material": "stone", "size": [.4, .4, .2], "bevel": 0, "at": [.5, 0, .1]},
                 {"id": "post", "op": "cylinder", "material": "iron", "radius": .1, "height": .2, "at": [1, 0, .1]}]
        plan = one(parts, [{"id": "stone", "finish": "stone"}, {"id": "iron", "finish": "metal"}], size=(1.6, .4, .2))
        bevels = plan.detail["bevels"]
        self.assertGreater(bevels["slab"], bevels["bar"])          # stone softer, metal crisper
        self.assertNotIn("flat", bevels)                           # bevel: 0 is respected
        self.assertIn("post", bevels)
        self.assertLessEqual(bevels["bar"], D.BEVEL["metal"][2])
        flat = next(i for i in plan.instances if i.part == "flat")
        self.assertEqual(len(flat.mesh.faces), 6)
        slab = next(i for i in plan.instances if i.part == "slab")
        self.assertGreater(len(slab.mesh.faces), 6)
        self.assertTrue(slab.mesh.closed())

    def test_auto_detail_off_leaves_the_part_graph_plain(self):
        plan = fixture("arch", autoDetail=False)
        self.assertEqual(plan.detail["bevels"], {})
        self.assertEqual(plan.detail["blocks"], {})
        self.assertFalse(any(i.weld for i in plan.instances))
        self.assertTrue(all(w is None for w in model_plan.edge_widths(plan.spec)))


class Masonry(unittest.TestCase):
    def test_large_stone_boxes_get_ashlar_courses_with_recessed_joints(self):
        plan = fixture("arch")
        self.assertIn("wall", plan.detail["blocks"])
        wall = next(i for i in plan.instances if i.part == "wall")
        self.assertTrue(wall.weld)
        self.assertTrue(wall.mesh.closed())
        cfg = plan.detail["blocks"]["wall"]
        blocks = (len(wall.mesh.faces) - 6) // 26
        self.assertGreaterEqual(blocks, 20)
        # The joints are recesses: the core sits `depth` inside every outer face it shares.
        lo, hi = wall.mesh.bounds()
        self.assertAlmostEqual(hi[1] - lo[1], .6, delta=2 * cfg["depth"] + 1e-6)

    def test_blocks_are_opt_out_and_opt_in(self):
        wall = {"id": "wall", "op": "box", "material": "stone", "size": [2, .4, 1.5], "at": [0, 0, .75]}
        self.assertIn("wall", one([wall], size=(2, .4, 1.5)).detail["blocks"])
        self.assertEqual(one([dict(wall, blocks=False)], size=(2, .4, 1.5)).detail["blocks"], {})
        small = {"id": "pier", "op": "box", "material": "stone", "size": [.6, .4, .9], "at": [0, 0, .45]}
        self.assertEqual(one([small], size=(.6, .4, .9)).detail["blocks"], {})
        chosen = one([dict(small, blocks={"course": .15, "length": .3})], size=(.6, .4, .9)).detail["blocks"]["pier"]
        self.assertAlmostEqual(chosen["course"], .15)


class Budget(unittest.TestCase):
    def test_every_fixture_stays_within_budget_with_all_tiers_on(self):
        for name, data in sorted(FIXTURES.items()):
            with self.subTest(name):
                plan = fixture(name)
                self.assertLessEqual(plan.estimated_triangles(), plan.budget)
                for inst in plan.instances:
                    self.assertTrue(inst.mesh.closed(), inst.key)
                    self.assertGreater(inst.mesh.volume(), 0, inst.key)

    def test_tight_budgets_degrade_the_detail_tiers_instead_of_overflowing(self):
        wall = {"id": "wall", "op": "box", "material": "stone", "size": [6, .5, 4], "at": [0, 0, 2]}
        rich = one([wall], size=(6, .5, 4), budget=12000)
        lean = one([wall], size=(6, .5, 4), budget=2500)
        self.assertLessEqual(lean.estimated_triangles(), 2500)
        self.assertLessEqual(rich.estimated_triangles(), 12000)
        rich_cfg, lean_cfg = rich.detail["blocks"].get("wall"), lean.detail["blocks"].get("wall")
        self.assertIsNotNone(rich_cfg)
        self.assertTrue(lean_cfg is None or lean_cfg["course"] > rich_cfg["course"])

    def test_micro_relief_only_spends_leftover_budget(self):
        slab = {"id": "slab", "op": "box", "material": "stone", "size": [1.2, 1.2, .2], "at": [0, 0, .1], "blocks": False}
        rich = one([slab], size=(1.2, 1.2, .2), budget=8000)
        self.assertIn("slab", rich.detail["relief"])
        self.assertLessEqual(rich.detail["relief"]["slab"], D.RELIEF["stone"][1])
        self.assertLessEqual(rich.estimated_triangles(), 8000)
        flat = next(i for i in rich.instances if i.part == "slab")
        tops = [v[2] for v in flat.mesh.verts if abs(v[0]) < .4 and abs(v[1]) < .4 and v[2] > .1]
        self.assertGreater(max(tops) - min(tops), 1e-4)  # displaced, not flat
        self.assertLess(max(tops) - min(tops), .02)       # subtle


class SurfaceDetails(unittest.TestCase):
    def test_crate_nails_and_caps_stand_proud_of_the_wood(self):
        plan = fixture("crate")
        pine = [i for i in plan.instances if i.material == "pine"]
        nails = [i for i in plan.instances if i.part == "nail"]
        self.assertGreater(len(nails), 20)
        for nail in nails:
            top, extent = host_height(nail, pine)
            self.assertGreaterEqual(top, .5 * extent - 1e-6, nail.key)
        for cap in (i for i in plan.instances if i.part == "corner"):
            top, extent = host_height(cap, pine)
            self.assertGreaterEqual(top, .5 * extent - 1e-6, cap.key)

    def test_scattered_details_never_land_on_hidden_faces(self):
        plan = fixture("crate")
        hosts = [i for i in plan.instances if i.part == "edge_y"]
        others = D.Solids([i for i in plan.instances if i.part != "nail"])
        for nail in (i for i in plan.instances if i.part == "nail"):
            lo, hi = nail.mesh.bounds()
            centre = tuple((a + b) / 2 for a, b in zip(lo, hi))
            best = None
            for h in hosts:
                for a, b, c in D.tri_list(h.mesh):
                    q = D.closest_on_triangle(centre, a, b, c)
                    if best is None or math.dist(q, centre) < best[0]:
                        best = (math.dist(q, centre), q, G.norm(G.cross(G.sub(b, a), G.sub(c, a))))
            _, q, n = best
            # Just outside the host surface under the nail is open air, not another part.
            self.assertFalse(others.inside_any(G.add(q, G.mul(n, .001))), nail.key)

    def test_sunk_declared_details_are_raised_and_buried_ones_fail_with_a_hint(self):
        mats = [{"id": "oak", "finish": "wood"}, {"id": "iron", "finish": "metal"}]
        board = {"id": "board", "op": "box", "material": "oak", "size": [.6, .4, .04], "bevel": 0, "at": [0, 0, .02]}
        stud = {"id": "boss", "op": "cylinder", "material": "iron", "radius": .02, "height": .01, "bevel": 0, "at": [0, 0, .036], "surface": True}
        plan = one([board, stud], mats, size=(.6, .4, .05))
        inst = next(i for i in plan.instances if i.part == "boss")
        top, extent = host_height(inst, [i for i in plan.instances if i.part == "board"])
        self.assertGreaterEqual(top, .5 * extent - 1e-6)
        self.assertIn("boss", plan.detail["surfaceDetails"])
        buried = dict(stud, at=[0, 0, .015])
        with self.assertRaisesRegex(ValueError, r"part boss \(copy 0\) is buried .* mm inside board; move it onto the surface"):
            one([board, buried], mats, size=(.6, .4, .05))
        loose = dict(buried, surface=False)
        self.assertEqual(one([board, loose], mats, size=(.6, .4, .05)).detail["surfaceDetails"], {})

    def test_protrusion_can_be_declared(self):
        mats = [{"id": "oak", "finish": "wood"}, {"id": "iron", "finish": "metal"}]
        board = {"id": "board", "op": "box", "material": "oak", "size": [.6, .4, .04], "bevel": 0, "at": [0, 0, .02]}
        stud = {"id": "stud", "op": "sphere", "material": "iron", "radius": .01, "at": [0, 0, .04], "surface": {"protrude": .016}}
        plan = one([board, stud], mats, size=(.6, .4, .06))
        inst = next(i for i in plan.instances if i.part == "stud")
        top, _ = host_height(inst, [i for i in plan.instances if i.part == "board"])
        self.assertAlmostEqual(top, .016, delta=1e-4)


class Determinism(unittest.TestCase):
    def test_detail_pass_is_deterministic_for_spec_and_seed(self):
        for name in ("arch", "crate", "lantern"):
            with self.subTest(name):
                a, b = fixture(name), fixture(name)
                self.assertEqual(signature(a), signature(b))
                self.assertEqual(a.detail, b.detail)
                self.assertEqual(a.warnings, b.warnings)
        # Masonry does not depend on the seed (only scatter and noise do).
        walls = lambda plan: [s for s in signature(plan) if s[0].startswith("wall#")]
        self.assertEqual(walls(fixture("arch", seed=1)), walls(fixture("arch", seed=9)))


if __name__ == "__main__":
    unittest.main()
