package com.medicaljava.volumerestservice.store;

import com.medicaljava.volumerestservice.store.VolumeStore.ImportFailure;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Imports {@code app.data-dir} (layout: patient/series/*.dcm) into the store. New series are added, series whose
 * files changed are re-imported under the same volume id, and series deleted through the API stay deleted.
 */
@Component
public class DataDirectoryScanner {

    private static final Logger LOG = LoggerFactory.getLogger(DataDirectoryScanner.class);

    public record ScanResult(
            Instant startedAt,
            Instant finishedAt,
            int imported,
            int updated,
            int unchanged,
            int excluded,
            int failed) {}

    public record ImportStatus(boolean running, ScanResult lastScan, List<ImportFailure> failures) {}

    private final String dataDir;
    private final boolean importOnStartup;
    private final VolumeStore store;
    private final VolumeImporter importer;
    private final AtomicBoolean running = new AtomicBoolean();
    private final AtomicReference<ScanResult> lastScan = new AtomicReference<>();

    public DataDirectoryScanner(@Value("${app.data-dir:Data}") String dataDir,
            @Value("${app.import-on-startup:true}") boolean importOnStartup,
            VolumeStore store, VolumeImporter importer) {
        this.dataDir = dataDir;
        this.importOnStartup = importOnStartup;
        this.store = store;
        this.importer = importer;
    }

    @EventListener(ApplicationReadyEvent.class)
    void importOnStartup() {
        if (!importOnStartup) {
            return;
        }
        // Runs in the background so the API is available (serving already-stored volumes) straight away.
        Thread.ofVirtual().name("data-dir-import").start(() -> {
            try {
                scan();
            } catch (Exception e) {
                LOG.error("Startup import of {} failed", dataDir, e);
            }
        });
    }

    public ScanResult scan() {
        if (!running.compareAndSet(false, true)) {
            throw new StoreConflictException("An import is already running");
        }
        try {
            var result = doScan();
            lastScan.set(result);
            LOG.info("Data directory import: {}", result);
            return result;
        } finally {
            running.set(false);
        }
    }

    public ImportStatus status() {
        return new ImportStatus(running.get(), lastScan.get(), store.listFailures());
    }

    private ScanResult doScan() {
        var startedAt = Instant.now();
        int imported = 0, updated = 0, unchanged = 0, excluded = 0, failed = 0;

        var root = dataPath();
        if (!Files.isDirectory(root)) {
            LOG.warn("Data directory {} does not exist; nothing to import", root.toAbsolutePath());
            return new ScanResult(startedAt, Instant.now(), 0, 0, 0, 0, 0);
        }

        var sources = store.volumeSources();
        var excludedSources = store.excludedSources();
        var failures = store.listFailures();

        for (var patientDir : listSortedDirs(root)) {
            var patientName = patientDir.getFileName().toString();
            for (var seriesDir : listSortedDirs(patientDir)) {
                var sourcePath = patientName + "/" + seriesDir.getFileName();
                if (excludedSources.contains(sourcePath)) {
                    excluded++;
                    continue;
                }

                String fingerprint;
                try {
                    fingerprint = fingerprint(seriesDir);
                } catch (IOException e) {
                    LOG.warn("Cannot read {}", seriesDir, e);
                    failed++;
                    continue;
                }

                var existing = sources.get(sourcePath);
                if (existing != null && fingerprint.equals(existing.fingerprint())) {
                    unchanged++;
                    continue;
                }
                if (failures.stream().anyMatch(f -> f.sourcePath().equals(sourcePath)
                        && f.fingerprint().equals(fingerprint))) {
                    unchanged++;
                    continue;
                }

                try {
                    importer.importDirectory(seriesDir, patientName, sourcePath, fingerprint,
                            existing == null ? null : existing.volumeId());
                    if (existing == null) {
                        imported++;
                    } else {
                        updated++;
                    }
                } catch (Exception e) {
                    LOG.warn("Failed to import {}", sourcePath, e);
                    store.recordFailure(sourcePath, fingerprint, String.valueOf(e.getMessage()));
                    failed++;
                }
            }
        }
        return new ScanResult(startedAt, Instant.now(), imported, updated, unchanged, excluded, failed);
    }

    // Falls back to the repo-root Data directory when running from VolumeRESTServiceJava/.
    private Path dataPath() {
        var primary = Path.of(dataDir);
        if (Files.isDirectory(primary)) {
            return primary;
        }
        var fallback = Path.of("..", "Data");
        return Files.isDirectory(fallback) ? fallback : primary;
    }

    /** Cheap change detection: file count, total size and newest modification time. */
    private static String fingerprint(Path seriesDir) throws IOException {
        long count = 0, size = 0, newest = 0;
        for (var file : VolumeImporter.listSortedFiles(seriesDir)) {
            count++;
            size += Files.size(file);
            newest = Math.max(newest, Files.getLastModifiedTime(file).toMillis());
        }
        return count + ":" + size + ":" + newest;
    }

    private static List<Path> listSortedDirs(Path dir) {
        try (var stream = Files.list(dir)) {
            return stream.filter(Files::isDirectory)
                    .sorted(Comparator.comparing(p -> p.getFileName().toString()))
                    .toList();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
