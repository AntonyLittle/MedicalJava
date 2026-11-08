package com.medicaljava.volumerestservice.store;

import com.medicaljava.volumerestservice.repository.DicomSeriesReader.DecodedSlice;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;

/**
 * Splits a series into stacks of parallel slices and orders each stack along its normal. A series acquired in
 * several orientations (e.g. a three-plane localizer) yields one stack per orientation.
 */
public final class SeriesGeometry {

    /** Slices from different series parts with orientations closer than this (cosine) are treated as parallel. */
    private static final double SAME_DIRECTION = 0.9999;
    /** A normal within about 10 degrees of a patient axis is named after that axis. */
    private static final double NAMED_ORIENTATION = Math.cos(Math.toRadians(10));
    /** Split series keep only stacks with at least this many slices (single images are scout views). */
    static final int MIN_SPLIT_SLICES = 3;
    /** In-plane misalignment, in pixels, tolerated between a slice and the stack's straight line. */
    private static final double GRID_TOLERANCE_PIXELS = 0.25;

    /**
     * One stack of parallel slices, sorted by position along {@code normal}. {@code key} is empty for an unsplit
     * series and the orientation label otherwise; it identifies the stack across re-imports.
     */
    public record Part(String key, String label, double[] rowDirection, double[] columnDirection, double[] normal,
            List<DecodedSlice> slices) {}

    private SeriesGeometry() {}

    public static List<Part> split(List<DecodedSlice> decoded) {
        var groups = new ArrayList<List<DecodedSlice>>();
        for (var slice : decoded) {
            groups.stream().filter(g -> compatible(g.getFirst(), slice)).findFirst()
                    .orElseGet(() -> {
                        var group = new ArrayList<DecodedSlice>();
                        groups.add(group);
                        return group;
                    })
                    .add(slice);
        }

        if (groups.size() > 1) {
            groups.removeIf(g -> g.size() < MIN_SPLIT_SLICES);
            if (groups.isEmpty()) {
                throw new InvalidDicomException(
                        "Series mixes orientations and has no stack of at least " + MIN_SPLIT_SLICES + " slices");
            }
        }

        boolean split = decoded.size() > groups.stream().mapToInt(List::size).sum() || groups.size() > 1;
        var labelCounts = new HashMap<String, Integer>();
        var parts = new ArrayList<Part>();
        for (var group : groups) {
            var plane = group.getFirst().plane();
            var row = normalize(plane.rowDirection());
            var column = normalize(subtract(plane.columnDirection(), scale(row, dot(plane.columnDirection(), row))));
            var normal = cross(row, column);

            var sorted = new ArrayList<>(group);
            sorted.sort(Comparator.comparingDouble(s -> dot(normal, s.plane().position())));
            checkRegularGrid(sorted, row, column, normal);

            var base = orientationLabel(normal);
            int n = labelCounts.merge(base, 1, Integer::sum);
            var label = n == 1 ? base : base + " " + n;
            parts.add(new Part(split ? label : "", label, row, column, normal, sorted));
        }
        return parts;
    }

    public static String orientationLabel(double[] normal) {
        int axis = 0;
        for (int i = 1; i < 3; i++) {
            if (Math.abs(normal[i]) > Math.abs(normal[axis])) {
                axis = i;
            }
        }
        if (Math.abs(normal[axis]) < NAMED_ORIENTATION) {
            return "oblique";
        }
        return switch (axis) {
            case 0 -> "sagittal";
            case 1 -> "coronal";
            default -> "axial";
        };
    }

    private static boolean compatible(DecodedSlice a, DecodedSlice b) {
        var sa = a.slice();
        var sb = b.slice();
        return sa.widthPixels() == sb.widthPixels() && sa.heightPixels() == sb.heightPixels()
                && close(sa.pixelSpacingXMm(), sb.pixelSpacingXMm())
                && close(sa.pixelSpacingYMm(), sb.pixelSpacingYMm())
                && dot(normalize(a.plane().rowDirection()), normalize(b.plane().rowDirection())) > SAME_DIRECTION
                && dot(normalize(a.plane().columnDirection()), normalize(b.plane().columnDirection())) > SAME_DIRECTION;
    }

    /**
     * The slice positions must lie on a straight line so the stack is a regular grid: perpendicular to the slices,
     * or sheared at a constant rate (gantry tilt). Uneven spacing along the line is allowed.
     */
    private static void checkRegularGrid(List<DecodedSlice> sorted, double[] row, double[] column, double[] normal) {
        var first = sorted.getFirst().plane().position();
        var last = subtract(sorted.getLast().plane().position(), first);
        double depth = dot(normal, last);
        double rowShear = depth > 1e-6 ? dot(row, last) / depth : 0;
        double columnShear = depth > 1e-6 ? dot(column, last) / depth : 0;
        double sx = sorted.getFirst().slice().pixelSpacingXMm();
        double sy = sorted.getFirst().slice().pixelSpacingYMm();
        for (var slice : sorted) {
            var offset = subtract(slice.plane().position(), first);
            double d = dot(normal, offset);
            if (Math.abs(dot(row, offset) - rowShear * d) > GRID_TOLERANCE_PIXELS * sx
                    || Math.abs(dot(column, offset) - columnShear * d) > GRID_TOLERANCE_PIXELS * sy) {
                throw new InvalidDicomException("Slices of the " + orientationLabel(normal)
                        + " stack are not on a regular grid");
            }
        }
    }

    private static boolean close(double a, double b) {
        return Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(a));
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

    private static double[] scale(double[] a, double s) {
        return new double[] {a[0] * s, a[1] * s, a[2] * s};
    }

    private static double[] normalize(double[] a) {
        double length = Math.sqrt(dot(a, a));
        return length > 0 ? scale(a, 1 / length) : new double[] {1, 0, 0};
    }
}
