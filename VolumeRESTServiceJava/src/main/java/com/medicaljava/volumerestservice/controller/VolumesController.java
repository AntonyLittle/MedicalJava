package com.medicaljava.volumerestservice.controller;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;
import com.medicaljava.volumerestservice.model.Slice;
import com.medicaljava.volumerestservice.model.Volume;
import com.medicaljava.volumerestservice.repository.PatientRepository;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/Patients/{patientId}/Volumes")
public class VolumesController {

    private final PatientRepository repo;
    private final ObjectMapper objectMapper;

    public VolumesController(PatientRepository repo, ObjectMapper objectMapper) {
        this.repo = repo;
        this.objectMapper = objectMapper;
    }

    @GetMapping
    public ResponseEntity<?> get(@PathVariable int patientId) {
        try {
            return ResponseEntity.ok(new ArrayList<>(repo.getVolumeSummaries(patientId)));
        } catch (Exception e) {
            return ResponseEntity.badRequest().build();
        }
    }

    @GetMapping("/{id}")
    public ResponseEntity<?> get(@PathVariable int patientId, @PathVariable int id) {
        try {
            return ResponseEntity.ok(repo.getVolume(patientId, id));
        } catch (Exception e) {
            return ResponseEntity.badRequest().build();
        }
    }

    /**
     * Same volume as GET /{id} but without JSON pixel arrays. Layout, little-endian:
     * uint32 metadata length N, N bytes of UTF-8 JSON (slices carry empty radiodensities), zero padding to a
     * 4-byte boundary, then every slice's width*height int16 pixels back to back in the JSON slice order.
     */
    @GetMapping(value = "/{id}/binary", produces = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<StreamingResponseBody> getBinary(@PathVariable int patientId, @PathVariable int id) {
        Volume volume;
        byte[] metadata;
        try {
            volume = repo.getVolume(patientId, id);
            metadata = objectMapper.writeValueAsBytes(withoutPixels(volume));
        } catch (JacksonException e) {
            return ResponseEntity.internalServerError().build();
        } catch (Exception e) {
            return ResponseEntity.badRequest().build();
        }

        StreamingResponseBody body = out -> {
            int headerLength = 4 + metadata.length;
            ByteBuffer header = ByteBuffer.allocate((headerLength + 3) & ~3).order(ByteOrder.LITTLE_ENDIAN);
            header.putInt(metadata.length).put(metadata);
            out.write(header.array());

            for (Slice slice : volume.slices()) {
                ByteBuffer pixels = ByteBuffer.allocate(slice.radiodensities().length * Short.BYTES)
                        .order(ByteOrder.LITTLE_ENDIAN);
                pixels.asShortBuffer().put(slice.radiodensities());
                out.write(pixels.array());
            }
        };
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_OCTET_STREAM).body(body);
    }

    private static Volume withoutPixels(Volume volume) {
        return volume.withSlicesAndSpatial(
                volume.slices().stream()
                        .map(s -> new Slice(s.sliceId(), s.volumeId(), s.patientId(), s.index(), s.widthPixels(),
                                s.heightPixels(), s.widthMm(), s.heightMm(), s.depthPositionMm(), s.originXMm(),
                                s.originYMm(), s.pixelSpacingXMm(), s.pixelSpacingYMm(), new short[0]))
                        .collect(Collectors.toList()),
                volume.width(), volume.height(), volume.depth());
    }
}
