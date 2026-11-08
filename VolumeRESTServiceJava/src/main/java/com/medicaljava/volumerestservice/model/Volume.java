package com.medicaljava.volumerestservice.model;

import java.util.List;

/**
 * A stack of parallel slices. {@code rowDirection} and {@code columnDirection} are the patient-space (LPS) unit
 * vectors along an image row and down a column (ImageOrientationPatient); slices are ordered along their cross
 * product. Pixel values are int16 and map to real values (in {@code valueUnits}, e.g. "HU") as
 * {@code value * valueSlope + valueIntercept}; {@code minValue}/{@code maxValue} are the real range.
 * {@code formatVersion} below the importer's current version marks a volume stored by an older import whose
 * values and orientation were not decoded.
 */
public record Volume(
    int volumeId,
    int patientId,
    String name,
    String modality,
    Patient patient,
    List<Slice> slices,
    int width,
    int height,
    int depth,
    double[] rowDirection,
    double[] columnDirection,
    double valueSlope,
    double valueIntercept,
    String valueUnits,
    double minValue,
    double maxValue,
    int formatVersion
) {
    public Volume withSlices(List<Slice> slices) {
        return new Volume(volumeId, patientId, name, modality, patient, slices, width, height, depth, rowDirection,
                columnDirection, valueSlope, valueIntercept, valueUnits, minValue, maxValue, formatVersion);
    }

    public Volume withoutPixels() {
        return withSlices(slices.stream().map(Slice::withoutPixels).toList());
    }
}
