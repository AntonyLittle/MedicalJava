package com.medicaljava.volumerestservice.model;

public record Slice (
    int sliceId, 
    int volumeId, 
    int patientId, 
    int index, 
    int widthPixels, 
    int heightPixels, 
    int widthMm,
    int heightMm,
    int depthPositionMm,
    short[] radiodensities) {}
