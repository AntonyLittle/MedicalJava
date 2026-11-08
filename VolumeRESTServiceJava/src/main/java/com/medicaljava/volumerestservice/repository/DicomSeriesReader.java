package com.medicaljava.volumerestservice.repository;

import com.medicaljava.volumerestservice.model.Slice;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Fragments;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Path;

/** Decodes a single DICOM image into a {@link Slice} plus the series/patient tags needed to file it. */
public final class DicomSeriesReader {

    public record SeriesInfo(
            String patientName,
            String patientId,
            String seriesInstanceUid,
            String seriesDescription,
            String seriesNumber,
            String modality,
            String studyInstanceUid,
            String frameOfReferenceUid) {

        public SeriesInfo(String patientName, String patientId, String seriesInstanceUid, String seriesDescription,
                String seriesNumber, String modality) {
            this(patientName, patientId, seriesInstanceUid, seriesDescription, seriesNumber, modality, null, null);
        }
    }

    /** The DICOM instance a slice was decoded from; either UID may be null. */
    public record SourceImage(String sopClassUid, String sopInstanceUid) {}

    /** Patient-space (LPS) orientation and position of an image: ImageOrientationPatient and ImagePositionPatient. */
    public record ImagePlane(double[] rowDirection, double[] columnDirection, double[] position) {}

    /**
     * How the raw pixel bits map to values: interpret them with {@code signed}/{@code bitsStored}, then
     * {@code real = stored * rescaleSlope + rescaleIntercept}. Stored values in [paddingLow, paddingHigh] are padding
     * (not part of the image); both are null when there is none.
     */
    public record PixelEncoding(
            boolean signed,
            int bitsStored,
            double rescaleSlope,
            double rescaleIntercept,
            boolean hasRescale,
            String rescaleType,
            Integer paddingLow,
            Integer paddingHigh) {

        public int interpret(short raw) {
            int value = raw & 0xFFFF;
            if (bitsStored < 16) {
                value &= (1 << bitsStored) - 1;
                if (signed && (value & (1 << (bitsStored - 1))) != 0) {
                    value -= 1 << bitsStored;
                }
            } else if (signed) {
                value = (short) value;
            }
            return value;
        }

        public boolean isPadding(int value) {
            return paddingLow != null && value >= paddingLow && value <= paddingHigh;
        }
    }

    /**
     * The slice's volumeId and patientId are 0; they are assigned when the volume is stored. Its radiodensities
     * hold the raw pixel bits, to be interpreted with {@code encoding}.
     */
    public record DecodedSlice(SeriesInfo info, Slice slice, ImagePlane plane, PixelEncoding encoding,
            SourceImage source) {

        public DecodedSlice(SeriesInfo info, Slice slice, ImagePlane plane, PixelEncoding encoding) {
            this(info, slice, plane, encoding, new SourceImage(null, null));
        }
    }

    private static final double[] AXIAL_ROW = {1, 0, 0};
    private static final double[] AXIAL_COLUMN = {0, 1, 0};

    private DicomSeriesReader() {}

    public static DecodedSlice read(Path dicomFile, int sliceIndex) throws IOException {
        try (var dis = new DicomInputStream(dicomFile.toFile())) {
            var dataset = dis.readDataset();

            int width = dataset.getInt(Tag.Columns, 0);
            int height = dataset.getInt(Tag.Rows, 0);
            short[] radiodensities = readPixels(dataset, dis.getTransferSyntax(), width, height);

            // DICOM PixelSpacing is [row spacing (y), column spacing (x)].
            var pixelSpacing = dataset.getDoubles(Tag.PixelSpacing);
            var imagePosition = dataset.getDoubles(Tag.ImagePositionPatient);
            if (pixelSpacing == null || pixelSpacing.length < 2
                    || imagePosition == null || imagePosition.length < 3) {
                throw new IOException("Missing PixelSpacing or ImagePositionPatient");
            }
            double pixelSpacingY = pixelSpacing[0];
            double pixelSpacingX = pixelSpacing[1];
            var plane = new ImagePlane(
                    orientationVector(dataset, 0, AXIAL_ROW),
                    orientationVector(dataset, 3, AXIAL_COLUMN),
                    new double[] {imagePosition[0], imagePosition[1], imagePosition[2]});

            var slice = new Slice(sliceIndex, 0, 0, sliceIndex, width, height,
                    pixelSpacingX * width, pixelSpacingY * height, imagePosition[2],
                    imagePosition[0], imagePosition[1], pixelSpacingX, pixelSpacingY,
                    imagePosition[0], imagePosition[1], imagePosition[2], radiodensities);

            var info = new SeriesInfo(
                    dataset.getString(Tag.PatientName),
                    dataset.getString(Tag.PatientID),
                    dataset.getString(Tag.SeriesInstanceUID),
                    dataset.getString(Tag.SeriesDescription),
                    dataset.getString(Tag.SeriesNumber),
                    dataset.getString(Tag.Modality),
                    dataset.getString(Tag.StudyInstanceUID),
                    dataset.getString(Tag.FrameOfReferenceUID));
            var source = new SourceImage(
                    dataset.getString(Tag.SOPClassUID, dis.getFileMetaInformation() == null ? null
                            : dis.getFileMetaInformation().getString(Tag.MediaStorageSOPClassUID)),
                    dataset.getString(Tag.SOPInstanceUID, dis.getFileMetaInformation() == null ? null
                            : dis.getFileMetaInformation().getString(Tag.MediaStorageSOPInstanceUID)));
            return new DecodedSlice(info, slice, plane, pixelEncoding(dataset), source);
        }
    }

    // Images without ImageOrientationPatient are treated as axial, as before orientation was supported.
    private static double[] orientationVector(Attributes dataset, int offset, double[] fallback) {
        var orientation = dataset.getDoubles(Tag.ImageOrientationPatient);
        if (orientation == null || orientation.length < 6) {
            return fallback.clone();
        }
        return new double[] {orientation[offset], orientation[offset + 1], orientation[offset + 2]};
    }

    private static PixelEncoding pixelEncoding(Attributes dataset) {
        if (!dataset.contains(Tag.PixelData)) {
            // Float pixel data has already been rounded to signed 16-bit values.
            return new PixelEncoding(true, 16, 1, 0, false, null, null, null);
        }
        boolean signed = dataset.getInt(Tag.PixelRepresentation, 0) == 1;
        int bitsStored = Math.clamp(dataset.getInt(Tag.BitsStored, 16), 1, 16);
        double slope = dataset.getDouble(Tag.RescaleSlope, 1);
        if (slope == 0 || !Double.isFinite(slope)) {
            slope = 1;
        }
        double intercept = dataset.getDouble(Tag.RescaleIntercept, 0);
        boolean hasRescale = dataset.contains(Tag.RescaleIntercept) || dataset.contains(Tag.RescaleSlope);
        var partial = new PixelEncoding(signed, bitsStored, slope, intercept, hasRescale,
                dataset.getString(Tag.RescaleType), null, null);

        // The padding tags are US or SS to match the pixels; interpret their 16 bits the same way as a pixel.
        if (!dataset.contains(Tag.PixelPaddingValue)) {
            return partial;
        }
        int padding = partial.interpret((short) dataset.getInt(Tag.PixelPaddingValue, 0));
        int limit = dataset.contains(Tag.PixelPaddingRangeLimit)
                ? partial.interpret((short) dataset.getInt(Tag.PixelPaddingRangeLimit, 0))
                : padding;
        return new PixelEncoding(signed, bitsStored, slope, intercept, hasRescale, partial.rescaleType(),
                Math.min(padding, limit), Math.max(padding, limit));
    }

    private static short[] readPixels(Attributes dataset, String transferSyntax, int width, int height)
            throws IOException {
        if (dataset.getValue(Tag.PixelData) instanceof Fragments fragments) {
            return readLosslessJpeg(dataset, fragments, transferSyntax, width, height);
        }

        int count = width * height;
        var pixels = new short[count];

        if (dataset.contains(Tag.PixelData)) {
            int bitsAllocated = dataset.getInt(Tag.BitsAllocated, 16);
            if (bitsAllocated != 16) {
                throw new IOException("Unsupported BitsAllocated: " + bitsAllocated);
            }
            byte[] bytes = dataset.getBytes(Tag.PixelData);
            if (bytes.length < count * 2) {
                throw new IOException("Pixel data too short: " + bytes.length + " bytes for " + count + " pixels");
            }
            var order = dataset.bigEndian() ? ByteOrder.BIG_ENDIAN : ByteOrder.LITTLE_ENDIAN;
            ByteBuffer.wrap(bytes).order(order).asShortBuffer().get(pixels);
        } else if (dataset.contains(Tag.FloatPixelData)) {
            float[] values = dataset.getFloats(Tag.FloatPixelData);
            if (values.length < count) {
                throw new IOException("Float pixel data too short");
            }
            for (int i = 0; i < count; i++) {
                pixels[i] = clampToShort(Math.round(values[i]));
            }
        } else if (dataset.contains(Tag.DoubleFloatPixelData)) {
            double[] values = dataset.getDoubles(Tag.DoubleFloatPixelData);
            if (values.length < count) {
                throw new IOException("Double pixel data too short");
            }
            for (int i = 0; i < count; i++) {
                pixels[i] = clampToShort(Math.round(values[i]));
            }
        } else {
            throw new IOException("No pixel data");
        }
        return pixels;
    }

    private static short[] readLosslessJpeg(Attributes dataset, Fragments fragments, String transferSyntax,
            int width, int height) throws IOException {
        if (!UID.JPEGLossless.equals(transferSyntax) && !UID.JPEGLosslessSV1.equals(transferSyntax)) {
            throw new IOException("Unsupported transfer syntax: " + transferSyntax);
        }
        if (dataset.getInt(Tag.NumberOfFrames, 1) > 1) {
            throw new IOException("Multi-frame compressed pixel data is not supported");
        }

        // Fragment 0 is the basic offset table.
        var jpeg = new ByteArrayOutputStream();
        for (int i = 1; i < fragments.size(); i++) {
            if (!(fragments.get(i) instanceof byte[] bytes)) {
                throw new IOException("Pixel data fragment was not loaded");
            }
            jpeg.writeBytes(bytes);
        }
        return JpegLosslessDecoder.decode(jpeg.toByteArray(), width, height);
    }

    private static short clampToShort(long value) {
        return (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, value));
    }
}
