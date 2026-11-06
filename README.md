# MedicalJava
## Volume store

`VolumeRESTServiceJava` decodes DICOM once and serves volumes from a lightweight store in `app.store-dir`
(default `Store/` at the repository root, git-ignored):

- `store.db` – SQLite database with patients, volumes and per-slice geometry.
- `volumes/*.vol` – one file per volume with raw little-endian int16 pixels, slices back to back in depth order.
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
  *Surface* (shaded isosurface at a HU threshold), and *MIP*, *MinIP* and *Avg* projections, which use the shared
  window level/width.
- **Clipping** – a clip box per patient axis, and *Cut at MPR plane*, which removes everything on one side of the
  axial, coronal or sagittal MPR plane and follows it as it moves.
- **MPR planes** – the three MPR planes are outlined in the 3D view, and shift+click moves the MPR crosshair to the
  point under the cursor.
- **Interaction** – left drag rotates, middle drag pans, right drag or the wheel zooms, and left+right drag adjusts
  the active mode (VR: preset shift horizontally, opacity vertically; Surface: threshold; projections: window
  level/width). Double-click resets the view. The view is drawn at half resolution while it changes and refined
  once input pauses. Empty bricks of 8³ voxels are skipped.

The store keeps raw CT pixel values (the DICOM rescale is not applied), so presets and the surface threshold are
specified in HU and converted assuming the usual intercept of −1024. For other data, use the preset *Shift* and
*Opacity* controls.
