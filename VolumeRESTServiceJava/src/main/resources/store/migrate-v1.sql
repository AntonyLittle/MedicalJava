-- Store version 0 -> 1, run by VolumeStore on one connection inside a transaction with foreign keys off.
-- Existing volumes keep their ids and get the axial/raw defaults (format_version 0) until they are re-imported.

CREATE TEMP TABLE volumes_seq AS SELECT seq FROM sqlite_sequence WHERE name = 'volumes';

CREATE TABLE volumes_v1 (
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
    source_path         TEXT,
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
    created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source_path, source_part)
);

INSERT INTO volumes_v1 (id, patient_id, name, modality, series_instance_uid, width, height, depth, slice_count,
                        pixel_file, pixel_bytes, source_path, source_fingerprint, created_at, updated_at)
SELECT id, patient_id, name, modality, series_instance_uid, width, height, depth, slice_count,
       pixel_file, pixel_bytes, source_path, source_fingerprint, created_at, updated_at
FROM volumes;

DROP TABLE volumes;
ALTER TABLE volumes_v1 RENAME TO volumes;

-- Keep AUTOINCREMENT's guarantee that ids of deleted volumes are never reused.
INSERT INTO sqlite_sequence (name, seq)
SELECT 'volumes', seq FROM volumes_seq WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'volumes');
UPDATE sqlite_sequence SET seq = MAX(seq, (SELECT seq FROM volumes_seq))
WHERE name = 'volumes' AND EXISTS (SELECT 1 FROM volumes_seq);
DROP TABLE volumes_seq;

ALTER TABLE slices ADD COLUMN position_x_mm REAL NOT NULL DEFAULT 0;
ALTER TABLE slices ADD COLUMN position_y_mm REAL NOT NULL DEFAULT 0;
ALTER TABLE slices ADD COLUMN position_z_mm REAL NOT NULL DEFAULT 0;
UPDATE slices SET position_x_mm = origin_x_mm, position_y_mm = origin_y_mm, position_z_mm = depth_position_mm;

CREATE TABLE excluded_sources_v1 (
    source_path TEXT NOT NULL,
    source_part TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (source_path, source_part)
);
INSERT INTO excluded_sources_v1 (source_path) SELECT source_path FROM excluded_sources;
DROP TABLE excluded_sources;
ALTER TABLE excluded_sources_v1 RENAME TO excluded_sources;
