// Skyburn Phase 1 - Weapons lock FSM (Task 1.4) using the shared engine (src/ai/fsm.js).
// Table is EXACTLY the PRD FSM Example Table:
//   IDLE --(Target in range + Lock)--> LOCKING   (start timer beep)
//   LOCKING --(Timer complete)-->       LOCKED    (solid tone, HUD lock)
//   LOCKING --(Target lost / Flare)-->  IDLE      (reset timer)
//   LOCKED --(Fire)-->                  FIRING    (spawn missile, consume ammo)
//   FIRING --(Missile spawned)-->       RELOADING (cooldown 0.8 s)
//   RELOADING --(Cooldown done)-->      IDLE      (ready)
// plus the same TARGET_LOST / FLARE exits from LOCKED (a lock cannot survive a lost target).
// Lock time 1.2 s (Task 1.4). Fire semantics: HOLD to lock, RELEASE to fire (PRD controls:
// "Right Click Hold/Release = Lock/Fire Missile"). The ctx handed to fire() is the LockSystem
// itself; hook methods (onEnterLocking/onLocked/onLost/onDecoyed/onFire) live on the class.

import { FSMTable, FSM } from '../ai/fsm.js';

export const LOCK_STATE = { IDLE: 0, LOCKING: 1, LOCKED: 2, FIRING: 3, RELOADING: 4, COUNT: 5 };
export const LOCK_STATE_NAMES = ['IDLE', 'LOCKING', 'LOCKED', 'FIRING', 'RELOADING'];
export const LOCK_EVENT = {
  TARGET_IN_RANGE: 0, TARGET_LOST: 1, TIMER_DONE: 2, FIRE: 3,
  MISSILE_SPAWNED: 4, COOLDOWN_DONE: 5, FLARE: 6, COUNT: 7,
};
export const LOCK_EVENT_NAMES = ['TARGET_IN_RANGE', 'TARGET_LOST', 'TIMER_DONE', 'FIRE',
  'MISSILE_SPAWNED', 'COOLDOWN_DONE', 'FLARE'];

export const LOCK_TUNING = {
  LOCK_TIME: 1.2,        // s (Task 1.4)
  RELOAD_TIME: 0.8,      // s (PRD table)
  BEEP_INTERVAL: 0.16,   // s between seeking beeps while LOCKING
};

// Guards are pure functions (PRD: "pure guards"). Actions delegate to ctx hooks.
function gTrue() { return true; }

export function buildLockTable() {
  const S = LOCK_STATE, E = LOCK_EVENT;
  const t = new FSMTable(S.COUNT, E.COUNT, LOCK_STATE_NAMES, LOCK_EVENT_NAMES);
  t.add(S.IDLE, E.TARGET_IN_RANGE, S.LOCKING, gTrue, (c) => { c.timer = 0; c.onEnterLocking(); });
  t.add(S.LOCKING, E.TIMER_DONE, S.LOCKED, gTrue, (c) => { c.onLocked(); });
  t.add(S.LOCKING, E.TARGET_LOST, S.IDLE, gTrue, (c) => { c.timer = 0; c.onLost(); });
  t.add(S.LOCKING, E.FLARE, S.IDLE, gTrue, (c) => { c.timer = 0; c.onDecoyed(); });
  t.add(S.LOCKED, E.FIRE, S.FIRING, gTrue, (c) => { c.onFire(); });
  t.add(S.LOCKED, E.TARGET_LOST, S.IDLE, gTrue, (c) => { c.timer = 0; c.onLost(); });
  t.add(S.LOCKED, E.FLARE, S.IDLE, gTrue, (c) => { c.timer = 0; c.onDecoyed(); });
  t.add(S.FIRING, E.MISSILE_SPAWNED, S.RELOADING, gTrue,
    (c) => { c.cooldown = LOCK_TUNING.RELOAD_TIME; });
  t.add(S.RELOADING, E.COOLDOWN_DONE, S.IDLE, gTrue, gTrue);
  return t;
}

export class LockSystem {
  // deps: { onEnterLocking, onLocked, onLost, onDecoyed, onFire, onSeekBeep } - audio/HUD
  // hooks (preallocated object, never replaced).
  constructor(deps, initialState) {
    this.deps = deps;
    this.timer = 0;          // seconds accumulated in LOCKING
    this.cooldown = 0;       // RELOADING countdown
    this.beepTimer = 0;
    this.prevFireHeld = false;
    this.table = buildLockTable();
    this.fsm = new FSM(this.table,
      initialState === undefined ? LOCK_STATE.IDLE : initialState, this);
  }

  get state() { return this.fsm.state; }
  stateName() { return LOCK_STATE_NAMES[this.fsm.state]; }

  fire(event) { return this.fsm.fire(event, this); }

  // Per-tick update. Args: dt, inRange (target valid + inside cone+range), flarePulse (enemy
  // flare event this tick), fireHeld (lock/fire button), canArm (ammo available).
  // Returns fireRequest (true exactly once when a missile should be spawned).
  update(dt, inRange, flarePulse, fireHeld, canArm) {
    const E = LOCK_EVENT;
    let fireRequest = false;
    const st = this.fsm.state;

    if (flarePulse && (st === LOCK_STATE.LOCKING || st === LOCK_STATE.LOCKED)) {
      this.fire(E.FLARE);
    }

    switch (this.fsm.state) {
      case LOCK_STATE.IDLE:
        if (inRange) this.fire(E.TARGET_IN_RANGE);
        break;
      case LOCK_STATE.LOCKING:
        if (!inRange) { this.fire(E.TARGET_LOST); break; }
        this.timer += dt;
        this.beepTimer -= dt;
        // epsilon: 144 ticks of 1/120 s accumulate to 1.1999999999999997 in float64 -
        // holding exactly LOCK_TIME of sim time must still lock (1e-9 s is 1 microsecond)
        if (this.timer >= LOCK_TUNING.LOCK_TIME - 1e-9) { this.fire(E.TIMER_DONE); break; }
        if (this.beepTimer <= 0) {
          this.beepTimer = LOCK_TUNING.BEEP_INTERVAL;
          if (this.deps.onSeekBeep) this.deps.onSeekBeep();
        }
        break;
      case LOCK_STATE.LOCKED:
        if (!inRange) { this.fire(E.TARGET_LOST); break; }
        // HOLD to lock, RELEASE to fire (PRD controls table); needs ammo.
        if (this.prevFireHeld && !fireHeld && canArm) {
          this.fire(E.FIRE);
          if (this.fsm.state === LOCK_STATE.FIRING) fireRequest = true;
        }
        break;
      case LOCK_STATE.FIRING:
        // caller spawns the missile, then calls notifySpawned(); auto-advance as a safety net
        this.fire(E.MISSILE_SPAWNED);
        break;
      case LOCK_STATE.RELOADING:
        this.cooldown -= dt;
        if (this.cooldown <= 0) this.fire(E.COOLDOWN_DONE);
        break;
      default:
        break;
    }
    this.prevFireHeld = fireHeld;
    return fireRequest;
  }

  // Called by main right after the missile actually spawned (PRD: FIRING -> RELOADING).
  notifySpawned() {
    if (this.fsm.state === LOCK_STATE.FIRING) this.fire(LOCK_EVENT.MISSILE_SPAWNED);
  }

  // Enemy released flares while we had them locked (PRD: "flares break lock").
  targetFlared() {
    if (this.fsm.state === LOCK_STATE.LOCKING || this.fsm.state === LOCK_STATE.LOCKED) {
      this.fire(LOCK_EVENT.FLARE);
    }
  }

  targetLost() {
    if (this.fsm.state === LOCK_STATE.LOCKING || this.fsm.state === LOCK_STATE.LOCKED) {
      this.fire(LOCK_EVENT.TARGET_LOST);
    }
  }
}
// Hook shims (the FSM actions call these on ctx = this LockSystem).
LockSystem.prototype.onEnterLocking = function () { if (this.deps.onEnterLocking) this.deps.onEnterLocking(); };
LockSystem.prototype.onLocked = function () { if (this.deps.onLocked) this.deps.onLocked(); };
LockSystem.prototype.onLost = function () { if (this.deps.onLost) this.deps.onLost(); };
LockSystem.prototype.onDecoyed = function () { if (this.deps.onDecoyed) this.deps.onDecoyed(); };
LockSystem.prototype.onFire = function () { if (this.deps.onFire) this.deps.onFire(); };
