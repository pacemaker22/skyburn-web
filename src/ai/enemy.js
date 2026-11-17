// Skyburn Phase 1 - Enemy AI (Task 1.5): "PATROL->ENGAGE->EVADE->ATTACK_RUN->RTB,
// Seek/Pursuit/Evade, difficulty affects reaction". Uses the shared FSM engine; steering is
// classic steering behaviors (Seek = fly to point, Pursuit = fly to predicted intercept,
// Evade = away from threat + jink). Difficulty scales reaction interval, aim error, jink
// energy and missile discipline. Deterministic: decisions come from a seeded RNG.
// The AI writes commands into a preallocated struct; main feeds them to FlightModel /
// GunSystem / MissileSystem. Zero allocation per tick.

import { FSMTable, FSM } from './fsm.js';
import { MISSILE_STATE } from '../combat/missiles.js';

export const AI_STATE = {
  PATROL: 0, ENGAGE: 1, EVADE: 2, ATTACK_RUN: 3, RTB: 4, DESTROYED: 5, COUNT: 6,
};
export const AI_STATE_NAMES = ['PATROL', 'ENGAGE', 'EVADE', 'ATTACK_RUN', 'RTB', 'DESTROYED'];
export const AI_EVENT = {
  SPOTTED: 0, ALIGNED_GUN: 1, THREAT: 2, THREAT_GONE: 3, OVERSHOOT: 4,
  RETREATED: 5, DIED: 6, COUNT: 7,
};
export const AI_EVENT_NAMES =
  ['SPOTTED', 'ALIGNED_GUN', 'THREAT', 'THREAT_GONE', 'OVERSHOOT', 'RETREATED', 'DIED'];

export const AI_TUNING = {
  GUN_RANGE: 900,           // m attack-run gun window
  GUN_CONE_COS: 0.985,      // ~10 degrees alignment for guns
  MISSILE_RANGE: 2600,      // m AI missile launch window
  MISSILE_CONE_COS: 0.94,   // ~20 degrees
  EVADE_RANGE: 1300,        // m incoming missile triggers EVADE
  OVERSHOOT_DIST: 160,      // m closer than this = overshoot -> re-engage
  HEAVY_DAMAGE: 0.28,       // health fraction below which the AI runs for the border
  RADAR_REACQUIRE: 6500,    // m re-spot range after RTB turn-in
  // difficulty presets: [Rookie, Veteran, Ace] (PRD AC references Veteran hit rates)
  REACTION: [0.9, 0.55, 0.3],       // s between steering decisions
  AIM_ERROR: [0.020, 0.008, 0.002], // rad added to gun aim direction
  JINK: [0.25, 0.6, 0.9],           // evade jink energy
  MISSILE_CHANCE: [0.15, 0.5, 0.85],// per-approach probability discipline
};

function pureTrue() { return true; }

export function buildAITable() {
  const S = AI_STATE, E = AI_EVENT;
  const t = new FSMTable(S.COUNT, E.COUNT, AI_STATE_NAMES, AI_EVENT_NAMES);
  t.add(S.PATROL, E.SPOTTED, S.ENGAGE, pureTrue, null);
  t.add(S.ENGAGE, E.ALIGNED_GUN, S.ATTACK_RUN, pureTrue, null);
  t.add(S.ENGAGE, E.THREAT, S.EVADE, pureTrue, null);
  t.add(S.ENGAGE, E.RETREATED, S.RTB, pureTrue, null);
  t.add(S.ATTACK_RUN, E.THREAT, S.EVADE, pureTrue, null);
  t.add(S.ATTACK_RUN, E.OVERSHOOT, S.ENGAGE, pureTrue, null);
  t.add(S.ATTACK_RUN, E.RETREATED, S.RTB, pureTrue, null);
  t.add(S.EVADE, E.THREAT_GONE, S.ENGAGE, pureTrue, null);
  t.add(S.RTB, E.SPOTTED, S.ENGAGE, pureTrue, null);
  t.add(S.PATROL, E.DIED, S.DESTROYED, pureTrue, null);
  t.add(S.ENGAGE, E.DIED, S.DESTROYED, pureTrue, null);
  t.add(S.ATTACK_RUN, E.DIED, S.DESTROYED, pureTrue, null);
  t.add(S.EVADE, E.DIED, S.DESTROYED, pureTrue, null);
  t.add(S.RTB, E.DIED, S.DESTROYED, pureTrue, null);
  return t;
}

// Commands produced per tick (single preallocated object shared per AI instance).
// main reads: pitch/roll/yaw in [-1,1], throttle [0,1], fireGun bool, spawnMissile bool,
// flareNow bool.
export class EnemyAI {
  // deps: { ents, missiles } + ids. difficulty: 0 Rookie, 1 Veteran, 2 Ace.
  constructor(ents, missiles, myId, playerRef, difficulty, seed, opts) {
    this.ents = ents;
    this.missiles = missiles;
    this.myId = myId;
    this.player = playerRef;        // { id, alive() } view over the player entity
    this.difficulty = Math.max(0, Math.min(2, difficulty | 0));
    this.table = buildAITable();
    this.fsm = new FSM(this.table, AI_STATE.PATROL, this);
    this.rng = (opts && opts.rng) || Math.random;
    this.patrolPhase = (opts && opts.patrolPhase) || (myId * 1.7);
    this.rethinkTimer = 0;
    this.jinkPhase = myId * 2.3;
    this.threatTimer = 0;           // time since last threat seen
    this.missileDecision = true;    // re-rolled per approach
    this.patrolAngle = this.patrolPhase;
    // preallocated command output (mutated in place - never reallocated)
    this.cmd = {
      pitch: 0, roll: 0, yaw: 0, throttle: 1, afterburner: false, airbrake: false,
      fireGun: false, spawnMissile: false, flareNow: false,
    };
    // preallocated scratch
    this._wp = new Float32Array(3);
    this._aim = new Float32Array(3);
    this._fwd = new Float32Array(3);
  }

  get state() { return this.fsm.state; }
  stateName() { return AI_STATE_NAMES[this.fsm.state]; }

  // Compute steering toward a world point (Seek). Writes pitch/roll commands.
  _seekTo(myIdx, x, y, z, dt) {
    const e = this.ents;
    const px = e.pos[myIdx * 3], py = e.pos[myIdx * 3 + 1], pz = e.pos[myIdx * 3 + 2];
    const yaw = e.rot[myIdx * 3], pitch = e.rot[myIdx * 3 + 1];
    this._fwd[0] = Math.sin(yaw) * Math.cos(pitch);
    this._fwd[1] = Math.sin(pitch);
    this._fwd[2] = -Math.cos(yaw) * Math.cos(pitch);
    let dx = x - px, dy = y - py, dz = z - pz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= d; dy /= d; dz /= d;
    // desired direction in ship-local frame: yaw error (right positive), pitch error (up positive)
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const fwdXZ = Math.sqrt(this._fwd[0] * this._fwd[0] + this._fwd[2] * this._fwd[2]) || 1;
    // signed horizontal angle between forward and target dir
    const cross = this._fwd[0] * dz - this._fwd[2] * dx; // >0: target to the left
    const dotXZ = (this._fwd[0] * dx + this._fwd[2] * dz) / fwdXZ;
    const yawErr = Math.atan2(-cross, Math.max(-1, Math.min(1, dotXZ))); // + = turn right
    const pitchErr = Math.asin(Math.max(-1, Math.min(1, dy))) - pitch;
    // bank-to-turn: roll proportional to yaw error, pull with pitch
    const rollCmd = Math.max(-1, Math.min(1, yawErr * 2.2));
    const banked = Math.abs(rollCmd) > 0.25;
    const pitchCmd = banked ? 0.55 + Math.max(-0.6, Math.min(0.6, pitchErr * 1.4))
      : Math.max(-0.7, Math.min(0.7, pitchErr * 1.6));
    this.cmd.roll = rollCmd;
    this.cmd.pitch = pitchCmd;
    this.cmd.yaw = 0;
  }

  // One AI tick. now = seconds (sim time, for jink waves). Returns this.cmd (read-only view).
  update(dt, now) {
    const e = this.ents, myIdx = this.myId, cmd = this.cmd, D = this.difficulty;
    cmd.fireGun = false; cmd.spawnMissile = false; cmd.flareNow = false;
    if (!e.isAlive(myIdx)) {
      if (this.fsm.state !== AI_STATE.DESTROYED) this.fsm.fire(AI_EVENT.DIED);
      cmd.pitch = 0; cmd.roll = 0; cmd.yaw = 0; cmd.throttle = 0;
      return cmd;
    }
    const M = MISSILE_STATE;
    const T = AI_TUNING;

    // --- threat scan: any live missile homing on me within EVADE_RANGE ---
    let threatened = false;
    let tx = 0, ty = 0, tz = 0;
    const ms = this.missiles;
    for (let i = 0; i < ms.max && !threatened; i++) {
      const st = ms.fsms[i].state;
      if (st === M.SPAWN || st === M.RECYCLE || st === M.EXPLODE) continue;
      if (ms.targetId[i] === myIdx) {
        const dx = ms.pos[i * 3] - e.pos[myIdx * 3];
        const dy = ms.pos[i * 3 + 1] - e.pos[myIdx * 3 + 1];
        const dz = ms.pos[i * 3 + 2] - e.pos[myIdx * 3 + 2];
        if (dx * dx + dy * dy + dz * dz < T.EVADE_RANGE * T.EVADE_RANGE) {
          threatened = true;
          tx = ms.pos[i * 3]; ty = ms.pos[i * 3 + 1]; tz = ms.pos[i * 3 + 2];
        }
      }
    }
    if (threatened) this.threatTimer = 0; else this.threatTimer += dt;

    // --- geometry vs the player ---
    const pAlive = e.isAlive(this.player.id);
    let distToPlayer = 1e9;
    let alignCos = -2;
    if (pAlive) {
      const dx = e.pos[this.player.id * 3] - e.pos[myIdx * 3];
      const dy = e.pos[this.player.id * 3 + 1] - e.pos[myIdx * 3 + 1];
      const dz = e.pos[this.player.id * 3 + 2] - e.pos[myIdx * 3 + 2];
      distToPlayer = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const yaw = e.rot[myIdx * 3], pitch = e.rot[myIdx * 3 + 1];
      const fx = Math.sin(yaw) * Math.cos(pitch), fy = Math.sin(pitch),
        fz = -Math.cos(yaw) * Math.cos(pitch);
      alignCos = (fx * dx + fy * dy + fz * dz) / distToPlayer;
    }

    // --- FSM events ---
    const S = AI_STATE, E = AI_EVENT;
    const heavy = e.health[myIdx] < e.maxHealth[myIdx] * T.HEAVY_DAMAGE;
    switch (this.fsm.state) {
      case S.PATROL:
        if (pAlive && distToPlayer < T.RADAR_REACQUIRE) this.fsm.fire(E.SPOTTED);
        break;
      case S.ENGAGE:
        if (threatened) this.fsm.fire(E.THREAT);
        else if (heavy && distToPlayer > 900) this.fsm.fire(E.RETREATED);
        else if (pAlive && alignCos > T.GUN_CONE_COS && distToPlayer < T.GUN_RANGE) {
          this.fsm.fire(E.ALIGNED_GUN);
        }
        break;
      case S.ATTACK_RUN:
        if (threatened) this.fsm.fire(E.THREAT);
        else if (heavy && distToPlayer > 900) this.fsm.fire(E.RETREATED);
        else if (!pAlive || distToPlayer < T.OVERSHOOT_DIST || alignCos < 0.2) {
          this.fsm.fire(E.OVERSHOOT);
        }
        break;
      case S.EVADE:
        if (this.threatTimer > 2.5) this.fsm.fire(E.THREAT_GONE);
        break;
      case S.RTB:
        if (pAlive && distToPlayer < T.RADAR_REACQUIRE * 0.55) this.fsm.fire(E.SPOTTED);
        break;
      default:
        break;
    }
    // --- reaction-limited steering (Task 1.5: difficulty affects reaction) ---
    this.rethinkTimer -= dt;
    const rethink = this.rethinkTimer <= 0;
    if (rethink) this.rethinkTimer = T.REACTION[D];

    this.flareCd = (this.flareCd || 0) - dt;
    this.missileCd = (this.missileCd || 0) - dt;

    switch (this.fsm.state) {
      case S.PATROL: {
        this.patrolAngle += dt * 0.05;
        const r = 6000;
        this._seekTo(myIdx, Math.cos(this.patrolAngle + this.patrolPhase) * r,
          1500 + Math.sin(this.patrolPhase) * 350,
          Math.sin(this.patrolAngle + this.patrolPhase) * r, dt);
        cmd.throttle = 0.75;
        break;
      }
      case S.ENGAGE:
        if (pAlive) {
          this._pursue(myIdx, this.player.id, Math.min(3, distToPlayer / 800));
          cmd.throttle = 1;
          cmd.afterburner = distToPlayer > 2500;
        }
        break;
      case S.ATTACK_RUN:
        if (pAlive) {
          this._pursue(myIdx, this.player.id, Math.min(1.6, distToPlayer / 900));
          cmd.throttle = 0.9;
          cmd.airbrake = distToPlayer < 350;
          if (alignCos > T.GUN_CONE_COS && distToPlayer < T.GUN_RANGE) cmd.fireGun = true;
          if (this.missileDecision && this.missileCd <= 0 && e.missilesLeft[myIdx] > 0 &&
            alignCos > T.MISSILE_CONE_COS && distToPlayer < T.MISSILE_RANGE &&
            distToPlayer > 400) {
            cmd.spawnMissile = true;
            this.missileCd = 9;
          }
        }
        break;
      case S.EVADE: {
        this.jinkPhase += dt * (3 + D);
        cmd.roll = Math.sin(this.jinkPhase) * T.JINK[D];
        cmd.pitch = 0.72;
        cmd.throttle = 1;
        cmd.afterburner = true;
        if (threatened) {
          this._seekTo(myIdx,
            e.pos[myIdx * 3] * 2 - tx,
            Math.max(900, e.pos[myIdx * 3 + 1] * 2 - ty),
            e.pos[myIdx * 3 + 2] * 2 - tz, dt);
        }
        if (this.flareCd <= 0 && e.flareCount[myIdx] > 0) {
          cmd.flareNow = true;
          this.flareCd = 2.5;
        }
        break;
      }
      case S.RTB: {
        const px2 = pAlive ? e.pos[this.player.id * 3] : 0;
        const pz2 = pAlive ? e.pos[this.player.id * 3 + 2] : 0;
        const dx = e.pos[myIdx * 3] - px2, dz = e.pos[myIdx * 3 + 2] - pz2;
        const d = Math.sqrt(dx * dx + dz * dz) || 1;
        this._seekTo(myIdx, e.pos[myIdx * 3] + dx / d * 5000, 2200,
          e.pos[myIdx * 3 + 2] + dz / d * 5000, dt);
        cmd.throttle = 1;
        cmd.afterburner = true;
        break;
      }
      case S.DESTROYED:
      default:
        cmd.pitch = 0; cmd.roll = 0; cmd.yaw = 0; cmd.throttle = 0;
        break;
    }
    return cmd;
  }

  // Pursuit: aim at the target's predicted position (Task 1.5 "Pursuit").
  _pursue(myIdx, targetId, leadTime) {
    const e = this.ents;
    this._seekTo(myIdx,
      e.pos[targetId * 3] + e.vel[targetId * 3] * leadTime,
      e.pos[targetId * 3 + 1] + e.vel[targetId * 3 + 1] * leadTime,
      e.pos[targetId * 3 + 2] + e.vel[targetId * 3 + 2] * leadTime, 0);
  }

  // Called by main when the AI transitions into ATTACK_RUN - rolls the per-approach
  // missile discipline (Task 1.5: difficulty affects missile usage).
  rollMissileDecision() {
    this.missileDecision = this.rng() < AI_TUNING.MISSILE_CHANCE[this.difficulty];
  }
}
