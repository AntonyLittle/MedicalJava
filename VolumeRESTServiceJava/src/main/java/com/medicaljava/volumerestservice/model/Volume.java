package com.medicaljava.volumerestservice.model;

import java.util.List;

public record Volume(
    int volumeId,
    int patientId,
    String name,
    String modality,
    Patient patient,
    List<Slice> slices,
    int width,
    int height,
    int depth
) {
    public Volume withSlicesAndSpatial(List<Slice> slices, int width, int height, int depth) {
        return new Volume(volumeId, patientId, name, modality, patient, slices, width, height, depth);
    }

    public Volume withoutPixels() {
        return withSlicesAndSpatial(slices.stream().map(Slice::withoutPixels).toList(), width, height, depth);
    }
}
