package com.medicaljava.volumerestservice.controller;

import com.medicaljava.volumerestservice.model.Segment;
import com.medicaljava.volumerestservice.model.SegmentStatistics;
import com.medicaljava.volumerestservice.model.Segmentation;
import com.medicaljava.volumerestservice.segmentation.AutoSegmentationService;
import com.medicaljava.volumerestservice.segmentation.SegmentationService;
import com.medicaljava.volumerestservice.store.PreconditionFailedException;
import com.medicaljava.volumerestservice.store.SegmentationStore;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.util.List;
import java.util.Locale;
import java.util.zip.GZIPInputStream;

/**
 * Segmentations (labelmaps) of a volume. Labels travel as one uint8 per voxel in the volume's slice order; GET
 * sends them gzip-encoded when the client accepts it, PUT takes them raw or with Content-Encoding: gzip. Changes take
 * an optional If-Match with the ETag (the revision) and fail with 412 when someone else changed it first.
 */
@RestController
@RequestMapping("/api/Patients/{patientId}/Volumes/{volumeId}/Segmentations")
public class SegmentationsController {

    public record CreateRequest(String name, List<Segment> segments) {}

    public record UpdateRequest(String name, List<Segment> segments) {}

    public record AutoRequest(String model, String name) {}

    private final SegmentationStore store;
    private final SegmentationService service;
    private final AutoSegmentationService auto;

    public SegmentationsController(SegmentationStore store, SegmentationService service,
            AutoSegmentationService auto) {
        this.store = store;
        this.service = service;
        this.auto = auto;
    }

    @GetMapping
    public ResponseEntity<List<Segmentation>> list(@PathVariable int patientId, @PathVariable int volumeId) {
        return ResponseEntity.ok(store.list(patientId, volumeId));
    }

    /** Creates an empty segmentation (every voxel background) with the given segments. */
    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Segmentation> create(@PathVariable int patientId, @PathVariable int volumeId,
            @RequestBody CreateRequest request) throws IOException {
        return created(store.create(patientId, volumeId, request.name(), "manual", request.segments(), null));
    }

    @GetMapping("/{id}")
    public ResponseEntity<Segmentation> get(@PathVariable int patientId, @PathVariable int volumeId,
            @PathVariable int id) {
        return withEtag(ResponseEntity.ok(), store.get(patientId, volumeId, id));
    }

    @PatchMapping(value = "/{id}", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Segmentation> update(@PathVariable int patientId, @PathVariable int volumeId,
            @PathVariable int id, @RequestHeader(value = HttpHeaders.IF_MATCH, required = false) String ifMatch,
            @RequestBody UpdateRequest request) {
        return withEtag(ResponseEntity.ok(), store.update(patientId, volumeId, id, revision(ifMatch), request.name(),
                request.segments()));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable int patientId, @PathVariable int volumeId,
            @PathVariable int id) {
        store.delete(patientId, volumeId, id);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/{id}/labels")
    public ResponseEntity<StreamingResponseBody> labels(@PathVariable int patientId, @PathVariable int volumeId,
            @PathVariable int id, @RequestHeader(value = HttpHeaders.ACCEPT_ENCODING, required = false)
            String acceptEncoding) {
        var stored = store.labels(patientId, volumeId, id);
        var file = stored.labelFile();
        boolean gzip = acceptEncoding != null && acceptEncoding.toLowerCase(Locale.ROOT).contains("gzip");
        var response = ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .eTag(etag(stored.segmentation()))
                .header(HttpHeaders.VARY, HttpHeaders.ACCEPT_ENCODING);
        if (gzip) {
            return response.header(HttpHeaders.CONTENT_ENCODING, "gzip")
                    .body(out -> Files.copy(file, out));
        }
        return response.contentLength(stored.segmentation().voxelCount()).body(out -> {
            try (var in = new GZIPInputStream(new BufferedInputStream(Files.newInputStream(file)), 65536)) {
                in.transferTo(out);
            }
        });
    }

    @PutMapping("/{id}/labels")
    public ResponseEntity<Segmentation> putLabels(@PathVariable int patientId, @PathVariable int volumeId,
            @PathVariable int id, @RequestHeader(value = HttpHeaders.IF_MATCH, required = false) String ifMatch,
            HttpServletRequest request) throws IOException {
        try (var body = decoded(request)) {
            return withEtag(ResponseEntity.ok(), store.replaceLabels(patientId, volumeId, id, revision(ifMatch), body));
        }
    }

    @GetMapping("/{id}/stats")
    public ResponseEntity<List<SegmentStatistics>> stats(@PathVariable int patientId, @PathVariable int volumeId,
            @PathVariable int id) throws IOException {
        return ResponseEntity.ok(service.statistics(patientId, volumeId, id));
    }

    @GetMapping("/{id}/dicom")
    public ResponseEntity<StreamingResponseBody> exportDicom(@PathVariable int patientId,
            @PathVariable int volumeId, @PathVariable int id) throws IOException {
        var segmentation = store.get(patientId, volumeId, id);
        var fileName = segmentation.name().replaceAll("[^A-Za-z0-9._ ()-]", "_") + ".dcm";
        var file = service.exportDicom(patientId, volumeId, id);
        try {
            long size = Files.size(file);
            return ResponseEntity.ok()
                    .contentType(MediaType.parseMediaType("application/dicom"))
                    .contentLength(size)
                    .header(HttpHeaders.CONTENT_DISPOSITION,
                            ContentDisposition.attachment().filename(fileName).build().toString())
                    .body(out -> {
                        try {
                            Files.copy(file, out);
                        } finally {
                            Files.deleteIfExists(file);
                        }
                    });
        } catch (IOException | RuntimeException e) {
            Files.deleteIfExists(file);
            throw e;
        }
    }

    /** Imports a DICOM SEG file as a new segmentation of this volume. */
    @PostMapping(value = "/dicom", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<Segmentation> importDicom(@PathVariable int patientId, @PathVariable int volumeId,
            @RequestParam("file") MultipartFile file) throws IOException {
        try (var in = file.getInputStream()) {
            return created(service.importDicom(patientId, volumeId, in));
        }
    }

    /** Starts automatic segmentation on the worker; poll /api/segmentation/jobs/{jobId}. */
    @PostMapping(value = "/auto", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<AutoSegmentationService.Job> startAuto(@PathVariable int patientId,
            @PathVariable int volumeId, @RequestBody AutoRequest request) {
        var job = auto.start(patientId, volumeId, request.model(), request.name());
        return ResponseEntity.accepted()
                .location(ServletUriComponentsBuilder.fromCurrentContextPath()
                        .path("/api/segmentation/jobs/{jobId}").buildAndExpand(job.jobId()).toUri())
                .body(job);
    }

    @GetMapping("/auto")
    public ResponseEntity<List<AutoSegmentationService.Job>> autoJobs(@PathVariable int patientId,
            @PathVariable int volumeId) {
        return ResponseEntity.ok(auto.jobs(patientId, volumeId));
    }

    private static ResponseEntity<Segmentation> created(Segmentation segmentation) {
        var location = ServletUriComponentsBuilder.fromCurrentContextPath()
                .path("/api/Patients/{patientId}/Volumes/{volumeId}/Segmentations/{id}")
                .buildAndExpand(segmentation.patientId(), segmentation.volumeId(), segmentation.segmentationId())
                .toUri();
        return withEtag(ResponseEntity.created(location), segmentation);
    }

    private static ResponseEntity<Segmentation> withEtag(ResponseEntity.BodyBuilder builder,
            Segmentation segmentation) {
        return builder.eTag(etag(segmentation)).body(segmentation);
    }

    private static String etag(Segmentation segmentation) {
        return "\"" + segmentation.revision() + "\"";
    }

    // The revision an If-Match header asks for; null for none or "*".
    private static Integer revision(String ifMatch) {
        if (ifMatch == null || ifMatch.isBlank() || ifMatch.strip().equals("*")) {
            return null;
        }
        var value = ifMatch.strip();
        if (value.startsWith("W/")) {
            value = value.substring(2);
        }
        value = value.replace("\"", "");
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException e) {
            throw new PreconditionFailedException("If-Match must be a segmentation ETag");
        }
    }

    private static InputStream decoded(HttpServletRequest request) throws IOException {
        var encoding = request.getHeader(HttpHeaders.CONTENT_ENCODING);
        InputStream body = new BufferedInputStream(request.getInputStream(), 65536);
        if (encoding != null && encoding.toLowerCase(Locale.ROOT).contains("gzip")) {
            return new GZIPInputStream(body, 65536);
        }
        return body;
    }
}
