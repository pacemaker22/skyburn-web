// Skyburn Phase 0 - World ocean: single large plane, waves displaced in the vertex shader
// (Task 0.5: ocean plane with shader waves). Pure data module: mesh built once at init.

export class Ocean {
  constructor(opts) {
    this.size = (opts && opts.size) || 40960;     // 40 km x 40 km arena (PRD non-goal: bounded arenas)
    this.segments = (opts && opts.segments) || 192;
  }

  // Position-only interleaved layout [px,py,pz]; normals come from the wave function in the shader.
  buildMesh() {
    const seg = this.segments, n = seg + 1;
    const half = this.size * 0.5;
    const step = this.size / seg;
    const verts = new Float32Array(n * n * 3);
    let o = 0;
    for (let j = 0; j < n; j++) {
      const z = -half + j * step;
      for (let i = 0; i < n; i++) {
        const x = -half + i * step;
        verts[o++] = x; verts[o++] = 0; verts[o++] = z;
      }
    }
    const idx = new Uint32Array(seg * seg * 6);
    let k = 0;
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }
    return { verts, idx };
  }
}
