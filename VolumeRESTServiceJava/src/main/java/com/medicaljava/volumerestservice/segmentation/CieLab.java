package com.medicaljava.volumerestservice.segmentation;

/**
 * sRGB colours to and from DICOM's scaled CIELab (RecommendedDisplayCIELabValue): L* 0–100 and a*, b* −128–127,
 * each mapped onto 0–65535, under the D65 white point.
 */
public final class CieLab {

    private static final double XN = 0.95047;
    private static final double YN = 1.0;
    private static final double ZN = 1.08883;

    private CieLab() {}

    public static int[] fromRgb(String hex) {
        double r = linear(Integer.parseInt(hex.substring(1, 3), 16) / 255.0);
        double g = linear(Integer.parseInt(hex.substring(3, 5), 16) / 255.0);
        double b = linear(Integer.parseInt(hex.substring(5, 7), 16) / 255.0);
        double x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
        double y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
        double z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
        double fx = f(x / XN);
        double fy = f(y / YN);
        double fz = f(z / ZN);
        double l = 116 * fy - 16;
        double a = 500 * (fx - fy);
        double bb = 200 * (fy - fz);
        return new int[] {
            scale(l / 100), scale((a + 128) / 255), scale((bb + 128) / 255)
        };
    }

    public static String toRgb(int[] lab) {
        double l = lab[0] / 65535.0 * 100;
        double a = lab[1] / 65535.0 * 255 - 128;
        double b = lab[2] / 65535.0 * 255 - 128;
        double fy = (l + 16) / 116;
        double fx = fy + a / 500;
        double fz = fy - b / 200;
        double x = XN * inverseF(fx);
        double y = YN * inverseF(fy);
        double z = ZN * inverseF(fz);
        double r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
        double g = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
        double bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
        return String.format("#%02x%02x%02x", channel(r), channel(g), channel(bl));
    }

    private static double linear(double c) {
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    private static int channel(double linear) {
        double c = Math.clamp(linear, 0, 1);
        double srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
        return (int) Math.round(Math.clamp(srgb, 0, 1) * 255);
    }

    private static double f(double t) {
        return t > 216.0 / 24389 ? Math.cbrt(t) : (24389.0 / 27 * t + 16) / 116;
    }

    private static double inverseF(double t) {
        return t * t * t > 216.0 / 24389 ? t * t * t : (116 * t - 16) / (24389.0 / 27);
    }

    private static int scale(double fraction) {
        return (int) Math.round(Math.clamp(fraction, 0, 1) * 65535);
    }
}
