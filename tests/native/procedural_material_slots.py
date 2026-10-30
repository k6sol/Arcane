"""Actual Blender regression for single-material generated parts, not art acceptance."""
import hashlib
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests" / "unit"))
import worker_paths
import bpy
import procedural
from audit import mesh_metrics
from asset_worker import mesh_audit_reason


def geometry(mesh):
    return hashlib.sha256(json.dumps({
        "vertices": [list(v.co) for v in mesh.vertices],
        "faces": [list(f.vertices) for f in mesh.polygons],
        "uv": [[list(p.uv) for p in layer.data] for layer in mesh.uv_layers],
        "smooth": [p.use_smooth for p in mesh.polygons],
    }, sort_keys=True).encode()).hexdigest()


def material(name, color, metallic, roughness):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    return mat


def collection(name):
    result = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(result)
    return result


request = {"name": "material-slot-proof", "seed": 31, "color": [.22, .18, .14],
           "triangleBudget": 16000, "procedural": {"kind": "tree", "species": "oak",
           "height": 9, "trunkTaper": .55, "branchLevels": 3, "leafDensity": 0,
           "finish": "natural", "trunkRadius": None, "secondaryColor": [.1, .3, .1]}}
original_union = procedural.union_wood
observed = {}


def inherited_slots(data, name):
    mesh = original_union(data, name)
    assert mesh is not None, "The actual union branch must be exercised"
    mesh.materials.clear()
    mesh.materials.append(None)
    mesh.materials.append(material("Inherited", [.5, .5, .5], 0, .5))
    mesh.materials.append(None)
    for polygon in mesh.polygons:
        polygon.material_index = polygon.index % 3
    observed["geometry"] = geometry(mesh)
    observed["mesh"] = mesh
    return mesh


for union in (inherited_slots, lambda *_: None):
    procedural.union_wood = union
    main, *_ = procedural.build(request, material, collection, lambda *_: None, lambda *_, **__: None)
    assert len(main) == 1
    mesh = main[0].data
    assert len(mesh.materials) == 1
    assert mesh.materials[0].name.startswith("MAT_Bark") and mesh.materials[0].use_nodes
    assert all(p.material_index == 0 for p in mesh.polygons)
    if union is inherited_slots:
        assert mesh == observed["mesh"] and geometry(mesh) == observed["geometry"]
        # The actual Blender audit, rather than a fabricated exception string,
        # must distinguish this material defect from geometry or UV failures.
        authored = mesh.materials[0]
        mesh.materials.clear()
        mesh.materials.append(None)
        mesh.materials.append(authored)
        measured = mesh_metrics(main[0], "render")
        assert measured["errors"] == ["Missing named node material"], measured["errors"]
        errors = [measured["name"] + ": " + e for e in measured["errors"]]
        assert mesh_audit_reason([measured], errors) == "MESH_MATERIAL_NODE"
        assert mesh_audit_reason([measured], errors + ["Render triangle budget failed"]) == "MESH_AUDIT"
        mesh.materials.clear()
        mesh.materials.append(authored)
procedural.union_wood = original_union
import oak_spray_layout_test
spray_suite = unittest.defaultTestLoader.loadTestsFromModule(oak_spray_layout_test)
spray_result = unittest.TextTestRunner().run(spray_suite)
assert spray_result.wasSuccessful() and spray_result.testsRun == 4 and not spray_result.skipped
print("ARCANE_GENERATED_MATERIAL_SLOTS_OK " + json.dumps({"cases": 2, "diagnosticCases": 1,
      "oakSprayCases": spray_result.testsRun, "blender": bpy.app.version_string}))
