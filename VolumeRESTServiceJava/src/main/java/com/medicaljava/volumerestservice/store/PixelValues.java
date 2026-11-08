package com.medicaljava.volumerestservice.store;

import com.medicaljava.volumerestservice.repository.DicomSeriesReader.DecodedSlice;

import java.util.List;

/**
 * Converts decoded pixels (raw bits plus per-slice rescale) to int16 stored values with one linear mapping for the
 * whole volume: {@code real = stored * slope + intercept}. Integer rescales that fit in int16 (CT) are applied so
 * the stored values are the real values; anything else is requantised to cover the real range.
 */
public final class PixelValues {

    public record Mapping(double slope, double intercept, String units, double minValue, double maxValue) {}

    private PixelValues() {}

    /** Replaces each slice's raw pixels in place. Padding pixels become the lowest real value of the volume. */
    public static Mapping encode(List<DecodedSlice> slices, String modality) {
        double realMin = Double.POSITIVE_INFINITY;
        double realMax = Double.NEGATIVE_INFINITY;
        int rawMin = Integer.MAX_VALUE;
        int rawMax = Integer.MIN_VALUE;
        boolean integral = true;
        var first = slices.getFirst().encoding();
        boolean sameRescale = true;
        for (var decoded : slices) {
            var encoding = decoded.encoding();
            integral &= isInteger(encoding.rescaleSlope()) && isInteger(encoding.rescaleIntercept());
            sameRescale &= encoding.rescaleSlope() == first.rescaleSlope()
                    && encoding.rescaleIntercept() == first.rescaleIntercept();
            int lo = Integer.MAX_VALUE;
            int hi = Integer.MIN_VALUE;
            for (short raw : decoded.slice().radiodensities()) {
                int value = encoding.interpret(raw);
                if (encoding.isPadding(value)) {
                    continue;
                }
                lo = Math.min(lo, value);
                hi = Math.max(hi, value);
            }
            if (lo > hi) {
                continue;
            }
            rawMin = Math.min(rawMin, lo);
            rawMax = Math.max(rawMax, hi);
            double a = lo * encoding.rescaleSlope() + encoding.rescaleIntercept();
            double b = hi * encoding.rescaleSlope() + encoding.rescaleIntercept();
            realMin = Math.min(realMin, Math.min(a, b));
            realMax = Math.max(realMax, Math.max(a, b));
        }
        if (realMin > realMax) {
            // Nothing but padding.
            realMin = realMax = 0;
            rawMin = rawMax = 0;
        }

        double slope;
        double intercept;
        if (integral && realMin >= Short.MIN_VALUE && realMax <= Short.MAX_VALUE) {
            slope = 1;
            intercept = 0;
        } else if (sameRescale && first.rescaleSlope() > 0 && rawMin >= Short.MIN_VALUE && rawMax <= Short.MAX_VALUE) {
            slope = first.rescaleSlope();
            intercept = first.rescaleIntercept();
        } else {
            slope = realMax > realMin ? (realMax - realMin) / 65535.0 : 1;
            intercept = realMin - Short.MIN_VALUE * slope;
        }

        short paddingValue = toStored(realMin, slope, intercept);
        for (var decoded : slices) {
            var encoding = decoded.encoding();
            var pixels = decoded.slice().radiodensities();
            for (int i = 0; i < pixels.length; i++) {
                int value = encoding.interpret(pixels[i]);
                pixels[i] = encoding.isPadding(value)
                        ? paddingValue
                        : toStored(value * encoding.rescaleSlope() + encoding.rescaleIntercept(), slope, intercept);
            }
        }

        // Store the range as it reads back after quantisation.
        double storedMin = toStored(realMin, slope, intercept) * slope + intercept;
        double storedMax = toStored(realMax, slope, intercept) * slope + intercept;
        return new Mapping(slope, intercept, units(slices, modality), Math.min(storedMin, storedMax),
                Math.max(storedMin, storedMax));
    }

    private static String units(List<DecodedSlice> slices, String modality) {
        var encoding = slices.getFirst().encoding();
        var type = encoding.rescaleType();
        // "US" means unspecified.
        if (type != null && !type.isBlank() && !"US".equalsIgnoreCase(type.trim())) {
            return type.trim();
        }
        return "CT".equalsIgnoreCase(modality) && slices.stream().anyMatch(s -> s.encoding().hasRescale()) ? "HU" : "";
    }

    private static short toStored(double real, double slope, double intercept) {
        long stored = Math.round((real - intercept) / slope);
        return (short) Math.clamp(stored, Short.MIN_VALUE, Short.MAX_VALUE);
    }

    private static boolean isInteger(double value) {
        return Math.abs(value - Math.rint(value)) < 1e-9;
    }
}
