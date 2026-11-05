package com.medicaljava.volumerestservice.store;

import com.medicaljava.volumerestservice.model.Patient;
import com.medicaljava.volumerestservice.model.Slice;
import com.medicaljava.volumerestservice.model.Volume;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
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

    /** Volume metadata without pixels, ready to be stored alongside a pixel file. */
    public record NewVolume(
            String name,
            String modality,
            String seriesInstanceUid,
            String sourcePath,
            String sourceFingerprint,
            int width,
            int height,
            int depth,
            List<Slice> slices,
            long pixelBytes) {}

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

    public record SourceState(int volumeId, String fingerprint) {}

    public record ImportFailure(String sourcePath, String fingerprint, String error, String failedAt) {}

    private final JdbcClient jdbc;
    private final TransactionTemplate tx;
    private final StorePaths paths;
    private final ReentrantLock writeLock = new ReentrantLock();

    public VolumeStore(DataSource dataSource, JdbcClient jdbc, PlatformTransactionManager txManager,
            StorePaths paths) {
        this.jdbc = jdbc;
        this.tx = new TransactionTemplate(txManager);
        this.paths = paths;
        new ResourceDatabasePopulator(new ClassPathResource("store/schema.sql")).execute(dataSource);
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
        record Row(Volume volume, String pixelFile, long pixelBytes) {}
        var row = jdbc.sql("SELECT * FROM volumes WHERE id = ? AND patient_id = ?")
                .param(volumeId)
                .param(patientId)
                .query((rs, n) -> new Row(volumeFromRow(rs, patient, List.of()), rs.getString("pixel_file"),
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
                        rs.getDouble("spacing_x_mm"), rs.getDouble("spacing_y_mm"), new short[0]))
                .list();

        var volume = row.volume().withSlicesAndSpatial(slices, row.volume().width(), row.volume().height(),
                row.volume().depth());
        return new StoredVolume(volume, paths.pixelFile(row.pixelFile()), row.pixelBytes());
    }

    public boolean hasSeries(int patientId, String seriesInstanceUid) {
        return jdbc.sql("SELECT COUNT(*) FROM volumes WHERE patient_id = ? AND series_instance_uid = ?")
                .param(patientId)
                .param(seriesInstanceUid)
                .query(Integer.class)
                .single() > 0;
    }

    public Map<String, SourceState> volumeSources() {
        var sources = new HashMap<String, SourceState>();
        jdbc.sql("SELECT source_path, id, source_fingerprint FROM volumes WHERE source_path IS NOT NULL")
                .query(rs -> {
                    sources.put(rs.getString(1), new SourceState(rs.getInt(2), rs.getString(3)));
                });
        return sources;
    }

    public Set<String> excludedSources() {
        return new HashSet<>(jdbc.sql("SELECT source_path FROM excluded_sources").query(String.class).list());
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
                                source_path = ?, source_fingerprint = ?, updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?""")
                            .params(patientId, v.name(), v.modality(), v.seriesInstanceUid(),
                                    v.width(), v.height(), v.depth(), v.slices().size(), pixelFileName,
                                    v.pixelBytes(), v.sourcePath(), v.sourceFingerprint(), replaceVolumeId)
                            .update();
                    jdbc.sql("DELETE FROM slices WHERE volume_id = ?").param(replaceVolumeId).update();
                    id = replaceVolumeId;
                } else {
                    jdbc.sql("""
                            INSERT INTO volumes (patient_id, name, modality, series_instance_uid, width, height,
                                depth, slice_count, pixel_file, pixel_bytes, source_path, source_fingerprint)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""")
                            .params(patientId, v.name(), v.modality(), v.seriesInstanceUid(),
                                    v.width(), v.height(), v.depth(), v.slices().size(), pixelFileName,
                                    v.pixelBytes(), v.sourcePath(), v.sourceFingerprint())
                            .update();
                    id = lastInsertId();
                }

                int position = 0;
                for (var s : v.slices()) {
                    jdbc.sql("""
                            INSERT INTO slices (volume_id, position, slice_index, width_px, height_px, width_mm,
                                height_mm, depth_position_mm, origin_x_mm, origin_y_mm, spacing_x_mm, spacing_y_mm)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""")
                            .params(id, position++, s.index(), s.widthPixels(), s.heightPixels(), s.widthMm(),
                                    s.heightMm(), s.depthPositionMm(), s.originXMm(), s.originYMm(),
                                    s.pixelSpacingXMm(), s.pixelSpacingYMm())
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
        var pixelFile = write(() -> {
            record Row(String pixelFile, String sourcePath) {}
            var row = jdbc.sql("SELECT pixel_file, source_path FROM volumes WHERE id = ? AND patient_id = ?")
                    .param(volumeId)
                    .param(patientId)
                    .query((rs, n) -> new Row(rs.getString(1), rs.getString(2)))
                    .optional()
                    .orElseThrow(() -> new NoSuchElementException("Volume not found"));
            if (row.sourcePath() != null) {
                excludeSource(row.sourcePath());
            }
            jdbc.sql("DELETE FROM volumes WHERE id = ?").param(volumeId).update();
            return row.pixelFile();
        });
        deleteQuietly(paths.pixelFile(pixelFile));
    }

    public void deletePatient(int patientId) {
        var pixelFiles = write(() -> {
            getPatient(patientId);
            jdbc.sql("SELECT source_path FROM volumes WHERE patient_id = ? AND source_path IS NOT NULL")
                    .param(patientId).query(String.class).list()
                    .forEach(this::excludeSource);
            var files = jdbc.sql("SELECT pixel_file FROM volumes WHERE patient_id = ?")
                    .param(patientId).query(String.class).list();
            jdbc.sql("DELETE FROM patients WHERE id = ?").param(patientId).update();
            return files;
        });
        pixelFiles.forEach(f -> deleteQuietly(paths.pixelFile(f)));
    }

    // ---- helpers ----

    private <T> T write(Supplier<T> work) {
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
    private int lastInsertId() {
        return jdbc.sql("SELECT last_insert_rowid()").query(Integer.class).single();
    }

    private void excludeSource(String sourcePath) {
        jdbc.sql("INSERT OR IGNORE INTO excluded_sources (source_path) VALUES (?)").param(sourcePath).update();
    }

    private static Volume volumeFromRow(ResultSet rs, Patient patient, List<Slice> slices) throws SQLException {
        return new Volume(rs.getInt("id"), patient.patientId(), rs.getString("name"), rs.getString("modality"),
                patient, slices, rs.getInt("width"), rs.getInt("height"), rs.getInt("depth"));
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
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static void deleteQuietly(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (IOException e) {
            LOG.warn("Could not delete {}", path, e);
        }
    }
}
