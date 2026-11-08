package com.medicaljava.volumerestservice.model;

/**
 * Size and value statistics of one label. Values are real values in {@code units} (e.g. HU); they are null when the
 * label has no voxels.
 */
public record SegmentStatistics(
    int label,
    String name,
    long voxelCount,
    double volumeMl,
    Double mean,
    Double standardDeviation,
    Double min,
    Double max,
    String units
) {}
