package com.medicaljava.volumerestservice.model;

public record Slice (
    int sliceId, 
    int volumeId, 
    int patientId, 
    int index, 
    int width, 
    int height, 
    short[] radiodensities) {}
