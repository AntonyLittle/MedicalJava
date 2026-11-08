# MedicalJava
## Volume store

`VolumeRESTServiceJava` decodes DICOM once and serves volumes from a lightweight store in `app.store-dir`
(default `Store/` at the repository root, git-ignored):

- `store.db` – SQLite database with patients, volumes and per-slice geometry.
- `volumes/*.vol` – one file per volume with little-endian int16 values, slices back to back in stack order.

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

The store is versioned (SQLite `user_version`) and upgraded in place at startup. Volumes from older imports are kept
(shown as raw axial stacks, with a warning in the UI) and data-directory volumes are re-imported by the next scan,
keeping their ids (a mixed-orientation series is replaced by its parts). Uploaded volumes can't be re-decoded; upload
them again to update them.

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

Presets and their *Shift* are in HU, so they apply to CT volumes. For other data (e.g. MR), *VR* ramps opacity across
the shared window level/width instead, and the surface threshold is in the volume's own units. The 3D view, the MPR
views and picking all use the volume's acquired orientation, so oblique and tilted stacks line up with the 2D views.

## Tests

- Backend: `mvn test` in `VolumeRESTServiceJava/` (unit tests plus end-to-end tests against series in `Data/`).
- Frontend: `npm test` in `frontend/` (vitest; volume geometry and MPR sampling).
