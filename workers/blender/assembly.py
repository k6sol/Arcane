"""Bundled data-only assembly builder. No eval, imports from input, file paths or external assets."""
import math
import bpy
import bmesh
from mathutils import Euler, Matrix, Vector


def unit_geometry(g):
    kind = g["kind"]
    if kind == "mesh":
        return g["vertices"], [g["indices"][i:i + 3] for i in range(0, len(g["indices"]), 3)]
    if kind == "box":
        return [(-.5, -.5, -.5), (.5, -.5, -.5), (.5, .5, -.5), (-.5, .5, -.5),
                (-.5, -.5, .5), (.5, -.5, .5), (.5, .5, .5), (-.5, .5, .5)], [
            (3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    segments = g["segments"]
    if not isinstance(segments, int) or not 8 <= segments <= 64 or segments % 4:
        raise ValueError("Invalid primitive segment bound")
    if kind == "sphere":
        rings = g["rings"]
        vertices = [(0, 0, -.5), (0, 0, .5)]
        for ring in range(1, rings):
            theta = ring * math.pi / rings
            for j in range(segments):
                phi = j * 2 * math.pi / segments
                vertices.append((.5 * math.sin(theta) * math.cos(phi), .5 * math.sin(theta) * math.sin(phi), -.5 * math.cos(theta)))
        faces = []
        for j in range(segments):
            nxt = (j + 1) % segments
            faces.append((0, 2 + nxt, 2 + j))
            for ring in range(rings - 2):
                a, b = 2 + ring * segments + j, 2 + ring * segments + nxt
                faces.append((a, b, b + segments, a + segments))
            a, b = 2 + (rings - 2) * segments + j, 2 + (rings - 2) * segments + nxt
            faces.append((a, b, 1))
        return vertices, faces
    if kind not in ("cylinder", "cone"):
        raise ValueError("Unknown assembly primitive")
    vertices = [(.5 * math.cos(j * 2 * math.pi / segments), .5 * math.sin(j * 2 * math.pi / segments), -.5) for j in range(segments)]
    faces = [tuple(reversed(range(segments)))]
    if kind == "cylinder":
        vertices += [(x, y, .5) for x, y, _ in vertices[:]]
        faces.append(tuple(range(segments, 2 * segments)))
        for j in range(segments):
            nxt = (j + 1) % segments
            faces.append((j, nxt, nxt + segments, j + segments))
    else:
        vertices.append((0, 0, .5))
        for j in range(segments):
            faces.append((j, (j + 1) % segments, segments))
    return vertices, faces


def rotation(degrees):
    return Euler(tuple(math.radians(n) for n in degrees), 'XYZ').to_matrix().to_4x4()


def socket_metrics(scene):
    bpy.context.view_layer.update()
    result = []
    for obj in scene.objects:
        if obj.type == 'EMPTY' and obj.get("arcane_socket_id"):
            result.append({"name": obj["arcane_socket_id"], "kind": obj["arcane_socket_kind"], "part": obj["arcane_socket_part"],
                           "nodeName": obj["arcane_socket_node"], "matrix": [float(n) for row in obj.matrix_world for n in row]})
    return sorted(result, key=lambda x: x["name"])


def build_assembly(request, make_material, make_collection, select):
    recipe = request["recipe"]
    if recipe["schemaVersion"] != 1 or not 2 <= len(recipe["parts"]) <= 96 or not 1 <= len(recipe["materials"]) <= 8 or len(recipe["sockets"]) > 64:
        raise ValueError("Assembly count/version gate failed")
    materials = {}
    for data in recipe["materials"]:
        mat = make_material("MAT_" + data["id"], data["color"], data["metallic"], data["roughness"])
        if data.get("emission"):
            shader = mat.node_tree.nodes.get("Principled BSDF")
            shader.inputs["Emission Color"].default_value = (*data["emission"]["color"], 1)
            shader.inputs["Emission Strength"].default_value = data["emission"]["strength"]
        materials[data["id"]] = mat
    groups = {role: make_collection(name) for role, name in [("render", "COL_CustomAssembly"), ("lod1", "COL_LOD1"), ("collision", "COL_Collision")]}
    objects = {"render": [], "lod1": [], "collision": []}
    parts = {}
    for part in recipe["parts"]:
        vertices, faces = unit_geometry(part["geometry"])
        if len(vertices) > 4096 or len(faces) > 8192:
            raise ValueError("Assembly mesh count gate failed")
        mesh = bpy.data.meshes.new(part["name"] + "_Mesh")
        mesh.from_pydata(vertices, [], faces)
        if mesh.validate(verbose=False):
            raise ValueError("Input mesh required structural repair")
        mesh.transform(Matrix.Diagonal(Vector((*part["dimensions"], 1))))
        bm = bmesh.new()
        try:
            bm.from_mesh(mesh)
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            bm.to_mesh(mesh)
        finally:
            bm.free()
        prefix = "COL_" if part["role"] == "collision" else "SM_"
        obj = bpy.data.objects.new(prefix + part["name"], mesh)
        groups[part["role"]].objects.link(obj)
        obj["arcane_role"], obj["arcane_part_id"] = part["role"], part["name"]
        if part.get("material"):
            mesh.materials.append(materials[part["material"]])
        if part.get("bevel"):
            select([obj])
            bevel = obj.modifiers.new("Recipe bevel", "BEVEL")
            bevel.width, bevel.segments = part["bevel"]["width"], part["bevel"]["segments"]
            bpy.ops.object.modifier_apply(modifier=bevel.name)
        for polygon in obj.data.polygons:
            polygon.use_smooth = part["geometry"]["kind"] == "sphere" or (part["geometry"]["kind"] in ("cylinder", "cone") and abs(polygon.normal.z) < .9)
        obj.data.transform(Matrix.Translation(Vector(part["position"])) @ rotation(part["rotationDegrees"]))
        obj.data.update()
        objects[part["role"]].append(obj)
        parts[part["name"]] = obj
    socket_group = make_collection("COL_Sockets")
    sockets = []
    for socket in recipe["sockets"]:
        part = next(p for p in recipe["parts"] if p["name"] == socket["part"])
        node_name = ("SOCK_" if socket["kind"] == "socket" else "ATT_") + socket["name"]
        obj = bpy.data.objects.new(node_name, None)
        socket_group.objects.link(obj)
        obj.parent = parts[part["name"]]
        obj.empty_display_type = 'ARROWS'
        obj.empty_display_size = .08
        obj["arcane_socket_id"], obj["arcane_socket_kind"] = socket["name"], socket["kind"]
        obj["arcane_socket_part"], obj["arcane_socket_node"] = socket["part"], node_name
        obj.matrix_world = Matrix.Translation(Vector(part["position"])) @ rotation(part["rotationDegrees"]) @ Matrix.Translation(Vector(socket["position"])) @ rotation(socket["rotationDegrees"])
        sockets.append(obj)
    bpy.context.view_layer.update()
    return objects["render"], objects["lod1"], objects["collision"], sockets


def assembly_evidence(request):
    scene = bpy.context.scene
    points = []
    for obj in scene.objects:
        if obj.type == 'MESH' and obj.get("arcane_role") == "render":
            points.extend(obj.matrix_world @ v.co for v in obj.data.vertices)
    # Node passes the digest/upper estimates from its validated normalized recipe.
    return {"recipeSha256": request["_recipeSha256"], "estimatedTriangles": request["_estimatedTriangles"],
            "bounds": {"min": [min(v[k] for v in points) for k in range(3)], "max": [max(v[k] for v in points) for k in range(3)]},
            "sockets": socket_metrics(scene), "artisticFidelity": "unverified", "robloxImport": "unverified"}
