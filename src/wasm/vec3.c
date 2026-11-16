// Skyburn Phase 0 - WASM stub (Task 0.7): vec3 math in C, compiled to WebAssembly when a
// wasm32 toolchain is available (clang --target=wasm32 or emcc). If not available, vec3.js
// loads a JS fallback with the SAME API. JS orchestrates, WASM computes hot paths (PRD Sec 8).
//
// Build (when clang exists):
//   clang --target=wasm32 -O2 -nostdlib -Wl,--no-entry -Wl,--export-all \
//         -o src/wasm/vec3.wasm src/wasm/vec3.c
// build.py runs this automatically when clang is found; vec3.js falls back otherwise.

/* C API (all operate on float* triples unless noted):
   void   sb_vec3_add(const float* a, const float* b, float* out);
   void   sb_vec3_sub(const float* a, const float* b, float* out);
   void   sb_vec3_scale(const float* a, float s, float* out);
   void   sb_vec3_cross(const float* a, const float* b, float* out);
   float  sb_vec3_dot(const float* a, const float* b);
   float  sb_vec3_length(const float* a);
   float  sb_vec3_normalize(const float* a, float* out);  // returns length; zero-safe
*/

void sb_vec3_add(const float* a, const float* b, float* out) {
  out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
}

void sb_vec3_sub(const float* a, const float* b, float* out) {
  out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
}

void sb_vec3_scale(const float* a, float s, float* out) {
  out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
}

void sb_vec3_cross(const float* a, const float* b, float* out) {
  out[0] = a[1] * b[2] - a[2] * b[1];
  out[1] = a[2] * b[0] - a[0] * b[2];
  out[2] = a[0] * b[1] - a[1] * b[0];
}

float sb_vec3_dot(const float* a, const float* b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

float sb_vec3_length(const float* a) {
  return sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

float sb_vec3_normalize(const float* a, float* out) {
  float len = sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  if (len > 1e-12f) {
    float inv = 1.0f / len;
    out[0] = a[0] * inv; out[1] = a[1] * inv; out[2] = a[2] * inv;
  } else {
    out[0] = 0.0f; out[1] = 0.0f; out[2] = 0.0f;
  }
  return len;
}
