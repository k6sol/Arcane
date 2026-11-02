"""Actual NumPy rock textures and geometry; no Blender, provider or Studio."""
from pathlib import Path
import hashlib
import importlib.util
import json
import sys
import unittest

sys.dont_write_bytecode = True
import numpy as np
import worker_paths
import procedural
import textures

ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / "tests/fixtures/materials/textures-512-baseline.py"
BASELINE_SHA = "b18c8d4cbce4c63a84ed3abc1acc6aec353372aa7f1dcc899cd4dc2eb4556a72"


def request(resolution=None):
    spec = {"kind": "rock", "form": "boulder", "size": [1.6, 1.2, .9], "roughness": .7, "moss": False, "finish": "natural"}
    if resolution is not None:
        spec["textureResolution"] = resolution
    return {"procedural": spec, "seed": 31, "triangleBudget": 6000, "name": "rock-detail", "color": [.2, .19, .17]}


class RockTextureResolutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raw = BASELINE.read_bytes().replace(b"\r\n", b"\n")
        if hashlib.sha256(raw).hexdigest() != BASELINE_SHA:
            raise ValueError("Frozen512 baseline changed")
        spec = importlib.util.spec_from_file_location("arcane_rock_512_baseline", BASELINE)
        cls.baseline = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.baseline)
        cls.mesh = procedural.plan(request())[0][2]
        cls.bake = procedural.rock_bake(cls.mesh)

    def pixels(self, module, size):
        return module.tree_pixels("rock-boulder", [.2, .19, .17], 0, 31, size, extent=1.6, bake=self.bake)

    def test_default512_pixels_remain_exactly_the_frozen_production_output(self):
        before, after = self.pixels(self.baseline, 512), self.pixels(textures, 512)
        for role in before:
            np.testing.assert_array_equal(before[role], after[role])

    def test_selected_resolution_does_not_mutate_geometry_uvs_or_budget(self):
        original = json.dumps(self.bake, sort_keys=True)
        for size in [512, 1024]:
            current = request(size)
            mesh = procedural.plan(current)[0][2]
            self.assertEqual(json.dumps(procedural.rock_bake(mesh), sort_keys=True), original)
            self.assertEqual(mesh.triangles(), 5488)
            self.assertEqual(procedural.surface_materials(current)[0]["surface"], {"profile": "stone", "resolution": size})
        self.assertEqual(procedural.surface_materials(request())[0]["surface"]["resolution"], 512)

    def test_1024_maps_are_finite_opaque_and_have_unit_tangent_normals(self):
        maps = self.pixels(textures, 1024)
        self.assertEqual(set(maps), {"baseColor", "normal", "metallicRoughness"})
        for pixels in maps.values():
            self.assertEqual(pixels.dtype, np.float32)
            self.assertEqual(pixels.shape, (1024 * 1024 * 4,))
            self.assertTrue(np.isfinite(pixels).all())
            self.assertGreaterEqual(float(pixels.min()), 0)
            self.assertLessEqual(float(pixels.max()), 1)
            self.assertTrue((pixels.reshape(-1, 4)[:, 3] == 1).all())
        vectors = maps["normal"].reshape(-1, 4)[:, :3] * 2 - 1
        np.testing.assert_allclose(np.linalg.norm(vectors, axis=1), 1, atol=2e-6)
        self.assertGreater(float(maps["baseColor"].reshape(-1, 4)[:, :3].std()), .005)

    def test_full_tile_triangle_covers_expected_world_texels_with_bounded_scratch(self):
        grids = []
        class Grid:
            def __getitem__(self, item):
                out = np.mgrid[item]
                grids.append(out[0].size)
                if out[0].size > 512 * 512:
                    raise AssertionError("Unbounded high-resolution raster scratch")
                return out
        class Proxy:
            mgrid = Grid()
            def __getattr__(self, name):
                return getattr(np, name)
        bake = {"vertices": [[0, 0, 0], [1, 0, 0], [0, 1, 0]], "faces": [[0, 1, 2]],
                "uvs": [[[0, 0], [1, 0], [0, 1]]], "normals": [[0, 0, 1]] * 3,
                "mossNormals": [[0, 0, 1]] * 3, "cavity": [0] * 3, "tunnel": [0] * 3}
        maps, filled, texels = textures._rasterise(Proxy(), bake, 1024)
        self.assertTrue(grids)
        self.assertLessEqual(max(grids), 512 * 512)
        for x, y in [(0, 0), (900, 20), (20, 900), (256, 256)]:
            index = y * 1024 + x
            self.assertTrue(filled[index] and texels[index])
            np.testing.assert_allclose(maps[index, :3], [(x + .5) / 1024, (y + .5) / 1024, 0], atol=1e-10)
            np.testing.assert_allclose(maps[index, -2:], [1 / 1024] * 2, atol=1e-10)
        self.assertGreater(int(texels.sum()), 500000)

    def test_unsupported_sizes_refuse_before_authoring(self):
        for size in [256, 2048, 4096]:
            with self.subTest(size=size), self.assertRaisesRegex(ValueError, "512 or 1024"):
                textures._rock_surface(np, np.random.default_rng(31), [.2, .19, .17], size, "boulder", 1.6, False, self.bake)


if __name__ == "__main__":
    unittest.main()
