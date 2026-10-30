"""Actual pure atlas layout checks, not Blender/alpha-minification/art acceptance.

Capture production _spray calls while retaining the real canvas authoring and
random consumers. Before/after full birch image-byte comparison is a separate
same-host check; portable tests deliberately avoid floating-image hash pins.
"""
import copy
import importlib.util
import math
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
try:
    import numpy as np
except ModuleNotFoundError:
    np = None

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("arcane_oak_spray_layout", ROOT / "workers/blender/textures.py")
T = importlib.util.module_from_spec(spec)
spec.loader.exec_module(T)

# Captured from actual pre-change _spray, source SHA256
# e2cb18bb40157aea41f0e27e8508d688c31549945c8fd0f220e8ae1cbc33a14d.
# PCG64 integer state is independent of floating-image math and shade colour.
RNG_BEFORE = {
    ("oak", 31): (244483955762611536224826904501466795808, 107090353359002252723118071224206516545, 3730491695),
    ("oak", 701): (135630498107803135050283694355255229655, 172627947748720544414426561062464122065, 3853783993),
    ("birch", 31): (71767463896267500736120869132078141161, 107090353359002252723118071224206516545, 2692938797),
    ("birch", 701): (250325123506766968974199770989991663494, 172627947748720544414426561062464122065, 3853783993),
}


def capture(species, seed, shade=False):
    rng = np.random.Generator(np.random.PCG64(seed))
    shoots, painted, leaves = [], [], []
    original_shoot, original_twig, original_leaf = T._shoot, T._Canvas.twig, T._Canvas.leaf
    def shoot(*args, **kwargs):
        points = original_shoot(*args, **kwargs)
        shoots.append(tuple(tuple(p) for p in points))
        return points
    def twig(canvas, points, widths, color):
        painted.append((tuple(tuple(p) for p in points), tuple(widths)))
        return original_twig(canvas, points, widths, color)
    def leaf(canvas, species, rng, base, angle, length, color):
        leaves.append((tuple(base), angle, length, tuple(color)))
        return original_leaf(canvas, species, rng, base, angle, length, color)
    with patch.object(T, "_shoot", shoot), patch.object(T._Canvas, "twig", twig), patch.object(T._Canvas, "leaf", leaf):
        canvas = T._spray(np, rng, species, (.12, .25, .06), 128, 256, shade)
    return canvas, shoots, painted, leaves, copy.deepcopy(rng.bit_generator.state)


def segment_distance(point, first, last):
    delta = tuple(b - a for a, b in zip(first, last))
    length2 = sum(v * v for v in delta)
    t = min(1., max(0., sum((p - a) * d for p, a, d in zip(point, first, delta)) / length2))
    nearest = tuple(a + t * d for a, d in zip(first, delta))
    return math.dist(point, nearest)


@unittest.skipIf(np is None, "Actual atlas authoring requires NumPy")
class OakSprayLayout(unittest.TestCase):
    def test_actual_oak_bases_are_continuous_on_painted_shoots_with_small_terminal_rosettes(self):
        for seed in (31, 701):
            for shade in (False, True):
                with self.subTest(seed=seed, shade=shade):
                    _, shoots, painted, leaves, _ = capture("oak", seed, shade)
                    self.assertEqual(len(shoots), 4)
                    self.assertTrue(30 <= len(leaves) <= 37)
                    tips = [points[-1] for points in shoots]
                    counts = [sum(math.dist(base, tip) < 1e-9 for base, *_ in leaves) for tip in tips]
                    self.assertEqual(counts, [2, 1, 1, 1])
                    self.assertEqual(sum(counts), 5, "the previous layout stacked 17–19 leaves at these four tips")
                    for base, *_ in leaves:
                        self.assertLess(min(segment_distance(base, a, b) for points, _ in painted
                                            for a, b in zip(points, points[1:])), 1e-9)
                        if min(math.dist(base, tip) for tip in tips) > 1e-9:
                            self.assertGreater(min(math.dist(base, point) for points in shoots for point in points), 1e-6,
                                               "nonterminal leaves must not snap back to discrete shoot stations")

    def test_painted_root_and_natural_twig_widths_are_unchanged(self):
        for species in ("oak", "birch"):
            for seed in (31, 701):
                with self.subTest(species=species, seed=seed):
                    _, shoots, painted, _, _ = capture(species, seed)
                    self.assertEqual(painted[0][0][0], (64., 2.))
                    self.assertEqual(painted[0][0][1:], shoots[0][1:])
                    for index, ((points, widths), original) in enumerate(zip(painted, shoots)):
                        w = (2.6 if species == "oak" else 1.7) if index == 0 else (1.6 if species == "oak" else 1.1)
                        self.assertEqual(widths, tuple(w * (1 - .55 * k / (len(points) - 1)) for k in range(len(points))))
                        if index:
                            self.assertEqual(points, original)

    def test_existing_rng_consumption_and_birch_discrete_attachment_contract_are_preserved(self):
        for (species, seed), (state, inc, uinteger) in RNG_BEFORE.items():
            for shade in (False, True):
                with self.subTest(species=species, seed=seed, shade=shade):
                    _, shoots, _, leaves, rng = capture(species, seed, shade)
                    self.assertEqual(rng, {"bit_generator": "PCG64", "state": {"state": state, "inc": inc},
                                           "has_uint32": 1, "uinteger": uinteger})
                    if species == "birch":
                        self.assertEqual(len(shoots), 5)
                        self.assertTrue(31 <= len(leaves) <= 42)
                        for base, *_ in leaves:
                            # A main-shoot station can also be a side-shoot's
                            # junction. Coordinate ownership need not be unique.
                            self.assertLess(min(math.dist(base, q) for points in shoots for q in points), 1e-9)

    def test_seeded_authoring_is_deterministic_and_retains_shade_and_seed_variation(self):
        for species in ("oak", "birch"):
            first, again, other, shaded = [capture(species, seed, shade) for seed, shade in
                                           ((31, False), (31, False), (701, False), (31, True))]
            self.assertEqual(first[1:], again[1:])
            self.assertNotEqual(first[3], other[3])
            for field in ("rgb", "alpha", "height", "rough"):
                np.testing.assert_array_equal(getattr(first[0], field), getattr(again[0], field))
                self.assertTrue(np.isfinite(getattr(first[0], field)).all())
            self.assertFalse(np.array_equal(first[0].rgb, shaded[0].rgb))
            for field in ("alpha", "height", "rough"):
                np.testing.assert_array_equal(getattr(first[0], field), getattr(shaded[0], field))


if __name__ == "__main__":
    unittest.main()
