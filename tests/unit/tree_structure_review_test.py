"""Controlled same-object review tests; no Blender, rendering or artistic acceptance.

Import the complete production helper. Only its explicit Blender rendering
boundary is doubled; source hashing, source selection and restoration run here.
"""
import copy
import hashlib
import json
import math
from pathlib import Path
import tempfile
import sys
from types import SimpleNamespace as NS
import unittest
from unittest.mock import MagicMock, patch

import worker_paths
import tree_structure_review as review


REQUEST_HASH = "d" * 64


def semantic(request, role, key):
    return "arcane_" + {"bark": "a", "leaves": "b"}[key] * 64


class Matrix:
    def __iter__(self):
        return iter(((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)))

    def __matmul__(self, value):
        return tuple(value)


class Object(dict):
    def __init__(self, key):
        super().__init__(arcane_role="render", arcane_source_key=key, arcane_identity_scheme="arcane-semantic-v1",
                         arcane_source_object_id=semantic(None, "render", key))
        self.name, self.type, self.hide_render = "original-" + key, "MESH", False
        self.matrix_world = Matrix()
        self.clear_count = 0
        vertex = lambda co: NS(co=list(co), normal=(0, 0, 1))
        self.data = NS(vertices=[vertex((-.3, 0, 0)), vertex((.5, 0, 0)), vertex((0, 0, 2))],
                       loop_triangles=[NS(vertices=(0, 1, 2))], polygons=[NS(vertices=(0, 1, 2), material_index=0, use_smooth=True)],
                       corner_normals=[NS(vector=(0, 0, 1)) for _ in range(3)],
                       uv_layers=[NS(name="UVMap", data=[NS(uv=[0, 0]), NS(uv=[1, 0]), NS(uv=[.5, 1])])], materials=[])
        self.data.calc_loop_triangles = lambda: None
        self.data.as_pointer = lambda: id(self.data)

    def as_pointer(self):
        return id(self)

    def evaluated_get(self, depsgraph):
        return self

    def to_mesh(self):
        return self.data

    def to_mesh_clear(self):
        self.clear_count += 1


def fixture(density=.7):
    request = {"template": "procedural", "procedural": {"kind": "tree", "finish": "natural", "leafDensity": density}, "renderResolution": 129}
    objects = [Object("bark")] + ([Object("leaves")] if density else [])
    rows = [{"name": obj.name, "role": "render"} for obj in objects]
    review.enrich_tree_meshes(request, objects, rows, semantic, None)
    camera = NS(parent=None, rotation_mode='XYZ', location=(1, 2, 3), rotation_euler=(.1, .2, .3),
                data=NS(type='ORTHO', ortho_scale=5, clip_start=.1, clip_end=100))
    settings = NS(file_format='PNG', color_mode='RGB', color_depth='16')
    render = NS(resolution_x=129, resolution_y=129, resolution_percentage=75, pixel_aspect_x=1.1, pixel_aspect_y=.9,
                image_settings=settings, filepath="original-side.png")
    proxy = NS(type="MESH", hide_render=True, get=lambda key: "collision")
    ground = NS(type="MESH", hide_render=False, get=lambda key: "preview")
    scene = NS(camera=camera, render=render, objects=objects + [proxy, ground])
    layer = NS(material_override=None, update=lambda: None)
    bpy = NS(context=NS(scene=scene, view_layer=layer, evaluated_depsgraph_get=lambda: None))
    return request, objects, rows, camera, bpy


class TreeStructureReviewTests(unittest.TestCase):
    def test_exact_original_semantic_sources_and_legitimate_bare_tree(self):
        for density, keys in ((0, {"bark"}), (.7, {"bark", "leaves"})):
            request, objects, rows, _, _ = fixture(density)
            selected = review.original_tree_objects(request, objects, semantic)
            self.assertEqual(set(selected), keys)
            self.assertIs(selected["bark"], objects[0])
            metadata = review.structure_metadata(request, objects, rows, REQUEST_HASH, semantic)
            self.assertEqual(metadata, {"schemaVersion": 1, "path": "preview-structure.png", "requestSha256": REQUEST_HASH,
                "sourceObjects": [{"sourceKey": "bark", "sourceObjectId": objects[0]["arcane_source_object_id"], "geometrySha256": rows[0]["geometrySha256"]}],
                "views": ["front", "side", "oblique", "roots"]})
        for change in (lambda objs: objs.pop(), lambda objs: objs.append(objs[0]),
                       lambda objs: objs[0].__setitem__("arcane_role", "lod1"),
                       lambda objs: objs[0].__setitem__("arcane_source_key", "guessed-trunk"),
                       lambda objs: objs[0].__setitem__("arcane_identity_scheme", "other"),
                       lambda objs: objs[0].__setitem__("arcane_source_object_id", "arcane_" + "c" * 64)):
            request, objects, _, _, _ = fixture()
            change(objects)
            with self.assertRaisesRegex(ValueError, "identity"):
                review.original_tree_objects(request, objects, semantic)

    def test_actual_evaluated_geometry_digest_and_full_precision_uv_material_fingerprint(self):
        request, objects, rows, _, _ = fixture(0)
        obj = objects[0]
        expected = hashlib.sha256(json.dumps({"vertices": [[-.3, 0.0, 0.0], [.5, 0.0, 0.0], [0.0, 0.0, 2.0]],
                                             "triangles": [[0, 1, 2]]}, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(rows[0]["geometrySha256"], expected)
        original = review.exact_source_fingerprint(objects, None)
        obj.data.vertices[0].co[0] += 1e-8
        review.enrich_tree_meshes(request, objects, rows, semantic, None)
        self.assertEqual(rows[0]["geometrySha256"], expected, "Audit digest keeps the existing rounded domain")
        self.assertNotEqual(review.exact_source_fingerprint(objects, None), original, "Private guard must see sub-micrometre changes")
        original = review.exact_source_fingerprint(objects, None)
        obj.data.uv_layers[0].data[0].uv[0] += 1e-8
        self.assertNotEqual(review.exact_source_fingerprint(objects, None), original)
        mat = NS(name="MAT_Bark", diffuse_color=(.2, .3, .1, 1), use_nodes=True, use_backface_culling=False,
                 as_pointer=lambda: 123, node_tree=NS(nodes=[], links=[]))
        obj.data.materials.append(mat)
        original = review.exact_source_fingerprint(objects, None)
        mat.diffuse_color = (.2, .3, .10000001, 1)
        self.assertNotEqual(review.exact_source_fingerprint(objects, None), original)
        before_clear = obj.clear_count
        obj.data.vertices[0].co[0] = float('nan')
        with self.assertRaises(ValueError):
            review.enrich_tree_meshes(request, objects, rows, semantic, None)
        self.assertEqual(obj.clear_count, before_clear + 1, "Release each evaluated mesh even on digest failure")

    def test_legacy_marker_absence_and_closed_new_marker_refuse_malformed_without_fallback(self):
        request, objects, rows, _, _ = fixture()
        metadata = review.structure_metadata(request, objects, rows, REQUEST_HASH, semantic)
        with tempfile.TemporaryDirectory(prefix="arcane-tree-review-test-") as directory:
            root = Path(directory)
            path = root / "audit.json"
            path.write_text(json.dumps({"meshes": rows}), encoding="utf-8")
            original = copy.deepcopy(rows)
            self.assertIsNone(review.retained_structure(root, REQUEST_HASH))
            self.assertEqual(rows, original)
            path.write_text(json.dumps({"treeStructure": metadata}), encoding="utf-8")
            self.assertEqual(review.retained_structure(root, REQUEST_HASH), metadata)
            for change in (lambda m: m.update(extra=True), lambda m: m.update(schemaVersion=True), lambda m: m.update(path="other.png"),
                           lambda m: m.update(requestSha256="e" * 64), lambda m: m.update(sourceObjects=[]),
                           lambda m: m["sourceObjects"][0].update(geometrySha256="not-a-digest"), lambda m: m.update(views=["front"])):
                bad = copy.deepcopy(metadata)
                change(bad)
                path.write_text(json.dumps({"treeStructure": bad}), encoding="utf-8")
                with self.assertRaises(ValueError):
                    review.retained_structure(root, REQUEST_HASH)
            path.write_text('{"treeStructure":null,"treeStructure":null}', encoding="utf-8")
            with self.assertRaises(ValueError):
                review.retained_structure(root, REQUEST_HASH)
            path.write_bytes(b' ' * (4 * 1024 * 1024 + 1))
            with self.assertRaisesRegex(ValueError, "exceeded"):
                review.retained_structure(root, REQUEST_HASH)

    def test_even_and_odd_sheet_cover_exact_square_and_asymmetric_original_bounds(self):
        for resolution in (128, 129, 511, 1024):
            layout = review.sheet_layout(resolution)
            self.assertEqual([row[0] for row in layout], list(review.VIEWS))
            self.assertEqual(sum(width * height for _, _, _, width, height in layout), resolution * resolution)
            rectangles = [(x, y, x + w, y + h) for _, x, y, w, h in layout]
            for left, first in enumerate(rectangles):
                self.assertTrue(0 <= first[0] < first[2] <= resolution and 0 <= first[1] < first[3] <= resolution)
                for second in rectangles[left + 1:]:
                    self.assertFalse(max(first[0], second[0]) < min(first[2], second[2]) and max(first[1], second[1]) < min(first[3], second[3]))
        points = [(-4, -1, .2), (2, 7, .2), (1, 3, 11), (-1, -2, 6)]
        for name in review.VIEWS:
            plan = review.view_plan(points, name, 64, 65)
            self.assertTrue(all(math.isfinite(c) for c in plan["location"] + plan["target"]))
            self.assertGreater(plan["scale"], 0)
            if name == "roots":
                self.assertLess(plan["target"][2], 4)
            else:
                # Independent camera basis: every original point is inside the conservative square.
                direction = [plan["location"][k] - plan["target"][k] for k in range(3)]
                length = math.sqrt(sum(c * c for c in direction))
                direction = [c / length for c in direction]
                right = [-direction[1], direction[0], 0]
                length = math.sqrt(sum(c * c for c in right))
                right = [c / length for c in right]
                up = [-direction[2] * right[1], direction[2] * right[0], direction[0] * right[1] - direction[1] * right[0]]
                for point in points:
                    for axis in (right, up):
                        self.assertLess(abs(sum((point[k] - plan["target"][k]) * axis[k] for k in range(3))), plan["scale"] / 2)

    def test_success_uses_same_original_bark_and_restores_before_metrics(self):
        request, objects, rows, camera, bpy = fixture()
        scene = bpy.context.scene
        original_render = vars(scene.render).copy()
        original_settings = vars(scene.render.image_settings).copy()
        original_camera = (camera.location, camera.rotation_euler, vars(camera.data).copy())
        visits = []

        def render(bound_bpy, directory, bound_camera, points, resolution):
            self.assertIs(bound_bpy, bpy)
            self.assertIs(bound_camera, camera)
            self.assertFalse(objects[0].hide_render)
            self.assertTrue(objects[1].hide_render)
            self.assertTrue(scene.objects[-2].hide_render)
            self.assertFalse(scene.objects[-1].hide_render)
            self.assertEqual(points, [tuple(vertex.co) for vertex in objects[0].data.vertices])
            self.assertEqual(resolution, 129)
            visits.append("original-bark")
            camera.location, camera.rotation_euler = (7, 8, 9), (.4, .5, .6)
            camera.data.ortho_scale = 2
            scene.render.resolution_x = 64

        def metrics(path):
            self.assertEqual(vars(scene.render), original_render)
            self.assertEqual(vars(scene.render.image_settings), original_settings)
            self.assertEqual((camera.location, camera.rotation_euler, vars(camera.data)), original_camera)
            self.assertFalse(objects[1].hide_render)
            visits.append("restored-metrics")
            return {"path": path.name, "width": 129, "height": 129}

        with patch.object(review, "_render_sheet", side_effect=render):
            metrics_result, metadata = review.render_tree_structure(bpy, request, Path("owned-job"), camera, objects, rows, REQUEST_HASH, semantic, metrics)
        self.assertEqual(visits, ["original-bark", "restored-metrics"])
        self.assertEqual(metrics_result["path"], metadata["path"])

    def test_render_failure_preserves_original_exception_and_restores_all_state(self):
        for density in (0, .7):
            request, objects, rows, camera, bpy = fixture(density)
            original = (camera.location, camera.rotation_euler, vars(camera.data).copy(), vars(bpy.context.scene.render).copy())
            failure = RuntimeError("controlled render failure")

            def render(*args):
                camera.location = (9, 8, 7)
                camera.data.clip_end = 4
                bpy.context.scene.render.resolution_y = 64
                raise failure

            with patch.object(review, "_render_sheet", side_effect=render):
                with self.assertRaises(RuntimeError) as caught:
                    review.render_tree_structure(bpy, request, Path("owned-job"), camera, objects, rows, REQUEST_HASH, semantic, lambda path: self.fail("No metrics after failed render"))
            self.assertIs(caught.exception, failure)
            self.assertEqual((camera.location, camera.rotation_euler, vars(camera.data), vars(bpy.context.scene.render)), original)
            self.assertTrue(all(not obj.hide_render for obj in objects))

    def test_source_mutation_and_missing_view_dimensions_fail_without_approval(self):
        for mutate in (lambda obj: obj.data.vertices[0].co.__setitem__(0, -.30000001),
                       lambda obj: obj.data.uv_layers[0].data[0].uv.__setitem__(0, 1e-8)):
            request, objects, rows, camera, bpy = fixture()
            with patch.object(review, "_render_sheet", side_effect=lambda *args: mutate(objects[0])):
                with self.assertRaisesRegex(ValueError, "restoration"):
                    review.render_tree_structure(bpy, request, Path("owned-job"), camera, objects, rows, REQUEST_HASH, semantic, lambda path: self.fail("Changed source cannot publish"))
            self.assertFalse(objects[1].hide_render)
        request, objects, rows, camera, bpy = fixture()
        with patch.object(review, "_render_sheet"):
            with self.assertRaisesRegex(ValueError, "dimensions"):
                review.render_tree_structure(bpy, request, Path("owned-job"), camera, objects, rows, REQUEST_HASH, semantic,
                                             lambda path: {"path": path.name, "width": 128, "height": 129})

    def test_owned_sheet_image_is_removed_when_save_fails(self):
        failure = OSError("controlled save failure")
        pixels = MagicMock()
        sheet = MagicMock()
        sheet.ravel.return_value = [0, 0, 0, 1]
        image = NS(pixels=pixels, save_render=MagicMock(side_effect=failure))
        images = NS(new=MagicMock(return_value=image), remove=MagicMock())
        bpy = NS(context=NS(scene=object()), data=NS(images=images))
        fake_numpy = NS(zeros=MagicMock(return_value=sheet), float32=object())
        with patch.dict(sys.modules, {"numpy": fake_numpy}), patch.object(review, "_render_tile", return_value=object()) as render:
            with self.assertRaises(OSError) as caught:
                review._render_sheet(bpy, Path("owned-job"), object(), [(0, 0, 0), (1, 1, 2)], 129)
        self.assertIs(caught.exception, failure)
        self.assertEqual(render.call_count, 4)
        images.remove.assert_called_once_with(image)
        image.save_render.assert_called_once_with(str(Path("owned-job") / "preview-structure.png"), scene=bpy.context.scene)

    def test_restore_refusal_still_attempts_other_original_owned_state(self):
        request, objects, rows, camera, bpy = fixture()

        class Data:
            type, ortho_scale, clip_start, clip_end, armed = 'ORTHO', 5, .1, 100, False

            def __setattr__(self, name, value):
                if name == "ortho_scale" and value == 5 and self.armed:
                    raise RuntimeError("controlled restore refusal")
                object.__setattr__(self, name, value)

        camera.data = Data()

        def render(*args):
            camera.data.ortho_scale, camera.data.clip_end, camera.data.armed = 2, 4, True
            bpy.context.scene.render.resolution_y = 64

        with patch.object(review, "_render_sheet", side_effect=render):
            with self.assertRaisesRegex(ValueError, "restoration"):
                review.render_tree_structure(bpy, request, Path("owned-job"), camera, objects, rows, REQUEST_HASH, semantic,
                                             lambda path: self.fail("Restore refusal cannot publish"))
        self.assertEqual(camera.data.clip_end, 100)
        self.assertEqual(bpy.context.scene.render.resolution_y, 129)
        self.assertFalse(objects[1].hide_render)


if __name__ == "__main__":
    unittest.main()
