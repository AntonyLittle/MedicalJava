#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
precision highp usampler3D;

// Keep in sync with RenderMode in VolumeRenderer.ts.
const int MODE_DVR = 0;
const int MODE_MIP = 1;
const int MODE_MINIP = 2;
const int MODE_AVERAGE = 3;
const int MODE_ISO = 4;

in vec2 vNdc;
out vec4 outColor;

uniform int uMode;

// Camera (patient space, mm); see camera.ts.
uniform vec3 uCamTarget;
uniform vec3 uCamRight;
uniform vec3 uCamDown;
uniform vec3 uCamForward;
uniform vec2 uHalfSizeMm;
uniform float uPerspectiveDistanceMm;

// Volume: texture coordinate = p * uTexScale + uTexOffset.
uniform sampler3D uVolume;
uniform vec3 uTexScale;
uniform vec3 uTexOffset;
uniform vec3 uSpacingMm;

// Region to march: volume box ∩ clip box, then the cut plane's half-space dot(n, p) <= w.
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform bool uCutEnabled;
uniform vec4 uCutPlane;

uniform float uStepMm;
uniform int uMaxSteps;

// Empty-space skipping: one 0/1 texel per brick of voxels.
uniform bool uSkipEmpty;
uniform usampler3D uOccupancy;
uniform vec3 uGridOrigin;
uniform vec3 uBrickSizeMm;
uniform ivec3 uBrickDims;

// DVR: LUT lookup x = value * uLutScale + uLutOffset; LUT alpha is opacity per mm.
uniform sampler2D uTransfer;
uniform float uLutScale;
uniform float uLutOffset;
uniform float uOpacityScale;
uniform float uShading;

// MIP / MinIP / average greyscale window.
uniform float uWindowLow;
uniform float uWindowHigh;

uniform float uIsoValue;
uniform vec3 uIsoColor;

float sampleAt(vec3 p) {
  return texture(uVolume, p * uTexScale + uTexOffset).r;
}

vec3 gradientAt(vec3 p) {
  vec3 dx = vec3(uSpacingMm.x, 0.0, 0.0);
  vec3 dy = vec3(0.0, uSpacingMm.y, 0.0);
  vec3 dz = vec3(0.0, 0.0, uSpacingMm.z);
  return vec3(
    sampleAt(p + dx) - sampleAt(p - dx),
    sampleAt(p + dy) - sampleAt(p - dy),
    sampleAt(p + dz) - sampleAt(p - dz)
  ) / (2.0 * uSpacingMm);
}

// Headlight Blinn-Phong; two-sided because gradients point into denser material.
vec3 shade(vec3 color, vec3 gradient, vec3 viewDir, float ambient, float specular) {
  float magnitude = length(gradient);
  if (magnitude < 1e-3) return color * (ambient + (1.0 - ambient) * 0.6);
  float facing = abs(dot(gradient / magnitude, viewDir));
  return color * (ambient + (1.0 - ambient) * facing) + vec3(specular * pow(facing, 40.0));
}

// Ray parameters inside the axis-aligned box: (near, far); near > far when it misses.
vec2 intersectBox(vec3 origin, vec3 dir, vec3 boxMin, vec3 boxMax) {
  vec3 safeDir = mix(dir, vec3(1e-9), lessThan(abs(dir), vec3(1e-9)));
  vec3 inverse = 1.0 / safeDir;
  vec3 t0 = (boxMin - origin) * inverse;
  vec3 t1 = (boxMax - origin) * inverse;
  vec3 tMin = min(t0, t1);
  vec3 tMax = max(t0, t1);
  return vec2(max(max(tMin.x, tMin.y), tMin.z), min(min(tMax.x, tMax.y), tMax.z));
}

ivec3 brickAt(vec3 p) {
  return clamp(ivec3(floor((p - uGridOrigin) / uBrickSizeMm)), ivec3(0), uBrickDims - 1);
}

// Next sample position on the step grid past the exit of the brick containing p.
float skipBrick(vec3 origin, vec3 dir, float t, ivec3 brick) {
  vec3 lo = uGridOrigin + vec3(brick) * uBrickSizeMm;
  vec3 hi = lo + uBrickSizeMm;
  float exitT = intersectBox(origin, dir, lo, hi).y;
  return t + max(1.0, ceil((exitT - t) / uStepMm)) * uStepMm;
}

bool brickEmpty(vec3 p) {
  return texelFetch(uOccupancy, brickAt(p), 0).r == 0u;
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec3 offset = uCamRight * vNdc.x * uHalfSizeMm.x + uCamDown * vNdc.y * uHalfSizeMm.y;
  vec3 origin;
  vec3 dir;
  bool perspective = uPerspectiveDistanceMm > 0.0;
  if (perspective) {
    origin = uCamTarget - uCamForward * uPerspectiveDistanceMm;
    dir = normalize(uCamForward * uPerspectiveDistanceMm + offset);
  } else {
    origin = uCamTarget + offset;
    dir = uCamForward;
  }

  vec2 range = intersectBox(origin, dir, uBoxMin, uBoxMax);
  if (perspective) range.x = max(range.x, 0.0);
  if (uCutEnabled) {
    float denominator = dot(uCutPlane.xyz, dir);
    float distance = uCutPlane.w - dot(uCutPlane.xyz, origin);
    if (abs(denominator) < 1e-9) {
      if (distance < 0.0) range = vec2(1.0, 0.0);
    } else if (denominator > 0.0) {
      range.y = min(range.y, distance / denominator);
    } else {
      range.x = max(range.x, distance / denominator);
    }
  }

  outColor = vec4(0.0, 0.0, 0.0, 1.0);
  if (range.x >= range.y) return;

  // Jittered start hides the wood-grain pattern of a regular step.
  float t = range.x + hash(gl_FragCoord.xy) * uStepMm;
  vec3 viewDir = -dir;

  if (uMode == MODE_DVR) {
    vec4 accumulated = vec4(0.0);
    for (int i = 0; i < uMaxSteps; i++) {
      if (t > range.y) break;
      vec3 p = origin + dir * t;
      if (uSkipEmpty && brickEmpty(p)) {
        t = skipBrick(origin, dir, t, brickAt(p));
        continue;
      }
      float value = sampleAt(p);
      vec4 sampleColor = texture(uTransfer, vec2(value * uLutScale + uLutOffset, 0.5));
      if (sampleColor.a > 0.0) {
        float alphaPerMm = min(0.999, sampleColor.a * uOpacityScale);
        float alpha = 1.0 - pow(1.0 - alphaPerMm, uStepMm);
        vec3 color = sampleColor.rgb;
        if (uShading > 0.0) {
          vec3 gradient = gradientAt(p);
          float edge = smoothstep(5.0, 60.0, length(gradient));
          color = mix(color, shade(color, gradient, viewDir, 0.3, 0.25), uShading * edge);
        }
        accumulated.rgb += (1.0 - accumulated.a) * alpha * color;
        accumulated.a += (1.0 - accumulated.a) * alpha;
        if (accumulated.a > 0.98) break;
      }
      t += uStepMm;
    }
    outColor = vec4(accumulated.rgb, 1.0);
  } else if (uMode == MODE_ISO) {
    float previousT = t - uStepMm;
    bool first = true;
    for (int i = 0; i < uMaxSteps; i++) {
      if (t > range.y) break;
      vec3 p = origin + dir * t;
      if (uSkipEmpty && brickEmpty(p)) {
        t = skipBrick(origin, dir, t, brickAt(p));
        previousT = t - uStepMm;
        first = false;
        continue;
      }
      if (sampleAt(p) >= uIsoValue) {
        float hitT = t;
        if (!first) {
          // Refine between the last sample below the threshold and this one.
          float lo = previousT;
          float hi = t;
          for (int j = 0; j < 6; j++) {
            float mid = 0.5 * (lo + hi);
            if (sampleAt(origin + dir * mid) >= uIsoValue) hi = mid;
            else lo = mid;
          }
          hitT = hi;
        }
        vec3 hit = origin + dir * hitT;
        outColor = vec4(shade(uIsoColor, gradientAt(hit), viewDir, 0.2, 0.3), 1.0);
        return;
      }
      first = false;
      previousT = t;
      t += uStepMm;
    }
  } else {
    float extreme = uMode == MODE_MINIP ? 1e9 : -1e9;
    float sum = 0.0;
    float count = 0.0;
    bool skipped = false;
    for (int i = 0; i < uMaxSteps; i++) {
      if (t > range.y) break;
      vec3 p = origin + dir * t;
      if (uSkipEmpty && brickEmpty(p)) {
        t = skipBrick(origin, dir, t, brickAt(p));
        skipped = true;
        continue;
      }
      float value = sampleAt(p);
      extreme = uMode == MODE_MINIP ? min(extreme, value) : max(extreme, value);
      sum += value;
      count += 1.0;
      t += uStepMm;
    }
    if (count == 0.0) {
      // Skipped bricks lie entirely outside the window: below it for MIP, above it for MinIP.
      if (skipped && uMode == MODE_MINIP) outColor = vec4(1.0);
      return;
    }
    float value = uMode == MODE_AVERAGE ? sum / count : extreme;
    float grey = clamp((value - uWindowLow) / (uWindowHigh - uWindowLow), 0.0, 1.0);
    outColor = vec4(vec3(grey), 1.0);
  }
}
