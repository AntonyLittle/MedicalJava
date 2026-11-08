package com.medicaljava.volumerestservice.store;

import com.medicaljava.volumerestservice.model.Slice;
import com.medicaljava.volumerestservice.repository.DicomSeriesReader.DecodedSlice;
import com.medicaljava.volumerestservice.repository.DicomSeriesReader.ImagePlane;
import com.medicaljava.volumerestservice.repository.DicomSeriesReader.PixelEncoding;
import com.medicaljava.volumerestservice.repository.DicomSeriesReader.SeriesInfo;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

class SeriesDecodingTest {

    private static final SeriesInfo INFO = new SeriesInfo("P", "1", "1.2.3", "S", "1", "CT");
    private static final PixelEncoding RAW = new PixelEncoding(true, 16, 1, 0, false, null, null, null);
    private static final double[] X = {1, 0, 0};
    private static final double[] Y = {0, 1, 0};
    private static final double[] MINUS_Z = {0, 0, -1};

    // ---- values ----

    @Test
    void integerRescaleIsAppliedAndPaddingBecomesTheLowestValue() {
        var ct = new PixelEncoding(true, 16, 1, -1024, true, null, -2000, -2000);
        var slice = slice(0, ct, new short[] {-2000, 0, 1024, 3000});

        var mapping = PixelValues.encode(List.of(slice), "CT");

        assertThat(slice.slice().radiodensities()).containsExactly(-1024, -1024, 0, 1976);
        assertThat(mapping.slope()).isEqualTo(1);
        assertThat(mapping.intercept()).isEqualTo(0);
        assertThat(mapping.units()).isEqualTo("HU");
        assertThat(mapping.minValue()).isEqualTo(-1024);
        assertThat(mapping.maxValue()).isEqualTo(1976);
    }

    @Test
    void unsignedPixelsAreMaskedToBitsStored() {
        var unsigned12 = new PixelEncoding(false, 12, 1, -1024, true, null, null, null);
        // 0xF000 bits above BitsStored are ignored; 4095 is the largest 12-bit value.
        var slice = slice(0, unsigned12, new short[] {0, (short) 0xF000, 4095});

        PixelValues.encode(List.of(slice), "CT");

        assertThat(slice.slice().radiodensities()).containsExactly(-1024, -1024, 3071);
    }

    @Test
    void signedPixelsAreSignExtendedFromBitsStored() {
        var signed12 = new PixelEncoding(true, 12, 1, 0, false, null, null, null);
        var slice = slice(0, signed12, new short[] {0x0FFF, 0x0800, 0x07FF});

        var mapping = PixelValues.encode(List.of(slice), "MR");

        assertThat(slice.slice().radiodensities()).containsExactly(-1, -2048, 2047);
        assertThat(mapping.units()).isEmpty();
    }

    @Test
    void sharedFractionalRescaleIsKeptAsTheVolumeMapping() {
        var pet = new PixelEncoding(true, 16, 0.5, 10, true, "BQML", null, null);
        var slice = slice(0, pet, new short[] {0, 100, 32767});

        var mapping = PixelValues.encode(List.of(slice), "PT");

        assertThat(slice.slice().radiodensities()).containsExactly(0, 100, 32767);
        assertThat(mapping.slope()).isEqualTo(0.5);
        assertThat(mapping.intercept()).isEqualTo(10);
        assertThat(mapping.units()).isEqualTo("BQML");
    }

    @Test
    void differingFractionalRescalesAreRequantisedToOneMapping() {
        var a = slice(0, new PixelEncoding(true, 16, 0.25, 0, true, null, null, null), new short[] {0, 400});
        var b = slice(1, new PixelEncoding(true, 16, 2.5, 0, true, null, null, null), new short[] {0, 1000});

        var mapping = PixelValues.encode(List.of(a, b), "PT");

        double[] expected = {0, 100, 0, 2500};
        var stored = new short[] {a.slice().radiodensities()[0], a.slice().radiodensities()[1],
                b.slice().radiodensities()[0], b.slice().radiodensities()[1]};
        for (int i = 0; i < expected.length; i++) {
            assertThat(stored[i] * mapping.slope() + mapping.intercept()).isCloseTo(expected[i], within(mapping.slope()));
        }
        assertThat(mapping.minValue()).isCloseTo(0, within(mapping.slope()));
        assertThat(mapping.maxValue()).isCloseTo(2500, within(mapping.slope()));
    }

    // ---- geometry ----

    @Test
    void stackIsSortedAlongItsNormalNotByZ() {
        // Sagittal: rows along +y, columns along -z, so the normal is -x; the file order runs the other way.
        var slices = new ArrayList<DecodedSlice>();
        for (int i = 0; i < 4; i++) {
            slices.add(slice(i, Y, MINUS_Z, new double[] {10.0 * i, 0, 0}));
        }

        var parts = SeriesGeometry.split(slices);

        assertThat(parts).hasSize(1);
        var part = parts.getFirst();
        assertThat(part.key()).isEmpty();
        assertThat(part.label()).isEqualTo("sagittal");
        assertThat(part.normal()).containsExactly(new double[] {-1, 0, 0}, within(1e-12));
        assertThat(part.slices()).extracting(s -> s.slice().index()).containsExactly(3, 2, 1, 0);
    }

    @Test
    void mixedOrientationsAreSplitAndSmallStacksDropped() {
        var slices = new ArrayList<DecodedSlice>();
        for (int i = 0; i < 3; i++) {
            slices.add(slice(slices.size(), X, Y, new double[] {0, 0, i}));
        }
        for (int i = 0; i < 4; i++) {
            slices.add(slice(slices.size(), X, MINUS_Z, new double[] {0, i, 0}));
        }
        slices.add(slice(slices.size(), Y, MINUS_Z, new double[] {0, 0, 0}));

        var parts = SeriesGeometry.split(slices);

        assertThat(parts).extracting(SeriesGeometry.Part::key).containsExactly("axial", "coronal");
        assertThat(parts.get(1).slices()).hasSize(4);
    }

    @Test
    void mixedOrientationsWithoutAStackAreRejected() {
        var slices = List.of(slice(0, X, Y, new double[] {0, 0, 0}), slice(1, X, MINUS_Z, new double[] {0, 0, 0}));

        assertThatThrownBy(() -> SeriesGeometry.split(slices)).isInstanceOf(InvalidDicomException.class);
    }

    @Test
    void constantShearIsAcceptedButAnIrregularStackIsRejected() {
        var sheared = new ArrayList<DecodedSlice>();
        for (int i = 0; i < 4; i++) {
            sheared.add(slice(i, X, Y, new double[] {0, 0.5 * i, 2.0 * i}));
        }
        assertThat(SeriesGeometry.split(sheared)).hasSize(1);

        var irregular = new ArrayList<>(sheared);
        irregular.set(2, slice(2, X, Y, new double[] {3, 1, 4}));
        assertThatThrownBy(() -> SeriesGeometry.split(irregular)).isInstanceOf(InvalidDicomException.class);
    }

    @Test
    void obliqueStacksAreLabelledOblique() {
        double c = Math.cos(Math.toRadians(30));
        double s = Math.sin(Math.toRadians(30));
        var normal = new double[] {0, -s, c};
        var slices = new ArrayList<DecodedSlice>();
        for (int i = 0; i < 3; i++) {
            slices.add(slice(i, X, new double[] {0, c, s}, new double[] {0, normal[1] * i, normal[2] * i}));
        }

        assertThat(SeriesGeometry.split(slices).getFirst().label()).isEqualTo("oblique");
    }

    // ---- helpers ----

    private static DecodedSlice slice(int index, PixelEncoding encoding, short[] pixels) {
        return new DecodedSlice(INFO, slice(index, pixels.length, 1, pixels), new ImagePlane(X, Y, new double[3]),
                encoding);
    }

    private static DecodedSlice slice(int index, double[] row, double[] column, double[] position) {
        return new DecodedSlice(INFO, slice(index, 2, 2, new short[4]), new ImagePlane(row, column, position), RAW);
    }

    private static Slice slice(int index, int width, int height, short[] pixels) {
        return new Slice(index, 0, 0, index, width, height, width, height, 0, 0, 0, 1, 1, 0, 0, 0, pixels);
    }
}
