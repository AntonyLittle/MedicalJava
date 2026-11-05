package com.medicaljava.volumerestservice.repository;

import com.medicaljava.volumerestservice.model.Patient;
import com.medicaljava.volumerestservice.model.Slice;
import com.medicaljava.volumerestservice.model.Volume;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Fragments;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Repository;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;
import tools.jackson.databind.ObjectMapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.NoSuchElementException;

@Repository
public class PatientRepositoryImpl implements PatientRepository {

    private static final Logger LOG = LoggerFactory.getLogger(PatientRepositoryImpl.class);

    private final String dataDir;
    private final ObjectMapper objectMapper;

    public PatientRepositoryImpl(@Value("${app.data-dir:Data}") String dataDir, ObjectMapper objectMapper) {
        this.dataDir = dataDir;
        this.objectMapper = objectMapper;
    }

    // Falls back to the repo-root Data directory when running from
    // VolumeRESTServiceJava/.
    private Path dataPath() {
        var primary = Paths.get(dataDir);
        if (Files.isDirectory(primary)) {
            return primary;
        }
        var fallback = Paths.get("..", "Data");
        return Files.isDirectory(fallback) ? fallback : primary;
    }

    // Directory order is filesystem-dependent; sorting keeps the positional ids
    // stable.
    private static List<Path> listSorted(Path dir, DirectoryStream.Filter<Path> filter) throws IOException {
        var paths = new ArrayList<Path>();
        try (var stream = Files.newDirectoryStream(dir, filter)) {
            stream.forEach(paths::add);
        }
        paths.sort(Comparator.comparing(p -> p.getFileName().toString()));
        return paths;
    }

    @Override
    public List<Patient> getPatientSummaries() {
        var patients = new ArrayList<Patient>();
        try {
            for (var dir : listSorted(dataPath(), Files::isDirectory)) {
                var patient = new Patient(
                        patients.size() + 1,
                        dir.getFileName().toString(),
                        new ArrayList<>());
                patients.add(patient);
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return patients;
    }

    @Override
    public Patient getPatient(int patientId) {
        return getPatientSummaries().stream()
                .filter(p -> p.patientId() == patientId)
                .findFirst()
                .orElseThrow(() -> new NoSuchElementException("Patient not found"));
    }

    @Override
    public List<Volume> getVolumeSummaries(int patientId) {
        var patient = getPatient(patientId);

        var volumes = new ArrayList<Volume>();
        var patientDir = dataPath().resolve(patient.name());
        try {
            for (var dir : listSorted(patientDir, Files::isDirectory)) {
                var volume = new Volume(
                        volumes.size() + 1,
                        patientId,
                        dir.getFileName().toString(),
                        "CT",
                        patient,
                        new ArrayList<>(),
                        0, 0, 0);
                volumes.add(volume);
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return volumes;
    }

    @Override
    public Volume getVolume(int patientId, int volumeId) {
        var volumeSummary = getVolumeSummaries(patientId).stream()
                .filter(v -> v.volumeId() == volumeId)
                .findFirst()
                .orElseThrow(() -> new NoSuchElementException("Volume not found"));

        var seriesDir = dataPath()
                .resolve(volumeSummary.patient().name())
                .resolve(volumeSummary.name());

        var slices = new ArrayList<Slice>();
        int sliceIndex = 0;
        try {
            for (var dicomFile : listSorted(seriesDir, Files::isRegularFile)) {
                try {
                    slices.add(readSlice(dicomFile, patientId, volumeId, sliceIndex));
                } catch (Exception e) {
                    LOG.warn("Skipping {}", dicomFile, e);
                }
                sliceIndex++;
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }

        slices.sort(Comparator.comparingDouble(Slice::depthPositionMm));

        if (slices.isEmpty()) {
            return volumeSummary.withSlicesAndSpatial(slices, 0, 0, 0);
        }
        var firstSlice = slices.getFirst();
        var lastSlice = slices.getLast();
        return volumeSummary.withSlicesAndSpatial(
                slices,
                (int) firstSlice.widthMm(),
                (int) firstSlice.heightMm(),
                (int) (lastSlice.depthPositionMm() - firstSlice.depthPositionMm()));
    }

    private Slice readSlice(Path dicomFile, int patientId, int volumeId, int sliceIndex) throws IOException {
        try (var dis = new DicomInputStream(dicomFile.toFile())) {
            var dataset = dis.readDataset();

            int width = dataset.getInt(Tag.Columns, 0);
            int height = dataset.getInt(Tag.Rows, 0);
            short[] radiodensities = readPixels(dataset, dis.getTransferSyntax(), width, height);

            // DICOM PixelSpacing is [row spacing (y), column spacing (x)].
            var pixelSpacing = dataset.getDoubles(Tag.PixelSpacing);
            var imagePosition = dataset.getDoubles(Tag.ImagePositionPatient);
            if (pixelSpacing == null || pixelSpacing.length < 2
                    || imagePosition == null || imagePosition.length < 3) {
                throw new IOException("Missing PixelSpacing or ImagePositionPatient");
            }
            double pixelSpacingY = pixelSpacing[0];
            double pixelSpacingX = pixelSpacing[1];

            return new Slice(sliceIndex, volumeId, patientId, sliceIndex, width, height,
                    pixelSpacingX * width, pixelSpacingY * height, imagePosition[2],
                    imagePosition[0], imagePosition[1], pixelSpacingX, pixelSpacingY, radiodensities);
        }
    }

    /**
     * Same volume as getVolume but without JSON pixel arrays. Layout,
     * little-endian:
     * uint32 metadata length N, N bytes of UTF-8 JSON (slices carry empty
     * radiodensities), zero padding to a
     * 4-byte boundary, then every slice's width*height int16 pixels back to back in
     * the JSON slice order.
     */
    @Override
    public StreamingResponseBody getVolumeBinary(int patientId, int volumeId) {
        var volume = getVolume(patientId, volumeId);
        var metadata = objectMapper.writeValueAsBytes(volume.withoutPixels());

        return out -> {
            int headerLength = 4 + metadata.length;
            var header = ByteBuffer.allocate((headerLength + 3) & ~3).order(ByteOrder.LITTLE_ENDIAN);
            header.putInt(metadata.length).put(metadata);
            out.write(header.array());

            for (var slice : volume.slices()) {
                var pixels = ByteBuffer.allocate(slice.radiodensities().length * Short.BYTES)
                        .order(ByteOrder.LITTLE_ENDIAN);
                pixels.asShortBuffer().put(slice.radiodensities());
                out.write(pixels.array());
            }
        };
    }

    private static short[] readPixels(Attributes dataset, String transferSyntax, int width, int height)
            throws IOException {
        if (dataset.getValue(Tag.PixelData) instanceof Fragments fragments) {
            return readLosslessJpeg(dataset, fragments, transferSyntax, width, height);
        }

        int count = width * height;
        var pixels = new short[count];

        if (dataset.contains(Tag.PixelData)) {
            int bitsAllocated = dataset.getInt(Tag.BitsAllocated, 16);
            if (bitsAllocated != 16) {
                throw new IOException("Unsupported BitsAllocated: " + bitsAllocated);
            }
            byte[] bytes = dataset.getBytes(Tag.PixelData);
            if (bytes.length < count * 2) {
                throw new IOException("Pixel data too short: " + bytes.length + " bytes for " + count + " pixels");
            }
            var order = dataset.bigEndian() ? ByteOrder.BIG_ENDIAN : ByteOrder.LITTLE_ENDIAN;
            ByteBuffer.wrap(bytes).order(order).asShortBuffer().get(pixels);
        } else if (dataset.contains(Tag.FloatPixelData)) {
            float[] values = dataset.getFloats(Tag.FloatPixelData);
            if (values.length < count) {
                throw new IOException("Float pixel data too short");
            }
            for (int i = 0; i < count; i++) {
                pixels[i] = clampToShort(Math.round(values[i]));
            }
        } else if (dataset.contains(Tag.DoubleFloatPixelData)) {
            double[] values = dataset.getDoubles(Tag.DoubleFloatPixelData);
            if (values.length < count) {
                throw new IOException("Double pixel data too short");
            }
            for (int i = 0; i < count; i++) {
                pixels[i] = clampToShort(Math.round(values[i]));
            }
        } else {
            throw new IOException("No pixel data");
        }
        return pixels;
    }

    private static short[] readLosslessJpeg(Attributes dataset, Fragments fragments, String transferSyntax,
            int width, int height) throws IOException {
        if (!UID.JPEGLossless.equals(transferSyntax) && !UID.JPEGLosslessSV1.equals(transferSyntax)) {
            throw new IOException("Unsupported transfer syntax: " + transferSyntax);
        }
        if (dataset.getInt(Tag.NumberOfFrames, 1) > 1) {
            throw new IOException("Multi-frame compressed pixel data is not supported");
        }

        // Fragment 0 is the basic offset table.
        var jpeg = new ByteArrayOutputStream();
        for (int i = 1; i < fragments.size(); i++) {
            if (!(fragments.get(i) instanceof byte[] bytes)) {
                throw new IOException("Pixel data fragment was not loaded");
            }
            jpeg.writeBytes(bytes);
        }
        return JpegLosslessDecoder.decode(jpeg.toByteArray(), width, height);
    }

    private static short clampToShort(long value) {
        return (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, value));
    }
}
