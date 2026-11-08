"""Segmentation models offered by the worker.

Each model takes a Volume and returns (name, segments, labels) where labels is a uint8 array of the volume's shape
(slices, rows, columns) and segments lists {label, name, color}.
"""

import importlib.util
import logging

import numpy as np

from volume_io import Volume, palette_color

LOG = logging.getLogger("segmentation-worker")


class ModelError(Exception):
    """The model can't segment this volume (e.g. wrong modality); reported to the client as a 400."""


class Model:
    id = ""
    name = ""
    description = ""

    def unavailable_reason(self) -> str | None:
        return None

    def segment(self, volume: Volume) -> tuple[str, list[dict], np.ndarray]:
        raise NotImplementedError

    def describe(self) -> dict:
        reason = self.unavailable_reason()
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "available": reason is None,
            "unavailableReason": reason,
        }


def _require_hounsfield(volume: Volume) -> None:
    if volume.units != "HU":
        raise ModelError("This model needs a CT volume in Hounsfield units")


class CtBasic(Model):
    """Body, lungs and bone from Hounsfield thresholds and connected components. Fast, no training data needed."""

    id = "ct-basic"
    name = "CT basic (body, lungs, bone)"
    description = "Thresholds and connected components: body outline, air-filled lungs and bone (≥ 250 HU)."

    BODY_HU = -500
    LUNG_HU = -400
    BONE_HU = 250
    # Air pockets smaller than this aren't lungs (bowel gas, sinuses, trachea fragments).
    MIN_LUNG_ML = 150
    MIN_BONE_ML = 0.5

    def unavailable_reason(self):
        if importlib.util.find_spec("scipy") is None:
            return "Needs scipy (pip install -r requirements.txt)"
        return None

    def segment(self, volume):
        from scipy import ndimage

        _require_hounsfield(volume)
        hu = volume.real
        dz, dy, dx = volume.spacing
        voxel_ml = dz * dy * dx / 1000.0

        body = _largest_component(hu > self.BODY_HU)
        # Fill each slice so the lungs and airways become part of the body.
        for k in range(body.shape[0]):
            body[k] = ndimage.binary_fill_holes(body[k])

        air = (hu < self.LUNG_HU) & body
        components, count = ndimage.label(air)
        lungs = np.zeros_like(air)
        if count:
            sizes = np.bincount(components.ravel())[1:] * voxel_ml
            keep = [i + 1 for i in np.argsort(sizes)[::-1][:2] if sizes[i] >= self.MIN_LUNG_ML]
            lungs = np.isin(components, keep)

        bone = (hu >= self.BONE_HU) & body
        components, count = ndimage.label(bone)
        if count:
            sizes = np.bincount(components.ravel()) * voxel_ml
            small = sizes < self.MIN_BONE_ML
            small[0] = True
            bone &= ~small[components]

        labels = np.zeros(hu.shape, np.uint8)
        labels[body] = 1
        labels[lungs] = 2
        labels[bone] = 3
        segments = [
            {"label": 1, "name": "Body", "color": "#e8b796"},
            {"label": 2, "name": "Lungs", "color": "#5fa8d3"},
            {"label": 3, "name": "Bone", "color": "#f1e9d2"},
        ]
        return "CT basic", segments, labels


def _largest_component(mask: np.ndarray) -> np.ndarray:
    from scipy import ndimage

    components, count = ndimage.label(mask)
    if count == 0:
        return mask
    sizes = np.bincount(components.ravel())
    sizes[0] = 0
    return components == sizes.argmax()


class TotalSegmentator(Model):
    """TotalSegmentator (Wasserthal et al.) — 117 anatomical structures in CT. Runs in the volume's own grid."""

    def __init__(self, fast: bool):
        self.fast = fast
        self.id = "totalsegmentator-fast" if fast else "totalsegmentator"
        self.name = "TotalSegmentator" + (" (fast, 3 mm)" if fast else "")
        self.description = (
            "117 anatomical structures in CT"
            + (", at 3 mm resolution (much faster, coarser)" if fast else " at 1.5 mm resolution; a GPU is recommended")
        )

    def unavailable_reason(self):
        missing = [m for m in ("totalsegmentator", "nibabel") if importlib.util.find_spec(m) is None]
        if missing:
            return "Install " + " and ".join(missing) + " in the worker's Python environment"
        return None

    def segment(self, volume):
        import nibabel as nib
        from totalsegmentator.map_to_binary import class_map
        from totalsegmentator.python_api import totalsegmentator

        _require_hounsfield(volume)
        # NIfTI index order is (column, row, slice), in RAS.
        data = np.ascontiguousarray(volume.real.transpose(2, 1, 0))
        image = nib.Nifti1Image(data, volume.affine_ras())
        LOG.info("Running TotalSegmentator%s on %s voxels", " (fast)" if self.fast else "", data.shape)
        result = totalsegmentator(image, None, ml=True, fast=self.fast, quiet=True)
        labels_xyz = np.asanyarray(result.dataobj)
        if labels_xyz.shape != data.shape:
            raise RuntimeError(f"TotalSegmentator returned shape {labels_xyz.shape}, expected {data.shape}")
        labels = np.ascontiguousarray(labels_xyz.transpose(2, 1, 0)).astype(np.uint8)
        present = set(np.unique(labels).tolist()) - {0}
        names = class_map["total"]
        segments = [
            {"label": int(label), "name": names[label].replace("_", " "), "color": palette_color(int(label))}
            for label in sorted(present)
            if label in names
        ]
        return "TotalSegmentator", segments, labels


MODELS: dict[str, Model] = {m.id: m for m in (CtBasic(), TotalSegmentator(fast=False), TotalSegmentator(fast=True))}
