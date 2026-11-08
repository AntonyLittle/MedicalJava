"""Volume I/O for the segmentation worker: the service's binary volume format, label responses and geometry."""

import json
import struct
from dataclasses import dataclass

import numpy as np


@dataclass
class Volume:
    """A volume as sent by VolumeRESTServiceJava: metadata plus stored int16 values, shape (slices, rows, columns)."""

    metadata: dict
    stored: np.ndarray

    @property
    def real(self) -> np.ndarray:
        """Real values (e.g. HU) as float32."""
        slope = float(self.metadata.get("valueSlope", 1) or 1)
        intercept = float(self.metadata.get("valueIntercept", 0) or 0)
        return self.stored.astype(np.float32) * np.float32(slope) + np.float32(intercept)

    @property
    def units(self) -> str:
        return self.metadata.get("valueUnits") or ""

    @property
    def spacing(self) -> tuple[float, float, float]:
        """Millimetres between voxel centres along (slice, row, column); uneven slice spacing is averaged."""
        slices = self.metadata["slices"]
        first = slices[0]
        if len(slices) > 1:
            depth = abs(slices[-1]["depthPositionMm"] - first["depthPositionMm"]) / (len(slices) - 1)
        else:
            depth = min(first["pixelSpacingXMm"], first["pixelSpacingYMm"])
        return depth, first["pixelSpacingYMm"], first["pixelSpacingXMm"]

    def affine_lps(self) -> np.ndarray:
        """4×4 matrix from (column, row, slice) voxel indices to patient LPS millimetres."""
        slices = self.metadata["slices"]
        first = slices[0]
        row = np.array(self.metadata.get("rowDirection") or [1, 0, 0], dtype=float)
        column = np.array(self.metadata.get("columnDirection") or [0, 1, 0], dtype=float)
        row /= np.linalg.norm(row)
        column -= row * column.dot(row)
        column /= np.linalg.norm(column)
        origin = _position(first)
        if len(slices) > 1:
            step = (_position(slices[-1]) - origin) / (len(slices) - 1)
        else:
            step = np.cross(row, column) * min(first["pixelSpacingXMm"], first["pixelSpacingYMm"])
        affine = np.eye(4)
        affine[:3, 0] = row * first["pixelSpacingXMm"]
        affine[:3, 1] = column * first["pixelSpacingYMm"]
        affine[:3, 2] = step
        affine[:3, 3] = origin
        return affine

    def affine_ras(self) -> np.ndarray:
        """As affine_lps, in the RAS frame NIfTI uses."""
        return np.diag([-1.0, -1.0, 1.0, 1.0]) @ self.affine_lps()


def _position(s: dict) -> np.ndarray:
    if s.get("positionXMm") is None:
        return np.array([s["originXMm"], s["originYMm"], s["depthPositionMm"]], dtype=float)
    return np.array([s["positionXMm"], s["positionYMm"], s["positionZMm"]], dtype=float)


def _padded(length: int) -> int:
    return (length + 3) & ~3


def parse_volume(body: bytes) -> Volume:
    """Parses the /binary layout: uint32 N, N bytes of JSON, padding to 4 bytes, int16 pixels slice by slice."""
    if len(body) < 4:
        raise ValueError("Empty volume")
    (length,) = struct.unpack_from("<I", body, 0)
    metadata = json.loads(body[4 : 4 + length].decode("utf-8"))
    slices = metadata.get("slices") or []
    if not slices:
        raise ValueError("The volume has no slices")
    rows = slices[0]["heightPixels"]
    columns = slices[0]["widthPixels"]
    if any(s["widthPixels"] != columns or s["heightPixels"] != rows for s in slices):
        raise ValueError("Slices of different sizes are not supported")
    offset = _padded(4 + length)
    count = len(slices) * rows * columns
    if len(body) - offset < count * 2:
        raise ValueError("The volume's pixel data is too short")
    stored = np.frombuffer(body, dtype="<i2", count=count, offset=offset).reshape(len(slices), rows, columns)
    return Volume(metadata, stored)


def encode_volume(metadata: dict, stored: np.ndarray) -> bytes:
    """Inverse of parse_volume, for tests and tools."""
    header = json.dumps(metadata).encode("utf-8")
    padding = _padded(4 + len(header)) - 4 - len(header)
    return struct.pack("<I", len(header)) + header + bytes(padding) + stored.astype("<i2").tobytes()


def encode_labels(name: str, segments: list[dict], labels: np.ndarray) -> bytes:
    """The worker's response: uint32 N, N bytes of JSON {name, segments}, padding to 4 bytes, uint8 labels."""
    header = json.dumps({"name": name, "segments": segments}).encode("utf-8")
    padding = _padded(4 + len(header)) - 4 - len(header)
    return struct.pack("<I", len(header)) + header + bytes(padding) + np.ascontiguousarray(labels, np.uint8).tobytes()


def parse_labels(body: bytes, shape: tuple[int, ...]) -> tuple[dict, np.ndarray]:
    (length,) = struct.unpack_from("<I", body, 0)
    header = json.loads(body[4 : 4 + length].decode("utf-8"))
    offset = _padded(4 + length)
    return header, np.frombuffer(body, dtype=np.uint8, offset=offset).reshape(shape)


def palette_color(label: int) -> str:
    """A distinct, deterministic colour per label (golden-angle hues)."""
    import colorsys

    hue = (label * 0.618033988749895) % 1.0
    r, g, b = colorsys.hsv_to_rgb(hue, 0.65, 0.95)
    return "#{:02x}{:02x}{:02x}".format(round(r * 255), round(g * 255), round(b * 255))
