"""Production-selected station fidelity; pure geometry, no native/art acceptance.

The inspected9m/seed31 oak previously emitted59 axes, including33 tertiary
branches. Its largest tertiary station-chord error was18.186mm (1.184 nominal
radii). These tests use independent corresponding-chord measurements and actual
tube inputs; they do not replace the allocator or assert a universal error bound.
"""
import collections
import copy
import importlib.util
import math
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
import worker_paths  # noqa: E402,F401

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("arcane_wood_fidelity", ROOT / "workers/blender/procedural.py")
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)

REQUEST = {"template":"procedural","name":"station-fidelity","seed":31,"triangleBudget":16000,"color":[.22,.18,.14],
           "procedural":{"kind":"tree","species":"oak","height":9,"trunkTaper":.55,"branchLevels":3,
                         "leafDensity":.7,"trunkRadius":None,"secondaryColor":[.12,.25,.06],"finish":"natural"}}
# Original measured5ad/8f allocator identity, not merely a minimum branch count.
EMITTED_IDS = (0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,
               33,34,36,38,39,40,42,43,45,47,49,50,51,53,54,56,60,61,62,63,64,65,66,69,70,71,72)


def measured_error(axis, stations, scale):
    """Independent vertex maximum on matching source-arc intervals, not nearest other branches."""
    points = axis["points"][:axis["woodCount"]]
    cumulative = [0.]
    for a, b in zip(points, points[1:]):
        cumulative.append(cumulative[-1] + math.dist(a, b))
    segment, distance, ratio = 0, 0., 0.
    for i, point in enumerate(points):
        while segment + 1 < len(stations) - 1 and stations[segment + 1][0] < cumulative[i]:
            segment += 1
        a, b = stations[segment][1], stations[segment + 1][1]
        delta = tuple(y - x for x, y in zip(a, b))
        projection = sum((p - x) * d for p, x, d in zip(point, a, delta)) / sum(d * d for d in delta)
        nearest = tuple(x + min(1., max(0., projection)) * d for x, d in zip(a, delta))
        error = math.dist(point, nearest)
        distance, ratio = max(distance, error * scale), max(ratio, error / axis["radii"][i])
    return distance, ratio


class TreeStationFidelity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        captured, calls = [], []
        original_skeleton, original_tube = P.broadleaf_skeleton, P.MeshData.tube
        def skeleton(*args, **kwargs):
            axes, anchors, scale = original_skeleton(*args, **kwargs)
            captured.append((axes, scale, copy.deepcopy([(a["points"], a["radii"]) for a in axes]),
                             {a["id"] for a in axes if a["kept"]}))
            return axes, anchors, scale
        def tube(owner, spine, radii, sides, *args, **kwargs):
            calls.append((owner, tuple(tuple(p) for p in spine), tuple(radii), sides))
            return original_tube(owner, spine, radii, sides, *args, **kwargs)
        with patch.object(P, "broadleaf_skeleton", skeleton), patch.object(P.MeshData, "tube", tube):
            cls.parts = P.plan(copy.deepcopy(REQUEST))
        cls.bark, cls.leaves = [row[2] for row in cls.parts]
        cls.axes, cls.scale, cls.original_geometry, cls.initial_kept = captured[0]
        cls.calls = [call for call in calls if call[0] is cls.bark]
        cls.details = cls.bark.wood["axisDetails"]
        cls.by_id = {a["id"]: a for a in cls.axes}

    def stations(self, detail):
        axis = self.by_id[detail["id"]]
        return P.wood_stations(axis, axis.get("joint"), detail["preset"][2], axis["order"] == 0,
                               chord_ratio=detail["chordTargetRatio"])

    def test_original_grown_axes_radii_and_kept_hierarchy_survive_the_allocator(self):
        self.assertEqual([(a["points"], a["radii"]) for a in self.axes], self.original_geometry)
        self.assertEqual(tuple(d["id"] for d in self.details), EMITTED_IDS)
        self.assertEqual(collections.Counter(d["order"] for d in self.details), {0:1,1:5,2:20,3:33})
        self.assertEqual(sum(not self.by_id[i]["kept"] for i in self.initial_kept), 15)
        self.assertEqual([(d["id"],d["preset"],d["stations"],d["sides"]) for d in self.details if d["order"] < 2],
                         [(0,[24,.75,1.7],40,24),(1,[24,.75,1.7],28,9),(2,[24,.75,1.7],30,9),
                          (3,[24,.64,2.1],27,8),(4,[24,.64,2.1],25,8),(5,[24,.64,2.1],25,6)])

    def test_actual_emission_and_union_reserve_use_the_same_selected_station_cost(self):
        self.assertEqual(len(self.calls), len(self.details))
        predicted = 0
        for detail, (_, spine, radii, sides) in zip(self.details, self.calls):
            stations = self.stations(detail)
            self.assertEqual(len(stations), detail["stations"])
            self.assertEqual(tuple(tuple(c * self.scale for c in row[1]) for row in stations), spine)
            self.assertEqual(tuple(row[2] * self.scale for row in stations), radii)
            self.assertEqual(sides, detail["sides"])
            predicted += 2 * sides * (len(stations) - 1) + sides + sides - 2
        self.assertEqual(predicted, self.bark.triangles())
        self.assertEqual(self.bark.wood["triangleLimit"], math.floor(predicted * P.UNION_RESERVE))
        self.assertLessEqual(self.bark.wood["triangleLimit"] + 460 * P.leaf_triangles(), 16000)
        self.assertEqual(self.leaves.triangles(), 322 * 12)

    def test_independent_polyline_error_matches_metadata_and_exposes_remaining_fallbacks(self):
        tertiary, fallbacks = [], []
        for detail in self.details:
            axis = self.by_id[detail["id"]]
            distance, ratio = measured_error(axis, self.stations(detail), self.scale)
            self.assertAlmostEqual(ratio, detail["maxChordErrorRatio"], places=11)
            if detail["order"] == 3:
                tertiary.append((detail["id"],distance,ratio))
                if ratio > P.WOOD_CHORD_RATIO:
                    fallbacks.append(detail)
        self.assertLess(max(row[1] for row in tertiary), .0155)  # Original maximum18.186mm.
        self.assertLess(max(row[2] for row in tertiary), .85)  # Original maximum1.184 nominal radii.
        self.assertLess(next(row[1] for row in tertiary if row[0] == 51), .007)
        self.assertEqual(len(fallbacks), 10, "the costed experiment does not promise a universal half-radius bound")
        self.assertTrue(all(d["chordTargetRatio"] is None for d in fallbacks))

    def test_refinement_only_adds_dense_source_points_without_removing_semantic_rings_or_mutating_axes(self):
        axis = self.by_id[51]
        original = copy.deepcopy(axis)
        coarse = P.wood_stations(axis, axis.get("joint"), 4., False)
        self.assertEqual(coarse, P.wood_stations(axis, axis.get("joint"), 4., False, chord_ratio=None))
        refined = P.wood_stations(axis, axis.get("joint"), 4., False, chord_ratio=.5)
        self.assertEqual(axis, original)
        old_s = {row[0] for row in coarse}
        self.assertTrue(old_s.issubset(row[0] for row in refined))
        self.assertEqual(refined[0], coarse[0]); self.assertEqual(refined[-1], coarse[-1])
        self.assertGreater(len(refined), len(coarse))
        dense_s = [0.]
        points = axis["points"][:axis["woodCount"]]
        for a, b in zip(points, points[1:]):
            dense_s.append(dense_s[-1] + math.dist(a, b))
        for i, row in enumerate(refined):
            if row[0] not in old_s:
                self.assertIn(row[0], dense_s)
                self.assertGreater(row[0] - refined[i - 1][0], .012)
                self.assertGreater(refined[i + 1][0] - row[0], .012)
                self.assertGreaterEqual(refined[-1][0] - row[0], .03)
        self.assertLess(measured_error(axis, refined, self.scale)[1], measured_error(axis, coarse, self.scale)[1])

    def test_final_cards_remain_on_actual_emitted_skin_with_closed_topology_and_finite_uvs(self):
        orders = {detail["id"]: detail["order"] for detail in self.details}
        for attachment in self.leaves.attachments:
            self.assertGreater(orders[attachment["axis"]], 0)
            self.assertEqual(attachment["root"], self.bark.vertices[attachment["vertex"]])
            first = attachment["first"]
            base = tuple((a + b) / 2 for a, b in zip(self.leaves.vertices[first], self.leaves.vertices[first + 5]))
            self.assertLess(math.dist(base, attachment["root"]), 1e-9)
        for mesh in (self.bark, self.leaves):
            edges = collections.Counter(tuple(sorted((a,b))) for face in mesh.faces for a,b in zip(face,face[1:]+face[:1]))
            self.assertTrue(all(count == 2 for count in edges.values()))
            self.assertTrue(all(math.isfinite(c) for face in mesh.uvs for uv in face for c in uv))

    def test_spacing_blocked_refinement_keeps_semantic_rings_and_reports_residual_instead_of_forcing_slivers(self):
        axis = self.by_id[51]
        before = copy.deepcopy(axis)
        coarse = P.wood_stations(axis, axis.get("joint"), 4., False)
        tiny_target = 1e-7
        refined = P.wood_stations(axis, axis.get("joint"), 4., False, chord_ratio=tiny_target)
        self.assertEqual(axis, before)
        old_s = {row[0] for row in coarse}
        self.assertTrue(old_s.issubset(row[0] for row in refined))
        self.assertLessEqual(len(refined), len(coarse) + axis["woodCount"])
        for i, row in enumerate(refined):
            if row[0] not in old_s:
                self.assertGreater(row[0] - refined[i - 1][0], .012)
                self.assertGreater(refined[i + 1][0] - row[0], .012)
                self.assertGreaterEqual(refined[-1][0] - row[0], .03)
        self.assertGreater(measured_error(axis, refined, self.scale)[1], tiny_target,
                           "forced-ring spacing takes precedence over an unattainable requested target")


if __name__ == "__main__":
    unittest.main()
