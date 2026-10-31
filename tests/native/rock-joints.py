"""Exercise boulder material controls with the pinned runtime's actual NumPy."""
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests/unit"))
import bpy
import rock_joints_test

suite = unittest.defaultTestLoader.loadTestsFromModule(rock_joints_test)
result = unittest.TextTestRunner().run(suite)
assert result.wasSuccessful() and result.testsRun == 7 and not result.skipped
print("ARCANE_ROCK_JOINTS_OK " + json.dumps({"cases": result.testsRun, "blender": bpy.app.version_string}))
