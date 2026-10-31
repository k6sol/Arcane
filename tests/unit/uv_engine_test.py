"""General UV engine contract (workers/blender/uv): seams, density, packing, tile mode and metrics
on synthetic meshes, plus the natural-finish procedural stage. Pure Python (numpy optional), no bpy."""
import importlib.util
import json
import math
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
import worker_paths  # noqa: E402,F401  (job layout: every workers/blender subpackage importable flat)
import uv_engine as E  # noqa: E402
import uv_metrics as M  # noqa: E402

spec = importlib.util.spec_from_file_location("arcane_procedural_under_uv", ROOT / "workers" / "blender" / "procedural.py")
procedural = importlib.util.module_from_spec(spec)
spec.loader.exec_module(procedural)


def cube(s=1.0):
    v = [(x, y, z) for z in (0, s) for y in (0, s) for x in (0, s)]
    return v, [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (1, 3, 7, 5), (3, 2, 6, 7), (2, 0, 4, 6)]


def cylinder(r=.5, h=2.0, seg=24, rings=8, caps=True, axis="z"):
    v, f = [], []
    for i in range(rings + 1):
        for j in range(seg):
            t = 2 * math.pi * j / seg
            p = (r * math.cos(t), r * math.sin(t), h * i / rings)
            v.append(p if axis == "z" else (p[2], p[0], p[1] + r))
    for i in range(rings):
        for j in range(seg):
            a, b = i * seg + j, i * seg + (j + 1) % seg
            f.append((a, b, b + seg, a + seg))
    if caps:
        f.append(tuple(reversed(range(seg))))
        f.append(tuple(rings * seg + j for j in range(seg)))
    return v, f


def sphere(n=16, m=12):
    v = [(0, 0, -1)] + [(math.cos(-math.pi / 2 + math.pi * i / m) * math.cos(2 * math.pi * j / n), math.cos(-math.pi / 2 + math.pi * i / m) * math.sin(2 * math.pi * j / n),
                         math.sin(-math.pi / 2 + math.pi * i / m)) for i in range(1, m) for j in range(n)] + [(0, 0, 1)]
    f = [(0, 1 + (j + 1) % n, 1 + j) for j in range(n)]
    f += [(1 + i * n + j, 1 + i * n + (j + 1) % n, 1 + (i + 1) * n + (j + 1) % n, 1 + (i + 1) * n + j) for i in range(m - 2) for j in range(n)]
    f += [(1 + (m - 2) * n + j, 1 + (m - 2) * n + (j + 1) % n, len(v) - 1) for j in range(n)]
    return v, f


def torus(R=1.0, r=.3, n=32, m=12):
    v = [((R + r * math.cos(2 * math.pi * j / m)) * math.cos(2 * math.pi * i / n), (R + r * math.cos(2 * math.pi * j / m)) * math.sin(2 * math.pi * i / n),
          r * math.sin(2 * math.pi * j / m)) for i in range(n) for j in range(m)]
    f = [(i * m + j, ((i + 1) % n) * m + j, ((i + 1) % n) * m + (j + 1) % m, i * m + (j + 1) % m) for i in range(n) for j in range(m)]
    return v, f


def seam_edges(faces, uvs):
    _, edges, seams = M.islands(faces, uvs)
    return seams


class SeamSelection(unittest.TestCase):
    def test_branch_junction_fallback_never_returns_folded_charts(self):
        # A retained boolean branch junction cannot be split by its centroid plane.
        # The former last-resort projection returned four reversed triangles.
        data = json.loads((ROOT / 'tests/fixtures/uv/branch-junction.json').read_text())
        topo = E.Topology(data['vertices'], data['faces'])
        charts = E._split(topo, list(range(len(data['faces']))), E.UP, E.VIEW, 5, frozenset(), .22, 3.0)
        self.assertEqual(sorted(face for chart in charts for face in chart.faces), list(range(len(data['faces']))))
        for chart in charts:
            self.assertEqual(E.chart_quality(topo, chart.faces, chart.uvs)[0], 0)
        self.assertEqual([tuple(point) for point in data['vertices']], topo.vertices)
        self.assertEqual([tuple(face) for face in data['faces']], topo.faces)

    def test_cube_seams_follow_every_feature_edge(self):
        v, f = cube()
        result = E.unwrap(v, f)
        self.assertEqual(result["chartKinds"], {"planar": 6})
        self.assertEqual(len(seam_edges(f, result["uvs"])), 12)

    def test_cylinder_is_one_straight_chart_cut_on_the_least_visible_side(self):
        v, f = cylinder(caps=False)
        result = E.unwrap(v, f)
        self.assertEqual(result["chartKinds"], {"cylindrical": 1})
        seams = seam_edges(f, result["uvs"])
        # One axial cut: every seam edge is vertical (one per ring) ...
        self.assertEqual(len(seams), 8)
        xs = {(round(v[a][0], 6), round(v[a][1], 6)) for a, b in seams} | {(round(v[b][0], 6), round(v[b][1], 6)) for a, b in seams}
        self.assertEqual(len(xs), 1)
        # ... on the side facing away from the review camera (it looks along +Y from -Y).
        x, y = next(iter(xs))
        self.assertLess(-(x * E.VIEW[0] + y * E.VIEW[1]), 0)
        # Straightened rectangle: each ring's v is constant, so strata/bark run level.
        topo = E.Topology(v, f)
        for face, uv in zip(f, result["uvs"]):
            for (i, a), (j, b) in zip(enumerate(face), list(enumerate(face))[1:] + list(enumerate(face))[:1]):
                if abs(v[a][2] - v[b][2]) < 1e-9:
                    self.assertAlmostEqual(uv[i][1], uv[j][1], places=6)
        self.assertEqual(len(topo.faces), len(result["uvs"]))

    def test_lying_cylinder_cuts_underneath(self):
        v, f = cylinder(caps=False, axis="x")
        result = E.unwrap(v, f)
        seams = seam_edges(f, result["uvs"])
        self.assertTrue(seams)
        self.assertTrue(all(v[a][2] < .1 and v[b][2] < .1 for a, b in seams), "seam runs along the underside")

    def test_material_boundaries_are_seams(self):
        v, f = cylinder(caps=False)
        labels = [0 if i < len(f) // 2 else 1 for i in range(len(f))]
        result = E.unwrap(v, f, labels)
        seams = seam_edges(f, result["uvs"])
        boundary = {tuple(sorted((f[i][k], f[i][(k + 1) % 4]))) for i in range(len(f) // 2) for k in range(4)} & \
                   {tuple(sorted((f[i][k], f[i][(k + 1) % 4]))) for i in range(len(f) // 2, len(f)) for k in range(4)}
        self.assertTrue(boundary <= seams)

    def test_closed_and_genus_one_surfaces_become_flat_disks(self):
        for v, f in (sphere(), torus()):
            result = E.unwrap(v, f)
            topo = E.Topology(v, f)
            for faces in result["chartFaces"]:
                chart = E.ChartMesh(topo, faces, seam_edges(f, result["uvs"]))
                self.assertTrue(chart.is_disk() or len(faces) == 1)
            rep = M.report(v, f, result["uvs"], "unique")
            self.assertEqual(rep["errors"], [])
            # ARAP trades a little angle for even density on the cut torus.
            self.assertLess(rep["angleDistortion"], .2)
            self.assertLess(rep["densityCV"], .1)

    def test_annulus_cut_joins_its_two_boundaries(self):
        v, f = cylinder(caps=False)
        topo = E.Topology(v, f)
        chart = E.ChartMesh(topo, list(range(len(f))))
        self.assertEqual(len(chart.boundary_loops()), 2)
        cuts = E.cut_annulus(topo, chart, E.UP, E.unit(E.VIEW))
        self.assertTrue(E.ChartMesh(topo, list(range(len(f))), cuts).is_disk())


class DensityAndPacking(unittest.TestCase):
    def test_every_chart_has_the_same_texel_density(self):
        v, f = cylinder()
        rep = M.report(v, f, E.unwrap(v, f)["uvs"], "unique")
        self.assertLess(rep["densityCV"], .02)
        self.assertLess(rep["islandDensityRatio"], 1.03)

    def test_packing_is_inside_the_unit_square_with_scaled_padding(self):
        v, f = sphere()
        for size in (256, 512, 1024):
            result = E.unwrap(v, f, texture_size=size)
            self.assertEqual(result["paddingPx"], E.padding_px(size))
            rep = M.report(v, f, result["uvs"], "unique", size)
            self.assertEqual(rep["overlapFaces"], 0)
            self.assertGreaterEqual(rep["islandGapPx"], E.padding_px(size) - 1.5)
            self.assertGreaterEqual(rep["borderPx"], .5)
            self.assertGreater(rep["utilization"], .45)
        self.assertEqual([2, 4, 8], [E.padding_px(s) for s in (256, 512, 1024)])

    def test_target_density_and_per_material_equalisation(self):
        v, f = cube()
        capped = E.unwrap(v, f, texture_size=512, target_ppm=100)
        self.assertAlmostEqual(capped["texelsPerMetre"], 100, places=6)
        parts = [(v, f, None, 512, {}), (*cylinder(), None, 256, {})]
        a, b = E.equalize(parts)
        self.assertAlmostEqual(a["texelsPerMetre"], b["texelsPerMetre"], places=6)
        for (vv, ff, _, size, _), res in zip(parts, (a, b)):
            self.assertAlmostEqual(M.report(vv, ff, res["uvs"], "unique", size)["texelsPerMetre"], res["texelsPerMetre"], delta=.01 * res["texelsPerMetre"])

    def test_unwrap_is_deterministic(self):
        v, f = torus()
        self.assertEqual(E.unwrap(v, f)["uvs"], E.unwrap(v, f)["uvs"])


class TileMode(unittest.TestCase):
    def test_world_scale_repeats_wrap_a_cylinder_without_a_visible_seam(self):
        v, f = cylinder(r=.5, h=2.0, caps=False)
        result = E.unwrap(v, f, mode="tile", tile_m=1.0, texture_size=512)
        rep = M.report(v, f, result["uvs"], "periodic", 512)
        self.assertEqual(rep["errors"], [])
        self.assertLess(rep["angleDistortion"], .06)
        self.assertAlmostEqual(rep["texelsPerMetre"], 512 * 3 / (2 * math.pi * .5 * math.cos(math.pi / 24)), delta=25)
        # Each column of faces ends on a whole repeat: u is 0 or 1 at every repeat boundary.
        for uv in result["uvs"]:
            self.assertTrue(all(-1e-9 <= c <= 1 + 1e-9 for p in uv for c in p))

    def test_planar_architecture_keeps_world_scale_and_level_v(self):
        v, f = cube(.8)
        result = E.unwrap(v, f, mode="tile", tile_m=1.0, texture_size=256)
        for face, uv in zip(f, result["uvs"]):
            for (i, a), (j, b) in zip(enumerate(face), list(enumerate(face))[1:] + list(enumerate(face))[:1]):
                d3, d2 = math.dist(v[a], v[b]), math.dist(uv[i], uv[j])
                self.assertAlmostEqual(d2, d3, places=6)


class Metrics(unittest.TestCase):
    QUAD = ([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], [(0, 1, 2), (0, 2, 3)])

    def test_isometric_quad_is_clean(self):
        v, f = self.QUAD
        rep = M.measure(v, f, [((.1, .1), (.6, .1), (.6, .6)), ((.1, .1), (.6, .6), (.1, .6))], texture_size=512)
        self.assertAlmostEqual(rep["angleDistortion"], 0, places=6)
        self.assertAlmostEqual(rep["texelsPerMetre"], 256, places=4)
        self.assertEqual((rep["flippedFaces"], rep["overlapFaces"], rep["islands"]), (0, 0, 1))
        self.assertAlmostEqual(rep["utilization"], .25, delta=.01)
        self.assertEqual(rep["seamRatio"], 0)

    def test_stretch_flip_overlap_and_padding_are_detected(self):
        v, f = self.QUAD
        stretched = M.measure(v, f, [((0, 0), (.5, 0), (.5, .25)), ((0, 0), (.5, .25), (0, .25))])
        self.assertAlmostEqual(stretched["angleDistortion"], 1.0, places=6)
        self.assertAlmostEqual(M.measure(v, f, [((0, 0), (.5, 0), (.5, .25)), ((0, 0), (.5, .25), (0, .25))], texel_aspect=.5)["angleDistortion"], 0, places=6)
        folded = M.measure(v, f, [((.1, .1), (.6, .1), (.6, .6)), ((.1, .1), (.6, .6), (.6, .1))])
        self.assertEqual(folded["foldedFaces"], 1)
        self.assertGreater(folded["overlapFaces"], 0)
        mirrored = M.measure(v, f, [((.6, .1), (.1, .1), (.1, .6)), ((.6, .1), (.1, .6), (.6, .6))])
        self.assertEqual((mirrored["foldedFaces"], mirrored["mirroredFaces"]), (0, 2))
        # Two islands with no empty texel between them (at 512 px) fail the 1 px gap rule.
        apart = M.report(v, f, [((.1, .1), (.5, .1), (.5, .5)), ((.5005, .1), (.9, .5), (.5005, .5))], "unique")
        self.assertTrue(any("islandGapPx" in e for e in apart["errors"]))

    def test_intents_gate_errors_differently(self):
        v, f = self.QUAD
        overlap = [((.1, .1), (.6, .1), (.6, .6)), ((.1, .1), (.6, .1), (.6, .6))]
        self.assertTrue(M.report(v, f, overlap, "unique")["errors"])
        self.assertEqual(M.report(v, f, overlap, "atlas")["errors"], [])

    def test_concave_ngons_are_ear_clipped_not_fanned(self):
        # An L-shaped boolean face: a fan from corner 0 would cover the notch and fold.
        v = [(0, 0, 0), (2, 0, 0), (2, 1, 0), (1, 1, 0), (1, 2, 0), (0, 2, 0)]
        f = [(1, 2, 3, 4, 5, 0)]
        tris = E.ear_clip([v[i] for i in f[0]])
        self.assertEqual(len(tris), 4)
        self.assertAlmostEqual(sum(E.Topology([v[i] for i in f[0]], [(0, 1, 2)]).areas[0] * 0 + abs(
            (v[f[0][b]][0] - v[f[0][a]][0]) * (v[f[0][c]][1] - v[f[0][a]][1]) - (v[f[0][c]][0] - v[f[0][a]][0]) * (v[f[0][b]][1] - v[f[0][a]][1])) / 2
            for a, b, c in tris), 3.0)
        result = E.unwrap(v, f)
        rep = M.report(v, f, result["uvs"], "unique")
        self.assertEqual((rep["flippedFaces"], rep["overlapFaces"]), (0, 0))
        self.assertAlmostEqual(rep["densityCV"], 0, places=6)

    def test_seam_ratio_counts_only_differing_uvs(self):
        v, f = cube()
        rep = M.report(v, f, E.unwrap(v, f)["uvs"], "unique")
        self.assertEqual(rep["seamRatio"], 1.0)
        self.assertEqual(rep["smoothSeamRatio"], 0.0)


class ProceduralStage(unittest.TestCase):
    def request(self, params):
        return {"name": "uv", "procedural": params, "seed": 31, "triangleBudget": 16000, "color": [.4, .38, .35]}

    def test_natural_column_is_engine_unwrapped_and_passes(self):
        params = {"kind": "column", "radius": .35, "height": 4, "flutes": 20, "base": "attic", "capital": "corinthian", "finish": "natural"}
        (key, _, mesh), = procedural.plan(self.request(params))
        self.assertEqual(mesh.uv_report, {"intent": "periodic", "textureSize": 256, "engine": True})
        rep = M.report(mesh.vertices, mesh.faces, mesh.uvs, "periodic", 256)
        self.assertEqual(rep["errors"], [])
        self.assertLess(rep["angleDistortion"], .1)
        self.assertLess(rep["densityCV"], .1)

    def test_authored_generators_keep_their_uvs_and_legacy_requests_skip_the_stage(self):
        rock = {"kind": "rock", "size": [1.6, 1.2, .9], "roughness": .7}
        legacy = procedural.plan(self.request(rock))[0][2]
        natural = procedural.plan(self.request({**rock, "finish": "natural"}))[0][2]
        self.assertIsNone(legacy.uv_report)
        self.assertEqual(natural.uv_report["intent"], "tiled")
        self.assertEqual(natural.uvs, legacy.uvs, "authored rock UVs are untouched by the stage")
        column = {"kind": "column", "radius": .35, "height": 4, "flutes": 20, "base": "attic", "capital": "corinthian"}
        self.assertIsNone(procedural.plan(self.request(column))[0][2].uv_report)


def plank(v, f, size, centre, n=6, tilt=0.0):
    """Closed box subdivided along x (a plank), optionally tilted about y."""
    sx, sy, sz = size
    base = len(v)
    ring = [(-sy / 2, -sz / 2), (sy / 2, -sz / 2), (sy / 2, sz / 2), (-sy / 2, sz / 2)]
    c, s = math.cos(tilt), math.sin(tilt)
    for i in range(n + 1):
        x = -sx / 2 + sx * i / n
        for y, z in ring:
            v.append((centre[0] + x * c - z * s, centre[1] + y, centre[2] + x * s + z * c))
    for i in range(n):
        for k in range(4):
            a, b = base + 4 * i + k, base + 4 * i + (k + 1) % 4
            f.append((a, b, b + 4, a + 4))
    f.append(tuple(base + k for k in (3, 2, 1, 0)))
    f.append(tuple(base + 4 * n + k for k in range(4)))


def crate():
    v, f = [], []
    for side in (-1, 1):
        for row in range(3):
            plank(v, f, (.74, .022, .24), (0, side * .39, .15 + .25 * row))
        plank(v, f, (.9, .022, .06), (0, side * .41, .4), tilt=math.radians(40))
    for k in range(8):
        plank(v, f, (.74, .06, .06), (0, -.3 + .085 * k, .78))
    return v, f


class ManyPartAtlas(unittest.TestCase):
    def test_many_small_planks_pack_densely(self):
        # Thin plank edges fold onto their faces and short strips pack whole (no padding ring per
        # cut piece); diagonal braces lie along u. The cut-every-strip layout filled 0.54 here.
        v, f = crate()
        r = E.unwrap(v, f, texture_size=512, mode="atlas")
        q = M.report(v, f, r["uvs"], "unique", 512)
        self.assertEqual(q["errors"], [])
        self.assertGreaterEqual(q["utilization"], .58)
        self.assertLessEqual(r["charts"], 120)
        self.assertEqual(r["uvs"], E.unwrap(v, f, texture_size=512, mode="atlas")["uvs"])  # deterministic


class BlenderAdapterContract(unittest.TestCase):
    def test_unwrap_blender_mesh_keeps_no_uv_layer_reference_across_operators(self):
        # A UV layer (or its data) held in a frame across an edit-mode round trip goes stale; freeing
        # it later (an exception traceback, a closure) crashed Blender with pack="best". UVs are read
        # and written by layer name through foreach_get/foreach_set helpers only.
        import ast
        source = (ROOT / "workers" / "blender" / "uv" / "uv_stage.py").read_text(encoding="utf-8")
        fn = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == "unwrap_blender_mesh")
        names = {n.attr for n in ast.walk(fn) if isinstance(n, ast.Attribute)}
        self.assertNotIn("uv_layers", names)
        self.assertNotIn("data", {n.attr for n in ast.walk(fn) if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id != "obj"})
        self.assertIn("view_layer", names)  # objects outside the view layer keep the engine packing


if __name__ == "__main__":
    unittest.main()
