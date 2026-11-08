package com.medicaljava.volumerestservice.model;

import java.util.List;

/**
 * A labelmap on a volume's voxel grid: one uint8 label per voxel, slices in the volume's order. {@code stale} is true
 * when the volume was re-imported with a different geometry since the labels were written; the labels then no
 * longer line up with the voxels (and may not even have the same count). {@code revision} increases with every
 * change and is sent as the ETag.
 */
public record Segmentation(
    int segmentationId,
    int volumeId,
    int patientId,
    String name,
    String source,
    int revision,
    String createdAt,
    String modifiedAt,
    long voxelCount,
    boolean stale,
    List<Segment> segments
) {}
