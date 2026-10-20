"""Automatic material inference for model specs (workers/blender/grammar/model_materials.py).

Pure: no bpy. Every fixture spec gets a library family per slot without naming one; the choice is
deterministic, explicit choices win, context tags steer weathering, and an optional learned
preference module can bias the family.
"""
import copy
import json
import sys
import types
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
import worker_paths  # noqa: E402,F401
import model_materials as M  # noqa: E402
import model_spec  # noqa: E402

FIXTURES = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted((ROOT / "tests" / "fixtures" / "model-specs").glob("*.json"))}


def run(name, mutate=None, masonry=()):
    doc = copy.deepcopy(FIXTURES[name])
    if mutate:
        mutate(doc["spec"])
    spec = model_spec.validate(doc["spec"])
    out = M.infer(spec, doc["spec"], doc["name"], masonry)
    return out, {e["material"]: e for e in out["materials"]}


class Inference(unittest.TestCase):
    def test_fixtures_get_sensible_families_without_naming_any(self):
        want = {"arch": {"granite": "stone-ashlar"}, "barrel": {"oak": "wood-planks", "iron": "metal-iron"},
                "bench": {"teak": "wood-planks", "iron": "metal-iron"}, "column": {"marble": "stone-marble"},
                "crate": {"pine": "wood-planks", "iron": "metal-iron"}, "fountain": {"stone": "stone-marble", "water": None},
                "lantern": {"iron": "metal-iron", "brass": "metal-brass", "glass": None},
                "sword": {"steel": "metal-steel", "gold": "metal-gold", "leather": "leather"}}
        for name, families in want.items():
            with self.subTest(name):
                _, by = run(name)
                for mid, family in families.items():
                    self.assertEqual(by[mid]["library"], family)
                    self.assertEqual(by[mid]["source"], "inferred" if family else "finish")
                    if family:
                        self.assertTrue(by[mid]["reasons"])

    def test_geometric_masonry_takes_blockless_stone(self):
        _, plain = run("arch")
        _, cut = run("arch", masonry=("granite",))
        self.assertEqual(plain["granite"]["library"], "stone-ashlar")
        self.assertEqual(cut["granite"]["library"], "stone-sandstone")
        # Colour is compensated for the sandstone palette tint so grey stays grey.
        self.assertGreater(cut["granite"]["params"]["color"][2], .5)

    def test_deterministic(self):
        for name in FIXTURES:
            self.assertEqual(json.dumps(run(name)[0], sort_keys=True), json.dumps(run(name)[0], sort_keys=True))

    def test_explicit_choices_win(self):
        def named(s):
            s["materials"][0].update(library="metal-rusted", wear=.9, color=[.2, .3, .4], moss=.5)
        _, by = run("barrel", named)
        oak = by["oak"]
        self.assertEqual((oak["library"], oak["source"]), ("metal-rusted", "explicit"))
        self.assertEqual((oak["params"]["wear"], oak["params"]["moss"], oak["params"]["color"]), (.9, .5, [.2, .3, .4]))
        _, by = run("barrel", lambda s: s["materials"][0].update(library="none"))
        self.assertEqual((by["oak"]["library"], by["oak"]["source"]), (None, "explicit"))
        self.assertEqual(by["iron"]["source"], "inferred")

    def test_canonical_defaults_do_not_count_as_explicit(self):
        # The host writes finish defaults into the canonical spec; they must not pin weathering.
        canon = lambda s: s["materials"][0].update(wear=model_spec.FINISHES["stone"][3], cavity=model_spec.FINISHES["stone"][4])
        _, base = run("arch", lambda s: s.update(context=["ancient"]))
        _, filled = run("arch", lambda s: (s.update(context=["ancient"]), canon(s)))
        self.assertEqual(base["granite"]["params"], filled["granite"]["params"])

    def test_context_tags_steer_weathering(self):
        _, new = run("arch", lambda s: s.update(context=["new"]))
        _, default = run("arch")
        _, ancient = run("arch", lambda s: s.update(context=["ancient", "swamp"]))
        p0, p1, p3 = new["granite"]["params"], default["granite"]["params"], ancient["granite"]["params"]
        for key in ("wear", "dirt", "moss"):
            self.assertLessEqual(p0[key], p1[key])
            self.assertLess(p1[key], p3[key])
        self.assertEqual(p0["moss"], 0)
        _, indoor = run("arch", lambda s: s.update(context=["indoor", "castle"]))
        self.assertEqual(indoor["granite"]["params"]["moss"], 0)
        _, snowy = run("arch", lambda s: s.update(context=["snowy"]))
        self.assertGreater(snowy["granite"]["params"]["snow"], 0)
        _, desert = run("arch", lambda s: s.update(context=["desert", "ancient"]))
        self.assertEqual(desert["granite"]["params"]["moss"], 0)
        # Old wet scenes rust dark iron; ancient wood weathers.
        _, old = run("barrel", lambda s: s.update(context=["ancient", "forest"]))
        self.assertEqual((old["oak"]["library"], old["iron"]["library"]), ("wood-weathered", "metal-rusted"))
        # Outdoor objects (by name) grow some moss; neutral props do not.
        self.assertGreater(default["granite"]["params"]["moss"], 0)
        self.assertEqual(run("crate")[1]["pine"]["params"]["moss"], 0)

    def test_context_is_validated(self):
        spec = copy.deepcopy(FIXTURES["arch"]["spec"])
        spec["context"] = ["outdoor", "ancient"]
        self.assertEqual(model_spec.validate(spec)["context"], ["outdoor", "ancient"])
        self.assertNotIn("context", model_spec.validate(FIXTURES["arch"]["spec"]))
        for bad in (["Outdoor"], "outdoor", ["x"] * 9, [1]):
            spec["context"] = bad
            with self.assertRaises(model_spec.SpecError):
                model_spec.validate(spec)

    def test_geometry_drives_frames_and_planks(self):
        _, barrel = run("barrel")
        self.assertEqual(barrel["oak"]["frame"], "axis")
        self.assertEqual(barrel["oak"]["params"]["joints"], 0)
        _, crate = run("crate")
        self.assertEqual(crate["pine"]["frame"], "parts")
        self.assertEqual((crate["pine"]["params"]["joints"], crate["pine"]["params"]["seams"]), (0, 0))
        # Dark spec iron (a diffuse-style colour) takes the family's metal reflectance.
        self.assertNotIn("color", barrel["iron"]["params"])

    def test_learned_preference_hook(self):
        fake = types.ModuleType("preferences")
        fake.materialBias = lambda q: {"families": {"metal-steel": 20.0}, "params": {"wear": .2}} if q["material"] == "iron" else None
        sys.modules["preferences"] = fake
        try:
            _, by = run("barrel")
        finally:
            del sys.modules["preferences"]
        self.assertEqual(by["iron"]["library"], "metal-steel")
        self.assertIn("learned preference", by["iron"]["reasons"])
        self.assertEqual(by["oak"]["library"], "wood-planks")
        _, plain = run("barrel")
        self.assertAlmostEqual(by["iron"]["params"]["wear"], plain["iron"]["params"]["wear"] + .2, places=3)


if __name__ == "__main__":
    unittest.main()
