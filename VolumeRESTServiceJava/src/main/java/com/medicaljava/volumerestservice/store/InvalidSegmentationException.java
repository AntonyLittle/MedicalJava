package com.medicaljava.volumerestservice.store;

/** A segmentation request or file that can't be stored (wrong size, bad segment table, unsupported DICOM SEG). */
public class InvalidSegmentationException extends RuntimeException {
    public InvalidSegmentationException(String message) {
        super(message);
    }
}
