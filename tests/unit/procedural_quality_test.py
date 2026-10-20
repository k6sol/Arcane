"""Pure planning checks for original closed geometry and explicit UV0, not render-quality evidence."""
import importlib.util
import math
import sys
import unittest
import types
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("procedural_quality", ROOT / "workers/blender/procedural.py")
procedural = importlib.util.module_from_spec(spec)
spec.loader.exec_module(procedural)


def request(params, seed=31, budget=16000):
    return {"name": "quality", "procedural": params, "seed": seed, "triangleBudget": budget, "color": [.22, .18, .14]}


def tree(species="oak"):
    return {"kind": "tree", "species": species, "height": 9, "trunkTaper": .55, "branchLevels": 3,
            "leafDensity": .9, "trunkRadius": None, "secondaryColor": [.12, .25, .06], "finish": "natural"}


class ProceduralQuality(unittest.TestCase):
    def test_uv0_is_finite_bounded_and_noncollapsed_on_every_closed_part(self):
        cases = [tree(species) for species in ("oak", "pine", "birch", "palm")] + [
            {"kind": "rock", "size": [1.6, 1.2, .9], "roughness": .7, "finish": "natural"},
            {"kind": "column", "radius": .35, "height": 4, "flutes": 20, "base": "attic", "capital": "corinthian", "finish": "natural"},
        ]
        for params in cases:
            with self.subTest(params=params):
                for key, _, mesh in procedural.plan(request(params)):
                    self.assertEqual(len(mesh.uvs), len(mesh.faces))
                    for face, uv in zip(mesh.faces, mesh.uvs):
                        self.assertEqual(len(face), len(uv))
                        self.assertTrue(all(math.isfinite(c) and -1e-7 <= c <= 1 + 1e-7 for point in uv for c in point), key)
                        area = abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(uv, uv[1:] + uv[:1]))) / 2
                        self.assertGreater(area, 1e-9, key)

    def test_leaf_is_curved_and_has_a_continuous_multisample_rim(self):
        leaf = procedural.MeshData()
        leaf.leaf((0, 0, 0), (1, 0, 0), (0, 0, 1), .4, .2, .006)
        self.assertEqual(leaf.triangles(), procedural.leaf_triangles(), "Budget planner must include the actual curved leaf cost")
        x = {round(vertex[0], 6) for vertex in leaf.vertices}
        z = {round(vertex[2], 6) for vertex in leaf.vertices}
        self.assertGreater(len(x), 4, "A broadleaf silhouette needs more than the old diamond corners")
        self.assertGreater(len(z), 3, "Cup, tip curl and closed thickness must survive in geometry")
        self.assertEqual(min(vertex[0] for vertex in leaf.vertices), 0)
        self.assertEqual(max(vertex[0] for vertex in leaf.vertices), .4)

    def test_finish_adapter_is_bounded_and_keeps_existing_material_count(self):
        natural = request(tree())
        materials = procedural.surface_materials(natural)
        self.assertEqual([m["id"] for m in materials], ["Bark", "Leaves"])
        # Natural oak/birch/pine author 512 px species bark tiles and leaf/needle-spray cutout atlases.
        self.assertEqual([m["surface"] for m in materials], [{"profile": "bark", "resolution": 512}, {"profile": "leaf", "resolution": 512}])
        pine = procedural.surface_materials(request(tree("pine")))
        self.assertEqual([(m["pattern"], m["surface"]["resolution"]) for m in pine], [("pine-bark", 512), ("pine-leaves", 512)])
        self.assertTrue(all(m["metallic"] == 0 for m in materials))
        natural["procedural"].pop("finish")
        self.assertEqual(procedural.surface_materials(natural), [], "Legacy requests retain their flat finish")

    def test_trusted_relief_hook_rejects_nonfinite_or_unbounded_settings(self):
        # No Blender: invalid inputs are refused before any image/object operation.
        previous = sys.modules.get("bpy")
        sys.modules["bpy"] = types.ModuleType("bpy")
        try:
            module_spec = importlib.util.spec_from_file_location("textures_quality", ROOT / "workers/blender/textures.py")
            textures = importlib.util.module_from_spec(module_spec)
            module_spec.loader.exec_module(textures)
            empty = {"seed": 1, "recipe": {"materials": []}}
            textures.author_surfaces(empty, None, [])
            textures.author_surfaces(empty, None, [], normal_relief=.005)
            for value in [float("nan"), float("inf"), 0, -.01, .1, True, "low"]:
                with self.subTest(value=value), self.assertRaises(ValueError):
                    textures.author_surfaces(empty, None, [], normal_relief=value)
        finally:
            if previous is None:
                del sys.modules["bpy"]
            else:
                sys.modules["bpy"] = previous


if __name__ == "__main__":
    unittest.main()
