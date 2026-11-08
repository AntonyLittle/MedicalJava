package com.medicaljava.volumerestservice.segmentation;

import com.medicaljava.volumerestservice.model.Segment;
import com.medicaljava.volumerestservice.model.Segmentation;
import com.medicaljava.volumerestservice.model.Volume;
import com.medicaljava.volumerestservice.store.VolumeStore.DicomReferences;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.util.UIDUtils;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;

/**
 * Writes a segmentation as a binary DICOM Segmentation object: one frame per segment and slice the segment appears
 * in, on the volume's own pixel grid, referencing the source images when their UIDs are known. Volumes imported
 * without DICOM UIDs get deterministic study and frame of reference UIDs, so repeated exports stay consistent.
 */
public final class DicomSegWriter {

    static final String SOFTWARE_NAME = "MedicalJava";
    private static final String SOFTWARE_VERSION = "1.0.0";
    private static final int SERIES_NUMBER = 300;

    private record Frame(Segment segment, int slice) {}

    private DicomSegWriter() {}

    /** {@code labels} holds one label per voxel, slices in the volume's order. */
    public static void write(Volume volume, DicomReferences refs, Segmentation segmentation, byte[] labels,
            OutputStream out) throws IOException {
        var slices = volume.slices();
        var first = slices.getFirst();
        int rows = first.heightPixels();
        int columns = first.widthPixels();
        int sliceSize = rows * columns;

        // Segments that have voxels, numbered 1..n in DICOM, and the slices each appears in.
        var present = new boolean[256][slices.size()];
        for (int k = 0; k < slices.size(); k++) {
            int offset = k * sliceSize;
            for (int i = 0; i < sliceSize; i++) {
                present[labels[offset + i] & 0xFF][k] = true;
            }
        }
        var segments = new ArrayList<Segment>();
        var frames = new ArrayList<Frame>();
        for (var segment : segmentation.segments()) {
            var slicesWithSegment = present[segment.label()];
            boolean any = false;
            for (int k = 0; k < slices.size(); k++) {
                if (slicesWithSegment[k]) {
                    if (!any) {
                        segments.add(segment);
                        any = true;
                    }
                    frames.add(new Frame(segment, k));
                }
            }
        }
        if (frames.isEmpty()) {
            throw new com.medicaljava.volumerestservice.store.InvalidSegmentationException(
                    "The segmentation has no labelled voxels in any listed segment, so there is nothing to export");
        }

        var now = LocalDateTime.now();
        var date = now.format(DateTimeFormatter.BASIC_ISO_DATE);
        var time = now.format(DateTimeFormatter.ofPattern("HHmmss"));
        var seed = "medicaljava:" + volume.volumeId() + ":" + refs.seriesInstanceUid();
        var studyUid = refs.studyInstanceUid() != null ? refs.studyInstanceUid()
                : UIDUtils.createNameBasedUID((seed + ":study").getBytes(StandardCharsets.UTF_8));
        var frameOfReferenceUid = refs.frameOfReferenceUid() != null ? refs.frameOfReferenceUid()
                : UIDUtils.createNameBasedUID((seed + ":for").getBytes(StandardCharsets.UTF_8));
        var sopInstanceUid = UIDUtils.createUID();

        var ds = new Attributes();
        ds.setString(Tag.SpecificCharacterSet, VR.CS, "ISO_IR 192");
        ds.setString(Tag.SOPClassUID, VR.UI, UID.SegmentationStorage);
        ds.setString(Tag.SOPInstanceUID, VR.UI, sopInstanceUid);
        ds.setString(Tag.ImageType, VR.CS, "DERIVED", "PRIMARY");
        ds.setString(Tag.InstanceCreationDate, VR.DA, date);
        ds.setString(Tag.InstanceCreationTime, VR.TM, time);

        // Patient and study: the source volume's.
        ds.setString(Tag.PatientName, VR.PN, nullToEmpty(refs.patientName()));
        ds.setString(Tag.PatientID, VR.LO, nullToEmpty(refs.patientId()));
        ds.setNull(Tag.PatientBirthDate, VR.DA);
        ds.setNull(Tag.PatientSex, VR.CS);
        ds.setString(Tag.StudyInstanceUID, VR.UI, studyUid);
        ds.setNull(Tag.StudyDate, VR.DA);
        ds.setNull(Tag.StudyTime, VR.TM);
        ds.setNull(Tag.ReferringPhysicianName, VR.PN);
        ds.setNull(Tag.StudyID, VR.SH);
        ds.setNull(Tag.AccessionNumber, VR.SH);

        // Series, equipment and frame of reference.
        ds.setString(Tag.Modality, VR.CS, "SEG");
        ds.setString(Tag.SeriesInstanceUID, VR.UI, UIDUtils.createUID());
        ds.setInt(Tag.SeriesNumber, VR.IS, SERIES_NUMBER);
        ds.setString(Tag.SeriesDescription, VR.LO, truncate(segmentation.name(), 64));
        ds.setString(Tag.SeriesDate, VR.DA, date);
        ds.setString(Tag.SeriesTime, VR.TM, time);
        ds.setString(Tag.FrameOfReferenceUID, VR.UI, frameOfReferenceUid);
        ds.setNull(Tag.PositionReferenceIndicator, VR.LO);
        ds.setString(Tag.Manufacturer, VR.LO, SOFTWARE_NAME);
        ds.setString(Tag.ManufacturerModelName, VR.LO, SOFTWARE_NAME);
        ds.setString(Tag.DeviceSerialNumber, VR.LO, "1");
        ds.setString(Tag.SoftwareVersions, VR.LO, SOFTWARE_VERSION);

        // Segmentation image.
        ds.setInt(Tag.InstanceNumber, VR.IS, 1);
        ds.setString(Tag.ContentDate, VR.DA, date);
        ds.setString(Tag.ContentTime, VR.TM, time);
        ds.setString(Tag.ContentLabel, VR.CS, "SEGMENTATION");
        ds.setString(Tag.ContentDescription, VR.LO, truncate(segmentation.name(), 64));
        ds.setString(Tag.ContentCreatorName, VR.PN, SOFTWARE_NAME);
        ds.setString(Tag.SegmentationType, VR.CS, "BINARY");
        ds.setString(Tag.LossyImageCompression, VR.CS, "00");
        ds.setInt(Tag.SamplesPerPixel, VR.US, 1);
        ds.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        ds.setInt(Tag.Rows, VR.US, rows);
        ds.setInt(Tag.Columns, VR.US, columns);
        ds.setInt(Tag.BitsAllocated, VR.US, 1);
        ds.setInt(Tag.BitsStored, VR.US, 1);
        ds.setInt(Tag.HighBit, VR.US, 0);
        ds.setInt(Tag.PixelRepresentation, VR.US, 0);
        ds.setInt(Tag.NumberOfFrames, VR.IS, frames.size());

        var segmentSequence = ds.newSequence(Tag.SegmentSequence, segments.size());
        for (int n = 0; n < segments.size(); n++) {
            segmentSequence.add(segmentItem(segments.get(n), n + 1));
        }

        addDimensions(ds);
        addSharedGroups(ds, volume);
        boolean referencesKnown = refs.seriesInstanceUid() != null
                && refs.sources().size() == slices.size()
                && refs.sources().stream().allMatch(s -> s.sopClassUid() != null && s.sopInstanceUid() != null);
        if (referencesKnown) {
            var series = ds.newSequence(Tag.ReferencedSeriesSequence, 1);
            var item = new Attributes();
            item.setString(Tag.SeriesInstanceUID, VR.UI, refs.seriesInstanceUid());
            var instances = item.newSequence(Tag.ReferencedInstanceSequence, refs.sources().size());
            for (var source : refs.sources()) {
                var instance = new Attributes();
                instance.setString(Tag.ReferencedSOPClassUID, VR.UI, source.sopClassUid());
                instance.setString(Tag.ReferencedSOPInstanceUID, VR.UI, source.sopInstanceUid());
                instances.add(instance);
            }
            series.add(item);
        }

        var perFrame = ds.newSequence(Tag.PerFrameFunctionalGroupsSequence, frames.size());
        for (var frame : frames) {
            int segmentNumber = segments.indexOf(frame.segment()) + 1;
            var slice = slices.get(frame.slice());
            var item = new Attributes();
            var content = new Attributes();
            content.setInt(Tag.DimensionIndexValues, VR.UL, segmentNumber, frame.slice() + 1);
            item.newSequence(Tag.FrameContentSequence, 1).add(content);
            var position = new Attributes();
            position.setDouble(Tag.ImagePositionPatient, VR.DS, slice.positionXMm(), slice.positionYMm(),
                    slice.positionZMm());
            item.newSequence(Tag.PlanePositionSequence, 1).add(position);
            var identification = new Attributes();
            identification.setInt(Tag.ReferencedSegmentNumber, VR.US, segmentNumber);
            item.newSequence(Tag.SegmentIdentificationSequence, 1).add(identification);
            if (referencesKnown) {
                var source = refs.sources().get(frame.slice());
                var derivation = new Attributes();
                derivation.newSequence(Tag.DerivationCodeSequence, 1).add(code("113076", "DCM", "Segmentation"));
                var sourceImage = new Attributes();
                sourceImage.setString(Tag.ReferencedSOPClassUID, VR.UI, source.sopClassUid());
                sourceImage.setString(Tag.ReferencedSOPInstanceUID, VR.UI, source.sopInstanceUid());
                // Each frame lies exactly on its source image's pixel grid.
                sourceImage.setString(Tag.SpatialLocationsPreserved, VR.CS, "YES");
                sourceImage.newSequence(Tag.PurposeOfReferenceCodeSequence, 1)
                        .add(code("121322", "DCM", "Source image for image processing operation"));
                derivation.newSequence(Tag.SourceImageSequence, 1).add(sourceImage);
                item.newSequence(Tag.DerivationImageSequence, 1).add(derivation);
            }
            perFrame.add(item);
        }

        ds.setBytes(Tag.PixelData, VR.OB, packFrames(frames, labels, sliceSize));

        try (var dos = new DicomOutputStream(out, UID.ExplicitVRLittleEndian)) {
            dos.writeDataset(ds.createFileMetaInformation(UID.ExplicitVRLittleEndian), ds);
        }
    }

    // Frames follow each other bit by bit (not byte-aligned), first pixel in the lowest bit; the whole is padded
    // to an even length.
    private static byte[] packFrames(List<Frame> frames, byte[] labels, int sliceSize) {
        long bits = (long) frames.size() * sliceSize;
        long bytes = (bits + 7) / 8;
        if (bytes % 2 == 1) {
            bytes++;
        }
        if (bytes > Integer.MAX_VALUE - 8) {
            throw new com.medicaljava.volumerestservice.store.InvalidSegmentationException(
                    "The segmentation is too large for a single DICOM SEG object");
        }
        var pixelData = new byte[(int) bytes];
        long bit = 0;
        for (var frame : frames) {
            int offset = frame.slice() * sliceSize;
            int label = frame.segment().label();
            for (int i = 0; i < sliceSize; i++, bit++) {
                if ((labels[offset + i] & 0xFF) == label) {
                    pixelData[(int) (bit >>> 3)] |= (byte) (1 << (bit & 7));
                }
            }
        }
        return pixelData;
    }

    private static Attributes segmentItem(Segment segment, int number) {
        var item = new Attributes();
        item.setInt(Tag.SegmentNumber, VR.US, number);
        item.setString(Tag.SegmentLabel, VR.LO, truncate(segment.name(), 64));
        item.setString(Tag.SegmentAlgorithmType, VR.CS, segment.algorithmType());
        if (!"MANUAL".equals(segment.algorithmType())) {
            item.setString(Tag.SegmentAlgorithmName, VR.LO, SOFTWARE_NAME);
        }
        item.setInt(Tag.RecommendedDisplayCIELabValue, VR.US, CieLab.fromRgb(segment.color()));
        // The structure isn't coded, so it is described generically; SegmentLabel carries the name.
        item.newSequence(Tag.SegmentedPropertyCategoryCodeSequence, 1).add(code("85756007", "SCT", "Tissue"));
        item.newSequence(Tag.SegmentedPropertyTypeCodeSequence, 1).add(code("85756007", "SCT", "Tissue"));
        return item;
    }

    private static void addDimensions(Attributes ds) {
        var organizationUid = UIDUtils.createUID();
        var organization = new Attributes();
        organization.setString(Tag.DimensionOrganizationUID, VR.UI, organizationUid);
        ds.newSequence(Tag.DimensionOrganizationSequence, 1).add(organization);
        ds.setString(Tag.DimensionOrganizationType, VR.CS, "3D");

        var index = ds.newSequence(Tag.DimensionIndexSequence, 2);
        var bySegment = new Attributes();
        bySegment.setString(Tag.DimensionOrganizationUID, VR.UI, organizationUid);
        bySegment.setInt(Tag.DimensionIndexPointer, VR.AT, Tag.ReferencedSegmentNumber);
        bySegment.setInt(Tag.FunctionalGroupPointer, VR.AT, Tag.SegmentIdentificationSequence);
        bySegment.setString(Tag.DimensionDescriptionLabel, VR.LO, "ReferencedSegmentNumber");
        index.add(bySegment);
        var byPosition = new Attributes();
        byPosition.setString(Tag.DimensionOrganizationUID, VR.UI, organizationUid);
        byPosition.setInt(Tag.DimensionIndexPointer, VR.AT, Tag.ImagePositionPatient);
        byPosition.setInt(Tag.FunctionalGroupPointer, VR.AT, Tag.PlanePositionSequence);
        byPosition.setString(Tag.DimensionDescriptionLabel, VR.LO, "ImagePositionPatient");
        index.add(byPosition);
    }

    private static void addSharedGroups(Attributes ds, Volume volume) {
        var slices = volume.slices();
        var first = slices.getFirst();
        double thickness = SegmentationStatistics.sliceThickness(slices)[0];
        if (slices.size() > 1) {
            thickness = (slices.getLast().depthPositionMm() - first.depthPositionMm()) / (slices.size() - 1);
        }
        var shared = new Attributes();
        var measures = new Attributes();
        measures.setDouble(Tag.PixelSpacing, VR.DS, first.pixelSpacingYMm(), first.pixelSpacingXMm());
        measures.setDouble(Tag.SliceThickness, VR.DS, Math.abs(thickness));
        measures.setDouble(Tag.SpacingBetweenSlices, VR.DS, Math.abs(thickness));
        shared.newSequence(Tag.PixelMeasuresSequence, 1).add(measures);
        var orientation = new Attributes();
        var row = volume.rowDirection();
        var column = volume.columnDirection();
        orientation.setDouble(Tag.ImageOrientationPatient, VR.DS, row[0], row[1], row[2], column[0], column[1],
                column[2]);
        shared.newSequence(Tag.PlaneOrientationSequence, 1).add(orientation);
        ds.newSequence(Tag.SharedFunctionalGroupsSequence, 1).add(shared);
    }

    static Attributes code(String value, String scheme, String meaning) {
        var code = new Attributes();
        code.setString(Tag.CodeValue, VR.SH, value);
        code.setString(Tag.CodingSchemeDesignator, VR.SH, scheme);
        code.setString(Tag.CodeMeaning, VR.LO, meaning);
        return code;
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }

    private static String truncate(String s, int length) {
        var text = s == null ? "" : s;
        return text.length() <= length ? text : text.substring(0, length);
    }
}
