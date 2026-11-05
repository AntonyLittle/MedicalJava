package com.medicaljava.volumerestservice.model;

public record Slice(
    int sliceId,
    int volumeId,
    int patientId,
    int index,
    int widthPixels,
    int heightPixels,
    double widthMm,
    double heightMm,
    double depthPositionMm,
    double originXMm,
    double originYMm,
    double pixelSpacingXMm,
    double pixelSpacingYMm,
    short[] radiodensities
) {
    public Slice withoutPixels() {
        return new Slice(sliceId, volumeId, patientId, index, widthPixels, heightPixels, widthMm, heightMm,
                depthPositionMm, originXMm, originYMm, pixelSpacingXMm, pixelSpacingYMm, new short[0]);
    }
}
