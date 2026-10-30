"""Diagnostic classifier tests need only stdlib, never a Blender or product session."""
import ast
import json
from pathlib import Path
import unittest


class WorkerFailureTests(unittest.TestCase):
    def setUp(self):
        worker = Path(__file__).resolve().parents[2] / "workers" / "blender" / "asset_worker.py"
        parsed = ast.parse(worker.read_text(encoding="utf-8"))
        functions = [node for node in parsed.body if isinstance(node, ast.FunctionDef) and node.name == "failure_report"]
        self.assertEqual(len(functions), 1)
        self.scope = {"_failure_stage": "review-render", "_failure_artifact": "preview-hero.png", "_failure_metrics": None, "_failure_audit": False}
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


if __name__ == "__main__":
    unittest.main()
