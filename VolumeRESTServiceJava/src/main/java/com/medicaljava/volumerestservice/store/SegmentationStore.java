package com.medicaljava.volumerestservice.store;

import com.medicaljava.volumerestservice.model.Segment;
import com.medicaljava.volumerestservice.model.Segmentation;
import com.medicaljava.volumerestservice.model.Volume;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import java.util.zip.GZIPOutputStream;

/**
 * Segmentations of stored volumes: metadata in SQLite, labels in one gzip file per segmentation under
 * {@code segmentations/}. Each write of the labels uses a fresh file name, like volume pixel files.
 */
@Component
public class SegmentationStore {

    public static final Set<String> ALGORITHM_TYPES = Set.of("MANUAL", "SEMIAUTOMATIC", "AUTOMATIC");
    private static final Pattern COLOR = Pattern.compile("#[0-9a-fA-F]{6}");
    private static final int MAX_NAME_LENGTH = 200;

    /** A segmentation's label file (gzip of voxelCount uint8 labels) and the volume it belongs to. */
    public record StoredLabels(Segmentation segmentation, VolumeStore.StoredVolume volume, Path labelFile) {}

    private record Row(Segmentation segmentation, String labelFile, String geometryHash) {}

    private final VolumeStore volumes;
    private final JdbcClient jdbc;
    private final StorePaths paths;

    public SegmentationStore(VolumeStore volumes, JdbcClient jdbc, StorePaths paths) {
        this.volumes = volumes;
        this.jdbc = jdbc;
        this.paths = paths;
    }

    /** Number of labels a segmentation of the volume has: one per voxel. */
    public static long voxelCount(Volume volume) {
        return volume.slices().stream().mapToLong(s -> (long) s.widthPixels() * s.heightPixels()).sum();
    }

    // ---- reads ----

    public List<Segmentation> list(int patientId, int volumeId) {
        var volume = volumes.getVolume(patientId, volumeId).volume();
        var hash = VolumeStore.geometryHash(volume);
        var rows = jdbc.sql("SELECT * FROM segmentations WHERE volume_id = ? ORDER BY name, id")
                .param(volumeId)
                .query((rs, n) -> new Row(new Segmentation(rs.getInt("id"), volumeId, patientId, rs.getString("name"),
                        rs.getString("source"), rs.getInt("revision"), timestamp(rs.getString("created_at")),
                        timestamp(rs.getString("modified_at")), rs.getLong("voxel_count"),
                        !hash.equals(rs.getString("geometry_hash")), List.of()),
                        rs.getString("label_file"), rs.getString("geometry_hash")))
                .list();
        var segments = segmentsOfVolume(volumeId);
        return rows.stream().map(r -> withSegments(r.segmentation(),
                segments.getOrDefault(r.segmentation().segmentationId(), List.of()))).toList();
    }

    public Segmentation get(int patientId, int volumeId, int segmentationId) {
        var volume = volumes.getVolume(patientId, volumeId).volume();
        return row(volume, segmentationId).segmentation();
    }

    public StoredLabels labels(int patientId, int volumeId, int segmentationId) {
        var volume = volumes.getVolume(patientId, volumeId);
        var row = row(volume.volume(), segmentationId);
        return new StoredLabels(row.segmentation(), volume, paths.labelFile(row.labelFile()));
    }

    // ---- writes ----

    /**
     * Creates a segmentation of the volume. {@code labels} supplies the volume's voxel count of raw uint8 labels;
     * when null, every voxel starts as background.
     */
    public Segmentation create(int patientId, int volumeId, String name, String source, List<Segment> segments,
            InputStream labels) throws IOException {
        var volume = volumes.getVolume(patientId, volumeId).volume();
        var cleanName = checkName(name);
        var cleanSegments = checkSegments(segments);
        long voxelCount = voxelCount(volume);
        var hash = VolumeStore.geometryHash(volume);

        var fileName = UUID.randomUUID() + ".seg.gz";
        var target = paths.labelFile(fileName);
        var tmp = writeLabels(labels, voxelCount);
        try {
            int id = volumes.write(() -> {
                volumes.getVolume(patientId, volumeId);
                jdbc.sql("""
                        INSERT INTO segmentations (volume_id, name, source, label_file, voxel_count, geometry_hash)
                        VALUES (?, ?, ?, ?, ?, ?)""")
                        .params(volumeId, cleanName, source == null ? "manual" : source, fileName, voxelCount, hash)
                        .update();
                int newId = volumes.lastInsertId();
                insertSegments(newId, cleanSegments);
                move(tmp, target);
                return newId;
            });
            return get(patientId, volumeId, id);
        } catch (RuntimeException e) {
            VolumeStore.deleteQuietly(target);
            throw e;
        } finally {
            VolumeStore.deleteQuietly(tmp);
        }
    }

    /** Renames the segmentation and/or replaces its segment table; null arguments are left unchanged. */
    public Segmentation update(int patientId, int volumeId, int segmentationId, Integer expectedRevision, String name,
            List<Segment> segments) {
        var volume = volumes.getVolume(patientId, volumeId).volume();
        var cleanName = name == null ? null : checkName(name);
        var cleanSegments = segments == null ? null : checkSegments(segments);
        volumes.write(() -> {
            checkRevision(row(volume, segmentationId).segmentation(), expectedRevision);
            if (cleanName != null) {
                jdbc.sql("UPDATE segmentations SET name = ? WHERE id = ?").params(cleanName, segmentationId).update();
            }
            if (cleanSegments != null) {
                jdbc.sql("DELETE FROM segments WHERE segmentation_id = ?").param(segmentationId).update();
                insertSegments(segmentationId, cleanSegments);
            }
            touch(segmentationId);
            return null;
        });
        return get(patientId, volumeId, segmentationId);
    }

    /**
     * Replaces the labels with {@code labels} (raw uint8, one per voxel of the volume as it is now). This also
     * brings a stale segmentation up to date with the volume's current geometry.
     */
    public Segmentation replaceLabels(int patientId, int volumeId, int segmentationId, Integer expectedRevision,
            InputStream labels) throws IOException {
        var volume = volumes.getVolume(patientId, volumeId).volume();
        row(volume, segmentationId);
        long voxelCount = voxelCount(volume);
        var hash = VolumeStore.geometryHash(volume);

        var fileName = UUID.randomUUID() + ".seg.gz";
        var target = paths.labelFile(fileName);
        var tmp = writeLabels(labels, voxelCount);
        String previous;
        try {
            previous = volumes.write(() -> {
                var current = row(volume, segmentationId);
                checkRevision(current.segmentation(), expectedRevision);
                jdbc.sql("""
                        UPDATE segmentations SET label_file = ?, voxel_count = ?, geometry_hash = ? WHERE id = ?""")
                        .params(fileName, voxelCount, hash, segmentationId)
                        .update();
                touch(segmentationId);
                move(tmp, target);
                return current.labelFile();
            });
        } catch (RuntimeException e) {
            VolumeStore.deleteQuietly(target);
            throw e;
        } finally {
            VolumeStore.deleteQuietly(tmp);
        }
        VolumeStore.deleteQuietly(paths.labelFile(previous));
        return get(patientId, volumeId, segmentationId);
    }

    public void delete(int patientId, int volumeId, int segmentationId) {
        var volume = volumes.getVolume(patientId, volumeId).volume();
        var file = volumes.write(() -> {
            var row = row(volume, segmentationId);
            jdbc.sql("DELETE FROM segmentations WHERE id = ?").param(segmentationId).update();
            return row.labelFile();
        });
        VolumeStore.deleteQuietly(paths.labelFile(file));
    }

    // ---- helpers ----

    private Row row(Volume volume, int segmentationId) {
        var hash = VolumeStore.geometryHash(volume);
        var row = jdbc.sql("SELECT * FROM segmentations WHERE id = ? AND volume_id = ?")
                .param(segmentationId)
                .param(volume.volumeId())
                .query((rs, n) -> new Row(new Segmentation(rs.getInt("id"), volume.volumeId(), volume.patientId(),
                        rs.getString("name"), rs.getString("source"), rs.getInt("revision"),
                        timestamp(rs.getString("created_at")), timestamp(rs.getString("modified_at")),
                        rs.getLong("voxel_count"), !hash.equals(rs.getString("geometry_hash")), List.of()),
                        rs.getString("label_file"), rs.getString("geometry_hash")))
                .optional()
                .orElseThrow(() -> new NoSuchElementException("Segmentation not found"));
        var segments = jdbc.sql("""
                SELECT label, name, color, algorithm_type FROM segments WHERE segmentation_id = ? ORDER BY label""")
                .param(segmentationId)
                .query((rs, n) -> new Segment(rs.getInt(1), rs.getString(2), rs.getString(3), rs.getString(4)))
                .list();
        return new Row(withSegments(row.segmentation(), segments), row.labelFile(), row.geometryHash());
    }

    private Map<Integer, List<Segment>> segmentsOfVolume(int volumeId) {
        var result = new HashMap<Integer, List<Segment>>();
        jdbc.sql("""
                SELECT s.segmentation_id, s.label, s.name, s.color, s.algorithm_type
                FROM segments s JOIN segmentations g ON g.id = s.segmentation_id
                WHERE g.volume_id = ? ORDER BY s.segmentation_id, s.label""")
                .param(volumeId)
                .query(rs -> {
                    result.computeIfAbsent(rs.getInt(1), k -> new ArrayList<>())
                            .add(new Segment(rs.getInt(2), rs.getString(3), rs.getString(4), rs.getString(5)));
                });
        return result;
    }

    private static Segmentation withSegments(Segmentation s, List<Segment> segments) {
        return new Segmentation(s.segmentationId(), s.volumeId(), s.patientId(), s.name(), s.source(), s.revision(),
                s.createdAt(), s.modifiedAt(), s.voxelCount(), s.stale(), segments);
    }

    private void insertSegments(int segmentationId, List<Segment> segments) {
        for (var segment : segments) {
            jdbc.sql("""
                    INSERT INTO segments (segmentation_id, label, name, color, algorithm_type) VALUES (?, ?, ?, ?, ?)""")
                    .params(segmentationId, segment.label(), segment.name(), segment.color(), segment.algorithmType())
                    .update();
        }
    }

    private void touch(int segmentationId) {
        jdbc.sql("UPDATE segmentations SET revision = revision + 1, modified_at = CURRENT_TIMESTAMP WHERE id = ?")
                .param(segmentationId)
                .update();
    }

    private static void checkRevision(Segmentation current, Integer expected) {
        if (expected != null && expected != current.revision()) {
            throw new PreconditionFailedException("The segmentation was changed elsewhere (revision "
                    + current.revision() + ", expected " + expected + "). Reload it to see the changes.");
        }
    }

    private static String checkName(String name) {
        if (name == null || name.isBlank()) {
            throw new InvalidSegmentationException("A segmentation needs a name");
        }
        var stripped = name.strip();
        if (stripped.length() > MAX_NAME_LENGTH) {
            throw new InvalidSegmentationException("Name is longer than " + MAX_NAME_LENGTH + " characters");
        }
        return stripped;
    }

    static List<Segment> checkSegments(List<Segment> segments) {
        if (segments == null) {
            return List.of();
        }
        var labels = new HashSet<Integer>();
        var clean = new ArrayList<Segment>();
        for (var s : segments) {
            if (s == null || s.label() < 1 || s.label() > 255) {
                throw new InvalidSegmentationException("Segment labels must be between 1 and 255");
            }
            if (!labels.add(s.label())) {
                throw new InvalidSegmentationException("Label " + s.label() + " is used by more than one segment");
            }
            if (s.color() == null || !COLOR.matcher(s.color()).matches()) {
                throw new InvalidSegmentationException("Segment colours must look like #rrggbb");
            }
            var type = s.algorithmType() == null ? "MANUAL" : s.algorithmType();
            if (!ALGORITHM_TYPES.contains(type)) {
                throw new InvalidSegmentationException("Unknown algorithm type " + type);
            }
            var name = s.name() == null || s.name().isBlank() ? "Segment " + s.label() : s.name().strip();
            if (name.length() > MAX_NAME_LENGTH) {
                throw new InvalidSegmentationException("Segment name is longer than " + MAX_NAME_LENGTH + " characters");
            }
            clean.add(new Segment(s.label(), name, s.color().toLowerCase(java.util.Locale.ROOT), type));
        }
        return clean;
    }

    // Compresses exactly voxelCount labels (zeros when labels is null) into a temporary file.
    private Path writeLabels(InputStream labels, long voxelCount) throws IOException {
        var tmp = Files.createTempFile(paths.tmp(), "labels-", ".seg.gz");
        try (var out = new GZIPOutputStream(new BufferedOutputStream(Files.newOutputStream(tmp)), 64 * 1024)) {
            var buffer = new byte[64 * 1024];
            long written = 0;
            if (labels == null) {
                while (written < voxelCount) {
                    int n = (int) Math.min(buffer.length, voxelCount - written);
                    out.write(buffer, 0, n);
                    written += n;
                }
            } else {
                for (int n; (n = labels.read(buffer)) > 0; ) {
                    written += n;
                    if (written > voxelCount) {
                        throw new InvalidSegmentationException("Labels are longer than the volume's " + voxelCount
                                + " voxels");
                    }
                    out.write(buffer, 0, n);
                }
                if (written != voxelCount) {
                    throw new InvalidSegmentationException("Got " + written + " labels for a volume of " + voxelCount
                            + " voxels");
                }
            }
        } catch (IOException | RuntimeException e) {
            VolumeStore.deleteQuietly(tmp);
            throw e;
        }
        return tmp;
    }

    private static void move(Path from, Path to) {
        try {
            Files.move(from, to, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    // SQLite's CURRENT_TIMESTAMP is UTC "YYYY-MM-DD HH:MM:SS".
    private static String timestamp(String sqlite) {
        return sqlite == null ? null : sqlite.replace(' ', 'T') + "Z";
    }
}
