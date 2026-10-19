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

import java.io.ByteArrayOutputStream;
import java.io.IOException;
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

    @Value("${app.data-dir:Data}")
    private String dataDir;

    // Falls back to the repo-root Data directory when running from VolumeRESTServiceJava/.
    private Path dataPath() {
        Path primary = Paths.get(dataDir);
        if (Files.isDirectory(primary)) {
            return primary;
        }
        Path fallback = Paths.get("..", "Data");
        return Files.isDirectory(fallback) ? fallback : primary;
    }

    // Directory order is filesystem-dependent; sorting keeps the positional ids stable.
    private static List<Path> listSorted(Path dir, DirectoryStream.Filter<Path> filter) throws IOException {
        List<Path> paths = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir, filter)) {
            stream.forEach(paths::add);
        }
        paths.sort(Comparator.comparing(p -> p.getFileName().toString()));
        return paths;
    }

    @Override
    public List<Patient> getPatientSummaries() {
        List<Patient> patients = new ArrayList<>();
        try {
            for (Path dir : listSorted(dataPath(), Files::isDirectory)) {
                Patient patient = new Patient(
                        patients.size() + 1,
                        dir.getFileName().toString(),
                        new ArrayList<>());
                patients.add(patient);
            }
        } catch (IOException e) {
            throw new RuntimeException(e);
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
        Patient patient = getPatientSummaries().stream()
                .filter(p -> p.patientId() == patientId)
                .findFirst()
                .orElseThrow(() -> new NoSuchElementException("Patient not found"));

        List<Volume> volumes = new ArrayList<>();
        Path patientDir = dataPath().resolve(patient.name());
        try {
            for (Path dir : listSorted(patientDir, Files::isDirectory)) {
                Volume volume = new Volume(
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
            throw new RuntimeException(e);
        }
        return volumes;
    }

    @Override
    public Volume getVolume(int patientId, int volumeId) {
        Volume volumeSummary = getVolumeSummaries(patientId).stream()
                .filter(v -> v.volumeId() == volumeId)
                .findFirst()
                .orElseThrow(() -> new NoSuchElementException("Volume not found"));

        Path seriesDir = dataPath()
                .resolve(volumeSummary.patient().name())
                .resolve(volumeSummary.name());

        List<Slice> slices = new ArrayList<>();
        int sliceIndex = 0;
        try {
            for (Path dicomFile : listSorted(seriesDir, Files::isRegularFile)) {
                try {
                    slices.add(readSlice(dicomFile, patientId, volumeId, sliceIndex));
                } catch (Exception e) {
                    LOG.warn("Skipping {}", dicomFile, e);
                }
                sliceIndex++;
            }
        } catch (IOException e) {
            throw new RuntimeException(e);
        }

        slices.sort((o1, o2) -> Double.compare(o1.depthPositionMm(), o2.depthPositionMm()));

        var firstSlice = slices.isEmpty() ? null : slices.get(0);
        var lastSlice = slices.isEmpty() ? null : slices.get(slices.size() - 1);

        volumeSummary = volumeSummary.withSlicesAndSpatial(
                slices,
                firstSlice == null ? 0 : (int) firstSlice.widthMm(),
                firstSlice == null ? 0 : (int) firstSlice.heightMm(),
                (int) ((lastSlice == null ? 0 : lastSlice.depthPositionMm())
                        - (firstSlice == null ? 0 : firstSlice.depthPositionMm())));
        return volumeSummary;
    }

    private Slice readSlice(Path dicomFile, int patientId, int volumeId, int sliceIndex) throws IOException {
        try (DicomInputStream dis = new DicomInputStream(dicomFile.toFile())) {
            Attributes dataset = dis.readDataset();

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

    private static short[] readPixels(Attributes dataset, String transferSyntax, int width, int height)
            throws IOException {
        int count = width * height;
        short[] pixels = new short[count];

        if (dataset.getValue(Tag.PixelData) instanceof Fragments fragments) {
            return readLosslessJpeg(dataset, fragments, transferSyntax, width, height);
        }

        if (dataset.contains(Tag.PixelData)) {
            int bitsAllocated = dataset.getInt(Tag.BitsAllocated, 16);
            if (bitsAllocated != 16) {
                throw new IOException("Unsupported BitsAllocated: " + bitsAllocated);
            }
            byte[] bytes = dataset.getBytes(Tag.PixelData);
            if (bytes.length < count * 2) {
                throw new IOException("Pixel data too short: " + bytes.length + " bytes for " + count + " pixels");
            }
            ByteOrder order = dataset.bigEndian() ? ByteOrder.BIG_ENDIAN : ByteOrder.LITTLE_ENDIAN;
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
        ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
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
