-- Store version 1 -> 2, run by VolumeStore on one connection inside a transaction. Adds the DICOM identifiers kept
-- for DICOM SEG export; the segmentation tables are created by schema.sql. Data-directory volumes get the
-- identifiers when the next scan re-imports them (importer format version 2).

ALTER TABLE volumes ADD COLUMN study_instance_uid TEXT;
ALTER TABLE volumes ADD COLUMN frame_of_reference_uid TEXT;
ALTER TABLE slices ADD COLUMN sop_class_uid TEXT;
ALTER TABLE slices ADD COLUMN sop_instance_uid TEXT;
