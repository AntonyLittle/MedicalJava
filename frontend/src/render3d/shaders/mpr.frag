#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;

// Keep in sync with MODE_INDEX in MprRenderer.ts.
const int MODE_AVERAGE = 0;
const int MODE_MAX = 1;
const int MODE_MIN = 2;

out vec4 outColor;

uniform sampler3D uVolume;
uniform vec3 uDims;
uniform vec3 uVoxelBoxMin;
uniform vec3 uVoxelBoxMax;

// In voxel coordinates: sample k of image pixel (column, row) is at uOrigin + column·uColumnStep + row·uRowStep +
// k·uSampleStep. Row 0 is the top of the image, which sits at the top of the drawing buffer.
uniform vec3 uOrigin;
uniform vec3 uColumnStep;
uniform vec3 uRowStep;
uniform vec3 uSampleStep;
uniform int uSampleCount;
uniform int uMode;
uniform float uDrawingBufferHeight;

// Pixels without any sample inside the volume show this value.
uniform float uOutsideValue;
uniform float uWindowLow;
uniform float uWindowHigh;

// Voxel centres within this distance outside the box still count as inside, as in the CPU sampler.
const float EDGE_TOLERANCE = 1e-3;

float sampleAt(vec3 v) {
  return texture(uVolume, (v + 0.5) / uDims).r;
}

bool inside(vec3 v) {
  return all(greaterThanEqual(v, uVoxelBoxMin - EDGE_TOLERANCE)) && all(lessThanEqual(v, uVoxelBoxMax + EDGE_TOLERANCE));
}

// Range of k for which origin + k·dir lies inside the box: (first, last); first > last when it misses.
vec2 sampleRange(vec3 origin, vec3 dir) {
  vec3 boxMin = uVoxelBoxMin - EDGE_TOLERANCE;
  vec3 boxMax = uVoxelBoxMax + EDGE_TOLERANCE;
  float first = 0.0;
  float last = float(uSampleCount - 1);
  for (int axis = 0; axis < 3; axis++) {
    float o = origin[axis];
    float d = dir[axis];
    if (abs(d) < 1e-9) {
      if (o < boxMin[axis] || o > boxMax[axis]) return vec2(1.0, 0.0);
      continue;
    }
    float t0 = (boxMin[axis] - o) / d;
    float t1 = (boxMax[axis] - o) / d;
    first = max(first, min(t0, t1));
    last = min(last, max(t0, t1));
  }
  return vec2(ceil(first), floor(last));
}

void main() {
  float column = gl_FragCoord.x - 0.5;
  float row = uDrawingBufferHeight - gl_FragCoord.y - 0.5;
  vec3 base = uOrigin + uColumnStep * column + uRowStep * row;

  float value = uOutsideValue;
  if (uSampleCount == 1) {
    if (inside(base)) value = sampleAt(base);
  } else {
    vec2 range = sampleRange(base, uSampleStep);
    int first = int(range.x);
    int last = int(range.y);
    if (first <= last) {
      float sum = 0.0;
      float extreme = uMode == MODE_MIN ? 1e9 : -1e9;
      for (int k = first; k <= last; k++) {
        float s = sampleAt(base + uSampleStep * float(k));
        sum += s;
        extreme = uMode == MODE_MIN ? min(extreme, s) : max(extreme, s);
      }
      value = uMode == MODE_AVERAGE ? sum / float(last - first + 1) : extreme;
    }
  }

  float grey = clamp((value - uWindowLow) / (uWindowHigh - uWindowLow), 0.0, 1.0);
  outColor = vec4(vec3(grey), 1.0);
}
