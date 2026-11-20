// Skyburn Phase 1 - GPU particle system (Task 1.8): SoA pool of 2000, one interleaved dynamic
// VBO re-staged every frame with bufferSubData (positions/sizes/colors live on the GPU between
// frames). Kinds: SMOKE (damage/impact clouds, grows + fades), FLASH (muzzle/explosion core),
// SPARK (fast gravity streaks), DEBRIS (chunks), TRAIL (missile motor ribbon puffs).
// "Smoke ribbon" = high-rate small TRAIL puffs emitted along a flying object's path, blended
// by the renderer into a continuous ribbon. Zero allocation per tick: stage() writes into a
// preallocated Float32Array that the renderer uploads directly.

import { Pool } from '../combat/entities.js';
import { mulberry32 } from '../world/terrain.js';

export const PARTICLE_TUNING = { MAX: 2000 }; // PRD pool size

export const P_KIND = { SMOKE: 0, FLASH: 1, SPARK: 2, DEBRIS: 3, TRAIL: 4 };

// per-kind motion constants [gravity, drag(1/s), sizeGrowth(frac of life), alphaCurve]
const KIND_MOTION = [
  [0.0, 1.2, 2.2, 1.0],  // SMOKE: rises slightly? no gravity, drags, grows a lot
  [0.0, 6.0, 0.2, 2.0],  // FLASH: dies fast, barely grows
  [-14.0, 0.4, 0.0, 1.0],// SPARK: falls fast, stays small
  [-9.81, 0.25, 0.0, 1.0],// DEBRIS: falls, small drag
  [0.6, 1.6, 1.6, 1.0],  // TRAIL: slight rise, grows into ribbon
];

export class ParticleSystem {
  constructor(max, seed) {
    this.max = max || PARTICLE_TUNING.MAX;
    this.pool = new Pool(this.max);
    this.pos = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3);
    this.ttl = new Float32Array(this.max);
    this.life0 = new Float32Array(this.max);
    this.size0 = new Float32Array(this.max);
    this.color = new Float32Array(this.max * 3);
    this.kind = new Uint8Array(this.max);
    this.rng = mulberry32(seed === undefined ? 0xFA7E5 : seed);
    // GPU staging: 8 floats per particle [x,y,z,size,r,g,b,alpha]; renderer uploads this.
    this.staging = new Float32Array(this.max * 8);
    this.stagedCount = 0;
  }

  spawn(kind, x, y, z, vx, vy, vz, ttl, size, r, g, b) {
    const id = this.pool.alloc();
    if (id < 0) return -1; // pool full: silently drop (visual only, "no new in loop")
    this.pos[id * 3] = x; this.pos[id * 3 + 1] = y; this.pos[id * 3 + 2] = z;
    this.vel[id * 3] = vx; this.vel[id * 3 + 1] = vy; this.vel[id * 3 + 2] = vz;
    this.ttl[id] = ttl; this.life0[id] = ttl;
    this.size0[id] = size;
    this.color[id * 3] = r; this.color[id * 3 + 1] = g; this.color[id * 3 + 2] = b;
    this.kind[id] = kind;
    return id;
  }

  // Explosion burst (graphics pass): ~30 particles, the whole effect fades within 0.9 s
  // (readability rule #4: explosions never block the view). White-hot core -> orange
  // fireball -> sparks + warm dark smoke. Deterministic (seeded), fully pooled.
  burstExplosion(x, y, z) {
    this.spawn(P_KIND.FLASH, x, y, z, 0, 0, 0, 0.22, 30, 1.0, 0.92, 0.70);  // white-hot core
    this.spawn(P_KIND.FLASH, x, y, z, 0, 0, 0, 0.42, 16, 1.0, 0.55, 0.22);  // orange fireball
    for (let i = 0; i < 12; i++) {
      const a = this.rng() * Math.PI * 2;
      const u = this.rng() * 2 - 1;
      const sp = 26 + this.rng() * 44;
      const rh = Math.sqrt(1 - u * u);
      this.spawn(P_KIND.SPARK, x, y, z,
        Math.cos(a) * rh * sp, u * sp, Math.sin(a) * rh * sp,
        0.35 + this.rng() * 0.35, 2.2, 1.0, 0.68, 0.28);
    }
    for (let i = 0; i < 10; i++) {
      const a = this.rng() * Math.PI * 2;
      const sp = 4 + this.rng() * 10;
      this.spawn(P_KIND.SMOKE, x, y, z,
        Math.cos(a) * sp, 3 + this.rng() * 6, Math.sin(a) * sp,
        0.55 + this.rng() * 0.35, 8 + this.rng() * 7, 0.30, 0.27, 0.26);
    }
    for (let i = 0; i < 6; i++) {
      const a = this.rng() * Math.PI * 2;
      const u = this.rng() * 2 - 1;
      const sp = 14 + this.rng() * 22;
      const rh = Math.sqrt(1 - u * u);
      this.spawn(P_KIND.DEBRIS, x, y, z,
        Math.cos(a) * rh * sp, u * sp + 8, Math.sin(a) * rh * sp,
        0.5 + this.rng() * 0.4, 1.6, 0.25, 0.23, 0.22);
    }
  }

  // Muzzle flash (pooled, 2 puffs, 0.05 s per the VFX spec).
  muzzleFlash(x, y, z, dx, dy, dz) {
    this.spawn(P_KIND.FLASH, x, y, z, dx * 8, dy * 8, dz * 8, 0.05, 5.5, 1.0, 0.9, 0.62);
    this.spawn(P_KIND.SPARK, x, y, z, dx * 60, dy * 60, dz * 60, 0.05, 1.6, 1.0, 0.8, 0.45);
  }

  // Bullet hit feedback: tiny flash + 5 bright sparks, gone in ~0.2 s (pooled, VFX spec).
  hitSpark(x, y, z) {
    this.spawn(P_KIND.FLASH, x, y, z, 0, 1, 0, 0.10, 4.5, 1.0, 0.85, 0.50);
    for (let i = 0; i < 5; i++) {
      const a = this.rng() * Math.PI * 2;
      const u = (this.rng() * 2 - 1) * 0.7;
      const sp = 12 + this.rng() * 20;
      const rh = Math.sqrt(1 - u * u);
      this.spawn(P_KIND.SPARK, x, y, z,
        Math.cos(a) * rh * sp, u * sp + 4, Math.sin(a) * rh * sp,
        0.16 + this.rng() * 0.06, 1.8, 1.0, 0.80, 0.40);
    }
  }

  // Damage smoke (health < 35%): oily puffs drifting behind the jet (low count, pooled).
  emitDamageSmoke(x, y, z, vx, vy, vz) {
    this.spawn(P_KIND.SMOKE, x, y, z, vx * 0.2, vy * 0.2 + 1.5, vz * 0.2,
      1.1, 5, 0.12, 0.12, 0.13);
  }

  // Missile motor trail puff (smoke ribbon segment): white smoke, 2 s life (VFX spec).
  // Emission rate is throttled in missiles.js so one missile holds <= 100 live puffs.
  emitTrail(x, y, z) {
    this.spawn(P_KIND.TRAIL, x, y, z, 0, 1.0, 0, 2.0, 2.6, 0.90, 0.90, 0.92);
  }

  // Flare: bright white-hot core + 3 falling sparks, visuals last ~1.5 s (VFX spec).
  emitFlare(x, y, z, vx, vy, vz) {
    this.spawn(P_KIND.FLASH, x, y, z, 0, 0, 0, 0.30, 6, 1.0, 0.85, 0.55);
    for (let i = 0; i < 3; i++) {
      this.spawn(P_KIND.SPARK, x, y, z,
        vx + (this.rng() - 0.5) * 18, vy - 6 - this.rng() * 8, vz + (this.rng() - 0.5) * 18,
        1.5, 3.2, 1.0, 0.72, 0.32);
    }
  }

  // Afterburner cone + glow: short-lived additive puffs streaming backwards (pooled).
  // (bx,by,bz) = unit backwards vector of the jet at emission time.
  emitAfterburner(x, y, z, bx, by, bz) {
    this.spawn(P_KIND.FLASH, x, y, z,
      bx * 55 + (this.rng() - 0.5) * 8, by * 55 + (this.rng() - 0.5) * 8,
      bz * 55 + (this.rng() - 0.5) * 8, 0.14, 5.5, 1.0, 0.62, 0.25);
    this.spawn(P_KIND.FLASH, x, y, z,
      bx * 30, by * 30, bz * 30, 0.08, 3.5, 1.0, 0.85, 0.55);
  }

  // Engine glow: small warm additive dot at the nozzle - keeps distant jets readable
  // against terrain (readability rule #1, pairs with the silhouette outline).
  emitEngineGlow(x, y, z) {
    this.spawn(P_KIND.FLASH, x, y, z, 0, 0, 0, 0.12, 5, 1.0, 0.72, 0.35);
  }

  // Integrate all live particles; free expired slots. O(max) scan - 2000 floats, cheap.
  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.ttl[i] <= 0) continue;
      this.ttl[i] -= dt;
      if (this.ttl[i] <= 0) {
        this.ttl[i] = 0;
        this.pool.free(i);
        continue;
      }
      const k = KIND_MOTION[this.kind[i]];
      this.vel[i * 3] -= this.vel[i * 3] * k[1] * dt;
      this.vel[i * 3 + 1] += k[0] * dt;
      this.vel[i * 3 + 2] -= this.vel[i * 3 + 2] * k[1] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
  }

  // Stage live particles into the GPU buffer layout: ALPHA-blend kinds first (SMOKE, TRAIL,
  // DEBRIS), then ADDITIVE kinds (FLASH, SPARK). The renderer draws [0, stagedAlphaCount) with
  // alpha blending and [stagedAlphaCount, stagedCount) with additive blending - one VBO, no
  // copies, no sort. Returns the total count written.
  stage() {
    let nAlpha = 0;
    let n = 0;
    const st = this.staging;
    // pass 1: alpha kinds
    for (let i = 0; i < this.max; i++) {
      if (this.ttl[i] <= 0) continue;
      const k = this.kind[i];
      if (k === P_KIND.FLASH || k === P_KIND.SPARK) continue;
      nAlpha = this._writeOne(st, nAlpha, i);
    }
    n = nAlpha;
    // pass 2: additive kinds
    for (let i = 0; i < this.max; i++) {
      if (this.ttl[i] <= 0) continue;
      const k = this.kind[i];
      if (k !== P_KIND.FLASH && k !== P_KIND.SPARK) continue;
      n = this._writeOne(st, n, i);
    }
    this.stagedAlphaCount = nAlpha;
    this.stagedCount = n;
    return n;
  }

  _writeOne(st, o8, i) {
    const o = o8 * 8;
    const lifeFrac = this.ttl[i] / this.life0[i];            // 1 -> 0
    const k = KIND_MOTION[this.kind[i]];
    const size = this.size0[i] * (1 + k[2] * (1 - lifeFrac));
    const alpha = Math.min(1, lifeFrac * k[3]);
    st[o] = this.pos[i * 3]; st[o + 1] = this.pos[i * 3 + 1]; st[o + 2] = this.pos[i * 3 + 2];
    st[o + 3] = size;
    st[o + 4] = this.color[i * 3]; st[o + 5] = this.color[i * 3 + 1]; st[o + 6] = this.color[i * 3 + 2];
    st[o + 7] = alpha;
    return o8 + 1;
  }

  activeCount() { return this.pool.active; }
}

// Soft round sprite fragment logic lives in the shader; size attenuation there too
// (gl_PointSize = aSize * uPointScale / w). Rendered as gl.POINTS with additive-ish blending
// for FLASH/SPARK and alpha blending for SMOKE/TRAIL/DEBRIS (two passes in the renderer).
export const PARTICLE_BLEND = { ADDITIVE: 0, ALPHA: 1 };

export function particleBlendPass(kind) {
  return kind === P_KIND.FLASH || kind === P_KIND.SPARK
    ? PARTICLE_BLEND.ADDITIVE : PARTICLE_BLEND.ALPHA;
}
