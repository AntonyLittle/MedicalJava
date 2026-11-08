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
const int MODE_LABELS = 5;

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

// The volume keeps its acquisition orientation: patient points map to voxel coordinates (fractional grid indices)
// through an affine transform. Rays are parametrised by patient distance t (mm) and marched in voxel coordinates.
uniform sampler3D uVolume;
uniform mat4 uPatientToVoxel;
uniform vec3 uDims;
uniform vec3 uVoxelBoxMin;
uniform vec3 uVoxelBoxMax;

// Clipping in patient space: the clip box, then the cut plane's half-space dot(n, p) <= w.
uniform vec3 uClipMin;
uniform vec3 uClipMax;
uniform bool uCutEnabled;
uniform vec4 uCutPlane;

uniform float uStepMm;
uniform int uMaxSteps;

// Empty-space skipping: one 0/1 texel per brick of voxels.
uniform bool uSkipEmpty;
uniform usampler3D uOccupancy;
uniform float uBrickSize;
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

// Segmentation labels on the volume's grid (nearest voxel), and RGBA per label (alpha 0 = hidden). Labels mode draws
// the surfaces of visible segments with uLabelOpacity; uLabelTint colours VR samples inside visible segments.
uniform highp usampler3D uLabels;
uniform sampler2D uLabelColors;
uniform bool uLabelTint;
uniform float uLabelOpacity;

float sampleAt(vec3 v) {
  return texture(uVolume, (v + 0.5) / uDims).r;
}

// Patient-space gradient (value per mm) from central differences along the voxel axes.
vec3 gradientAt(vec3 v) {
  vec3 perVoxel = 0.5 * vec3(
    sampleAt(v + vec3(1.0, 0.0, 0.0)) - sampleAt(v - vec3(1.0, 0.0, 0.0)),
    sampleAt(v + vec3(0.0, 1.0, 0.0)) - sampleAt(v - vec3(0.0, 1.0, 0.0)),
    sampleAt(v + vec3(0.0, 0.0, 1.0)) - sampleAt(v - vec3(0.0, 0.0, 1.0))
  );
  return transpose(mat3(uPatientToVoxel)) * perVoxel;
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

ivec3 brickAt(vec3 v) {
  return clamp(ivec3(floor(v / uBrickSize)), ivec3(0), uBrickDims - 1);
}

// Next sample position on the step grid past the exit of the brick containing the voxel point.
float skipBrick(vec3 voxelOrigin, vec3 voxelDir, float t, ivec3 brick) {
  vec3 lo = vec3(brick) * uBrickSize;
  float exitT = intersectBox(voxelOrigin, voxelDir, lo, lo + uBrickSize).y;
  return t + max(1.0, ceil((exitT - t) / uStepMm)) * uStepMm;
}

bool brickEmpty(vec3 v) {
  return texelFetch(uOccupancy, brickAt(v), 0).r == 0u;
}

uint labelAt(vec3 v) {
  ivec3 p = ivec3(floor(v + 0.5));
  if (any(lessThan(p, ivec3(0))) || any(greaterThanEqual(p, ivec3(uDims)))) return 0u;
  return texelFetch(uLabels, p, 0).r;
}

vec4 labelColor(uint label) {
  return texelFetch(uLabelColors, ivec2(int(label), 0), 0);
}

float isLabel(ivec3 p, uint label) {
  if (any(lessThan(p, ivec3(0))) || any(greaterThanEqual(p, ivec3(uDims)))) return 0.0;
  return texelFetch(uLabels, p, 0).r == label ? 1.0 : 0.0;
}

// The segment's indicator (1 inside, 0 outside) interpolated trilinearly: its 0.5 level is a smooth surface.
float labelIndicator(vec3 v, uint label) {
  vec3 base = floor(v);
  vec3 f = v - base;
  ivec3 p = ivec3(base);
  float x00 = mix(isLabel(p, label), isLabel(p + ivec3(1, 0, 0), label), f.x);
  float x10 = mix(isLabel(p + ivec3(0, 1, 0), label), isLabel(p + ivec3(1, 1, 0), label), f.x);
  float x01 = mix(isLabel(p + ivec3(0, 0, 1), label), isLabel(p + ivec3(1, 0, 1), label), f.x);
  float x11 = mix(isLabel(p + ivec3(0, 1, 1), label), isLabel(p + ivec3(1, 1, 1), label), f.x);
  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}

vec3 labelDifference(vec3 v, uint label, float h) {
  return vec3(
    labelIndicator(v + vec3(h, 0.0, 0.0), label) - labelIndicator(v - vec3(h, 0.0, 0.0), label),
    labelIndicator(v + vec3(0.0, h, 0.0), label) - labelIndicator(v - vec3(0.0, h, 0.0), label),
    labelIndicator(v + vec3(0.0, 0.0, h), label) - labelIndicator(v - vec3(0.0, 0.0, h), label)
  ) / (2.0 * h);
}

// Central differences over one and two voxels together, which smooths the stair steps of voxel labels.
vec3 labelGradient(vec3 v, uint label) {
  vec3 perVoxel = 0.5 * (labelDifference(v, label, 1.0) + labelDifference(v, label, 2.0));
  // Scaled up so shade() treats it as a real surface rather than a flat region.
  return transpose(mat3(uPatientToVoxel)) * perVoxel * 100.0;
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
  vec3 voxelOrigin = (uPatientToVoxel * vec4(origin, 1.0)).xyz;
  vec3 voxelDir = mat3(uPatientToVoxel) * dir;

  vec2 range = intersectBox(voxelOrigin, voxelDir, uVoxelBoxMin, uVoxelBoxMax);
  vec2 clip = intersectBox(origin, dir, uClipMin, uClipMax);
  range = vec2(max(range.x, clip.x), min(range.y, clip.y));
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
      vec3 v = voxelOrigin + voxelDir * t;
      if (uSkipEmpty && brickEmpty(v)) {
        t = skipBrick(voxelOrigin, voxelDir, t, brickAt(v));
        continue;
      }
      float value = sampleAt(v);
      vec4 sampleColor = texture(uTransfer, vec2(value * uLutScale + uLutOffset, 0.5));
      if (sampleColor.a > 0.0) {
        float alphaPerMm = min(0.999, sampleColor.a * uOpacityScale);
        float alpha = 1.0 - pow(1.0 - alphaPerMm, uStepMm);
        vec3 color = sampleColor.rgb;
        if (uLabelTint) {
          uint label = labelAt(v);
          vec4 tint = labelColor(label);
          if (label != 0u && tint.a > 0.0) color = mix(color, tint.rgb, 0.7);
        }
        if (uShading > 0.0) {
          vec3 gradient = gradientAt(v);
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
  } else if (uMode == MODE_LABELS) {
    // Each entry into a visible segment is a surface; transparent surfaces let the ones behind show through.
    vec4 accumulated = vec4(0.0);
    uint current = labelAt(voxelOrigin + voxelDir * t);
    float previousT = t;
    if (current != 0u && labelColor(current).a > 0.0) {
      // The ray starts inside a segment (at a clip plane): show the cut face, flat.
      accumulated = vec4(labelColor(current).rgb * 0.8 * uLabelOpacity, uLabelOpacity);
    }
    for (int i = 0; i < uMaxSteps; i++) {
      if (t > range.y || accumulated.a > 0.98) break;
      vec3 v = voxelOrigin + voxelDir * t;
      uint label = labelAt(v);
      if (label != current) {
        current = label;
        vec4 color = labelColor(label);
        if (label != 0u && color.a > 0.0) {
          float lo = previousT;
          float hi = t;
          for (int j = 0; j < 6; j++) {
            float mid = 0.5 * (lo + hi);
            if (labelIndicator(voxelOrigin + voxelDir * mid, label) >= 0.5) hi = mid;
            else lo = mid;
          }
          vec3 hit = voxelOrigin + voxelDir * hi;
          vec3 shaded = shade(color.rgb, labelGradient(hit, label), viewDir, 0.25, 0.25);
          accumulated.rgb += (1.0 - accumulated.a) * uLabelOpacity * shaded;
          accumulated.a += (1.0 - accumulated.a) * uLabelOpacity;
        }
      }
      previousT = t;
      t += uStepMm;
    }
    outColor = vec4(accumulated.rgb, 1.0);
  } else if (uMode == MODE_ISO) {
    float previousT = t - uStepMm;
    bool first = true;
    for (int i = 0; i < uMaxSteps; i++) {
      if (t > range.y) break;
      vec3 v = voxelOrigin + voxelDir * t;
      if (uSkipEmpty && brickEmpty(v)) {
        t = skipBrick(voxelOrigin, voxelDir, t, brickAt(v));
        previousT = t - uStepMm;
        first = false;
        continue;
      }
      if (sampleAt(v) >= uIsoValue) {
        float hitT = t;
        if (!first) {
          // Refine between the last sample below the threshold and this one.
          float lo = previousT;
          float hi = t;
          for (int j = 0; j < 6; j++) {
            float mid = 0.5 * (lo + hi);
            if (sampleAt(voxelOrigin + voxelDir * mid) >= uIsoValue) hi = mid;
            else lo = mid;
          }
          hitT = hi;
        }
        vec3 hit = voxelOrigin + voxelDir * hitT;
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
      vec3 v = voxelOrigin + voxelDir * t;
      if (uSkipEmpty && brickEmpty(v)) {
        t = skipBrick(voxelOrigin, voxelDir, t, brickAt(v));
        skipped = true;
        continue;
      }
      float value = sampleAt(v);
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
