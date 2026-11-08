-- Store schema version 0 (before orientation and rescale were decoded), used to test the upgrade.

CREATE TABLE IF NOT EXISTS patients (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL UNIQUE,
    dicom_patient_id TEXT,
    created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Pixels live in volumes/{pixel_file}: little-endian int16, slices back to back in slices.position order.
-- Each write uses a fresh file name so a re-import never overwrites a file an older row still points to.
CREATE TABLE IF NOT EXISTS volumes (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id          INTEGER NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
    name                TEXT    NOT NULL,
    modality            TEXT    NOT NULL,
    series_instance_uid TEXT,
    width               INTEGER NOT NULL,
    height              INTEGER NOT NULL,
    depth               INTEGER NOT NULL,
    slice_count         INTEGER NOT NULL,
    pixel_file          TEXT    NOT NULL,
    pixel_bytes         INTEGER NOT NULL,
    -- Path relative to app.data-dir for directory imports; NULL for uploads.
    source_path         TEXT UNIQUE,
    source_fingerprint  TEXT,
    created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS volumes_patient_series ON volumes (patient_id, series_instance_uid);

CREATE TABLE IF NOT EXISTS slices (
    volume_id         INTEGER NOT NULL REFERENCES volumes (id) ON DELETE CASCADE,
    position          INTEGER NOT NULL,
    slice_index       INTEGER NOT NULL,
    width_px          INTEGER NOT NULL,
    height_px         INTEGER NOT NULL,
    width_mm          REAL    NOT NULL,
    height_mm         REAL    NOT NULL,
    depth_position_mm REAL    NOT NULL,
    origin_x_mm       REAL    NOT NULL,
    origin_y_mm       REAL    NOT NULL,
    spacing_x_mm      REAL    NOT NULL,
    spacing_y_mm      REAL    NOT NULL,
    PRIMARY KEY (volume_id, position)
) WITHOUT ROWID;

-- Source directories whose volumes were deleted via the API; rescans must not bring them back.
CREATE TABLE IF NOT EXISTS excluded_sources (
    source_path TEXT PRIMARY KEY
);

-- Source directories that failed to import; retried only once their fingerprint changes.
CREATE TABLE IF NOT EXISTS import_failures (
    source_path TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    error       TEXT NOT NULL,
    failed_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
