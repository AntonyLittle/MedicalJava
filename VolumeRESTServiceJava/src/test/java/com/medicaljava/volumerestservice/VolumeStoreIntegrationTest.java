package com.medicaljava.volumerestservice;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.env.Environment;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.FileSystemUtils;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/**
 * End-to-end tests of the volume store against real DICOM series from the repository's Data directory. Expected
 * pixel hashes come from the original directory-backed implementation's pixels, reordered along each stack's
 * normal and with the MR padding value (0) replaced by the lowest real value (1).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class VolumeStoreIntegrationTest {

    private static final Path SAMPLES = Path.of("..", "Data", "Anonymized_20261014");
    private static final Path CT_SAMPLE = Path.of("..", "Data", "John Doe", "Series Repeat 3");
    private static final Path WORK;
    private static final Path DATA_DIR;
    private static final Path STORE_DIR;

    static {
        try {
            WORK = Files.createTempDirectory("volume-store-test");
            DATA_DIR = WORK.resolve("data");
            STORE_DIR = WORK.resolve("store");
            copyDir(SAMPLES.resolve("series-00002"), DATA_DIR.resolve("Test Patient").resolve("A"));
            copyDir(SAMPLES.resolve("series-00001"), DATA_DIR.resolve("Test Patient").resolve("B"));
        } catch (IOException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", DATA_DIR::toString);
        registry.add("app.store-dir", STORE_DIR::toString);
        registry.add("app.import-on-startup", () -> "false");
    }

    @AfterAll
    static void cleanUp() throws IOException {
        FileSystemUtils.deleteRecursively(WORK);
    }

    @Autowired
    Environment environment;

    @Autowired
    ObjectMapper json;

    @Autowired
    JdbcClient jdbc;

    RestClient http;

    @BeforeEach
    void setUp() {
        http = RestClient.create("http://localhost:" + environment.getProperty("local.server.port"));
    }

    @Test
    @Order(1)
    void scanImportsSeriesAndServesIdenticalPixels() {
        var scan = json(post("/api/import"));
        assertThat(scan.get("imported").asInt()).isEqualTo(2);

        int patientId = patientId("Test Patient");
        var volumes = json(get("/api/Patients/" + patientId + "/Volumes"));
        assertThat(volumes.size()).isEqualTo(2);

        var a = volumeId(patientId, "A");
        assertThat(pixelHash(patientId, a)).isEqualTo("29e4f383059b0ee2");
        assertThat(pixelHash(patientId, volumeId(patientId, "B"))).isEqualTo("f8619c3cfca60076");

        var full = json(get("/api/Patients/" + patientId + "/Volumes/" + a));
        var slices = full.get("slices");
        var slice = slices.get(0);
        assertThat(slices.size()).isEqualTo(20);
        assertThat(slice.get("radiodensities").size())
                .isEqualTo(slice.get("widthPixels").asInt() * slice.get("heightPixels").asInt());

        // Coronal: ordered anterior to posterior along the normal, not by z (which is the same for every slice).
        assertThat(vector(full.get("rowDirection"))).containsExactly(new double[] {0.999993, -0.0036927, 0},
                within(1e-5));
        assertThat(vector(full.get("columnDirection"))).containsExactly(new double[] {0, 0, -1}, within(1e-9));
        assertThat(slice.get("positionYMm").asDouble()).isCloseTo(-81.1051, within(1e-3));
        assertThat(slices.get(19).get("positionYMm").asDouble()).isCloseTo(4.39434, within(1e-3));
        for (int i = 1; i < slices.size(); i++) {
            assertThat(slices.get(i).get("depthPositionMm").asDouble())
                    .isGreaterThan(slices.get(i - 1).get("depthPositionMm").asDouble());
        }
        assertThat(full.get("valueUnits").asString()).isEmpty();
        assertThat(full.get("valueSlope").asDouble()).isEqualTo(1);
        assertThat(full.get("minValue").asDouble()).isEqualTo(1);
        assertThat(full.get("formatVersion").asInt()).isEqualTo(1);
    }

    @Test
    @Order(2)
    void rescanIsIdempotent() {
        int patientId = patientId("Test Patient");
        int a = volumeId(patientId, "A");

        var scan = json(post("/api/import"));
        assertThat(scan.get("imported").asInt()).isZero();
        assertThat(scan.get("unchanged").asInt()).isEqualTo(2);
        assertThat(volumeId(patientId, "A")).isEqualTo(a);
    }

    @Test
    @Order(3)
    void changedSeriesIsReimportedUnderSameId() throws IOException {
        int patientId = patientId("Test Patient");
        int a = volumeId(patientId, "A");
        var seriesA = DATA_DIR.resolve("Test Patient").resolve("A");
        try (var files = Files.list(seriesA)) {
            Files.delete(files.sorted().toList().getLast());
        }

        var scan = json(post("/api/import"));
        assertThat(scan.get("updated").asInt()).isEqualTo(1);
        assertThat(volumeId(patientId, "A")).isEqualTo(a);
        assertThat(json(get("/api/Patients/" + patientId + "/Volumes/" + a)).get("slices").size()).isEqualTo(19);
        assertThat(pixelFileCount()).isEqualTo(2);
    }

    @Test
    @Order(4)
    void uploadToPatientCreatesVolumeAndRejectsDuplicateSeries() throws IOException {
        int patientId = patientId("Test Patient");
        var path = "/api/Patients/" + patientId + "/Volumes";

        var response = upload(path, dicomFiles("series-00004"));
        assertThat(response.getStatusCode().value()).isEqualTo(201);
        var created = json(response);
        int volumeId = created.get(0).get("volumeId").asInt();
        assertThat(response.getHeaders().getLocation()).hasToString(
                "http://localhost:" + environment.getProperty("local.server.port") + path + "/" + volumeId);
        assertThat(pixelHash(patientId, volumeId)).isEqualTo("2f920b558e0568a6");

        assertThat(upload(path, dicomFiles("series-00004")).getStatusCode().value()).isEqualTo(409);
    }

    @Test
    @Order(5)
    void zipUploadFilesSeriesUnderPatientFromTags() throws IOException {
        var zip = WORK.resolve("series.zip");
        try (var out = new ZipOutputStream(Files.newOutputStream(zip))) {
            for (var file : dicomFiles("series-00005")) {
                out.putNextEntry(new ZipEntry("nested/" + file.getFileName()));
                Files.copy(file, out);
                out.closeEntry();
            }
        }

        var response = upload("/api/Volumes", List.of(zip));
        assertThat(response.getStatusCode().value()).isEqualTo(201);
        var created = json(response).get(0);
        int patientId = created.get("patientId").asInt();
        assertThat(patientId).isNotEqualTo(patientId("Test Patient"));
        assertThat(pixelHash(patientId, created.get("volumeId").asInt())).isEqualTo("8b5702f3be31959f");
    }

    @Test
    @Order(6)
    void nonDicomUploadIsRejected() throws IOException {
        var junk = Files.writeString(WORK.resolve("notes.txt"), "not a DICOM file");
        assertThat(upload("/api/Patients/" + patientId("Test Patient") + "/Volumes", List.of(junk))
                .getStatusCode().value()).isEqualTo(400);
        assertThat(upload("/api/Patients/9999/Volumes", List.of(junk)).getStatusCode().value()).isEqualTo(404);
    }

    @Test
    @Order(7)
    void deletedVolumeStaysDeletedAfterRescan() {
        int patientId = patientId("Test Patient");
        int a = volumeId(patientId, "A");
        int files = pixelFileCount();

        assertThat(delete("/api/Patients/" + patientId + "/Volumes/" + a).getStatusCode().value()).isEqualTo(204);
        assertThat(get("/api/Patients/" + patientId + "/Volumes/" + a).getStatusCode().value()).isEqualTo(404);
        assertThat(pixelFileCount()).isEqualTo(files - 1);

        var scan = json(post("/api/import"));
        assertThat(scan.get("excluded").asInt()).isEqualTo(1);
        assertThat(scan.get("imported").asInt()).isZero();
    }

    @Test
    @Order(8)
    void deletingPatientRemovesVolumesSlicesAndFiles() {
        int patientId = patientId("Test Patient");
        int files = pixelFileCount();
        int volumes = json(get("/api/Patients/" + patientId + "/Volumes")).size();

        assertThat(delete("/api/Patients/" + patientId).getStatusCode().value()).isEqualTo(204);
        assertThat(get("/api/Patients/" + patientId).getStatusCode().value()).isEqualTo(404);
        assertThat(pixelFileCount()).isEqualTo(files - volumes);
        assertThat(jdbc.sql("SELECT COUNT(*) FROM slices s LEFT JOIN volumes v ON v.id = s.volume_id "
                + "WHERE v.id IS NULL").query(Integer.class).single()).isZero();
    }

    @Test
    @Order(9)
    void unreadableSeriesIsRecordedAndNotRetriedUntilChanged() throws IOException {
        var broken = Files.createDirectories(DATA_DIR.resolve("Broken").resolve("X"));
        Files.writeString(broken.resolve("image.dcm"), "garbage");

        assertThat(json(post("/api/import")).get("failed").asInt()).isEqualTo(1);
        var failures = json(get("/api/import/status")).get("failures");
        assertThat(failures.size()).isEqualTo(1);
        assertThat(failures.get(0).get("sourcePath").asString()).isEqualTo("Broken/X");
        assertThat(json(post("/api/import")).get("failed").asInt()).isZero();

        Files.delete(broken.resolve("image.dcm"));
        copyDir(SAMPLES.resolve("series-00002"), broken);
        assertThat(json(post("/api/import")).get("imported").asInt()).isEqualTo(1);
        assertThat(json(get("/api/import/status")).get("failures").size()).isZero();
    }

    @Test
    @Order(10)
    void mixedOrientationSeriesIsSplitAndPartsAreDeletedIndividually() throws IOException {
        copyDir(SAMPLES.resolve("series-00000"), DATA_DIR.resolve("Localizer").resolve("L"));
        assertThat(json(post("/api/import")).get("imported").asInt()).isEqualTo(1);

        int patientId = patientId("Localizer");
        var names = new ArrayList<String>();
        json(get("/api/Patients/" + patientId + "/Volumes")).forEach(v -> names.add(v.get("name").asString()));
        assertThat(names).containsExactly("L (axial)", "L (coronal)", "L (sagittal)");

        int sagittal = volumeId(patientId, "L (sagittal)");
        var volume = json(get("/api/Patients/" + patientId + "/Volumes/" + sagittal));
        assertThat(volume.get("slices").size()).isEqualTo(9);
        assertThat(vector(volume.get("rowDirection"))).containsExactly(new double[] {0, 1, 0}, within(1e-9));

        int excludedBefore = json(post("/api/import")).get("excluded").asInt();
        assertThat(delete("/api/Patients/" + patientId + "/Volumes/" + sagittal).getStatusCode().value())
                .isEqualTo(204);
        // The directory still has volumes, so it is scanned as usual rather than excluded.
        var scan = json(post("/api/import"));
        assertThat(scan.get("excluded").asInt()).isEqualTo(excludedBefore);
        assertThat(scan.get("updated").asInt()).isZero();
        assertThat(scan.get("imported").asInt()).isZero();

        // A changed directory is re-imported, but the deleted part stays deleted.
        Files.delete(DATA_DIR.resolve("Localizer").resolve("L").resolve("image-00000.dcm"));
        assertThat(json(post("/api/import")).get("updated").asInt()).isEqualTo(1);
        assertThat(json(get("/api/Patients/" + patientId + "/Volumes")).size()).isEqualTo(2);
        assertThat(get("/api/Patients/" + patientId + "/Volumes/" + sagittal).getStatusCode().value())
                .isEqualTo(404);
    }

    @Test
    @Order(11)
    void ctValuesAreStoredInHounsfieldUnitsWithoutPadding() throws IOException {
        copyDir(CT_SAMPLE, DATA_DIR.resolve("CT Patient").resolve("Head"));
        assertThat(json(post("/api/import")).get("imported").asInt()).isEqualTo(1);

        int patientId = patientId("CT Patient");
        int volumeId = volumeId(patientId, "Head");
        var summary = json(get("/api/Patients/" + patientId + "/Volumes")).get(0);
        assertThat(summary.get("valueUnits").asString()).isEqualTo("HU");
        assertThat(summary.get("valueSlope").asDouble()).isEqualTo(1);
        assertThat(summary.get("valueIntercept").asDouble()).isEqualTo(0);
        // Raw pixels are HU + 1024, and the -2000 padding outside the scan circle becomes the lowest value.
        assertThat(summary.get("minValue").asDouble()).isEqualTo(-1024);

        int[] range = pixelRange(patientId, volumeId);
        assertThat(range[0]).isEqualTo(-1024);
        assertThat(range[1]).isEqualTo((int) summary.get("maxValue").asDouble());
    }

    // ---- helpers ----

    private static double[] vector(JsonNode node) {
        return new double[] {node.get(0).asDouble(), node.get(1).asDouble(), node.get(2).asDouble()};
    }

    private int[] pixelRange(int patientId, int volumeId) {
        var body = get("/api/Patients/" + patientId + "/Volumes/" + volumeId + "/binary").getBody();
        int metadataLength = ByteBuffer.wrap(body, 0, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
        int offset = (4 + metadataLength + 3) & ~3;
        var pixels = ByteBuffer.wrap(body, offset, body.length - offset).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer();
        int min = Short.MAX_VALUE;
        int max = Short.MIN_VALUE;
        while (pixels.hasRemaining()) {
            short value = pixels.get();
            min = Math.min(min, value);
            max = Math.max(max, value);
        }
        return new int[] {min, max};
    }

    private ResponseEntity<byte[]> get(String path) {
        return http.get().uri(path).retrieve().onStatus(s -> true, (req, res) -> {}).toEntity(byte[].class);
    }

    private ResponseEntity<byte[]> post(String path) {
        return http.post().uri(path).retrieve().onStatus(s -> true, (req, res) -> {}).toEntity(byte[].class);
    }

    private ResponseEntity<byte[]> delete(String path) {
        return http.delete().uri(path).retrieve().onStatus(s -> true, (req, res) -> {}).toEntity(byte[].class);
    }

    private ResponseEntity<byte[]> upload(String path, List<Path> files) {
        var parts = new LinkedMultiValueMap<String, Object>();
        files.forEach(f -> parts.add("files", new FileSystemResource(f)));
        return http.post().uri(path).contentType(MediaType.MULTIPART_FORM_DATA).body(parts)
                .retrieve().onStatus(s -> true, (req, res) -> {}).toEntity(byte[].class);
    }

    private JsonNode json(ResponseEntity<byte[]> response) {
        assertThat(response.getStatusCode().is2xxSuccessful()).as("status %s", response.getStatusCode()).isTrue();
        return json.readTree(response.getBody());
    }

    private int patientId(String name) {
        for (var p : json(get("/api/Patients"))) {
            if (p.get("name").asString().equals(name)) {
                return p.get("patientId").asInt();
            }
        }
        throw new AssertionError("No patient " + name);
    }

    private int volumeId(int patientId, String name) {
        for (var v : json(get("/api/Patients/" + patientId + "/Volumes"))) {
            if (v.get("name").asString().equals(name)) {
                return v.get("volumeId").asInt();
            }
        }
        throw new AssertionError("No volume " + name);
    }

    /** First 16 hex chars of the SHA-256 of the pixel section of the /binary response. */
    private String pixelHash(int patientId, int volumeId) {
        var body = get("/api/Patients/" + patientId + "/Volumes/" + volumeId + "/binary").getBody();
        int metadataLength = ByteBuffer.wrap(body, 0, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
        int offset = (4 + metadataLength + 3) & ~3;
        try {
            var digest = MessageDigest.getInstance("SHA-256").digest(Arrays.copyOfRange(body, offset, body.length));
            return HexFormat.of().formatHex(digest).substring(0, 16);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static int pixelFileCount() {
        try (var files = Files.list(STORE_DIR.resolve("volumes"))) {
            return (int) files.count();
        } catch (IOException e) {
            throw new AssertionError(e);
        }
    }

    private static List<Path> dicomFiles(String series) throws IOException {
        try (var files = Files.list(SAMPLES.resolve(series))) {
            return files.sorted().toList();
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
