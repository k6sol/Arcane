"""Synthetic worker contract tests: AST-isolated functions, no bpy import/process.

Exercises production identity/export-evidence code against owned byte fixtures.
This is not Blender round-trip, render, exporter or Studio acceptance evidence.
"""
import ast
import hashlib
import json
import struct
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "workers" / "blender" / "asset_worker.py"
tree = ast.parse(SOURCE.read_text(encoding="utf-8"), filename=str(SOURCE))
names = {"semantic_id", "stamp_import_identity", "exported_import_evidence"}
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
assert len(functions) == len(names)
namespace = {"hashlib": hashlib, "json": json, "struct": struct}
# Compile ONLY these reviewed function definitions. No module imports, main,
# modeling, operator calls, discovery, runtime probes or worker spawning.
exec(compile(ast.Module(body=functions, type_ignores=[]), str(SOURCE), "exec"), namespace)
semantic_id = namespace["semantic_id"]
stamp = namespace["stamp_import_identity"]
exported = namespace["exported_import_evidence"]


class Object(dict):
    def __init__(self, role, key):
        super().__init__(arcane_role=role, arcane_source_key=key)
        self.parent = None


def glb(nodes):
    doc = {"asset": {"version": "2.0", "generator": "Khronos glTF Blender I/O v4.5.0"}, "nodes": nodes}
    raw = json.dumps(doc).encode("utf-8")
    raw += b" " * ((-len(raw)) % 4)
    return struct.pack("<IIIII", 0x46546C67, 2, 20 + len(raw), len(raw), 0x4E4F534A) + raw


class ProducerContract(unittest.TestCase):
    def setUp(self):
        self.request = {"template": "environment-kit", "name": "test-kit"}
        self.meshes = [Object("render", "floor"), Object("render", "wall")]
        self.proxies = [Object("collision", "floor"), Object("collision", "wall")]
        stamp(self.request, self.meshes, [], self.proxies, [])

    def test_source_bytecode_is_disabled_before_local_audit_and_assembly_imports(self):
        settings = [node for node in tree.body if isinstance(node, ast.Assign)
                    and any(isinstance(target, ast.Attribute)
                            and isinstance(target.value, ast.Name) and target.value.id == "sys"
                            and target.attr == "dont_write_bytecode" for target in node.targets)]
        self.assertEqual(len(settings), 1, "Require one unconditional module-level cache guard")
        setting = settings[0]
        sys_imports = [node for node in tree.body if isinstance(node, ast.Import)
                       and any(alias.name == "sys" and alias.asname in (None, "sys") for alias in node.names)]
        self.assertTrue(any(node.lineno < setting.lineno for node in sys_imports))
        local_imports = [node for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
                         and node.module in {"audit", "assembly"}]
        self.assertEqual({node.module for node in local_imports}, {"audit", "assembly"})
        for node in local_imports:
            self.assertLess(setting.end_lineno, node.lineno, "Disable bytecode before each local import")
        isolated = {"sys": SimpleNamespace(dont_write_bytecode=False)}
        # Execute only the cache setting, without loading bpy or either local module.
        exec(compile(ast.Module(body=[setting], type_ignores=[]), str(SOURCE), "exec"), isolated)
        self.assertIs(isolated["sys"].dont_write_bytecode, True)

    def test_ids_use_explicit_semantic_keys_and_survive_job_and_order_changes(self):
        expected = "arcane_" + hashlib.sha256(b"arcane-semantic-v1\0environment-kit\0test-kit\0render\0floor").hexdigest()
        self.assertEqual(self.meshes[0]["arcane_source_object_id"], expected)
        before = [obj["arcane_source_object_id"] for obj in self.meshes]
        stamp({**self.request, "seed": 999, "jobId": "different-job"}, list(reversed(self.meshes)), [], self.proxies, [])
        self.assertEqual(before, [obj["arcane_source_object_id"] for obj in self.meshes])
        self.assertNotEqual(expected, semantic_id({**self.request, "name": "new-name"}, "render", "floor"))

    def test_collision_pairing_is_explicit_and_custom_recipe_proxies_are_model_level(self):
        self.assertEqual(json.loads(self.proxies[0]["arcane_collision_for"]), [self.meshes[0]["arcane_source_object_id"]])
        stamp({**self.request, "template": "custom-assembly"}, self.meshes, [], self.proxies, [])
        self.assertEqual(json.loads(self.proxies[0]["arcane_collision_for"]), sorted(obj["arcane_source_object_id"] for obj in self.meshes))

    def test_missing_or_duplicate_source_keys_do_not_get_fallback_ids(self):
        with self.assertRaises(ValueError):
            stamp(self.request, [Object("render", None)], [], [], [])
        with self.assertRaises(ValueError):
            stamp(self.request, [Object("render", "same"), Object("render", "same")], [], [], [])

    def test_evidence_is_from_actual_exported_bytes_and_node_indices(self):
        nodes = [{"mesh": i, "extras": dict(obj)} for i, obj in enumerate(reversed(self.meshes))]
        raw = glb(nodes)
        with tempfile.TemporaryDirectory(prefix="arcane-worker-contract-") as directory:
            path = Path(directory) / "asset.glb"
            path.write_bytes(raw)
            result = exported(path, self.meshes, [])
        self.assertEqual(result["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(result["byteLength"], len(raw))
        self.assertEqual(result["generator"], "Khronos glTF Blender I/O v4.5.0")
        self.assertEqual(result["objects"][0]["sourceObjectId"], self.meshes[1]["arcane_source_object_id"])
        self.assertEqual(result["objects"][0]["nodeIndex"], 0)

    def test_export_lost_identity_or_duplicate_nodes_fail(self):
        nodes = [{"mesh": i, "extras": dict(obj)} for i, obj in enumerate(self.meshes)]
        for mutated in [[{**nodes[0], "extras": {}}, nodes[1]], [nodes[0], nodes[0]], [nodes[0]]]:
            with tempfile.TemporaryDirectory(prefix="arcane-worker-contract-") as directory:
                path = Path(directory) / "asset.glb"
                path.write_bytes(glb(mutated))
                with self.assertRaises(ValueError):
                    exported(path, self.meshes, [])

    def test_invalid_or_oversized_glb_header_fails_before_json_load(self):
        with tempfile.TemporaryDirectory(prefix="arcane-worker-contract-") as directory:
            path = Path(directory) / "asset.glb"
            raw = bytearray(glb([]))
            struct.pack_into("<I", raw, 12, 1024 * 1024 + 4)
            path.write_bytes(raw)
            with self.assertRaises(ValueError):
                exported(path, self.meshes, [])


if __name__ == "__main__":
    unittest.main()
