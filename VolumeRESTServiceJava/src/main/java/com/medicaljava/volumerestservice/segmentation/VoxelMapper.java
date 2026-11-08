package com.medicaljava.volumerestservice.segmentation;

import com.medicaljava.volumerestservice.model.Volume;

/**
 * Maps patient-space (LPS) points to the nearest voxel of a volume, whose slices may be unevenly spaced or sheared
 * (gantry tilt). A point belongs to the slice nearest along the normal, if it is within half a slice spacing of it.
 */
final class VoxelMapper {

    private final double[] right;
    private final double[] down;
    private final double[] normal;
    private final double[][] positions;
    private final double[] depths;
    private final double[] halfThickness;
    private final int width;
    private final int height;
    private final double spacingX;
    private final double spacingY;

    VoxelMapper(Volume volume) {
        var slices = volume.slices();
        right = normalize(volume.rowDirection());
        var column = volume.columnDirection();
        down = normalize(subtract(column, scale(right, dot(column, right))));
        normal = cross(right, down);
        int n = slices.size();
        positions = new double[n][];
        depths = new double[n];
        for (int k = 0; k < n; k++) {
            var s = slices.get(k);
            positions[k] = new double[] {s.positionXMm(), s.positionYMm(), s.positionZMm()};
            depths[k] = dot(normal, positions[k]);
        }
        var thickness = SegmentationStatistics.sliceThickness(slices);
        halfThickness = new double[n];
        for (int k = 0; k < n; k++) {
            halfThickness[k] = thickness[k] / 2 + 1e-3;
        }
        width = slices.getFirst().widthPixels();
        height = slices.getFirst().heightPixels();
        spacingX = slices.getFirst().pixelSpacingXMm();
        spacingY = slices.getFirst().pixelSpacingYMm();
    }

    double[] normal() {
        return normal;
    }

    /** Index of the voxel nearest to the point in the volume's label array, or -1 outside the volume. */
    long voxelIndex(double x, double y, double z) {
        double depth = normal[0] * x + normal[1] * y + normal[2] * z;
        int k = nearestSlice(depth);
        if (Math.abs(depth - depths[k]) > halfThickness[k]) {
            return -1;
        }
        var p = positions[k];
        double dx = x - p[0];
        double dy = y - p[1];
        double dz = z - p[2];
        long i = Math.round((right[0] * dx + right[1] * dy + right[2] * dz) / spacingX);
        long j = Math.round((down[0] * dx + down[1] * dy + down[2] * dz) / spacingY);
        if (i < 0 || j < 0 || i >= width || j >= height) {
            return -1;
        }
        return (long) k * width * height + j * width + i;
    }

    private int nearestSlice(double depth) {
        int lo = 0;
        int hi = depths.length - 1;
        while (hi - lo > 1) {
            int mid = (lo + hi) >>> 1;
            if (depths[mid] <= depth) lo = mid;
            else hi = mid;
        }
        return Math.abs(depth - depths[lo]) <= Math.abs(depth - depths[hi]) ? lo : hi;
    }

    static double dot(double[] a, double[] b) {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }

    static double[] cross(double[] a, double[] b) {
        return new double[] {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
    }

    static double[] subtract(double[] a, double[] b) {
        return new double[] {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
    }

    static double[] scale(double[] a, double s) {
        return new double[] {a[0] * s, a[1] * s, a[2] * s};
    }

    static double[] normalize(double[] a) {
        double length = Math.sqrt(dot(a, a));
        return length > 0 ? scale(a, 1 / length) : new double[] {1, 0, 0};
    }
}
