import base64
from contextlib import contextmanager
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import struct
import tempfile
import unittest
import zlib

ROOT = Path(__file__).resolve().parent.parent
PATH = ROOT / "skills/arcane-vfx/scripts/effect.py"
loader = importlib.util.spec_from_file_location("effect", PATH)
effect = importlib.util.module_from_spec(loader)
loader.loader.exec_module(effect)


def example():
    return json.loads((ROOT / "examples/ember-impact.json").read_text(encoding="utf8"))


@contextmanager
def owned_output():
    # Retain owned artifacts for diagnosis; never use or delete shared host TEMP.
    owner = ROOT / ".test-output"
    owner.mkdir(exist_ok=True)
    path = Path(tempfile.mkdtemp(prefix="unit-", dir=owner)).resolve()
    if path.parent != owner.resolve():
        raise RuntimeError("Test output escaped its owner")
    yield path


class EffectTests(unittest.TestCase):
    def test_all_shipped_examples_fit_their_budgets(self):
        for path in sorted((ROOT / "examples").glob("*.json")):
            with self.subTest(example=path.name):
                value = effect.read_spec(path)
                self.assertGreater(effect.statistics(value)["totalParticles"],0)

    def test_emission_bounds_include_bursts_and_streams(self):
        value = effect.normalize(example())
        bounds = effect.statistics(value)
        self.assertEqual(bounds["totalParticles"], 66)
        self.assertEqual(bounds["peakParticles"], 66)
        self.assertAlmostEqual(bounds["tailEnd"], 2.68)

    def test_precise_ballistic_motion_and_finite_tail(self):
        value = example()
        layer = value["layers"][0]
        layer.update(burst=1, life=[1,1], speed=[4,4], acceleration=[0,-2,0], drag=0)
        value["layers"] = [layer]
        value = effect.normalize(value)
        point = effect.sample(value, .5)[0]
        self.assertEqual(point["position"], [0,1.75,0])
        self.assertEqual(effect.sample(value, 1), [])

    def test_rejects_nonfinite_bool_huge_integer_and_unknown_keys(self):
        for bad in (True, float("nan"), float("inf"), 10**500):
            value = example()
            value["seed"] = bad
            with self.assertRaises(ValueError):
                effect.normalize(value)
        value = example()
        value["layers"][0]["toolbox"] = "anything"
        with self.assertRaisesRegex(ValueError, "unknown fields"):
            effect.normalize(value)

    def test_unsupported_kind_and_invalid_curves_are_refused(self):
        for change in ({"kind":"beam"}, {"alpha":[[0,1],[0,0]]}, {"size":[[0,1],[2,0]]}, {"life":[2,1]}):
            value = example()
            value["layers"][0].update(change)
            with self.assertRaises(ValueError):
                effect.normalize(value)

    def test_budgets_fail_without_truncation(self):
        value = example()
        value["budgets"] = {"peakParticles": 20}
        original = copy.deepcopy(value)
        with self.assertRaisesRegex(ValueError, "authored bound 66"):
            effect.normalize(value)
        self.assertEqual(value, original)

    def test_rate_start_is_one_interval_after_burst(self):
        value = example()
        value["layers"] = [value["layers"][0]]
        value["layers"][0].update(burst=0, rate=10, duration=.3, life=[1,1])
        value = effect.normalize(value)
        self.assertEqual(len(effect.sample(value, .099)), 0)
        self.assertEqual(len(effect.sample(value, .1)), 1)
        self.assertEqual(len(effect.sample(value, .3)), 3)

    def test_original_atlas_gutters_and_seeded_pixel_determinism(self):
        pixels = effect.make_atlas("smoke", 32, 17)
        self.assertEqual(pixels, effect.make_atlas("smoke", 32, 17))
        self.assertNotEqual(pixels, effect.make_atlas("smoke", 32, 18))
        for frame in range(16):
            for y in range(32):
                for x in range(32):
                    if x < 2 or x >= 30 or y < 2 or y >= 30:
                        i = ((frame//4*32+y)*128+frame%4*32+x)*4
                        self.assertEqual(pixels[i+3], 0)

    def test_png_roundtrip_crc_and_alpha(self):
        pixels = effect.make_atlas("ring", 32, 4)
        png = effect.encode_png(128,128,pixels)
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        offset, data = 8, b""
        while offset < len(png):
            size = struct.unpack(">I",png[offset:offset+4])[0]
            kind, body = png[offset+4:offset+8], png[offset+8:offset+8+size]
            crc = struct.unpack(">I",png[offset+8+size:offset+12+size])[0]
            self.assertEqual(zlib.crc32(kind+body)&0xffffffff,crc)
            if kind == b"IDAT":
                data += body
            offset += size+12
        rows = zlib.decompress(data)
        decoded = b"".join(rows[y*513+1:(y+1)*513] for y in range(128))
        self.assertEqual(decoded,pixels)
        self.assertGreater(max(decoded[3::4]), 150)

    def test_duplicate_json_keys_and_nan_are_refused(self):
        with owned_output() as temp:
            file = Path(temp)/"bad.json"
            for text in ('{"version":1,"version":1}', '{"seed":NaN}'):
                file.write_text(text)
                with self.assertRaises(ValueError):
                    effect.read_spec(file)

    def test_two_builds_have_same_artifacts_and_valid_csp(self):
        with owned_output() as temp:
            first = effect.build(example(), Path(temp)/"a",32)
            second = effect.build(example(), Path(temp)/"b",32)
            self.assertEqual(first["artifacts"], second["artifacts"])
            html = (Path(temp)/"a/preview.html").read_text(encoding="utf8")
            script = re.search(r"<script>([\s\S]*)</script>",html)[1]
            digest = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
            self.assertTrue("script-src 'sha256-"+digest+"'" in html, "Generated script bytes must match the CSP hash")
            self.assertNotIn("__SCRIPT",html)
            self.assertEqual(first["networkCalls"],0)
            with self.assertRaisesRegex(ValueError,"new output"):
                effect.build(example(), Path(temp)/"a",32)


if __name__ == "__main__":
    unittest.main()
