"""Private mature-oak atlas compensation, using the real pure worker path.

These checks establish bounded authoring and nominal world-scale compensation,
not visible canopy coverage, alpha minification, export or art acceptance.
Same-host pre-change image-byte captures are an independent release check;
portable tests do not pin floating-image hashes to one NumPy/platform version.
"""
import copy
import math
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
import worker_paths  # noqa: E402,F401
import procedural as P
import textures as T
import variation
try:
    import numpy as np
except ModuleNotFoundError:
    np = None


def request(height=9.0, **params):
    return {"seed": 31, "triangleBudget": 16000, "name": "oak-height-fixture", "color": [.3, .2, .1],
            "procedural": {"kind": "tree", "species": "oak", "height": height, "trunkTaper": .55,
                           "branchLevels": 3, "leafDensity": .7, "trunkRadius": None,
                           "secondaryColor": [.12, .25, .06], "finish": "natural", **params}}


def capture(scale, seed=31, shade=False):
    rng = np.random.default_rng(seed)
    painted, leaves = [], []
    original_twig, original_leaf = T._Canvas.twig, T._Canvas.leaf
    def twig(canvas, points, widths, color):
        painted.append((np.array(points), tuple(widths)))
        return original_twig(canvas, points, widths, color)
    def leaf(canvas, species, rng, base, angle, length, color):
        leaves.append((tuple(base), angle, length))
        return original_leaf(canvas, species, rng, base, angle, length, color)
    with patch.object(T._Canvas, "twig", twig), patch.object(T._Canvas, "leaf", leaf):
        canvas = T._spray(np, rng, "oak", (.12, .25, .06), 128, 256, shade, leaf_scale=scale)
    return canvas, painted, leaves, copy.deepcopy(rng.bit_generator.state)


def segment_distance(point, first, last):
    delta = last - first
    t = min(1., max(0., np.dot(np.array(point) - first, delta) / np.dot(delta, delta)))
    return np.linalg.norm(np.array(point) - first - t * delta)


def linear_alpha(alpha, x, y):
    # Same texel-centre convention as production/native root validation.
    x, y = x - .5, y - .5
    ix, iy = math.floor(x), math.floor(y)
    fx, fy = x - ix, y - iy
    return float(alpha[iy, ix] * (1 - fx) * (1 - fy) + alpha[iy, ix + 1] * fx * (1 - fy)
                 + alpha[iy + 1, ix] * (1 - fx) * fy + alpha[iy + 1, ix + 1] * fx * fy)


class OakHeightMetadata(unittest.TestCase):
    def test_private_metadata_uses_effective_height_without_mutating_variant_request(self):
        for height in (2., 9., 18., 20.):
            source = request(height)
            original = copy.deepcopy(source)
            materials = P.surface_materials(source)
            self.assertEqual(source, original)
            self.assertNotIn("leaf_scale", materials[0])
            self.assertEqual(materials[1].get("leaf_scale", 1.), min(1., 9. / height))
            self.assertEqual(materials[1]["surface"], {"profile": "leaf", "resolution": 512})
            self.assertEqual("leaf_scale" in materials[1], height > 9.)
        # Actual family resolution, including the 20m effective-height clamp.
        for height, member in ((9., 1), (18., 2), (20., 3)):
            source = request(height, variant=[member, 3])
            original = copy.deepcopy(source)
            resolved, _, _ = variation.resolve(source["procedural"], source["seed"], P.SPECIES["oak"]["radius"])
            materials = P.surface_materials(source)
            expected = min(1., 9. / resolved["height"])
            self.assertEqual(materials[1].get("leaf_scale", 1.), expected)
            self.assertEqual("leaf_scale" in materials[1], expected < 1.)
            self.assertEqual(source, original)
            tinted = variation.tint_surfaces(source["procedural"], source["seed"], materials)
            self.assertEqual(tinted[1].get("leaf_scale", 1.), expected)

    def test_other_species_finishes_density_zero_and_rock_extent_are_unchanged(self):
        for species in ("birch", "pine", "palm"):
            self.assertTrue(all("leaf_scale" not in m for m in P.surface_materials(request(18., species=species))))
        self.assertEqual(P.surface_materials(request(18., finish="flat")), [])
        self.assertEqual([m["id"] for m in P.surface_materials(request(18., leafDensity=0))], ["Bark"])
        rock = {**request(), "procedural": {"kind": "rock", "form": "boulder", "size": [2., 3., 4.],
                                            "roughness": .5, "finish": "natural"}}
        material = P.surface_materials(rock)[0]
        self.assertNotIn("leaf_scale", material)
        self.assertEqual(material["extent"], P.rock_extent(rock["procedural"]))

    def test_real_author_finish_and_surface_adapter_forward_only_nondefault_scale(self):
        class AtPixels(Exception):
            pass
        for source in (request(9.), request(18.), request(18., variant=[2, 3])):
            # Stop at the real pure pixel boundary before any bpy material/image use.
            # No Blender module or operation is created by this fixture.
            calls = []
            def pixels(*args, **kwargs):
                calls.append((args, kwargs))
                if args[0] == "oak-leaves":
                    raise AtPixels
                return {role: [] for role, _, _ in T.ROLES}
            # The first bark row also needs to stop before material binding. Drop
            # that row in the trusted adapter input, retaining the real Leaves row.
            original = P.surface_materials
            def only_leaves(value):
                return [m for m in original(value) if m["id"] == "Leaves"]
            with patch.dict(sys.modules, {"bpy": SimpleNamespace()}), patch.object(P, "surface_materials", only_leaves), patch.object(T, "tree_pixels", pixels):
                with self.assertRaises(AtPixels):
                    P.author_finish(source, Path("unused-pure-fixture"), [])
            args, kwargs = calls[0]
            material = original(source)[1]
            expected = material.get("leaf_scale", 1.)
            self.assertEqual(kwargs, {"leaf_scale": expected} if expected < 1. else {})
            texture_seed = variation.texture_seed(source["procedural"], source["seed"]) if source["procedural"].get("variant") else source["seed"]
            import hashlib
            self.assertEqual(args[3], int.from_bytes(hashlib.sha256((str(texture_seed) + ":Leaves").encode()).digest()[:8], "big"))
            self.assertEqual(args[6:9], (False, 1.0, None), "rock extent/bake positional arguments retain their meaning")

    def test_invalid_or_incompatible_scales_are_refused_before_pixel_authoring(self):
        invalid = (True, False, None, ".5", float("nan"), float("inf"), -float("inf"), .44999, 1.00001, 10 ** 1000)
        for value in invalid:
            for function in (T.tree_surface, T.tree_pixels):
                args = ("oak-leaves", (.1, .3, .1), 31, 512) if function is T.tree_surface else ("oak-leaves", (.1, .3, .1), 0., 31, 512)
                with self.subTest(value=str(value)[:20], function=function.__name__), self.assertRaisesRegex(ValueError, "^Invalid trusted oak leaf scale$"):
                    function(*args, leaf_scale=value)
        for pattern in (*[p for p in T.TREE_PATTERNS if p != "oak-leaves"], None):
            with self.subTest(pattern=pattern), self.assertRaisesRegex(ValueError, "^Invalid trusted oak leaf scale$"):
                T.tree_surface(pattern, (.1, .3, .1), 31, 512, leaf_scale=.5)


@unittest.skipIf(np is None, "Actual atlas authoring requires NumPy")
class OakHeightAtlas(unittest.TestCase):
    def test_default_and_explicit_one_are_byte_identical_across_unchanged_patterns(self):
        for pattern in ("oak-leaves", "birch-leaves", "pine-leaves", "oak-bark", "oak-log"):
            with self.subTest(pattern=pattern):
                first = T.tree_pixels(pattern, (.12, .25, .06), 0., 31, 512)
                explicit = T.tree_pixels(pattern, (.12, .25, .06), 0., 31, 512, leaf_scale=1.)
                for role in first:
                    self.assertEqual(first[role].tobytes(), explicit[role].tobytes())

    def test_dense_shoots_are_deterministic_bounded_thin_and_rooted_on_painted_segments(self):
        for scale in (.5, .45):
            for seed in (31, 701):
                with self.subTest(scale=scale, seed=seed):
                    canvas, painted, leaves, state = capture(scale, seed)
                    again = capture(scale, seed)
                    self.assertEqual(leaves, again[2])
                    self.assertEqual(state, again[3])
                    self.assertEqual(len(painted), 1 + math.floor(3 / scale + .5))
                    self.assertTrue(37 < len(leaves) <= 156)
                    self.assertEqual(tuple(painted[0][0][0]), (64., 2.))
                    self.assertGreaterEqual(linear_alpha(canvas.alpha, 64., 2.), 1 - 1 / 255)
                    tips = [points[-1] for points, _ in painted]
                    self.assertEqual([sum(math.dist(base, tip) < 1e-9 for base, *_ in leaves) for tip in tips], [2] + [1] * (len(painted) - 1))
                    for index, (points, widths) in enumerate(painted):
                        w = (2.6 if index == 0 else 1.6) * scale
                        self.assertEqual(widths[0], max(w, 1.25) if index == 0 else w)
                        self.assertEqual(widths[1:], tuple(w * (1 - .55 * k / (len(points) - 1)) for k in range(1, len(points))))
                        for a, b in zip(points, points[1:]):
                            self.assertGreater(np.linalg.norm(b - a), 0.)
                    first, second = painted[0][0][:2]
                    steps = math.ceil(np.linalg.norm(second - first) * 2)
                    for k in range(steps + 1):
                        point = first + (second - first) * k / steps
                        self.assertGreaterEqual(linear_alpha(canvas.alpha, *point), .5)
                    for base, _, length in leaves:
                        self.assertTrue(0 < length <= .21 * 256 * scale)
                        self.assertLess(min(segment_distance(base, a, b) for points, _ in painted for a, b in zip(points, points[1:])), 1e-9)
                    for field in ("rgb", "alpha", "height", "rough"):
                        self.assertTrue(np.isfinite(getattr(canvas, field)).all())
                        np.testing.assert_array_equal(getattr(canvas, field), getattr(again[0], field))

    def test_actual_atlas_path_forwards_scale_to_all_eight_tiles_with_bounded_work(self):
        original = T._spray
        scales, calls = [], []
        original_leaf = T._Canvas.leaf
        def spray(*args, **kwargs):
            scales.append(kwargs.get("leaf_scale", 1.))
            return original(*args, **kwargs)
        def leaf(*args, **kwargs):
            calls.append(1)
            return original_leaf(*args, **kwargs)
        with patch.object(T, "_spray", spray), patch.object(T._Canvas, "leaf", leaf):
            maps = T.tree_pixels("oak-leaves", (.12, .25, .06), 0., 1827007653639644032, 512, leaf_scale=.45)
        self.assertEqual(scales, [.45] * 8)
        self.assertLessEqual(len(calls), 8 * 156)
        self.assertGreater(len(calls), 8 * 37)
        for values in maps.values():
            self.assertEqual(values.shape, (512 * 512 * 4,))
            self.assertTrue(np.isfinite(values).all())
        alpha = maps["baseColor"].reshape(512, 512, 4)[..., 3]
        for row in range(2):
            for col in range(4):
                self.assertGreaterEqual(linear_alpha(alpha, col * 128 + 64., row * 256 + 2.), 1 - 1 / 255)

    def test_density_guard_refuses_an_out_of_contract_cohort_before_leaf_rasterization(self):
        class OversizedCohort:
            def __init__(self):
                self.rng = np.random.default_rng(31)
            def uniform(self, *args):
                return self.rng.uniform(*args)
            def random(self):
                return self.rng.random()
            def integers(self, *args):
                # Simulate an internal cohort regression outside the requested
                # integer bounds; the final work guard must still refuse it.
                return 99
        with patch.object(T._Canvas, "leaf", side_effect=AssertionError("rasterization must not begin")):
            with self.assertRaisesRegex(ValueError, "^Oak leaf atlas density exceeds its trusted bound$"):
                T._spray(np, OversizedCohort(), "oak", (.12, .25, .06), 128, 256, False, leaf_scale=.45)

    def test_same_seed_9_to_18_plan_retains_322_cards_and_compensates_nominal_world_glyph_scale(self):
        parts = [P.plan(request(height)) for height in (9., 18.)]
        leaves = [next(mesh for key, _, mesh in item if key == "leaves") for item in parts]
        self.assertEqual([len(mesh.vertices) // 8 for mesh in leaves], [322, 322])
        scales = [P.surface_materials(request(height))[1].get("leaf_scale", 1.) for height in (9., 18.)]
        self.assertEqual(scales, [1., .5])
        for index in range(0, len(leaves[0].vertices), 8):
            lengths = []
            for mesh in leaves:
                card = mesh.vertices[index:index + 8]
                base = P.mul(P.add(card[0], card[5]), .5)
                tip = P.mul(P.add(card[2], card[3]), .5)
                lengths.append(math.dist(base, tip))
            self.assertAlmostEqual(lengths[1] / lengths[0], 2., places=10)
            # Nominal glyph fraction, before tile clipping/overlap, is multiplied
            # by s. This proves compensation, not identical visible leaf segments.
            self.assertAlmostEqual(lengths[0] * .17 * scales[0], lengths[1] * .17 * scales[1], places=10)
        for item in parts:
            self.assertLessEqual(sum(mesh.triangles() for _, _, mesh in item), 16000)
        original = P.surface_materials
        def no_private_scale(source):
            return [{key: value for key, value in m.items() if key != "leaf_scale"} for m in original(source)]
        with patch.object(P, "surface_materials", no_private_scale):
            without_metadata = P.plan(request(18.))
        self.assertEqual([(m.vertices, m.faces, m.uvs, m.normals) for _, _, m in parts[1]],
                         [(m.vertices, m.faces, m.uvs, m.normals) for _, _, m in without_metadata])


if __name__ == "__main__":
    unittest.main()
