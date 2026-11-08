-- Applied on every startup by VolumeStore; every statement must be idempotent.

CREATE TABLE IF NOT EXISTS patients (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL UNIQUE,
    dicom_patient_id TEXT,
    created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Pixels live in volumes/{pixel_file}: little-endian int16, slices back to back in slices.position order.
-- Each write uses a fresh file name so a re-import never overwrites a file an older row still points to.
-- Directions are the LPS unit vectors along an image row and column; slices are ordered along row x column.
-- Real values are stored * value_slope + value_intercept, in value_units; min/max_value are the real range.
-- format_version records the importer version that decoded the volume (0 = imported before orientation and
-- rescale were decoded); data-directory volumes below the current version are re-imported.
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
    source_path         TEXT,
    -- Which stack of a mixed-orientation series ('' when the series is a single stack).
    source_part         TEXT    NOT NULL DEFAULT '',
    source_fingerprint  TEXT,
    row_x               REAL    NOT NULL DEFAULT 1,
    row_y               REAL    NOT NULL DEFAULT 0,
    row_z               REAL    NOT NULL DEFAULT 0,
    column_x            REAL    NOT NULL DEFAULT 0,
    column_y            REAL    NOT NULL DEFAULT 1,
    column_z            REAL    NOT NULL DEFAULT 0,
    value_slope         REAL    NOT NULL DEFAULT 1,
    value_intercept     REAL    NOT NULL DEFAULT 0,
    value_units         TEXT    NOT NULL DEFAULT '',
    min_value           REAL    NOT NULL DEFAULT 0,
    max_value           REAL    NOT NULL DEFAULT 0,
    format_version      INTEGER NOT NULL DEFAULT 0,
    -- DICOM identifiers of the source series, kept for DICOM SEG export (NULL when unknown).
    study_instance_uid     TEXT,
    frame_of_reference_uid TEXT,
    created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source_path, source_part)
);

CREATE INDEX IF NOT EXISTS volumes_patient_series ON volumes (patient_id, series_instance_uid);

-- position_*_mm is ImagePositionPatient; depth_position_mm is the distance along the volume's slice normal and
-- origin_*_mm repeat the position's x/y, for clients that only understand axial stacks.
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
    position_x_mm     REAL    NOT NULL DEFAULT 0,
    position_y_mm     REAL    NOT NULL DEFAULT 0,
    position_z_mm     REAL    NOT NULL DEFAULT 0,
    sop_class_uid     TEXT,
    sop_instance_uid  TEXT,
    PRIMARY KEY (volume_id, position)
) WITHOUT ROWID;

-- Source directory stacks whose volumes were deleted via the API; rescans must not bring them back.
CREATE TABLE IF NOT EXISTS excluded_sources (
    source_path TEXT NOT NULL,
    source_part TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (source_path, source_part)
);

-- Source directories that failed to import; retried only once their fingerprint changes.
CREATE TABLE IF NOT EXISTS import_failures (
    source_path TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    error       TEXT NOT NULL,
    failed_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Labelmaps on a volume's voxel grid: segmentations/{label_file} is the gzip of one uint8 label per voxel (0 =
-- background), slices back to back in the volume's slice order, voxel_count bytes uncompressed. geometry_hash is
-- the volume geometry the labels were written for; a re-import that changes the geometry makes them stale.
-- revision increases with every change and is the segmentation's ETag.
CREATE TABLE IF NOT EXISTS segmentations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    volume_id     INTEGER NOT NULL REFERENCES volumes (id) ON DELETE CASCADE,
    name          TEXT    NOT NULL,
    -- 'manual', 'auto:<model>' or 'dicom-seg'.
    source        TEXT    NOT NULL DEFAULT 'manual',
    label_file    TEXT    NOT NULL,
    voxel_count   INTEGER NOT NULL,
    geometry_hash TEXT    NOT NULL,
    revision      INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    modified_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS segmentations_volume ON segmentations (volume_id);

-- algorithm_type is the DICOM SEG SegmentAlgorithmType: MANUAL, SEMIAUTOMATIC or AUTOMATIC.
CREATE TABLE IF NOT EXISTS segments (
    segmentation_id INTEGER NOT NULL REFERENCES segmentations (id) ON DELETE CASCADE,
    label           INTEGER NOT NULL CHECK (label BETWEEN 1 AND 255),
    name            TEXT    NOT NULL,
    color           TEXT    NOT NULL,
    algorithm_type  TEXT    NOT NULL DEFAULT 'MANUAL',
    PRIMARY KEY (segmentation_id, label)
) WITHOUT ROWID;
