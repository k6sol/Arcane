"""Pure v2 fidelity/correspondence tests. No bpy, subprocess or native proof."""
from copy import deepcopy
from pathlib import Path
from types import FunctionType, ModuleType, SimpleNamespace
import importlib.util
import math
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("arcane_conversion_policy", ROOT / "workers/blender/conversion_audit.py")
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)
WORKER_SPEC = importlib.util.spec_from_file_location("arcane_conversion_policy_worker", ROOT / "workers/blender/convert_glb.py")
worker = importlib.util.module_from_spec(WORKER_SPEC)
with patch.dict(sys.modules, {"conversion_audit": audit}), patch.object(sys, "path", list(sys.path)), patch.object(sys, "dont_write_bytecode", True):
    WORKER_SPEC.loader.exec_module(worker)


def identity():
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def add_attribute(doc, binary, values, name=None, indices=False):
    padded = binary + b"\0" * ((-len(binary)) % 4)
    width = len(values[0]); component = 5123 if indices else 5126
    raw = struct.pack("<" + ("H" if indices else "f") * (len(values)*width), *(n for row in values for n in row))
    view = len(doc["bufferViews"])
    doc["bufferViews"].append({"buffer": 0, "byteOffset": len(padded), "byteLength": len(raw)})
    index = len(doc["accessors"])
    entry = {"bufferView": view, "componentType": component, "count": len(values), "type": "SCALAR" if width == 1 else "VEC%d" % width}
    if name == "POSITION":
        entry.update({"min": [min(row[axis] for row in values) for axis in range(3)], "max": [max(row[axis] for row in values) for axis in range(3)]})
    doc["accessors"].append(entry)
    primitive = doc["meshes"][0]["primitives"][0]
    if indices: primitive["indices"] = index
    else: primitive["attributes"][name] = index
    result = padded + raw
    doc["buffers"] = [{"byteLength": len(result)}]
    return result


def glb_bytes(doc, binary):
    encoded = audit.canonical(doc)
    encoded += b" " * ((-len(encoded)) % 4)
    padded = binary + b"\0" * ((-len(binary)) % 4)
    return struct.pack("<5I", 0x46546C67, 2, 28+len(encoded)+len(padded), len(encoded), 0x4E4F534A) + encoded + struct.pack("<2I", len(padded), 0x004E4942) + padded


def fixture():
    positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 0], [0, 1, 0], [-1, 0, 0]]
    uv = [[0, 0], [1, 0], [0, 1], [.25, 0], [.25, 1], [-.75, 0]]
    doc = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
           "nodes": [{"children": [1], "translation": [.25, .5, .25], "rotation": [0, 0, math.sin(math.pi/12), math.cos(math.pi/12)], "scale": [1.5, .75, 1.25]},
                     {"mesh": 0, "rotation": [0, math.sin(math.pi/6), 0, math.cos(math.pi/6)], "scale": [.75, 1.5, 1.25]}],
           "meshes": [{"primitives": [{"attributes": {}}]}], "accessors": [], "bufferViews": []}
    binary = b""
    for name, values in (("POSITION", positions), ("NORMAL", [[0, 0, 1]]*6), ("TANGENT", [[1, 0, 0, 1]]*6),
                         ("TEXCOORD_0", uv), ("COLOR_0", [[.25, .5, .75, 1]]*6)):
        binary = add_attribute(doc, binary, values, name)
    binary = add_attribute(doc, binary, [[i] for i in range(6)], indices=True)
    raw = glb_bytes(doc, binary); source_hash = audit.sha(raw)
    marked = deepcopy(doc); marked["nodes"][1].pop("mesh"); marked["nodes"][1]["children"] = [2]
    origin = "glb_%s:1:0" % source_hash
    marked["nodes"][0]["extras"] = {audit.NODE_KEY: "node0"}
    marked["nodes"][1]["extras"] = {audit.NODE_KEY: "node1"}
    marked["nodes"].append({"mesh": 0, "extras": {audit.NODE_KEY: "node1_primitive0", audit.ORIGIN: origin}})
    marked_binary = add_attribute(marked, binary, [[i] for i in range(6)], audit.VERTEX_ID)
    marked_raw = glb_bytes(marked, marked_binary)
    part = {"sourceNodeIndex": 1, "sourceMeshIndex": 0, "sourcePrimitiveIndex": 0, "sourceMaterialIndex": None,
            "sourceKey": "node1_primitive0", "importNodeIndex": 2, "originMarker": origin,
            "worldMatrix": audit.worlds(doc)[1], "triangles": 2, "vertexCount": 6}
    mapping = {"schemaVersion": 2, "fidelityPolicy": audit.FIDELITY_POLICY, "sourceSha256": source_hash,
               "importSha256": audit.sha(marked_raw), "sourceSceneIndex": 0, "declaredSceneCount": 1, "parts": [part],
               "nodes": [{"nodeKey": "node0", "importNodeIndex": 0, "parentKey": None, "localMatrix": audit.matrix_local(doc["nodes"][0])},
                         {"nodeKey": "node1", "importNodeIndex": 1, "parentKey": "node0", "localMatrix": audit.matrix_local(doc["nodes"][1])},
                         {"nodeKey": "node1_primitive0", "importNodeIndex": 2, "parentKey": "node1", "localMatrix": identity()}]}
    request = {"schemaVersion": 2, "fidelityPolicy": audit.FIDELITY_POLICY, "kind": "converted-glb",
               "jobId": "11111111-1111-4111-8111-111111111111", "parentJobId": "22222222-2222-4222-8222-222222222222",
               "parentManifestSha256": "a"*64, "name": "seam-card", "sourceSha256": source_hash, "sourceBytes": len(raw),
               "importSha256": audit.sha(marked_raw), "importBytes": len(marked_raw), "sourceMapSha256": audit.sha(audit.canonical(mapping)),
               "collision": "none", "renderResolution": 128, "renderSamples": 1}
    return doc, binary, raw, marked, marked_binary, marked_raw, part, mapping, request


def attributes(doc, binary):
    return {key: audit.accessor(doc, binary, index) for key, index in doc["meshes"][0]["primitives"][0]["attributes"].items()}


def exported(doc, values, indices):
    result = deepcopy(doc); result["accessors"] = []; result["bufferViews"] = []
    result["meshes"][0]["primitives"][0] = {"attributes": {}}
    binary = b""
    for key, rows in values.items(): binary = add_attribute(result, binary, rows, key)
    binary = add_attribute(result, binary, [[i] for i in indices], indices=True)
    return result, binary


def corner(source, source_id=0):
    local = {key: list(value[source_id]) for key, value in source["attributes"].items()}; world = {}
    for key, value in local.items():
        if key == "POSITION": world[key] = audit.position(source["world"], value)
        elif key == "NORMAL": world[key] = audit.policy_normal(source["world"], value)
        elif key == "TANGENT": world[key] = audit.policy_normalize(audit.policy_vector(source["world"], value[:3]), "FIDELITY_TANGENT") + [value[3]*audit.matrix_sign(source["world"])]
        else: world[key] = list(value)
    return local, world


class ObservedSceneObject(dict):
    """Controlled RNA-shaped observation; no bpy or native evidence."""
    def __init__(self, key, mesh, actual_world):
        super().__init__({audit.NODE_KEY: key})
        self.type = "MESH" if mesh else "EMPTY"
        self.modifiers = []; self.constraints = []; self.animation_data = None
        self.parent_type = "OBJECT"; self.parent = None
        self.actual_world = list(actual_world); self.world_reads = 0

    @property
    def matrix_local(self):
        raise AssertionError("Effective local observations must not read RNA matrix_local")

    @property
    def matrix_world(self):
        self.world_reads += 1
        # Inverse of the fixed signed-axis permutation, not Blender mathutils.
        axes, signs = (0, 2, 1, 3), (1, 1, -1, 1)
        matrix = [[0.0]*4 for _ in range(4)]
        for col in range(4):
            for row in range(4):
                matrix[axes[row]][axes[col]] = self.actual_world[row+4*col]*signs[row]*signs[col]
        return matrix


def observed_scene(mapping, actual_worlds=None):
    values = audit.hierarchy_worlds(mapping) if actual_worlds is None else actual_worlds
    part_keys = {part["sourceKey"] for part in mapping["parts"]}
    objects = {row["nodeKey"]: ObservedSceneObject(row["nodeKey"], row["nodeKey"] in part_keys, values[row["nodeKey"]])
               for row in mapping["nodes"]}
    for row in mapping["nodes"]:
        if row["parentKey"] is not None: objects[row["nodeKey"]].parent = objects[row["parentKey"]]
    # Graph validation and observation cannot depend on scene iteration order.
    return SimpleNamespace(objects=list(reversed(list(objects.values())))), objects


class ImagePixels(list):
    def foreach_get(self, target):
        for index, value in enumerate(self): target[index] = value


class SceneImage:
    """Controlled image data only; never a native image-retention proof."""
    def __init__(self, source="FILE", image_type="IMAGE", packed=False, packs=True):
        self.source = source; self.type = image_type; self.name = "arbitrary-runtime-name"
        self.packed_file = object() if packed else None
        self.packs = packs; self.pack_calls = 0; self.users = 1
        self.size = (1, 1); self.pixels = ImagePixels([.25, .5, .75, 1])
        self.colorspace_settings = SimpleNamespace(name="sRGB"); self.alpha_mode = "STRAIGHT"

    def as_pointer(self):
        return id(self)

    def pack(self):
        self.pack_calls += 1
        if self.packs == "raises": raise RuntimeError("controlled image pack failure")
        if self.packs: self.packed_file = object()


def material_node(image=None, group=None):
    node = SimpleNamespace(bl_idname="ShaderNodeTexImage" if group is None else "ShaderNodeGroup",
                           image=image, node_tree=group, inputs=[], outputs=[])
    node.as_pointer = lambda: id(node)
    return node


def material_tree(*nodes):
    tree = SimpleNamespace(nodes=list(nodes), links=[])
    tree.as_pointer = lambda: id(tree)
    return tree


def scene_material(tree):
    material = SimpleNamespace(node_tree=tree)
    material.as_pointer = lambda: id(material)
    return material


def image_scene(images, material=None):
    bpy = SimpleNamespace(data=SimpleNamespace(images=list(images)))
    objects = {"selected-render": SimpleNamespace(material_slots=[SimpleNamespace(material=material)])}
    return bpy, objects


class ControlledOperator:
    """Fixed RNA-shaped contract double; not an actual Blender operator."""
    EXPORT_PROPERTIES = {"filepath", "check_existing", "export_format", "use_selection", "export_extras",
                         "export_yup", "export_apply", "export_texcoords", "export_normals", "export_tangents",
                         "export_materials", "export_vertex_color", "export_all_vertex_colors",
                         "export_active_vertex_color_when_no_material", "export_attributes", "export_image_format",
                         "export_animations", "export_skins", "export_morph", "export_cameras", "export_lights",
                         "export_gpu_instances", "export_draco_mesh_compression_enable", "export_use_gltfpack"}

    def __init__(self, failure=None, properties=None):
        self.failure = failure; self.result = {"FINISHED"}; self.calls = []
        self.properties = self.EXPORT_PROPERTIES if properties is None else properties

    def get_rna_type(self):
        return SimpleNamespace(properties=dict.fromkeys(self.properties))

    def __call__(self, **arguments):
        self.calls.append(arguments)
        if self.failure is not None: raise self.failure
        return self.result


class ControlledViewObjects(dict):
    active = None


class ControlledReportingOperator(ControlledOperator):
    """Contract double for report wrapping, not native Blender evidence."""
    def __init__(self, module, *, before=False, after=False, repeat=1):
        super().__init__()
        self.module = module; self.before = before; self.after = after; self.repeat = repeat
        self.escaped = None

    def __call__(self, **arguments):
        self.calls.append(arguments)
        if self.before:
            raise RuntimeError("controlled pre-save report")
        try:
            for _ in range(self.repeat):
                self.module.save("controlled context", arguments)
        except Exception as failure:
            self.escaped = failure
            raise RuntimeError("untrusted report text /fake/path.py:59 PermissionError") from None
        if self.after:
            raise RuntimeError("controlled post-save report")
        return self.result


def controlled_observer(original, site="SAVE", intervals=None):
    module = ModuleType("controlled_export_observer")
    module.save = original
    return module, original, ((original.__code__, intervals or ((None, None, site),)),)


def observer_source_stub(*_arguments, **_keywords):
    return {"FINISHED"}


def observer_installation(directory):
    """Owned source-custody fixture only; no downloaded/exporter code is run."""
    executable = directory / "blender"
    executable.write_bytes(b"controlled executable placeholder, never launched")
    root = directory / "5.2/scripts/addons_core/io_scene_gltf2"
    pins = {}
    for relative in worker._EXPORT_SOURCE_PINS:
        data = ("controlled source: " + relative).encode()
        target = root / relative; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
        pins[relative] = (len(data), audit.sha(data))
    modules = {}
    packages = (("io_scene_gltf2", "", True), ("io_scene_gltf2.blender", "blender", True),
                ("io_scene_gltf2.blender.exp", "blender/exp", False),
                ("io_scene_gltf2.io", "io", True), ("io_scene_gltf2.io.exp", "io/exp", False))
    for name, relative, initialized in packages:
        module = ModuleType(name); folder = root / relative
        module.__path__ = [str(folder)]
        module.__file__ = str(folder / "__init__.py") if initialized else None
        modules[name] = module
    for name, relative, functions in (("io_scene_gltf2.blender.exp.export", "blender/exp/export.py", (("save", 21), ("__export", 53))),
                                      ("io_scene_gltf2.io.exp.export", "io/exp/export.py", (("save_gltf", 23),))):
        module = ModuleType(name); module.__file__ = str(root / relative)
        for function, line in functions:
            code = observer_source_stub.__code__.replace(co_filename=module.__file__, co_firstlineno=line, co_name=function)
            module.__dict__[function] = FunctionType(code, module.__dict__, function)
        modules[name] = module
    modules["io_scene_gltf2.blender.exp.export"].gltf2_io_export = modules["io_scene_gltf2.io.exp.export"]
    bpy = SimpleNamespace(app=SimpleNamespace(version=(5, 2, 3), binary_path=str(executable)))
    return bpy, root, pins, modules


class CollisionVector:
    def __init__(self, values):
        self.x, self.y, self.z = values

    def __iter__(self):
        return iter((self.x, self.y, self.z))


class CollisionWorld:
    def __matmul__(self, vector):
        return vector


class CollisionVertex:
    def __init__(self, values):
        self.co = CollisionVector(values)


class ControlledCollisionBmesh:
    """Disposable topology double; does not implement or prove native welding."""
    def __init__(self, mode):
        self.mode = mode; self.freed = False; self.joined = False

    def from_mesh(self, mesh):
        self.verts = [CollisionVertex(row) for row in mesh.positions]
        self.faces = [SimpleNamespace(verts=[self.verts[index] for index in face]) for face in mesh.triangles]
        self.loose_edge = getattr(mesh, "loose_edge", False)

    @property
    def edges(self):
        found = {}
        for face in self.faces:
            for first, second in zip(face.verts, face.verts[1:]+face.verts[:1]):
                key = frozenset((first, second)); found.setdefault(key, []).append(face)
        result = [SimpleNamespace(link_faces=faces, is_manifold=len(faces) == 2) for faces in found.values()]
        if self.loose_edge: result.append(SimpleNamespace(link_faces=[], is_manifold=False))
        return result

    def normal_update(self):
        pass

    def calc_volume(self, signed):
        if not signed: raise AssertionError("Signed volume observation required")
        if self.joined and self.mode == "zero-volume": return 0
        if self.joined and self.mode == "nonfinite-volume": return math.nan
        total = 0
        for face in self.faces:
            if len(face.verts) != 3: raise AssertionError("Raw polygon must refuse before volume")
            a, b, c = (list(vertex.co) for vertex in face.verts)
            total += audit.policy_dot(a, audit.policy_cross(b, c))/6
        return total

    def to_mesh(self, _mesh):
        raise AssertionError("Collision audit must not write a model mesh")

    def free(self):
        self.freed = True


def collision_fixture(split=True):
    positions = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)]
    triangles = [(0, 2, 1), (0, 1, 3), (0, 3, 2), (1, 2, 3)]
    if split:
        positions = [positions[index] for face in triangles for index in face]
        triangles = [(index, index+1, index+2) for index in range(0, 12, 3)]
    mesh = SimpleNamespace(positions=list(positions), triangles=list(triangles))
    return SimpleNamespace(data=mesh, matrix_world=CollisionWorld())


def collision_module(mode="ordinary"):
    created, calls = [], []
    def new():
        bm = ControlledCollisionBmesh(mode); created.append(bm); return bm
    def weld(bm, *, targetmap, use_centroid, average_vert_data):
        calls.append({"pairs": [(tuple(source.co), tuple(target.co)) for source, target in targetmap.items()],
                      "use_centroid": use_centroid, "average_vert_data": average_vert_data})
        if mode == "raises": raise RuntimeError("controlled audit weld failure")
        for face in bm.faces: face.verts = [targetmap.get(vertex, vertex) for vertex in face.verts]
        bm.verts = [vertex for vertex in bm.verts if vertex not in targetmap]; bm.joined = True
        if mode == "drop-face": bm.faces.pop()
        elif mode == "move-position": bm.verts[1].co.x += 1e-8
    return SimpleNamespace(new=new, ops=SimpleNamespace(weld_verts=weld)), created, calls


class ConversionFidelityPolicyTests(unittest.TestCase):
    def refused(self, reason, callback):
        with self.assertRaises(audit.ConversionFailure) as failure: callback()
        self.assertEqual(failure.exception.reason, reason)

    def test_policy_is_fixed_and_physical_position_boundary_is_inclusive(self):
        self.assertEqual(audit.FIDELITY_POLICY, "arcane-static-fidelity-v1")
        self.assertEqual(audit.IDENTITY, "arcane-converted-v2")
        audit.policy_distance([0, 0, 0], [0.0001, 0, 0], audit.POSITION_LIMIT, "FIDELITY_POSITION")
        self.refused("FIDELITY_POSITION", lambda: audit.policy_distance([0, 0, 0], [math.nextafter(.0001, math.inf), 0, 0], audit.POSITION_LIMIT, "FIDELITY_POSITION"))
        self.refused("FIDELITY_POSITION", lambda: audit.policy_distance([0, 0, 0], [.00008, .00008, 0], audit.POSITION_LIMIT, "FIDELITY_POSITION"))

    def test_direction_small_representation_error_passes_and_large_or_reversed_directions_refuse(self):
        for radians in (0, .01*math.pi/180):
            audit.policy_direction([0, 0, 1], [math.sin(radians), 0, math.cos(radians)], "FIDELITY_NORMAL")
        for vector in ([math.sin(.03*math.pi/180), 0, math.cos(.03*math.pi/180)], [0, 0, -1], [0, 0, 0], [float("nan"), 0, 1]):
            self.refused("FIDELITY_NORMAL", lambda: audit.policy_direction([0, 0, 1], vector, "FIDELITY_NORMAL"))

    def test_uv_and_linear_rgba_boundaries_have_no_extra_epsilon(self):
        for size, limit, reason in ((2, 2**-20, "FIDELITY_UV"), (4, 1/65535, "FIDELITY_COLOR")):
            baseline = [0]*size
            audit.policy_components(baseline, [limit]+[0]*(size-1), size, limit, reason)
            self.refused(reason, lambda: audit.policy_components(baseline, [math.nextafter(limit, math.inf)]+[0]*(size-1), size, limit, reason))

    def test_local_transform_limits_and_handedness_are_checked_independently(self):
        original = identity(); within = identity(); within[12] = 1e-5
        audit.compare_fidelity_transform(original, within)
        within[0] += 2**-20
        audit.compare_fidelity_transform(original, within)
        too_far = identity(); too_far[12] = math.nextafter(1e-5, math.inf)
        self.refused("FIDELITY_TRANSFORM", lambda: audit.compare_fidelity_transform(original, too_far))
        reflected = identity(); reflected[0] = -1
        self.refused("FIDELITY_TRANSFORM", lambda: audit.compare_fidelity_transform(original, reflected))

    def test_small_axis_drift_cannot_hide_in_a_large_axis(self):
        original = identity(); original[5] = .001
        changed = list(original); changed[5] += 1e-7
        self.refused("FIDELITY_TRANSFORM", lambda: audit.compare_fidelity_transform(original, changed))

    def test_conditioning_refuses_singular_or_unresolved_transforms_without_puffing_planar_geometry(self):
        at_limit = identity(); at_limit[0] = 1e-4
        audit.check_fidelity_matrix(at_limit)
        beyond = identity(); beyond[0] = 1/10001
        self.refused("FIDELITY_CONDITION", lambda: audit.check_fidelity_matrix(beyond))
        singular = identity(); singular[10] = 0
        self.refused("FIDELITY_CONDITION", lambda: audit.check_fidelity_matrix(singular))
        doc, binary, _raw, _marked, _mb, _mr, part, _map, _request = fixture()
        source = audit.source_fidelity(doc, binary, part, 0)
        self.assertEqual(source["triangles"], 2)
        self.assertTrue(all(p[2] == 0 for p in source["attributes"]["POSITION"]))

    def test_signed_axis_matrix_adapter_preserves_full_affine_components(self):
        bpy_matrix = [[2, 3, 5, 7], [11, 13, 17, 19], [23, 29, 31, 37], [0, 0, 0, 1]]
        self.assertEqual(audit.bpy_matrix_y_up(bpy_matrix), [2, 23, -11, 0, 5, 31, -17, 0, -3, -29, 13, 0, 7, 37, -19, 1])

    def test_original_and_marked_bytes_validate_exact_ids_seams_and_full_affine_graph(self):
        doc, binary, raw, marked, marked_binary, marked_raw, part, mapping, request = fixture()
        before = bytes(raw)
        _sd, _sb, expected, _graph = worker.source_evidence(request, mapping, raw, marked_raw)
        source = expected[part["sourceKey"]]
        self.assertEqual(source["vertexCount"], 6)
        self.assertEqual(source["attributes"]["POSITION"][0], source["attributes"]["POSITION"][3])
        self.assertNotEqual(source["attributes"]["TEXCOORD_0"][0], source["attributes"]["TEXCOORD_0"][3])
        self.assertEqual(audit.glb_fidelity(marked, marked_binary, 2, part, source), source["correspondenceSha256"])
        self.assertEqual(marked_binary[:len(binary)], binary)
        self.assertEqual(raw, before)

    def test_source_copy_never_adopts_a_forged_input_vertex_id(self):
        _doc, _binary, raw, marked, marked_binary, _mr, _part, mapping, request = fixture()
        ids = marked["accessors"][marked["meshes"][0]["primitives"][0]["attributes"][audit.VERTEX_ID]]
        changed = bytearray(marked_binary); offset = marked["bufferViews"][ids["bufferView"]]["byteOffset"]
        struct.pack_into("<f", changed, offset, 1)
        self.refused("FIDELITY_CORRESPONDENCE", lambda: worker.source_evidence(request, mapping, raw, glb_bytes(marked, bytes(changed))))

    def test_vertex_reordering_and_replacement_keep_corner_correspondence(self):
        doc, binary, _raw, marked, marked_binary, _mr, part, _map, _request = fixture()
        source = audit.source_fidelity(doc, binary, part, 0); values = attributes(marked, marked_binary)
        order = [3, 5, 0, 2, 1, 4]; inverse = {old: new for new, old in enumerate(order)}
        reordered = {key: [rows[index] for index in order] for key, rows in values.items()}
        out, data = exported(marked, reordered, [inverse[i] for i in range(6)])
        self.assertEqual(audit.glb_fidelity(out, data, 2, part, source), source["correspondenceSha256"])
        split = {key: deepcopy(rows)+[deepcopy(rows[0])] for key, rows in values.items()}
        out, data = exported(marked, split, [6, 1, 2, 3, 4, 5, 0, 1, 2])
        # A split may not add a face or leave an unused split vertex.
        self.refused("FIDELITY_CORRESPONDENCE", lambda: audit.glb_fidelity(out, data, 2, part, source))
        out, data = exported(marked, split, [6, 1, 2, 3, 4, 5])
        # Unreferenced accessor slots are storage, not an extra rendered face.
        self.assertEqual(audit.glb_fidelity(out, data, 2, part, source), source["correspondenceSha256"])
        # A compact alternative may omit that unreferenced old slot too.
        trimmed = {key: rows[1:] for key, rows in split.items()}
        out, data = exported(marked, trimmed, [5, 0, 1, 2, 3, 4])
        self.assertEqual(audit.glb_fidelity(out, data, 2, part, source), source["correspondenceSha256"])

    def test_a_real_used_export_vertex_split_is_allowed_without_merging_source_ids(self):
        doc, binary, _raw, marked, _mb, _mr, part, _map, _req = fixture()
        values = attributes(doc, binary)
        values = {key: [row for index, row in enumerate(rows) if index != 3] for key, rows in values.items()}
        source_doc, source_binary = exported(doc, values, [0, 1, 2, 0, 3, 4])
        source_part = {**part, "vertexCount": 5}
        source = audit.source_fidelity(source_doc, source_binary, source_part, 0)
        actual = {key: deepcopy(rows)+[deepcopy(rows[0])] for key, rows in values.items()}
        actual[audit.VERTEX_ID] = [[0], [1], [2], [3], [4], [0]]
        out, data = exported(marked, actual, [0, 1, 2, 5, 3, 4])
        self.assertEqual(audit.glb_fidelity(out, data, 2, source_part, source), source["correspondenceSha256"])
        self.assertEqual(len(audit.accessor(out, data, out["meshes"][0]["primitives"][0]["attributes"][audit.VERTEX_ID])), 6)

    def test_all_eight_uv_and_color_sets_are_checked(self):
        doc, binary, _raw, marked, _mb, _mr, part, _map, _req = fixture()
        for index in range(1, 8):
            binary = add_attribute(doc, binary, [[.25, .75]]*6, "TEXCOORD_%d" % index)
            binary = add_attribute(doc, binary, [[.25, .5, .75, 1]]*6, "COLOR_%d" % index)
        source = audit.source_fidelity(doc, binary, part, 0)
        actual = attributes(doc, binary); actual[audit.VERTEX_ID] = [[i] for i in range(6)]
        out, data = exported(marked, actual, list(range(6)))
        audit.glb_fidelity(out, data, 2, part, source)
        for key, reason in (("TEXCOORD_7", "FIDELITY_UV"), ("COLOR_7", "FIDELITY_COLOR")):
            changed = deepcopy(actual); changed[key][0][0] += .001
            out, data = exported(marked, changed, list(range(6)))
            self.refused(reason, lambda: audit.glb_fidelity(out, data, 2, part, source))

    def test_material_primitives_can_share_six_storage_slots_while_each_uses_three(self):
        doc, binary, _raw, marked, _mb, _mr, part, _map, _req = fixture()
        values = attributes(doc, binary)
        source_doc, source_binary = exported(doc, values, [0, 1, 2])
        source_doc["materials"] = [{}, {}]
        first = source_doc["meshes"][0]["primitives"][0]
        first["material"] = 0
        second = {"attributes": dict(first["attributes"]), "material": 1}
        offset = len(source_binary)
        raw_indices = struct.pack("<HHH", 3, 4, 5)
        source_doc["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": len(raw_indices)})
        second["indices"] = len(source_doc["accessors"])
        source_doc["accessors"].append({"bufferView": len(source_doc["bufferViews"])-1, "componentType": 5123, "type": "SCALAR", "count": 3})
        source_doc["meshes"][0]["primitives"].append(second)
        source_binary += raw_indices
        source_doc["buffers"][0]["byteLength"] = len(source_binary)
        actual = deepcopy(values); actual[audit.VERTEX_ID] = [[i] for i in range(6)]
        for primitive_index, ids in ((0, [0, 1, 2]), (1, [3, 4, 5])):
            source_part = {**part, "sourcePrimitiveIndex": primitive_index, "sourceKey": "node1_primitive%d" % primitive_index,
                           "sourceMaterialIndex": primitive_index, "triangles": 1}
            source = audit.source_fidelity(source_doc, source_binary, source_part, 0)
            self.assertEqual(source["vertexCount"], 6)
            self.assertEqual(source["usedIds"], set(ids))
            out, data = exported(marked, actual, ids)
            out["materials"] = [{}, {}]; out["meshes"][0]["primitives"][0]["material"] = primitive_index
            self.assertEqual(audit.glb_fidelity(out, data, 2, source_part, source), source["correspondenceSha256"])
            wrong, wrong_data = exported(marked, actual, [3, 4, 5] if primitive_index == 0 else [0, 1, 2])
            self.refused("FIDELITY_CORRESPONDENCE", lambda: audit.glb_fidelity(wrong, wrong_data, 2, source_part, source))
        self.assertEqual(audit.checked_vertex_ids([0, 1, 2], 6, {0, 1, 2}), [0, 1, 2])
        self.refused("FIDELITY_CORRESPONDENCE", lambda: audit.checked_vertex_ids([0, 1, 2, 3, 4, 5], 6, {0, 1, 2}))

    def test_cyclic_numeric_id_encoding_is_explicit_and_multiplicity_or_winding_changes_refuse(self):
        expected = audit.sha(b"[[0,10,2],[3,4,5]]")
        self.assertEqual(audit.correspondence_hash([[4, 5, 3], [10, 2, 0]]), expected)
        self.assertNotEqual(audit.correspondence_hash([[0, 10, 2], [3, 4, 5], [3, 4, 5]]), expected)
        self.assertNotEqual(audit.correspondence_hash([[0, 2, 10], [3, 4, 5]]), expected)

    def test_foreign_fractional_missing_and_nonfloat_ids_are_refused(self):
        for values in ([0, 1, 2, 3, 4, 6], [0, 1, 2, 3, 4, 5.5], [0, 1, 2, 3, 4, -1], [0, 1, 2, 3, 4, True]):
            self.refused("FIDELITY_CORRESPONDENCE", lambda: audit.checked_vertex_ids(values, 6))
        doc, binary, _raw, marked, marked_binary, _mr, part, _map, _req = fixture()
        source = audit.source_fidelity(doc, binary, part, 0)
        no_id = deepcopy(marked); no_id["meshes"][0]["primitives"][0]["attributes"].pop(audit.VERTEX_ID)
        self.refused("FIDELITY_CORRESPONDENCE", lambda: audit.glb_fidelity(no_id, marked_binary, 2, part, source))
        wrong_type = deepcopy(marked); index = wrong_type["meshes"][0]["primitives"][0]["attributes"][audit.VERTEX_ID]
        wrong_type["accessors"][index]["componentType"] = 5125
        self.refused("FIDELITY_CORRESPONDENCE", lambda: audit.glb_fidelity(wrong_type, marked_binary, 2, part, source))

    def test_every_source_semantic_is_checked_and_extra_identity_cannot_excuse_changed_uv_association(self):
        doc, binary, _raw, marked, marked_binary, _mr, part, _map, _req = fixture()
        source = audit.source_fidelity(doc, binary, part, 0)
        for name, reason, change in (("POSITION", "FIDELITY_POSITION", .001), ("NORMAL", "FIDELITY_NORMAL", .01),
                                     ("TANGENT", "FIDELITY_TANGENT", .01), ("TEXCOORD_0", "FIDELITY_UV", .001),
                                     ("COLOR_0", "FIDELITY_COLOR", .001)):
            values = attributes(marked, marked_binary)
            # Direction perturbation must affect a perpendicular component.
            values[name][0][1 if name == "TANGENT" else 0] += change
            out, data = exported(marked, values, list(range(6)))
            self.refused(reason, lambda: audit.glb_fidelity(out, data, 2, part, source))
        values = attributes(marked, marked_binary)
        values["TEXCOORD_0"][0], values["TEXCOORD_0"][3] = values["TEXCOORD_0"][3], values["TEXCOORD_0"][0]
        out, data = exported(marked, values, list(range(6)))
        self.refused("FIDELITY_UV", lambda: audit.glb_fidelity(out, data, 2, part, source))

    def test_tangent_handedness_cannot_be_hidden_by_matching_xyz(self):
        doc, binary, _raw, _m, _mb, _mr, part, _map, _req = fixture()
        source = audit.source_fidelity(doc, binary, part, 0); local, world = corner(source)
        local["TANGENT"][3] = -1
        self.refused("FIDELITY_TANGENT", lambda: audit.compare_fidelity_corner(source, 0, local, world))

    def test_local_source_frame_and_world_points_all_have_to_pass(self):
        doc, binary, _raw, _m, _mb, _mr, part, _map, _req = fixture()
        source = audit.source_fidelity(doc, binary, part, 0)
        local, world = corner(source); local["POSITION"][0] += .001
        self.refused("FIDELITY_POSITION", lambda: audit.compare_fidelity_corner(source, 0, local, world))
        local, world = corner(source); world["POSITION"][0] += .001
        self.refused("FIDELITY_POSITION", lambda: audit.compare_fidelity_corner(source, 0, local, world))

    def test_small_world_error_cannot_hide_large_source_frame_error_and_the_reverse(self):
        for scale, displacement, source_frame_fails in ((.001, .000001, True), (100, .0002, False)):
            doc, binary, _raw, _m, _mb, _mr, part, _map, _req = fixture()
            doc["nodes"][0]["scale"] = [scale]*3; doc["nodes"][0]["translation"] = [0, 0, 0]
            doc["nodes"][1]["scale"] = [1, 1, 1]
            source = audit.source_fidelity(doc, binary, {**part, "worldMatrix": audit.worlds(doc)[1]}, 0)
            local, world = corner(source); world["POSITION"][0] += displacement
            if source_frame_fails:
                audit.policy_distance(audit.position(source["world"], local["POSITION"]), world["POSITION"], audit.POSITION_LIMIT, "FIDELITY_POSITION")
            else:
                audit.policy_distance(local["POSITION"], audit.position(source["inverse"], world["POSITION"]), audit.POSITION_LIMIT, "FIDELITY_POSITION")
            self.refused("FIDELITY_POSITION", lambda: audit.compare_fidelity_corner(source, 0, local, world))

    def test_local_and_world_direction_measurements_are_both_required(self):
        doc, binary, _raw, _m, _mb, _mr, part, _map, _req = fixture()
        source = audit.source_fidelity(doc, binary, part, 0)
        local, world = corner(source); local["NORMAL"][0] += .01
        self.refused("FIDELITY_NORMAL", lambda: audit.compare_fidelity_corner(source, 0, local, world))
        local, world = corner(source); world["NORMAL"][0] += .01
        self.refused("FIDELITY_NORMAL", lambda: audit.compare_fidelity_corner(source, 0, local, world))

    def test_small_actual_change_can_pass_policy_while_retaining_its_different_measurement_digest(self):
        doc, binary, _raw, marked, marked_binary, _mr, part, _map, _req = fixture()
        source = audit.source_fidelity(doc, binary, part, 0); values = attributes(marked, marked_binary)
        values["POSITION"][1][0] += .000002
        out, data = exported(marked, values, list(range(6)))
        audit.glb_fidelity(out, data, 2, part, source)
        measured = audit.primitive_geometry(out, data, 2, 0, source["semantics"])[0]
        self.assertNotEqual(measured, source["geometry"])

    def test_exact_graph_parentage_and_local_transforms_reject_world_preserving_reparenting(self):
        _d, _b, _r, marked, _mb, _mr, _p, mapping, _req = fixture()
        audit.glb_node_bindings(marked, mapping, input_indices=True)
        changed = deepcopy(marked); old_world = audit.worlds(marked)[2]
        changed["nodes"][1].pop("children"); changed["nodes"][0]["children"].append(2)
        parent_inverse = audit.policy_inverse(audit.worlds(changed)[0])
        changed["nodes"][2]["matrix"] = audit.multiply_matrix(parent_inverse, old_world)
        self.refused("FIDELITY_HIERARCHY", lambda: audit.glb_node_bindings(changed, mapping))
        changed = deepcopy(marked); changed["nodes"][0]["translation"][0] += .001
        self.refused("FIDELITY_TRANSFORM", lambda: audit.glb_node_bindings(changed, mapping))

    def test_unknown_duplicate_or_missing_node_keys_and_cycles_refuse(self):
        _d, _b, _r, marked, _mb, _mr, _p, mapping, _req = fixture()
        for key in (None, "node99", "node0"):
            changed = deepcopy(marked); changed["nodes"][2]["extras"][audit.NODE_KEY] = key
            self.refused("FIDELITY_HIERARCHY", lambda: audit.glb_node_bindings(changed, mapping))
        cycle = deepcopy(mapping); cycle["nodes"][0]["parentKey"] = "node1"
        self.refused("FIDELITY_HIERARCHY", lambda: audit.hierarchy_map(cycle))

    def test_effective_locals_use_each_actual_world_once_without_reading_rna_local(self):
        _d, _b, _r, _m, _mb, _mr, _p, mapping, request = fixture()
        scene, objects = observed_scene(mapping)
        found, rows = worker.mapped_scene_nodes(scene, mapping, request, False)
        self.assertEqual(set(found), set(objects))
        self.assertTrue(all(found[key] is obj for key, obj in objects.items()))
        self.assertEqual({key: obj.world_reads for key, obj in objects.items()}, dict.fromkeys(objects, 1))
        expected = audit.hierarchy_map(mapping)
        for row in rows:
            self.assertEqual(row["worldMatrix"], objects[row["nodeKey"]].actual_world)
            audit.compare_fidelity_transform(expected[row["nodeKey"]]["localMatrix"], row["localMatrix"])
        # Repeated controlled snapshots keep exact rows; production's actual
        # saved/reopened comparison remains unchanged and requires native proof.
        _found, reopened = worker.mapped_scene_nodes(scene, mapping, request, False)
        self.assertEqual(rows, reopened)
        self.assertEqual({key: obj.world_reads for key, obj in objects.items()}, dict.fromkeys(objects, 2))

    def test_effective_local_rows_retain_actual_allowed_motion_instead_of_source_values(self):
        _d, _b, _r, _m, _mb, _mr, _p, mapping, request = fixture()
        actual = deepcopy(audit.hierarchy_worlds(mapping))
        for matrix in actual.values(): matrix[12] += audit.TRANSLATION_LIMIT/2
        scene, _objects = observed_scene(mapping, actual)
        _found, rows = worker.mapped_scene_nodes(scene, mapping, request, False)
        root = next(row for row in rows if row["parentKey"] is None)
        self.assertEqual(root["localMatrix"], actual[root["nodeKey"]])
        self.assertEqual(root["worldMatrix"], actual[root["nodeKey"]])
        original = next(row for row in mapping["nodes"] if row["nodeKey"] == root["nodeKey"])
        self.assertNotEqual(root["localMatrix"], original["localMatrix"])
        for row in rows: self.assertEqual(row["worldMatrix"], actual[row["nodeKey"]])

    def test_effective_local_graph_and_object_parent_type_are_validated_before_sampling(self):
        _d, _b, _r, _m, _mb, _mr, _p, mapping, request = fixture()
        for mode in ("BONE", "VERTEX", "VERTEX_3", "wrong-parent", "missing-parent"):
            with self.subTest(mode=mode):
                scene, objects = observed_scene(mapping)
                if mode == "wrong-parent": objects["node1_primitive0"].parent = objects["node0"]
                elif mode == "missing-parent": objects["node1"].parent = None
                else: objects["node1"].parent_type = mode
                self.refused("FIDELITY_HIERARCHY", lambda: worker.mapped_scene_nodes(scene, mapping, request, False))
                self.assertTrue(all(obj.world_reads == 0 for obj in objects.values()))

    def test_effective_local_missing_duplicate_or_foreign_objects_refuse_before_sampling(self):
        _d, _b, _r, _m, _mb, _mr, _p, mapping, request = fixture()
        for mode in ("missing", "duplicate", "foreign"):
            with self.subTest(mode=mode):
                scene, objects = observed_scene(mapping)
                if mode == "missing": scene.objects.pop()
                elif mode == "duplicate": scene.objects.append(objects["node1"])
                else: objects["node1"][audit.NODE_KEY] = "node99"
                self.refused("FIDELITY_HIERARCHY", lambda: worker.mapped_scene_nodes(scene, mapping, request, False))
                self.assertTrue(all(obj.world_reads == 0 for obj in objects.values()))

    def test_effective_local_sampling_never_repairs_nonaffine_or_ill_conditioned_actual_worlds(self):
        _d, _b, _r, _m, _mb, _mr, _p, mapping, request = fixture()
        for mode, reason in (("affine", "FIDELITY_TRANSFORM"), ("nonfinite", "FIDELITY_TRANSFORM"),
                             ("singular", "FIDELITY_CONDITION"), ("condition", "FIDELITY_CONDITION")):
            with self.subTest(mode=mode):
                actual = deepcopy(audit.hierarchy_worlds(mapping))
                if mode == "affine": actual["node0"][15] = 1-2**-24
                elif mode == "nonfinite": actual["node0"][0] = math.nan
                else:
                    actual["node0"] = identity()
                    actual["node0"][0] = 0 if mode == "singular" else .00001
                scene, _objects = observed_scene(mapping, actual)
                self.refused(reason, lambda: worker.mapped_scene_nodes(scene, mapping, request, False))

    def test_effective_derived_locals_still_refuse_actual_translation_linear_and_handedness_changes(self):
        _d, _b, _r, _m, _mb, _mr, _p, mapping, request = fixture()
        for mode in ("translation", "linear", "handedness"):
            with self.subTest(mode=mode):
                changed = deepcopy(mapping)
                local = changed["nodes"][1]["localMatrix"]
                if mode == "translation": local[12] += 2*audit.TRANSLATION_LIMIT
                else:
                    factor = -1 if mode == "handedness" else 1+2*audit.LINEAR_LIMIT
                    for axis in range(3): local[axis] *= factor
                # The controlled actual graph is internally coherent; rejection
                # comes from its unchanged comparison with the original map.
                scene, _objects = observed_scene(mapping, audit.hierarchy_worlds(changed))
                self.refused("FIDELITY_TRANSFORM", lambda: worker.mapped_scene_nodes(scene, mapping, request, False))

    def test_material_image_collector_covers_recursive_and_disconnected_nodes_without_changing_record(self):
        direct, nested, disconnected, unrelated = (SceneImage() for _ in range(4))
        deepest = material_tree(material_node(nested))
        material = scene_material(material_tree(material_node(direct), material_node(group=material_tree(material_node(group=deepest))), material_node(disconnected)))
        before = audit.material_graph(material)
        pointers = set(); collected = audit.material_graph(material, image_pointers=pointers)
        self.assertEqual(collected, before)
        self.assertEqual(audit.sha(audit.canonical(collected)), audit.sha(audit.canonical(before)))
        self.assertEqual(pointers, {direct.as_pointer(), nested.as_pointer(), disconnected.as_pointer()})
        self.assertNotIn(unrelated.as_pointer(), pointers)

    def test_scene_packing_exempts_only_unreferenced_typed_viewers_and_keeps_all_file_validation(self):
        source, already, unreferenced = SceneImage(), SceneImage(packed=True), SceneImage()
        unreferenced.name = "Render Result"  # A name never supplies an exemption.
        generated = SceneImage("GENERATED", "UV_TEST")
        result, compositor = SceneImage("VIEWER", "RENDER_RESULT"), SceneImage("VIEWER", "COMPOSITING")
        material = scene_material(material_tree(material_node(source)))
        before = audit.material_graph(material)
        bpy, objects = image_scene([source, already, unreferenced, generated, result, compositor], material)
        worker.pack_scene_images(bpy, objects)
        self.assertEqual([image.pack_calls for image in bpy.data.images], [1, 0, 1, 0, 0, 0])
        self.assertIsNotNone(source.packed_file); self.assertIsNotNone(unreferenced.packed_file)
        self.assertEqual(audit.material_graph(material), before)
        self.assertEqual(len(bpy.data.images), 6)  # No data-block was deleted.

    def test_referenced_viewers_refuse_even_through_nested_or_disconnected_material_nodes(self):
        for image_type in ("RENDER_RESULT", "COMPOSITING"):
            for location in ("direct", "nested", "disconnected"):
                with self.subTest(image_type=image_type, location=location):
                    image = SceneImage("VIEWER", image_type)
                    node = material_node(image); images = [image]
                    if location == "nested": tree = material_tree(material_node(group=material_tree(material_node(group=material_tree(node)))))
                    elif location == "disconnected":
                        other = SceneImage(); images.append(other)
                        tree = material_tree(material_node(other), node)
                    else: tree = material_tree(node)
                    bpy, objects = image_scene(images, scene_material(tree))
                    self.refused("MATERIAL", lambda: worker.pack_scene_images(bpy, objects))
                    self.assertEqual(image.pack_calls, 0)

    def test_unknown_viewer_types_and_unsupported_image_sources_do_not_gain_exemption(self):
        for source, image_type in (("VIEWER", "IMAGE"), ("VIEWER", "UV_TEST"), ("VIEWER", "UNKNOWN"),
                                   ("MOVIE", "IMAGE"), ("SEQUENCE", "IMAGE"), ("TILED", "IMAGE"), ("UNKNOWN", "RENDER_RESULT")):
            with self.subTest(source=source, image_type=image_type):
                image = SceneImage(source, image_type)
                bpy, objects = image_scene([image])
                self.refused("MATERIAL", lambda: worker.pack_scene_images(bpy, objects))
                self.assertEqual(image.pack_calls, 0)

    def test_failed_image_packing_refuses_or_propagates_without_false_packed_state(self):
        image = SceneImage(packs=False)
        bpy, objects = image_scene([image])
        self.refused("MATERIAL", lambda: worker.pack_scene_images(bpy, objects))
        self.assertEqual(image.pack_calls, 1); self.assertIsNone(image.packed_file)
        thrown = SceneImage(packs="raises")
        bpy, objects = image_scene([thrown])
        with self.assertRaisesRegex(RuntimeError, "^controlled image pack failure$"):
            worker.pack_scene_images(bpy, objects)
        self.assertEqual(thrown.pack_calls, 1); self.assertIsNone(thrown.packed_file)

    def test_image_collection_keeps_graph_cycle_link_and_pixel_refusals_before_packing(self):
        for mode in ("cycle", "link", "pixels"):
            with self.subTest(mode=mode):
                image = SceneImage(); tree = material_tree(material_node(image))
                if mode == "cycle": tree.nodes.append(material_node(group=tree))
                elif mode == "link": tree.links.append(SimpleNamespace(is_valid=False))
                else: image.pixels = ImagePixels([])
                bpy, objects = image_scene([image], scene_material(tree))
                self.refused("MATERIAL", lambda: worker.pack_scene_images(bpy, objects))
                self.assertEqual(image.pack_calls, 0)

    def test_export_operator_finished_still_calls_once_with_exact_original_arguments(self):
        operator = ControlledOperator(); arguments = {"filepath": "fixed-owned.glb", "export_format": "GLB"}
        self.assertIsNone(worker.operate(operator, arguments, export_diagnostics=True))
        self.assertEqual(operator.calls, [arguments])

    def test_export_operator_exception_categories_are_finite_and_exclude_messages(self):
        for exception_type, reason in ((TypeError, "OPERATOR_ARGUMENT"), (ValueError, "OPERATOR_ARGUMENT"),
                                       (RuntimeError, "OPERATOR_RUNTIME"), (KeyError, "OPERATOR_EXCEPTION")):
            with self.subTest(exception_type=exception_type.__name__):
                operator = ControlledOperator(failure=exception_type("untrusted diagnostic detail must not escape"))
                with self.assertRaises(audit.ConversionFailure) as failure:
                    worker.operate(operator, {"filepath": "fixed-owned.glb"}, export_diagnostics=True)
                self.assertEqual(failure.exception.reason, reason)
                self.assertEqual(str(failure.exception), reason)
                self.assertTrue(failure.exception.__suppress_context__)
                self.assertEqual(len(operator.calls), 1)

    def test_export_operator_cancelled_and_other_results_remain_failures_without_retry(self):
        for result, reason in (({"CANCELLED"}, "OPERATOR_CANCELLED"), ({"RUNNING_MODAL"}, "OPERATOR_RESULT"),
                               ({"FINISHED", "CANCELLED"}, "OPERATOR_RESULT"), (None, "OPERATOR_RESULT"), ({}, "OPERATOR_RESULT")):
            with self.subTest(result=result):
                operator = ControlledOperator(); operator.result = result
                self.refused(reason, lambda: worker.operate(operator, {}, export_diagnostics=True))
                self.assertEqual(len(operator.calls), 1)

    def test_export_operator_preserves_existing_custody_and_conversion_failures(self):
        for original in (OSError("controlled custody failure"), audit.ConversionFailure("SOURCE")):
            with self.subTest(exception_type=type(original).__name__):
                operator = ControlledOperator(failure=original)
                with self.assertRaises(type(original)) as failure:
                    worker.operate(operator, {}, export_diagnostics=True)
                self.assertIs(failure.exception, original)
                self.assertEqual(len(operator.calls), 1)

    def test_nonexport_operator_exception_and_result_behavior_is_unchanged(self):
        for original in (TypeError("controlled argument failure"), ValueError("controlled value failure"),
                         RuntimeError("controlled runtime failure"), KeyError("controlled other failure"),
                         OSError("controlled custody failure"), audit.ConversionFailure("SOURCE")):
            with self.subTest(exception_type=type(original).__name__):
                operator = ControlledOperator(failure=original)
                with self.assertRaises(type(original)) as failure: worker.operate(operator, {})
                self.assertIs(failure.exception, original)
                self.assertEqual(len(operator.calls), 1)
        operator = ControlledOperator(); operator.result = {"CANCELLED"}
        self.refused("NATIVE", lambda: worker.operate(operator, {}))
        self.assertEqual(len(operator.calls), 1)

    def test_operator_property_admission_stays_fail_closed_before_dispatch(self):
        for diagnostics in (False, True):
            operator = ControlledOperator(properties={"filepath"})
            self.refused("FEATURE", lambda: worker.operate(operator, {"foreign_option": True}, export_diagnostics=diagnostics))
            self.assertEqual(operator.calls, [])

    def test_actual_export_wrapper_enables_fixed_diagnostics_and_retains_fidelity_options(self):
        with tempfile.TemporaryDirectory(prefix="arcane-export-diagnostics-") as temporary:
            directory = Path(temporary).resolve()
            for materials in ("EXPORT", "NONE"):
                operator = ControlledOperator(failure=ValueError("controlled operator argument failure"))
                bpy = SimpleNamespace(ops=SimpleNamespace(export_scene=SimpleNamespace(gltf=operator)),
                                      context=SimpleNamespace(view_layer=SimpleNamespace(objects=ControlledViewObjects())))
                self.refused("OPERATOR_ARGUMENT", lambda: worker.export_model(bpy, directory, "asset.glb", [], materials))
                self.assertEqual(len(operator.calls), 1)
                arguments = operator.calls[0]
                self.assertEqual(arguments["export_format"], "GLB")
                self.assertEqual(arguments["export_materials"], materials)
                self.assertEqual(arguments["export_vertex_color"], "ACTIVE")
                self.assertEqual(arguments["export_image_format"], "AUTO")
                for key in ("export_texcoords", "export_normals", "export_tangents", "export_all_vertex_colors", "export_attributes", "export_extras"):
                    self.assertIs(arguments[key], True)
                for key in ("export_apply", "export_animations", "export_skins", "export_morph", "export_cameras", "export_lights", "export_gpu_instances", "export_draco_mesh_compression_enable", "export_use_gltfpack"):
                    self.assertIs(arguments[key], False)
                self.assertFalse((directory / "asset.glb").exists())

    def test_save_observer_forwards_once_and_restores_exact_binding_and_return_identity(self):
        calls = []; result = object(); argument = object(); keyword = object()
        def original(*arguments, **keywords):
            calls.append((arguments, keywords)); return result
        bindings = controlled_observer(original); module = bindings[0]
        with patch.object(worker, "_export_observer_bindings", return_value=bindings):
            with worker._observe_export_save(None) as observation:
                self.assertIs(module.save(argument, item=keyword), result)
                self.assertEqual(observation, {"available": True, "entries": 1, "returned": True, "failure": None})
        self.assertIs(module.save, original)
        self.assertEqual(calls, [((argument,), {"item": keyword})])

    def test_save_observer_restores_on_exception_control_exit_and_classifier_failure(self):
        for original_error in (FileNotFoundError("private path"), KeyboardInterrupt()):
            for broken_classifier in (False, True):
                with self.subTest(kind=type(original_error).__name__, classifier=broken_classifier):
                    def original(*_a, **_k): raise original_error
                    bindings = controlled_observer(original); module = bindings[0]
                    with patch.object(worker, "_export_observer_bindings", return_value=bindings):
                        classifier = (patch.object(worker, "_export_site", side_effect=ValueError("observer fault")) if broken_classifier else
                                      patch.object(worker, "_export_site", wraps=worker._export_site))
                        with classifier:
                            with self.assertRaises(type(original_error)) as caught:
                                with worker._observe_export_save(None) as observation:
                                    module.save()
                    self.assertIs(caught.exception, original_error)
                    self.assertIs(module.save, original)
                    if broken_classifier or isinstance(original_error, KeyboardInterrupt):
                        self.assertEqual(worker._observed_export_reason(observation), "OPERATOR_RUNTIME")

    def test_save_observer_categories_use_exact_types_without_subclass_attributes(self):
        class ForeignMissing(FileNotFoundError):
            def __getattribute__(self, _name): raise AssertionError("subclass attribute must not be read")
        for failure, category in ((FileNotFoundError("sensitive"), "MISSING"), (PermissionError("sensitive"), "ACCESS"),
                                  (OSError("sensitive"), "IO"), (FileExistsError("sensitive"), "IO"),
                                  (NotADirectoryError("sensitive"), "IO"), (TypeError("sensitive"), "ARGUMENT"),
                                  (ValueError("sensitive"), "ARGUMENT"), (RuntimeError("sensitive"), "OTHER"),
                                  (ForeignMissing("sensitive"), "OTHER")):
            self.assertEqual(worker._export_category(failure), category)

    def test_save_observer_directory_and_write_are_caller_sites_not_shared_helper_names(self):
        def shared(failure): raise failure
        def caller(failure): shared(failure)
        line = caller.__code__.co_firstlineno + 0  # One-line body has its declaration line.
        for site, intervals in (("DIRECTORY", ((line, line, "DIRECTORY"), (None, None, "SAVE"))),
                                ("WRITE", ((line, None, "WRITE"), (None, None, "SAVE")))):
            try: caller(FileNotFoundError("no paths retained"))
            except FileNotFoundError as failure:
                self.assertEqual(worker._export_site(failure, ((caller.__code__, intervals),)), site)
                self.assertEqual(worker._export_site(failure, ((caller.__code__, ((line + 1, line + 1, site), (None, None, "SAVE"))),)), "SAVE")

    def test_save_observer_requires_code_identity_and_rejects_overlong_tracebacks(self):
        def original(failure): raise failure
        clone = FunctionType(original.__code__.replace(), globals())
        self.assertIsNot(clone.__code__, original.__code__)
        try: clone(FileNotFoundError("fake DIRECTORY line59"))
        except FileNotFoundError as failure:
            self.assertIsNone(worker._export_site(failure, ((original.__code__, ((None, None, "DIRECTORY"),)),)))
        def recurse(depth):
            if depth: return recurse(depth - 1)
            raise FileNotFoundError("bounded traceback")
        for depth, expected in ((8, "SAVE"), (70, None)):
            try: recurse(depth)
            except FileNotFoundError as failure:
                self.assertEqual(worker._export_site(failure, ((recurse.__code__, ((None, None, "SAVE"),)),)), expected)

    def test_save_observer_reports_all_fifteen_closed_pairs_without_report_text_or_exception_storage(self):
        errors = ((FileNotFoundError, "MISSING"), (PermissionError, "ACCESS"), (FileExistsError, "IO"),
                  (ValueError, "ARGUMENT"), (RuntimeError, "OTHER"))
        self.assertEqual(len(worker._EXPORT_OBSERVED_REASONS), 15)
        for site in ("DIRECTORY", "WRITE", "SAVE"):
            for error_type, category in errors:
                with self.subTest(site=site, category=category):
                    original_error = error_type("secret/source/name OPERATOR_DIRECTORY_MISSING")
                    def original(*_a, **_k): raise original_error
                    bindings = controlled_observer(original, site); module = bindings[0]
                    operator = ControlledReportingOperator(module)
                    with patch.object(worker, "_export_observer_bindings", return_value=bindings):
                        with worker._observe_export_save(None) as observation:
                            reason = "OPERATOR_" + site + "_" + category
                            self.refused(reason, lambda: worker.operate(operator, {}, export_diagnostics=True, export_observation=observation))
                    self.assertIs(operator.escaped, original_error)
                    self.assertIs(module.save, original)
                    self.assertEqual(len(operator.calls), 1)
                    self.assertNotIn("secret", audit.canonical(observation).decode())
                    self.assertTrue(all(type(value) in (bool, int, str, type(None)) for value in observation.values()))
                    self.assertIn(reason, audit.REASONS)

    def test_save_observer_before_after_and_multiple_entries_are_observations_without_retry(self):
        for before, after, repeat, expected in ((True, False, 1, "OPERATOR_BEFORE_SAVE"),
                                                (False, True, 1, "OPERATOR_AFTER_SAVE"),
                                                (False, True, 2, "OPERATOR_RUNTIME")):
            calls = []
            def original(*arguments): calls.append(arguments); return {"FINISHED"}
            bindings = controlled_observer(original); operator = ControlledReportingOperator(bindings[0], before=before, after=after, repeat=repeat)
            with patch.object(worker, "_export_observer_bindings", return_value=bindings):
                with worker._observe_export_save(None) as observation:
                    self.refused(expected, lambda: worker.operate(operator, {}, export_diagnostics=True, export_observation=observation))
            self.assertEqual(len(operator.calls), 1)
            self.assertEqual(len(calls), 0 if before else repeat)
            self.assertIs(bindings[0].save, original)

    def test_save_observer_does_not_promote_handled_errors_or_change_success_and_cancel(self):
        def original(*_a, **_k):
            try: raise PermissionError("handled image-style error")
            except PermissionError: return {"FINISHED"}
        bindings = controlled_observer(original)
        for result in ({"FINISHED"}, {"CANCELLED"}):
            operator = ControlledReportingOperator(bindings[0]); operator.result = result
            with patch.object(worker, "_export_observer_bindings", return_value=bindings):
                with worker._observe_export_save(None) as observation:
                    if result == {"FINISHED"}:
                        self.assertIsNone(worker.operate(operator, {}, export_diagnostics=True, export_observation=observation))
                    else:
                        self.refused("OPERATOR_CANCELLED", lambda: worker.operate(operator, {}, export_diagnostics=True, export_observation=observation))
                    self.assertIsNone(observation["failure"])
            self.assertEqual(len(operator.calls), 1)
            self.assertIs(bindings[0].save, original)

    def test_save_observer_unavailable_setup_does_not_block_or_change_existing_error(self):
        for setup_error in (None, ValueError("private setup failure")):
            for failure in (None, RuntimeError("private operator failure")):
                operator = ControlledOperator(failure=failure)
                with patch.object(worker, "_export_observer_bindings", return_value=None, side_effect=setup_error):
                    with worker._observe_export_save(None) as observation:
                        if failure is None:
                            self.assertIsNone(worker.operate(operator, {}, export_diagnostics=True, export_observation=observation))
                        else:
                            self.refused("OPERATOR_RUNTIME", lambda: worker.operate(operator, {}, export_diagnostics=True, export_observation=observation))
                self.assertEqual(len(operator.calls), 1)

    def test_save_observer_validates_owned_sources_packages_functions_and_lazy_import_targets(self):
        with tempfile.TemporaryDirectory(prefix="arcane-observer-source-") as temporary:
            bpy, root, pins, modules = observer_installation(Path(temporary).resolve())
            export = modules["io_scene_gltf2.blender.exp.export"]
            lazy = {name: module for name, module in modules.items() if name.endswith(".export")}
            loaded = {name: module for name, module in modules.items() if name not in lazy}
            def fixed_import(name):
                self.assertIn(name, lazy)
                sys.modules[name] = lazy[name]
                return lazy[name]
            with patch.dict(sys.modules, loaded), patch.object(worker, "_EXPORT_SOURCE_PINS", pins), patch.object(worker.importlib, "import_module", side_effect=fixed_import) as imports:
                # Ensure the actual loader has to perform its fixed lazy loads.
                with patch.dict(sys.modules, {name: None for name in lazy}):
                    for name in lazy: del sys.modules[name]
                    bindings = worker._export_observer_bindings(bpy)
                    self.assertIsNotNone(bindings)
                    self.assertIs(bindings[0], export)
                    self.assertIs(bindings[1], export.save)
                    self.assertEqual([call.args[0] for call in imports.call_args_list], list(lazy))
                    self.assertEqual(bindings[2][1][1][:2], ((59, 59, "DIRECTORY"), (62, 62, "DIRECTORY")))
                    self.assertEqual(bindings[2][2][1][0], (85, None, "WRITE"))

    def test_save_observer_refuses_changed_sources_foreign_packages_and_function_origins_before_mutation(self):
        for mode in ("hash", "post-import-hash", "namespace-code", "foreign-search", "function-origin", "version"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="arcane-observer-refusal-") as temporary:
                bpy, root, pins, modules = observer_installation(Path(temporary).resolve())
                export = modules["io_scene_gltf2.blender.exp.export"]; original = export.save
                target = root / "blender/exp/export.py"
                def change_source():
                    raw = target.read_bytes(); target.write_bytes(b"X" + raw[1:])
                if mode == "hash": change_source()
                elif mode == "namespace-code": (root / "blender/exp/__init__.py").write_bytes(b"unrecognized initializer")
                elif mode == "foreign-search": modules["io_scene_gltf2"].__path__ = [str(root), str(root.parent)]
                elif mode == "function-origin": export.save = observer_source_stub
                elif mode == "version": bpy.app.version = (5, 2, 4)
                expected = export.save
                def fixed_import(name):
                    if mode == "post-import-hash": change_source()
                    return modules[name]
                with patch.dict(sys.modules, modules), patch.object(worker, "_EXPORT_SOURCE_PINS", pins), patch.object(worker.importlib, "import_module", side_effect=fixed_import):
                    self.assertIsNone(worker._export_observer_bindings(bpy))
                self.assertIs(export.save, expected)
                if mode != "function-origin": self.assertIs(export.save, original)

    def test_actual_export_wrapper_uses_observation_without_changing_selected_arguments(self):
        with tempfile.TemporaryDirectory(prefix="arcane-export-observed-") as temporary:
            directory = Path(temporary).resolve()
            original_error = PermissionError("private owned output name")
            def original(*_a): raise original_error
            bindings = controlled_observer(original, "DIRECTORY")
            operator = ControlledReportingOperator(bindings[0])
            bpy = SimpleNamespace(ops=SimpleNamespace(export_scene=SimpleNamespace(gltf=operator)),
                                  context=SimpleNamespace(view_layer=SimpleNamespace(objects=ControlledViewObjects())))
            with patch.object(worker, "_export_observer_bindings", return_value=bindings):
                self.refused("OPERATOR_DIRECTORY_ACCESS", lambda: worker.export_model(bpy, directory, "asset.glb", [], "EXPORT"))
            self.assertEqual(len(operator.calls), 1)
            self.assertEqual(operator.calls[0]["filepath"], str(directory / "asset.glb"))
            self.assertIs(operator.calls[0]["export_tangents"], True)
            self.assertIs(operator.calls[0]["export_use_gltfpack"], False)
            self.assertIs(bindings[0].save, original)
            self.assertFalse((directory / "asset.glb").exists())

    def test_collision_position_targets_use_exact_finite_values_without_distance_or_centroid(self):
        vertices = [CollisionVertex(value) for value in ((0, 0, 0), (-0.0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1), (2**-30, 0, 0))]
        targets, unique = worker._collision_position_targets(vertices)
        self.assertEqual(unique, 5)
        self.assertEqual(targets, {vertices[1]: vertices[0]})
        self.assertNotIn(vertices[-1], targets)
        for value in (math.nan, math.inf, -math.inf):
            self.refused("COLLISION", lambda: worker._collision_position_targets([CollisionVertex((value, 0, 0))]))

    def test_collision_normal_seam_copy_has_original_position_hash_and_no_model_mutation(self):
        results = []
        for split in (False, True):
            obj = collision_fixture(split); before = deepcopy(vars(obj.data))
            module, created, calls = collision_module()
            with patch.dict(sys.modules, {"bmesh": module}): results.append(worker.proxy_geometry(obj, None))
            self.assertEqual(vars(obj.data), before)
            self.assertEqual(len(created), 1); self.assertTrue(created[0].freed)
            self.assertEqual(len(calls), int(split))
            if split:
                self.assertEqual(len(calls[0]["pairs"]), 8)
                self.assertTrue(all(source == target for source, target in calls[0]["pairs"]))
                self.assertIs(calls[0]["use_centroid"], False); self.assertIs(calls[0]["average_vert_data"], False)
        self.assertEqual(results[0], results[1]); self.assertEqual(results[0][1], 4)

    def test_collision_near_position_cracks_remain_open_instead_of_using_a_tolerance(self):
        obj = collision_fixture(); obj.data.positions[3] = (2**-30, 0, 0)
        before = deepcopy(vars(obj.data)); module, created, calls = collision_module()
        with patch.dict(sys.modules, {"bmesh": module}):
            self.refused("COLLISION", lambda: worker.proxy_geometry(obj, None))
        self.assertEqual(len(calls), 1)
        self.assertTrue(all(source == target for source, target in calls[0]["pairs"]))
        self.assertTrue(created[0].freed); self.assertEqual(vars(obj.data), before)

    def test_collision_raw_area_volume_face_and_loose_edge_guards_precede_audit_weld(self):
        for mode in ("area", "planar", "polygon", "loose-edge"):
            with self.subTest(mode=mode):
                obj = collision_fixture()
                if mode == "area": obj.data.positions[1] = obj.data.positions[0]
                elif mode == "planar": obj.data.positions = [(x, y, 0) for x, y, _z in obj.data.positions]
                elif mode == "polygon": obj.data.triangles[0] = (0, 1, 2, 3)
                else: obj.data.loose_edge = True
                before = deepcopy(vars(obj.data)); module, created, calls = collision_module()
                with patch.dict(sys.modules, {"bmesh": module}):
                    self.refused("COLLISION", lambda: worker.proxy_geometry(obj, None))
                self.assertEqual(calls, []); self.assertTrue(created[0].freed)
                self.assertEqual(vars(obj.data), before)

    def test_collision_audit_weld_cannot_drop_faces_move_positions_or_erase_positive_volume(self):
        for mode in ("drop-face", "move-position", "zero-volume", "nonfinite-volume"):
            with self.subTest(mode=mode):
                obj = collision_fixture(); before = deepcopy(vars(obj.data))
                module, created, calls = collision_module(mode)
                with patch.dict(sys.modules, {"bmesh": module}):
                    self.refused("COLLISION", lambda: worker.proxy_geometry(obj, None))
                self.assertEqual(len(calls), 1); self.assertTrue(created[0].freed)
                self.assertEqual(vars(obj.data), before)

    def test_collision_audit_copy_is_freed_after_native_weld_exception(self):
        obj = collision_fixture(); before = deepcopy(vars(obj.data))
        module, created, calls = collision_module("raises")
        with patch.dict(sys.modules, {"bmesh": module}):
            with self.assertRaisesRegex(RuntimeError, "^controlled audit weld failure$"):
                worker.proxy_geometry(obj, None)
        self.assertEqual(len(calls), 1); self.assertTrue(created[0].freed)
        self.assertEqual(vars(obj.data), before)

    def test_strict_v2_inputs_refuse_prototype_or_caller_policy_and_keep_real_source_bytes(self):
        _d, _b, raw, _m, _mb, marked_raw, _p, mapping, request = fixture()
        with tempfile.TemporaryDirectory(prefix="arcane-policy-") as temporary:
            directory = Path(temporary).resolve()
            (directory / "source.glb").write_bytes(raw); (directory / "import-source.glb").write_bytes(marked_raw)
            (directory / "source-map.json").write_bytes(audit.canonical(mapping))
            def check(changed):
                encoded = audit.canonical(changed); (directory / "request.json").write_bytes(encoded)
                return audit.validate_inputs(directory, audit.sha(encoded))
            observed = check(request)
            self.assertEqual(observed[2:], (raw, marked_raw))
            for changed in ({**request, "schemaVersion": 1}, {**request, "fidelityPolicy": "relaxed"}, {**request, "positionTolerance": 1}):
                self.refused("INPUT", lambda: check(changed))
            for changed_map in ({**mapping, "schemaVersion": 1}, {**mapping, "fidelityPolicy": "relaxed"}):
                encoded = audit.canonical(changed_map); (directory / "source-map.json").write_bytes(encoded)
                self.refused("INPUT", lambda: check({**request, "sourceMapSha256": audit.sha(encoded)}))


if __name__ == "__main__":
    unittest.main()
