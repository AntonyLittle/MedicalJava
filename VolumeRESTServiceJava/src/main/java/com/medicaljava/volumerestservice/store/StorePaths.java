package com.medicaljava.volumerestservice.store;

import java.nio.file.Path;

public record StorePaths(Path root, Path database, Path volumes, Path segmentations, Path tmp) {

    public Path pixelFile(String fileName) {
        return volumes.resolve(fileName);
    }

    public Path labelFile(String fileName) {
        return segmentations.resolve(fileName);
    }
}
