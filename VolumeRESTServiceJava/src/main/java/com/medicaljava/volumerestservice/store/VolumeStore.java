package com.medicaljava.volumerestservice.store;

import com.medicaljava.volumerestservice.model.Patient;
import com.medicaljava.volumerestservice.model.Slice;
import com.medicaljava.volumerestservice.model.Volume;
import com.medicaljava.volumerestservice.repository.DicomSeriesReader.SourceImage;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.jdbc.datasource.init.ScriptUtils;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.ByteOrder;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/**
 * SQLite metadata plus one raw pixel file per volume. Writes are serialised in-process (SQLite allows a
 * single writer); reads run concurrently thanks to WAL. Assumes a single service instance per store.
 */
@Component
public class VolumeStore {

    private static final Logger LOG = LoggerFactory.getLogger(VolumeStore.class);

    /** Store schema version, kept in SQLite's user_version. */
    static final int SCHEMA_VERSION = 2;

    /** Volume metadata without pixels, ready to be stored alongside a pixel file. */
    public record NewVolume(
            String name,
            String modality,
            String seriesInstanceUid,
            String sourcePath,
            String sourcePart,
            String sourceFingerprint,
            int width,
            int height,
            int depth,
            double[] rowDirection,
            double[] columnDirection,
            PixelValues.Mapping values,
            int formatVersion,
            List<Slice> slices,
            long pixelBytes,
            String studyInstanceUid,
            String frameOfReferenceUid,
            // Parallel to slices; null when unknown.
            List<SourceImage> sources) {}

    /** Who the volume belongs to: an existing patient id, or a name to look up / create. */
    public record PatientRef(Integer patientId, String name, String dicomPatientId) {
        public static PatientRef byId(int patientId) {
            return new PatientRef(patientId, null, null);
        }

        public static PatientRef byName(String name, String dicomPatientId) {
            return new PatientRef(null, name, dicomPatientId);
        }
    }

    public record StoredVolume(Volume volume, Path pixelFile, long pixelBytes) {}

    public record VolumeKey(int patientId, int volumeId) {}

    public record SourceState(int volumeId, String fingerprint, int formatVersion) {}

    public record ImportFailure(String sourcePath, String fingerprint, String error, String failedAt) {}

    /** What a DICOM object derived from a volume needs to reference it. Any UID may be null when unknown. */
    public record DicomReferences(String patientName, String patientId, String studyInstanceUid,
            String seriesInstanceUid, String frameOfReferenceUid, String modality, List<SourceImage> sources) {}

    // Nested rather than method-local: two local records with the same name make the Eclipse compiler (used by the
    // VS Code debugger) write a duplicate InnerClasses entry, which the JVM rejects with a ClassFormatError.
    private record VolumeRow(Volume volume, String pixelFile, long pixelBytes) {}

    private record DeletedRow(String pixelFile, String sourcePath, String sourcePart) {}

    private final JdbcClient jdbc;
    private final TransactionTemplate tx;
    private final StorePaths paths;
    private final ReentrantLock writeLock = new ReentrantLock();

    public VolumeStore(DataSource dataSource, JdbcClient jdbc, PlatformTransactionManager txManager,
            StorePaths paths) {
        this.jdbc = jdbc;
        this.tx = new TransactionTemplate(txManager);
        this.paths = paths;
        migrate(dataSource);
        new ResourceDatabasePopulator(new ClassPathResource("store/schema.sql")).execute(dataSource);
        jdbc.sql("PRAGMA user_version = " + SCHEMA_VERSION).update();
        removeOrphanedFiles();
    }

    // ---- reads ----

    public List<Patient> listPatients() {
        return jdbc.sql("SELECT id, name FROM patients ORDER BY name, id")
                .query((rs, n) -> new Patient(rs.getInt("id"), rs.getString("name"), new ArrayList<>()))
                .list();
    }

    public Patient getPatient(int patientId) {
        return jdbc.sql("SELECT id, name FROM patients WHERE id = ?")
                .param(patientId)
                .query((rs, n) -> new Patient(rs.getInt("id"), rs.getString("name"), new ArrayList<>()))
                .optional()
                .orElseThrow(() -> new NoSuchElementException("Patient not found"));
    }

    public Optional<Integer> findPatientIdByName(String name) {
        return jdbc.sql("SELECT id FROM patients WHERE name = ?").param(name).query(Integer.class).optional();
    }

    public List<Volume> listVolumes(int patientId) {
        var patient = getPatient(patientId);
        return jdbc.sql("SELECT * FROM volumes WHERE patient_id = ? ORDER BY name, id")
                .param(patientId)
                .query((rs, n) -> volumeFromRow(rs, patient, new ArrayList<>()))
                .list();
    }

    public StoredVolume getVolume(int patientId, int volumeId) {
        var patient = getPatient(patientId);
        var row = jdbc.sql("SELECT * FROM volumes WHERE id = ? AND patient_id = ?")
                .param(volumeId)
                .param(patientId)
                .query((rs, n) -> new VolumeRow(volumeFromRow(rs, patient, List.of()), rs.getString("pixel_file"),
                        rs.getLong("pixel_bytes")))
                .optional()
                .orElseThrow(() -> new NoSuchElementException("Volume not found"));

        var slices = jdbc.sql("SELECT * FROM slices WHERE volume_id = ? ORDER BY position")
                .param(volumeId)
                .query((rs, n) -> new Slice(
                        rs.getInt("slice_index"), volumeId, patientId, rs.getInt("slice_index"),
                        rs.getInt("width_px"), rs.getInt("height_px"),
                        rs.getDouble("width_mm"), rs.getDouble("height_mm"), rs.getDouble("depth_position_mm"),
                        rs.getDouble("origin_x_mm"), rs.getDouble("origin_y_mm"),
                        rs.getDouble("spacing_x_mm"), rs.getDouble("spacing_y_mm"),
                        rs.getDouble("position_x_mm"), rs.getDouble("position_y_mm"), rs.getDouble("position_z_mm"),
                        new short[0]))
                .list();

        var volume = row.volume().withSlices(slices);
        return new StoredVolume(volume, paths.pixelFile(row.pixelFile()), row.pixelBytes());
    }

    public DicomReferences dicomReferences(int patientId, int volumeId) {
        var references = jdbc.sql("""
                SELECT p.name, p.dicom_patient_id, v.study_instance_uid, v.series_instance_uid,
                    v.frame_of_reference_uid, v.modality
                FROM volumes v JOIN patients p ON p.id = v.patient_id WHERE v.id = ? AND v.patient_id = ?""")
                .param(volumeId)
                .param(patientId)
                .query((rs, n) -> new DicomReferences(rs.getString(1), rs.getString(2), rs.getString(3),
                        rs.getString(4), rs.getString(5), rs.getString(6), List.of()))
                .optional()
                .orElseThrow(() -> new NoSuchElementException("Volume not found"));
        var sources = jdbc.sql("SELECT sop_class_uid, sop_instance_uid FROM slices WHERE volume_id = ? ORDER BY position")
                .param(volumeId)
                .query((rs, n) -> new SourceImage(rs.getString(1), rs.getString(2)))
                .list();
        return new DicomReferences(references.patientName(), references.patientId(), references.studyInstanceUid(),
                references.seriesInstanceUid(), references.frameOfReferenceUid(), references.modality(), sources);
    }

    /**
     * Identifies the voxel grid of a volume (slice sizes, spacing, positions and orientation, rounded to well below a
     * voxel), so labelmaps written for it can tell whether a re-import moved the voxels.
     */
    public static String geometryHash(Volume volume) {
        var text = new StringBuilder();
        for (var d : volume.rowDirection()) {
            text.append(String.format(java.util.Locale.ROOT, "%.5f,", d));
        }
        for (var d : volume.columnDirection()) {
            text.append(String.format(java.util.Locale.ROOT, "%.5f,", d));
        }
        for (var s : volume.slices()) {
            text.append(String.format(java.util.Locale.ROOT, "|%d,%d,%.4f,%.4f,%.3f,%.3f,%.3f", s.widthPixels(),
                    s.heightPixels(), s.pixelSpacingXMm(), s.pixelSpacingYMm(), s.positionXMm(), s.positionYMm(),
                    s.positionZMm()));
        }
        try {
            var digest = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(text.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return java.util.HexFormat.of().formatHex(digest, 0, 16);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public boolean hasSeries(int patientId, String seriesInstanceUid) {
        return jdbc.sql("SELECT COUNT(*) FROM volumes WHERE patient_id = ? AND series_instance_uid = ?")
                .param(patientId)
                .param(seriesInstanceUid)
                .query(Integer.class)
                .single() > 0;
    }

    /** Data-directory volumes by source path, then by source part. */
    public Map<String, Map<String, SourceState>> volumeSources() {
        var sources = new HashMap<String, Map<String, SourceState>>();
        jdbc.sql("""
                SELECT source_path, source_part, id, source_fingerprint, format_version
                FROM volumes WHERE source_path IS NOT NULL""")
                .query(rs -> {
                    sources.computeIfAbsent(rs.getString(1), k -> new HashMap<>())
                            .put(rs.getString(2), new SourceState(rs.getInt(3), rs.getString(4), rs.getInt(5)));
                });
        return sources;
    }

    /** Parts deleted through the API, by source path. */
    public Map<String, Set<String>> excludedSources() {
        var excluded = new HashMap<String, Set<String>>();
        jdbc.sql("SELECT source_path, source_part FROM excluded_sources")
                .query(rs -> {
                    excluded.computeIfAbsent(rs.getString(1), k -> new HashSet<>()).add(rs.getString(2));
                });
        return excluded;
    }

    public List<ImportFailure> listFailures() {
        return jdbc.sql("SELECT source_path, fingerprint, error, failed_at FROM import_failures ORDER BY source_path")
                .query((rs, n) -> new ImportFailure(rs.getString(1), rs.getString(2), rs.getString(3),
                        rs.getString(4)))
                .list();
    }

    // ---- writes ----

    /**
     * Stores a volume whose pixels have been written to {@code tmpPixelFile} (which is consumed). When
     * {@code replaceVolumeId} is set, that volume is updated in place so its id stays stable.
     */
    public VolumeKey saveVolume(PatientRef owner, NewVolume v, Path tmpPixelFile, Integer replaceVolumeId) {
        var pixelFileName = UUID.randomUUID() + ".vol";
        var pixelFile = paths.pixelFile(pixelFileName);
        String[] previousPixelFile = {null};

        VolumeKey key;
        try {
            key = write(() -> {
                int patientId = resolvePatient(owner);
                int id;
                if (replaceVolumeId != null) {
                    previousPixelFile[0] = jdbc.sql("SELECT pixel_file FROM volumes WHERE id = ?")
                            .param(replaceVolumeId).query(String.class).single();
                    jdbc.sql("""
                            UPDATE volumes SET patient_id = ?, name = ?, modality = ?, series_instance_uid = ?,
                                width = ?, height = ?, depth = ?, slice_count = ?, pixel_file = ?, pixel_bytes = ?,
                                source_path = ?, source_part = ?, source_fingerprint = ?,
                                row_x = ?, row_y = ?, row_z = ?, column_x = ?, column_y = ?, column_z = ?,
                                value_slope = ?, value_intercept = ?, value_units = ?, min_value = ?, max_value = ?,
                                format_version = ?, study_instance_uid = ?, frame_of_reference_uid = ?,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?""")
                            .params(volumeParams(patientId, v, pixelFileName, replaceVolumeId))
                            .update();
                    jdbc.sql("DELETE FROM slices WHERE volume_id = ?").param(replaceVolumeId).update();
                    id = replaceVolumeId;
                } else {
                    jdbc.sql("""
                            INSERT INTO volumes (patient_id, name, modality, series_instance_uid, width, height,
                                depth, slice_count, pixel_file, pixel_bytes, source_path, source_part,
                                source_fingerprint, row_x, row_y, row_z, column_x, column_y, column_z,
                                value_slope, value_intercept, value_units, min_value, max_value, format_version,
                                study_instance_uid, frame_of_reference_uid)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""")
                            .params(volumeParams(patientId, v, pixelFileName, null))
                            .update();
                    id = lastInsertId();
                }

                int position = 0;
                for (var s : v.slices()) {
                    var source = v.sources() == null ? new SourceImage(null, null) : v.sources().get(position);
                    jdbc.sql("""
                            INSERT INTO slices (volume_id, position, slice_index, width_px, height_px, width_mm,
                                height_mm, depth_position_mm, origin_x_mm, origin_y_mm, spacing_x_mm, spacing_y_mm,
                                position_x_mm, position_y_mm, position_z_mm, sop_class_uid, sop_instance_uid)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""")
                            .params(id, position++, s.index(), s.widthPixels(), s.heightPixels(), s.widthMm(),
                                    s.heightMm(), s.depthPositionMm(), s.originXMm(), s.originYMm(),
                                    s.pixelSpacingXMm(), s.pixelSpacingYMm(),
                                    s.positionXMm(), s.positionYMm(), s.positionZMm(),
                                    source.sopClassUid(), source.sopInstanceUid())
                            .update();
                }

                if (v.sourcePath() != null) {
                    jdbc.sql("DELETE FROM import_failures WHERE source_path = ?").param(v.sourcePath()).update();
                }

                // Moved before commit so a committed row always has its file; a failed commit leaves an
                // unreferenced file that is deleted below (or by removeOrphanedFiles on the next start).
                try {
                    Files.move(tmpPixelFile, pixelFile, StandardCopyOption.ATOMIC_MOVE);
                } catch (IOException e) {
                    throw new UncheckedIOException(e);
                }
                return new VolumeKey(patientId, id);
            });
        } catch (RuntimeException e) {
            deleteQuietly(pixelFile);
            deleteQuietly(tmpPixelFile);
            throw e;
        }

        if (previousPixelFile[0] != null) {
            deleteQuietly(paths.pixelFile(previousPixelFile[0]));
        }
        return key;
    }

    public void recordFailure(String sourcePath, String fingerprint, String error) {
        write(() -> jdbc.sql("""
                INSERT INTO import_failures (source_path, fingerprint, error) VALUES (?, ?, ?)
                ON CONFLICT (source_path) DO UPDATE
                    SET fingerprint = excluded.fingerprint, error = excluded.error, failed_at = CURRENT_TIMESTAMP""")
                .params(sourcePath, fingerprint, error)
                .update());
    }

    public void clearFailure(String sourcePath) {
        write(() -> jdbc.sql("DELETE FROM import_failures WHERE source_path = ?").param(sourcePath).update());
    }

    public void deleteVolume(int patientId, int volumeId) {
        var labelFiles = new ArrayList<String>();
        var pixelFile = write(() -> {
            var row = jdbc.sql("""
                    SELECT pixel_file, source_path, source_part FROM volumes WHERE id = ? AND patient_id = ?""")
                    .param(volumeId)
                    .param(patientId)
                    .query((rs, n) -> new DeletedRow(rs.getString(1), rs.getString(2), rs.getString(3)))
                    .optional()
                    .orElseThrow(() -> new NoSuchElementException("Volume not found"));
            if (row.sourcePath() != null) {
                excludeSource(row.sourcePath(), row.sourcePart());
            }
            labelFiles.addAll(labelFilesOfVolumes("volume_id = ?", volumeId));
            jdbc.sql("DELETE FROM volumes WHERE id = ?").param(volumeId).update();
            return row.pixelFile();
        });
        deleteQuietly(paths.pixelFile(pixelFile));
        labelFiles.forEach(f -> deleteQuietly(paths.labelFile(f)));
    }

    /** Removes a volume whose data-directory source no longer produces it; unlike a delete, it isn't excluded. */
    public void removeVolume(int volumeId) {
        var labelFiles = new ArrayList<String>();
        var pixelFile = write(() -> {
            var file = jdbc.sql("SELECT pixel_file FROM volumes WHERE id = ?").param(volumeId)
                    .query(String.class).single();
            labelFiles.addAll(labelFilesOfVolumes("volume_id = ?", volumeId));
            jdbc.sql("DELETE FROM volumes WHERE id = ?").param(volumeId).update();
            return file;
        });
        deleteQuietly(paths.pixelFile(pixelFile));
        labelFiles.forEach(f -> deleteQuietly(paths.labelFile(f)));
    }

    public void deletePatient(int patientId) {
        var labelFiles = new ArrayList<String>();
        var pixelFiles = write(() -> {
            getPatient(patientId);
            jdbc.sql("""
                    SELECT source_path, source_part FROM volumes WHERE patient_id = ? AND source_path IS NOT NULL""")
                    .param(patientId)
                    .query(rs -> {
                        excludeSource(rs.getString(1), rs.getString(2));
                    });
            var files = jdbc.sql("SELECT pixel_file FROM volumes WHERE patient_id = ?")
                    .param(patientId).query(String.class).list();
            labelFiles.addAll(labelFilesOfVolumes(
                    "volume_id IN (SELECT id FROM volumes WHERE patient_id = ?)", patientId));
            jdbc.sql("DELETE FROM patients WHERE id = ?").param(patientId).update();
            return files;
        });
        pixelFiles.forEach(f -> deleteQuietly(paths.pixelFile(f)));
        labelFiles.forEach(f -> deleteQuietly(paths.labelFile(f)));
    }

    // ---- helpers ----

    /** Runs work in a transaction, serialised with every other store write. */
    <T> T write(Supplier<T> work) {
        writeLock.lock();
        try {
            return tx.execute(status -> work.get());
        } finally {
            writeLock.unlock();
        }
    }

    private int resolvePatient(PatientRef owner) {
        if (owner.patientId() != null) {
            return getPatient(owner.patientId()).patientId();
        }
        var existing = findPatientIdByName(owner.name());
        if (existing.isPresent()) {
            return existing.get();
        }
        jdbc.sql("INSERT INTO patients (name, dicom_patient_id) VALUES (?, ?)")
                .params(owner.name(), owner.dicomPatientId())
                .update();
        return lastInsertId();
    }

    // Only valid inside a transaction, where the same connection performed the INSERT.
    int lastInsertId() {
        return jdbc.sql("SELECT last_insert_rowid()").query(Integer.class).single();
    }

    private List<String> labelFilesOfVolumes(String condition, int param) {
        return jdbc.sql("SELECT label_file FROM segmentations WHERE " + condition).param(param)
                .query(String.class).list();
    }

    private void excludeSource(String sourcePath, String sourcePart) {
        jdbc.sql("INSERT OR IGNORE INTO excluded_sources (source_path, source_part) VALUES (?, ?)")
                .params(sourcePath, sourcePart).update();
    }

    private static Object[] volumeParams(int patientId, NewVolume v, String pixelFileName, Integer id) {
        var row = v.rowDirection();
        var column = v.columnDirection();
        var values = v.values();
        var params = new ArrayList<Object>(List.of(patientId, v.name(), v.modality()));
        params.add(v.seriesInstanceUid());
        params.addAll(List.of(v.width(), v.height(), v.depth(), v.slices().size(), pixelFileName, v.pixelBytes()));
        params.add(v.sourcePath());
        params.add(v.sourcePart());
        params.add(v.sourceFingerprint());
        params.addAll(List.of(row[0], row[1], row[2], column[0], column[1], column[2]));
        params.addAll(List.of(values.slope(), values.intercept(), values.units(), values.minValue(),
                values.maxValue(), v.formatVersion()));
        params.add(v.studyInstanceUid());
        params.add(v.frameOfReferenceUid());
        if (id != null) {
            params.add(id);
        }
        return params.toArray();
    }

    private static Volume volumeFromRow(ResultSet rs, Patient patient, List<Slice> slices) throws SQLException {
        return new Volume(rs.getInt("id"), patient.patientId(), rs.getString("name"), rs.getString("modality"),
                patient, slices, rs.getInt("width"), rs.getInt("height"), rs.getInt("depth"),
                new double[] {rs.getDouble("row_x"), rs.getDouble("row_y"), rs.getDouble("row_z")},
                new double[] {rs.getDouble("column_x"), rs.getDouble("column_y"), rs.getDouble("column_z")},
                rs.getDouble("value_slope"), rs.getDouble("value_intercept"), rs.getString("value_units"),
                rs.getDouble("min_value"), rs.getDouble("max_value"), rs.getInt("format_version"));
    }

    /**
     * Upgrades an older store in place, one version at a time. Runs before schema.sql, on one connection. Version 1
     * rebuilds the volumes table with foreign keys off, as SQLite can't drop the old UNIQUE (source_path) constraint.
     */
    private void migrate(DataSource dataSource) {
        try (var connection = dataSource.getConnection(); var statement = connection.createStatement()) {
            int version;
            try (var rs = statement.executeQuery("PRAGMA user_version")) {
                version = rs.getInt(1);
            }
            boolean existing;
            try (var rs = statement.executeQuery(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'volumes'")) {
                existing = rs.getInt(1) > 0;
            }
            if (!existing) {
                return;
            }
            if (version < 1) {
                migrateStep(connection, 1, () -> {
                    ScriptUtils.executeSqlScript(connection, new ClassPathResource("store/migrate-v1.sql"));
                    fillValueRanges(connection);
                });
            }
            if (version < 2) {
                migrateStep(connection, 2, () ->
                        ScriptUtils.executeSqlScript(connection, new ClassPathResource("store/migrate-v2.sql")));
            }
        } catch (SQLException e) {
            throw new IllegalStateException("Could not upgrade the store", e);
        }
    }

    private interface MigrationWork {
        void run() throws SQLException;
    }

    private void migrateStep(Connection connection, int version, MigrationWork work) throws SQLException {
        LOG.info("Upgrading store {} to version {}", paths.database(), version);
        try (var statement = connection.createStatement()) {
            statement.execute("PRAGMA foreign_keys = OFF");
            try {
                connection.setAutoCommit(false);
                work.run();
                statement.execute("PRAGMA user_version = " + version);
                connection.commit();
            } catch (SQLException | RuntimeException e) {
                connection.rollback();
                throw e;
            } finally {
                connection.setAutoCommit(true);
                statement.execute("PRAGMA foreign_keys = ON");
            }
        }
    }

    // Volumes imported before value ranges were recorded: read them from the pixel files.
    private void fillValueRanges(Connection connection) throws SQLException {
        var files = new LinkedHashMap<Integer, String>();
        try (var statement = connection.createStatement();
                var rs = statement.executeQuery("SELECT id, pixel_file FROM volumes")) {
            while (rs.next()) {
                files.put(rs.getInt(1), rs.getString(2));
            }
        }
        try (var update = connection.prepareStatement("UPDATE volumes SET min_value = ?, max_value = ? WHERE id = ?")) {
            for (var entry : files.entrySet()) {
                int min = 0;
                int max = 0;
                var file = paths.pixelFile(entry.getValue());
                if (Files.exists(file)) {
                    try (var channel = FileChannel.open(file, StandardOpenOption.READ)) {
                        var pixels = channel.map(FileChannel.MapMode.READ_ONLY, 0, channel.size())
                                .order(ByteOrder.LITTLE_ENDIAN).asShortBuffer();
                        min = Short.MAX_VALUE;
                        max = Short.MIN_VALUE;
                        while (pixels.hasRemaining()) {
                            short value = pixels.get();
                            min = Math.min(min, value);
                            max = Math.max(max, value);
                        }
                        if (min > max) {
                            min = max = 0;
                        }
                    } catch (IOException e) {
                        throw new UncheckedIOException(e);
                    }
                }
                update.setInt(1, min);
                update.setInt(2, max);
                update.setInt(3, entry.getKey());
                update.executeUpdate();
            }
        }
    }

    private void removeOrphanedFiles() {
        try {
            try (var tmp = Files.walk(paths.tmp())) {
                tmp.sorted(Comparator.reverseOrder())
                        .filter(p -> !p.equals(paths.tmp()))
                        .forEach(VolumeStore::deleteQuietly);
            }
            var referenced = new HashSet<>(jdbc.sql("SELECT pixel_file FROM volumes").query(String.class).list());
            try (var files = Files.list(paths.volumes())) {
                files.filter(p -> !referenced.contains(p.getFileName().toString())).forEach(p -> {
                    LOG.warn("Removing orphaned pixel file {}", p);
                    deleteQuietly(p);
                });
            }
            var labels = new HashSet<>(jdbc.sql("SELECT label_file FROM segmentations").query(String.class).list());
            try (var files = Files.list(paths.segmentations())) {
                files.filter(p -> !labels.contains(p.getFileName().toString())).forEach(p -> {
                    LOG.warn("Removing orphaned label file {}", p);
                    deleteQuietly(p);
                });
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public static void deleteQuietly(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (IOException e) {
            LOG.warn("Could not delete {}", path, e);
        }
    }
}
