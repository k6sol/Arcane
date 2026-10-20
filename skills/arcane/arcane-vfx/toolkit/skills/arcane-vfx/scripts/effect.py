"""Original, dependency-free authoring for finite Roblox particle effects."""
import argparse
import base64
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys
import zlib

ROOT = Path(__file__).resolve().parent.parent
NAME = re.compile(r"[a-z][a-z0-9-]{0,47}\Z")
TEXTURES = ("flare", "ring", "smoke", "spark")


def fail(path, message):
    raise ValueError(f"{path}: {message}")


def fields(value, required, optional, path):
    if not isinstance(value, dict):
        fail(path, "expected an object")
    missing, extra = set(required) - value.keys(), value.keys() - set(required) - set(optional)
    if missing or extra:
        fail(path, f"missing fields {sorted(missing)}; unknown fields {sorted(extra)}")


def number(value, lo, hi, path, integer=False):
    if type(value) not in (int, float) or not lo <= value <= hi or not math.isfinite(value):
        fail(path, f"expected a finite number in [{lo}, {hi}]")
    if integer and type(value) is not int:
        fail(path, "expected an integer")
    return value


def vector(value, length, lo, hi, path):
    if not isinstance(value, list) or len(value) != length:
        fail(path, f"expected {length} numbers")
    return [number(v, lo, hi, f"{path}[{i}]") for i, v in enumerate(value)]


def curve(value, maximum, path):
    if not isinstance(value, list) or not 2 <= len(value) <= 8:
        fail(path, "expected 2 to 8 age/value keys")
    result = [vector(v, 2, 0, maximum, f"{path}[{i}]") for i, v in enumerate(value)]
    if result[0][0] != 0 or result[-1][0] != 1:
        fail(path, "age keys must start at 0 and end at 1")
    if any(not a[0] < b[0] <= 1 for a, b in zip(result, result[1:])):
        fail(path, "age keys must increase strictly within [0, 1]")
    return result


def normalize(spec):
    fields(spec, ("version", "name", "seed", "duration", "layers"), ("budgets",), "effect")
    if type(spec["version"]) is not int or spec["version"] != 1:
        fail("version", "expected 1")
    if not isinstance(spec["name"], str) or not NAME.fullmatch(spec["name"]):
        fail("name", "use a lowercase name, up to 48 characters")
    result = {"version": 1, "name": spec["name"], "seed": number(spec["seed"], 0, 2147483647, "seed", True),
              "duration": number(spec["duration"], .05, 15, "duration")}
    limits = {"peakParticles": 600, "totalParticles": 2048, "textureMiB": 16}
    maximums = {"peakParticles": 2000, "totalParticles": 4096, "textureMiB": 64}
    supplied = spec.get("budgets", {})
    fields(supplied, (), limits, "budgets")
    for key, value in supplied.items():
        limits[key] = number(value, 1, maximums[key], f"budgets.{key}", True)
    result["budgets"] = limits
    layers = spec["layers"]
    if not isinstance(layers, list) or not 1 <= len(layers) <= 8:
        fail("layers", "expected 1 to 8 layers")
    names, output = set(), []
    required = ("id", "start", "duration", "burst", "rate", "life", "speed", "spread", "position",
                "acceleration", "drag", "texture", "blend", "color", "size", "alpha")
    for i, layer in enumerate(layers):
        path = f"layers[{i}]"
        fields(layer, required, ("kind",), path)
        name = layer["id"]
        if not isinstance(name, str) or not NAME.fullmatch(name) or name in names:
            fail(path + ".id", "expected a unique lowercase name, up to 48 characters")
        names.add(name)
        if layer.get("kind", "particles") != "particles":
            fail(path + ".kind", "only particle layers are exported by this version")
        row = {"id": name, "kind": "particles"}
        for key, lo, hi in (("start", 0, 15), ("duration", 0, 15), ("burst", 0, 4096), ("rate", 0, 400),
                            ("spread", 0, 180), ("drag", 0, 10)):
            row[key] = number(layer[key], lo, hi, path + "." + key, key == "burst")
        if row["start"] + row["duration"] > result["duration"] + 1e-9:
            fail(path, "emission window extends beyond effect duration")
        for key, count, lo, hi in (("life", 2, .01, 20), ("speed", 2, 0, 200), ("position", 3, -10000, 10000),
                                   ("acceleration", 3, -1000, 1000), ("color", 3, 0, 1)):
            row[key] = vector(layer[key], count, lo, hi, path + "." + key)
        if row["life"][0] > row["life"][1] or row["speed"][0] > row["speed"][1]:
            fail(path, "range minimum exceeds maximum")
        if layer["texture"] not in TEXTURES or layer["blend"] not in ("alpha", "add"):
            fail(path, "unknown texture or blend mode")
        row["texture"], row["blend"] = layer["texture"], layer["blend"]
        row["size"] = curve(layer["size"], 100, path + ".size")
        row["alpha"] = curve(layer["alpha"], 1, path + ".alpha")
        if row["burst"] + math.floor(row["rate"] * row["duration"] + 1e-9) == 0:
            fail(path, "layer emits no particles")
        output.append(row)
    result["layers"] = output
    bounds = statistics(result)
    for key in ("peakParticles", "totalParticles"):
        if bounds[key] > limits[key]:
            fail("budgets." + key, f"authored bound {bounds[key]} exceeds {limits[key]}")
    return result


def statistics(spec):
    return {
        "peakParticles": sum(l["burst"] + math.ceil(l["rate"] * min(l["duration"], l["life"][1])) for l in spec["layers"]),
        "totalParticles": sum(l["burst"] + math.floor(l["rate"] * l["duration"] + 1e-9) for l in spec["layers"]),
        "tailEnd": max(l["start"] + l["duration"] + l["life"][1] for l in spec["layers"]),
    }


def random_value(seed, index, channel):
    x = (seed ^ (((index + 1) * 0x9e3779b9) & 0xffffffff) ^ (((channel + 1) * 0x85ebca6b) & 0xffffffff)) & 0xffffffff
    x = ((x ^ (x >> 16)) * 0x7feb352d) & 0xffffffff
    x = ((x ^ (x >> 15)) * 0x846ca68b) & 0xffffffff
    return (x ^ (x >> 16)) / 4294967296


def layer_seed(name):
    value = 2166136261
    for letter in name:
        value = ((value ^ ord(letter)) * 16777619) & 0xffffffff
    return value


def evaluate_curve(keys, age):
    for a, b in zip(keys, keys[1:]):
        if age <= b[0]:
            return a[1] + (b[1] - a[1]) * (age - a[0]) / (b[0] - a[0])
    return keys[-1][1]


def sample(spec, time):
    particles = []
    for li, layer in enumerate(spec["layers"]):
        stream = math.floor(layer["rate"] * layer["duration"] + 1e-9)
        for index in range(layer["burst"] + stream):
            born = layer["start"] + (0 if index < layer["burst"] else (index - layer["burst"] + 1) / layer["rate"])
            age = time - born
            if age < 0:
                continue
            seed = spec["seed"] ^ layer_seed(layer["id"])
            rand = lambda channel: random_value(seed, index, channel)
            life = layer["life"][0] + (layer["life"][1] - layer["life"][0]) * rand(0)
            if age >= life:
                continue
            speed = layer["speed"][0] + (layer["speed"][1] - layer["speed"][0]) * rand(1)
            cosine = 1 - rand(2) * (1 - math.cos(math.radians(layer["spread"])))
            sine, angle = math.sqrt(max(0, 1 - cosine * cosine)), rand(3) * math.tau
            velocity = [speed * sine * math.cos(angle), speed * cosine, speed * sine * math.sin(angle)]
            drag = layer["drag"]
            factor = -math.expm1(-drag * age) / drag if drag > 1e-6 else age
            gravity = (age - factor) / drag if drag > 1e-6 else .5 * age * age
            position = [p + v * factor + a * gravity for p, v, a in zip(layer["position"], velocity, layer["acceleration"])]
            t = age / life
            particles.append({"layer": li, "index": index, "position": position, "age": t,
                              "size": evaluate_curve(layer["size"], t), "alpha": evaluate_curve(layer["alpha"], t)})
    return particles


def encode_png(width, height, pixels):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    rows = b"".join(b"\0" + pixels[y * width * 4:(y + 1) * width * 4] for y in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def texture_alpha(kind, x, y, t, seed):
    radius = math.hypot(x, y)
    if kind == "flare":
        return math.exp(-radius * radius * (5 + 3 * t)) * max(0, 1 - radius) ** .4
    if kind == "ring":
        ring = math.exp(-((radius - (.24 + .48 * t)) / (.065 + .04 * t)) ** 2)
        return ring * max(0, 1 - radius) ** .35
    if kind == "spark":
        return math.exp(-((x / .12) ** 2 + (y / .72) ** 2) * 2) * max(0, 1 - radius)
    value = 0
    for i in range(7):
        angle = random_value(seed, i, 0) * math.tau + .4 * t
        offset = .25 * random_value(seed, i, 1)
        cx, cy = math.cos(angle) * offset, math.sin(angle) * offset
        width = .15 + .14 * random_value(seed, i, 2) + .08 * t
        value += math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / width ** 2) * .32
    breakup = .86 + .14 * math.sin(19 * x + seed) * math.sin(17 * y - 2 * t)
    return min(1, value * breakup) * max(0, 1 - radius) ** 1.5


def make_atlas(kind, tile, seed):
    width = tile * 4
    pixels = bytearray(width * width * 4)
    gutter = max(2, tile // 16)
    for frame in range(16):
        for y in range(gutter, tile - gutter):
            for x in range(gutter, tile - gutter):
                u, v = (x + .5 - tile / 2) / (tile / 2 - gutter), (y + .5 - tile / 2) / (tile / 2 - gutter)
                alpha = round(max(0, min(1, texture_alpha(kind, u, v, frame / 15, seed))) * 255)
                offset = ((frame // 4 * tile + y) * width + frame % 4 * tile + x) * 4
                pixels[offset:offset + 4] = bytes((255, 255, 255, alpha))
    return bytes(pixels)


def contact_sheet(spec, tile, atlases):
    """Bounded raster comparison using the actual authored atlas alpha."""
    size, width, height = 256, 1024, 512
    pixels = bytearray(bytes((23, 28, 36, 255)) * width * height)
    tail = statistics(spec)["tailEnd"]
    first = min(l["start"] + (0 if l["burst"] else 1/l["rate"]) + l["life"][0] * .15 for l in spec["layers"])
    second = min(l["start"] + (0 if l["burst"] else 1/l["rate"]) + l["life"][0] * .5 for l in spec["layers"])
    times = sorted([first, second] + [tail * f for f in (.1, .2, .35, .5, .7, .92)])
    snapshots = [sample(spec, time) for time in times]
    work = 0
    yaw, pitch = .55, .32
    def unit(point):
        x = point[0] * math.cos(yaw) - point[2] * math.sin(yaw)
        z = point[0] * math.sin(yaw) + point[2] * math.cos(yaw)
        return (x, point[1] * math.cos(pitch) - z * math.sin(pitch),
                z * math.cos(pitch) + point[1] * math.sin(pitch))
    visible = [(unit(p["position"]),p["size"]/2) for points in snapshots for p in points if p["alpha"] > .01 and p["size"] > 0]
    low = [min((p[a]-r for p,r in visible),default=-1) for a in (0,1)]
    high = [max((p[a]+r for p,r in visible),default=1) for a in (0,1)]
    center = [(a+b)/2 for a,b in zip(low,high)]
    scale = 208/max(2,high[0]-low[0],high[1]-low[1])
    def project(point):
        x,y,z = unit(point)
        return (128+(x-center[0])*scale,138-(y-center[1])*scale,z)
    for panel, time in enumerate(times):
        points = sorted(snapshots[panel], key=lambda p: project(p["position"])[2])
        ox, oy = panel % 4 * size, panel // 4 * size
        for point in points:
            layer, diameter = spec["layers"][point["layer"]], point["size"] * scale
            if diameter < .1 or point["alpha"] <= 0:
                continue
            cx, cy, _ = project(point["position"])
            left, top = cx - diameter / 2, cy - diameter / 2
            x0, x1 = max(0, math.floor(left)), min(size, math.ceil(left + diameter))
            y0, y1 = max(0, math.floor(top)), min(size, math.ceil(top + diameter))
            work += max(0, x1-x0) * max(0, y1-y0)
            if work > 8_000_000:
                fail("contact-sheet", "raster work exceeds 8 million samples; reduce billboard coverage")
            frame = min(15, int(point["age"] * 16))
            atlas = atlases[layer["texture"]]
            for y in range(y0,y1):
                sy = min(tile-1,max(0,int((y+.5-top)/diameter*tile))) + frame//4*tile
                for x in range(x0,x1):
                    sx = min(tile-1,max(0,int((x+.5-left)/diameter*tile))) + frame%4*tile
                    alpha = atlas[(sy*tile*4+sx)*4+3] / 255 * point["alpha"]
                    if alpha <= 0:
                        continue
                    offset = ((oy+y)*width+ox+x)*4
                    for channel in range(3):
                        foreground, background = layer["color"][channel]*255, pixels[offset+channel]
                        value = background + foreground*alpha if layer["blend"] == "add" else foreground*alpha + background*(1-alpha)
                        pixels[offset+channel] = min(255,max(0,round(value)))
        glyphs = {"0":"111101101101111","1":"010110010010111","2":"111001111100111","3":"111001111001111","4":"101101111001001","5":"111100111001111","6":"111100111101111","7":"111001001001001","8":"111101111101111","9":"111101111001111",".":"000000000000010","s":"011100010001110"}
        for letter, character in enumerate(f"{time:.3f}s"):
            for index, bit in enumerate(glyphs[character]):
                if bit == "1":
                    for dy in range(2):
                        for dx in range(2):
                            x,y = ox+10+letter*8+index%3*2+dx,oy+10+index//3*2+dy
                            offset=(y*width+x)*4
                            pixels[offset:offset+4]=bytes((175,192,211,255))
    return encode_png(width,height,bytes(pixels)), times


def lua(value):
    if isinstance(value, dict):
        return "{" + ",".join("[" + json.dumps(k) + "]=" + lua(v) for k, v in value.items()) + "}"
    if isinstance(value, list):
        return "{" + ",".join(lua(v) for v in value) + "}"
    return json.dumps(value, allow_nan=False)


def read_spec(path):
    data = Path(path).read_bytes()
    if len(data) > 262144:
        fail("spec", "file exceeds 256 KiB")
    def constant(value):
        fail("spec", "nonfinite JSON constant " + value)
    def unique(pairs):
        obj = {}
        for key, value in pairs:
            if key in obj:
                fail("spec", "duplicate JSON key " + key)
            obj[key] = value
        return obj
    return normalize(json.loads(data.decode("utf8"), parse_constant=constant, object_pairs_hook=unique))


def build(spec, out, tile=64):
    spec = normalize(spec)
    if tile not in (32, 64, 128):
        fail("tile", "choose 32, 64 or 128")
    textures = sorted({l["texture"] for l in spec["layers"]})
    texture_bytes = len(textures) * (tile * 4) ** 2 * 4
    if texture_bytes > spec["budgets"]["textureMiB"] * 1024 ** 2:
        fail("budgets.textureMiB", f"uncompressed atlases require {texture_bytes} bytes")
    out = Path(out).resolve()
    if out.exists() or out.parent == out:
        fail("out", "choose a new output directory")
    timeline = (ROOT / "scripts/timeline.cjs").read_text(encoding="utf8")
    template = (ROOT / "assets/preview.html").read_text(encoding="utf8")
    runtime = (ROOT / "assets/Runtime.luau").read_bytes()
    out.mkdir(parents=True)
    texture_info, images, atlases = {}, {}, {}
    for kind in textures:
        pixels = make_atlas(kind, tile, spec["seed"])
        atlases[kind] = pixels
        png = encode_png(tile * 4, tile * 4, pixels)
        (out / f"{kind}.png").write_bytes(png)
        texture_info[kind] = {"file": f"{kind}.png", "pixelSha256": hashlib.sha256(pixels).hexdigest(), "width": tile * 4, "frames": 16}
        images[kind] = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
    sheet, sheet_times = contact_sheet(spec, tile, atlases)
    (out / "contact-sheet.png").write_bytes(sheet)
    (out / "Effect.json").write_text(json.dumps(spec, indent=2, allow_nan=False) + "\n", encoding="utf8", newline="\n")
    (out / "Effect.luau").write_text("--!strict\n-- Generated local effect data.\nreturn " + lua(spec) + "\n", encoding="utf8", newline="\n")
    (out / "Runtime.luau").write_bytes(runtime)
    script = timeline + "\nconst effect = " + json.dumps(spec, allow_nan=False) + ";\nconst textureSources = " + json.dumps(images) + ";\n"
    script += (ROOT / "scripts/preview.js").read_text(encoding="utf8")
    # Only validated numeric/ASCII manifest data and generated data URIs enter this script.
    script = script.replace("</script", "<\\/script")
    script_hash = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
    html = template.replace("__SCRIPT_HASH__", script_hash).replace("__SCRIPT__", script)
    (out / "preview.html").write_text(html, encoding="utf8", newline="\n")
    artifacts = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.iterdir()) if p.is_file()}
    sources = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(ROOT.rglob("*")) if p.is_file() and "__pycache__" not in p.parts}
    report = {"version": 1, "effect": spec["name"], "seed": spec["seed"], "statistics": statistics(spec), "textures": texture_info,
              "uncompressedTextureBytes": texture_bytes, "artifacts": artifacts, "sourceHashes": sources, "contactSheetTimes": sheet_times,
              "generator": {"algorithm": 1, "python": sys.version.split()[0], "zlib": zlib.ZLIB_VERSION},
              "preview": "analytic approximation; native Studio acceptance pending", "networkCalls": 0}
    (out / "build.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf8", newline="\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("validate", "build", "sample"))
    parser.add_argument("spec")
    parser.add_argument("--out")
    parser.add_argument("--tile", type=int, default=64)
    parser.add_argument("--time", type=float, default=0)
    args = parser.parse_args()
    try:
        spec = read_spec(args.spec)
        if args.command == "build":
            if not args.out:
                fail("out", "--out NEW_DIRECTORY is required")
            result = build(spec, args.out, args.tile)
        elif args.command == "sample":
            number(args.time, 0, 35, "time")
            result = sample(spec, args.time)
        else:
            result = {"valid": True, **statistics(spec)}
        print(json.dumps(result, allow_nan=False))
    except (ValueError, OSError, RecursionError) as error:
        print(f"effect {args.command} failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
