package com.medicaljava.volumerestservice.repository;

import java.io.IOException;

/**
 * Decoder for single-component lossless JPEG (ITU-T T.81 process 14, SOF3), as used by
 * DICOM transfer syntaxes 1.2.840.10008.1.2.4.57 and .70. Java ImageIO has no reader for it.
 */
final class JpegLosslessDecoder {

    private static final int SOI = 0xD8;
    private static final int EOI = 0xD9;
    private static final int SOF3 = 0xC3;
    private static final int DHT = 0xC4;
    private static final int DRI = 0xDD;
    private static final int SOS = 0xDA;

    private static final class HuffmanTable {
        final int[] minCode = new int[17];
        final int[] maxCode = new int[18];
        final int[] valPtr = new int[17];
        int[] values = new int[0];
    }

    private final byte[] data;
    private int pos;

    private final HuffmanTable[] tables = new HuffmanTable[4];
    private int precision;
    private int width;
    private int height;
    private int restartInterval;

    private int bitBuffer;
    private int bitCount;

    private JpegLosslessDecoder(byte[] data) {
        this.data = data;
    }

    /** Returns the samples as raw 16-bit patterns, row-major. */
    static short[] decode(byte[] jpeg, int expectedWidth, int expectedHeight) throws IOException {
        JpegLosslessDecoder decoder = new JpegLosslessDecoder(jpeg);
        return decoder.run(expectedWidth, expectedHeight);
    }

    private short[] run(int expectedWidth, int expectedHeight) throws IOException {
        if (data.length < 4 || u8(0) != 0xFF || u8(1) != SOI) {
            throw new IOException("Not a JPEG stream");
        }
        pos = 2;

        while (pos + 4 <= data.length) {
            if (u8(pos) != 0xFF) {
                throw new IOException("Expected JPEG marker at offset " + pos);
            }
            int marker = u8(pos + 1);
            if (marker == 0xFF) {
                pos++;
                continue;
            }
            if (marker == EOI) {
                break;
            }
            int length = (u8(pos + 2) << 8) | u8(pos + 3);
            int segment = pos + 4;
            pos += 2 + length;

            switch (marker) {
                case SOF3 -> readFrameHeader(segment, expectedWidth, expectedHeight);
                case DHT -> readHuffmanTables(segment, pos);
                case DRI -> restartInterval = (u8(segment) << 8) | u8(segment + 1);
                case SOS -> {
                    return decodeScan(segment);
                }
                default -> {
                    if (marker >= 0xC0 && marker <= 0xCF) {
                        throw new IOException("Unsupported JPEG process: SOF" + (marker - 0xC0));
                    }
                }
            }
        }
        throw new IOException("No scan found in JPEG stream");
    }

    private void readFrameHeader(int p, int expectedWidth, int expectedHeight) throws IOException {
        precision = u8(p);
        height = (u8(p + 1) << 8) | u8(p + 2);
        width = (u8(p + 3) << 8) | u8(p + 4);
        int components = u8(p + 5);
        if (components != 1) {
            throw new IOException("Unsupported component count: " + components);
        }
        if (precision < 2 || precision > 16) {
            throw new IOException("Unsupported precision: " + precision);
        }
        if (width != expectedWidth || height != expectedHeight) {
            throw new IOException("JPEG size " + width + "x" + height
                    + " does not match DICOM " + expectedWidth + "x" + expectedHeight);
        }
    }

    private void readHuffmanTables(int p, int end) throws IOException {
        while (p < end) {
            int tcTh = u8(p++);
            int tableClass = tcTh >> 4;
            int id = tcTh & 0x0F;
            if (id > 3) {
                throw new IOException("Invalid Huffman table id: " + id);
            }
            int[] counts = new int[17];
            int total = 0;
            for (int len = 1; len <= 16; len++) {
                counts[len] = u8(p++);
                total += counts[len];
            }
            HuffmanTable table = new HuffmanTable();
            table.values = new int[total];
            for (int i = 0; i < total; i++) {
                table.values[i] = u8(p++);
            }

            int code = 0;
            int index = 0;
            for (int len = 1; len <= 16; len++) {
                table.valPtr[len] = index;
                table.minCode[len] = code;
                code += counts[len];
                index += counts[len];
                table.maxCode[len] = counts[len] == 0 ? -1 : code - 1;
                code <<= 1;
            }
            if (tableClass == 0) {
                tables[id] = table;
            }
        }
    }

    private short[] decodeScan(int p) throws IOException {
        int scanComponents = u8(p);
        if (scanComponents != 1) {
            throw new IOException("Unsupported scan component count: " + scanComponents);
        }
        int tableId = u8(p + 2) >> 4;
        int predictor = u8(p + 1 + scanComponents * 2);
        int pointTransform = u8(p + 3 + scanComponents * 2) & 0x0F;
        if (predictor < 1 || predictor > 7) {
            throw new IOException("Invalid lossless predictor: " + predictor);
        }
        HuffmanTable table = tables[tableId & 3];
        if (table == null) {
            throw new IOException("Missing Huffman table " + tableId);
        }
        if (width == 0 || height == 0) {
            throw new IOException("Scan before frame header");
        }

        // Entropy-coded data starts right after the SOS header, which run() already skipped past.
        bitBuffer = 0;
        bitCount = 0;

        int total = width * height;
        int[] samples = new int[total];
        int defaultPrediction = 1 << (precision - pointTransform - 1);
        int intervalStart = 0;

        for (int i = 0; i < total; i++) {
            if (restartInterval > 0 && i > 0 && i % restartInterval == 0) {
                skipToRestart();
                intervalStart = i;
            }

            int col = i % width;
            int prediction;
            if (i - intervalStart < width) {
                prediction = i == intervalStart ? defaultPrediction : samples[i - 1];
            } else if (col == 0) {
                prediction = samples[i - width];
            } else {
                int ra = samples[i - 1];
                int rb = samples[i - width];
                int rc = samples[i - width - 1];
                prediction = switch (predictor) {
                    case 1 -> ra;
                    case 2 -> rb;
                    case 3 -> rc;
                    case 4 -> ra + rb - rc;
                    case 5 -> ra + ((rb - rc) >> 1);
                    case 6 -> rb + ((ra - rc) >> 1);
                    default -> (ra + rb) >> 1;
                };
            }

            samples[i] = (prediction + decodeDifference(table)) & 0xFFFF;
        }

        short[] result = new short[total];
        for (int i = 0; i < total; i++) {
            result[i] = (short) (samples[i] << pointTransform);
        }
        return result;
    }

    private int decodeDifference(HuffmanTable table) throws IOException {
        int category = decodeHuffman(table);
        if (category == 0) {
            return 0;
        }
        if (category == 16) {
            return 32768;
        }
        int bits = readBits(category);
        return bits < (1 << (category - 1)) ? bits - (1 << category) + 1 : bits;
    }

    private int decodeHuffman(HuffmanTable table) throws IOException {
        int code = 0;
        for (int len = 1; len <= 16; len++) {
            code = (code << 1) | readBit();
            if (code <= table.maxCode[len]) {
                int index = table.valPtr[len] + code - table.minCode[len];
                if (index >= table.values.length) {
                    break;
                }
                return table.values[index];
            }
        }
        throw new IOException("Invalid Huffman code at offset " + pos);
    }

    private int readBits(int count) throws IOException {
        int value = 0;
        for (int i = 0; i < count; i++) {
            value = (value << 1) | readBit();
        }
        return value;
    }

    private int readBit() throws IOException {
        if (bitCount == 0) {
            if (pos >= data.length) {
                throw new IOException("Unexpected end of JPEG data");
            }
            int b = u8(pos++);
            if (b == 0xFF) {
                int next = pos < data.length ? u8(pos) : 0;
                if (next == 0) {
                    pos++;
                } else {
                    // Marker inside entropy data: leave it in place and feed zeros.
                    pos--;
                    b = 0;
                }
            }
            bitBuffer = b;
            bitCount = 8;
        }
        bitCount--;
        return (bitBuffer >> bitCount) & 1;
    }

    private void skipToRestart() throws IOException {
        bitCount = 0;
        while (pos + 1 < data.length) {
            if (u8(pos) == 0xFF && (u8(pos + 1) & 0xF8) == 0xD0) {
                pos += 2;
                return;
            }
            pos++;
        }
        throw new IOException("Missing restart marker");
    }

    private int u8(int index) {
        return data[index] & 0xFF;
    }
}
