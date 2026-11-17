// Skyburn Phase 1 - Missiles (Task 1.4): "Lock FSM IDLE->LOCKING 1.2s->LOCKED->FIRING (in
// lockon.js), PN guidance, flares break lock" + the PRD Missile FSM:
//   SPAWN -> BOOST -> GUIDE -> PROXIMITY -> HIT/MISS/TIMEOUT -> EXPLODE -> RECYCLE
// Invariant (PRD): GUIDE cannot go to SPAWN - enforced structurally (no such transition) AND
// by FSMTable.validate(forbidden) so a bad table edit fails loudly.
// Guidance: proportional-navigation-flavored lead pursuit - steer toward the predicted
// intercept point (target pos + target vel * t_go) with a turn-rate limit; t_go from closing
// rate. This is the standard arcade PN approximation (N=4 behavior: turn harder the faster
// the LOS rotates). Zero allocation per tick (SoA arrays + preallocated FSMs).

import { Pool, TEAM } from './entities.js';
import { FSMTable, FSM } from '../ai/fsm.js';
import { mulberry32 } from '../world/terrain.js';

export const MISSILE_STATE = {
  SPAWN: 0, BOOST: 1, GUIDE: 2, PROXIMITY: 3, HIT: 4, MISS: 5, TIMEOUT: 6, EXPLODE: 7,
  RECYCLE: 8, COUNT: 9,
};
export const MISSILE_STATE_NAMES =
  ['SPAWN', 'BOOST', 'GUIDE', 'PROXIMITY', 'HIT', 'MISS', 'TIMEOUT', 'EXPLODE', 'RECYCLE'];
export const MISSILE_EVENT = {
  LAUNCH: 0, MOTOR_DONE: 1, FUSE_IN: 2, CONTACT: 3, DECOYED: 4, OUT_OF_CHASE: 5,
  LIFE_OVER: 6, DETONATE: 7, DONE: 8, FREED: 9, COUNT: 11,
};
export const MISSILE_EVENT_NAMES =
  ['LAUNCH', 'MOTOR_DONE', 'FUSE_IN', 'CONTACT', 'DECOYED', 'OUT_OF_CHASE', 'LIFE_OVER',
    'DETONATE', 'DONE', 'FREED', '(unused)'];

export const MISSILE_TUNING = {
  MAX_MISSILES: 64,       // PRD pool
  BOOST_ACCEL: 300,       // m/s^2 while motor burns
  BOOST_TIME: 1.2,        // s
  MAX_SPEED: 900,         // m/s
  TURN_RATE: 3.6,         // rad/s guidance limit
  FUSE_RANGE: 8,          // m proximity fuse (PRD Task 1.6)
  FUSE_WINDOW: 1.2,       // s in PROXIMITY before MISS
  LIFE: 9.0,              // s total flight time -> TIMEOUT
  DECOY_RANGE: 1600,      // m within which flares can seduce the seeker
  DECOY_PROB: 2.2,        // per-second seduction probability while flares burn
  BLAST_RADIUS: 25,       // m explosion damage radius
  BLAST_DMG: 60,
};

function pureTrue() { return true; }

// The one shared missile transition table (PRD FSM; forbidden pair validated).
export function buildMissileTable() {
  const S = MISSILE_STATE, E = MISSILE_EVENT;
  const t = new FSMTable(S.COUNT, E.COUNT, MISSILE_STATE_NAMES, MISSILE_EVENT_NAMES);
  t.add(S.SPAWN, E.LAUNCH, S.BOOST, pureTrue, null);
  t.add(S.BOOST, E.MOTOR_DONE, S.GUIDE, pureTrue, null);
  t.add(S.GUIDE, E.FUSE_IN, S.PROXIMITY, pureTrue, null);
  t.add(S.PROXIMITY, E.CONTACT, S.HIT, pureTrue, null);
  t.add(S.PROXIMITY, E.DECOYED, S.MISS, pureTrue, null);
  t.add(S.PROXIMITY, E.OUT_OF_CHASE, S.MISS, pureTrue, null);
  t.add(S.GUIDE, E.DECOYED, S.MISS, pureTrue, null);
  t.add(S.BOOST, E.LIFE_OVER, S.TIMEOUT, pureTrue, null);
  t.add(S.GUIDE, E.LIFE_OVER, S.TIMEOUT, pureTrue, null);
  t.add(S.PROXIMITY, E.LIFE_OVER, S.TIMEOUT, pureTrue, null);
  t.add(S.HIT, E.DETONATE, S.EXPLODE, pureTrue, (c) => { c.onExplode(); });
  t.add(S.MISS, E.DETONATE, S.EXPLODE, pureTrue, (c) => { c.onExplode(); });
  t.add(S.TIMEOUT, E.DETONATE, S.EXPLODE, pureTrue, (c) => { c.onExplode(); });
  t.add(S.EXPLODE, E.DONE, S.RECYCLE, pureTrue, null);
  t.add(S.RECYCLE, E.FREED, S.SPAWN, pureTrue, (c) => { c.onFreed(); });
  // PRD invariant: GUIDE cannot go to SPAWN (structurally absent + validated):
  t.validate([[S.GUIDE, S.SPAWN]]);
  return t;
}

export class MissileSystem {
  // hooks: { onExplode(x,y,z,ownerId), flareActive(targetId, outPos) -> bool, onTrail(...) }
  constructor(seed, hooks) {
    this.max = MISSILE_TUNING.MAX_MISSILES;
    this.pool = new Pool(this.max);
    this.table = buildMissileTable();
    this.rng = mulberry32(seed === undefined ? 0x5EED1E5 : seed);
    this.hooks = hooks || { onExplode: null, flareActive: null };

    // SoA fields (index = pool slot)
    this.pos = new Float32Array(this.max * 3);
    this.prevPos = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3);
    this.yaw = new Float32Array(this.max);      // render orientation
    this.pitch = new Float32Array(this.max);
    this.owner = new Int32Array(this.max);
    this.targetId = new Int32Array(this.max);
    this.life = new Float32Array(this.max);     // total life countdown
    this.decoyedTimer = new Float32Array(this.max); // >0 while flying at a flare point
    this.flareX = new Float32Array(this.max);
    this.flareY = new Float32Array(this.max);
    this.flareZ = new Float32Array(this.max);
    this.explodeTimer = new Float32Array(this.max); // HIT/MISS/TIMEOUT -> EXPLODE grace
    this._ctxCache = new Array(this.max); // per-slot ctx objects (stable, no per-tick alloc)
    for (let i = 0; i < this.max; i++) {
      this._ctxCache[i] = {
        sys: this, slot: 0,
        onExplode() { this.sys._detonate(this.slot); },
        onFreed() { this.sys._recycle(this.slot); },
      };
    }
    this.fsms = new Array(this.max);
    for (let i = 0; i < this.max; i++) {
      this.fsms[i] = new FSM(this.table, MISSILE_STATE.SPAWN, this._ctxCache[i]);
    }
    this._aim = new Float32Array(3);
  }

  _ctx(i) { return this._ctxCache[i]; }

  // Spawn a missile from a shooter. Returns pool slot or -1 (pool full - "no new in loop").
  spawn(ownerId, x, y, z, fx, fy, fz, launchSpeed, targetId) {
    const id = this.pool.alloc();
    if (id < 0) return -1;
    this.pos[id * 3] = x; this.pos[id * 3 + 1] = y; this.pos[id * 3 + 2] = z;
    this.prevPos[id * 3] = x; this.prevPos[id * 3 + 1] = y; this.prevPos[id * 3 + 2] = z;
    this.vel[id * 3] = fx * launchSpeed;
    this.vel[id * 3 + 1] = fy * launchSpeed;
    this.vel[id * 3 + 2] = fz * launchSpeed;
    this.yaw[id] = Math.atan2(fx, -fz);
    this.pitch[id] = Math.asin(Math.max(-1, Math.min(1, fy)));
    this.owner[id] = ownerId;
    this.targetId[id] = targetId;
    this.life[id] = MISSILE_TUNING.LIFE;
    this.decoyedTimer[id] = 0;
    this.explodeTimer[id] = 0;
    const s = this.fsms[id];
    s.state = MISSILE_STATE.SPAWN;
    s.fire(MISSILE_EVENT.LAUNCH, this._ctx(id));
    return id;
  }

  _detonate(slot) {
    if (this.hooks.onExplode) {
      this.hooks.onExplode(this.pos[slot * 3], this.pos[slot * 3 + 1], this.pos[slot * 3 + 2],
        this.owner[slot], this.targetId[slot]);
    }
    this.explodeTimer[slot] = 0.05; // brief EXPLODE state before recycle
  }

  _recycle(slot) {
    this.pool.free(slot);
  }

  stateOf(slot) { return this.fsms[slot].state; }
  stateNameOf(slot) { return MISSILE_STATE_NAMES[this.fsms[slot].state]; }

  // One physics tick for every live missile. ents = WorldEntities (targets + owner),
  // trailFn = optional fn(x,y,z) for motor smoke (particles). Zero allocation.
  update(dt, ents, trailFn) {
    const T = MISSILE_TUNING;
    for (let i = 0; i < this.max; i++) {
      const st = this.fsms[i].state;
      if (st === MISSILE_STATE.SPAWN) continue;
      if (st === MISSILE_STATE.RECYCLE) {
        // terminal state: release the pool slot (FREED -> SPAWN + onFreed -> pool.free)
        this.fsms[i].fire(MISSILE_EVENT.FREED, this._ctx(i));
        continue;
      }
      const fsm = this.fsms[i];
      fsm.tick(dt);
      this.prevPos[i * 3] = this.pos[i * 3];
      this.prevPos[i * 3 + 1] = this.pos[i * 3 + 1];
      this.prevPos[i * 3 + 2] = this.pos[i * 3 + 2];
      this.life[i] -= dt;

      // states that just need timers
      if (st === MISSILE_STATE.HIT || st === MISSILE_STATE.MISS || st === MISSILE_STATE.TIMEOUT) {
        if (fsm.timeInState >= this.explodeTimer[i] + 0.05) fsm.fire(MISSILE_EVENT.DETONATE, this._ctx(i));
        continue;
      }
      if (st === MISSILE_STATE.EXPLODE) {
        if (fsm.timeInState >= 0.05) fsm.fire(MISSILE_EVENT.DONE, this._ctx(i));
        continue;
      }
      if (this.life[i] <= 0) { fsm.fire(MISSILE_EVENT.LIFE_OVER, this._ctx(i)); continue; }

      // flight (BOOST / GUIDE / PROXIMITY all fly; only GUIDance differs)
      const px = this.pos[i * 3], py = this.pos[i * 3 + 1], pz = this.pos[i * 3 + 2];
      let vx = this.vel[i * 3], vy = this.vel[i * 3 + 1], vz = this.vel[i * 3 + 2];
      let speed = Math.sqrt(vx * vx + vy * vy + vz * vz);

      // motor: BOOST burns hard, GUIDE sustains, PROXIMITY coasts
      let acc = 0;
      if (st === MISSILE_STATE.BOOST) {
        acc = T.BOOST_ACCEL;
        if (fsm.timeInState >= T.BOOST_TIME) fsm.fire(MISSILE_EVENT.MOTOR_DONE, this._ctx(i));
      } else if (st === MISSILE_STATE.GUIDE) {
        acc = T.BOOST_ACCEL * 0.25;
      }

      // guidance (GUIDE + PROXIMITY): steer toward lead point (PN-flavored)
      let steerX = vx / speed, steerY = vy / speed, steerZ = vz / speed;
      const tid = this.targetId[i];
      const hasTarget = tid >= 0 && ents.isAlive(tid);
      if (this.decoyedTimer[i] > 0) {
        this.decoyedTimer[i] -= dt;
        steerX = this.flareX[i] - px; steerY = this.flareY[i] - py; steerZ = this.flareZ[i] - pz;
      } else if (hasTarget && st !== MISSILE_STATE.BOOST) {
        const tx = ents.pos[tid * 3], ty = ents.pos[tid * 3 + 1], tz = ents.pos[tid * 3 + 2];
        const tvx = ents.vel[tid * 3], tvy = ents.vel[tid * 3 + 1], tvz = ents.vel[tid * 3 + 2];
        const rx = tx - px, ry = ty - py, rz = tz - pz;
        const dist = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
        // closing rate (positive = closing): (v_missile - v_target) . losDir
        const closing = ((vx - tvx) * rx + (vy - tvy) * ry + (vz - tvz) * rz) / dist;
        const tGo = dist / Math.max(closing, 60);
        // lead prediction (PRD: "Proportional Navigation + lead prediction")
        const ax = this._aim;
        ax[0] = tx + tvx * tGo - px; ax[1] = ty + tvy * tGo - py; ax[2] = tz + tvz * tGo - pz;

        // flare seduction (Task 1.4: "flares break lock"): while countermeasures burn inside
        // DECOY_RANGE the seeker chases the flare source instead of the jet - it can never
        // reach fuse range of the jet while seduced (the jet itself sits inside the flare
        // sphere, so seduction always starts well before fuse range). The FSM DECOYED event
        // (GUIDE/PROXIMITY -> MISS) fires on the probabilistic roll and resolves the missile.
        let seduced = false;
        if (this.hooks.flareActive && this.hooks.flareActive(tid, ax)) {
          const dx2 = ax[0] - px, dy2 = ax[1] - py, dz2 = ax[2] - pz;
          if (dx2 * dx2 + dy2 * dy2 + dz2 * dz2 < T.DECOY_RANGE * T.DECOY_RANGE) {
            steerX = dx2; steerY = dy2; steerZ = dz2;
            seduced = true;
            if (this.rng() < T.DECOY_PROB * dt) {
              this.flareX[i] = ax[0]; this.flareY[i] = ax[1]; this.flareZ[i] = ax[2];
              this.decoyedTimer[i] = 1.5;
              fsm.fire(MISSILE_EVENT.DECOYED, this._ctx(i));
            }
          }
        }
        if (!seduced) {
          const al = Math.sqrt(ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2]) || 1;
          steerX = ax[0] / al; steerY = ax[1] / al; steerZ = ax[2] / al;

          // proximity fuse (PRD: 8 m) - only while the seeker tracks the jet
          if (st === MISSILE_STATE.GUIDE && dist < T.FUSE_RANGE + ents.radius[tid]) {
            fsm.fire(MISSILE_EVENT.FUSE_IN, this._ctx(i));
          }
          if (st === MISSILE_STATE.PROXIMITY) {
            if (dist < T.FUSE_RANGE + ents.radius[tid]) {
              fsm.fire(MISSILE_EVENT.CONTACT, this._ctx(i)); // HIT
            } else if (closing < -5 || fsm.timeInState > T.FUSE_WINDOW) {
              fsm.fire(MISSILE_EVENT.OUT_OF_CHASE, this._ctx(i)); // MISS
            }
          }
        }
      }

      // normalize steer to a unit direction (flare/countermeasure steering yields a raw
      // offset vector; a non-unit steer would corrupt the velocity magnitude below)
      const steerLen = Math.sqrt(steerX * steerX + steerY * steerY + steerZ * steerZ) || 1;
      steerX /= steerLen; steerY /= steerLen; steerZ /= steerLen;

      // integrate: turn current velocity toward the steer direction at TURN_RATE, plus accel
      const maxTurn = T.TURN_RATE * dt;
      const curX = vx / speed, curY = vy / speed, curZ = vz / speed;
      let dot = curX * steerX + curY * steerY + curZ * steerZ;
      if (dot > 1) dot = 1; if (dot < -1) dot = -1;
      const ang = Math.acos(dot);
      let ndx, ndy, ndz;
      if (ang < 1e-5 || ang <= maxTurn) {
        ndx = steerX; ndy = steerY; ndz = steerZ;
      } else {
        const t = maxTurn / ang;
        // slerp on the great circle between current and desired (unit vectors)
        const a = Math.sin((1 - t) * ang) / Math.sin(ang);
        const b = Math.sin(t * ang) / Math.sin(ang);
        ndx = a * curX + b * steerX; ndy = a * curY + b * steerY; ndz = a * curZ + b * steerZ;
        const nl = Math.sqrt(ndx * ndx + ndy * ndy + ndz * ndz) || 1;
        ndx /= nl; ndy /= nl; ndz /= nl;
      }
      speed = Math.min(T.MAX_SPEED, speed + acc * dt);
      if (st === MISSILE_STATE.PROXIMITY) speed = Math.max(200, speed - 40 * dt); // motor burnt
      this.vel[i * 3] = ndx * speed; this.vel[i * 3 + 1] = ndy * speed; this.vel[i * 3 + 2] = ndz * speed;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.yaw[i] = Math.atan2(ndx, -ndz);
      this.pitch[i] = Math.asin(Math.max(-1, Math.min(1, ndy)));
      if (trailFn && (st === MISSILE_STATE.BOOST || st === MISSILE_STATE.GUIDE)) {
        trailFn(px, py, pz);
      }
    }
  }

  activeCount() { return this.pool.active; }
}
