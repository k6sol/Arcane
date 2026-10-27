"""Fixed conversion measurements, not a producer/permission assertion by JSON.

Canonical encoding v1 (independently reproducible): UTF-8 JSON with ASCII escapes,
sorted keys, separators=(',', ':'), no NaN. Numeric *samples* become integer
millionths, rounded half away from zero. Geometry is in glTF Y-up WORLD meters.
Each corner is a dict of source-present glTF semantics; triangles keep winding,
choose the lexicographically smallest of three cyclic rotations, then sort.
UV V is converted back from Blender. Missing source attributes never disappear
from the comparison. Names, vertex numbering and object order are not identity.

These hashes retain exact snapshot comparison semantics. V2 source fidelity
instead uses actual host-owned vertex/node correspondence and the fixed product
precision policy; a measured digest is never replaced with its source digest.

Material hashes describe actual Blender material flags and the complete shader
graph: sorted recursive node signatures, socket identifiers, linked signatures,
fixed semantic node properties/defaults and actual decoded image samples. Node,
material, image display names and paths are excluded. Image pixels are streamed
as signed little-endian int64 quantized RGBA samples; dimensions/colorspace are
included. Independently resolved original/export glTF material channels and image
pixels are ALSO compared; a graph hash is not that source-fidelity proof.

Only the bundled Blender worker imports this module. No bpy import at module load.
"""
import hashlib
import json
import math
import os
import re
import stat
import struct
from array import array
from collections import Counter
from pathlib import Path

JSON_BYTES = 512 * 1024
GLB_BYTES = 64 * 1024 * 1024
EXPORT_BYTES = 20_000_000
BLEND_BYTES = 128 * 1024 * 1024
IMAGE_PIXELS = 16_777_216
ORIGIN = "arcane_conversion_origin_v1"
IDENTITY = "arcane-converted-v2"
FIDELITY_POLICY = "arcane-static-fidelity-v1"
VERTEX_ID = "_ARCANE_SOURCE_VERTEX_ID"
NODE_KEY = "arcane_conversion_node_v2"
POSITION_LIMIT = 0.0001
TRANSLATION_LIMIT = 0.00001
DIRECTION_LIMIT = 0.02 * math.pi / 180
UV_LIMIT = 2 ** -20
COLOR_LIMIT = 1 / 65535
LINEAR_LIMIT = 2 ** -20
CONDITION_LIMIT = 10000
HASH = re.compile(r"[a-f0-9]{64}\Z")
UUID = re.compile(r"[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\Z")
REASONS = {"INPUT", "SOURCE", "MAP", "FEATURE", "GEOMETRY", "MATERIAL", "COLLISION", "EXPORT", "REOPEN", "RENDER", "IO", "NATIVE", "IO_PATH", "IO_LINK", "IO_TYPE", "IO_SIZE", "IO_IDENTITY", "IO_READ", "IO_CHANGED", "IO_EXISTS", "IO_ACCESS", "GEOMETRY_COUNTS", "GEOMETRY_TRANSFORM", "GEOMETRY_DIRECTION", "GEOMETRY_TOPOLOGY", "GEOMETRY_AREA", "GEOMETRY_UV", "GEOMETRY_TRIANGLES", "GEOMETRY_HASH", "GEOMETRY_HASH_POSITION", "GEOMETRY_HASH_NORMAL", "GEOMETRY_HASH_TANGENT", "GEOMETRY_HASH_UV", "GEOMETRY_HASH_COLOR", "GEOMETRY_HASH_CORNER_ASSOCIATION"}
REASONS.update("FIDELITY_" + group for group in ("POSITION", "NORMAL", "TANGENT", "UV", "COLOR", "TRANSFORM", "CONDITION", "CORRESPONDENCE", "HIERARCHY"))
REASONS.update("OPERATOR_" + group for group in ("ARGUMENT", "RUNTIME", "CANCELLED", "RESULT", "EXCEPTION"))
REASONS.update({"OPERATOR_DIRECTORY_MISSING", "OPERATOR_DIRECTORY_ACCESS", "OPERATOR_DIRECTORY_IO",
                "OPERATOR_DIRECTORY_ARGUMENT", "OPERATOR_DIRECTORY_OTHER", "OPERATOR_WRITE_MISSING",
                "OPERATOR_WRITE_ACCESS", "OPERATOR_WRITE_IO", "OPERATOR_WRITE_ARGUMENT", "OPERATOR_WRITE_OTHER",
                "OPERATOR_SAVE_MISSING", "OPERATOR_SAVE_ACCESS", "OPERATOR_SAVE_IO",
                "OPERATOR_SAVE_ARGUMENT", "OPERATOR_SAVE_OTHER", "OPERATOR_BEFORE_SAVE", "OPERATOR_AFTER_SAVE"})


class ConversionFailure(Exception):
    def __init__(self, reason):
        self.reason = reason if reason in REASONS else "NATIVE"
        super().__init__(self.reason)


def require(condition, reason="INPUT"):
    if not condition:
        raise ConversionFailure(reason)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("utf-8")


def finite(value, maximum=1_000_000):
    require(type(value) in (int, float) and math.isfinite(value) and abs(value) <= maximum)
    return float(value)


def quantize(value):
    value = finite(value)
    scaled = value * 1_000_000
    return math.floor(scaled + 0.5) if scaled >= 0 else math.ceil(scaled - 0.5)


def natural(value, maximum, minimum=0):
    require(type(value) is int and minimum <= value <= maximum)
    return value


def fields(value, names):
    require(type(value) is dict and set(value) == set(names))
    return value


def _pairs(pairs):
    out = {}
    for key, value in pairs:
        require(key not in out)
        out[key] = value
    return out


def parse_json(raw, maximum=JSON_BYTES):
    require(0 < len(raw) <= maximum)
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs,
                           parse_constant=lambda _token: (_ for _ in ()).throw(ConversionFailure("INPUT")))
    except (ValueError, UnicodeError, RecursionError):
        raise ConversionFailure("INPUT") from None
    pending, count = [(value, 0)], 0
    while pending:
        item, depth = pending.pop()
        count += 1
        require(count <= 100_000 and depth <= 32)
        if type(item) is dict:
            require(all(type(k) is str and k not in {"__proto__", "constructor", "prototype"} for k in item))
            pending.extend((child, depth + 1) for child in item.values())
        elif type(item) is list:
            pending.extend((child, depth + 1) for child in item)
        else:
            require(item is None or type(item) in (bool, str, int, float))
            if type(item) in (int, float):
                require(math.isfinite(item))
    return value


def no_links(path, directory=False):
    path = Path(path)
    require(path.is_absolute(), "IO_PATH")
    for item in [path, *path.parents]:
        info = item.lstat()
        require(not stat.S_ISLNK(info.st_mode) and not (getattr(info, "st_file_attributes", 0) & 0x400), "IO_LINK")
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), "IO_TYPE")
    if not directory:
        require(info.st_nlink == 1, "IO_LINK")
    return info


# Windows path stat and handle fstat can expose different ctime meanings.
# Compare the same metadata channel before/after reading; keep both change-time
# checks instead of equating creation time with handle metadata-change time.
WINDOWS_FILE_SNAPSHOTS = os.name == "nt"


def _file_snapshot(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns, info.st_nlink, getattr(info, "st_birthtime_ns", None))


def _opening_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            None if WINDOWS_FILE_SNAPSHOTS else info.st_ctime_ns,
            info.st_nlink, getattr(info, "st_birthtime_ns", None))


def read_owned(path, maximum, minimum=1):
    before = no_links(path)
    require(minimum <= before.st_size <= maximum, "IO_SIZE")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    handle = os.open(path, flags)
    try:
        opened = os.fstat(handle)
        require(_opening_identity(opened) == _opening_identity(before), "IO_IDENTITY")
        require(stat.S_ISREG(opened.st_mode), "IO_TYPE")
        chunks, remaining = [], before.st_size
        while remaining:
            chunk = os.read(handle, min(remaining, 64 * 1024))
            require(bool(chunk), "IO_READ")
            chunks.append(chunk)
            remaining -= len(chunk)
        require(not os.read(handle, 1), "IO_READ")
        require(_file_snapshot(os.fstat(handle)) == _file_snapshot(opened), "IO_CHANGED")
        require(_file_snapshot(no_links(path)) == _file_snapshot(before), "IO_CHANGED")
        return b"".join(chunks)
    finally:
        os.close(handle)


def write_new(path, raw):
    no_links(Path(path).parent, directory=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    handle = os.open(path, flags, 0o600)
    try:
        with os.fdopen(handle, "wb", closefd=False) as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(handle)


def validate_inputs(directory, request_hash):
    require(type(request_hash) is str and HASH.fullmatch(request_hash))
    no_links(directory, directory=True)
    request_raw = read_owned(directory / "request.json", JSON_BYTES)
    require(sha(request_raw) == request_hash, "SOURCE")
    r = fields(parse_json(request_raw), ("schemaVersion", "fidelityPolicy", "kind", "jobId", "parentJobId", "parentManifestSha256", "name", "sourceSha256", "sourceBytes", "importSha256", "importBytes", "sourceMapSha256", "collision", "renderResolution", "renderSamples"))
    natural(r["schemaVersion"], 2, 2)
    require(r["fidelityPolicy"] == FIDELITY_POLICY and r["kind"] == "converted-glb" and r["collision"] in ("none", "convex-hull"))
    require(all(type(r[k]) is str and HASH.fullmatch(r[k]) for k in ("parentManifestSha256", "sourceSha256", "importSha256", "sourceMapSha256")))
    require(all(type(r[k]) is str and UUID.fullmatch(r[k]) for k in ("jobId", "parentJobId")) and r["jobId"] != r["parentJobId"])
    require(type(r["name"]) is str and re.fullmatch(r"[a-z][a-z0-9-]{0,47}", r["name"]) and not re.match(r"(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:-|$)", r["name"], re.I))
    natural(r["sourceBytes"], GLB_BYTES, 20); natural(r["importBytes"], GLB_BYTES, 20)
    natural(r["renderResolution"], 1024, 128); natural(r["renderSamples"], 64, 1)
    source = read_owned(directory / "source.glb", GLB_BYTES, 20)
    imported = read_owned(directory / "import-source.glb", GLB_BYTES, 20)
    map_raw = read_owned(directory / "source-map.json", JSON_BYTES)
    require(len(source) == r["sourceBytes"] and sha(source) == r["sourceSha256"] and len(imported) == r["importBytes"] and sha(imported) == r["importSha256"] and sha(map_raw) == r["sourceMapSha256"], "SOURCE")
    m = fields(parse_json(map_raw), ("schemaVersion", "fidelityPolicy", "sourceSha256", "importSha256", "sourceSceneIndex", "declaredSceneCount", "parts", "nodes"))
    natural(m["schemaVersion"], 2, 2)
    require(m["fidelityPolicy"] == FIDELITY_POLICY and m["sourceSha256"] == r["sourceSha256"] and m["importSha256"] == r["importSha256"])
    natural(m["declaredSceneCount"], 4096, 1); natural(m["sourceSceneIndex"], m["declaredSceneCount"] - 1)
    require(type(m["parts"]) is list and 1 <= len(m["parts"]) <= 128 and len(m["parts"]) + int(r["collision"] == "convex-hull") <= 128)
    seen = {key: set() for key in ("sourceKey", "originMarker", "importNodeIndex")}
    for part in m["parts"]:
        fields(part, ("sourceNodeIndex", "sourceMeshIndex", "sourcePrimitiveIndex", "sourceMaterialIndex", "sourceKey", "importNodeIndex", "originMarker", "worldMatrix", "triangles", "vertexCount"))
        for key in ("sourceNodeIndex", "sourceMeshIndex", "sourcePrimitiveIndex", "importNodeIndex"):
            natural(part[key], 4095)
        if part["sourceMaterialIndex"] is not None:
            natural(part["sourceMaterialIndex"], 4095)
        natural(part["triangles"], 20_000, 1)
        natural(part["vertexCount"], 60000, 3)
        require(part["sourceKey"] == "node%d_primitive%d" % (part["sourceNodeIndex"], part["sourcePrimitiveIndex"]) and part["originMarker"] == "glb_%s:%d:%d" % (r["sourceSha256"], part["sourceNodeIndex"], part["sourcePrimitiveIndex"]))
        require(type(part["worldMatrix"]) is list and len(part["worldMatrix"]) == 16)
        for n in part["worldMatrix"]: finite(n)
        require([part["worldMatrix"][i] for i in (3, 7, 11, 15)] == [0, 0, 0, 1])
        check_fidelity_matrix(part["worldMatrix"])
        for key in seen:
            require(part[key] not in seen[key]); seen[key].add(part[key])
    require(sum(p["triangles"] for p in m["parts"]) <= 100_000)
    hierarchy_map(m)
    return r, m, source, imported


def object_id(source_hash, role, source_key):
    require(HASH.fullmatch(source_hash) and role in ("render", "collision"))
    return "arcane_" + sha((source_hash + "\n" + role + "\n" + source_key).encode("ascii"))


def asset_id(source_hash):
    require(HASH.fullmatch(source_hash))
    return "arcane_" + sha((source_hash + "\nconverted-root").encode("ascii"))


def glb(raw, maximum=GLB_BYTES):
    require(28 <= len(raw) <= maximum and len(raw) % 4 == 0, "SOURCE")
    magic, version, length, n, kind = struct.unpack_from("<5I", raw)
    require((magic, version, length, kind) == (0x46546C67, 2, len(raw), 0x4E4F534A) and n % 4 == 0 and 1 <= n <= 4 * 1024 * 1024 and 28 + n <= len(raw), "SOURCE")
    count, kind = struct.unpack_from("<2I", raw, 20 + n)
    require(kind == 0x004E4942 and 28 + n + count == len(raw), "SOURCE")
    doc = parse_json(raw[20:20 + n], 4 * 1024 * 1024)
    require(type(doc) is dict and type(doc.get("buffers")) is list and len(doc["buffers"]) == 1 and "uri" not in doc["buffers"][0], "SOURCE")
    used = natural(doc["buffers"][0].get("byteLength"), count)
    require(count - used <= 3 and not any(raw[28 + n + used:]), "SOURCE")
    require(not doc.get("skins") and not doc.get("animations") and not doc.get("cameras"), "FEATURE")
    for image in doc.get("images", []):
        require(type(image) is dict and "uri" not in image and image.get("mimeType") in ("image/png", "image/jpeg") and type(image.get("bufferView")) is int, "FEATURE")
    for node in doc.get("nodes", []):
        require(not any(k in node for k in ("skin", "weights", "camera")) and not node.get("extensions"), "FEATURE")
    for mesh in doc.get("meshes", []):
        require("weights" not in mesh, "FEATURE")
        for primitive in mesh.get("primitives", []):
            require("targets" not in primitive and not primitive.get("extensions"), "FEATURE")
    return doc, raw[28 + n:28 + n + used]


def ref(items, index):
    natural(index, len(items) - 1)
    return items[index]


def accessor(doc, binary, index):
    a = ref(doc.get("accessors", []), index)
    widths = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
    shapes = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
    require(a.get("componentType") in widths and a.get("type") in shapes, "FEATURE")
    fmt, width = widths[a["componentType"]]; size = shapes[a["type"]]
    count = natural(a.get("count"), 300_000, 1)
    def stream(view_index, offset, length, components, component_fmt, component_width, allow_stride):
        view = ref(doc.get("bufferViews", []), view_index)
        require(view.get("buffer", 0) == 0, "SOURCE")
        start = natural(view.get("byteOffset", 0), len(binary))
        extent = natural(view.get("byteLength"), len(binary))
        offset = natural(offset, extent)
        stride = view.get("byteStride", components * component_width)
        natural(stride, 252, components * component_width)
        require(allow_stride or "byteStride" not in view, "SOURCE")
        require(offset % component_width == 0 and (start + offset) % component_width == 0 and stride % component_width == 0 and start + extent <= len(binary) and offset + (length - 1) * stride + components * component_width <= extent, "SOURCE")
        return [list(struct.unpack_from("<" + component_fmt * components, binary, start + offset + i * stride)) for i in range(length)]
    rows = stream(a["bufferView"], a.get("byteOffset", 0), count, size, fmt, width, True) if "bufferView" in a else [[0] * size for _ in range(count)]
    if "sparse" in a:
        sparse = a["sparse"]; n = natural(sparse.get("count"), count, 1)
        indices = sparse["indices"]; require(indices.get("componentType") in (5121, 5123, 5125), "SOURCE")
        ifmt, iw = widths[indices["componentType"]]
        ix = stream(indices["bufferView"], indices.get("byteOffset", 0), n, 1, ifmt, iw, False)
        values = sparse["values"]; vals = stream(values["bufferView"], values.get("byteOffset", 0), n, size, fmt, width, False)
        last = -1
        for item, row in zip(ix, vals):
            at = natural(item[0], count - 1); require(at > last, "SOURCE"); last = at; rows[at] = row
    if a.get("normalized", False):
        require(a["componentType"] in (5120, 5121, 5122, 5123), "SOURCE")
        divisor = {5120: 127, 5121: 255, 5122: 32767, 5123: 65535}[a["componentType"]]
        rows = [[max(-1, value / divisor) if a["componentType"] in (5120, 5122) else value / divisor for value in row] for row in rows]
    for row in rows:
        for value in row: finite(value)
    return rows


def matrix_local(node):
    if "matrix" in node:
        m = node["matrix"]
    else:
        x, y, z, w = node.get("rotation", [0, 0, 0, 1]); sx, sy, sz = node.get("scale", [1, 1, 1])
        t = node.get("translation", [0, 0, 0])
        m = [(1 - 2 * (y*y + z*z))*sx, 2*(x*y + z*w)*sx, 2*(x*z - y*w)*sx, 0,
             2*(x*y - z*w)*sy, (1 - 2*(x*x + z*z))*sy, 2*(y*z + x*w)*sy, 0,
             2*(x*z + y*w)*sz, 2*(y*z - x*w)*sz, (1 - 2*(x*x + y*y))*sz, 0, *t, 1]
    require(type(m) is list and len(m) == 16 and [m[i] for i in (3, 7, 11, 15)] == [0, 0, 0, 1], "SOURCE")
    for value in m: finite(value)
    return m


def worlds(doc, scene_index=None):
    nodes = doc.get("nodes", []); require(type(nodes) is list and len(nodes) <= 4096, "SOURCE")
    scene = ref(doc.get("scenes", []), doc.get("scene", 0) if scene_index is None else scene_index)
    identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
    pending = [(index, identity) for index in scene.get("nodes", [])]; out = {}
    while pending:
        index, parent = pending.pop(); node = ref(nodes, index)
        require(index not in out and len(out) < 4096, "SOURCE")
        local = matrix_local(node)
        m = [sum(parent[k*4 + i%4] * local[(i//4)*4 + k] for k in range(4)) for i in range(16)]
        for value in m: finite(value)
        out[index] = m; pending.extend((child, m) for child in node.get("children", []))
    return out


def position(m, p):
    return [sum(m[axis + col*4] * p[col] for col in range(3)) + m[axis + 12] for axis in range(3)]


def normal(m, p):
    a,b,c,d,e,f,g,h,i = m[0],m[4],m[8],m[1],m[5],m[9],m[2],m[6],m[10]
    det = a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g)
    require(abs(det) > 1e-20, "GEOMETRY")
    cofactors = [(e*i-f*h), (f*g-d*i), (d*h-e*g), (c*h-b*i), (a*i-c*g), (b*g-a*h), (b*f-c*e), (c*d-a*f), (a*e-b*d)]
    result = [sum(cofactors[row*3 + col] * p[col] for col in range(3))/det for row in range(3)]
    length = math.hypot(*result); require(length > 0, "GEOMETRY")
    return [n/length for n in result]


def triangles(indices, mode):
    require(mode in (4, 5, 6), "FEATURE")
    if mode == 4:
        require(len(indices) % 3 == 0, "GEOMETRY")
        return [indices[i:i+3] for i in range(0, len(indices), 3)]
    return [([indices[i], indices[i+1], indices[i+2]] if i % 2 == 0 else [indices[i+1], indices[i], indices[i+2]]) for i in range(len(indices)-2)] if mode == 5 else [[indices[0], indices[i], indices[i+1]] for i in range(1, len(indices)-1)]


def triangle_key(corners):
    return min(canonical(corners[i:] + corners[:i]) for i in range(3)).decode("ascii")


def geometry_hash(rows):
    return sha(canonical(sorted(rows)))


GEOMETRY_GROUPS = ("POSITION", "NORMAL", "TANGENT", "UV", "COLOR")


def geometry_projection_hashes(rows):
    """Diagnostic marginals of actual canonical corners; never acceptance proof."""
    result = {}
    for group in GEOMETRY_GROUPS:
        projected = []
        for row in rows:
            corners = json.loads(row)
            values = []
            for corner in corners:
                values.append({key: value for key, value in corner.items() if
                    key == group or (group == "UV" and key.startswith("TEXCOORD_")) or
                    (group == "COLOR" and key.startswith("COLOR_"))})
            projected.append(triangle_key(values))
        result[group] = geometry_hash(projected)
    return result


def require_geometry_match(expected, actual, expected_projections=None, actual_projections=None):
    # Exact snapshot comparison, not v2 source semantic acceptance.
    if expected == actual:
        return
    reason = "GEOMETRY_HASH"
    if (type(expected_projections) is dict and type(actual_projections) is dict and
            set(expected_projections) == set(actual_projections) == set(GEOMETRY_GROUPS) and
            all(type(values[key]) is str and HASH.fullmatch(values[key]) for
                values in (expected_projections, actual_projections) for key in GEOMETRY_GROUPS)):
        reason = "GEOMETRY_HASH_CORNER_ASSOCIATION"
        for group in GEOMETRY_GROUPS:
            if expected_projections[group] != actual_projections[group]:
                reason = "GEOMETRY_HASH_" + group
                break
    raise ConversionFailure(reason)


def policy_values(values, size, reason):
    require(type(values) in (list, tuple) and len(values) == size and
            all(type(v) in (int, float) and math.isfinite(v) for v in values), reason)
    return values


def policy_normalize(values, reason):
    policy_values(values, 3, reason)
    length = math.hypot(*values)
    require(math.isfinite(length) and length > 0, reason)
    return [v / length for v in values]


def policy_cross(a, b):
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]


def policy_dot(a, b):
    return sum(x*y for x, y in zip(a, b))


def policy_distance(a, b, limit, reason):
    policy_values(a, 3, reason); policy_values(b, 3, reason)
    distance = math.hypot(*(x-y for x, y in zip(a, b)))
    require(math.isfinite(distance) and distance <= limit, reason)


def policy_direction(expected, actual, reason):
    a = policy_normalize(expected, reason); b = policy_normalize(actual, reason)
    angle = math.atan2(math.hypot(*policy_cross(a, b)), policy_dot(a, b))
    require(math.isfinite(angle) and angle <= DIRECTION_LIMIT, reason)


def policy_components(expected, actual, size, limit, reason):
    policy_values(expected, size, reason); policy_values(actual, size, reason)
    require(all(abs(a-b) <= limit for a, b in zip(expected, actual)), reason)


def policy_inverse(matrix):
    policy_values(matrix, 16, "FIDELITY_TRANSFORM")
    require([matrix[i] for i in (3, 7, 11, 15)] == [0, 0, 0, 1], "FIDELITY_TRANSFORM")
    lengths = [math.hypot(*matrix[at:at+3]) for at in (0, 4, 8)]
    require(all(math.isfinite(n) and n > 0 for n in lengths), "FIDELITY_CONDITION")
    columns = [[v/lengths[i] for v in matrix[4*i:4*i+3]] for i in range(3)]
    rows = [policy_cross(columns[1], columns[2]), policy_cross(columns[2], columns[0]), policy_cross(columns[0], columns[1])]
    det = policy_dot(columns[0], rows[0])
    require(math.isfinite(det) and abs(det) > 1e-12, "FIDELITY_CONDITION")
    inverse_rows = [[v / det / lengths[i] for v in row] for i, row in enumerate(rows)]
    result = [inverse_rows[0][0], inverse_rows[1][0], inverse_rows[2][0], 0,
              inverse_rows[0][1], inverse_rows[1][1], inverse_rows[2][1], 0,
              inverse_rows[0][2], inverse_rows[1][2], inverse_rows[2][2], 0,
              *[-sum(row[i]*matrix[12+i] for i in range(3)) for row in inverse_rows], 1]
    require(all(math.isfinite(v) for v in result), "FIDELITY_CONDITION")
    return result


def matrix_sign(matrix):
    columns = [policy_normalize(matrix[at:at+3], "FIDELITY_CONDITION") for at in (0, 4, 8)]
    value = policy_dot(columns[0], policy_cross(columns[1], columns[2]))
    require(math.isfinite(value) and value != 0, "FIDELITY_CONDITION")
    return 1 if value > 0 else -1


def check_fidelity_matrix(matrix):
    inverse = policy_inverse(matrix)
    def norm(m): return max(sum(abs(m[row+4*col]) for col in range(3)) for row in range(3))
    condition = norm(matrix) * norm(inverse)
    require(math.isfinite(condition) and condition <= CONDITION_LIMIT, "FIDELITY_CONDITION")
    return inverse


def compare_fidelity_transform(expected, actual):
    check_fidelity_matrix(expected); check_fidelity_matrix(actual)
    require(matrix_sign(expected) == matrix_sign(actual), "FIDELITY_TRANSFORM")
    policy_distance(expected[12:15], actual[12:15], TRANSLATION_LIMIT, "FIDELITY_TRANSFORM")
    for col in range(3):
        a, b = expected[4*col:4*col+3], actual[4*col:4*col+3]
        policy_distance(a, b, math.hypot(*a)*LINEAR_LIMIT, "FIDELITY_TRANSFORM")


def policy_vector(matrix, vector):
    return [sum(matrix[axis+col*4]*vector[col] for col in range(3)) for axis in range(3)]


def policy_normal(matrix, vector):
    inverse = policy_inverse(matrix)
    result = [sum(inverse[axis*4+col]*vector[col] for col in range(3)) for axis in range(3)]
    return policy_normalize(result, "FIDELITY_NORMAL")


def multiply_matrix(a, b):
    return [sum(a[k*4+i%4]*b[(i//4)*4+k] for k in range(4)) for i in range(16)]


def hierarchy_map(mapping):
    entries = mapping["nodes"]
    require(type(entries) is list and 1 <= len(entries) <= 4096, "FIDELITY_HIERARCHY")
    nodes, indices = {}, set()
    for entry in entries:
        fields(entry, ("nodeKey", "importNodeIndex", "parentKey", "localMatrix"))
        key = entry["nodeKey"]
        require(type(key) is str and re.fullmatch(r"node[0-9]{1,4}(?:_primitive[0-9]{1,4})?", key) and key not in nodes, "FIDELITY_HIERARCHY")
        natural(entry["importNodeIndex"], 4095)
        require(entry["importNodeIndex"] not in indices, "FIDELITY_HIERARCHY")
        require(entry["parentKey"] is None or type(entry["parentKey"]) is str, "FIDELITY_HIERARCHY")
        check_fidelity_matrix(entry["localMatrix"])
        nodes[key] = entry; indices.add(entry["importNodeIndex"])
    for key, entry in nodes.items():
        seen, parent = {key}, entry["parentKey"]
        while parent is not None:
            require(parent in nodes and parent not in seen and len(seen) < 128, "FIDELITY_HIERARCHY")
            seen.add(parent); parent = nodes[parent]["parentKey"]
    for part in mapping["parts"]:
        entry = nodes.get(part["sourceKey"])
        require(entry is not None and entry["importNodeIndex"] == part["importNodeIndex"] and
                entry["parentKey"] == "node%d" % part["sourceNodeIndex"], "FIDELITY_HIERARCHY")
    return nodes


def hierarchy_worlds(mapping):
    nodes = hierarchy_map(mapping); result = {}
    for key in nodes:
        chain, at = [], key
        while at is not None and at not in result:
            chain.append(at); at = nodes[at]["parentKey"]
        parent = result[at] if at is not None else matrix_local({})
        for current in reversed(chain):
            parent = multiply_matrix(parent, nodes[current]["localMatrix"])
            check_fidelity_matrix(parent); result[current] = parent
    return result


def check_node_bindings(mapping, observed):
    expected = hierarchy_map(mapping); expected_world = hierarchy_worlds(mapping)
    require(type(observed) is dict and set(observed) == set(expected), "FIDELITY_HIERARCHY")
    for key, row in observed.items():
        require(row["parentKey"] == expected[key]["parentKey"], "FIDELITY_HIERARCHY")
        compare_fidelity_transform(expected[key]["localMatrix"], row["localMatrix"])
        check_fidelity_matrix(row["worldMatrix"])
        require(matrix_sign(expected_world[key]) == matrix_sign(row["worldMatrix"]), "FIDELITY_TRANSFORM")
    return [{"nodeKey": key, "parentKey": observed[key]["parentKey"], "localMatrix": observed[key]["localMatrix"],
             "worldMatrix": observed[key]["worldMatrix"]} for key in sorted(observed)]


def glb_node_bindings(doc, mapping, input_indices=False):
    actual_world = worlds(doc); nodes = doc.get("nodes", []); expected = hierarchy_map(mapping)
    require(len(actual_world) == len(nodes) == len(expected), "FIDELITY_HIERARCHY")
    parents = {}
    for index, node in enumerate(nodes):
        for child in node.get("children", []):
            require(child not in parents, "FIDELITY_HIERARCHY"); parents[child] = index
    keys = [node.get("extras", {}).get(NODE_KEY) for node in nodes]
    require(all(type(key) is str and key in expected for key in keys) and len(set(keys)) == len(keys), "FIDELITY_HIERARCHY")
    part_keys = {part["sourceKey"] for part in mapping["parts"]}; observed = {}
    for index, node in enumerate(nodes):
        key = keys[index]
        require(("mesh" in node) == (key in part_keys), "FIDELITY_HIERARCHY")
        if input_indices: require(expected[key]["importNodeIndex"] == index, "FIDELITY_HIERARCHY")
        observed[key] = {"parentKey": keys[parents[index]] if index in parents else None,
                         "localMatrix": matrix_local(node), "worldMatrix": actual_world[index]}
    return check_node_bindings(mapping, observed)


def bpy_matrix_y_up(matrix):
    # Exact signed-axis permutation of actual components, without another
    # float32 matrix multiplication: C * actual * inverse(C).
    axes, signs = (0, 2, 1, 3), (1, 1, -1, 1)
    result = [float(matrix[axes[row]][axes[col]])*signs[row]*signs[col] for col in range(4) for row in range(4)]
    check_fidelity_matrix(result)
    return result


def correspondence_hash(faces):
    require(type(faces) is list and 1 <= len(faces) <= 20000, "FIDELITY_CORRESPONDENCE")
    ordered = []
    for face in faces:
        require(type(face) in (list, tuple) and len(face) == 3 and
                all(type(v) is int and 0 <= v < 60000 for v in face), "FIDELITY_CORRESPONDENCE")
        row = tuple(face)
        ordered.append(min(row, row[1:]+row[:1], row[2:]+row[:2]))
    return sha(canonical([list(row) for row in sorted(ordered)]))


def checked_vertex_ids(values, count, expected_used_ids=None):
    natural(count, 60000, 3)
    require(type(values) is list and 3 <= len(values) <= 60000, "FIDELITY_CORRESPONDENCE")
    result = []
    for value in values:
        require(type(value) in (int, float) and math.isfinite(value) and value == math.floor(value) and 0 <= value < count,
                "FIDELITY_CORRESPONDENCE")
        result.append(int(value))
    if expected_used_ids is not None:
        require(set(result) == set(expected_used_ids), "FIDELITY_CORRESPONDENCE")
    return result


def source_fidelity(doc, binary, part, scene_index, accessor_cache=None):
    require(ref(doc.get("nodes", []), part["sourceNodeIndex"]).get("mesh") == part["sourceMeshIndex"], "MAP")
    digest, semantics, triangle_count, world = primitive_geometry(doc, binary, part["sourceNodeIndex"], part["sourcePrimitiveIndex"], scene_index=scene_index, allow_unused_storage=True)
    primitive = doc["meshes"][part["sourceMeshIndex"]]["primitives"][part["sourcePrimitiveIndex"]]
    cache = {} if accessor_cache is None else accessor_cache
    attributes = {}
    for key in semantics:
        index = primitive["attributes"][key]
        if index not in cache: cache[index] = accessor(doc, binary, index)
        attributes[key] = cache[index]
    count = len(attributes["POSITION"])
    require(count == part["vertexCount"] and triangle_count == part["triangles"], "FIDELITY_CORRESPONDENCE")
    indices = [row[0] for row in accessor(doc, binary, primitive["indices"])] if "indices" in primitive else list(range(count))
    faces = triangles(indices, primitive.get("mode", 4))
    return {"geometry": digest, "semantics": semantics, "attributes": attributes, "world": world,
            "inverse": check_fidelity_matrix(world), "vertexCount": count,
            "usedIds": set(indices), "triangles": triangle_count, "correspondenceSha256": correspondence_hash(faces)}


def compare_fidelity_corner(source, source_id, local, world):
    require(type(source_id) is int and 0 <= source_id < source["vertexCount"], "FIDELITY_CORRESPONDENCE")
    for key in source["semantics"]:
        require(key in local and key in world, "FIDELITY_CORRESPONDENCE")
        expected = list(source["attributes"][key][source_id])
        if key == "POSITION":
            policy_distance(expected, local[key], POSITION_LIMIT, "FIDELITY_POSITION")
            policy_distance(expected, position(source["inverse"], world[key]), POSITION_LIMIT, "FIDELITY_POSITION")
            policy_distance(position(source["world"], expected), world[key], POSITION_LIMIT, "FIDELITY_POSITION")
        elif key == "NORMAL":
            policy_direction(expected, local[key], "FIDELITY_NORMAL")
            policy_direction(expected, policy_normal(source["inverse"], world[key]), "FIDELITY_NORMAL")
            policy_direction(policy_normal(source["world"], expected), world[key], "FIDELITY_NORMAL")
        elif key == "TANGENT":
            policy_values(local[key], 4, "FIDELITY_TANGENT"); policy_values(world[key], 4, "FIDELITY_TANGENT")
            require(expected[3] in (-1, 1) and local[key][3] == expected[3] and
                    world[key][3] == expected[3]*matrix_sign(source["world"]), "FIDELITY_TANGENT")
            policy_direction(expected[:3], local[key][:3], "FIDELITY_TANGENT")
            policy_direction(expected[:3], policy_vector(source["inverse"], world[key][:3]), "FIDELITY_TANGENT")
            policy_direction(policy_vector(source["world"], expected[:3]), world[key][:3], "FIDELITY_TANGENT")
        elif key.startswith("TEXCOORD_"):
            policy_components(expected, local[key], 2, UV_LIMIT, "FIDELITY_UV")
        else:
            if len(expected) == 3: expected.append(1)
            policy_components(expected, local[key], 4, COLOR_LIMIT, "FIDELITY_COLOR")


def glb_fidelity(doc, binary, node_index, part, source):
    node = ref(doc.get("nodes", []), node_index)
    mesh = ref(doc.get("meshes", []), node.get("mesh"))
    require(len(mesh["primitives"]) == 1, "FIDELITY_CORRESPONDENCE")
    primitive = mesh["primitives"][0]; names = set(primitive.get("attributes", {}))
    require(VERTEX_ID in names, "FIDELITY_CORRESPONDENCE")
    require(set(source["semantics"]) <= names and names - set(source["semantics"]) <= {VERTEX_ID, "NORMAL", "TANGENT"}, "FEATURE")
    declared = ref(doc.get("accessors", []), primitive["attributes"].get(VERTEX_ID))
    require(declared.get("type") == "SCALAR" and declared.get("componentType") == 5126 and not declared.get("normalized", False), "FIDELITY_CORRESPONDENCE")
    ids = checked_vertex_ids([row[0] for row in accessor(doc, binary, primitive["attributes"][VERTEX_ID])], part["vertexCount"])
    attributes = {key: accessor(doc, binary, primitive["attributes"][key]) for key in source["semantics"]}
    require(all(len(values) == len(ids) for values in attributes.values()), "FIDELITY_CORRESPONDENCE")
    indices = [row[0] for row in accessor(doc, binary, primitive["indices"])] if "indices" in primitive else list(range(len(ids)))
    require(all(type(i) is int and 0 <= i < len(ids) for i in indices), "FIDELITY_CORRESPONDENCE")
    require({ids[i] for i in indices} == source["usedIds"], "FIDELITY_CORRESPONDENCE")
    faces = triangles(indices, primitive.get("mode", 4)); world_matrix = worlds(doc)[node_index]
    check_fidelity_matrix(world_matrix)
    correspondence = []
    for face in faces:
        correspondence.append([ids[index] for index in face])
        for index in face:
            local = {key: list(values[index]) for key, values in attributes.items()}; observed = {}
            for key, value in local.items():
                if key == "POSITION": observed[key] = position(world_matrix, value)
                elif key == "NORMAL": observed[key] = policy_normal(world_matrix, value)
                elif key == "TANGENT": observed[key] = policy_normalize(policy_vector(world_matrix, value[:3]), "FIDELITY_TANGENT") + [value[3]*matrix_sign(world_matrix)]
                else:
                    if key.startswith("COLOR_") and len(value) == 3: value.append(1)
                    observed[key] = value
            compare_fidelity_corner(source, ids[index], local, observed)
    digest = correspondence_hash(correspondence)
    require(len(faces) == source["triangles"] and digest == source["correspondenceSha256"], "FIDELITY_CORRESPONDENCE")
    return digest


def primitive_geometry(doc, binary, node_index, primitive_index, semantics=None, scene_index=None, diagnostic_hashes=None, allow_unused_storage=False):
    matrices = worlds(doc, scene_index); require(node_index in matrices, "MAP")
    node = ref(doc.get("nodes", []), node_index); primitive = ref(ref(doc.get("meshes", []), node.get("mesh"))["primitives"], primitive_index)
    attributes = primitive.get("attributes", {}); require("POSITION" in attributes, "SOURCE")
    selected = list(attributes) if semantics is None else list(semantics)
    require(all(k in attributes and (k in ("POSITION", "NORMAL", "TANGENT") or re.fullmatch(r"(?:TEXCOORD|COLOR)_[0-7]", k)) for k in selected), "FEATURE")
    data = {key: accessor(doc, binary, attributes[key]) for key in selected}
    require("POSITION" in data, "GEOMETRY")
    count = len(data["POSITION"]); require(all(len(values) == count for values in data.values()), "GEOMETRY")
    for key, values in data.items():
        size = 3 if key in ("POSITION", "NORMAL") else 4 if key == "TANGENT" else 2 if key.startswith("TEXCOORD_") else None
        require(all(len(row) == size if size is not None else len(row) in (3, 4) for row in values), "FEATURE")
    if "indices" in primitive:
        index_accessor = ref(doc.get("accessors", []), primitive["indices"])
        require(index_accessor.get("type") == "SCALAR" and index_accessor.get("componentType") in (5121, 5123, 5125) and not index_accessor.get("normalized", False), "SOURCE")
    indices = [row[0] for row in accessor(doc, binary, primitive["indices"])] if "indices" in primitive else list(range(count))
    for index in indices: natural(index, count - 1)
    faces = triangles(indices, primitive.get("mode", 4)); require(1 <= len(faces) <= 20000, "GEOMETRY")
    # glTF material primitives may share accessor storage without referencing
    # every slot. Their rendered faces remain exact; physical bpy loose meshes
    # are still audited independently and never repaired or trimmed here.
    if not allow_unused_storage: require(len(set(indices)) == count, "GEOMETRY")
    m = matrices[node_index]; rows = []
    determinant = m[0]*(m[5]*m[10]-m[6]*m[9])-m[4]*(m[1]*m[10]-m[2]*m[9])+m[8]*(m[1]*m[6]-m[2]*m[5])
    for face in faces:
        corners = []
        for index in face:
            corner = {}
            for key, values in data.items():
                value = values[index]
                if key == "POSITION": value = position(m, value)
                elif key == "NORMAL": value = normal(m, value)
                elif key == "TANGENT":
                    xyz = [sum(m[axis + col*4] * value[col] for col in range(3)) for axis in range(3)]
                    length = math.hypot(*xyz); require(length > 0, "GEOMETRY")
                    value = [n/length for n in xyz] + [value[3] * (1 if determinant >= 0 else -1)]
                elif key.startswith("COLOR_") and len(value) == 3: value = value + [1]
                corner[key] = [quantize(n) for n in value]
            corners.append(corner)
        a,b,c = [position(m, data["POSITION"][index]) for index in face]
        u=[b[k]-a[k] for k in range(3)]; v=[c[k]-a[k] for k in range(3)]
        require(math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]) > 1e-10, "GEOMETRY")
        rows.append(triangle_key(corners))
    if diagnostic_hashes is not None:
        diagnostic_hashes.update(geometry_projection_hashes(rows))
    return geometry_hash(rows), tuple(sorted(selected)), len(faces), m


def image_record(image):
    width, height = (int(n) for n in image.size)
    require(1 <= width <= 4096 and 1 <= height <= 4096 and width * height <= IMAGE_PIXELS, "MATERIAL")
    require(len(image.pixels) == width * height * 4, "MATERIAL")
    values = array("f", [0.0]) * (width * height * 4)
    image.pixels.foreach_get(values)
    digest = hashlib.sha256()
    for start in range(0, len(values), 4096):
        digest.update(b"".join(struct.pack("<q", quantize(value)) for value in values[start:start+4096]))
    return {"width": width, "height": height, "rgbaSha256": digest.hexdigest(),
            "colorSpace": str(image.colorspace_settings.name), "alphaMode": str(image.alpha_mode)}


class ImageDecoder:
    """Decode only owned content-addressed PNG/JPEG snapshots, never an input URI."""
    def __init__(self, bpy, directory):
        self.bpy = bpy
        parent = directory / ".worker"
        no_links(parent, directory=True)
        self.directory = parent / "conversion-images"
        self.directory.mkdir(mode=0o700)  # Exclusive: no pre-existing scratch tree.
        no_links(self.directory, directory=True)
        self.created = set()
        self.cache = {}
        self.unique = {}
        self.pixels = 0

    def decode(self, raw, mime, color_space):
        require(mime in ("image/png", "image/jpeg") and 1 <= len(raw) <= GLB_BYTES and color_space in ("sRGB", "Non-Color"), "MATERIAL")
        require(raw.startswith(b"\x89PNG\r\n\x1a\n") if mime == "image/png" else raw.startswith(b"\xff\xd8"), "MATERIAL")
        digest = sha(raw); key = (digest, color_space)
        if key in self.cache:
            return self.cache[key]
        filename = digest + (".png" if mime == "image/png" else ".jpg")
        path = self.directory / filename
        if filename not in self.created:
            write_new(path, raw); self.created.add(filename)
        require(read_owned(path, GLB_BYTES) == raw, "SOURCE")
        image = self.bpy.data.images.load(str(path), check_existing=False)
        try:
            image.colorspace_settings.name = color_space
            image.alpha_mode = "STRAIGHT"
            width, height = (int(n) for n in image.size)
            require(1 <= width <= 4096 and 1 <= height <= 4096, "MATERIAL")
            if digest not in self.unique:
                self.pixels += width * height
                require(self.pixels <= IMAGE_PIXELS, "MATERIAL")
                self.unique[digest] = True
            record = image_record(image)
            require(read_owned(path, GLB_BYTES) == raw, "SOURCE")
            self.cache[key] = record
            return record
        finally:
            self.bpy.data.images.remove(image)


def material_semantics(doc, binary, material_index, decoder):
    """Normalized real glTF channels, including actual decoded embedded pixels."""
    m = {} if material_index is None else ref(doc.get("materials", []), material_index)
    p = m.get("pbrMetallicRoughness", {})
    def texture(info, color_space):
        if info is None:
            return None
        t = ref(doc.get("textures", []), info.get("index")); require(not t.get("extensions"), "FEATURE")
        image = ref(doc.get("images", []), t.get("source"))
        view = ref(doc.get("bufferViews", []), image.get("bufferView"))
        require(view.get("buffer", 0) == 0, "SOURCE")
        start = natural(view.get("byteOffset", 0), len(binary)); length = natural(view.get("byteLength"), len(binary), 1)
        require(start + length <= len(binary), "SOURCE")
        sampler = {} if "sampler" not in t else ref(doc.get("samplers", []), t["sampler"])
        record = decoder.decode(binary[start:start+length], image.get("mimeType"), color_space)
        return {"image": record, "texCoord": info.get("texCoord", 0),
                "sampler": {"magFilter": sampler.get("magFilter"), "minFilter": sampler.get("minFilter"), "wrapS": sampler.get("wrapS", 10497), "wrapT": sampler.get("wrapT", 10497)},
                "extensions": sample_tree(info.get("extensions", {}))}
    extensions = dict(m.get("extensions", {}))
    emission = extensions.pop("KHR_materials_emissive_strength", {})
    # Other glTF extension channels remain explicit: unknown conversion changes
    # cannot disappear just because this worker renders core PBR successfully.
    def extension_data(value, name=""):
        if type(value) is dict:
            return {key: texture(child, "sRGB" if "color" in key.lower() else "Non-Color") if key.endswith("Texture") else extension_data(child, key) for key, child in value.items()}
        if type(value) is list:
            return [extension_data(child, name) for child in value]
        return sample_tree(value)
    return {"baseColorFactor": sample_tree(p.get("baseColorFactor", [1,1,1,1])),
            "metallicFactor": quantize(p.get("metallicFactor", 1)), "roughnessFactor": quantize(p.get("roughnessFactor", 1)),
            "baseColorTexture": texture(p.get("baseColorTexture"), "sRGB"), "metallicRoughnessTexture": texture(p.get("metallicRoughnessTexture"), "Non-Color"),
            "normalTexture": texture(m.get("normalTexture"), "Non-Color"), "normalScale": quantize(m.get("normalTexture", {}).get("scale", 1)),
            "occlusionTexture": texture(m.get("occlusionTexture"), "Non-Color"), "occlusionStrength": quantize(m.get("occlusionTexture", {}).get("strength", 1)),
            "emissiveTexture": texture(m.get("emissiveTexture"), "sRGB"), "emissiveFactor": sample_tree(m.get("emissiveFactor", [0,0,0])),
            "emissiveStrength": quantize(emission.get("emissiveStrength", 1)), "alphaMode": m.get("alphaMode", "OPAQUE"),
            "alphaCutoff": quantize(m.get("alphaCutoff", 0.5)), "doubleSided": m.get("doubleSided", False), "extensions": extension_data(extensions)}


def sample_tree(value):
    if value is None or type(value) in (str, bool):
        return value
    if type(value) in (int, float):
        return quantize(value)
    if type(value) is dict:
        return {key: sample_tree(child) for key, child in value.items() if key not in ("name", "extras")}
    if type(value) in (list, tuple) or hasattr(value, "__len__"):
        return [sample_tree(child) for child in value]
    raise ConversionFailure("MATERIAL")


NODE_PROPERTIES = ("operation", "blend_type", "data_type", "clamp_type", "use_clamp", "clamp_factor", "clamp_result", "normalize",
                   "interpolation", "extension", "projection", "projection_blend", "uv_map", "attribute_name", "attribute_type",
                   "vector_type", "convert_from", "convert_to", "space", "distribution", "subsurface_method")


def material_graph(material, image_pointers=None):
    if material is None:
        return None
    require(material.node_tree is not None, "MATERIAL")
    images = {}
    def graph(tree, parent_stack):
        require(tree.as_pointer() not in parent_stack and len(parent_stack) < 16 and len(tree.nodes) <= 256 and len(tree.links) <= 1024, "MATERIAL")
        parent_stack = parent_stack | {tree.as_pointer()}
        require(all(link.is_valid for link in tree.links), "MATERIAL")
        memo = {}
        def node_record(node, stack):
            token = node.as_pointer(); require(token not in stack and len(stack) < 64, "MATERIAL")
            if token in memo:
                return memo[token]
            record = {"type": node.bl_idname, "properties": {}, "inputs": [], "outputs": []}
            for name in NODE_PROPERTIES:
                if hasattr(node, name): record["properties"][name] = sample_tree(getattr(node, name))
            if getattr(node, "image", None) is not None:
                image = node.image; pointer = image.as_pointer()
                if image_pointers is not None: image_pointers.add(pointer)
                if pointer not in images: images[pointer] = image_record(image)
                record["image"] = images[pointer]
            if getattr(node, "node_tree", None) is not None:
                record["group"] = graph(node.node_tree, parent_stack)
            if hasattr(node, "color_ramp"):
                ramp = node.color_ramp
                record["ramp"] = {"mode": ramp.color_mode, "interpolation": ramp.interpolation,
                                  "hueInterpolation": ramp.hue_interpolation,
                                  "elements": [[quantize(e.position), sample_tree(e.color)] for e in ramp.elements]}
            for socket in node.inputs:
                incoming = [link for link in tree.links if link.to_node == node and link.to_socket == socket]
                item = {"socket": socket.identifier}
                if incoming:
                    item["links"] = sorted((canonical({"node": sha(canonical(node_record(link.from_node, stack | {token}))), "socket": link.from_socket.identifier}).decode("ascii") for link in incoming))
                elif hasattr(socket, "default_value"):
                    item["default"] = sample_tree(socket.default_value)
                record["inputs"].append(item)
            for socket in node.outputs:
                item = {"socket": socket.identifier}
                if node.bl_idname in ("ShaderNodeRGB", "ShaderNodeValue") and hasattr(socket, "default_value"):
                    item["default"] = sample_tree(socket.default_value)
                record["outputs"].append(item)
            record["inputs"].sort(key=lambda item: item["socket"]); record["outputs"].sort(key=lambda item: item["socket"])
            memo[token] = record
            return record
        nodes = sorted(canonical(node_record(node, set())).decode("ascii") for node in tree.nodes)
        links = sorted(canonical({"from": sha(canonical(node_record(link.from_node, set()))), "fromSocket": link.from_socket.identifier,
                                  "to": sha(canonical(node_record(link.to_node, set()))), "toSocket": link.to_socket.identifier}).decode("ascii") for link in tree.links)
        return {"nodes": nodes, "links": links}
    flags = {}
    for name in ("use_backface_culling", "surface_render_method", "blend_method", "alpha_threshold", "diffuse_color", "metallic", "roughness"):
        if hasattr(material, name): flags[name] = sample_tree(getattr(material, name))
    return {"flags": flags, "graph": graph(material.node_tree, set())}


def measure(obj, part, source_hash, semantics, bpy, diagnostic_rows=None, expected_geometry=None, fidelity_source=None):
    require(obj.type == "MESH" and not obj.modifiers and not obj.constraints and obj.data.shape_keys is None and obj.animation_data is None, "FEATURE")
    dg = bpy.context.evaluated_depsgraph_get(); evaluated = obj.evaluated_get(dg)
    mesh = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=dg)
    try:
        mesh.calc_loop_triangles()
        require(3 <= len(mesh.vertices) <= 60000 and 1 <= len(mesh.loop_triangles) <= 20000 and len(mesh.uv_layers) <= 8, "GEOMETRY_COUNTS")
        uv_keys = sorted((key for key in semantics if key.startswith("TEXCOORD_")), key=lambda key: int(key.split("_")[1]))
        color_keys = sorted((key for key in semantics if key.startswith("COLOR_")), key=lambda key: int(key.split("_")[1]))
        require(uv_keys == ["TEXCOORD_%d" % i for i in range(len(uv_keys))] and len(mesh.uv_layers) == len(uv_keys), "FEATURE")
        require(color_keys == ["COLOR_%d" % i for i in range(len(color_keys))] and len(mesh.color_attributes) == len(color_keys), "FEATURE")
        if "TANGENT" in semantics:
            require(bool(uv_keys), "FEATURE"); mesh.calc_tangents(uvmap=mesh.uv_layers[0].name)
        vertex_ids = None
        if fidelity_source is not None:
            attribute = mesh.attributes.get(VERTEX_ID)
            require(attribute is not None and attribute.domain == "POINT" and attribute.data_type == "FLOAT" and
                    len(attribute.data) == len(mesh.vertices), "FIDELITY_CORRESPONDENCE")
            vertex_ids = checked_vertex_ids([float(item.value) for item in attribute.data], part["vertexCount"], fidelity_source["usedIds"])
        world = obj.matrix_world.copy()
        if fidelity_source is not None: check_fidelity_matrix(bpy_matrix_y_up(world))
        determinant = world.to_3x3().determinant(); require(abs(determinant) > 1e-20, "GEOMETRY_TRANSFORM")
        normal_matrix = world.to_3x3().inverted().transposed()
        def y_up(v): return [float(v[0]), float(v[2]), -float(v[1])]
        used = set(); edge_uses = Counter(); invalid_uvs = 0; degenerate = 0; rows = []; correspondence = []
        for polygon in mesh.polygons:
            for edge in polygon.edge_keys: edge_uses[tuple(sorted(edge))] += 1
        for layer in mesh.uv_layers:
            for item in layer.data:
                if any(not math.isfinite(n) or abs(n) > 1_000_000 for n in item.uv): invalid_uvs += 1
        for triangle in mesh.loop_triangles:
            corners, points = [], []
            if vertex_ids is not None:
                correspondence.append([vertex_ids[mesh.loops[loop_index].vertex_index] for loop_index in triangle.loops])
            for loop_index in triangle.loops:
                loop = mesh.loops[loop_index]; vertex = loop.vertex_index; used.add(vertex)
                p = y_up(world @ mesh.vertices[vertex].co); points.append(p)
                corner = {"POSITION": [quantize(n) for n in p]}
                local_values = {"POSITION": y_up(mesh.vertices[vertex].co)}
                world_values = {"POSITION": p}
                if "NORMAL" in semantics:
                    require(len(mesh.corner_normals) == len(mesh.loops), "FEATURE")
                    n = normal_matrix @ mesh.corner_normals[loop_index].vector
                    require(n.length > 0, "GEOMETRY_DIRECTION"); n.normalize(); corner["NORMAL"] = [quantize(v) for v in y_up(n)]
                    local_values["NORMAL"] = y_up(mesh.corner_normals[loop_index].vector)
                    world_values["NORMAL"] = y_up(n)
                if "TANGENT" in semantics:
                    tangent = world.to_3x3() @ loop.tangent
                    require(tangent.length > 0, "FEATURE"); tangent.normalize()
                    corner["TANGENT"] = [quantize(v) for v in y_up(tangent)] + [quantize(-loop.bitangent_sign * (1 if determinant >= 0 else -1))]
                    local_values["TANGENT"] = y_up(loop.tangent) + [-float(loop.bitangent_sign)]
                    world_values["TANGENT"] = y_up(tangent) + [-float(loop.bitangent_sign)*(1 if determinant >= 0 else -1)]
                for index, key in enumerate(uv_keys):
                    uv = mesh.uv_layers[index].data[loop_index].uv
                    corner[key] = [quantize(uv.x), quantize(1 - uv.y)]
                    local_values[key] = world_values[key] = [float(uv.x), 1-float(uv.y)]
                for index, key in enumerate(color_keys):
                    layer = mesh.color_attributes[index]; require(layer.domain in ("POINT", "CORNER"), "FEATURE")
                    corner[key] = [quantize(n) for n in layer.data[vertex if layer.domain == "POINT" else loop_index].color]
                    local_values[key] = world_values[key] = [float(n) for n in layer.data[vertex if layer.domain == "POINT" else loop_index].color]
                if fidelity_source is not None:
                    compare_fidelity_corner(fidelity_source, vertex_ids[vertex], local_values, world_values)
                corners.append(corner)
            a,b,c = points; u=[b[k]-a[k] for k in range(3)]; v=[c[k]-a[k] for k in range(3)]
            if math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]) <= 1e-10: degenerate += 1
            rows.append(triangle_key(corners))
        edges = [tuple(sorted(edge.vertices)) for edge in mesh.edges]
        loose_vertices = len(mesh.vertices) - len(used); loose_edges = sum(edge_uses[edge] == 0 for edge in edges)
        require(not (loose_vertices or loose_edges), "GEOMETRY_TOPOLOGY")
        require(not degenerate, "GEOMETRY_AREA")
        require(not invalid_uvs, "GEOMETRY_UV")
        slots = {mesh.polygons[t.polygon_index].material_index for t in mesh.loop_triangles}
        require(len(slots) == 1, "MATERIAL")
        index = next(iter(slots)); material = obj.material_slots[index].material if index < len(obj.material_slots) else None
        digest = geometry_hash(rows)
        correspondence_digest = None
        if fidelity_source is not None:
            correspondence_digest = correspondence_hash(correspondence)
            require(correspondence_digest == fidelity_source["correspondenceSha256"], "FIDELITY_CORRESPONDENCE")
        if diagnostic_rows is not None and digest != expected_geometry:
            diagnostic_rows.extend(rows)
        return {"sourceKey": part["sourceKey"], "originMarker": part["originMarker"],
                "sourceObjectId": object_id(source_hash, "render", part["sourceKey"]), "vertices": len(mesh.vertices), "triangles": len(mesh.loop_triangles),
                "boundaryEdges": sum(edge_uses[edge] == 1 for edge in edges), "nonManifoldEdges": sum(edge_uses[edge] != 2 for edge in edges),
                "looseVertices": loose_vertices, "looseEdges": loose_edges, "degenerateFaces": degenerate, "invalidUVs": invalid_uvs,
                "uvLayers": len(mesh.uv_layers), "finitePositions": True, "geometrySha256": digest,
                **({"correspondenceSha256": correspondence_digest} if fidelity_source is not None else {}),
                "materialSha256": sha(canonical(material_graph(material)))}
    finally:
        evaluated.to_mesh_clear()


def render_metrics(path, bpy):
    raw = read_owned(path, 16 * 1024 * 1024)
    require(raw.startswith(b"\x89PNG\r\n\x1a\n"), "RENDER")
    image = bpy.data.images.load(str(path), check_existing=False)
    try:
        width,height = (int(n) for n in image.size); require(128 <= width <= 1024 and 128 <= height <= 1024, "RENDER")
        pixels = array("f", [0.0]) * (width * height * 4); require(len(image.pixels) == len(pixels), "RENDER")
        image.pixels.foreach_get(pixels)
        low, high, mean, square, count = math.inf, -math.inf, 0.0, 0.0, 0
        for at in range(0, len(pixels), 4):
            require(all(math.isfinite(n) and 0 <= n <= 1_000_000 for n in pixels[at:at+4]), "RENDER")
            value = 0.2126*pixels[at]+0.7152*pixels[at+1]+0.0722*pixels[at+2]
            count += 1; delta=value-mean; mean += delta/count; square += delta*(value-mean)
            low=min(low,value); high=max(high,value)
        deviation=math.sqrt(max(0,square/count))
        require(high-low > 1e-3 and deviation > 1e-4, "RENDER")
        require(read_owned(path, 16 * 1024 * 1024) == raw, "SOURCE")
        return {"path": path.name, "width":width, "height":height, "finitePixels":True,
                "minLuminance":low,"maxLuminance":high,"meanLuminance":mean,"standardDeviation":deviation}
    finally:
        bpy.data.images.remove(image)
