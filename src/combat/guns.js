// Skyburn Phase 1 - Guns (Task 1.3): "hitscan + tracer, 600 RPM, falloff, spread, muzzle
// flash pooled". Bullets are instant hitscan rays; the pool stores TRACER visuals (segment +
// ttl) and is capped at 500. Spread and cadence are deterministic (seeded RNG).
// Zero allocation after construction: all buffers preallocated, fire/update write in place.

import { Pool } from './entities.js';
import { mulberry32 } from '../world/terrain.js';

export const GUN_TUNING = {
  RPM: 600,               // PRD Task 1.3
  MAX_RANGE: 2600,        // m hitscan reach
  FALLOFF_START: 800,     // full damage <= 800 m
  FALLOFF_END: 2400,      // linear falloff to MIN_DMG_FRAC at 2400 m
  MIN_DMG_FRAC: 0.25,
  SPREAD_RAD: 0.0035,     // ~0.2 degree cone (aim wobble)
  TRACER_TTL: 0.3,        // s a tracer segment stays visible (VFX spec: 0.3 s fading streak)
  MAX_TRACERS: 500,       // PRD pool size
};

export class GunSystem {
  // collision: the world's CollisionWorld, injected by main (created BEFORE the gun system).
  // Guns never read ents.collision - the ents registry carries no back-reference to it.
  constructor(seed, collision) {
    this.collision = collision || null; // null => _fireOne bails silently (main always injects)
    this.pool = new Pool(GUN_TUNING.MAX_TRACERS);
    this.pos0 = new Float32Array(GUN_TUNING.MAX_TRACERS * 3);
    this.pos1 = new Float32Array(GUN_TUNING.MAX_TRACERS * 3);
    this.ttl = new Float32Array(GUN_TUNING.MAX_TRACERS);
    this.rng = mulberry32(seed === undefined ? 0xC0FFEE : seed);
    // Hooks set by main (audio + damage application). Preallocated, never replaced.
    this.hooks = { onHit: null, onMuzzle: null };
    this._hit = { id: -1, dist: 0, px: 0, py: 0, pz: 0 };
  }

  // Attempt to fire for one shooter. shooter = preallocated plain object view:
  //   { id, team, gunDamage, noseX, noseY, noseZ, fx, fy, fz (unit forward), world }
  // fireHeld: InputState FIRE_GUN. cooldown: shooter's current cooldown (s), mutated.
  // Returns the updated cooldown.
  tryFire(shooter, fireHeld, cooldown, dt) {
    if (!fireHeld) {
      // allow immediate first shot on next press but keep the drum spinning honestly
      return cooldown > 0 ? Math.max(0, cooldown - dt) : 0;
    }
    if (cooldown > 0) return cooldown - dt;
    const interval = 60 / GUN_TUNING.RPM;
    this._fireOne(shooter);
    return cooldown + interval - dt > 0 ? cooldown + interval - dt : 0;
  }

  _fireOne(shooter) {
    if (!this.collision) return false; // no collision world injected: skip silently, never crash
    const ents = shooter.world;
    // spread: two uniform samples -> cone offset (deterministic per seed)
    const a = this.rng() * Math.PI * 2;
    const rm = GUN_TUNING.SPREAD_RAD * Math.sqrt(this.rng());
    const dirX = shooter.fx + Math.cos(a) * rm;
    const dirY = shooter.fy + Math.sin(a) * rm;
    const dirZ = shooter.fz + (this.rng() - 0.5) * rm;
    const dl = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;
    const dx = dirX / dl, dy = dirY / dl, dz = dirZ / dl;
    const endX = shooter.noseX + dx * GUN_TUNING.MAX_RANGE;
    const endY = shooter.noseY + dy * GUN_TUNING.MAX_RANGE;
    const endZ = shooter.noseZ + dz * GUN_TUNING.MAX_RANGE;

    const hit = this._hit;
    hit.id = -1;
    const enemyTeam = shooter.team === 0 ? 1 : 0;
    const found = this.collision.segmentQuery(ents, shooter.noseX, shooter.noseY, shooter.noseZ,
      endX, endY, endZ, shooter.id, enemyTeam, hit);
    let ex = endX, ey = endY, ez = endZ;
    if (found) {
      ex = hit.px; ey = hit.py; ez = hit.pz;
      // damage falloff (Task 1.3): full <= FALLOFF_START, linear to MIN_DMG_FRAC at FALLOFF_END
      const d = hit.dist;
      let frac = 1;
      if (d > GUN_TUNING.FALLOFF_START) {
        const t = Math.min(1, (d - GUN_TUNING.FALLOFF_START) /
          (GUN_TUNING.FALLOFF_END - GUN_TUNING.FALLOFF_START));
        frac = 1 - t * (1 - GUN_TUNING.MIN_DMG_FRAC);
      }
      if (this.hooks.onHit) {
        this.hooks.onHit(hit.id, shooter.gunDamage * frac, hit.px, hit.py, hit.pz, shooter.id);
      }
    }
    if (this.hooks.onMuzzle) {
      this.hooks.onMuzzle(shooter.noseX, shooter.noseY, shooter.noseZ, dx, dy, dz);
    }
    // pooled tracer (visual only; skipped silently when the pool is full - "no new in loop")
    const id = this.pool.alloc();
    if (id >= 0) {
      this.pos0[id * 3] = shooter.noseX; this.pos0[id * 3 + 1] = shooter.noseY;
      this.pos0[id * 3 + 2] = shooter.noseZ;
      this.pos1[id * 3] = ex; this.pos1[id * 3 + 1] = ey; this.pos1[id * 3 + 2] = ez;
      this.ttl[id] = GUN_TUNING.TRACER_TTL;
    }
  }

  // Expire tracers; frees slots back to the pool (O(pool) scan each tick - 500 floats max).
  update(dt) {
    for (let i = 0; i < this.pool.max; i++) {
      if (this.ttl[i] > 0) {
        this.ttl[i] -= dt;
        if (this.ttl[i] <= 0) {
          this.ttl[i] = 0;
          this.pool.free(i);
        }
      }
    }
  }

  // Active tracer count (for renderer stats).
  activeCount() { return this.pool.active; }
}
