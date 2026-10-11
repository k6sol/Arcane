"""Read-only capability probe. Launched with factory startup and autoexec disabled."""
import json
import platform
import bpy


def supported(operator):
    try:
        operator.get_rna_type()
        return True
    except (AttributeError, RuntimeError):
        return False


engines = [item.identifier for item in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
result = {
    "version": bpy.app.version_string,
    "pythonVersion": platform.python_version(),
    "background": bpy.app.background,
    "capabilities": {
        "glbExport": supported(bpy.ops.export_scene.gltf),
        "glbImport": supported(bpy.ops.import_scene.gltf),
        "fbxExport": supported(bpy.ops.export_scene.fbx),
        "fbxImport": supported(bpy.ops.import_scene.fbx),
        "cycles": "CYCLES" in engines or hasattr(bpy.context.scene, "cycles"),
    },
}
print("ARCANE_RESULT " + json.dumps(result, sort_keys=True), flush=True)
