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
            String modality) {}

    /** The slice's volumeId and patientId are 0; they are assigned when the volume is stored. */
    public record DecodedSlice(SeriesInfo info, Slice slice) {}

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

            var slice = new Slice(sliceIndex, 0, 0, sliceIndex, width, height,
                    pixelSpacingX * width, pixelSpacingY * height, imagePosition[2],
                    imagePosition[0], imagePosition[1], pixelSpacingX, pixelSpacingY, radiodensities);

            var info = new SeriesInfo(
                    dataset.getString(Tag.PatientName),
                    dataset.getString(Tag.PatientID),
                    dataset.getString(Tag.SeriesInstanceUID),
                    dataset.getString(Tag.SeriesDescription),
                    dataset.getString(Tag.SeriesNumber),
                    dataset.getString(Tag.Modality));
            return new DecodedSlice(info, slice);
        }
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
