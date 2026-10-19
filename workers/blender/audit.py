"""Measured mesh/UV/normal audit for the fixed static templates, no external modules."""
import math
import hashlib
import json
import bmesh
from mathutils import Vector


def material_metrics(mat):
    shader = next(node for node in mat.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
    result = {"name": mat.name, "color": list(shader.inputs["Base Color"].default_value)[:3],
            "metallic": float(shader.inputs["Metallic"].default_value), "roughness": float(shader.inputs["Roughness"].default_value),
            "emission": {"color": list(shader.inputs["Emission Color"].default_value)[:3], "strength": float(shader.inputs["Emission Strength"].default_value)}}
    if mat.get("arcane_surface"):
        from textures import surface_evidence
        result["surface"] = surface_evidence(mat)
    return result


def mesh_metrics(obj, role, imported=False):
    evaluated = obj.evaluated_get(__import__("bpy").context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    bm = bmesh.new()
    try:
        mesh.calc_loop_triangles()
        bm.from_mesh(mesh)
        bm.verts.index_update()
        bm.faces.index_update()
        bm.normal_update()
        coords = [tuple(v.co) for v in bm.verts]
        finite = all(math.isfinite(c) for v in coords for c in v)
        duplicate_verts = len(coords) - len(set(tuple(round(c, 6) for c in v) for v in coords))
        keys = [tuple(sorted(v.index for v in f.verts)) for f in bm.faces]
        duplicate_faces = len(keys) - len(set(keys))
        # Each connected closed component must have outward winding and positive volume.
        unseen = set(bm.faces)
        inverted = 0
        while unseen:
            pending = [unseen.pop()]
            volume = 0.0
            while pending:
                face = pending.pop()
                vs = list(face.verts)
                for i in range(1, len(vs) - 1):
                    volume += vs[0].co.dot(vs[i].co.cross(vs[i + 1].co)) / 6.0
                for edge in face.edges:
                    for adjacent in edge.link_faces:
                        if adjacent in unseen:
                            unseen.remove(adjacent)
                            pending.append(adjacent)
            if volume <= 1e-12:
                inverted += 1
        invalid_uvs, degenerate_uvs = 0, 0
        uv = mesh.uv_layers.active
        if uv:
            invalid_uvs = sum(not all(math.isfinite(c) and -1e-6 <= c <= 1.000001 for c in point.uv) for point in uv.data)
            for polygon in mesh.polygons:
                points = [uv.data[i].uv for i in polygon.loop_indices]
                area = abs(sum(a.x * b.y - b.x * a.y for a, b in zip(points, points[1:] + points[:1]))) / 2.0
                if area <= 1e-12:
                    degenerate_uvs += 1
        result = {
            "name": obj.name, "role": role,
            "vertices": len(mesh.vertices), "edges": len(mesh.edges), "faces": len(mesh.polygons),
            "triangles": len(mesh.loop_triangles), "nonManifoldEdges": sum(not e.is_manifold for e in bm.edges),
            "looseVertices": sum(not v.link_edges for v in bm.verts), "looseEdges": sum(not e.link_faces for e in bm.edges),
            "duplicateVertices": duplicate_verts, "duplicateFaces": duplicate_faces,
            "degenerateFaces": sum(f.calc_area() <= 1e-10 for f in bm.faces),
            "inconsistentNormals": sum(e.is_manifold and not e.is_contiguous for e in bm.edges),
            "invertedComponents": inverted, "finitePositions": finite,
            "uvLayers": len(mesh.uv_layers), "uvLoops": len(uv.data) if uv else 0,
            "invalidUVs": invalid_uvs, "degenerateUVFaces": degenerate_uvs,
            "dimensions": list(obj.dimensions), "scale": list(obj.scale), "rotation": list(obj.rotation_euler),
            "materials": [m.name for m in mesh.materials if m], "errors": [],
        }
        if obj.get("arcane_part_id"):
            world = [obj.matrix_world @ v.co for v in mesh.vertices]
            result["bounds"] = {"min": [min(v[k] for v in world) for k in range(3)], "max": [max(v[k] for v in world) for k in range(3)]}
            geometry = {"vertices": [[round(float(c), 6) for c in v.co] for v in mesh.vertices], "triangles": [list(t.vertices) for t in mesh.loop_triangles]}
            result["position"] = list(obj.location)
            result["materialProperties"] = [material_metrics(mat) for mat in mesh.materials if mat]
            result["geometrySha256"] = hashlib.sha256(json.dumps(geometry, separators=(',', ':')).encode()).hexdigest()
        elif obj.get("arcane_surface_uv") and obj.get("arcane_source_key") and role != "collision":
            result["materialProperties"] = [material_metrics(mat) for mat in mesh.materials if mat]
        errors = result["errors"]
        if not finite or any(not math.isfinite(d) or d <= 1e-6 for d in obj.dimensions):
            errors.append("Nonfinite coordinates or empty dimensions")
        for field in ["nonManifoldEdges", "looseVertices", "looseEdges", "duplicateFaces", "degenerateFaces", "inconsistentNormals", "invertedComponents"]:
            if result[field]:
                errors.append(field + ": " + str(result[field]))
        if not imported and duplicate_verts:
            errors.append("Duplicate vertices within 1e-6 meters")
        if any(abs(s - 1.0) > 1e-5 for s in obj.scale) or any(abs(r) > 1e-5 for r in obj.rotation_euler):
            errors.append("Unapplied scale/rotation")
        if not imported and not obj.name.startswith("COL_" if role == "collision" else "SM_"):
            errors.append("Invalid object naming")
        if role != "collision":
            if not uv or len(uv.data) != len(mesh.loops) or invalid_uvs or degenerate_uvs:
                errors.append("Missing, incomplete or degenerate UVs")
            if not 1 <= len(result["materials"]) <= 3:
                errors.append("Material count outside 1..3")
            for mat in mesh.materials:
                if not mat or not mat.use_nodes or not mat.name.startswith("MAT_"):
                    errors.append("Missing named node material")
                    continue
                if not all(link.is_valid for link in mat.node_tree.links):
                    errors.append("Invalid material node link")
                outputs = [node for node in mat.node_tree.nodes if node.type == "OUTPUT_MATERIAL" and node.is_active_output]
                if not outputs or not outputs[0].inputs["Surface"].is_linked:
                    errors.append("Material surface is disconnected")
                bsdf = next((node for node in mat.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
                if not bsdf:
                    errors.append("Missing PBR shader")
                else:
                    for socket in ["Metallic", "Roughness"]:
                        value = bsdf.inputs[socket].default_value
                        if not math.isfinite(value) or not 0 <= value <= 1:
                            errors.append("Invalid PBR " + socket)
        elif result["materials"]:
            errors.append("Collision has materials")
        return result
    finally:
        bm.free()
        evaluated.to_mesh_clear()


def audit_scene(objects, request):
    import bpy
    bpy.context.view_layer.update()
    meshes = [mesh_metrics(obj, obj["arcane_role"]) for obj in objects]
    totals = {
        "renderTriangles": sum(m["triangles"] for m in meshes if m["role"] == "render"),
        "lod1Triangles": sum(m["triangles"] for m in meshes if m["role"] == "lod1"),
        "collisionTriangles": sum(m["triangles"] for m in meshes if m["role"] == "collision"),
        "materials": len(set(mat for m in meshes for mat in m["materials"])),
    }
    errors = [m["name"] + ": " + error for m in meshes for error in m["errors"]]
    if not 0 < totals["renderTriangles"] <= request["triangleBudget"]:
        errors.append("Render triangle budget failed")
    if totals["materials"] > (8 if request.get("recipe") else 3):
        errors.append("Global material budget failed")
    if not 0 < totals["collisionTriangles"] <= request.get("recipe", {}).get("collisionTriangleBudget", 256):
        errors.append("Collision budget failed")
    if request["template"] == "hero-prop" and not 0 < totals["lod1Triangles"] < totals["renderTriangles"]:
        errors.append("Hero LOD did not reduce triangle count")
    if request.get("recipe") and (totals["lod1Triangles"] > request["recipe"]["lodTriangleBudget"] or (totals["lod1Triangles"] and totals["lod1Triangles"] >= totals["renderTriangles"])):
        errors.append("Custom LOD budget/reduction failed")
    return meshes, totals, errors


def render_metrics(path):
    import bpy
    image = bpy.data.images.load(str(path), check_existing=False)
    try:
        values = list(image.pixels)
        luminance = [0.2126 * values[i] + 0.7152 * values[i + 1] + 0.0722 * values[i + 2] for i in range(0, len(values), 4)]
        mean = sum(luminance) / len(luminance)
        variance = sum((v - mean) ** 2 for v in luminance) / len(luminance)
        result = {"path": path.name, "width": image.size[0], "height": image.size[1],
                  "finitePixels": all(math.isfinite(v) for v in values),
                  "minLuminance": min(luminance), "maxLuminance": max(luminance),
                  "meanLuminance": mean, "standardDeviation": math.sqrt(variance)}
        if not result["finitePixels"] or result["maxLuminance"] - result["minLuminance"] < 0.05 or result["standardDeviation"] < 0.005:
            raise ValueError("Review render is empty, uniform or nonfinite")
        return result
    finally:
        bpy.data.images.remove(image)
