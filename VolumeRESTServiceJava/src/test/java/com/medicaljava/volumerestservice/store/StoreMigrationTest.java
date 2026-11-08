package com.medicaljava.volumerestservice.store;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.util.unit.DataSize;

import com.medicaljava.volumerestservice.model.Volume;
import com.zaxxer.hikari.HikariDataSource;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/** Upgrading a store written before orientation and rescale were decoded (schema version 0). */
class StoreMigrationTest {

    private static final Path SAMPLES = Path.of("..", "Data", "Anonymized_20261014");

    @TempDir
    Path work;

    @Test
    void versionZeroStoreIsUpgradedThenReimportedUnderTheSameIds() throws IOException {
        var config = new StoreConfig();
        var paths = config.storePaths(work.resolve("store").toString());
        var dataDir = work.resolve("data");
        copyDir(SAMPLES.resolve("series-00002"), dataDir.resolve("Test Patient").resolve("A"));
        copyDir(SAMPLES.resolve("series-00000"), dataDir.resolve("Test Patient").resolve("L"));

        try (var dataSource = (HikariDataSource) config.dataSource(paths)) {
            var jdbc = JdbcClient.create(dataSource);
            new ResourceDatabasePopulator(new ClassPathResource("store/schema-v0.sql")).execute(dataSource);
            jdbc.sql("INSERT INTO patients (id, name) VALUES (1, 'Test Patient')").update();
            insertLegacyVolume(jdbc, paths, 5, "A", "a.vol", new short[] {-5, 0, 3, 10});
            insertLegacyVolume(jdbc, paths, 7, "L", "l.vol", new short[] {1, 2, 3, 4});
            jdbc.sql("INSERT INTO excluded_sources (source_path) VALUES ('Gone/X')").update();
            // Volume 9 was deleted, so new volumes must not reuse its id.
            jdbc.sql("UPDATE sqlite_sequence SET seq = 9 WHERE name = 'volumes'").update();

            var store = new VolumeStore(dataSource, jdbc, new DataSourceTransactionManager(dataSource), paths);

            assertThat(jdbc.sql("PRAGMA user_version").query(Integer.class).single())
                    .isEqualTo(VolumeStore.SCHEMA_VERSION);
            var legacy = store.getVolume(1, 5).volume();
            assertThat(legacy.formatVersion()).isZero();
            assertThat(legacy.rowDirection()).containsExactly(1, 0, 0);
            assertThat(legacy.columnDirection()).containsExactly(0, 1, 0);
            assertThat(legacy.valueSlope()).isEqualTo(1);
            assertThat(legacy.minValue()).isEqualTo(-5);
            assertThat(legacy.maxValue()).isEqualTo(10);
            var slice = legacy.slices().getFirst();
            assertThat(slice.positionXMm()).isEqualTo(slice.originXMm());
            assertThat(slice.positionZMm()).isEqualTo(slice.depthPositionMm());
            assertThat(store.excludedSources()).isEqualTo(Map.of("Gone/X", Set.of("")));

            var importer = new VolumeImporter(store, paths, DataSize.ofGigabytes(1));
            var scan = new DataDirectoryScanner(dataDir.toString(), false, store, importer).scan();
            assertThat(scan.updated()).isEqualTo(2);
            assertThat(scan.failed()).isZero();

            var volumes = store.listVolumes(1);
            assertThat(volumes).extracting(Volume::name)
                    .containsExactly("A", "L (axial)", "L (coronal)", "L (sagittal)");
            var a = volumes.getFirst();
            assertThat(a.volumeId()).isEqualTo(5);
            assertThat(a.formatVersion()).isEqualTo(VolumeImporter.FORMAT_VERSION);
            assertThat(a.rowDirection()).containsExactly(new double[] {0.999993, -0.0036927, 0}, within(1e-5));
            assertThat(a.columnDirection()).containsExactly(new double[] {0, 0, -1}, within(1e-9));
            // The split series replaces volume 7 with new volumes above the highest id ever used.
            assertThat(volumes.subList(1, 4)).allSatisfy(v -> assertThat(v.volumeId()).isGreaterThan(9));
            assertThat(Files.exists(paths.pixelFile("a.vol"))).isFalse();
            assertThat(Files.exists(paths.pixelFile("l.vol"))).isFalse();

            assertThat(new DataDirectoryScanner(dataDir.toString(), false, store, importer).scan().unchanged())
                    .isEqualTo(2);
        }
    }

    private static void insertLegacyVolume(JdbcClient jdbc, StorePaths paths, int id, String name, String file,
            short[] pixels) throws IOException {
        var bytes = ByteBuffer.allocate(pixels.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        bytes.asShortBuffer().put(pixels);
        Files.write(paths.pixelFile(file), bytes.array());
        jdbc.sql("""
                INSERT INTO volumes (id, patient_id, name, modality, width, height, depth, slice_count, pixel_file,
                    pixel_bytes, source_path, source_fingerprint)
                VALUES (?, 1, ?, 'MR', 2, 1, 1, 2, ?, ?, ?, 'old')""")
                .params(id, name, file, pixels.length * 2, "Test Patient/" + name)
                .update();
        for (int position = 0; position < 2; position++) {
            jdbc.sql("""
                    INSERT INTO slices (volume_id, position, slice_index, width_px, height_px, width_mm, height_mm,
                        depth_position_mm, origin_x_mm, origin_y_mm, spacing_x_mm, spacing_y_mm)
                    VALUES (?, ?, ?, 2, 1, 2, 1, ?, -3, 4, 1, 1)""")
                    .params(id, position, position, 10.0 * position)
                    .update();
        }
    }

    private static void copyDir(Path from, Path to) throws IOException {
        Files.createDirectories(to);
        try (var files = Files.list(from)) {
            for (var file : files.toList()) {
                Files.copy(file, to.resolve(file.getFileName()));
            }
        }
    }
}
