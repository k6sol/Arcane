"""Model spec compiler, pure stage: validation, determinism, budgets and watertightness.

Loads workers/blender/grammar (no bpy) and checks the eight fixture specs in
tests/fixtures/model-specs plus every operator: each planned instance is a closed,
consistently wound solid with positive volume and non-mirrored analytic UVs, the plan
fits its triangle budget, and the same (spec, seed) always yields identical geometry.
This is planner evidence, not Blender export or render evidence (see model_build/review).
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
import model_geom as G  # noqa: E402
import model_plan  # noqa: E402
import model_spec  # noqa: E402
from model_sdf import Field, mesh_field  # noqa: E402

FIXTURES = sorted((ROOT / "tests" / "fixtures" / "model-specs").glob("*.json"))


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def request(data, seed=1, budget=None):
    return {"name": data["name"], "seed": seed, "triangleBudget": budget or data["triangleBudget"], "procedural": copy.deepcopy(data["spec"])}


def signature(plan):
    return [(i.key, round(sum(v[0] + 2 * v[1] + 3 * v[2] for v in i.mesh.verts), 9), len(i.mesh.faces)) for i in plan.instances]


def mirrored_uv_faces(mesh):
    bad = 0
    for uv in mesh.uvs:
        area = sum((uv[k][0] - uv[0][0]) * (uv[k + 1][1] - uv[0][1]) - (uv[k + 1][0] - uv[0][0]) * (uv[k][1] - uv[0][1]) for k in range(1, len(uv) - 1))
        bad += area < -1e-12
    return bad


class Validation(unittest.TestCase):
    def test_fixture_specs_validate_with_explicit_defaults(self):
        self.assertEqual(len(FIXTURES), 8)
        for path in FIXTURES:
            with self.subTest(path.name):
                spec = model_spec.validate(load(path)["spec"])
                self.assertEqual(spec["finish"], "natural")
                for m in spec["materials"]:
                    self.assertEqual(set(m), {"id", "finish", "color", "roughness", "metallic", "wear", "cavity"})

    def test_invalid_specs_are_refused_with_actionable_messages(self):
        base = load(FIXTURES[0])["spec"]
        cases = [
            (lambda s: s["parts"][0].update(color=[1, 0, 0]), "unsupported field"),
            (lambda s: s["parts"][0].update(material="gold"), "material must name"),
            (lambda s: s["parts"][0].update(op="teapot"), ".op must be one of"),
            (lambda s: s["parts"].append(dict(s["parts"][0])), "part ids must be unique"),
            (lambda s: s["parts"][0].update(parent=s["parts"][0]["id"]), "cannot name itself"),
            (lambda s: s.update(materials=[{"id": "m%d" % k, "finish": "wood"} for k in range(4)]), "materials needs 1..3"),
            (lambda s: s["parts"].append({"id": "x", "op": "box", "material": s["materials"][0]["id"], "size": [1, 1, 1], "bevel": .6}), "bevel must be less than half"),
            (lambda s: s["parts"].append({"id": "x", "op": "loft", "material": s["materials"][0]["id"],
                                          "sections": [{"z": 1, "shape": {"type": "circle", "r": .1}}, {"z": 0, "shape": {"type": "circle", "r": .1}}]}), "strictly ascend"),
            (lambda s: s["parts"].append({"id": "x", "op": "sphere", "material": s["materials"][0]["id"], "radius": .01, "mirror": "x",
                                          "scatter": {"on": s["parts"][0]["id"], "count": 4}}), "scatter cannot combine"),
            (lambda s: s["parts"].append({"id": "x", "op": "box", "material": s["materials"][0]["id"], "size": [.01, .01, .01],
                                          "array": {"grid": [10, 10, 10], "step": [.02, .02, .02]}}), "more than 640 instances"),
            (lambda s: s["parts"].append({"id": "x", "op": "revolve", "material": s["materials"][0]["id"], "profile": [[0, 0], [.1, 0], [0, .1], [.1, .2], [0, .2]]}), "interior radii"),
            (lambda s: s["parts"].append({"id": "x", "op": "sdf", "material": s["materials"][0]["id"], "shapes": [{"prim": "sphere", "r": .1, "op": "subtract"}]}), "first sdf primitive"),
            (lambda s: s["parts"].append({"id": "x", "op": "box", "material": s["materials"][0]["id"], "size": [1, 1, 1], "radius": 2}), "does not take radius"),
        ]
        for mutate, message in cases:
            with self.subTest(message):
                spec = copy.deepcopy(base)
                mutate(spec)
                with self.assertRaises(model_spec.SpecError) as caught:
                    model_spec.validate(spec)
                self.assertIn(message, str(caught.exception))
                self.assertTrue(str(caught.exception).startswith("Model spec: "))

    def test_unused_material_and_unknown_references_fail(self):
        spec = copy.deepcopy(load(FIXTURES[0])["spec"])
        spec["materials"].append({"id": "spare", "finish": "metal"})
        with self.assertRaisesRegex(model_spec.SpecError, "not used by any solid part"):
            model_spec.validate(spec)
        spec = copy.deepcopy(load(FIXTURES[0])["spec"])
        spec["parts"][0]["parent"] = "ghost"
        with self.assertRaisesRegex(model_spec.SpecError, "unknown part"):
            model_spec.validate(spec)


class Operators(unittest.TestCase):
    def assertSolid(self, mesh, label):
        self.assertTrue(mesh.closed(), label + " is not a closed, consistently wound solid")
        self.assertGreater(mesh.volume(), 0, label + " is inside out")
        self.assertEqual(len(mesh.uvs), len(mesh.faces))
        if not mesh.auto_uv:
            self.assertEqual(mirrored_uv_faces(mesh), 0, label + " has mirrored UVs")

    def test_every_operator_builds_a_closed_outward_solid(self):
        circle = {"type": "circle", "r": .05, "round": 0}
        cases = {
            "box": G.box((1, .5, .3)), "rounded box": G.box((1, .5, .3), .05, .02), "cylinder": G.cylinder(.2, .5, None, .03, .02),
            "cone": G.cylinder(.2, .5, 0, 0, .02), "sphere": G.sphere(.3, .03),
            "revolve": G.revolve([[0, 0], [.3, 0], [.35, .4], [.3, .8], [0, .8]], .02, "smooth"),
            "fluted": G.revolve([[0, 0], [.3, 0], [.3, 3], [0, 3]], .03, "linear", {"count": 20, "depth": .8, "width": .8, "from": .2, "to": 2.8}),
            "ring": G.revolve([[.3, 0], [.32, 0], [.32, .04], [.3, .04]], .02, "linear", None, 0, True),
            "cup": G.revolve([[0, 0], [1, 0], [1, .5], [.9, .5], [.9, .1], [0, .1]], .05),
            "extrude": G.extrude(G.shape_points({"type": "star", "n": 5, "r": .5, "r2": .25, "round": 0}, .05), .2, .02, {"width": .03, "depth": -.02}, .02),
            "loft": G.loft([{"z": 0, "shape": circle, "at": (0, 0), "scale": (1, 1), "rot": 0}, {"z": .5, "shape": circle, "at": (.1, 0), "scale": (2, 1), "rot": 30},
                            {"z": .6, "shape": circle, "at": (0, 0), "scale": (0, 0), "rot": 0}], .01, "smooth"),
            "sweep": G.sweep(G.sample_path({"points": [(0, 0, 0), (.5, 0, .3), (1, 0, 0)], "curve": "catmull", "closed": False}, .02), False,
                             G.shape_points(circle, .01), 90, [[0, 1], [1, .3]]),
            "closed sweep": G.sweep(G.sample_path({"points": [(1, 0, 0), (0, 1, 0), (-1, 0, 0), (0, -1, 0)], "curve": "catmull", "closed": True}, .05), True,
                                    G.shape_points({"type": "rect", "w": .05, "h": .02, "round": 0}, .01)),
            "bezier sweep": G.sweep(G.sample_path({"points": [(0, 0, 0), (0, .3, .2), (.4, .3, .2), (.6, 0, 0)], "curve": "bezier", "closed": False}, .02), False,
                                    G.shape_points(circle, .01), 0, [[0, 1], [1, 0]]),
        }
        for label, mesh in cases.items():
            with self.subTest(label):
                self.assertSolid(mesh, label)
        mirrored = cases["rounded box"].transformed(G.scaling((-1, 1, 1)))
        self.assertSolid(mirrored, "mirrored copy")

    def test_sdf_marching_tetrahedra_is_watertight_and_follows_smooth_booleans(self):
        shapes = [{"prim": "sphere", "at": (0, 0, 0), "rot": (0, 0, 0), "r": .3, "op": "union", "blend": 0, "round": 0},
                  {"prim": "capsule", "at": (0, 0, 0), "rot": (0, 0, 0), "a": (0, 0, 0), "b": (.4, 0, .3), "r": .1, "r2": .05, "op": "union", "blend": .08, "round": 0},
                  {"prim": "box", "at": (0, 0, .25), "rot": (0, 0, 30), "size": (.3, .3, .2), "op": "subtract", "blend": .03, "round": .02}]
        mesh, _ = mesh_field(Field(shapes, {"amp": .01, "scale": .1, "octaves": 2, "warp": .3, "seed": 0, "mask": None}, 7), .04)
        self.assertTrue(mesh.closed())
        self.assertGreater(mesh.volume(), 0)
        # The box cut removed the sphere's crown: nothing remains near the uncut top (0, 0, .3).
        crown = [v for v in mesh.verts if abs(v[0]) < .05 and abs(v[1]) < .05]
        self.assertLess(max(v[2] for v in crown), .2)


class Planner(unittest.TestCase):
    def test_fixture_plans_are_closed_within_budget_and_floor_pivoted(self):
        for path in FIXTURES:
            data = load(path)
            with self.subTest(data["name"]):
                plan = model_plan.plan(request(data))
                self.assertLessEqual(plan.estimated_triangles(), plan.budget)
                solids = plan.solids()
                self.assertTrue(solids)
                for inst in plan.instances:
                    self.assertTrue(inst.mesh.closed(), inst.key)
                    self.assertGreater(inst.mesh.volume(), 0, inst.key)
                    if not inst.auto_uv:
                        self.assertEqual(mirrored_uv_faces(inst.mesh), 0, inst.key)
                low = min(v[2] for i in solids for v in i.mesh.verts)
                self.assertAlmostEqual(low, 0.0, places=9)
                xs = [v[0] for i in solids for v in i.mesh.verts]
                self.assertAlmostEqual((min(xs) + max(xs)) / 2, 0.0, places=9)

    def test_same_spec_and_seed_is_identical_and_seed_moves_scatter(self):
        crate = load(next(p for p in FIXTURES if p.name == "crate.json"))
        a, b = model_plan.plan(request(crate)), model_plan.plan(request(crate))
        self.assertEqual(signature(a), signature(b))
        c = model_plan.plan(request(crate, seed=2))
        nails = lambda plan: [s for s in signature(plan) if s[0].startswith("nail#")]
        self.assertNotEqual(nails(a), nails(c))
        self.assertEqual([s for s in signature(a) if not s[0].startswith("nail#")], [s for s in signature(c) if not s[0].startswith("nail#")])

    def test_budget_scales_tessellation_and_refuses_impossible_budgets(self):
        column = load(next(p for p in FIXTURES if p.name == "column.json"))
        rich, lean = model_plan.plan(request(column, budget=20000)), model_plan.plan(request(column, budget=6000))
        self.assertLessEqual(lean.estimated_triangles(), 6000)
        self.assertGreater(rich.estimated_triangles(), lean.estimated_triangles())
        crate = load(next(p for p in FIXTURES if p.name == "crate.json"))
        with self.assertRaisesRegex(ValueError, "coarsest resolution exceeds"):
            model_plan.plan(request(crate, budget=2500))

    def test_symmetry_arrays_and_scatter_expand_to_the_declared_copies(self):
        lantern = model_plan.plan(request(load(next(p for p in FIXTURES if p.name == "lantern.json"))))
        count = lambda part: sum(1 for i in lantern.instances if i.part == part)
        self.assertEqual(count("post"), 4)       # mirror xy
        self.assertEqual(count("rail_y"), 4)     # array 2 x mirror y
        crate = model_plan.plan(request(load(next(p for p in FIXTURES if p.name == "crate.json"))))
        nails = [i for i in crate.instances if i.part == "nail"]
        self.assertGreater(len(nails), 20)
        # Poisson spacing holds between scattered nails.
        centres = [tuple(sum(v[k] for v in n.mesh.verts) / len(n.mesh.verts) for k in range(3)) for n in nails]
        # Spacing is measured at the surface points; nail centres sit up to sink + radius off them.
        self.assertGreaterEqual(min(math.dist(a, b) for i, a in enumerate(centres) for b in centres[i + 1:]), .07 - 2 * .0055)

    def test_centred_mirror_copies_are_dropped_with_a_warning(self):
        spec = {"kind": "spec", "size": [.2, .2, .2], "materials": [{"id": "oak", "finish": "wood"}],
                "parts": [{"id": "block", "op": "box", "material": "oak", "size": [.2, .2, .2], "mirror": "x"}]}
        plan = model_plan.plan({"name": "m", "seed": 1, "triangleBudget": 4000, "procedural": spec})
        self.assertEqual(len(plan.instances), 1)
        self.assertTrue(any("coincident copies dropped" in w for w in plan.warnings))


if __name__ == "__main__":
    unittest.main()
