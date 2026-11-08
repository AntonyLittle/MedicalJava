"""Tests for the segmentation worker. Run: python -m unittest -v (needs numpy and scipy)."""

import json
import threading
import unittest
import urllib.error
import urllib.request

import numpy as np

from models import CtBasic, ModelError
from volume_io import encode_volume, parse_labels, parse_volume, Volume
from worker import make_server


def metadata(shape, spacing=(5.0, 4.0, 4.0), units="HU", row=(1, 0, 0), column=(0, 1, 0)):
    depth, sy, sx = spacing
    normal = np.cross(row, column)
    slices = []
    for k in range(shape[0]):
        position = normal * depth * k + np.array([-100.0, -80.0, 10.0])
        slices.append(
            {
                "widthPixels": shape[2],
                "heightPixels": shape[1],
                "pixelSpacingXMm": sx,
                "pixelSpacingYMm": sy,
                "depthPositionMm": float(normal.dot(position)),
                "positionXMm": float(position[0]),
                "positionYMm": float(position[1]),
                "positionZMm": float(position[2]),
            }
        )
    return {
        "slices": slices,
        "rowDirection": list(row),
        "columnDirection": list(column),
        "valueSlope": 1,
        "valueIntercept": 0,
        "valueUnits": units,
    }


def phantom(shape=(30, 48, 48)):
    """Air around an elliptic body (40 HU) holding two lungs (-800 HU) and a spine (700 HU)."""
    k, j, i = np.indices(shape)
    values = np.full(shape, -1000, np.int16)
    body = ((i - 24) / 22.0) ** 2 + ((j - 24) / 18.0) ** 2 <= 1
    values[body] = 40
    for centre in (14, 34):
        lung = ((i - centre) / 7.0) ** 2 + ((j - 22) / 10.0) ** 2 <= 1
        values[lung & (k > 3) & (k < 27)] = -800
    spine = ((i - 24) / 3.0) ** 2 + ((j - 36) / 3.0) ** 2 <= 1
    values[spine] = 700
    return values


class VolumeIoTest(unittest.TestCase):
    def test_volume_round_trip(self):
        values = phantom((3, 5, 7))
        volume = parse_volume(encode_volume(metadata(values.shape), values))
        np.testing.assert_array_equal(volume.stored, values)
        self.assertEqual(volume.spacing, (5.0, 4.0, 4.0))

    def test_affine_maps_voxels_to_slice_positions(self):
        meta = metadata((4, 5, 6), row=(0, 1, 0), column=(0, 0, -1))
        volume = Volume(meta, np.zeros((4, 5, 6), np.int16))
        affine = volume.affine_lps()
        last = meta["slices"][3]
        corner = affine @ np.array([2, 3, 3, 1.0])
        expected = np.array([last["positionXMm"], last["positionYMm"], last["positionZMm"]])
        expected += np.array([0, 1, 0]) * 2 * 4.0 + np.array([0, 0, -1]) * 3 * 4.0
        np.testing.assert_allclose(corner[:3], expected)
        ras = volume.affine_ras() @ np.array([2, 3, 3, 1.0])
        np.testing.assert_allclose(ras[:3], expected * [-1, -1, 1])


class CtBasicTest(unittest.TestCase):
    def test_finds_body_lungs_and_bone(self):
        values = phantom()
        name, segments, labels = CtBasic().segment(Volume(metadata(values.shape), values))
        self.assertEqual(name, "CT basic")
        self.assertEqual([s["name"] for s in segments], ["Body", "Lungs", "Bone"])
        self.assertEqual(labels.shape, values.shape)
        self.assertTrue(np.all(labels[values == -800] == 2))
        self.assertTrue(np.all(labels[values == 700] == 3))
        self.assertTrue(np.all(labels[values == 40] == 1))
        self.assertTrue(np.all(labels[values == -1000] == 0))

    def test_rejects_data_without_hounsfield_units(self):
        values = phantom((3, 8, 8))
        with self.assertRaises(ModelError):
            CtBasic().segment(Volume(metadata(values.shape, units=""), values))


class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_server("127.0.0.1", 0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_lists_models(self):
        with urllib.request.urlopen(self.url + "/models") as response:
            models = {m["id"]: m for m in json.load(response)["models"]}
        self.assertTrue(models["ct-basic"]["available"])
        self.assertIn("totalsegmentator", models)

    def test_segments_a_volume(self):
        values = phantom()
        body = encode_volume(metadata(values.shape), values)
        request = urllib.request.Request(self.url + "/segment?model=ct-basic", data=body, method="POST")
        with urllib.request.urlopen(request) as response:
            header, labels = parse_labels(response.read(), values.shape)
        self.assertEqual(header["name"], "CT basic")
        self.assertTrue(np.all(labels[values == 700] == 3))

    def test_reports_errors_as_json(self):
        values = phantom((3, 8, 8))
        for query, body, status in (
            ("model=nope", encode_volume(metadata(values.shape), values), 400),
            ("model=ct-basic", b"\x01\x00\x00\x00{", 400),
            ("model=ct-basic", encode_volume(metadata(values.shape, units="mm"), values), 400),
        ):
            request = urllib.request.Request(self.url + "/segment?" + query, data=body, method="POST")
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(request)
            with caught.exception as error:
                self.assertEqual(error.code, status)
                self.assertIn("error", json.load(error))


if __name__ == "__main__":
    unittest.main()
