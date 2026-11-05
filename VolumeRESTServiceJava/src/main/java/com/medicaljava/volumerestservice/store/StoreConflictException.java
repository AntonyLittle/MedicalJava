package com.medicaljava.volumerestservice.store;

/** Upload or import request conflicts with the current store state. */
public class StoreConflictException extends RuntimeException {
    public StoreConflictException(String message) {
        super(message);
    }
}
