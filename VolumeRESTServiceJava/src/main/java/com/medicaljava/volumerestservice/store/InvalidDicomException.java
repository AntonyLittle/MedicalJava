package com.medicaljava.volumerestservice.store;

/** Upload contained no decodable DICOM images. */
public class InvalidDicomException extends RuntimeException {
    public InvalidDicomException(String message) {
        super(message);
    }
}
