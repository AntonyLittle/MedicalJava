package com.medicaljava.volumerestservice.controller;

import com.medicaljava.volumerestservice.model.Volume;
import com.medicaljava.volumerestservice.repository.PatientRepository;
import com.medicaljava.volumerestservice.store.DataDirectoryScanner;
import com.medicaljava.volumerestservice.store.DataDirectoryScanner.ImportStatus;
import com.medicaljava.volumerestservice.store.DataDirectoryScanner.ScanResult;
import com.medicaljava.volumerestservice.store.VolumeImporter;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.List;

@RestController
@RequestMapping("/api")
public class ImportController {

    private final DataDirectoryScanner scanner;
    private final VolumeImporter importer;
    private final PatientRepository repo;

    public ImportController(DataDirectoryScanner scanner, VolumeImporter importer, PatientRepository repo) {
        this.scanner = scanner;
        this.importer = importer;
        this.repo = repo;
    }

    /** Rescans the data directory synchronously. */
    @PostMapping("/import")
    public ResponseEntity<ScanResult> importDataDirectory() {
        return ResponseEntity.ok(scanner.scan());
    }

    @GetMapping("/import/status")
    public ResponseEntity<ImportStatus> importStatus() {
        return ResponseEntity.ok(scanner.status());
    }

    /** Uploads DICOM files and/or zip archives, filing each series under the patient named in its tags. */
    @PostMapping(value = "/Volumes", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<List<Volume>> upload(@RequestParam("files") List<MultipartFile> files)
            throws IOException {
        return VolumesController.created(repo, importer.importUpload(null, files));
    }
}
