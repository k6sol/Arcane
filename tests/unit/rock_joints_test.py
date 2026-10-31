"""Pure boulder-joint material controls; no Blender, export or artistic acceptance."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
import numpy as np  # noqa: E402
import worker_paths  # noqa: E402,F401
import procedural  # noqa: E402
import textures  # noqa: E402


SOURCE = Path(__file__).resolve().parents[2] / "workers/blender/textures.py"
# Complete reviewed e461 module, normalized only from CRLF to LF. Reversing just
# the two reviewed insertions must reproduce it; unrelated source drift is refused.
CONTROL_SHA256 = "c61fd656429570df623b551970ee4103703dc955f393ea323d3ebb29d5262261"
INSERTED_HELPER = '''def _weathered_boulder_joints(np, crack, medium):
    """Interrupt broad joints with existing world-space weathering; consume no randomness."""
    return crack * _smooth(np, .46, .60, medium)


'''
INSERTED_GATE = '''    if form == "boulder":
        crack = _weathered_boulder_joints(np, crack, medium)
'''


def control_text(source):
    source = source.replace("\r\n", "\n")
    if source.count(INSERTED_HELPER) != 1 or source.count(INSERTED_GATE) != 1:
        raise ValueError("Rock control insertions changed")
    source = source.replace(INSERTED_HELPER, "", 1).replace(INSERTED_GATE, "", 1)
    if hashlib.sha256(source.encode("utf8")).hexdigest() != CONTROL_SHA256:
        raise ValueError("Rock complete-module control source drifted")
    return source


def load_control():
    source = control_text(SOURCE.read_bytes().decode("utf8"))
    module = types.ModuleType("reviewed_e461_rock_textures")
    exec(compile(source, "<reviewed-e461-textures>", "exec"), module.__dict__)
    return module


def bake(form):
    size = [1.6, 1.2, .9] if form == "boulder" else [3., 1.5, 2.]
    p = {"kind": "rock", "size": size, "roughness": .7, "form": form, "moss": False, "finish": "natural"}
    request = {"procedural": p, "seed": 31, "triangleBudget": 6000,
               "name": "rock-joints", "color": [.2, .19, .17]}
    mesh = procedural.plan(request)[0][2]
    return procedural.rock_bake(mesh), max(size), mesh.triangles()


def array_hash(value):
    return hashlib.sha256(np.asarray(value).tobytes()).hexdigest()


def surface(module, data, form="boulder", seed=31, moss=False, trace=False):
    mesh, extent, _ = data
    rng = np.random.default_rng(seed)
    fields = []
    original_fbm, original_worley = module._Field.fbm, module._Field.worley

    def fbm(field, *args, **kwargs):
        out = original_fbm(field, *args, **kwargs)
        fields.append(("fbm", args, kwargs, array_hash(out)))
        return out

    def worley(field, density, warp=None):
        out = original_worley(field, density, warp)
        fields.append(("worley", density, tuple(array_hash(a) for a in out)))
        return out

    with patch.object(module._Field, "fbm", fbm if trace else original_fbm), patch.object(module._Field, "worley", worley if trace else original_worley):
        # Production cave geometry uses the rock-outcrop material pattern.
        kind = "boulder" if form == "boulder" else "outcrop"
        out = module._rock_surface(np, rng, [.2, .19, .17], 512, kind, extent, moss, mesh)
    return out, copy.deepcopy(rng.bit_generator.state), fields


class WeatheredRockJoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.control = load_control()
        cls.boulder = bake("boulder")
        cls.before_geometry = hashlib.sha256(json.dumps(cls.boulder[0], sort_keys=True).encode()).hexdigest()
        cls.joint_samples = []
        original = textures._weathered_boulder_joints

        def observe(numpy, crack, medium):
            out = original(numpy, crack, medium)
            cls.joint_samples.append((crack.copy(), out.copy()))
            return out

        with patch.object(textures, "_weathered_boulder_joints", observe):
            cls.after, cls.after_rng, cls.after_fields = surface(textures, cls.boulder, trace=True)
        cls.before, cls.before_rng, cls.before_fields = surface(cls.control, cls.boulder, trace=True)

    def assert_maps_equal(self, before, after):
        for a, b in zip(before, after):
            np.testing.assert_array_equal(a, b)

    def test_complete_control_refuses_unrelated_changes_and_accepts_line_endings(self):
        source = SOURCE.read_bytes().decode("utf8").replace("\r\n", "\n")
        self.assertEqual(control_text(source), control_text(source.replace("\n", "\r\n")))
        with self.assertRaisesRegex(ValueError, "complete-module control source drifted"):
            control_text(source + "\n# unrelated change\n")
        with self.assertRaisesRegex(ValueError, "insertions changed"):
            control_text(source.replace(INSERTED_GATE, ""))

    def test_joint_footprint_is_interrupted_locally_and_retains_strong_segments(self):
        self.assertEqual(len(self.joint_samples), 1)
        before, after = self.joint_samples[0]
        strong = before > .35
        self.assertGreater(int(strong.sum()), 100)
        removed = (after[strong] < .1).mean()
        retained = (after[strong] > .35).mean()
        ratio = after[strong] / before[strong]
        self.assertGreater(removed, .2, "long network portions must actually close, not just become uniformly paler")
        self.assertGreater(retained, .02, "some original joints must remain open")
        self.assertGreater(float(ratio.std()), .15, "a global contrast multiplier is not weathering")
        self.assertTrue((after >= 0).all() and (after <= before).all())
        self.assertTrue((after[before == 0] == 0).all(), "no new cracks may appear away from existing joints")
        print("ROCK_JOINT_FOOTPRINT " + json.dumps({"baselineStrongSamples": int(strong.sum()),
              "closedFraction": float(removed), "retainedStrongFraction": float(retained),
              "attenuationStd": float(ratio.std())}, sort_keys=True))

    def test_identity_gate_negative_control_reproduces_the_complete_old_material(self):
        with patch.object(textures, "_weathered_boulder_joints", lambda numpy, crack, medium: crack):
            identity, state, fields = surface(textures, self.boulder, trace=True)
        self.assert_maps_equal(self.before, identity)
        self.assertEqual(state, self.before_rng)
        self.assertEqual(fields, self.before_fields)

    def test_rng_and_all_unrelated_world_fields_are_exactly_unchanged(self):
        self.assertEqual(self.before_rng, self.after_rng)
        self.assertEqual(self.before_fields, self.after_fields)
        self.assertFalse(np.array_equal(self.before[0], self.after[0]))
        self.assertFalse(np.array_equal(self.before[2], self.after[2]))
        self.assertFalse(np.array_equal(self.before[3], self.after[3]))

    def test_same_seed_is_deterministic_and_material_channels_remain_valid(self):
        again, _, _ = surface(textures, self.boulder)
        self.assert_maps_equal(self.after, again)
        rgb, alpha, normal, rough = self.after
        self.assertTrue(all(np.isfinite(a).all() for a in self.after))
        self.assertTrue((alpha == 1).all())
        self.assertTrue((rgb >= 0).all() and (rgb <= 1).all())
        self.assertTrue((rough >= .4).all() and (rough <= 1).all())
        np.testing.assert_allclose(np.linalg.norm(normal, axis=-1), 1., atol=1e-12)

    def test_outcrop_cave_moss_and_other_material_outputs_are_unchanged(self):
        for form in ("outcrop", "cave"):
            data = bake(form)
            old, old_state, _ = surface(self.control, data, form, moss=True)
            new, new_state, _ = surface(textures, data, form, moss=True)
            self.assert_maps_equal(old, new)
            self.assertEqual(old_state, new_state)
        for pattern in ("oak-bark", "pine-leaves"):
            old = self.control.tree_surface(pattern, [.2, .19, .17], 31, 512)
            new = textures.tree_surface(pattern, [.2, .19, .17], 31, 512)
            self.assert_maps_equal(old, new)

    def test_texture_work_cannot_mutate_geometry_uvs_or_triangle_budget(self):
        after = hashlib.sha256(json.dumps(self.boulder[0], sort_keys=True).encode()).hexdigest()
        self.assertEqual(after, self.before_geometry)
        self.assertEqual(self.boulder[2], 5488)
        self.assertLessEqual(self.boulder[2], 6000)


if __name__ == "__main__":
    unittest.main()
