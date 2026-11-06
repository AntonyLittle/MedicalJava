#version 300 es

// Full-screen triangle from gl_VertexID; no vertex buffers needed.
out vec2 vNdc;

void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  // x right, y down, matching canvas pixels and CameraFrame.down.
  vNdc = vec2(position.x, -position.y);
  gl_Position = vec4(position, 0.0, 1.0);
}
