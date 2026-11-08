package com.medicaljava.volumerestservice.model;

/**
 * One image of a volume. {@code positionX/Y/ZMm} is the patient-space (LPS) centre of the first pixel
 * (ImagePositionPatient). The legacy fields describe the same position for axial-only clients: {@code originX/YMm}
 * are its x/y and {@code depthPositionMm} is its distance along the volume's slice normal.
 */
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
    double positionXMm,
    double positionYMm,
    double positionZMm,
    short[] radiodensities
) {
    public Slice withoutPixels() {
        return withPixels(new short[0]);
    }

    public Slice withPixels(short[] pixels) {
        return new Slice(sliceId, volumeId, patientId, index, widthPixels, heightPixels, widthMm, heightMm,
                depthPositionMm, originXMm, originYMm, pixelSpacingXMm, pixelSpacingYMm,
                positionXMm, positionYMm, positionZMm, pixels);
    }

    public Slice withDepthPositionMm(double depth) {
        return new Slice(sliceId, volumeId, patientId, index, widthPixels, heightPixels, widthMm, heightMm,
                depth, originXMm, originYMm, pixelSpacingXMm, pixelSpacingYMm,
                positionXMm, positionYMm, positionZMm, radiodensities);
    }
}
