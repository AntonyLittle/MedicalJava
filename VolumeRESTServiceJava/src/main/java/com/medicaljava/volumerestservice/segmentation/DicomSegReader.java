package com.medicaljava.volumerestservice.segmentation;

import com.medicaljava.volumerestservice.model.Segment;
import com.medicaljava.volumerestservice.model.Volume;
import com.medicaljava.volumerestservice.store.InvalidSegmentationException;
import com.medicaljava.volumerestservice.store.SegmentationStore;
import com.medicaljava.volumerestservice.store.VolumeStore.DicomReferences;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Fragments;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Reads a DICOM Segmentation (BINARY, or FRACTIONAL thresholded at one half) onto a volume's voxel grid. Each set
 * frame pixel is placed in the voxel nearest its centre, so a SEG made on the volume's own grid maps exactly and one
 * on another grid of the same frame of reference is resampled (nearest neighbour). Segment numbers become labels.
 */
public final class DicomSegReader {

    /** Palette for segments without a recommended display colour. */
    static final String[] PALETTE = {
        "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c",
        "#fabebe", "#008080", "#e6beff", "#9a6324", "#fffac8", "#800000", "#aaffc3", "#808000", "#ffd8b1"
    };

    public record Result(String name, List<Segment> segments, byte[] labels, long labelledVoxels) {}

    private DicomSegReader() {}

    public static Result read(InputStream in, Volume volume, DicomReferences refs) throws IOException {
        Attributes ds;
        try (var dis = new DicomInputStream(in)) {
            ds = dis.readDataset();
        } catch (IOException | RuntimeException e) {
            throw new InvalidSegmentationException("Not a readable DICOM file: " + e.getMessage());
        }
        if (!UID.SegmentationStorage.equals(ds.getString(Tag.SOPClassUID))) {
            throw new InvalidSegmentationException("Not a DICOM Segmentation (SOP class "
                    + ds.getString(Tag.SOPClassUID) + ")");
        }
        var frameOfReference = ds.getString(Tag.FrameOfReferenceUID);
        if (frameOfReference != null && refs.frameOfReferenceUid() != null
                && !frameOfReference.equals(refs.frameOfReferenceUid())) {
            throw new InvalidSegmentationException("The segmentation belongs to another frame of reference than this "
                    + "volume");
        }
        if (ds.getValue(Tag.PixelData) instanceof Fragments) {
            throw new InvalidSegmentationException("Compressed DICOM SEG pixel data is not supported");
        }

        var type = ds.getString(Tag.SegmentationType, "BINARY");
        int bitsAllocated = ds.getInt(Tag.BitsAllocated, 1);
        boolean fractional = "FRACTIONAL".equals(type);
        if (!fractional && bitsAllocated != 1 || fractional && bitsAllocated != 8) {
            throw new InvalidSegmentationException("Unsupported " + type + " segmentation with " + bitsAllocated
                    + " bits per pixel");
        }
        int threshold = fractional ? (ds.getInt(Tag.MaximumFractionalValue, 255) + 1) / 2 : 1;
        int rows = ds.getInt(Tag.Rows, 0);
        int columns = ds.getInt(Tag.Columns, 0);
        int frameCount = ds.getInt(Tag.NumberOfFrames, 1);
        byte[] pixels = ds.getBytes(Tag.PixelData);
        long frameSize = (long) rows * columns;
        long neededBytes = fractional ? frameSize * frameCount : (frameSize * frameCount + 7) / 8;
        if (pixels == null || rows == 0 || columns == 0 || pixels.length < neededBytes) {
            throw new InvalidSegmentationException("The segmentation's pixel data is missing or too short");
        }

        var segmentSequence = ds.getSequence(Tag.SegmentSequence);
        if (segmentSequence == null || segmentSequence.isEmpty()) {
            throw new InvalidSegmentationException("The segmentation has no segments");
        }
        var segments = new ArrayList<Segment>();
        var numbers = new HashMap<Integer, Integer>();
        for (var item : segmentSequence) {
            int number = item.getInt(Tag.SegmentNumber, segments.size() + 1);
            if (number < 1 || number > 255) {
                throw new InvalidSegmentationException("Segment number " + number + " doesn't fit an 8-bit labelmap");
            }
            numbers.put(number, number);
            var lab = item.getInts(Tag.RecommendedDisplayCIELabValue);
            var color = lab != null && lab.length == 3 ? CieLab.toRgb(lab) : PALETTE[(number - 1) % PALETTE.length];
            var algorithm = item.getString(Tag.SegmentAlgorithmType, "MANUAL");
            if (!SegmentationStore.ALGORITHM_TYPES.contains(algorithm)) {
                algorithm = "MANUAL";
            }
            var label = item.getString(Tag.SegmentLabel);
            segments.add(new Segment(number, label == null || label.isBlank() ? "Segment " + number : label.strip(),
                    color, algorithm));
        }

        var shared = item(ds.getSequence(Tag.SharedFunctionalGroupsSequence), 0);
        var perFrame = ds.getSequence(Tag.PerFrameFunctionalGroupsSequence);
        if (perFrame == null || perFrame.size() < frameCount) {
            throw new InvalidSegmentationException("The segmentation lacks per-frame positions");
        }

        var mapper = new VoxelMapper(volume);
        long voxelCount = SegmentationStore.voxelCount(volume);
        var labels = new byte[Math.toIntExact(voxelCount)];
        long labelled = 0;
        for (int f = 0; f < frameCount; f++) {
            var groups = perFrame.get(f);
            Integer number = segmentNumber(groups, shared, numbers);
            if (number == null) {
                continue;
            }
            var position = functional(groups, shared, Tag.PlanePositionSequence).getDoubles(Tag.ImagePositionPatient);
            var orientation = functional(groups, shared, Tag.PlaneOrientationSequence)
                    .getDoubles(Tag.ImageOrientationPatient);
            var spacing = functional(groups, shared, Tag.PixelMeasuresSequence).getDoubles(Tag.PixelSpacing);
            if (position == null || position.length < 3 || orientation == null || orientation.length < 6
                    || spacing == null || spacing.length < 2) {
                throw new InvalidSegmentationException("Frame " + (f + 1) + " lacks its position, orientation or "
                        + "pixel spacing");
            }
            // Row direction (along a row, i.e. with the column index) scaled by column spacing, and vice versa.
            double rx = orientation[0] * spacing[1], ry = orientation[1] * spacing[1], rz = orientation[2] * spacing[1];
            double cx = orientation[3] * spacing[0], cy = orientation[4] * spacing[0], cz = orientation[5] * spacing[0];
            long base = f * frameSize;
            for (int r = 0; r < rows; r++) {
                double px = position[0] + cx * r;
                double py = position[1] + cy * r;
                double pz = position[2] + cz * r;
                for (int c = 0; c < columns; c++) {
                    long index = base + (long) r * columns + c;
                    boolean set = fractional
                            ? (pixels[(int) index] & 0xFF) >= threshold
                            : (pixels[(int) (index >>> 3)] & (1 << (index & 7))) != 0;
                    if (!set) {
                        continue;
                    }
                    long voxel = mapper.voxelIndex(px + rx * c, py + ry * c, pz + rz * c);
                    if (voxel >= 0) {
                        if (labels[(int) voxel] == 0) {
                            labelled++;
                        }
                        labels[(int) voxel] = (byte) number.intValue();
                    }
                }
            }
        }
        if (labelled == 0) {
            throw new InvalidSegmentationException("The segmentation doesn't overlap this volume");
        }

        var name = firstNonBlank(ds.getString(Tag.SeriesDescription), ds.getString(Tag.ContentDescription),
                ds.getString(Tag.ContentLabel), "DICOM SEG");
        return new Result(name, segments, labels, labelled);
    }

    private static Integer segmentNumber(Attributes groups, Attributes shared, Map<Integer, Integer> numbers) {
        var identification = functional(groups, shared, Tag.SegmentIdentificationSequence);
        int number = identification.getInt(Tag.ReferencedSegmentNumber, -1);
        return numbers.get(number);
    }

    // A functional group item from the frame's groups, falling back to the shared ones; empty when neither has it.
    private static Attributes functional(Attributes groups, Attributes shared, int sequenceTag) {
        var own = item(groups.getSequence(sequenceTag), 0);
        if (!own.isEmpty()) {
            return own;
        }
        return shared.isEmpty() ? own : item(shared.getSequence(sequenceTag), 0);
    }

    private static Attributes item(org.dcm4che3.data.Sequence sequence, int index) {
        return sequence == null || sequence.size() <= index ? new Attributes() : sequence.get(index);
    }

    private static String firstNonBlank(String... values) {
        for (var v : values) {
            if (v != null && !v.isBlank()) {
                return v.strip();
            }
        }
        return null;
    }
}
