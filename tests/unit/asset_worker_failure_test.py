"""Diagnostic classifier tests need only stdlib, never a Blender or product session."""
import ast
import json
from pathlib import Path
import unittest


class WorkerFailureTests(unittest.TestCase):
    def setUp(self):
        worker = Path(__file__).resolve().parents[2] / "workers" / "blender" / "asset_worker.py"
        parsed = ast.parse(worker.read_text(encoding="utf-8"))
        functions = [node for node in parsed.body if isinstance(node, ast.FunctionDef) and node.name in ("failure_report", "mesh_audit_reason")]
        self.assertEqual(len(functions), 2)
        self.scope = {"_failure_stage": "review-render", "_failure_artifact": "preview-hero.png", "_failure_metrics": None,
                      "_failure_audit": False, "_failure_mesh_reason": None}
        exec(compile(ast.Module(body=functions, type_ignores=[]), "bundled_failure_classifier", "exec"), self.scope)

    def report(self, error):
        return self.scope["failure_report"](error)

    def test_unknown_exceptions_explain_safe_type_and_stage_without_exception_text(self):
        for error, code in [(RuntimeError("private-key and C:/private/source.py"), "BLENDER_OPERATION"),
                            (AttributeError("private attribute"), "BLENDER_API"),
                            (TypeError("private request body"), "INTERNAL_TYPE"),
                            (MemoryError("private allocation"), "MEMORY_LIMIT"),
                            (FileNotFoundError("C:/private/source.py"), "FILE_MISSING"),
                            (PermissionError("C:/private/source.py"), "FILE_ACCESS")]:
            with self.subTest(error=type(error).__name__):
                report = self.report(error)
                self.assertEqual(report["stage"], "review-render")
                self.assertEqual(report["artifactPath"], "preview-hero.png")
                self.assertEqual(report["reasonCode"], code)
                self.assertEqual(report["exceptionType"], type(error).__name__)
                self.assertNotIn("private", json.dumps(report))

    def test_operator_context_and_known_generator_failures_are_classified(self):
        self.assertEqual(self.report(RuntimeError("Operator poll() failed, context is incorrect"))["reasonCode"], "BLENDER_CONTEXT")
        self.assertEqual(self.report(ValueError("Column is too short for its base and capital"))["reasonCode"], "PROCEDURAL_LIMIT")
        self.scope["_failure_artifact"] = "preview-structure.png"
        structure = self.report(ValueError("Tree structure render dimensions changed"))
        self.assertEqual(structure["reasonCode"], "RENDER_CONTENT")
        self.assertEqual(structure["artifactPath"], "preview-structure.png")
        for reason in ["Foliage has no emitted wood skin", "Foliage has no emitted wood skin at its planned root",
                       "Foliage root moved outside its emitted branch skin"]:
            self.assertEqual(self.report(ValueError(reason))["reasonCode"], "FOLIAGE_ATTACHMENT")
        for reason in ["Invalid trusted oak leaf scale", "Oak leaf atlas density exceeds its trusted bound"]:
            self.assertEqual(self.report(ValueError(reason))["reasonCode"], "FOLIAGE_SCALE")
        self.assertEqual(self.report(ValueError("Review render is empty, uniform or nonfinite"))["reasonCode"], "RENDER_CONTENT")

    def test_only_written_audit_is_referenced_and_counters_are_retained(self):
        self.scope["_failure_stage"] = "mesh-validation"
        self.scope["_failure_metrics"] = {"renderTriangles": 1080, "triangleBudget": 100, "errorCount": 1}
        error = ValueError("Asset mesh gate failed: private mesh name")
        self.assertNotIn("auditPath", self.report(error))
        self.scope["_failure_audit"] = True
        report = self.report(error)
        self.assertEqual(report["auditPath"], "audit.json")
        self.assertEqual(report["metrics"]["renderTriangles"], 1080)
        self.assertNotIn("private", json.dumps(report))

    def test_measured_material_categories_retain_written_audit_and_safe_counters(self):
        for errors, expected in [(["Missing named node material"], "MESH_MATERIAL_NODE"),
                                 (["Invalid material node link"], "MESH_MATERIAL_LINK"),
                                 (["Material surface is disconnected"], "MESH_MATERIAL_SURFACE"),
                                 (["Missing PBR shader", "Invalid PBR Metallic", "Invalid PBR Roughness"], "MESH_MATERIAL_PBR")]:
            with self.subTest(code=expected):
                meshes = [{"name": "private mesh C:/private/source.py", "errors": errors}, {"name": "private clean mesh", "errors": []}]
                global_errors = [meshes[0]["name"] + ": " + error for error in errors]
                reason = self.scope["mesh_audit_reason"](meshes, global_errors)
                self.assertEqual(reason, expected)
                metrics = {"renderTriangles": 10310, "triangleBudget": 16000, "collisionTriangles": 12,
                           "errorCount": len(errors), "invalidMeshes": 1}
                self.scope.update(_failure_stage="mesh-validation", _failure_artifact=None, _failure_audit=True,
                                  _failure_metrics=metrics, _failure_mesh_reason=reason)
                report = self.report(ValueError("Asset mesh gate failed: private mesh and token"))
                self.assertEqual(report["reasonCode"], expected)
                self.assertEqual(report["metrics"], metrics)
                self.assertEqual(report["stage"], "mesh-validation")
                self.assertEqual(report["auditPath"], "audit.json")
                self.assertNotIn("private", json.dumps(report))

    def test_material_labels_never_hide_mixed_geometry_unknown_or_global_errors(self):
        node = {"name": "private", "errors": ["Missing named node material"]}
        for other in ["nonManifoldEdges: 1", "UV foldedFraction 0.01 above (0.005)", "private arbitrary failure",
                      "Material surface is disconnected"]:
            meshes = [node, {"name": "private other", "errors": [other]}]
            errors = [mesh["name"] + ": " + error for mesh in meshes for error in mesh["errors"]]
            self.assertEqual(self.scope["mesh_audit_reason"](meshes, errors), "MESH_AUDIT")
        for extra in ["Render triangle budget failed", "Global material budget failed", "Collision budget failed"]:
            self.assertEqual(self.scope["mesh_audit_reason"]([node], ["private: Missing named node material", extra]), "MESH_AUDIT")
        for meshes, errors in [(None, []), ([node], []), ([node], ["different source: Missing named node material"]),
                               ([{"name": "private", "errors": [None]}], ["private"]), ([node], [None])]:
            self.assertEqual(self.scope["mesh_audit_reason"](meshes, errors), "MESH_AUDIT")

    def test_exception_text_and_unwritten_or_wrong_stage_audits_cannot_mint_material_reason(self):
        error = ValueError("Asset mesh gate failed: private Missing named node material")
        self.assertEqual(self.report(error)["reasonCode"], "MESH_AUDIT")
        self.scope.update(_failure_mesh_reason="MESH_MATERIAL_NODE", _failure_metrics={"errorCount": 1}, _failure_stage="mesh-validation")
        self.assertEqual(self.report(error)["reasonCode"], "MESH_AUDIT")
        self.scope.update(_failure_audit=True, _failure_stage="texture-authoring")
        self.assertEqual(self.report(error)["reasonCode"], "MESH_AUDIT")
        self.scope.update(_failure_mesh_reason="private arbitrary code", _failure_stage="mesh-validation")
        report = self.report(error)
        self.assertEqual(report["reasonCode"], "MESH_AUDIT")
        self.assertNotIn("private", json.dumps(report))


if __name__ == "__main__":
    unittest.main()
