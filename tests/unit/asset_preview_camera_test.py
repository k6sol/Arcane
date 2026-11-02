"""Execute the actual pure worker camera planner, without Blender or network."""
import ast
import math
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[2] / "workers/blender/asset_worker.py"
parsed = ast.parse(SOURCE.read_text(encoding="utf-8"))
node = next(node for node in parsed.body if isinstance(node, ast.FunctionDef) and node.name == "review_camera_offset")
scope = {"math": math}
exec(compile(ast.Module(body=[node], type_ignores=[]), str(SOURCE), "exec"), scope)
plan = scope["review_camera_offset"]


class PreviewCameraTests(unittest.TestCase):
    def test_original_side_camera_ray_plane_crosses_the_ground(self):
        span, half_height, target_height = 1.6, 1.44, .45
        old = (-4 * span, 0, .5 * span)
        up_height = abs(old[0]) / math.hypot(*old)
        self.assertLess(target_height + old[2] - half_height * up_height, -.0648)
        fixed = plan((-4, 0, .5), span, half_height * 2)
        self.assertGreater(target_height + fixed[2] - half_height * up_height, .1 * span)

    def test_floor_clearance_and_projection_direction_across_asset_scales(self):
        for span in [.001, .1, 1.6, 10, 200]:
            for offset in [(2.6, -3.5, 2.3), (-4, 0, .5), (2, -3, .1)]:
                with self.subTest(span=span, offset=offset):
                    actual = plan(offset, span, span * 1.8)
                    length = math.sqrt(sum(value ** 2 for value in offset))
                    up_height = math.hypot(offset[0], offset[1]) / length
                    self.assertGreaterEqual(actual[2] - .9 * span * up_height, .1 * span - 1e-10)
                    distance = math.sqrt(sum(value ** 2 for value in actual))
                    for component, original in zip(actual, offset):
                        self.assertAlmostEqual(component / distance, original / length)

    def test_established_hero_projection_does_not_move(self):
        for span in [.1, 1, 200]:
            for actual, expected in zip(plan((2.6, -3.5, 2.3), span, span * 1.8), (2.6 * span, -3.5 * span, 2.3 * span)):
                self.assertAlmostEqual(actual, expected)

    def test_invalid_plans_refuse_before_rendering(self):
        for args in [((1, 0, 0), 1, 1), ((1, 0, -1), 1, 1), ((1, 0, 1), 0, 1), ((1, 0, 1), 1, -1), ((1, 0, float("nan")), 1, 1), ((1, 0, 1), float("inf"), 1)]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                plan(*args)


if __name__ == "__main__":
    unittest.main()
