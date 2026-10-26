"""Pure geometry diagnostics and controlled caller tests; no bpy or native process."""
from copy import deepcopy
from pathlib import Path
import importlib.util
import struct
import sys
import unittest
from unittest.mock import patch


REPOSITORY = Path(__file__).resolve().parents[2]
SOURCE = REPOSITORY / "workers" / "blender" / "conversion_audit.py"
WORKER = REPOSITORY / "workers" / "blender" / "convert_glb.py"
SPEC = importlib.util.spec_from_file_location("arcane_conversion_geometry", SOURCE)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)
WORKER_SPEC = importlib.util.spec_from_file_location("arcane_conversion_geometry_worker", WORKER)
worker = importlib.util.module_from_spec(WORKER_SPEC)
with patch.dict(sys.modules, {"conversion_audit": audit}), patch.object(sys, "path", list(sys.path)), patch.object(sys, "dont_write_bytecode", True):
    WORKER_SPEC.loader.exec_module(worker)


def corners():
    return [
        {"POSITION": [0, 0, 0], "NORMAL": [0, 0, 1000000], "TANGENT": [1000000, 0, 0, 1000000],
         "TEXCOORD_0": [0, 0], "COLOR_0": [1000000, 0, 0, 1000000]},
        {"POSITION": [1000000, 0, 0], "NORMAL": [0, 0, 1000000], "TANGENT": [1000000, 0, 0, 1000000],
         "TEXCOORD_0": [1000000, 0], "COLOR_0": [0, 1000000, 0, 1000000]},
        {"POSITION": [0, 1000000, 0], "NORMAL": [0, 0, 1000000], "TANGENT": [1000000, 0, 0, 1000000],
         "TEXCOORD_0": [0, 1000000], "COLOR_0": [0, 0, 1000000, 1000000]},
    ]


def rows(triangle):
    return [audit.triangle_key(triangle)]


def actual_source():
    """A real indexed planar triangle with FLOAT accessors, not a native audit."""
    doc = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}], "bufferViews": [], "accessors": [],
           "meshes": [{"primitives": [{"attributes": {}}]}]}
    chunks = []
    primitive = doc["meshes"][0]["primitives"][0]
    for name in ("POSITION", "NORMAL", "TANGENT", "TEXCOORD_0", "COLOR_0"):
        values = [[component / 1000000 for component in corner[name]] for corner in corners()]
        raw = struct.pack("<" + "f" * sum(len(value) for value in values), *(n for value in values for n in value))
        view = len(doc["bufferViews"])
        doc["bufferViews"].append({"buffer": 0, "byteOffset": sum(map(len, chunks)), "byteLength": len(raw)})
        primitive["attributes"][name] = len(doc["accessors"])
        doc["accessors"].append({"bufferView": view, "componentType": 5126, "count": 3, "type": "VEC" + str(len(values[0]))})
        if name == "POSITION":
            doc["accessors"][-1].update({"min": [0, 0, 0], "max": [1, 1, 0]})
        chunks.append(raw)
    raw = struct.pack("<HHH", 0, 1, 2)
    primitive["indices"] = len(doc["accessors"])
    doc["bufferViews"].append({"buffer": 0, "byteOffset": sum(map(len, chunks)), "byteLength": len(raw)})
    doc["accessors"].append({"bufferView": len(doc["bufferViews"]) - 1, "componentType": 5123, "count": 3, "type": "SCALAR"})
    chunks.append(raw)
    doc["buffers"] = [{"byteLength": sum(map(len, chunks))}]
    return doc, b"".join(chunks)


class ConversionGeometryDiagnosticsTests(unittest.TestCase):
    def refused(self, reason, expected_rows, actual_rows):
        with self.assertRaises(audit.ConversionFailure) as failure:
            audit.require_geometry_match(audit.geometry_hash(expected_rows), audit.geometry_hash(actual_rows),
                                         audit.geometry_projection_hashes(expected_rows), audit.geometry_projection_hashes(actual_rows))
        self.assertEqual(failure.exception.reason, reason)
        self.assertEqual(str(failure.exception), reason)

    def test_each_single_semantic_group_identifies_the_refused_projection(self):
        names = {"POSITION": "POSITION", "NORMAL": "NORMAL", "TANGENT": "TANGENT", "UV": "TEXCOORD_0", "COLOR": "COLOR_0"}
        original = rows(corners())
        for group, name in names.items():
            with self.subTest(group=group):
                changed = corners()
                changed[0][name][0] += 1
                self.refused("GEOMETRY_HASH_" + group, original, rows(changed))

    def test_cyclic_corner_dictionary_and_triangle_reordering_preserve_the_original_digest(self):
        first = corners()
        second = deepcopy(first)
        for corner in second:
            corner["POSITION"][2] = 1000000
        original = rows(first) + rows(second)
        reordered = [dict(reversed(list(corner.items()))) for corner in first[1:] + first[:1]]
        changed = rows(second[2:] + second[:2]) + rows(reordered)
        self.assertEqual(audit.geometry_hash(original), audit.geometry_hash(changed))
        self.assertEqual(audit.geometry_projection_hashes(original), audit.geometry_projection_hashes(changed))
        audit.require_geometry_match(audit.geometry_hash(original), audit.geometry_hash(changed))

    def test_opposite_winding_is_still_refused(self):
        original = corners()
        self.refused("GEOMETRY_HASH_POSITION", rows(original), rows([original[0], original[2], original[1]]))

    def test_matching_marginals_cannot_accept_wrong_uv_to_position_association(self):
        original = corners()
        changed = deepcopy(original)
        for index in range(3):
            changed[index]["TEXCOORD_0"] = original[(index + 1) % 3]["TEXCOORD_0"]
        before, after = rows(original), rows(changed)
        self.assertEqual(audit.geometry_projection_hashes(before), audit.geometry_projection_hashes(after))
        self.assertNotEqual(audit.geometry_hash(before), audit.geometry_hash(after))
        self.refused("GEOMETRY_HASH_CORNER_ASSOCIATION", before, after)

    def test_duplicate_triangle_multiplicity_is_not_deduplicated(self):
        original = rows(corners())
        self.refused("GEOMETRY_HASH_POSITION", original + original, original)
        self.refused("GEOMETRY_HASH_POSITION", original, original + original)

    def test_all_uv_and_color_layers_participate_in_their_projection(self):
        for prefix, group, width in (("TEXCOORD_", "UV", 2), ("COLOR_", "COLOR", 4)):
            for layer in range(8):
                with self.subTest(group=group, layer=layer):
                    original = corners()
                    for corner in original:
                        for at in range(1, 8):
                            corner[prefix + str(at)] = [0] * width
                    changed = deepcopy(original)
                    changed[1][prefix + str(layer)][0] += 1
                    self.refused("GEOMETRY_HASH_" + group, rows(original), rows(changed))

    def test_first_differing_group_uses_fixed_priority(self):
        original = rows(corners())
        changed = corners()
        changed[0]["POSITION"][0] += 1
        changed[0]["NORMAL"][0] += 1
        changed[0]["COLOR_0"][0] += 1
        self.refused("GEOMETRY_HASH_POSITION", original, rows(changed))

    def test_absent_semantics_have_stable_empty_projections_without_invented_attributes(self):
        original = [{"POSITION": corner["POSITION"]} for corner in corners()]
        before = deepcopy(original)
        projected = audit.geometry_projection_hashes(rows(original))
        self.assertEqual(set(projected), {"POSITION", "NORMAL", "TANGENT", "UV", "COLOR"})
        self.assertEqual(projected["NORMAL"], projected["COLOR"])
        self.assertEqual(before, original)
        self.refused("GEOMETRY_HASH_POSITION", rows(original), rows([original[0], original[2], original[1]]))

    def test_missing_or_malformed_diagnostic_projections_cannot_accept_a_mismatch(self):
        good = audit.geometry_projection_hashes(rows(corners()))
        for invalid in (None, {}, {**good, "private-name": "a" * 64}, {**good, "NORMAL": "not-a-digest"}, {**good, "UV": 0}):
            with self.subTest(projection=invalid):
                with self.assertRaises(audit.ConversionFailure) as failure:
                    audit.require_geometry_match("a" * 64, "b" * 64, good, invalid)
                self.assertEqual(failure.exception.reason, "GEOMETRY_HASH")

    def test_diagnostic_hints_add_no_new_acceptance_condition(self):
        digest = audit.geometry_hash(rows(corners()))
        self.assertIsNone(audit.require_geometry_match(digest, digest, {"POSITION": "a" * 64}, None))

    def test_straddling_millionths_boundary_is_still_a_refusal_without_new_tolerance(self):
        original = corners()
        changed = deepcopy(original)
        original[0]["POSITION"][0] = audit.quantize(0.12345649)
        changed[0]["POSITION"][0] = audit.quantize(0.12345651)
        self.assertNotEqual(original[0]["POSITION"][0], changed[0]["POSITION"][0])
        self.refused("GEOMETRY_HASH_POSITION", rows(original), rows(changed))

    def test_actual_source_accessor_projection_preserves_the_existing_geometry_result(self):
        doc, binary = actual_source()
        before = deepcopy(doc)
        ordinary = audit.primitive_geometry(doc, binary, 0, 0)
        projections = {}
        observed = audit.primitive_geometry(doc, binary, 0, 0, diagnostic_hashes=projections)
        self.assertEqual(observed, ordinary)
        self.assertEqual(observed[0], audit.geometry_hash(rows(corners())))
        self.assertEqual(observed[2], 1)
        self.assertEqual(projections, audit.geometry_projection_hashes(rows(corners())))
        self.assertEqual(doc, before)

    def controlled_measurement(self, actual_rows, triangle_count=1):
        doc, binary = actual_source()
        digest, semantics, _triangles, _world = audit.primitive_geometry(doc, binary, 0, 0)
        part = {"sourceKey": "node0_primitive0", "sourceNodeIndex": 0, "sourcePrimitiveIndex": 0, "triangles": 1}
        mapping = {"parts": [part], "sourceSceneIndex": 0}
        evidence = {part["sourceKey"]: {"geometry": digest, "semantics": semantics}}
        actual = {"sourceKey": part["sourceKey"], "triangles": triangle_count, "geometrySha256": audit.geometry_hash(actual_rows)}

        def measure(_object, _part, _source_hash, _semantics, _bpy, diagnostic_rows=None, expected_geometry=None):
            self.assertEqual(expected_geometry, digest)
            if actual["geometrySha256"] != expected_geometry:
                diagnostic_rows.extend(actual_rows)
            return actual

        with patch.object(audit, "measure", measure):
            return worker.measured_rows(None, {part["sourceKey"]: object()}, mapping,
                                        {"sourceSha256": "a" * 64}, evidence, doc, binary), actual

    def test_controlled_measurement_boundary_refuses_and_redecodes_actual_source(self):
        changed = corners()
        changed[0]["NORMAL"][0] += 1
        with self.assertRaises(audit.ConversionFailure) as failure:
            self.controlled_measurement(rows(changed))
        self.assertEqual(failure.exception.reason, "GEOMETRY_HASH_NORMAL")

    def test_controlled_measurement_success_returns_unchanged_audit_row_and_does_no_projection_work(self):
        with patch.object(audit, "geometry_projection_hashes", side_effect=AssertionError("unexpected diagnostic work")):
            observed, actual = self.controlled_measurement(rows(corners()))
        self.assertEqual(observed, [actual])
        self.assertEqual(set(observed[0]), {"sourceKey", "triangles", "geometrySha256"})

    def test_original_triangle_count_refusal_precedes_semantic_hint_work(self):
        with patch.object(audit, "geometry_projection_hashes", side_effect=AssertionError("unexpected diagnostic work")):
            with self.assertRaises(audit.ConversionFailure) as failure:
                self.controlled_measurement(rows(corners()), triangle_count=2)
        self.assertEqual(failure.exception.reason, "GEOMETRY_TRIANGLES")


if __name__ == "__main__":
    unittest.main()
