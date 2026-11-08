package com.medicaljava.volumerestservice.store;

import com.medicaljava.volumerestservice.model.Slice;
import com.medicaljava.volumerestservice.repository.DicomSeriesReader;
import com.medicaljava.volumerestservice.repository.DicomSeriesReader.DecodedSlice;
import com.medicaljava.volumerestservice.store.VolumeStore.NewVolume;
import com.medicaljava.volumerestservice.store.VolumeStore.PatientRef;
import com.medicaljava.volumerestservice.store.VolumeStore.VolumeKey;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.util.FileSystemUtils;
import org.springframework.util.unit.DataSize;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipInputStream;

/** Decodes DICOM series once and hands the result to {@link VolumeStore}. */
@Service
public class VolumeImporter {

    private static final Logger LOG = LoggerFactory.getLogger(VolumeImporter.class);
    private static final String DEFAULT_MODALITY = "CT";

    /**
     * Version of the decoding applied to stored volumes. 1 = rescale applied and native orientation kept; 2 = DICOM
     * study, frame of reference and instance UIDs kept. Data directory volumes stored by an older version are
     * re-imported by the next scan.
     */
    public static final int FORMAT_VERSION = 2;

    private final VolumeStore store;
    private final StorePaths paths;
    private final long maxExtractedBytes;

    public VolumeImporter(VolumeStore store, StorePaths paths,
            @Value("${app.upload.max-extracted-size:4GB}") DataSize maxExtractedSize) {
        this.store = store;
        this.paths = paths;
        this.maxExtractedBytes = maxExtractedSize.toBytes();
    }

    /**
     * Imports the files in {@code seriesDir} (unreadable ones are skipped) as one volume per stack of parallel
     * slices. Stacks already stored (by part, in {@code existingParts}) are replaced in place so their ids stay
     * stable, parts in {@code excludedParts} are skipped, and stored parts the directory no longer produces are
     * removed.
     */
    public List<VolumeKey> importDirectory(Path seriesDir, String patientName, String sourcePath, String fingerprint,
            Map<String, Integer> existingParts, Set<String> excludedParts) throws IOException {
        var decoded = new ArrayList<DecodedSlice>();
        int sliceIndex = 0;
        for (var file : listSortedFiles(seriesDir)) {
            try {
                decoded.add(DicomSeriesReader.read(file, sliceIndex));
            } catch (Exception e) {
                LOG.warn("Skipping {}", file, e);
            }
            sliceIndex++;
        }
        if (decoded.isEmpty()) {
            throw new InvalidDicomException("No readable DICOM images in " + sourcePath);
        }
        var owner = PatientRef.byName(patientName, decoded.getFirst().info().patientId());
        var parts = SeriesGeometry.split(decoded);

        var saved = new ArrayList<VolumeKey>();
        var produced = new HashSet<String>();
        for (var part : parts) {
            produced.add(part.key());
            if (excludedParts.contains(part.key())) {
                continue;
            }
            saved.add(save(owner, partName(seriesDir.getFileName().toString(), part), part, sourcePath, fingerprint,
                    existingParts.get(part.key())));
        }
        existingParts.forEach((key, volumeId) -> {
            if (!produced.contains(key)) {
                LOG.info("Removing {} part '{}', which the directory no longer contains", sourcePath, key);
                store.removeVolume(volumeId);
            }
        });
        return saved;
    }

    /**
     * Imports uploaded DICOM files (or zip archives of them), creating one volume per SeriesInstanceUID. With a
     * null {@code patientId}, each series is filed under the patient named in its DICOM tags.
     */
    public List<VolumeKey> importUpload(Integer patientId, List<MultipartFile> files) throws IOException {
        if (files == null || files.isEmpty()) {
            throw new InvalidDicomException("No files uploaded");
        }
        if (patientId != null) {
            store.getPatient(patientId);
        }

        var uploadDir = Files.createTempDirectory(paths.tmp(), "upload-");
        try {
            var series = new LinkedHashMap<String, List<DecodedSlice>>();
            int sliceIndex = 0;
            for (var file : stageUpload(files, uploadDir)) {
                try {
                    var slice = DicomSeriesReader.read(file, sliceIndex);
                    var uid = slice.info().seriesInstanceUid();
                    series.computeIfAbsent(uid == null ? "" : uid, k -> new ArrayList<>()).add(slice);
                    sliceIndex++;
                } catch (Exception e) {
                    LOG.info("Ignoring unreadable upload entry: {}", e.toString());
                }
            }
            if (series.isEmpty()) {
                throw new InvalidDicomException("Upload contains no readable DICOM images");
            }

            // Check every series before writing anything so a conflict or invalid geometry leaves the store untouched.
            var splits = series.values().stream().map(SeriesGeometry::split).toList();
            var owners = new ArrayList<PatientRef>();
            for (var entry : series.entrySet()) {
                var owner = patientId != null ? PatientRef.byId(patientId) : ownerFromTags(entry.getValue());
                var existingPatientId = owner.patientId() != null
                        ? owner.patientId()
                        : store.findPatientIdByName(owner.name()).orElse(null);
                if (!entry.getKey().isEmpty() && existingPatientId != null
                        && store.hasSeries(existingPatientId, entry.getKey())) {
                    throw new StoreConflictException("Series " + entry.getKey() + " is already stored for this patient");
                }
                owners.add(owner);
            }

            var saved = new ArrayList<VolumeKey>();
            int i = 0;
            for (var slices : series.values()) {
                var owner = owners.get(i);
                for (var part : splits.get(i++)) {
                    saved.add(save(owner, partName(uploadVolumeName(slices), part), part, null, null, null));
                }
            }
            return saved;
        } finally {
            FileSystemUtils.deleteRecursively(uploadDir);
        }
    }

    private static String partName(String name, SeriesGeometry.Part part) {
        return part.key().isEmpty() ? name : name + " (" + part.label() + ")";
    }

    private VolumeKey save(PatientRef owner, String name, SeriesGeometry.Part part, String sourcePath,
            String fingerprint, Integer replaceVolumeId) throws IOException {
        var decoded = part.slices();
        var info = decoded.getFirst().info();
        var modality = info.modality() == null || info.modality().isBlank() ? DEFAULT_MODALITY : info.modality();
        var values = PixelValues.encode(decoded, modality);

        // depthPositionMm becomes the distance along the stack's normal, which orders the slices.
        var normal = part.normal();
        var slices = decoded.stream()
                .map(d -> d.slice().withDepthPositionMm(SeriesGeometry.dot(normal, d.plane().position())))
                .toList();
        var first = slices.getFirst();
        var last = slices.getLast();

        var tmp = Files.createTempFile(paths.tmp(), "volume-", ".vol");
        try {
            long pixelBytes = writePixels(tmp, slices);
            var volume = new NewVolume(name, modality, info.seriesInstanceUid(), sourcePath, part.key(), fingerprint,
                    (int) first.widthMm(), (int) first.heightMm(),
                    (int) (last.depthPositionMm() - first.depthPositionMm()),
                    part.rowDirection(), part.columnDirection(), values, FORMAT_VERSION, slices, pixelBytes,
                    info.studyInstanceUid(), info.frameOfReferenceUid(),
                    decoded.stream().map(DecodedSlice::source).toList());
            return store.saveVolume(owner, volume, tmp, replaceVolumeId);
        } finally {
            VolumeStore.deleteQuietly(tmp);
        }
    }

    private static long writePixels(Path file, List<Slice> slices) throws IOException {
        long total = 0;
        try (var channel = FileChannel.open(file, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING)) {
            for (var slice : slices) {
                var buffer = ByteBuffer.allocate(slice.radiodensities().length * Short.BYTES)
                        .order(ByteOrder.LITTLE_ENDIAN);
                buffer.asShortBuffer().put(slice.radiodensities());
                while (buffer.hasRemaining()) {
                    total += channel.write(buffer);
                }
            }
            channel.force(true);
        }
        return total;
    }

    private List<Path> stageUpload(List<MultipartFile> files, Path dir) throws IOException {
        var staged = new ArrayList<Path>();
        long[] budget = {maxExtractedBytes};
        for (var file : files) {
            if (isZip(file)) {
                try (var zip = new ZipInputStream(file.getInputStream())) {
                    for (var entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) {
                        if (!entry.isDirectory()) {
                            // Entry names are never used as paths, so archives cannot write outside dir.
                            staged.add(copyBounded(zip, dir.resolve("entry-" + staged.size()), budget));
                        }
                    }
                }
            } else {
                try (var in = file.getInputStream()) {
                    staged.add(copyBounded(in, dir.resolve("file-" + staged.size()), budget));
                }
            }
        }
        return staged;
    }

    private static Path copyBounded(InputStream in, Path target, long[] budget) throws IOException {
        try (var out = Files.newOutputStream(target)) {
            var buffer = new byte[64 * 1024];
            for (int n; (n = in.read(buffer)) > 0; ) {
                budget[0] -= n;
                if (budget[0] < 0) {
                    throw new InvalidDicomException("Upload exceeds the maximum extracted size");
                }
                out.write(buffer, 0, n);
            }
        }
        return target;
    }

    private static boolean isZip(MultipartFile file) {
        var name = file.getOriginalFilename();
        var type = file.getContentType();
        return (name != null && name.toLowerCase(Locale.ROOT).endsWith(".zip"))
                || "application/zip".equals(type) || "application/x-zip-compressed".equals(type);
    }

    private static PatientRef ownerFromTags(List<DecodedSlice> slices) {
        var info = slices.getFirst().info();
        var name = firstNonBlank(info.patientName(), info.patientId(), "Unknown");
        return PatientRef.byName(name, info.patientId());
    }

    private static String uploadVolumeName(List<DecodedSlice> slices) {
        var info = slices.getFirst().info();
        var number = info.seriesNumber() == null ? null : "Series " + info.seriesNumber();
        var uid = info.seriesInstanceUid() == null ? null : "Series " + info.seriesInstanceUid();
        return firstNonBlank(info.seriesDescription(), number, uid, "Upload");
    }

    private static String firstNonBlank(String... values) {
        for (var v : values) {
            if (v != null && !v.isBlank()) {
                return v.strip();
            }
        }
        return null;
    }

    static List<Path> listSortedFiles(Path dir) throws IOException {
        try (var stream = Files.list(dir)) {
            return stream.filter(Files::isRegularFile)
                    .sorted(Comparator.comparing(p -> p.getFileName().toString()))
                    .toList();
        } catch (UncheckedIOException e) {
            throw e.getCause();
        }
    }
}
