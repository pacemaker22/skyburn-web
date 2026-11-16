// Skyburn Phase 0 - vec3 API (Task 0.7). Tries the compiled WebAssembly module first
// (src/wasm/vec3.wasm, produced by build.py when a wasm32 toolchain exists); falls back to a
// pure-JS implementation with the SAME API. All functions are out-param style: no allocation.
// The fallback (VEC3_JS) is also the reference implementation used by unit tests.

export const VEC3_JS = {
  name: 'js-fallback',
  add(a, b, out) {
    out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
    return out;
  },
  sub(a, b, out) {
    out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
    return out;
  },
  scale(a, s, out) {
    out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
    return out;
  },
  cross(a, b, out) {
    const x = a[1] * b[2] - a[2] * b[1];
    const y = a[2] * b[0] - a[0] * b[2];
    const z = a[0] * b[1] - a[1] * b[0];
    out[0] = x; out[1] = y; out[2] = z;
    return out;
  },
  dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  },
  length(a) {
    return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  },
  normalize(a, out) {
    const len = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    if (len > 1e-12) {
      const inv = 1 / len;
      out[0] = a[0] * inv; out[1] = a[1] * inv; out[2] = a[2] * inv;
    } else {
      out[0] = 0; out[1] = 0; out[2] = 0;
    }
    return len;
  },
};

let impl = null; // chosen backend (wasm or js fallback), set by initVec3()

// Attempt to load + wire the WASM module. Resolves with the active backend.
// Never throws: any failure (missing file, no toolchain artifact, bad memory) falls back to JS.
export async function initVec3() {
  try {
    const url = new URL('./vec3.wasm', import.meta.url);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('vec3.wasm not available (' + resp.status + ')');
    const bytes = await resp.arrayBuffer();
    if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly unavailable');
    const { instance } = await WebAssembly.instantiate(bytes);
    const e = instance.exports;
    if (typeof e.sb_vec3_add !== 'function') throw new Error('vec3.wasm exports missing');
    // WASM backend: same API, backed by module memory scratch space.
    const mem = e.memory;
    const scratch = new Float32Array(mem.buffer, 0, 64); // 16 vec3 slots at offset 0
    impl = {
      name: 'wasm',
      add(a, b, out) {
        scratch[0] = a[0]; scratch[1] = a[1]; scratch[2] = a[2];
        scratch[4] = b[0]; scratch[5] = b[1]; scratch[6] = b[2];
        e.sb_vec3_add(0, 16, 32);
        out[0] = scratch[32]; out[1] = scratch[33]; out[2] = scratch[34];
        return out;
      },
      sub(a, b, out) {
        scratch[0] = a[0]; scratch[1] = a[1]; scratch[2] = a[2];
        scratch[4] = b[0]; scratch[5] = b[1]; scratch[6] = b[2];
        e.sb_vec3_sub(0, 16, 32);
        out[0] = scratch[32]; out[1] = scratch[33]; out[2] = scratch[34];
        return out;
      },
      scale(a, s, out) {
        scratch[0] = a[0]; scratch[1] = a[1]; scratch[2] = a[2];
        e.sb_vec3_scale(0, s, 32);
        out[0] = scratch[32]; out[1] = scratch[33]; out[2] = scratch[34];
        return out;
      },
      cross(a, b, out) {
        scratch[0] = a[0]; scratch[1] = a[1]; scratch[2] = a[2];
        scratch[4] = b[0]; scratch[5] = b[1]; scratch[6] = b[2];
        e.sb_vec3_cross(0, 16, 32);
        out[0] = scratch[32]; out[1] = scratch[33]; out[2] = scratch[34];
        return out;
      },
      dot(a, b) {
        scratch[0] = a[0]; scratch[1] = a[1]; scratch[2] = a[2];
        scratch[4] = b[0]; scratch[5] = b[1]; scratch[6] = b[2];
        return e.sb_vec3_dot(0, 16);
      },
      length(a) {
        scratch[0] = a[0]; scratch[1] = a[1]; scratch[2] = a[2];
        return e.sb_vec3_length(0);
      },
      normalize(a, out) {
        scratch[0] = a[0]; scratch[1] = a[1]; scratch[2] = a[2];
        const len = e.sb_vec3_normalize(0, 32);
        out[0] = scratch[32]; out[1] = scratch[33]; out[2] = scratch[34];
        return len;
      },
    };
  } catch (err) {
    impl = VEC3_JS; // Task 0.7: "If WASM toolchain not available, implement JS fallback"
    const msg = err && err.message ? err.message : String(err);
    console.info('[SKYBURN] vec3 backend: JS fallback (' + msg + ')');
  }
  return impl;
}

// Sync accessor after boot. Before initVec3() resolves, the JS fallback is returned.
export function getVec3() {
  return impl || VEC3_JS;
}
