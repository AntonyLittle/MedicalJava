package com.medicaljava.volumerestservice;

import com.sun.net.httpserver.HttpServer;

import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.env.Environment;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.FileSystemUtils;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/** End-to-end tests of segmentations: storage, revisions, statistics, DICOM SEG and automatic segmentation. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class SegmentationIntegrationTest {

    private static final Path SAMPLES = Path.of("..", "Data", "Anonymized_20261014");
    private static final Path CT_SAMPLE = Path.of("..", "Data", "John Doe", "Series Repeat 3");
    private static final Path WORK;
    private static final Path DATA_DIR;
    private static final Path STORE_DIR;
    private static final HttpServer WORKER;
    private static final ObjectMapper JSON = new ObjectMapper();

    static {
        try {
            WORK = Files.createTempDirectory("segmentation-test");
            DATA_DIR = WORK.resolve("data");
            STORE_DIR = WORK.resolve("store");
            copyDir(CT_SAMPLE, DATA_DIR.resolve("CT Patient").resolve("Head"));
            copyDir(SAMPLES.resolve("series-00002"), DATA_DIR.resolve("MR Patient").resolve("A"));
            WORKER = fakeWorker();
        } catch (IOException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", DATA_DIR::toString);
        registry.add("app.store-dir", STORE_DIR::toString);
        registry.add("app.import-on-startup", () -> "false");
        registry.add("app.segmentation.worker-url", () -> "http://localhost:" + WORKER.getAddress().getPort());
    }

    @AfterAll
    static void cleanUp() throws IOException {
        WORKER.stop(0);
        FileSystemUtils.deleteRecursively(WORK);
    }

    @Autowired
    Environment environment;

    RestClient http;

    @BeforeEach
    void setUp() {
        http = RestClient.create("http://localhost:" + environment.getProperty("local.server.port"));
    }

    @Test
    @Order(1)
    void createdSegmentationStartsEmptyAndTakesLabelsWithRevisions() throws IOException {
        assertThat(json(post("/api/import")).get("imported").asInt()).isEqualTo(2);
        var base = segmentationsPath("CT Patient", "Head");
        var volume = binaryVolume("CT Patient", "Head");

        var created = postJson(base, Map.of("name", "Head", "segments",
                List.of(Map.of("label", 1, "name", "Bone", "color", "#FF0000"))));
        assertThat(created.getStatusCode().value()).isEqualTo(201);
        assertThat(created.getHeaders().getETag()).isEqualTo("\"1\"");
        var segmentation = json(created);
        int id = segmentation.get("segmentationId").asInt();
        assertThat(segmentation.get("voxelCount").asLong()).isEqualTo(volume.pixels().length);
        assertThat(segmentation.get("stale").asBoolean()).isFalse();
        assertThat(segmentation.get("segments").get(0).get("color").asString()).isEqualTo("#ff0000");
        assertThat(segmentation.get("segments").get(0).get("algorithmType").asString()).isEqualTo("MANUAL");

        var empty = labels(base + "/" + id);
        assertThat(empty).hasSize(volume.pixels().length);
        assertThat(countLabel(empty, 0)).isEqualTo(empty.length);

        var labels = boneLabels(volume);
        var put = putLabels(base + "/" + id, labels, "\"1\"");
        assertThat(put.getStatusCode().value()).isEqualTo(200);
        assertThat(json(put).get("revision").asInt()).isEqualTo(2);
        assertThat(putLabels(base + "/" + id, labels, "\"1\"").getStatusCode().value()).isEqualTo(412);
        assertThat(putLabels(base + "/" + id, new byte[10], null).getStatusCode().value()).isEqualTo(400);

        assertThat(labels(base + "/" + id)).isEqualTo(labels);
        var plain = http.get().uri(base + "/" + id + "/labels").header(HttpHeaders.ACCEPT_ENCODING, "identity")
                .retrieve().toEntity(byte[].class);
        assertThat(plain.getHeaders().getFirst(HttpHeaders.CONTENT_ENCODING)).isNull();
        assertThat(plain.getBody()).isEqualTo(labels);
    }

    @Test
    @Order(2)
    void statisticsCountVoxelsAndValues() {
        var base = segmentationsPath("CT Patient", "Head");
        int id = onlySegmentationId(base);
        var volume = binaryVolume("CT Patient", "Head");
        var labels = labels(base + "/" + id);

        var stats = json(get(base + "/" + id + "/stats"));
        var bone = stats.get(0);
        assertThat(bone.get("label").asInt()).isEqualTo(1);
        assertThat(bone.get("name").asString()).isEqualTo("Bone");
        long bones = countLabel(labels, 1);
        assertThat(bone.get("voxelCount").asLong()).isEqualTo(bones);
        assertThat(bone.get("min").asDouble()).isGreaterThanOrEqualTo(300);
        assertThat(bone.get("mean").asDouble()).isGreaterThan(300);
        assertThat(bone.get("units").asString()).isEqualTo("HU");
        var slices = volume.metadata().get("slices");
        double spacingZ = (slices.get(slices.size() - 1).get("depthPositionMm").asDouble()
                - slices.get(0).get("depthPositionMm").asDouble()) / (slices.size() - 1);
        double voxelMl = slices.get(0).get("pixelSpacingXMm").asDouble()
                * slices.get(0).get("pixelSpacingYMm").asDouble() * spacingZ / 1000;
        assertThat(bone.get("volumeMl").asDouble()).isCloseTo(bones * voxelMl, within(bones * voxelMl * 0.02));

        // The marker voxels have no segment entry yet.
        var marker = stats.get(1);
        assertThat(marker.get("label").asInt()).isEqualTo(2);
        assertThat(marker.get("name").asString()).isEqualTo("Label 2");
        assertThat(marker.get("voxelCount").asLong()).isEqualTo(10);
    }

    @Test
    @Order(3)
    void segmentTableIsUpdatedWithRevisionCheck() {
        var base = segmentationsPath("CT Patient", "Head");
        int id = onlySegmentationId(base);
        var body = Map.of("segments", List.of(
                Map.of("label", 1, "name", "Bone", "color", "#ff0000", "algorithmType", "SEMIAUTOMATIC"),
                Map.of("label", 2, "name", "Marker", "color", "#00ff00")));
        assertThat(patchJson(base + "/" + id, body, "\"1\"").getStatusCode().value()).isEqualTo(412);
        var updated = json(patchJson(base + "/" + id, body, "\"2\""));
        assertThat(updated.get("revision").asInt()).isEqualTo(3);
        assertThat(updated.get("segments").size()).isEqualTo(2);

        var duplicate = Map.of("segments", List.of(Map.of("label", 1, "name", "A", "color", "#ff0000"),
                Map.of("label", 1, "name", "B", "color", "#00ff00")));
        assertThat(patchJson(base + "/" + id, duplicate, null).getStatusCode().value()).isEqualTo(400);
        assertThat(patchJson(base + "/" + id, Map.of("name", "Renamed"), null).getStatusCode().value())
                .isEqualTo(200);
    }

    @Test
    @Order(4)
    void dicomSegExportReimportsToTheSameLabels() throws IOException {
        var base = segmentationsPath("CT Patient", "Head");
        int id = onlySegmentationId(base);
        var labels = labels(base + "/" + id);
        var volume = binaryVolume("CT Patient", "Head");
        int sliceSize = volume.metadata().get("slices").get(0).get("widthPixels").asInt()
                * volume.metadata().get("slices").get(0).get("heightPixels").asInt();

        var exported = get(base + "/" + id + "/dicom");
        assertThat(exported.getStatusCode().value()).isEqualTo(200);
        assertThat(exported.getHeaders().getContentType()).hasToString("application/dicom");
        var dicom = exported.getBody();
        try (var in = new DicomInputStream(new ByteArrayInputStream(dicom))) {
            var ds = in.readDataset();
            assertThat(ds.getString(Tag.SOPClassUID)).isEqualTo(UID.SegmentationStorage);
            assertThat(ds.getString(Tag.Modality)).isEqualTo("SEG");
            assertThat(ds.getString(Tag.SeriesDescription)).isEqualTo("Renamed");
            assertThat(ds.getSequence(Tag.SegmentSequence)).hasSize(2);
            int framesExpected = 0;
            for (int label = 1; label <= 2; label++) {
                for (int k = 0; k < labels.length / sliceSize; k++) {
                    for (int i = 0; i < sliceSize; i++) {
                        if (labels[k * sliceSize + i] == label) {
                            framesExpected++;
                            break;
                        }
                    }
                }
            }
            assertThat(ds.getInt(Tag.NumberOfFrames, 0)).isEqualTo(framesExpected);
            // Version 2 imports keep the UIDs, so the SEG references its source series.
            var series = ds.getSequence(Tag.ReferencedSeriesSequence);
            assertThat(series).hasSize(1);
            assertThat(series.getFirst().getSequence(Tag.ReferencedInstanceSequence))
                    .hasSize(labels.length / sliceSize);
            assertThat(ds.getString(Tag.FrameOfReferenceUID)).isNotNull();
        }

        var parts = new LinkedMultiValueMap<String, Object>();
        parts.add("file", new ByteArrayResource(dicom) {
            @Override
            public String getFilename() {
                return "seg.dcm";
            }
        });
        var imported = http.post().uri(base + "/dicom").contentType(MediaType.MULTIPART_FORM_DATA).body(parts)
                .retrieve().onStatus(s -> true, (req, res) -> {}).toEntity(byte[].class);
        assertThat(imported.getStatusCode().value()).isEqualTo(201);
        var segmentation = json(imported);
        assertThat(segmentation.get("source").asString()).isEqualTo("dicom-seg");
        assertThat(segmentation.get("name").asString()).isEqualTo("Renamed");
        var segments = segmentation.get("segments");
        assertThat(segments.get(0).get("name").asString()).isEqualTo("Bone");
        assertThat(segments.get(0).get("algorithmType").asString()).isEqualTo("SEMIAUTOMATIC");
        assertThat(segments.get(1).get("name").asString()).isEqualTo("Marker");
        assertThat(colorDistance(segments.get(0).get("color").asString(), "#ff0000")).isLessThanOrEqualTo(3);
        assertThat(colorDistance(segments.get(1).get("color").asString(), "#00ff00")).isLessThanOrEqualTo(3);
        assertThat(labels(base + "/" + segmentation.get("segmentationId").asInt())).isEqualTo(labels);

        var notSeg = new LinkedMultiValueMap<String, Object>();
        notSeg.add("file", new ByteArrayResource("garbage".getBytes(StandardCharsets.UTF_8)) {
            @Override
            public String getFilename() {
                return "x.dcm";
            }
        });
        assertThat(http.post().uri(base + "/dicom").contentType(MediaType.MULTIPART_FORM_DATA).body(notSeg)
                .retrieve().onStatus(s -> true, (req, res) -> {}).toEntity(byte[].class).getStatusCode().value())
                .isEqualTo(400);
    }

    @Test
    @Order(5)
    void reimportWithNewGeometryMakesSegmentationStaleUntilLabelsAreReplaced() throws IOException {
        var base = segmentationsPath("MR Patient", "A");
        var created = json(postJson(base, Map.of("name", "MR", "segments", List.of())));
        int id = created.get("segmentationId").asInt();

        // An unchanged rescan keeps it current.
        json(post("/api/import"));
        assertThat(json(get(base + "/" + id)).get("stale").asBoolean()).isFalse();

        try (var files = Files.list(DATA_DIR.resolve("MR Patient").resolve("A"))) {
            Files.delete(files.sorted().toList().getLast());
        }
        assertThat(json(post("/api/import")).get("updated").asInt()).isEqualTo(1);
        var stale = json(get(base + "/" + id));
        assertThat(stale.get("stale").asBoolean()).isTrue();
        assertThat(get(base + "/" + id + "/stats").getStatusCode().value()).isEqualTo(400);
        assertThat(get(base + "/" + id + "/dicom").getStatusCode().value()).isEqualTo(400);

        var volume = binaryVolume("MR Patient", "A");
        var fresh = json(putLabels(base + "/" + id, new byte[volume.pixels().length], null));
        assertThat(fresh.get("stale").asBoolean()).isFalse();
        assertThat(fresh.get("voxelCount").asLong()).isEqualTo(volume.pixels().length);
    }

    @Test
    @Order(6)
    void autoSegmentationStoresTheWorkersLabels() throws Exception {
        var models = json(get("/api/segmentation/models"));
        assertThat(models.get("workerAvailable").asBoolean()).isTrue();
        assertThat(models.get("models").get(0).get("id").asString()).isEqualTo("fake");

        var base = segmentationsPath("CT Patient", "Head");
        var started = postJson(base + "/auto", Map.of("model", "fake"));
        assertThat(started.getStatusCode().value()).isEqualTo(202);
        var job = waitForJob(json(started).get("jobId").asString());
        assertThat(job.get("state").asString()).as(job.toString()).isEqualTo("succeeded");

        var segmentation = json(get(base + "/" + job.get("segmentationId").asInt()));
        assertThat(segmentation.get("source").asString()).isEqualTo("auto:fake");
        assertThat(segmentation.get("name").asString()).isEqualTo("Fake model (auto)");
        assertThat(segmentation.get("segments").get(0).get("algorithmType").asString()).isEqualTo("AUTOMATIC");
        var volume = binaryVolume("CT Patient", "Head");
        var labels = labels(base + "/" + segmentation.get("segmentationId").asInt());
        for (int i = 0; i < labels.length; i++) {
            assertThat(labels[i]).isEqualTo((byte) (volume.pixels()[i] > 0 ? 1 : 0));
        }

        var failed = waitForJob(json(postJson(base + "/auto", Map.of("model", "broken"))).get("jobId").asString());
        assertThat(failed.get("state").asString()).isEqualTo("failed");
        assertThat(failed.get("message").asString()).contains("boom");
        assertThat(json(get(base + "/auto")).size()).isEqualTo(2);
    }

    @Test
    @Order(7)
    void deletingSegmentationsVolumesAndPatientsRemovesLabelFiles() throws IOException {
        var base = segmentationsPath("CT Patient", "Head");
        int files = labelFileCount();
        var any = json(get(base)).get(0).get("segmentationId").asInt();
        assertThat(delete(base + "/" + any).getStatusCode().value()).isEqualTo(204);
        assertThat(get(base + "/" + any).getStatusCode().value()).isEqualTo(404);
        assertThat(labelFileCount()).isEqualTo(files - 1);

        int patientId = patientId("CT Patient");
        assertThat(delete("/api/Patients/" + patientId).getStatusCode().value()).isEqualTo(204);
        int mrPatient = patientId("MR Patient");
        int mrVolume = volumeId(mrPatient, "A");
        assertThat(delete("/api/Patients/" + mrPatient + "/Volumes/" + mrVolume).getStatusCode().value())
                .isEqualTo(204);
        assertThat(labelFileCount()).isZero();
    }

    // ---- fake worker ----

    // "fake" labels every voxel with a positive stored value; "broken" fails.
    private static HttpServer fakeWorker() throws IOException {
        var server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        server.createContext("/models", exchange -> {
            var body = "{\"models\":[{\"id\":\"fake\",\"name\":\"Fake\",\"available\":true}]}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.createContext("/segment", exchange -> {
            var request = exchange.getRequestBody().readAllBytes();
            if (exchange.getRequestURI().getQuery().contains("broken")) {
                var body = "{\"error\":\"boom\"}".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(500, body.length);
                exchange.getResponseBody().write(body);
                exchange.close();
                return;
            }
            int length = ByteBuffer.wrap(request, 0, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
            int offset = (4 + length + 3) & ~3;
            var pixels = ByteBuffer.wrap(request, offset, request.length - offset).order(ByteOrder.LITTLE_ENDIAN)
                    .asShortBuffer();
            var labels = new byte[pixels.remaining()];
            for (int i = 0; i < labels.length; i++) {
                labels[i] = (byte) (pixels.get(i) > 0 ? 1 : 0);
            }
            var header = "{\"name\":\"Fake model\",\"segments\":[{\"label\":1,\"name\":\"Positive\",\"color\":\"#123456\"}]}"
                    .getBytes(StandardCharsets.UTF_8);
            int padded = (4 + header.length + 3) & ~3;
            var response = ByteBuffer.allocate(padded + labels.length).order(ByteOrder.LITTLE_ENDIAN);
            response.putInt(header.length).put(header).position(padded);
            response.put(labels);
            exchange.sendResponseHeaders(200, response.capacity());
            exchange.getResponseBody().write(response.array());
            exchange.close();
        });
        server.start();
        return server;
    }

    // ---- helpers ----

    private record BinaryVolume(JsonNode metadata, short[] pixels) {}

    private BinaryVolume binaryVolume(String patient, String volume) {
        int patientId = patientId(patient);
        var body = get("/api/Patients/" + patientId + "/Volumes/" + volumeId(patientId, volume) + "/binary").getBody();
        int metadataLength = ByteBuffer.wrap(body, 0, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
        var metadata = JSON.readTree(new String(body, 4, metadataLength, StandardCharsets.UTF_8));
        int offset = (4 + metadataLength + 3) & ~3;
        var buffer = ByteBuffer.wrap(body, offset, body.length - offset).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer();
        var pixels = new short[buffer.remaining()];
        buffer.get(pixels);
        return new BinaryVolume(metadata, pixels);
    }

    // Bone (>= 300 HU) is label 1; ten voxels at the start of the first slice are label 2.
    private static byte[] boneLabels(BinaryVolume volume) {
        var labels = new byte[volume.pixels().length];
        for (int i = 0; i < labels.length; i++) {
            labels[i] = (byte) (volume.pixels()[i] >= 300 ? 1 : 0);
        }
        for (int i = 0; i < 10; i++) {
            labels[i] = 2;
        }
        return labels;
    }

    private JsonNode waitForJob(String jobId) throws InterruptedException {
        for (int i = 0; i < 200; i++) {
            var job = json(get("/api/segmentation/jobs/" + jobId));
            var state = job.get("state").asString();
            if (state.equals("succeeded") || state.equals("failed")) {
                return job;
            }
            Thread.sleep(100);
        }
        throw new AssertionError("Job " + jobId + " didn't finish");
    }

    private String segmentationsPath(String patient, String volume) {
        int patientId = patientId(patient);
        return "/api/Patients/" + patientId + "/Volumes/" + volumeId(patientId, volume) + "/Segmentations";
    }

    private int onlySegmentationId(String base) {
        var list = json(get(base));
        assertThat(list.size()).isEqualTo(1);
        return list.get(0).get("segmentationId").asInt();
    }

    private byte[] labels(String segmentationPath) {
        var response = http.get().uri(segmentationPath + "/labels").header(HttpHeaders.ACCEPT_ENCODING, "gzip")
                .retrieve().toEntity(byte[].class);
        var body = response.getBody();
        if ("gzip".equals(response.getHeaders().getFirst(HttpHeaders.CONTENT_ENCODING))) {
            try (var in = new GZIPInputStream(new ByteArrayInputStream(body))) {
                return in.readAllBytes();
            } catch (IOException e) {
                throw new AssertionError(e);
            }
        }
        return body;
    }

    private ResponseEntity<byte[]> putLabels(String segmentationPath, byte[] labels, String ifMatch) {
        var gzip = new ByteArrayOutputStream();
        try (var out = new GZIPOutputStream(gzip)) {
            out.write(labels);
        } catch (IOException e) {
            throw new AssertionError(e);
        }
        var request = http.put().uri(segmentationPath + "/labels")
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .header(HttpHeaders.CONTENT_ENCODING, "gzip");
        if (ifMatch != null) {
            request = request.header(HttpHeaders.IF_MATCH, ifMatch);
        }
        return request.body(gzip.toByteArray()).retrieve().onStatus(s -> true, (req, res) -> {})
                .toEntity(byte[].class);
    }

    private static long countLabel(byte[] labels, int label) {
        long count = 0;
        for (var l : labels) {
            if ((l & 0xFF) == label) {
                count++;
            }
        }
        return count;
    }

    private static int colorDistance(String a, String b) {
        int distance = 0;
        for (int i = 1; i < 7; i += 2) {
            distance = Math.max(distance, Math.abs(Integer.parseInt(a.substring(i, i + 2), 16)
                    - Integer.parseInt(b.substring(i, i + 2), 16)));
        }
        return distance;
    }

    private static int labelFileCount() throws IOException {
        try (var files = Files.list(STORE_DIR.resolve("segmentations"))) {
            return (int) files.count();
        }
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

    private ResponseEntity<byte[]> postJson(String path, Object body) {
        return http.post().uri(path).contentType(MediaType.APPLICATION_JSON).body(JSON.writeValueAsBytes(body))
                .retrieve().onStatus(s -> true, (req, res) -> {}).toEntity(byte[].class);
    }

    private ResponseEntity<byte[]> patchJson(String path, Object body, String ifMatch) {
        var request = http.patch().uri(path).contentType(MediaType.APPLICATION_JSON);
        if (ifMatch != null) {
            request = request.header(HttpHeaders.IF_MATCH, ifMatch);
        }
        return request.body(JSON.writeValueAsBytes(body)).retrieve().onStatus(s -> true, (req, res) -> {})
                .toEntity(byte[].class);
    }

    private JsonNode json(ResponseEntity<byte[]> response) {
        assertThat(response.getStatusCode().is2xxSuccessful())
                .as("status %s: %s", response.getStatusCode(),
                        response.getBody() == null ? "" : new String(response.getBody(), StandardCharsets.UTF_8))
                .isTrue();
        return JSON.readTree(response.getBody());
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
        var names = new HashSet<String>();
        for (var v : json(get("/api/Patients/" + patientId + "/Volumes"))) {
            names.add(v.get("name").asString());
            if (v.get("name").asString().equals(name)) {
                return v.get("volumeId").asInt();
            }
        }
        throw new AssertionError("No volume " + name + " in " + names);
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
