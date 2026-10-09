package com.medicaljava.volumerestservice.model;

import java.util.List;

public record Volume(
    int volumeId,
    int patientId,
    String name,
    String modality,
    Patient patient,
    List<Slice> slices
) {
    public Volume withSlices(List<Slice> slices) {
        return new Volume(
            this.volumeId,
            this.patientId,
            this.name,
            this.modality,
            this.patient,
            slices
        );
    }
}
