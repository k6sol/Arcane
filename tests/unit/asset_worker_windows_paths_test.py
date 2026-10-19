"""Behavior tests for the worker path adapter; Blender is not imported."""
import ast
import ctypes
import ntpath
import os
from pathlib import Path
import types
import unittest
from unittest import mock

source = str(Path(os.path.abspath(__file__)).parents[2] / "workers" / "blender" / "asset_worker.py")
if os.name == "nt" and not source.startswith("\\\\?\\"):
    source = "\\\\?\\" + source
tree = ast.parse(Path(source).read_text(encoding="utf-8"))


class FakePath:
    targets = {}

    def __init__(self, value):
        self.value = value

    def __str__(self):
        return self.value

    @property
    def parent(self):
        return FakePath(ntpath.dirname(self.value))

    @property
    def name(self):
        return ntpath.basename(self.value)

    def __truediv__(self, name):
        return FakePath(ntpath.join(self.value, name))

    def is_absolute(self):
        return ntpath.isabs(self.value)

    def resolve(self, strict=False):
        return self.targets.get(self.value, self.value)


class ShortPathCall:
    def __init__(self, value, count=None):
        self.value, self.count, self.calls = value, count, []

    def __call__(self, original, output, capacity):
        self.calls.append(original)
        output.value = self.value
        return len(self.value) if self.count is None else self.count


def function(name, namespace):
    node = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), source, "exec"), namespace)
    return namespace[name]


class WindowsPathTests(unittest.TestCase):
    def setUp(self):
        FakePath.targets = {}
        self.adapt = function("blender_path", {"Path": FakePath})

    def invoke(self, path, alias, count=None):
        call = ShortPathCall(alias, count)
        host = types.SimpleNamespace(GetShortPathNameW=call)
        with mock.patch.object(os, "name", "nt"), mock.patch.object(ctypes, "WinDLL", return_value=host, create=True):
            result = self.adapt(FakePath(path))
        return result, call

    def test_short_windows_path_never_queries_alias(self):
        with mock.patch.object(os, "name", "nt"), mock.patch.object(ctypes, "WinDLL", side_effect=AssertionError("unexpected alias dependency"), create=True):
            self.assertEqual(self.adapt(FakePath("\\\\?\\C:\\job\\asset.blend")), "C:\\job\\asset.blend")
            self.assertEqual(self.adapt(FakePath("\\\\?\\UNC\\server\\share\\job\\asset.glb")), "\\\\server\\share\\job\\asset.glb")

    def test_non_windows_path_is_unchanged(self):
        with mock.patch.object(os, "name", "posix"):
            value = "/tmp/" + "a" * 400 + "/asset.blend"
            self.assertEqual(self.adapt(FakePath(value)), value)

    def test_alias_must_resolve_to_exact_original_parent(self):
        path = "\\\\?\\C:\\" + "a" * 280 + "\\asset.blend"
        alias = "\\\\?\\C:\\JOB~1"
        FakePath.targets[alias] = ntpath.dirname(path)
        result, call = self.invoke(path, alias)
        self.assertEqual(result, "C:\\JOB~1\\asset.blend")
        self.assertEqual(call.calls, [ntpath.dirname(path)])

    def test_unavailable_wrong_relative_oversized_and_still_long_aliases_fail(self):
        path = "\\\\?\\C:\\" + "a" * 280 + "\\asset.blend"
        for alias, count in [("", 0), ("\\\\?\\C:\\WRONG~1", None), ("relative", None), ("\\\\?\\C:\\JOB~1", 32768), ("\\\\?\\C:\\" + "b" * 280, None)]:
            FakePath.targets = {}
            if len(alias) > 260:
                FakePath.targets[alias] = ntpath.dirname(path)
            with self.subTest(alias=alias, count=count):
                with self.assertRaisesRegex(ValueError, "^Windows asset path has no verified short directory alias$"):
                    self.invoke(path, alias, count)

    def test_scene_temporary_at_filename_has_one_character_headroom(self):
        suffix = "\\asset.blend"
        path = "C:\\" + "a" * (259 - 3 - len(suffix)) + suffix
        self.assertEqual(len(path), 259)
        alias = "\\\\?\\C:\\JOB~1"
        FakePath.targets[alias] = ntpath.dirname(path)
        result, _ = self.invoke(path, alias)
        self.assertEqual(result, "C:\\JOB~1\\asset.blend")

    def test_windows_limit_counts_utf16_units_for_non_bmp_paths(self):
        path = "C:\\" + "\U0001f600" * 123 + "\\asset.blend"
        self.assertLess(len(path), 259)
        self.assertGreaterEqual(len(path.encode("utf-16-le")) // 2, 259)
        alias = "\\\\?\\C:\\JOB~1"
        FakePath.targets[alias] = ntpath.dirname(path)
        result, call = self.invoke(path, alias)
        self.assertEqual(result, "C:\\JOB~1\\asset.blend")
        self.assertEqual(len(call.calls), 1)

    def test_path_failure_preserves_stage_and_artifact_without_raw_paths(self):
        report = function("failure_report", {"_failure_stage": "scene-save", "_failure_artifact": "asset.blend", "_failure_metrics": None, "_failure_audit": False})
        self.assertEqual(report(ValueError("Windows asset path has no verified short directory alias")),
                         {"schemaVersion": 1, "stage": "scene-save", "reasonCode": "WINDOWS_PATH_LIMIT", "exceptionType": "ValueError", "artifactPath": "asset.blend"})


if __name__ == "__main__":
    unittest.main()
