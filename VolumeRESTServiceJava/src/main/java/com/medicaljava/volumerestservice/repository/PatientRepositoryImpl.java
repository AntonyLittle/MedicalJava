package com.medicaljava.volumerestservice.repository;

import com.medicaljava.volumerestservice.model.Patient;
import com.medicaljava.volumerestservice.model.Slice;
import com.medicaljava.volumerestservice.model.Volume;
import com.medicaljava.volumerestservice.store.VolumeStore;

import org.springframework.stereotype.Repository;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.Channels;
import java.nio.channels.FileChannel;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;

/** Serves patients and volumes from the {@link VolumeStore}; DICOM is decoded only at import time. */
@Repository
public class PatientRepositoryImpl implements PatientRepository {

    private final VolumeStore store;
    private final ObjectMapper objectMapper;

    public PatientRepositoryImpl(VolumeStore store, ObjectMapper objectMapper) {
        this.store = store;
        this.objectMapper = objectMapper;
    }

    @Override
    public List<Patient> getPatientSummaries() {
        return store.listPatients();
    }

    @Override
    public Patient getPatient(int patientId) {
        return store.getPatient(patientId);
    }

    @Override
    public List<Volume> getVolumeSummaries(int patientId) {
        return store.listVolumes(patientId);
    }

    @Override
    public Volume getVolume(int patientId, int volumeId) {
        var stored = store.getVolume(patientId, volumeId);
        var volume = stored.volume();
        var slices = new ArrayList<Slice>(volume.slices().size());
        try (var channel = FileChannel.open(stored.pixelFile(), StandardOpenOption.READ)) {
            checkSize(channel.size(), stored);
            var pixels = channel.map(FileChannel.MapMode.READ_ONLY, 0, channel.size())
                    .order(ByteOrder.LITTLE_ENDIAN)
                    .asShortBuffer();
            for (var slice : volume.slices()) {
                var radiodensities = new short[slice.widthPixels() * slice.heightPixels()];
                pixels.get(radiodensities);
                slices.add(slice.withPixels(radiodensities));
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return volume.withSlices(slices);
    }

    /**
     * Same volume as getVolume but without JSON pixel arrays. Layout, little-endian:
     * uint32 metadata length N, N bytes of UTF-8 JSON (slices carry empty radiodensities), zero padding to a
     * 4-byte boundary, then every slice's width*height int16 pixels back to back in the JSON slice order.
     * The pixel section is the stored .vol file, streamed as-is.
     */
    @Override
    public StreamingResponseBody getVolumeBinary(int patientId, int volumeId) {
        var stored = store.getVolume(patientId, volumeId);
        var metadata = objectMapper.writeValueAsBytes(stored.volume());

        return out -> {
            try (var channel = FileChannel.open(stored.pixelFile(), StandardOpenOption.READ)) {
                checkSize(channel.size(), stored);

                int headerLength = 4 + metadata.length;
                var header = ByteBuffer.allocate((headerLength + 3) & ~3).order(ByteOrder.LITTLE_ENDIAN);
                header.putInt(metadata.length).put(metadata);
                out.write(header.array());

                var target = Channels.newChannel(out);
                for (long position = 0, size = channel.size(); position < size; ) {
                    position += channel.transferTo(position, size - position, target);
                }
            }
        };
    }

    @Override
    public void deletePatient(int patientId) {
        store.deletePatient(patientId);
    }

    @Override
    public void deleteVolume(int patientId, int volumeId) {
        store.deleteVolume(patientId, volumeId);
    }

    private static void checkSize(long actual, VolumeStore.StoredVolume stored) {
        if (actual != stored.pixelBytes()) {
            throw new IllegalStateException("Pixel file " + stored.pixelFile() + " is " + actual
                    + " bytes, expected " + stored.pixelBytes());
        }
    }
}
