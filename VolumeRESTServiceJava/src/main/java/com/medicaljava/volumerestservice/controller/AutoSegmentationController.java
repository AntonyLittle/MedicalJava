package com.medicaljava.volumerestservice.controller;

import com.medicaljava.volumerestservice.segmentation.AutoSegmentationService;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Models offered by the automatic segmentation worker, and the jobs running on it. */
@RestController
@RequestMapping("/api/segmentation")
public class AutoSegmentationController {

    private final AutoSegmentationService auto;

    public AutoSegmentationController(AutoSegmentationService auto) {
        this.auto = auto;
    }

    @GetMapping("/models")
    public ResponseEntity<AutoSegmentationService.ModelList> models() {
        return ResponseEntity.ok(auto.models());
    }

    @GetMapping("/jobs/{jobId}")
    public ResponseEntity<AutoSegmentationService.Job> job(@PathVariable String jobId) {
        return ResponseEntity.ok(auto.job(jobId));
    }
}
