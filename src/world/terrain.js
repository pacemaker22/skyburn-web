// Skyburn Phase 0 - World terrain: seeded Perlin heightmap 256x256 (Task 0.5), 1 LOD ring.
// Pure data module: no DOM/WebGL here. Mesh buffers are built once at init (never in the loop).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Classic 2D gradient (Perlin) noise with a seeded permutation table.
export class Perlin2D {
  constructor(seed) {
    const rand = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  static fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

  static lerp(a, b, t) { return a + (b - a) * t; }

  static grad(hash, x, y) {
    switch (hash & 7) {
      case 0: return x + y;
      case 1: return x - y;
      case 2: return -x + y;
      case 3: return -x - y;
      case 4: return x;
      case 5: return -x;
      case 6: return y;
      default: return -y;
    }
  }

  noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const perm = this.perm;
    const aa = perm[perm[X] + Y];
    const ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y];
    const bb = perm[perm[X + 1] + Y + 1];
    const u = Perlin2D.fade(xf), v = Perlin2D.fade(yf);
    const x1 = Perlin2D.lerp(Perlin2D.grad(aa, xf, yf), Perlin2D.grad(ba, xf - 1, yf), u);
    const x2 = Perlin2D.lerp(Perlin2D.grad(ab, xf, yf - 1), Perlin2D.grad(bb, xf - 1, yf - 1), u);
    return Perlin2D.lerp(x1, x2, v); // roughly [-1, 1]
  }

  fbm(x, y, octaves) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += this.noise(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum / norm;
  }
}

export const SEA_LEVEL = 0;

// Island terrain patch: SIZE x SIZE meters centered on origin, SEG+1 x SEG+1 height samples.
// Heights below sea level sit under the ocean plane and are simply covered by it.
export class Terrain {
  constructor(opts) {
    const seed = (opts && opts.seed) !== undefined ? opts.seed : 1337;
    this.size = (opts && opts.size) || 12288;       // 12 km island region
    this.segments = (opts && opts.segments) || 255; // 256x256 heightfield (Task 0.5)
    this.perlin = new Perlin2D(seed);
    const n = this.segments + 1;
    this.n = n;
    this.heights = new Float32Array(n * n);
    this.minY = 0; this.maxY = 0;
    this._generate();
  }

  _generate() {
    const n = this.n, size = this.size, half = size * 0.5;
    const step = size / this.segments;
    const h = this.heights;
    const p = this.perlin;
    let min = Infinity, max = -Infinity;
    for (let j = 0; j < n; j++) {
      const z = -half + j * step;
      for (let i = 0; i < n; i++) {
        const x = -half + i * step;
        // island mask: full land near center, forced ocean toward the border
        const r = Math.sqrt(x * x + z * z) / half;
        const mask = r < 0.55 ? 1 : Math.max(0, 1 - (r - 0.55) / 0.45);
        const n01 = p.fbm(x * 0.00035, z * 0.00035, 4) * 0.5 + 0.5;
        const y = Math.max(0, (n01 - 0.52) * 2.2) * 680 * mask;
        h[j * n + i] = y;
        if (y < min) min = y;
        if (y > max) max = y;
      }
    }
    this.minY = min; this.maxY = max;
    this.step = step;
    this.half = half;
  }

  // Bilinear sample of the heightfield; outside the patch returns 0 (open ocean).
  heightAt(x, z) {
    const n = this.n, half = this.half, step = this.step;
    if (x < -half || x > half || z < -half || z > half) return 0;
    const fx = (x + half) / step, fz = (z + half) / step;
    const i0 = Math.min(this.segments - 1, Math.max(0, Math.floor(fx)));
    const j0 = Math.min(this.segments - 1, Math.max(0, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - i0));
    const tz = Math.min(1, Math.max(0, fz - j0));
    const h = this.heights;
    const a = h[j0 * n + i0], b = h[j0 * n + i0 + 1];
    const c = h[(j0 + 1) * n + i0], d = h[(j0 + 1) * n + i0 + 1];
    const top = a + (b - a) * tx;
    const bot = c + (d - c) * tx;
    return top + (bot - top) * tz;
  }

  // Build interleaved mesh [px,py,pz, nx,ny,nz, r,g,b] + Uint32 indices. One LOD ring (Task 0.5).
  // Graphics pass: vertex COLORS gain perlin patchiness + painted runway/roads; HEIGHTS are
  // byte-identical to the Phase 0 generator, so collision/gameplay is untouched.
  buildMesh() {
    const n = this.n, size = this.size, half = this.half, step = size / this.segments;
    const vertCount = n * n;
    const stride = 9;
    const verts = new Float32Array(vertCount * stride);
    const H = this.heights;
    const perlin = this.perlin;
    for (let j = 0; j < n; j++) {
      const z = -half + j * step;
      for (let i = 0; i < n; i++) {
        const x = -half + i * step;
        const y = H[j * n + i];
        // central-difference normal
        const yl = H[j * n + (i > 0 ? i - 1 : i)];
        const yr = H[j * n + (i < n - 1 ? i + 1 : i)];
        const yd = H[(j > 0 ? j - 1 : j) * n + i];
        const yu = H[(j < n - 1 ? j + 1 : j) * n + i];
        const nx = (yl - yr) / (2 * step);
        const nz = (yd - yu) / (2 * step);
        const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
        const o = (j * n + i) * stride;
        verts[o] = x; verts[o + 1] = y; verts[o + 2] = z;
        verts[o + 3] = nx * inv; verts[o + 4] = inv; verts[o + 5] = nz * inv;
        // broad patchiness picks between the two greens; fine mottle breaks the flat bands
        const patch = perlin.fbm(x * 0.0016, z * 0.0016, 3);
        const mottle = perlin.fbm(x * 0.012, z * 0.012, 2);
        colorForHeight(y, patch, mottle, x, z, verts, o + 6);
      }
    }
    const quads = this.segments * this.segments;
    const idx = new Uint32Array(quads * 6);
    let k = 0;
    for (let j = 0; j < this.segments; j++) {
      for (let i = 0; i < this.segments; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }
    return { verts, idx, stride };
  }
}

// Graphics-pass palette (art direction: 2 greens + sandy + dark slate, noise varied, runway
// + roads painted as color only). Heights are NOT touched here - gameplay identical.
// patch/mottle are perlin fbm samples roughly in [-1, 1]; (x, z) locate runway/road strips.
function colorForHeight(y, patch, mottle, x, z, out, o) {
  let r, g, b;
  if (y < 4) {
    r = 0.80; g = 0.72; b = 0.52;                                   // warm sandy shoreline
  } else if (y < 90) {
    // green 1 (light warm grass) <-> green 2 (deeper green) blended by patch noise
    const t = Math.min(1, Math.max(0, patch * 0.5 + 0.5));
    r = 0.42 - 0.10 * t; g = 0.55 - 0.04 * t; b = 0.28 + 0.01 * t;
  } else if (y < 260) {
    r = 0.27; g = 0.39; b = 0.24;                                   // green 2: deep slopes
  } else if (y < 460) {
    r = 0.40; g = 0.42; b = 0.45;                                   // dark slate rock
  } else {
    r = 0.86; g = 0.88; b = 0.91;                                   // pale caps (rare, high)
  }
  // fine mottle: +/-7% brightness variation kills the flat banded look
  const m = 1 + mottle * 0.14;
  r *= m; g *= m; b *= m;
  // painted airfield + roads (color-only overlays, masked to lowlands so they hug flat land;
  // vertex spacing is ~48 m, so strip widths are sized to survive vertex interpolation)
  if (y < 150) {
    const inRwyZ = z > 600 && z < 2800;
    if (inRwyZ && x > -60 && x < 60) {
      r = 0.22; g = 0.23; b = 0.25;                                 // asphalt runway strip
      if (x > -18 && x < 18 && ((z - 600) % 300) < 140) {
        r = 0.85; g = 0.85; b = 0.82;                               // dashed centerline
      }
    } else if (x > -45 && x < 45 && z > 2800 && z < 5200 && y < 120) {
      r = 0.60; g = 0.55; b = 0.44;                                 // sandy road, heading south
    } else if (z > -45 && z < 45 && x > -3200 && x < -60 && y < 120) {
      r = 0.60; g = 0.55; b = 0.44;                                 // sandy road, heading west
    }
  }
  out[o] = r; out[o + 1] = g; out[o + 2] = b;
}
