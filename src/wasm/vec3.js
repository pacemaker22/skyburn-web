// Skyburn Phase 0 - vec3 API (Task 0.7). Uses the compiled WebAssembly module when the build
// actually produced one (src/wasm/vec3.wasm, built by build.py when a wasm32 toolchain exists);
// otherwise runs a pure-JS implementation with the SAME API. All functions are out-param
// style: no allocation. The fallback (VEC3_JS) is also the reference implementation used by
// unit tests.
//
// 404 policy (vec3.wasm missing => zero console noise): a browser cannot check a file's
// existence without requesting it, and any request for a missing file logs a 404. So the
// "does the artifact exist?" decision happens at BUILD time: build.py knows whether it
// compiled src/wasm/vec3.wasm and flips the gate below in the dist/ copy of this file (and
// only then). With the gate off, initVec3() does ZERO network activity: no fetch attempt,
// no error - one info line, then the silent JS fallback.

// Build-time backend gate. `false` in the source tree; build.py sets it to `true` in
// dist/src/wasm/vec3.js exactly when dist/src/wasm/vec3.wasm exists.
const VEC3_WASM_AVAILABLE = false;

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

let impl = null;           // chosen backend (wasm or js fallback), set by initVec3()
let backendLogged = false; // "log once" guard: the backend line prints a single time

function logBackendOnce() {
  if (backendLogged) return;
  backendLogged = true;
  console.info('[SKYBURN] vec3 backend: JS');
}

// Fetch + wire the WASM module. Returns the wasm backend, or null on ANY failure (missing
// artifact, no WebAssembly, bad memory, missing exports). Never throws, never logs: a failed
// load must not break the game nor spam the console.
async function tryLoadWasm() {
  if (typeof WebAssembly === 'undefined') return null;
  try {
    const url = new URL('./vec3.wasm', import.meta.url);
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const bytes = await resp.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes);
    const e = instance.exports;
    if (typeof e.sb_vec3_add !== 'function') return null;
    // WASM backend: same API, backed by module memory scratch space.
    const mem = e.memory;
    const scratch = new Float32Array(mem.buffer, 0, 64); // 16 vec3 slots at offset 0
    return {
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
  } catch (_err) {
    return null; // silent: the JS fallback takes over, the game must not break
  }
}

// Resolve the active backend. Resolves with the backend object; never throws.
// - Gate off (no wasm artifact in this build): ZERO fetch attempts, no error, and exactly
//   one info line ([SKYBURN] vec3 backend: JS) before the JS fallback runs.
// - Gate on but the load fails: silent JS fallback as well - the game must not break.
export async function initVec3() {
  if (impl) return impl; // already initialized
  if (VEC3_WASM_AVAILABLE) impl = await tryLoadWasm();
  if (!impl) {
    impl = VEC3_JS; // Task 0.7: "If WASM toolchain not available, implement JS fallback"
    logBackendOnce();
  }
  return impl;
}

// Sync accessor after boot. Before initVec3() resolves, the JS fallback is returned.
export function getVec3() {
  return impl || VEC3_JS;
}
