package com.medicaljava.volumerestservice.segmentation;

import com.medicaljava.volumerestservice.model.Segment;
import com.medicaljava.volumerestservice.repository.PatientRepository;
import com.medicaljava.volumerestservice.store.InvalidSegmentationException;
import com.medicaljava.volumerestservice.store.SegmentationStore;
import com.medicaljava.volumerestservice.store.StorePaths;
import com.medicaljava.volumerestservice.store.VolumeStore;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Runs automatic segmentation on an external worker (see SegmentationWorker/). Jobs run one at a time, in the order
 * they were started; each sends the volume to the worker in the /binary format and stores the labelmap it returns as
 * a new segmentation. Jobs are kept in memory, so a restart forgets them (their results stay stored).
 *
 * <p>Worker protocol: {@code GET /models} returns {@code {"models": [{"id", "name", "description", "available",
 * "unavailableReason"}]}}. {@code POST /segment?model=id} takes the volume binary and returns, little-endian, a uint32
 * length N, N bytes of UTF-8 JSON {@code {"name", "segments": [{"label", "name", "color"}]}}, zero padding to a 4-byte
 * boundary, then one uint8 label per voxel in the volume's slice order. Errors are non-2xx with
 * {@code {"error": "..."}}.
 */
@Service
public class AutoSegmentationService {

    private static final Logger LOG = LoggerFactory.getLogger(AutoSegmentationService.class);
    private static final int MAX_KEPT_JOBS = 100;

    public record Model(String id, String name, String description, boolean available, String unavailableReason) {}

    public record ModelList(String workerUrl, boolean workerAvailable, String error, List<Model> models) {}

    /** state is queued, running, succeeded or failed; segmentationId is set once it succeeded. */
    public record Job(String jobId, int patientId, int volumeId, String model, String name, String state,
            String message, Integer segmentationId, Instant createdAt, Instant startedAt, Instant finishedAt) {

        Job with(String newState, String newMessage, Integer newSegmentationId, Instant started, Instant finished) {
            return new Job(jobId, patientId, volumeId, model, name, newState, newMessage, newSegmentationId,
                    createdAt, started, finished);
        }
    }

    private final URI workerUrl;
    private final Duration timeout;
    private final PatientRepository repo;
    private final VolumeStore volumes;
    private final SegmentationStore store;
    private final StorePaths paths;
    private final ObjectMapper json;
    private final HttpClient http;
    private final ExecutorService executor = Executors.newSingleThreadExecutor(
            Thread.ofVirtual().name("auto-segmentation").factory());
    private final Map<String, Job> jobs = new LinkedHashMap<>();

    public AutoSegmentationService(@Value("${app.segmentation.worker-url:http://localhost:54809}") String workerUrl,
            @Value("${app.segmentation.worker-timeout:4h}") Duration timeout,
            PatientRepository repo, VolumeStore volumes, SegmentationStore store, StorePaths paths,
            ObjectMapper json) {
        this.workerUrl = URI.create(workerUrl.endsWith("/") ? workerUrl : workerUrl + "/");
        this.timeout = timeout;
        this.repo = repo;
        this.volumes = volumes;
        this.store = store;
        this.paths = paths;
        this.json = json;
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    }

    public ModelList models() {
        try {
            var response = http.send(HttpRequest.newBuilder(workerUrl.resolve("models"))
                    .timeout(Duration.ofSeconds(10)).GET().build(), HttpResponse.BodyHandlers.ofByteArray());
            if (response.statusCode() != 200) {
                return new ModelList(workerUrl.toString(), false, "Worker answered " + response.statusCode(),
                        List.of());
            }
            var models = new ArrayList<Model>();
            for (var m : json.readTree(response.body()).path("models")) {
                models.add(new Model(m.path("id").asString(), m.path("name").asString(m.path("id").asString()),
                        m.path("description").asString(""), m.path("available").asBoolean(true),
                        m.path("unavailableReason").isMissingNode() || m.path("unavailableReason").isNull() ? null
                                : m.path("unavailableReason").asString()));
            }
            return new ModelList(workerUrl.toString(), true, null, models);
        } catch (IOException e) {
            return new ModelList(workerUrl.toString(), false, "Can't reach the segmentation worker at " + workerUrl
                    + " (" + e.getClass().getSimpleName() + "). Start it with SegmentationWorker/worker.py.", List.of());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }

    public synchronized Job start(int patientId, int volumeId, String model, String name) {
        volumes.getVolume(patientId, volumeId);
        if (model == null || model.isBlank()) {
            throw new InvalidSegmentationException("Choose a model");
        }
        var job = new Job(UUID.randomUUID().toString(), patientId, volumeId, model, name, "queued", null, null,
                Instant.now(), null, null);
        jobs.put(job.jobId(), job);
        while (jobs.size() > MAX_KEPT_JOBS) {
            jobs.remove(jobs.keySet().iterator().next());
        }
        executor.submit(() -> run(job.jobId()));
        return job;
    }

    public synchronized Job job(String jobId) {
        var job = jobs.get(jobId);
        if (job == null) {
            throw new NoSuchElementException("Job not found");
        }
        return job;
    }

    public synchronized List<Job> jobs(int patientId, int volumeId) {
        return jobs.values().stream().filter(j -> j.patientId() == patientId && j.volumeId() == volumeId).toList();
    }

    private synchronized void update(Job job) {
        jobs.put(job.jobId(), job);
    }

    private void run(String jobId) {
        var job = job(jobId);
        var started = Instant.now();
        update(job.with("running", "Sending the volume to the worker", null, started, null));
        try {
            int segmentationId = segment(job, started);
            update(job.with("succeeded", null, segmentationId, started, Instant.now()));
        } catch (Exception e) {
            LOG.warn("Auto-segmentation job {} ({}) failed", jobId, job.model(), e);
            var message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            update(job.with("failed", message, null, started, Instant.now()));
        }
    }

    private int segment(Job job, Instant started) throws IOException, InterruptedException {
        var tmp = Files.createTempFile(paths.tmp(), "auto-", ".bin");
        try {
            try (var out = Files.newOutputStream(tmp)) {
                repo.getVolumeBinary(job.patientId(), job.volumeId()).writeTo(out);
            }
            var uri = workerUrl.resolve("segment?model=" + URLEncoder.encode(job.model(), StandardCharsets.UTF_8));
            var request = HttpRequest.newBuilder(uri)
                    .timeout(timeout)
                    .header("Content-Type", "application/octet-stream")
                    .POST(HttpRequest.BodyPublishers.ofFile(tmp))
                    .build();
            update(job.with("running", "Segmenting", null, started, null));
            HttpResponse<InputStream> response;
            try {
                response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
            } catch (IOException e) {
                throw new IOException("Can't reach the segmentation worker at " + workerUrl + ": " + e.getMessage(), e);
            }
            try (var body = new BufferedInputStream(response.body(), 65536)) {
                if (response.statusCode() / 100 != 2) {
                    var text = new String(body.readNBytes(64 * 1024), StandardCharsets.UTF_8);
                    String error;
                    try {
                        error = json.readTree(text).path("error").asString(text);
                    } catch (RuntimeException e) {
                        error = text;
                    }
                    throw new IOException("The worker failed (" + response.statusCode() + "): " + error);
                }
                var data = new DataInputStream(body);
                var lengthBytes = data.readNBytes(4);
                if (lengthBytes.length < 4) {
                    throw new IOException("The worker sent an empty response");
                }
                int length = ByteBuffer.wrap(lengthBytes).order(ByteOrder.LITTLE_ENDIAN).getInt();
                if (length <= 0 || length > 16 * 1024 * 1024) {
                    throw new IOException("The worker sent a malformed response");
                }
                var header = json.readTree(data.readNBytes(length));
                data.skipNBytes(((4 + length + 3) & ~3) - 4 - length);
                var segments = segments(header);
                var name = job.name() != null && !job.name().isBlank() ? job.name()
                        : header.path("name").asString(job.model()) + " (auto)";
                return store.create(job.patientId(), job.volumeId(), name, "auto:" + job.model(), segments, data)
                        .segmentationId();
            }
        } finally {
            VolumeStore.deleteQuietly(tmp);
        }
    }

    private static List<Segment> segments(JsonNode header) {
        var segments = new ArrayList<Segment>();
        for (var s : header.path("segments")) {
            int label = s.path("label").asInt();
            var color = s.path("color").asString(DicomSegReader.PALETTE[Math.floorMod(label - 1,
                    DicomSegReader.PALETTE.length)]);
            segments.add(new Segment(label, s.path("name").asString("Segment " + label), color, "AUTOMATIC"));
        }
        return segments;
    }
}
