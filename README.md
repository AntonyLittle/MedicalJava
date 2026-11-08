# MedicalJava
## Volume store

`VolumeRESTServiceJava` decodes DICOM once and serves volumes from a lightweight store in `app.store-dir`
(default `Store/` at the repository root, git-ignored):

- `store.db` – SQLite database with patients, volumes and per-slice geometry.
- `volumes/*.vol` – one file per volume with little-endian int16 values, slices back to back in stack order.
- `segmentations/*.seg.gz` – one gzip file per segmentation: a uint8 label per voxel of its volume (see
  [Segmentation](#segmentation)).

Volumes keep the geometry and values of the acquisition:

- **Values** – the DICOM rescale, pixel representation, BitsStored and pixel padding are applied at import. A volume's
  values map to real ones as `value * valueSlope + valueIntercept` in `valueUnits` (CT: slope 1, intercept 0, `HU`),
  with `minValue`/`maxValue` giving the real range. Padding (e.g. CT's −2000 outside the scan circle) becomes the
  lowest real value.
- **Orientation** – `rowDirection`/`columnDirection` (ImageOrientationPatient) and each slice's `positionX/Y/ZMm`
  (ImagePositionPatient) are kept, so sagittal, coronal, oblique and gantry-tilted stacks are shown in their true
  position. Slices are ordered along the stack normal (`depthPositionMm` is the distance along it).
- **Mixed orientations** – a series acquired in several orientations (e.g. a three-plane localizer) becomes one volume
  per orientation, named like `series (sagittal)`; stacks with fewer than 3 slices are dropped. A stack whose slice
  positions don't lie on a straight line is rejected as an import failure.
  `GET …/binary` streams this file directly after the JSON header.

Volumes enter the store in two ways:

- **Data directory import** – `app.data-dir` (layout `patient/series/*.dcm`) is scanned in the background at
  startup (`app.import-on-startup`) and on `POST /api/import`. New series are added; series whose files changed are
  re-imported under the same volume id; series that fail to decode are listed by `GET /api/import/status` and
  retried once their files change.
- **Upload** – multipart `files` (DICOM files and/or zip archives); one volume is created per SeriesInstanceUID.
  - `POST /api/Patients/{patientId}/Volumes` adds to an existing patient (409 if the series is already there).
  - `POST /api/Volumes` files each series under the patient named in its DICOM tags, creating it if needed.

`DELETE /api/Patients/{patientId}/Volumes/{id}` and `DELETE /api/Patients/{patientId}` remove volumes and their
pixel files; deleted data-directory series are not re-imported by later scans. Patient and volume ids are assigned
at import time and stay stable. Only one service instance should use a store at a time.

The store is versioned (SQLite `user_version`) and upgraded in place at startup, one version at a time. Volumes from
older imports are kept (version 0 ones are shown as raw axial stacks, with a warning in the UI) and data-directory
volumes are re-imported by the next scan, keeping their ids (a mixed-orientation series is replaced by its parts).
Importer format 2 also keeps the DICOM study, frame of reference and instance UIDs, which DICOM SEG export references.
Uploaded volumes can't be re-decoded; upload them again to update them.

The frontend exposes all of this in the toolbar below the patient/volume selectors:
- **Upload…** – pick files, a folder or zip archives, or drag them onto the dialog. Shows upload progress.
- **Delete volume** and **Delete patient** – ask for confirmation first.
- **Rescan data folder** – runs the data directory import again.
- **Import status** chip – shows when an import is running and lists folders that failed to import.

## 3D volume rendering

The frontend renders the loaded volume in 3D with WebGL2 ray casting (`frontend/src/render3d/`, shown by
`VolumeRenderViewer`). The volume is uploaded once as a half-float 3D texture. Uneven slice spacing is resampled to an
even grid, and axes larger than the GPU's 3D texture limit are decimated. No server changes are involved.

- **Modes** – *VR* (colour/opacity transfer-function presets: bone, soft tissue, skin, lung, vessels, with lighting),
  *Surface* (shaded isosurface at a threshold), and *MIP*, *MinIP* and *Avg* projections, which use the shared
  window level/width.
- **Clipping** – a clip box per patient axis, and *Cut at MPR plane*, which removes everything on one side of the
  axial, coronal or sagittal MPR plane and follows it as it moves.
- **MPR planes** – the three MPR planes are outlined in the 3D view, and shift+click moves the MPR crosshair to the
  point under the cursor.
- **Interaction** – left drag rotates, middle drag pans, right drag or the wheel zooms, and left+right drag adjusts
  the active mode (VR: preset shift horizontally, opacity vertically; Surface: threshold; projections: window
  level/width). Double-click resets the view. The view is drawn at half resolution while it changes and refined
  once input pauses. Empty bricks of 8³ voxels are skipped.

The MPR views (thin, thick slab and the overview projection) are rendered on the GPU too, from the same texture: one
shared off-screen WebGL2 context renders every view and copies the result into its canvas, so the volume is on the GPU
only once. Slabs are sampled more coarsely while they move and refined once input pauses. Without WebGL2, or if the
volume doesn't fit on the GPU, the MPR views fall back to sampling on the CPU (`frontend/src/utils/mprSampler.ts`).

Presets and their *Shift* are in HU, so they apply to CT volumes. For other data (e.g. MR), *VR* ramps opacity across
the shared window level/width instead, and the surface threshold is in the volume's own units. The 3D view, the MPR
views and picking all use the volume's acquired orientation, so oblique and tilted stacks line up with the 2D views.

## Segmentation

A segmentation is a **labelmap** on its volume's own voxel grid: one uint8 per voxel (0 = background, 1–255 = segment
labels), slices in the volume's order. A volume can have several segmentations; each has a table of segments (label,
name, colour and DICOM algorithm type: manual, semi-automatic or automatic).

### REST API

Under `/api/Patients/{patientId}/Volumes/{volumeId}/Segmentations`:

| Request | |
|---|---|
| `GET` | List the volume's segmentations. |
| `POST` `{name, segments}` | Create an empty one (all background). 201 with `Location` and `ETag`. |
| `GET /{id}` | Metadata: name, source (`manual`, `auto:<model>`, `dicom-seg`), revision, voxel count, `stale`, segments. |
| `PATCH /{id}` `{name?, segments?}` | Rename and/or replace the segment table. |
| `GET /{id}/labels` | The labels, gzip-encoded when the client accepts it (browsers decode it transparently). |
| `PUT /{id}/labels` | Replace the labels: raw uint8, or with `Content-Encoding: gzip`. Must hold one label per voxel. |
| `DELETE /{id}` | Delete it and its label file. |
| `GET /{id}/stats` | Per label: voxel count, volume (mL), mean, SD, min and max in real units (e.g. HU). |
| `GET /{id}/dicom` | Export as a binary DICOM Segmentation object. |
| `POST /dicom` (multipart `file`) | Import a DICOM SEG (binary or fractional) as a new segmentation. |
| `POST /auto` `{model, name?}` | Start automatic segmentation (202 with a job). `GET /auto` lists the volume's jobs. |

Changes take an optional `If-Match` with the segmentation's ETag (its revision) and fail with 412 when someone else
changed it first. `GET /api/segmentation/models` lists the automatic models and `GET /api/segmentation/jobs/{jobId}`
reports a job (`queued`, `running`, `succeeded` with the new `segmentationId`, or `failed` with a message).

Labels are tied to the volume's geometry: when a data-directory re-import changes it (slices added or moved), the
segmentation is marked `stale`. Its labels no longer line up, so statistics and export refuse it until new labels are
saved; the UI can't open one whose voxel count no longer matches. Deleting a volume or patient deletes their
segmentations.

DICOM SEG export writes one frame per segment and slice it appears in, on the volume's pixel grid, with segment names,
colours (CIELab) and algorithm types. It references the source series and images when their UIDs are known (volumes
imported with format 2); otherwise it uses stable generated study and frame of reference UIDs. Segments are coded
generically (SNOMED "Tissue"); the name is in `SegmentLabel`. Import maps every frame pixel to the nearest voxel, so a
SEG on another grid of the same frame of reference is resampled; one from a different frame of reference is rejected.

### Viewer

The **Segmentation** panel above the viewers opens, creates, renames, saves (Ctrl+S) and deletes segmentations, and
imports and exports DICOM SEG. Unsaved changes are flagged, and switching volume or leaving the page asks first.

- **Segments** – pick the active segment (the one the tools change), show/hide, recolour, rename, add and remove. Their
  volumes update live.
- **Tools** (on the cine and MPR views; Ctrl + drag still pans):
  - *Brush* / *Eraser* – a disc in the view plane, one voxel thick, or a 3D ball. The eraser only removes the active
    segment.
  - *Region grow* – click to flood-fill the face-connected voxels within the value range (or ± a tolerance around the
    clicked voxel's value).
  - *Value range* – limits the brush and region growing; *Apply threshold* adds every voxel in range; *Show on views*
    previews the range in yellow.
  - *Paint over other segments* – otherwise tools only take background voxels.
- **Operations on the active segment** – grow or shrink by a distance in mm (exact Euclidean distance), fill enclosed
  holes (in 3D or per slice), keep the largest connected piece, interpolate between painted slices (shape-based, along
  the acquisition stack) and clear.
- **Undo / redo** – every stroke or operation is one step (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y).
- **Statistics** – volume, mean, SD, min and max per segment, including unsaved edits.
- **Export STL** – the active segment's surface (surface nets), in mm in patient (LPS) coordinates.

The 2D views draw the labels (fill and outline) nearest-neighbour on their own pixel grids; slab views show the
labels on the slab's centre plane. In the 3D view, *Seg* mode draws shaded surfaces of the visible segments (with an
opacity for seeing through them), and *Colour by segment* tints VR. Labels are uploaded as a second 3D texture, on the
same grid as the volume and updated incrementally while you paint. Long operations run in time slices with a progress
bar, so the page stays responsive.

### Automatic segmentation worker

`SegmentationWorker/` is a small Python HTTP service that the backend sends volumes to
(`app.segmentation.worker-url`, default `http://localhost:54809`; `app.segmentation.worker-timeout`, default 4 h).
Jobs run one at a time and their results are stored as new segmentations (source `auto:<model>`, segments
`AUTOMATIC`); editing one makes its segments semi-automatic.

```bash
cd SegmentationWorker
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python worker.py            # --host / --port to change where it listens
```

Models:

- `ct-basic` – body, lungs and bone (≥ 250 HU) from thresholds and connected components. Fast; needs CT in HU.
- `totalsegmentator` and `totalsegmentator-fast` – the 117 structures of
  [TotalSegmentator](https://github.com/wasserth/TotalSegmentator), when `TotalSegmentator` and `nibabel` are
  installed in the worker's environment (`pip install TotalSegmentator nibabel`; a CUDA GPU makes it practical). The
  volume is passed in its own grid; unevenly spaced slices are treated as evenly spaced.

The protocol is documented in `worker.py` and `AutoSegmentationService`, so other models can be added to
`SegmentationWorker/models.py` or served by a different worker.

## Tests

- Backend: `mvn test` in `VolumeRESTServiceJava/` (unit tests plus end-to-end tests against series in `Data/`).
- Frontend: `npm test` in `frontend/` (vitest; volume geometry, MPR sampling and segmentation tools).
- Segmentation worker: `python -m unittest` in `SegmentationWorker/` (needs numpy and scipy).
