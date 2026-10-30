"""Run bounded atlas contracts with the pinned Blender runtime's actual NumPy."""
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests/unit"))
import bpy
import oak_height_atlas_test

suite = unittest.defaultTestLoader.loadTestsFromModule(oak_height_atlas_test)
result = unittest.TextTestRunner().run(suite)
assert result.wasSuccessful() and result.testsRun == 9 and not result.skipped
print("ARCANE_OAK_HEIGHT_ATLAS_OK " + json.dumps({"cases": result.testsRun, "blender": bpy.app.version_string}))
