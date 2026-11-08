package com.medicaljava.volumerestservice.segmentation;

import com.medicaljava.volumerestservice.model.SegmentStatistics;
import com.medicaljava.volumerestservice.model.Segmentation;
import com.medicaljava.volumerestservice.store.InvalidSegmentationException;
import com.medicaljava.volumerestservice.store.SegmentationStore;
import com.medicaljava.volumerestservice.store.StorePaths;
import com.medicaljava.volumerestservice.store.VolumeStore;

import org.springframework.stereotype.Service;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.zip.GZIPInputStream;

/** Segmentation operations that need the labels themselves: statistics and DICOM SEG export/import. */
@Service
public class SegmentationService {

    private final SegmentationStore store;
    private final VolumeStore volumes;
    private final StorePaths paths;

    public SegmentationService(SegmentationStore store, VolumeStore volumes, StorePaths paths) {
        this.store = store;
        this.volumes = volumes;
        this.paths = paths;
    }

    public List<SegmentStatistics> statistics(int patientId, int volumeId, int segmentationId) throws IOException {
        return SegmentationStatistics.compute(store.labels(patientId, volumeId, segmentationId));
    }

    /**
     * Writes the segmentation as a DICOM SEG object to a temporary file in the store, which the caller must delete.
     * Writing it completely first lets a failure still become an error response.
     */
    public Path exportDicom(int patientId, int volumeId, int segmentationId) throws IOException {
        var stored = store.labels(patientId, volumeId, segmentationId);
        if (stored.segmentation().stale()) {
            throw new InvalidSegmentationException("The volume was re-imported with a different geometry since this "
                    + "segmentation was saved, so it can't be exported against it");
        }
        byte[] labels = readLabels(stored);
        var refs = volumes.dicomReferences(patientId, volumeId);
        var file = Files.createTempFile(paths.tmp(), "export-", ".dcm");
        try (var out = new BufferedOutputStream(Files.newOutputStream(file), 65536)) {
            DicomSegWriter.write(stored.volume().volume(), refs, stored.segmentation(), labels, out);
        } catch (IOException | RuntimeException e) {
            VolumeStore.deleteQuietly(file);
            throw e;
        }
        return file;
    }

    /** Imports a DICOM SEG object as a new segmentation of the volume. */
    public Segmentation importDicom(int patientId, int volumeId, InputStream in) throws IOException {
        var volume = volumes.getVolume(patientId, volumeId).volume();
        var refs = volumes.dicomReferences(patientId, volumeId);
        var result = DicomSegReader.read(in, volume, refs);
        return store.create(patientId, volumeId, result.name(), "dicom-seg", result.segments(),
                new ByteArrayInputStream(result.labels()));
    }

    static byte[] readLabels(SegmentationStore.StoredLabels stored) throws IOException {
        try (var in = new GZIPInputStream(new BufferedInputStream(Files.newInputStream(stored.labelFile())), 65536)) {
            var labels = in.readAllBytes();
            if (labels.length != stored.segmentation().voxelCount()) {
                throw new IllegalStateException("Label file " + stored.labelFile() + " has " + labels.length
                        + " labels, expected " + stored.segmentation().voxelCount());
            }
            return labels;
        }
    }
}
