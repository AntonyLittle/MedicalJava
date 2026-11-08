package com.medicaljava.volumerestservice.store;

/** An If-Match revision that is no longer current: someone else changed the resource first. */
public class PreconditionFailedException extends RuntimeException {
    public PreconditionFailedException(String message) {
        super(message);
    }
}
