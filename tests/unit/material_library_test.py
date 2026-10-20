"""Procedural PBR material library (workers/blender/materials): determinism, exact tiling,
value ranges, normal-map validity and convention, parameter bounds, mesh-aware bake effects and
legacy texture bytes. Pure Python + NumPy, no bpy."""
import hashlib
import importlib.util
import math
import random
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "workers" / "blender" / "materials"))
sys.path.insert(1, str(ROOT / "workers" / "blender"))
import numpy as np  # noqa: E402
import mat_core as C  # noqa: E402
import mat_library as L  # noqa: E402
import mat_metrics as M  # noqa: E402

SIZE = 128


def digest(result):
    return hashlib.sha256(b"".join(result["maps"][k].astype(np.float32).tobytes() for k in sorted(result["maps"]))).hexdigest()


def plane_samples(size=128, metres=1.0, normal=(0, 0, 1), edge=None, cavity=None):
    """A flat square of ``metres`` facing ``normal`` covering the whole atlas."""
    t = (np.arange(size) + .5) / size * metres
    b, a = np.meshgrid(t, t, indexing="ij")
    n = np.array(normal, dtype=float)
    n /= np.linalg.norm(n)
    helper = np.array([0, 0, 1.0]) if abs(n[2]) < .9 else np.array([1.0, 0, 0])
    e1 = np.cross(helper, n)
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(n, e1)
    pos = a[..., None] * e1 + b[..., None] * e2
    out = {"position": pos, "normal": np.broadcast_to(n, pos.shape).copy(), "mu": np.full((size, size), metres / size),
           "mv": np.full((size, size), metres / size), "filled": np.ones((size, size), dtype=bool)}
    out["edge"] = np.zeros((size, size)) if edge is None else edge
    out["cavity"] = np.zeros((size, size)) if cavity is None else cavity
    return out


class Catalogue(unittest.TestCase):
    def test_every_requested_family_exists(self):
        wanted = {"wood-planks", "wood-endgrain", "wood-painted", "wood-weathered", "stone-cobble", "stone-ashlar", "stone-slate",
                  "stone-marble", "stone-sandstone", "concrete", "brick", "metal-iron", "metal-rusted", "metal-brass", "metal-steel",
                  "metal-gold", "fabric", "leather", "ceramic", "glass", "ground-foliage", "sand", "snow", "ice", "emissive-runes"}
        self.assertEqual(wanted, set(L.NAMES))
        for name, info in L.describe().items():
            for key in ("color", "scale", "wear", "dirt", "moss", "age"):
                self.assertIn(key, info["params"], name)

    def test_parameters_are_bounded(self):
        with self.assertRaises(L.MaterialError):
            L.tile("brick", {"rust": 1}, size=SIZE)
        with self.assertRaises(L.MaterialError):
            L.tile("brick", {"wear": 1.5}, size=SIZE)
        with self.assertRaises(L.MaterialError):
            L.tile("brick", {"color": [1, 2, 0]}, size=SIZE)
        with self.assertRaises(L.MaterialError):
            L.tile("no-such-material", size=SIZE)
        with self.assertRaises(L.MaterialError):
            L.tile("brick", size=2048)


class Determinism(unittest.TestCase):
    def test_same_request_same_bytes(self):
        for name in ("wood-planks", "stone-cobble", "metal-rusted", "emissive-runes"):
            a, b = L.tile(name, {"wear": .5, "dirt": .5, "moss": .3}, size=SIZE, seed=9), L.tile(name, {"wear": .5, "dirt": .5, "moss": .3}, size=SIZE, seed=9)
            self.assertEqual(digest(a), digest(b), name)
            self.assertEqual(L.evidence_json(a), L.evidence_json(b), name)

    def test_seed_and_params_change_output(self):
        base = digest(L.tile("brick", size=SIZE, seed=1))
        self.assertNotEqual(base, digest(L.tile("brick", size=SIZE, seed=2)))
        self.assertNotEqual(base, digest(L.tile("brick", {"dirt": .9}, size=SIZE, seed=1)))


class Tiling(unittest.TestCase):
    def test_every_family_is_exactly_periodic(self):
        """Evaluating the tile shifted by half a period equals rolling the maps by half the size."""
        for name in L.NAMES:
            fn, group, profile, tile_m, prm = L.resolve(name, {"wear": .4, "dirt": .4, "moss": .3})
            ref = L._run(np, name, C.tile_domain(np, SIZE, tile_m, 5), prm, group, profile, {})
            dom = C.tile_domain(np, SIZE, tile_m, 5)
            dom.p[:, 0] += tile_m / 2
            dom.f[:, 0] += tile_m / 2
            dom.p[:, 1] += tile_m / 2
            dom.f[:, 1] += tile_m / 2
            shifted = L._run(np, name, dom, prm, group, profile, {})
            for role in ("baseColor", "normal", "metallicRoughness"):
                rolled = np.roll(np.roll(ref["maps"][role], -SIZE // 2, 0), -SIZE // 2, 1)
                diff = np.abs(shifted["maps"][role] - rolled)
                self.assertLess(float((diff > 2 / 255).mean()), .002, name + " " + role)

    def test_seam_metric_flags_a_real_seam(self):
        result = L.tile("stone-marble", size=SIZE, seed=3)
        self.assertLessEqual(max(result["evidence"]["metrics"]["seamRatio"].values()), M.THRESHOLDS["seamRatio"])
        broken = {k: v.copy() for k, v in result["maps"].items()}
        # A gentle ramp across the tile: smooth inside, a hard step where it wraps.
        broken["baseColor"][..., :3] *= np.linspace(.55, 1.0, SIZE)[None, :, None]
        self.assertTrue(any("continuous" in e for e in M.measure(np, broken)["errors"]))

    def test_texel_density_matches_uv_engine_tile_mode(self):
        result = L.tile("brick", size=512, tile_m=2.0)
        self.assertEqual(result["evidence"]["texelsPerMetre"], 256.0)
        self.assertEqual(result["evidence"]["tileMetres"], 2.0)


class Ranges(unittest.TestCase):
    def test_every_family_passes_its_validation(self):
        for name in L.NAMES:
            for params in ({}, {"wear": 1, "dirt": 1, "moss": 1, "age": 1, "snow": 1}):
                result = L.tile(name, params, size=SIZE, seed=4)
                self.assertEqual(result["evidence"]["metrics"]["errors"], [], (name, params))

    def test_metals_are_metals_and_dielectrics_are_not(self):
        for name in ("metal-steel", "metal-gold", "metal-brass"):
            m = L.tile(name, {"dirt": 0, "wear": 0, "age": 0}, size=SIZE)["evidence"]["metrics"]
            self.assertGreater(m["metallicShare"], .9, name)
            self.assertGreater(m["metalLumP5"], .3, name)
        for name in ("brick", "fabric", "wood-planks", "snow"):
            m = L.tile(name, {} if name != "wood-planks" else {"seams": 0}, size=SIZE)["evidence"]["metrics"]
            self.assertLess(m["metallicShare"], .01, name)

    def test_range_checks_catch_bad_maps(self):
        maps = L.tile("brick", size=SIZE)["maps"]
        dark = {k: v.copy() for k, v in maps.items()}
        dark["baseColor"][..., :3] = 0
        self.assertTrue(any("charcoal" in e for e in M.measure(np, dark)["errors"]))
        metal = {k: v.copy() for k, v in maps.items()}
        metal["metallicRoughness"][..., 2] = 1
        metal["baseColor"][..., :3] = .1
        self.assertTrue(any("metal albedo" in e for e in M.measure(np, metal)["errors"]))
        self.assertTrue(any("BLEND" in e for e in M.measure(np, maps, alpha_mode="BLEND")["errors"]))


class Normals(unittest.TestCase):
    def test_unit_length_outward_and_unbiased(self):
        for name in L.NAMES:
            n = L.tile(name, size=SIZE)["maps"]["normal"][..., :3] * 2 - 1
            self.assertTrue(np.allclose(np.linalg.norm(n, axis=-1), 1, atol=1e-5), name)
            self.assertGreater(float(n[..., 2].min()), .2, name)
            self.assertLess(abs(float(n[..., 0].mean())), .06, name)
            self.assertLess(abs(float(n[..., 1].mean())), .06, name)

    def test_opengl_green_channel(self):
        """Height rising toward +v tilts the normal toward -v: green below .5 (OpenGL, +Y = +v),
        the convention Roblox SurfaceAppearance and the studio import path declare."""
        dom = C.tile_domain(np, SIZE, 1.0, 0)
        height = .002 * np.sin(2 * math.pi * dom.p[:, 1])
        n = C.normals(np, dom, height).reshape(SIZE, SIZE, 3)
        rising = np.cos(2 * math.pi * dom.p[:, 1]).reshape(SIZE, SIZE) > .5
        self.assertTrue((n[..., 1][rising] < 0).all())
        right = .002 * np.sin(2 * math.pi * dom.p[:, 0])
        n = C.normals(np, dom, right).reshape(SIZE, SIZE, 3)
        self.assertTrue((n[..., 0][np.cos(2 * math.pi * dom.p[:, 0]).reshape(SIZE, SIZE) > .5] < 0).all())

    def test_normal_check_catches_invalid_maps(self):
        maps = L.tile("concrete", size=SIZE)["maps"]
        bad = {k: v.copy() for k, v in maps.items()}
        bad["normal"][..., :3] = .5
        errors = M.measure(np, bad)["errors"]
        self.assertTrue(any("unit length" in e for e in errors) or any("into the surface" in e for e in errors))


class Roblox(unittest.TestCase):
    def test_delivery_contract(self):
        r = L.tile("emissive-runes", size=SIZE)
        ev = r["evidence"]
        self.assertEqual(ev["normalConvention"], "OpenGL")
        self.assertEqual(ev["colorSpace"]["baseColor"], "sRGB")
        self.assertEqual(ev["channels"]["metallicRoughness"], ["occlusion", "roughness", "metallic", "one"])
        self.assertIn(ev["alphaMode"], ("OPAQUE", "MASK"))
        self.assertGreater(ev["emissiveStrength"], 0)
        self.assertIn("emissive", r["maps"])
        self.assertTrue((r["maps"]["baseColor"][..., 3] == 1).all())
        for size in (128, 256, 512, 1024):
            self.assertIn(size, C.SIZES)
        self.assertEqual(C.MAX_SIZE, 1024)


class Bake(unittest.TestCase):
    def test_bake_is_deterministic_and_valid(self):
        s = plane_samples()
        a = L.bake("stone-ashlar", s, {"wear": .5, "dirt": .5}, seed=3)
        b = L.bake("stone-ashlar", plane_samples(), {"wear": .5, "dirt": .5}, seed=3)
        self.assertEqual(digest(a), digest(b))
        self.assertEqual(a["evidence"]["metrics"]["errors"], [])
        self.assertEqual(a["evidence"]["mode"], "bake")

    def test_edges_wear_and_cavities_collect_dirt(self):
        edge = np.zeros((128, 128))
        edge[:, :20] = 1
        cav = np.zeros((128, 128))
        cav[:, -20:] = 1
        r = L.bake("metal-iron", plane_samples(edge=edge, cavity=cav), {"wear": .8, "dirt": .8}, seed=2)
        ao = r["maps"]["metallicRoughness"][..., 0]
        self.assertLess(float(ao[:, -20:].mean()), float(ao[:, 40:80].mean()))
        base = r["maps"]["baseColor"][..., :3].mean(-1)
        self.assertLess(float(base[:, -20:].mean()), float(base[:, 40:80].mean()))
        rough = r["maps"]["metallicRoughness"][..., 1]
        self.assertNotAlmostEqual(float(rough[:, :20].mean()), float(rough[:, 40:80].mean()), places=2)

    def test_moss_and_snow_settle_on_up_facing_surfaces(self):
        for key in ("moss", "snow"):
            up = L.bake("stone-cobble", plane_samples(normal=(0, 0, 1)), {key: .7}, seed=1)["evidence"]["coverage"]
            side = L.bake("stone-cobble", plane_samples(normal=(1, 0, 0)), {key: .7}, seed=1)["evidence"]["coverage"]
            down = L.bake("stone-cobble", plane_samples(normal=(0, 0, -1)), {key: .7}, seed=1)["evidence"]["coverage"]
            k = "mossy" if key == "moss" else "snowy"
            self.assertGreater(up[k], side[k] + .1, key)
            self.assertLess(down[k], .01, key)

    def test_parts_frame_follows_each_part(self):
        samples = plane_samples()
        samples["part"] = np.zeros((128, 128), dtype=np.int64)
        samples["partAxes"] = np.array([[[0, 1.0, 0], [1.0, 0, 0], [0, 0, -1.0]]])
        samples["partCentres"] = np.zeros((1, 3))
        r = L.bake("wood-planks", samples, {"seams": 0}, seed=1, frame="parts")
        self.assertEqual(r["evidence"]["metrics"]["errors"], [])


class Legacy(unittest.TestCase):
    def test_legacy_texture_bytes_unchanged(self):
        spec = importlib.util.spec_from_file_location("legacy_textures", ROOT / "workers" / "blender" / "textures.py")
        textures = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(textures)
        px = textures.tree_pixels("oak-bark", (.3, .2, .1), 0.0, 1234, 512)
        h = hashlib.sha256(b"".join(px[k].tobytes() for k in ("baseColor", "normal", "metallicRoughness"))).hexdigest()
        self.assertEqual(h, "ab2a8dbea075b63061d6beb6d2f438e5805128edb25bf95ca48000c8bf32fb58")
        phases = [random.Random(5 + i).random() * math.tau for i in range(4)]
        values = [textures.pattern(p, phases, u / 7, v / 5) for p in ("bark", "leaf", "stone", "weathered") for u in range(7) for v in range(5)]
        self.assertEqual(hashlib.sha256(repr(values).encode()).hexdigest(), "edf453335dd6d63272bf036ec471b357ab0b0d82669850c5476123cc28812d0b")


if __name__ == "__main__":
    unittest.main()
