package com.medicaljava.volumerestservice.model;

/**
 * One structure of a segmentation: voxels labelled {@code label} (1–255). {@code color} is "#rrggbb";
 * {@code algorithmType} is the DICOM SEG SegmentAlgorithmType (MANUAL, SEMIAUTOMATIC or AUTOMATIC).
 */
public record Segment(int label, String name, String color, String algorithmType) {}
