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
