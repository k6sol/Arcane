"""Automatic material choice for model spec slots: pick a material-library family and its
weathering when the spec does not name one, so an unannotated spec still bakes rich surfaces.

Pure (no bpy, no NumPy). ``infer(spec, raw, name)`` returns one entry per material:

    {"material": "granite", "library": "stone-ashlar", "source": "inferred", "frame": "box",
     "params": {"wear": .32, "dirt": .4, "moss": .14, "age": .0, "scale": .96, "color"?: [...]},
     "reasons": ["finish stone", "large masonry faces (>= 1.2 m)", ...]}

Evidence, strongest first: the material id (granite, oak, brass...), the ids of the parts that use
it (hoop, plank, blade...), the asset name, the spec's ``context`` tags, then the finish and the
part geometry (large masonry faces, revolved staves, thin planks, metal colour). Weathering comes
from context: an age level (new 0, default 1, old 2, ancient 3) and an exposure (outdoor, neutral,
indoor; wet or dry; snowy). Explicit choices always win: ``library`` (a family, or "none" for the
plain finish bake), and ``wear``/``cavity``/``moss``/``age``/``color`` written in the raw spec.
A learned-preference module (``preferences.materialBias``), when shipped, can bias the family
scores and nudge parameters; without it the result is the deterministic rules alone.
"""
import re

from model_spec import FINISHES as FINISH_DEFAULTS

# finish -> families it may become (first is the fallback when nothing else scores).
FAMILIES = {
    "wood": ("wood-planks", "wood-weathered", "wood-painted", "wood-endgrain"),
    "stone": ("stone-sandstone", "stone-ashlar", "stone-marble", "stone-cobble", "stone-slate", "concrete", "brick"),
    "plaster": ("concrete", "stone-sandstone"),
    "metal": ("metal-iron", "metal-steel", "metal-brass", "metal-gold", "metal-rusted"),
    "leather": ("leather",),
    "fabric": ("fabric",),
    "ceramic": ("ceramic",),
    "glass": (),     # stylised finish glass (rim + streaks + glow) reads better than the library glass
    "plastic": (),   # no library family: finish bake
}
# word -> (family, weight). Stems: a trailing "s"/"es" is dropped before lookup.
WORDS = {
    "granite": ("stone-sandstone", .3), "stone": ("stone-sandstone", .2), "rock": ("stone-sandstone", .2), "boulder": ("stone-sandstone", .3),
    "masonry": ("stone-ashlar", 1.2), "ashlar": ("stone-ashlar", 2.0), "block": ("stone-ashlar", .6), "wall": ("stone-ashlar", .5),
    "marble": ("stone-marble", 2.0), "alabaster": ("stone-marble", 1.5), "sandstone": ("stone-sandstone", 2.0), "limestone": ("stone-sandstone", 1.5),
    "slate": ("stone-slate", 2.0), "shale": ("stone-slate", 1.2), "basalt": ("stone-slate", 1.2), "cobble": ("stone-cobble", 2.0),
    "cobblestone": ("stone-cobble", 2.0), "pebble": ("stone-cobble", 1.2), "concrete": ("concrete", 2.0), "cement": ("concrete", 2.0),
    "plaster": ("concrete", 1.0), "stucco": ("concrete", 1.0), "brick": ("brick", 2.0), "terracotta": ("brick", 1.0),
    "oak": ("wood-planks", 1.5), "pine": ("wood-planks", 1.5), "teak": ("wood-planks", 1.5), "walnut": ("wood-planks", 1.5), "birch": ("wood-planks", 1.5),
    "maple": ("wood-planks", 1.5), "cedar": ("wood-planks", 1.5), "wood": ("wood-planks", 1.0), "timber": ("wood-planks", 1.0), "plank": ("wood-planks", 1.2),
    "board": ("wood-planks", .8), "stave": ("wood-planks", 1.0), "slat": ("wood-planks", .8), "beam": ("wood-planks", .6),
    "driftwood": ("wood-weathered", 2.0), "weathered": ("wood-weathered", 1.0), "rotten": ("wood-weathered", 1.5), "painted": ("wood-painted", 2.0),
    "endgrain": ("wood-endgrain", 2.0), "stump": ("wood-endgrain", 1.2), "log": ("wood-endgrain", .4),
    "iron": ("metal-iron", 1.5), "wrought": ("metal-iron", 1.0), "cast": ("metal-iron", .4), "hoop": ("metal-iron", 1.0), "band": ("metal-iron", .8),
    "nail": ("metal-iron", .6), "rivet": ("metal-iron", .6), "hinge": ("metal-iron", .8), "chain": ("metal-iron", .8), "strap": ("metal-iron", .4),
    "rust": ("metal-rusted", 2.0), "rusty": ("metal-rusted", 2.0), "rusted": ("metal-rusted", 2.0), "corroded": ("metal-rusted", 1.5),
    "steel": ("metal-steel", 1.5), "blade": ("metal-steel", 1.0), "silver": ("metal-steel", 1.2), "chrome": ("metal-steel", 1.5), "tin": ("metal-steel", 1.0),
    "aluminium": ("metal-steel", 1.5), "aluminum": ("metal-steel", 1.5), "pewter": ("metal-steel", 1.2),
    "brass": ("metal-brass", 2.0), "bronze": ("metal-brass", 1.8), "copper": ("metal-brass", 1.5),
    "gold": ("metal-gold", 2.0), "golden": ("metal-gold", 2.0), "gilded": ("metal-gold", 1.8), "gilt": ("metal-gold", 1.8),
    "leather": ("leather", 2.0), "hide": ("leather", 1.5), "grip": ("leather", .6),
    "cloth": ("fabric", 2.0), "fabric": ("fabric", 2.0), "canvas": ("fabric", 2.0), "linen": ("fabric", 2.0), "wool": ("fabric", 2.0), "rope": ("fabric", 1.0),
    "cushion": ("fabric", 1.0), "rug": ("fabric", 1.0), "banner": ("fabric", 1.0),
    "ceramic": ("ceramic", 2.0), "clay": ("ceramic", 1.5), "pottery": ("ceramic", 2.0), "porcelain": ("ceramic", 2.0), "tile": ("ceramic", .8),
}
# Context vocabulary. Age levels: the highest named level wins; "new" words lower it to 0.
NEW = {"new", "pristine", "clean", "polished", "modern", "fresh", "shiny", "brand", "freshly", "factory", "royal", "ornate"}
OLD = {"old", "weathered", "rustic", "worn", "aged", "medieval", "abandoned", "rusty", "battered", "used", "shabby", "dusty", "farm", "village"}
ANCIENT = {"ancient", "ruined", "ruin", "overgrown", "forgotten", "crumbling", "derelict", "sunken", "haunted", "temple", "tomb", "relic"}
OUTDOOR = {"outdoor", "outside", "exterior", "garden", "park", "forest", "jungle", "swamp", "village", "town", "street", "courtyard", "plaza",
           "graveyard", "cemetery", "ruin", "ruined", "coast", "coastal", "beach", "field", "meadow", "mountain", "camp", "dock", "harbor", "harbour",
           "yard", "farm", "road", "path", "temple", "overgrown"}
OUTDOOR_OBJECTS = {"arch", "archway", "fountain", "bench", "well", "gate", "statue", "column", "pillar", "fence", "bridge", "tomb", "gravestone",
                   "headstone", "obelisk", "shrine", "monument", "signpost", "mailbox", "lamppost", "streetlamp", "cart", "trough", "planter", "birdbath",
                   "bollard", "milestone", "altar", "aqueduct", "lighthouse"}
INDOOR = {"indoor", "interior", "inside", "room", "house", "tavern", "inn", "shop", "library", "kitchen", "office", "bedroom", "hall", "throne",
          "dungeon", "cellar", "crypt", "vault", "castle"}
WET = {"swamp", "jungle", "forest", "rain", "rainy", "coast", "coastal", "beach", "sunken", "damp", "dungeon", "sewer", "overgrown", "mossy",
       "cave", "cellar", "crypt", "marsh", "bog", "river", "lake", "waterfall", "fountain", "well"}
DRY = {"desert", "sand", "sandy", "arid", "dry", "dune", "canyon", "wasteland"}
SNOW = {"snow", "snowy", "winter", "arctic", "frozen", "icy", "tundra", "alpine"}
MOSSY = {"stone", "concrete", "brick", "wood"}  # family prefixes that grow moss
# Mean colour multiplier a family's own palette applies; an inferred family is given colour / tint so
# the baked mean matches the spec colour (grey granite stays grey in the sandstone bake).
AGED = {"wood-planks": "wood-weathered", "metal-iron": "metal-rusted"}
PLANKED = ("wood-planks", "wood-weathered", "wood-painted")
TINT = {"stone-sandstone": (1.012, .894, .76)}
TAG = re.compile(r"^[a-z][a-z0-9-]{0,23}$")


def tokens(text):
    out = []
    for word in re.split(r"[^a-z]+", str(text or "").lower()):
        if len(word) < 2:
            continue
        out.append(word)
        if word.endswith("es") and len(word) > 4 and word[:-2] in WORDS:
            out.append(word[:-2])
        elif word.endswith("s") and len(word) > 3:
            out.append(word[:-1])
    return out


def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, float(x)))


def r3(x):
    return round(float(x), 3)


def context_of(spec, raw, name):
    """Tags (spec context + asset name words) -> age level, exposure, wet/dry/snow and the words used."""
    tags = [t for t in (raw or {}).get("context") or spec.get("context") or [] if isinstance(t, str)]
    words = set()
    for t in tags:
        words.update(tokens(t))
    named = set(tokens(name))
    level, why = 1, []
    if words & ANCIENT or named & ANCIENT:
        level = 3
        why.append("ancient (" + sorted((words | named) & ANCIENT)[0] + ")")
    elif words & OLD or named & OLD:
        level = 2
        why.append("old (" + sorted((words | named) & OLD)[0] + ")")
    elif words & NEW or named & NEW:
        level = 0
        why.append("new (" + sorted((words | named) & NEW)[0] + ")")
    if words & INDOOR and not words & OUTDOOR:
        exposure = "indoor"
    elif words & OUTDOOR or named & (OUTDOOR | OUTDOOR_OBJECTS):
        exposure = "outdoor"
    else:
        exposure = "neutral"
    every = words | named
    return {"tags": tags, "age": level, "exposure": exposure, "wet": bool(every & WET) and not every & DRY,
            "dry": bool(every & DRY), "snow": bool(every & SNOW), "why": why}


def geometry_of(spec, mid):
    """Shape evidence for the parts that use material ``mid``."""
    parts = [p for p in spec["parts"] if p.get("material") == mid and p.get("csg") not in ("subtract", "intersect")]
    ops = [p["op"] for p in parts]
    boxes = [sorted(p["size"]) for p in parts if p["op"] == "box" and p.get("size")]
    big_face = any(b[1] >= 1.2 for b in boxes)
    planks = sum(1 for b in boxes if b[2] > 0 and b[0] / b[2] < .12 and b[2] >= .2)
    revolve = [p for p in parts if p["op"] == "revolve"]
    turned = (len(revolve) + sum(1 for p in parts if p["op"] in ("cylinder", "lathe"))) / max(1, len(parts))
    return {"parts": parts, "ops": ops, "bigFace": big_face, "planks": planks, "revolve": revolve, "turned": turned}


def luminance(c):
    return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]


def score(m, raw_m, spec, name, ctx, geo, masonry=False):
    finish = m["finish"]
    allowed = FAMILIES.get(finish, ())
    if not allowed:
        return None, [], {}
    scores = {f: 0.0 for f in allowed}
    scores[allowed[0]] += .5
    reasons = ["finish " + finish]

    def hit(words, weight, label):
        for w in words:
            fam = WORDS.get(w)
            if fam and fam[0] in scores:
                scores[fam[0]] += fam[1] * weight
                reasons.append("%s '%s'" % (label, w))
    hit(tokens(m["id"]), 4.0, "material")
    for p in geo["parts"][:24]:
        hit(tokens(p["id"]), 1.0, "part")
    hit(tokens(name), .8, "name")
    hit([w for t in ctx["tags"] for w in tokens(t)], .6, "context")
    color = m["color"]
    if finish == "stone":
        if geo["bigFace"] and masonry:
            scores["stone-sandstone"] += 1.0
            reasons.append("geometric masonry blocks already cut: blockless stone, tone per block")
        elif geo["bigFace"]:
            scores["stone-ashlar"] += 2.4
            reasons.append("large masonry faces (>= 1.2 m)")
        if geo["turned"] >= .5 and luminance(color) > .45:
            scores["stone-marble"] += 1.4
            reasons.append("light turned stone")
        if ctx["age"] >= 2 and ctx["exposure"] == "outdoor" and not geo["bigFace"]:
            scores["stone-sandstone"] += .3
    elif finish == "wood":
        if geo["planks"]:
            scores["wood-planks"] += .6
            reasons.append("%d plank-shaped part(s)" % geo["planks"])
    elif finish == "metal":
        lum = luminance(color)
        warm = color[0] > color[2] * 1.8 and color[0] > .25
        if warm:
            sat = (max(color) - min(color)) / max(max(color), 1e-6)
            fam = "metal-gold" if color[0] > .7 and sat > .6 else "metal-brass"
            scores[fam] += 1.5
            reasons.append("warm metal colour")
        elif lum > .3:
            scores["metal-steel"] += 1.2
            reasons.append("bright metal colour")
        else:
            scores["metal-iron"] += 1.0
            reasons.append("dark metal colour")
    return scores, reasons, {}


def preference_bias(entry, ctx):
    """Learned-preference hook: ``preferences.materialBias(query)`` -> {"families": {name: delta},
    "params": {name: delta}} or None. Absent or failing modules leave the rules untouched."""
    try:
        import preferences  # noqa: F401  (optional; shipped by the learning module when present)
    except Exception:
        return None
    fn = getattr(preferences, "materialBias", None)
    if not callable(fn):
        return None
    try:
        out = fn({"material": entry["material"], "finish": entry["finish"], "tags": list(ctx["tags"]),
                  "candidates": dict(entry["_scores"])})
    except Exception:
        return None
    return out if isinstance(out, dict) else None


def weathering(family, ctx, span):
    lvl = ctx["age"]
    wear = (.12, .32, .48, .62)[lvl]
    dirt = (.1, .35, .5, .62)[lvl] + (.05 if ctx["exposure"] == "outdoor" else 0) + (.06 if ctx["dry"] else 0)
    if family in ("metal-gold", "metal-steel"):
        dirt *= .5
    if family == "stone-marble":
        dirt *= .85
    if family == "leather":
        wear *= 1.1
    moss = 0.0
    if any(family.startswith(p) for p in MOSSY) and not ctx["dry"] and not ctx["snow"]:
        if ctx["exposure"] == "outdoor":
            moss = (0, .16, .3, .48)[lvl] + (.12 if ctx["wet"] else 0)
        elif ctx["exposure"] == "neutral":
            moss = (0, 0, .05, .15)[lvl] + (.08 if ctx["wet"] and lvl else 0)
        elif ctx["wet"]:
            moss = .04 * lvl
        if family.startswith("wood"):
            moss *= .55
        if family in ("stone-marble", "wood-painted"):
            moss *= .7
    age = (0, .1, .28, .5)[lvl] + (.05 if ctx["exposure"] == "outdoor" and family.startswith("metal") and lvl else 0)
    params = {"wear": r3(clamp(wear)), "dirt": r3(clamp(dirt)), "moss": r3(clamp(moss)), "age": r3(clamp(age))}
    if ctx["snow"] and ctx["exposure"] != "indoor":
        params["snow"] = .45
    # Feature size follows the object: planks and blocks in proportion to a prop, not a building.
    if family == "stone-ashlar":
        params["scale"] = r3(clamp(span / 3.5, .5, 1.2))
    else:
        params["scale"] = r3(clamp(.4 + .25 * span, .45, 1.1))
    return params


def frame_of(family, geo):
    if family.startswith("wood"):
        if geo["revolve"]:
            p = geo["revolve"][0]
            rot = p.get("rot") or [0, 0, 0]
            if abs(rot[0]) < 1e-6 and abs(rot[1]) < 1e-6:
                return "axis", {"axis": [0, 0, 1], "centre": [r3(c) for c in (p.get("at") or [0, 0, 0])[:2]] + [0.0]}
        return "parts", {}
    if family in ("leather", "metal-steel", "fabric"):
        return "parts", {}
    return "box", {}


def infer(spec, raw=None, name="", masonry=()):
    """One entry per spec material (see module doc). ``spec`` is the normalized spec, ``raw`` the
    request's spec as written (to tell explicit fields from defaults), ``masonry`` the material ids
    whose boxes the detail pass already cut into geometric blocks."""
    raw = raw if isinstance(raw, dict) else {}
    raw_mats = {m.get("id"): m for m in raw.get("materials") or [] if isinstance(m, dict)}
    ctx = context_of(spec, raw, name)
    span = max(spec["size"])
    out = []
    for m in spec["materials"]:
        raw_m = raw_mats.get(m["id"], {})
        geo = geometry_of(spec, m["id"])
        bias = None
        entry = {"material": m["id"], "finish": m["finish"], "library": None, "source": "finish", "frame": "box", "params": {}, "reasons": []}
        explicit = raw_m.get("library")
        if explicit == "none":
            entry.update(source="explicit", reasons=["library none: plain finish bake"])
            out.append(entry)
            continue
        if explicit:
            family, entry["source"] = explicit, "explicit"
            entry["reasons"] = ["library named in the spec"]
        else:
            scores, reasons, _ = score(m, raw_m, spec, name, ctx, geo, m["id"] in masonry)
            if not scores:
                entry["reasons"] = ["finish %s keeps its stylised finish bake" % m["finish"]]
                out.append(entry)
                continue
            entry["_scores"] = scores
            bias = preference_bias(entry, ctx)
            if bias and isinstance(bias.get("families"), dict):
                for fam, delta in bias["families"].items():
                    if fam in scores and isinstance(delta, (int, float)):
                        scores[fam] += max(-20.0, min(20.0, float(delta)))
                reasons.append("learned preference")
            order = FAMILIES[m["finish"]]
            family = max(order, key=lambda f: (round(scores[f], 6), -order.index(f)))
            # Age upgrades the plain family: ancient (or old, wet and outdoor) planks weather, dark iron rusts.
            aged = ctx["age"] >= 3 or (ctx["age"] >= 2 and ctx["wet"] and ctx["exposure"] != "indoor")
            if aged and family in AGED and not (bias and isinstance(bias.get("families"), dict)):
                family = AGED[family]
                reasons.append("aged by context: " + family)
            entry.update(source="inferred", reasons=list(dict.fromkeys(reasons))[:8])
            entry.pop("_scores", None)
        entry["library"] = family
        params = weathering(family, ctx, span)
        bias_params = (bias or {}).get("params")
        if isinstance(bias_params, dict):
            for k, delta in bias_params.items():
                if k in ("wear", "dirt", "moss", "age") and isinstance(delta, (int, float)):
                    params[k] = r3(clamp(params[k] + max(-.3, min(.3, float(delta)))))
        # Explicit numbers in the raw spec win over context defaults. The host's canonical spec
        # writes the finish defaults out, so a value equal to its finish default counts as unset.
        _, _, _, d_wear, d_cavity, d_color = FINISH_DEFAULTS[m["finish"]]
        for key, target, default in (("wear", "wear", d_wear), ("cavity", "dirt", d_cavity), ("moss", "moss", None), ("age", "age", None)):
            v = raw_m.get(key)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and (default is None or abs(v - default) > 1e-9):
                params[target] = r3(clamp(v))
        color = raw_m.get("color")
        if isinstance(color, list) and len(color) == 3 and all(abs(a - b) < 1e-9 for a, b in zip(color, d_color)):
            color = None
        if isinstance(color, list) and len(color) == 3:
            if family.startswith("metal") and luminance(m["color"]) < .2 and not explicit:
                entry["reasons"].append("spec colour too dark for metal reflectance: family colour used")
            elif family in TINT and not explicit:
                params["color"] = [r3(clamp(c / t)) for c, t in zip(m["color"], TINT[family])]
                entry["reasons"].append("colour compensated for the family's warm strata tint")
            else:
                params["color"] = [r3(c) for c in m["color"]]
        elif explicit:
            params["color"] = [r3(c) for c in m["color"]]
        entry["params"] = params
        frame, extra = frame_of(family, geo)
        if family in PLANKED and not explicit:
            # Geometry already cuts the planks or staves: no painted plank ends or board seams on top.
            if frame == "axis" or geo["planks"]:
                params["joints"] = 0.0
                entry["reasons"].append("planks/staves are geometry: painted plank joints off")
            if frame == "parts" and geo["planks"]:
                params["seams"] = 0.0
        entry["frame"] = frame
        entry.update(extra)
        out.append(entry)
    for e in out:
        e.pop("_scores", None)
    return {"context": {k: ctx[k] for k in ("tags", "age", "exposure", "wet", "dry", "snow")}, "contextReasons": ctx["why"], "materials": out}
