package com.medicaljava.volumerestservice.segmentation;

import com.medicaljava.volumerestservice.model.SegmentStatistics;
import com.medicaljava.volumerestservice.model.Slice;
import com.medicaljava.volumerestservice.store.InvalidSegmentationException;
import com.medicaljava.volumerestservice.store.SegmentationStore.StoredLabels;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.nio.ByteOrder;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.zip.GZIPInputStream;

/**
 * Per-label voxel counts, volumes and value statistics. A slice's voxels are as thick as the slice's share of the
 * stack: half the distance to each neighbour (the spacing, for evenly spaced slices).
 */
public final class SegmentationStatistics {

    private SegmentationStatistics() {}

    public static List<SegmentStatistics> compute(StoredLabels stored) throws IOException {
        var segmentation = stored.segmentation();
        if (segmentation.stale()) {
            throw new InvalidSegmentationException("The volume was re-imported with a different geometry since this "
                    + "segmentation was saved, so its labels no longer line up with the voxels");
        }
        var volume = stored.volume().volume();
        var slices = volume.slices();
        double slope = volume.valueSlope();
        double intercept = volume.valueIntercept();
        double[] thickness = sliceThickness(slices);

        long[] count = new long[256];
        double[] volumeMm3 = new double[256];
        double[] sum = new double[256];
        double[] sumSquares = new double[256];
        int[] min = new int[256];
        int[] max = new int[256];
        java.util.Arrays.fill(min, Integer.MAX_VALUE);
        java.util.Arrays.fill(max, Integer.MIN_VALUE);

        try (var channel = FileChannel.open(stored.volume().pixelFile(), StandardOpenOption.READ);
                var labels = new GZIPInputStream(new BufferedInputStream(Files.newInputStream(stored.labelFile())),
                        64 * 1024)) {
            var pixels = channel.map(FileChannel.MapMode.READ_ONLY, 0, channel.size())
                    .order(ByteOrder.LITTLE_ENDIAN).asShortBuffer();
            for (int k = 0; k < slices.size(); k++) {
                var slice = slices.get(k);
                int n = slice.widthPixels() * slice.heightPixels();
                var sliceLabels = labels.readNBytes(n);
                if (sliceLabels.length != n) {
                    throw new InvalidSegmentationException("Label file is shorter than the volume");
                }
                double voxelMm3 = slice.pixelSpacingXMm() * slice.pixelSpacingYMm() * thickness[k];
                long[] sliceCount = new long[256];
                for (int i = 0; i < n; i++) {
                    int label = sliceLabels[i] & 0xFF;
                    int value = pixels.get();
                    if (label == 0) {
                        continue;
                    }
                    sliceCount[label]++;
                    sum[label] += value;
                    sumSquares[label] += (double) value * value;
                    if (value < min[label]) min[label] = value;
                    if (value > max[label]) max[label] = value;
                }
                for (int label = 1; label < 256; label++) {
                    count[label] += sliceCount[label];
                    volumeMm3[label] += sliceCount[label] * voxelMm3;
                }
            }
        }

        var names = new HashMap<Integer, String>();
        segmentation.segments().forEach(s -> names.put(s.label(), s.name()));
        var result = new ArrayList<SegmentStatistics>();
        for (int label = 1; label < 256; label++) {
            if (count[label] == 0 && !names.containsKey(label)) {
                continue;
            }
            var name = names.getOrDefault(label, "Label " + label);
            var units = volume.valueUnits();
            if (count[label] == 0) {
                result.add(new SegmentStatistics(label, name, 0, 0, null, null, null, null, units));
                continue;
            }
            double mean = sum[label] / count[label];
            double variance = Math.max(0, sumSquares[label] / count[label] - mean * mean);
            double scale = Math.abs(slope);
            double realMin = (slope >= 0 ? min[label] : max[label]) * slope + intercept;
            double realMax = (slope >= 0 ? max[label] : min[label]) * slope + intercept;
            result.add(new SegmentStatistics(label, name, count[label], volumeMm3[label] / 1000,
                    mean * slope + intercept, Math.sqrt(variance) * scale, realMin, realMax, units));
        }
        return result;
    }

    /** Thickness each slice stands for along the stack; a single slice is as thick as its smaller pixel spacing. */
    public static double[] sliceThickness(List<Slice> slices) {
        int n = slices.size();
        var thickness = new double[n];
        if (n == 1) {
            thickness[0] = Math.min(slices.getFirst().pixelSpacingXMm(), slices.getFirst().pixelSpacingYMm());
            return thickness;
        }
        for (int k = 0; k < n; k++) {
            double below = k > 0 ? slices.get(k).depthPositionMm() - slices.get(k - 1).depthPositionMm() : Double.NaN;
            double above = k < n - 1 ? slices.get(k + 1).depthPositionMm() - slices.get(k).depthPositionMm()
                    : Double.NaN;
            if (Double.isNaN(below)) below = above;
            if (Double.isNaN(above)) above = below;
            thickness[k] = Math.abs(below + above) / 2;
        }
        return thickness;
    }
}
