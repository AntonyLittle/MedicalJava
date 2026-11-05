package com.medicaljava.volumerestservice.controller;

import com.medicaljava.volumerestservice.store.InvalidDicomException;
import com.medicaljava.volumerestservice.store.StoreConflictException;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.NoSuchElementException;

// Unknown ids map to 404, bad uploads to 400 and store conflicts to 409; anything else falls through to Spring's
// default handling.
@RestControllerAdvice
public class ApiExceptionHandler {

    @ExceptionHandler(NoSuchElementException.class)
    public ResponseEntity<Void> handleNotFound() {
        return ResponseEntity.notFound().build();
    }

    @ExceptionHandler(InvalidDicomException.class)
    public ResponseEntity<ProblemDetail> handleInvalidDicom(InvalidDicomException e) {
        return ResponseEntity.badRequest().body(ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, e.getMessage()));
    }

    @ExceptionHandler(StoreConflictException.class)
    public ResponseEntity<ProblemDetail> handleConflict(StoreConflictException e) {
        return ResponseEntity.status(HttpStatus.CONFLICT)
                .body(ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, e.getMessage()));
    }
}
