package com.medicaljava.volumerestservice.repository;

import com.medicaljava.volumerestservice.model.Patient;
import com.medicaljava.volumerestservice.model.Slice;
import com.medicaljava.volumerestservice.model.Volume;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomInputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Repository;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.NoSuchElementException;

@Repository
public class PatientRepositoryImpl implements PatientRepository {

    private static final Logger LOG = LoggerFactory.getLogger(PatientRepositoryImpl.class);

    @Value("${app.data-dir:Data}")
    private String dataDir;

    // Falls back to the demo data shipped alongside the original .NET project
    // if the configured directory isn't found relative to the working directory.
    private Path dataPath() {
        Path primary = Paths.get(dataDir);
        if (Files.isDirectory(primary)) {
            return primary;
        }
        Path fallback = Paths.get("..", "VolumeRESTServiceJava", "Data");
        return Files.isDirectory(fallback) ? fallback : primary;
    }

    @Override
    public List<Patient> getPatientSummaries() {
        List<Patient> patients = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(dataPath(), Files::isDirectory)) {
            for (Path dir : stream) {
                Patient patient = new Patient();
                patient.setPatientId(patients.size() + 1);
                patient.setName(dir.getFileName().toString());
                patient.setVolumes(new ArrayList<>());
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
                .filter(p -> p.getPatientId() == patientId)
                .findFirst()
                .orElseThrow(() -> new NoSuchElementException("Patient not found"));
    }

    @Override
    public List<Volume> getVolumeSummaries(int patientId) {
        Patient patient = getPatientSummaries().stream()
                .filter(p -> p.getPatientId() == patientId)
                .findFirst()
                .orElseThrow(() -> new NoSuchElementException("Patient not found"));

        List<Volume> volumes = new ArrayList<>();
        Path patientDir = dataPath().resolve(patient.getName());
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(patientDir, Files::isDirectory)) {
            for (Path dir : stream) {
                Volume volume = new Volume();
                volume.setPatientId(patientId);
                volume.setPatient(patient);
                volume.setVolumeId(volumes.size() + 1);
                volume.setName(dir.getFileName().toString());
                volume.setModality("CT");
                volume.setSlices(new ArrayList<>());
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
                .filter(v -> v.getVolumeId() == volumeId)
                .findFirst()
                .orElseThrow(() -> new NoSuchElementException("Volume not found"));

        Path seriesDir = dataPath()
                .resolve(volumeSummary.getPatient().getName())
                .resolve(volumeSummary.getName());

        List<Slice> slices = new ArrayList<>();
        int sliceIndex = 0;
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(seriesDir, Files::isRegularFile)) {
            for (Path dicomFile : stream) {
                try {
                    slices.add(readSlice(dicomFile, patientId, volumeId, sliceIndex));
                } catch (Exception e) {
                    LOG.debug(e.getMessage());
                }
                sliceIndex++;
            }
        } catch (IOException e) {
            throw new RuntimeException(e);
        }

        volumeSummary.setSlices(slices);
        return volumeSummary;
    }

    private Slice readSlice(Path dicomFile, int patientId, int volumeId, int sliceIndex) throws IOException {
        try (DicomInputStream dis = new DicomInputStream(dicomFile.toFile())) {
            Attributes dataset = dis.readDataset();

            int width = dataset.getInt(Tag.Columns, 0);
            int height = dataset.getInt(Tag.Rows, 0);
            byte[] pixelData = dataset.getBytes(Tag.PixelData);

            ByteOrder order = dataset.bigEndian() ? ByteOrder.BIG_ENDIAN : ByteOrder.LITTLE_ENDIAN;
            short[] radiodensities = new short[width * height];
            ByteBuffer.wrap(pixelData).order(order).asShortBuffer().get(radiodensities);

            Slice slice = new Slice();
            slice.setPatientId(patientId);
            slice.setVolumeId(volumeId);
            slice.setSliceId(sliceIndex);
            slice.setIndex(sliceIndex);
            slice.setWidth(width);
            slice.setHeight(height);
            slice.setRadiodensities(radiodensities);
            return slice;
        }
    }
}
