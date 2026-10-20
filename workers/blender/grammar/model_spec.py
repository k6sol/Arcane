"""Declarative model spec ("part graph") validation for assets_procedural kind "spec".

Data only: numbers, enums, short ids and point lists. No code, paths, imports or
expressions are ever accepted. The host (packages/asset-pipeline/src/model-spec.ts)
applies the same rules and canonical material defaults before this file runs; this
module re-checks everything so the planner never trusts its input, and fills the
geometric defaults the planner uses. Pure Python (no Blender) so it is unit-testable.

Coordinates are metres, Z up, the front faces -Y. Rotations are XYZ Euler degrees.
"""
import math
import re

OPS = ("box", "cylinder", "sphere", "revolve", "extrude", "loft", "sweep", "sdf")
SHAPES = ("circle", "ellipse", "rect", "ngon", "star", "polygon")
PRIMS = ("sphere", "box", "capsule", "torus", "cone", "cylinder", "ellipsoid")
CSG = ("union", "subtract", "intersect")
BLENDS = ("union", "subtract", "intersect")
CURVES = ("linear", "smooth")
PATH_CURVES = ("linear", "catmull", "bezier")
MIRRORS = ("x", "y", "z", "xy", "xz", "yz", "xyz")
AXES = ("x", "y", "z")
PIVOTS = ("base", "origin")
# finish -> (evidence profile, roughness, metallic, edge wear, cavity, default linear colour)
FINISHES = {
    "wood": ("bark", .7, 0.0, .35, .5, (.34, .2, .1)),
    "stone": ("stone", .86, 0.0, .4, .6, (.46, .44, .4)),
    "metal": ("weathered", .42, 1.0, .45, .55, (.3, .3, .31)),
    "plaster": ("stone", .9, 0.0, .25, .45, (.74, .71, .65)),
    "ceramic": ("stone", .32, 0.0, .2, .4, (.78, .76, .7)),
    "leather": ("weathered", .62, 0.0, .35, .45, (.24, .13, .07)),
    "fabric": ("weathered", .92, 0.0, .15, .4, (.4, .3, .24)),
    "plastic": ("weathered", .45, 0.0, .15, .3, (.55, .1, .08)),
    "glass": ("weathered", .06, 0.0, .05, .2, (.5, .58, .55)),
}
LIMITS = {
    "parts": 48, "materials": 3, "instances": 640, "points": 64, "sections": 32, "prims": 24,
    "coord": 50.0, "size": (0.02, 40.0), "length": (0.0005, 40.0), "count": 64, "scatter": 256,
}
ID = re.compile(r"^[a-z][a-z0-9_]{0,23}$")
MATERIAL_ID = re.compile(r"^[a-z][a-z0-9]{0,15}$")


class SpecError(ValueError):
    """Bounded, data-free validation message (never echoes arbitrary input)."""


def fail(message):
    raise SpecError("Model spec: " + message)


def fields(value, allowed, where):
    if not isinstance(value, dict):
        fail(where + " must be an object")
    for key in value:
        if key not in allowed:
            fail(where + " has an unsupported field" + (" " + key if isinstance(key, str) and ID.match(key) else ""))
    return value


def number(value, low, high, where, default=None):
    if value is None:
        if default is None:
            fail(where + " is required")
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        fail("%s must be a number in %g..%g" % (where, low, high))
    return float(value)


def integer(value, low, high, where, default=None):
    n = number(value, low, high, where, default)
    if n != int(n):
        fail(where + " must be an integer")
    return int(n)


def choice(value, options, where, default=None):
    if value is None:
        if default is None:
            fail(where + " is required")
        return default
    if value not in options:
        fail(where + " must be one of " + ", ".join(options))
    return value


def flag(value, where, default=False):
    if value is None:
        return default
    if not isinstance(value, bool):
        fail(where + " must be true or false")
    return value


def vec(value, n, low, high, where, default=None):
    if value is None:
        if default is None:
            fail(where + " is required")
        return tuple(default)
    if not isinstance(value, list) or len(value) != n:
        fail("%s must be %d numbers" % (where, n))
    return tuple(number(v, low, high, where) for v in value)


def scale3(value, where):
    if value is None:
        return (1.0, 1.0, 1.0)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        s = number(value, .01, 100, where)
        return (s, s, s)
    return vec(value, 3, .01, 100, where)


def points(value, dims, low_count, where, low=-50.0, high=50.0):
    if not isinstance(value, list) or not low_count <= len(value) <= LIMITS["points"]:
        fail("%s needs %d..%d points" % (where, low_count, LIMITS["points"]))
    return [vec(p, dims, low, high, where + " point") for p in value]


def shape(value, where):
    s = fields(value, ("type", "r", "rx", "ry", "w", "h", "n", "r2", "points", "round"), where)
    kind = choice(s.get("type"), SHAPES, where + ".type")
    lo, hi = LIMITS["length"]
    out = {"type": kind, "round": number(s.get("round"), 0, 10, where + ".round", 0.0)}
    if kind == "circle":
        out["r"] = number(s.get("r"), lo, hi, where + ".r")
    elif kind == "ellipse":
        out["rx"], out["ry"] = number(s.get("rx"), lo, hi, where + ".rx"), number(s.get("ry"), lo, hi, where + ".ry")
    elif kind == "rect":
        out["w"], out["h"] = number(s.get("w"), lo, hi, where + ".w"), number(s.get("h"), lo, hi, where + ".h")
        if out["round"] * 2 >= min(out["w"], out["h"]):
            fail(where + ".round must be less than half the smaller side")
    elif kind in ("ngon", "star"):
        out["n"] = integer(s.get("n"), 3, 64, where + ".n")
        out["r"] = number(s.get("r"), lo, hi, where + ".r")
        if kind == "star":
            out["r2"] = number(s.get("r2"), lo, hi, where + ".r2")
    else:
        out["points"] = points(s.get("points"), 2, 3, where + ".points")
        if polygon_area(out["points"]) == 0:
            fail(where + ".points enclose no area")
    return out


def polygon_area(pts):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1])) / 2


def path(value, where):
    p = fields(value, ("points", "curve", "closed"), where)
    closed = flag(p.get("closed"), where + ".closed")
    curve = choice(p.get("curve"), PATH_CURVES, where + ".curve", "catmull")
    pts = points(p.get("points"), 3, 3 if closed else 2, where + ".points")
    if curve == "bezier" and (len(pts) - 1) % 3 and not closed:
        fail(where + " bezier paths need 3k+1 points (anchor, handle, handle, anchor, ...)")
    if curve == "bezier" and closed and len(pts) % 3:
        fail(where + " closed bezier paths need 3k points")
    if any(math.dist(a, b) < 1e-5 for a, b in zip(pts, pts[1:])):
        fail(where + " has repeated consecutive points")
    return {"points": pts, "curve": curve, "closed": closed}


def curve_samples(value, where):
    # [[t, value], ...] with ascending t in 0..1 (a scale or twist curve).
    if value is None:
        return None
    pts = points(value, 2, 2, where, -100, 100)
    if any(not 0 <= t <= 1 for t, _ in pts) or any(b[0] <= a[0] for a, b in zip(pts, pts[1:])):
        fail(where + " needs ascending t in 0..1")
    if any(not 0 <= s <= 20 for _, s in pts):
        fail(where + " values must be 0..20")
    return pts


def noise(value, where):
    if value is None:
        return None
    n = fields(value, ("amp", "scale", "octaves", "warp", "mask", "seed"), where)
    out = {"amp": number(n.get("amp"), 0, 2, where + ".amp"), "scale": number(n.get("scale"), .005, 20, where + ".scale", .25),
           "octaves": integer(n.get("octaves"), 1, 6, where + ".octaves", 4), "warp": number(n.get("warp"), 0, 2, where + ".warp", 0.0),
           "seed": integer(n.get("seed"), 0, 65535, where + ".seed", 0), "mask": None}
    if n.get("mask") is not None:
        m = fields(n["mask"], ("axis", "from", "to"), where + ".mask")
        out["mask"] = {"axis": choice(m.get("axis"), AXES, where + ".mask.axis", "z"),
                       "from": number(m.get("from"), -50, 50, where + ".mask.from"), "to": number(m.get("to"), -50, 50, where + ".mask.to")}
        if out["mask"]["from"] == out["mask"]["to"]:
            fail(where + ".mask from and to must differ")
    return out


def prim(value, where):
    p = fields(value, ("prim", "at", "rot", "r", "r2", "size", "a", "b", "h", "radii", "round", "op", "blend"), where)
    kind = choice(p.get("prim"), PRIMS, where + ".prim")
    lo, hi = LIMITS["length"]
    c = LIMITS["coord"]
    out = {"prim": kind, "at": vec(p.get("at"), 3, -c, c, where + ".at", (0, 0, 0)), "rot": vec(p.get("rot"), 3, -720, 720, where + ".rot", (0, 0, 0)),
           "op": choice(p.get("op"), BLENDS, where + ".op", "union"), "blend": number(p.get("blend"), 0, 5, where + ".blend", 0.0),
           "round": number(p.get("round"), 0, 5, where + ".round", 0.0)}
    if kind == "sphere":
        out["r"] = number(p.get("r"), lo, hi, where + ".r")
    elif kind == "box":
        out["size"] = vec(p.get("size"), 3, lo, hi, where + ".size")
        if out["round"] * 2 >= min(out["size"]):
            fail(where + ".round must be less than half the smallest size")
    elif kind == "capsule":
        out["a"], out["b"] = vec(p.get("a"), 3, -c, c, where + ".a"), vec(p.get("b"), 3, -c, c, where + ".b")
        out["r"] = number(p.get("r"), lo, hi, where + ".r")
        out["r2"] = number(p.get("r2"), lo, hi, where + ".r2", out["r"])
    elif kind == "torus":
        out["r"], out["r2"] = number(p.get("r"), lo, hi, where + ".r"), number(p.get("r2"), lo, hi, where + ".r2")
        if out["r2"] >= out["r"]:
            fail(where + " torus tube radius r2 must be smaller than r")
    elif kind in ("cone", "cylinder"):
        out["r"], out["h"] = number(p.get("r"), lo if kind == "cylinder" else 0, hi, where + ".r"), number(p.get("h"), lo, hi, where + ".h")
        out["r2"] = number(p.get("r2"), 0, hi, where + ".r2", 0.0 if kind == "cone" else out["r"])
        if max(out["r"], out["r2"]) <= 0:
            fail(where + " needs a positive radius")
    else:
        out["radii"] = vec(p.get("radii"), 3, lo, hi, where + ".radii")
    return out


COMMON = ("id", "op", "material", "at", "rot", "scale", "parent", "mirror", "radial", "array", "scatter", "csg", "with",
          "noise", "smooth", "detail", "grain", "segments", "surface", "blocks")
LIBRARY = re.compile(r"^[a-z][a-z-]{1,31}$")
OP_FIELDS = {
    "box": ("size", "bevel"),
    "cylinder": ("radius", "radiusTop", "height", "bevel"),
    "sphere": ("radius",),
    "revolve": ("profile", "curve", "flutes", "closed"),
    "extrude": ("shape", "height", "bevel", "inset"),
    "loft": ("sections", "curve"),
    "sweep": ("path", "shape", "twist", "taper"),
    "sdf": ("shapes", "resolution"),
}


def part(value, index, materials):
    where = "parts[%d]" % index
    p = fields(value, COMMON + sum(OP_FIELDS.values(), ()), where)
    pid = p.get("id")
    if not isinstance(pid, str) or not ID.match(pid):
        fail(where + ".id must be a lowercase id (a-z, 0-9, _; up to 24 characters)")
    where = "part " + pid
    op = choice(p.get("op"), OPS, where + ".op")
    extra = [k for k in p if k not in COMMON and k not in OP_FIELDS[op]]
    if extra:
        fail(where + " (" + op + ") does not take " + ", ".join(sorted(extra)))
    c, (lo, hi) = LIMITS["coord"], LIMITS["length"]
    mat = p.get("material")
    csg = choice(p.get("csg"), CSG, where + ".csg", "none") if p.get("csg") is not None else None
    if csg not in ("subtract", "intersect") and mat not in materials:
        fail(where + ".material must name one of the spec materials")
    if mat is not None and mat not in materials:
        fail(where + ".material must name one of the spec materials")
    smooth = p.get("smooth")
    if smooth is not None and smooth is not False:
        smooth = number(smooth, 0, 180, where + ".smooth")
    out = {"id": pid, "op": op, "material": mat, "at": vec(p.get("at"), 3, -c, c, where + ".at", (0, 0, 0)),
           "rot": vec(p.get("rot"), 3, -720, 720, where + ".rot", (0, 0, 0)), "scale": scale3(p.get("scale"), where + ".scale"),
           "parent": p.get("parent"), "csg": csg, "with": None, "noise": noise(p.get("noise"), where + ".noise"),
           "smooth": smooth, "detail": number(p.get("detail"), .1, 8, where + ".detail", 1.0),
           "grain": choice(p.get("grain"), AXES, where + ".grain", "auto") if p.get("grain") is not None else "auto",
           "segments": integer(p.get("segments"), 3, 128, where + ".segments", 0) if p.get("segments") is not None else 0,
           "mirror": choice(p.get("mirror"), MIRRORS, where + ".mirror", "none") if p.get("mirror") is not None else None,
           "radial": None, "array": None, "scatter": None, "bevelAuto": op in ("box", "cylinder", "extrude") and p.get("bevel") is None,
           "surface": None, "blocks": None}
    s = p.get("surface")
    if isinstance(s, dict):
        s = fields(s, ("on", "protrude"), where + ".surface")
        if s.get("on") is not None and (not isinstance(s["on"], str) or not ID.match(s["on"])):
            fail(where + ".surface.on must name a part")
        out["surface"] = {"on": s.get("on"), "protrude": number(s.get("protrude"), .0002, .5, where + ".surface.protrude") if s.get("protrude") is not None else None}
    elif s is not None:
        out["surface"] = flag(s, where + ".surface")
    b = p.get("blocks")
    if b is not None:
        if op != "box":
            fail(where + ".blocks (masonry courses) needs a box part")
        if isinstance(b, dict):
            b = fields(b, ("course", "length", "mortar", "depth"), where + ".blocks")
            out["blocks"] = {"course": number(b.get("course"), .08, 2, where + ".blocks.course", 0.0) or None,
                             "length": number(b.get("length"), .1, 4, where + ".blocks.length", 0.0) or None,
                             "mortar": number(b.get("mortar"), .002, .05, where + ".blocks.mortar", 0.0) or None,
                             "depth": number(b.get("depth"), .002, .05, where + ".blocks.depth", 0.0) or None}
        else:
            out["blocks"] = flag(b, where + ".blocks")
    if out["parent"] is not None and (not isinstance(out["parent"], str) or not ID.match(out["parent"])):
        fail(where + ".parent must be a part id")
    if p.get("with") is not None:
        if csg not in ("subtract", "intersect") or not isinstance(p["with"], list) or not 1 <= len(p["with"]) <= 16 or any(not isinstance(i, str) or not ID.match(i) for i in p["with"]):
            fail(where + ".with lists 1..16 part ids and needs csg subtract or intersect")
        out["with"] = list(p["with"])
    if p.get("radial") is not None:
        r = fields(p["radial"], ("count", "axis", "center", "offset"), where + ".radial")
        out["radial"] = {"count": integer(r.get("count"), 2, LIMITS["count"], where + ".radial.count"), "axis": choice(r.get("axis"), AXES, where + ".radial.axis", "z"),
                         "center": vec(r.get("center"), 3, -c, c, where + ".radial.center", (0, 0, 0)), "offset": number(r.get("offset"), -360, 360, where + ".radial.offset", 0.0)}
    if p.get("array") is not None:
        a = fields(p["array"], ("count", "step", "grid", "path", "align", "rotStep"), where + ".array")
        arr = {"count": None, "step": vec(a.get("step"), 3, -c, c, where + ".array.step", (0, 0, 0)), "grid": None, "path": None,
               "align": flag(a.get("align"), where + ".array.align", True), "rotStep": vec(a.get("rotStep"), 3, -360, 360, where + ".array.rotStep", (0, 0, 0))}
        if a.get("grid") is not None:
            arr["grid"] = tuple(integer(n, 1, LIMITS["count"], where + ".array.grid") for n in vec(a["grid"], 3, 1, LIMITS["count"], where + ".array.grid"))
            if arr["grid"][0] * arr["grid"][1] * arr["grid"][2] < 2:
                fail(where + ".array.grid must make at least two copies")
        else:
            arr["count"] = integer(a.get("count"), 2, LIMITS["count"], where + ".array.count")
            if a.get("path") is not None:
                arr["path"] = path(a["path"], where + ".array.path")
            elif arr["step"] == (0, 0, 0) and arr["rotStep"] == (0, 0, 0):
                fail(where + ".array needs step, rotStep, grid or path")
        out["array"] = arr
    if p.get("scatter") is not None:
        s = fields(p["scatter"], ("on", "count", "spacing", "align", "minUp", "scaleRange", "yaw", "sink", "seed"), where + ".scatter")
        if not isinstance(s.get("on"), str) or not ID.match(s["on"]):
            fail(where + ".scatter.on must name a part")
        scl = vec(s.get("scaleRange"), 2, .05, 10, where + ".scatter.scaleRange", (1, 1))
        if scl[1] < scl[0]:
            fail(where + ".scatter.scaleRange must ascend")
        out["scatter"] = {"on": s["on"], "count": integer(s.get("count"), 1, LIMITS["scatter"], where + ".scatter.count"),
                          "spacing": number(s.get("spacing"), 0, 20, where + ".scatter.spacing", 0.0), "align": number(s.get("align"), 0, 1, where + ".scatter.align", 1.0),
                          "minUp": number(s.get("minUp"), -1, 1, where + ".scatter.minUp", -1.0), "scaleRange": scl,
                          "yaw": number(s.get("yaw"), 0, 360, where + ".scatter.yaw", 360.0), "sink": number(s.get("sink"), -5, 5, where + ".scatter.sink", 0.0),
                          "seed": integer(s.get("seed"), 0, 65535, where + ".scatter.seed", 0)}
    if op == "box":
        out["size"] = vec(p.get("size"), 3, lo, hi, where + ".size")
        out["bevel"] = number(p.get("bevel"), 0, 10, where + ".bevel", 0.0)
        if out["bevel"] * 2 >= min(out["size"]):
            fail(where + ".bevel must be less than half the smallest size")
    elif op == "cylinder":
        out["radius"], out["height"] = number(p.get("radius"), lo, hi, where + ".radius"), number(p.get("height"), lo, hi, where + ".height")
        out["radiusTop"] = number(p.get("radiusTop"), 0, hi, where + ".radiusTop", out["radius"])
        out["bevel"] = number(p.get("bevel"), 0, 10, where + ".bevel", 0.0)
        if out["bevel"] * 2 >= min(out["height"], 2 * min(out["radius"], out["radiusTop"] or out["radius"])):
            fail(where + ".bevel is too large for this cylinder")
    elif op == "sphere":
        out["radius"] = number(p.get("radius"), lo, hi, where + ".radius")
    elif op == "revolve":
        prof = points(p.get("profile"), 2, 2, where + ".profile")
        if any(r < 0 for r, _ in prof):
            fail(where + ".profile radii must be >= 0")
        if all(r == 0 for r, _ in prof):
            fail(where + ".profile needs a nonzero radius")
        out["closed"] = flag(p.get("closed"), where + ".closed")
        if out["closed"] and (len(prof) < 3 or any(r <= 0 for r, _ in prof) or polygon_area(prof) == 0):
            fail(where + " a closed profile needs 3+ points with radius > 0 enclosing an area")
        if not out["closed"] and any(r <= 0 for r, _ in prof[1:-1]):
            fail(where + ".profile interior radii must be > 0 (only the ends may touch the axis)")
        out["profile"] = prof
        out["curve"] = choice(p.get("curve"), CURVES, where + ".curve", "linear")
        out["flutes"] = None
        if p.get("flutes") is not None:
            f = fields(p["flutes"], ("count", "depth", "width", "from", "to"), where + ".flutes")
            out["flutes"] = {"count": integer(f.get("count"), 3, 64, where + ".flutes.count"), "depth": number(f.get("depth"), 0, 1, where + ".flutes.depth"),
                             "width": number(f.get("width"), .02, 1, where + ".flutes.width", .8),
                             "from": number(f.get("from"), -50, 50, where + ".flutes.from", -50.0), "to": number(f.get("to"), -50, 50, where + ".flutes.to", 50.0)}
    elif op == "extrude":
        out["shape"] = shape(p.get("shape"), where + ".shape")
        out["height"] = number(p.get("height"), lo, hi, where + ".height")
        out["bevel"] = number(p.get("bevel"), 0, 10, where + ".bevel", 0.0)
        out["inset"] = None
        if p.get("inset") is not None:
            i = fields(p["inset"], ("width", "depth"), where + ".inset")
            out["inset"] = {"width": number(i.get("width"), lo, hi, where + ".inset.width"), "depth": number(i.get("depth"), -hi, hi, where + ".inset.depth")}
        if out["bevel"] * 2 >= out["height"]:
            fail(where + ".bevel must be less than half the height")
        step = out["bevel"] + (out["inset"]["width"] if out["inset"] else 0.0)
        if out["shape"]["round"] > 0 and step >= out["shape"]["round"]:
            fail(where + ".shape.round must exceed bevel + inset width (or be 0)")
    elif op == "loft":
        raw = p.get("sections")
        if not isinstance(raw, list) or not 2 <= len(raw) <= LIMITS["sections"]:
            fail(where + ".sections needs 2..%d sections" % LIMITS["sections"])
        secs = []
        for k, s in enumerate(raw):
            sw = where + ".sections[%d]" % k
            s = fields(s, ("z", "shape", "at", "scale", "rot"), sw)
            sc = s.get("scale")
            if isinstance(sc, (int, float)) and not isinstance(sc, bool):
                sc = (number(sc, 0, 100, sw + ".scale"),) * 2
            else:
                sc = vec(sc, 2, 0, 100, sw + ".scale", (1, 1))
            secs.append({"z": number(s.get("z"), -c, c, sw + ".z"), "shape": shape(s.get("shape"), sw + ".shape"),
                         "at": vec(s.get("at"), 2, -c, c, sw + ".at", (0, 0)), "scale": sc, "rot": number(s.get("rot"), -720, 720, sw + ".rot", 0.0)})
        if any(b["z"] <= a["z"] for a, b in zip(secs, secs[1:])):
            fail(where + ".sections z must strictly ascend")
        if any(min(s["scale"]) == 0 for s in secs[1:-1]):
            fail(where + " only the first or last section may have scale 0 (a point)")
        out["sections"] = secs
        out["curve"] = choice(p.get("curve"), CURVES, where + ".curve", "linear")
    elif op == "sweep":
        out["path"] = path(p.get("path"), where + ".path")
        out["shape"] = shape(p.get("shape"), where + ".shape")
        out["twist"] = number(p.get("twist"), -3600, 3600, where + ".twist", 0.0)
        out["taper"] = curve_samples(p.get("taper"), where + ".taper")
    else:
        raw = p.get("shapes")
        if not isinstance(raw, list) or not 1 <= len(raw) <= LIMITS["prims"]:
            fail(where + ".shapes needs 1..%d primitives" % LIMITS["prims"])
        out["shapes"] = [prim(s, where + ".shapes[%d]" % k) for k, s in enumerate(raw)]
        if out["shapes"][0]["op"] != "union":
            fail(where + " the first sdf primitive must be a union")
        res = p.get("resolution")
        out["resolution"] = integer(res, 16, 96, where + ".resolution", 0) if res is not None else 0
    return out


def material(value, index):
    where = "materials[%d]" % index
    m = fields(value, ("id", "finish", "color", "roughness", "metallic", "wear", "cavity", "library", "glow", "moss", "age"), where)
    mid = m.get("id")
    if not isinstance(mid, str) or not MATERIAL_ID.match(mid):
        fail(where + ".id must be a lowercase id (a-z, 0-9; up to 16 characters)")
    finish = choice(m.get("finish"), tuple(FINISHES), where + ".finish")
    _, rough, metal, wear, cavity, color = FINISHES[finish]
    return {"id": mid, "finish": finish, "color": vec(m.get("color"), 3, 0, 1, where + ".color", color),
            "roughness": number(m.get("roughness"), 0, 1, where + ".roughness", rough), "metallic": number(m.get("metallic"), 0, 1, where + ".metallic", metal),
            "wear": number(m.get("wear"), 0, 1, where + ".wear", wear), "cavity": number(m.get("cavity"), 0, 1, where + ".cavity", cavity),
            "library": library(m.get("library"), where + ".library"), "glow": number(m.get("glow"), 0, 10, where + ".glow", 0.0),
            # Optional library weathering overrides (model_materials infers them from context otherwise).
            **{k: number(m[k], 0, 1, where + "." + k) for k in ("moss", "age") if m.get(k) is not None}}


def library(value, where):
    # A material library name (workers/blender/materials catalogue); unknown names fall back to the finish bake.
    if value is None:
        return None
    if not isinstance(value, str) or not LIBRARY.match(value):
        fail(where + " must be a library material name such as stone-ashlar")
    return value


CONTEXT_TAG = re.compile(r"^[a-z][a-z0-9-]{0,23}$")


def context(value):
    # Scene/theme tags (outdoor, ancient, swamp, snowy, new...) that steer material inference.
    if not isinstance(value, list) or len(value) > 8 or not all(isinstance(t, str) and CONTEXT_TAG.match(t) for t in value):
        fail("context must be up to 8 lowercase tags such as outdoor or ancient")
    return list(value)


def validate(value):
    """Return the normalized spec (all defaults explicit) or raise SpecError."""
    s = fields(value, ("kind", "finish", "size", "materials", "parts", "pivot", "smoothAngle", "autoDetail", "context"), "spec")
    if s.get("kind") != "spec":
        fail("kind must be spec")
    lo, hi = LIMITS["size"]
    out = {"kind": "spec", "finish": choice(s.get("finish"), ("natural", "flat"), "finish", "natural"),
           "size": vec(s.get("size"), 3, lo, hi, "size"), "pivot": choice(s.get("pivot"), PIVOTS, "pivot", "base"),
           "smoothAngle": number(s.get("smoothAngle"), 0, 180, "smoothAngle", 35.0), "autoDetail": flag(s.get("autoDetail"), "autoDetail", True)}
    if s.get("context") is not None:
        out["context"] = context(s["context"])
    mats = s.get("materials")
    if not isinstance(mats, list) or not 1 <= len(mats) <= LIMITS["materials"]:
        fail("materials needs 1..%d entries" % LIMITS["materials"])
    out["materials"] = [material(m, i) for i, m in enumerate(mats)]
    ids = [m["id"] for m in out["materials"]]
    if len(set(ids)) != len(ids):
        fail("material ids must be unique")
    raw = s.get("parts")
    if not isinstance(raw, list) or not 1 <= len(raw) <= LIMITS["parts"]:
        fail("parts needs 1..%d entries" % LIMITS["parts"])
    parts = [part(p, i, ids) for i, p in enumerate(raw)]
    by = {}
    for p in parts:
        if p["id"] in by:
            fail("part ids must be unique (" + p["id"] + ")")
        by[p["id"]] = p
    for p in parts:
        surface_on = p["surface"].get("on") if isinstance(p["surface"], dict) else None
        for ref, label in [(p["parent"], "parent"), ((p["scatter"] or {}).get("on"), "scatter.on"), (surface_on, "surface.on")] + [(w, "with") for w in p["with"] or []]:
            if ref is not None and ref not in by:
                fail("part " + p["id"] + "." + label + " names an unknown part")
            if ref == p["id"]:
                fail("part " + p["id"] + "." + label + " cannot name itself")
        if p["scatter"] and by[p["scatter"]["on"]]["csg"] in ("subtract", "intersect"):
            fail("part " + p["id"] + " cannot scatter on a cutter")
        if p["csg"] in ("subtract", "intersect") and (p["scatter"] is not None):
            fail("part " + p["id"] + " a cutter cannot scatter")
        if p["scatter"] and (p["array"] or p["radial"] or p["mirror"] or p["csg"]):
            fail("part " + p["id"] + " scatter cannot combine with array, radial, mirror or csg")
    for p in parts:
        seen, cursor = set(), p
        while cursor["parent"] is not None:
            if cursor["id"] in seen:
                fail("part " + p["id"] + " has a parent cycle")
            seen.add(cursor["id"])
            cursor = by[cursor["parent"]]
    used = {p["material"] for p in parts if p["csg"] not in ("subtract", "intersect")}
    for m in ids:
        if m not in used:
            fail("material " + m + " is not used by any solid part")
    if instance_count(parts) > LIMITS["instances"]:
        fail("parts expand to more than %d instances; reduce arrays/scatter" % LIMITS["instances"])
    out["parts"] = parts
    return out


def copies(p):
    n = 1
    if p["array"]:
        a = p["array"]
        n *= a["grid"][0] * a["grid"][1] * a["grid"][2] if a["grid"] else a["count"]
    if p["radial"]:
        n *= p["radial"]["count"]
    if p["mirror"]:
        n *= 2 ** len(p["mirror"])
    return n


def instance_count(parts):
    total = 0
    for p in parts:
        n = copies(p)
        if p["scatter"]:
            n = p["scatter"]["count"]
        total += n
    return total
