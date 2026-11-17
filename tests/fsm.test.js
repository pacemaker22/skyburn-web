// Skyburn Phase 1 - FSM tests (PRD AC: "FSM tests: missile cannot GUIDE->SPAWN").
// Covers: the shared FSM engine semantics (transition tables, pure guards, onEnter/onExit),
// the PRD Missile FSM lifecycle + GUIDE->SPAWN invariant, the PRD Weapons Lock table
// (IDLE->LOCKING 1.2s->LOCKED->FIRING->RELOADING, flare/lost->IDLE), and the Enemy AI table.

import test from 'node:test';
import assert from 'node:assert/strict';
import { FSMTable, FSM } from '../src/ai/fsm.js';
import {
  buildMissileTable, MissileSystem, MISSILE_STATE, MISSILE_EVENT, MISSILE_STATE_NAMES,
} from '../src/combat/missiles.js';
import {
  buildLockTable, LockSystem, LOCK_STATE, LOCK_EVENT, LOCK_STATE_NAMES, LOCK_TUNING,
} from '../src/combat/lockon.js';
import { buildAITable, AI_STATE, AI_EVENT } from '../src/ai/enemy.js';
import { WorldEntities, ENT_TYPE, TEAM } from '../src/combat/entities.js';

// ---- shared FSM engine ----

test('FSM engine: unknown event keeps state, guard-false keeps state, actions fire in order', () => {
  const S = { A: 0, B: 1, COUNT: 2 };
  const E = { GO: 0, UNUSED: 1, YEA: 2, COUNT: 3 };
  const t = new FSMTable(S.COUNT, E.COUNT, ['A', 'B'], ['GO', 'UNUSED', 'YEA']);
  const order = [];
  t.onExit[S.A] = () => order.push('exitA');
  t.onEnter[S.B] = () => order.push('enterB');
  t.add(S.A, E.GO, S.B, (ctx) => ctx.allow, (ctx) => order.push('action:' + ctx.tag));
  t.add(S.A, E.YEA, S.B, () => true, () => order.push('never'));
  const f = new FSM(t, S.A, { allow: false, tag: 'x' });
  assert.equal(f.fire(E.GO), false, 'guard false -> no transition');
  assert.equal(f.state, S.A);
  assert.equal(f.fire(E.UNUSED), false, 'event with no transition -> no change');
  assert.equal(f.fire(9), false, 'out-of-range event id -> no change');
  assert.equal(f.fire(E.YEA), true, 'always-true guard -> transition');
  assert.equal(f.state, S.B);
  assert.deepEqual(order, ['exitA', 'never', 'enterB'], 'exit -> action -> enter order');
  assert.equal(f.timeInState, 0, 'state time resets on transition');
  f.tick(0.5);
  assert.equal(f.timeInState, 0.5);
  f.tick(0.25);
  assert.equal(f.timeInState, 0.75);
});

test('FSMTable: duplicate transitions and forbidden pairs are rejected at build time', () => {
  const S = { A: 0, B: 1, C: 2, COUNT: 3 };
  const E = { X: 0, Y: 1, COUNT: 2 };
  const t = new FSMTable(S.COUNT, E.COUNT, ['A', 'B', 'C'], ['X', 'Y']);
  t.add(S.A, E.X, S.B, null, null);
  assert.throws(() => t.add(S.A, E.X, S.C), /duplicate/, 'duplicate (from,event) rejected');
  t.validate([[S.A, S.C]]); // A->B is fine, forbidden pair is A->C (absent)
  t.add(S.B, E.Y, S.C, null, null);
  assert.throws(() => t.validate([[S.B, S.C]]), /forbidden/, 'present forbidden pair throws');
});

// ---- Missile FSM (PRD: SPAWN -> BOOST -> GUIDE -> PROXIMITY -> HIT/MISS/TIMEOUT ->
// EXPLODE -> RECYCLE; invariant GUIDE cannot -> SPAWN) ----

function missileNames() { return MISSILE_STATE_NAMES; }

test('missile FSM table is structurally valid and forbids GUIDE -> SPAWN (PRD invariant)', () => {
  const t = buildMissileTable(); // throws if the forbidden pair exists
  assert.ok(t, 'table builds + validates');
  assert.equal(t.lookup(MISSILE_STATE.GUIDE, MISSILE_EVENT.FREED), null,
    'no path GUIDE -> SPAWN (FREED only fires from RECYCLE)');
  // and even a hand-built attempt to add it is impossible via the validated builder:
  assert.throws(() => {
    const S = MISSILE_STATE, E = MISSILE_EVENT;
    const bad = new FSMTable(S.COUNT, E.COUNT, missileNames(), undefined);
    bad.add(S.GUIDE, E.MOTOR_DONE, S.SPAWN, null, null);
    bad.validate([[S.GUIDE, S.SPAWN]]);
  }, /forbidden/, 'GUIDE->SPAWN is a forbidden pair');
});

test('missile FSM: full lifecycle to RECYCLE and back to SPAWN', () => {
  const sys = new MissileSystem(7, {});
  const ctx = { onExplode() {}, onFreed() {} };
  const fsm = sys.fsms[0];
  // initial state is SPAWN after construction
  assert.equal(fsm.state, MISSILE_STATE.SPAWN);
  assert.equal(fsm.fire(MISSILE_EVENT.LAUNCH, ctx), true);
  assert.equal(fsm.state, MISSILE_STATE.BOOST);
  fsm.tick(1.3); // past BOOST_TIME
  assert.equal(fsm.fire(MISSILE_EVENT.MOTOR_DONE, ctx), true);
  assert.equal(fsm.state, MISSILE_STATE.GUIDE);
  assert.equal(fsm.fire(MISSILE_EVENT.FUSE_IN, ctx), true);
  assert.equal(fsm.state, MISSILE_STATE.PROXIMITY);
  assert.equal(fsm.fire(MISSILE_EVENT.CONTACT, ctx), true, 'proximity contact -> HIT');
  assert.equal(fsm.state, MISSILE_STATE.HIT);
  assert.equal(fsm.fire(MISSILE_EVENT.DETONATE, ctx), true);
  assert.equal(fsm.state, MISSILE_STATE.EXPLODE);
  assert.equal(fsm.fire(MISSILE_EVENT.DONE, ctx), true);
  assert.equal(fsm.state, MISSILE_STATE.RECYCLE);
  assert.equal(fsm.fire(MISSILE_EVENT.FREED, ctx), true, 'RECYCLE -> SPAWN (pool reuse)');
  assert.equal(fsm.state, MISSILE_STATE.SPAWN);
  // GUIDE must NOT be able to jump straight back to SPAWN even mid-lifecycle
  fsm.fire(MISSILE_EVENT.LAUNCH, ctx);
  fsm.fire(MISSILE_EVENT.MOTOR_DONE, ctx);
  assert.equal(fsm.state, MISSILE_STATE.GUIDE);
  assert.equal(fsm.fire(MISSILE_EVENT.FREED, ctx), false, 'GUIDE -> SPAWN rejected at runtime');
  assert.equal(fsm.state, MISSILE_STATE.GUIDE, 'still in GUIDE');
});

test('missile FSM: TIMEOUT reachable from BOOST/GUIDE/PROXIMITY; MISS via decoy', () => {
  const sys = new MissileSystem(7, {});
  const ctx = { onExplode() {}, onFreed() {} };
  const f1 = sys.fsms[1];
  f1.fire(MISSILE_EVENT.LAUNCH, ctx);
  assert.equal(f1.fire(MISSILE_EVENT.LIFE_OVER, ctx), true, 'BOOST -> TIMEOUT');
  assert.equal(f1.state, MISSILE_STATE.TIMEOUT);
  const f2 = sys.fsms[2];
  f2.fire(MISSILE_EVENT.LAUNCH, ctx);
  f2.fire(MISSILE_EVENT.MOTOR_DONE, ctx);
  assert.equal(f2.fire(MISSILE_EVENT.DECOYED, ctx), true, 'GUIDE -> MISS via flare decoy');
  assert.equal(f2.state, MISSILE_STATE.MISS);
  const f3 = sys.fsms[3];
  f3.fire(MISSILE_EVENT.LAUNCH, ctx);
  f3.fire(MISSILE_EVENT.MOTOR_DONE, ctx);
  f3.fire(MISSILE_EVENT.FUSE_IN, ctx);
  assert.equal(f3.fire(MISSILE_EVENT.OUT_OF_CHASE, ctx), true, 'PROXIMITY -> MISS');
  assert.equal(f3.state, MISSILE_STATE.MISS);
});

// ---- Weapons Lock FSM (PRD FSM Example Table, verbatim paths) ----

test('lock FSM table matches the PRD example table exactly', () => {
  const S = LOCK_STATE, E = LOCK_EVENT;
  const t = buildLockTable();
  const expect = [
    [S.IDLE, E.TARGET_IN_RANGE, S.LOCKING],
    [S.LOCKING, E.TIMER_DONE, S.LOCKED],
    [S.LOCKING, E.TARGET_LOST, S.IDLE],
    [S.LOCKING, E.FLARE, S.IDLE],
    [S.LOCKED, E.FIRE, S.FIRING],
    [S.FIRING, E.MISSILE_SPAWNED, S.RELOADING],
    [S.RELOADING, E.COOLDOWN_DONE, S.IDLE],
    [S.LOCKED, E.TARGET_LOST, S.IDLE],
    [S.LOCKED, E.FLARE, S.IDLE],
  ];
  for (const [from, ev, to] of expect) {
    const entry = t.lookup(from, ev);
    assert.ok(entry, 'transition ' + LOCK_STATE_NAMES[from] + ' --ev--> exists');
    assert.equal(entry.to, to,
      LOCK_STATE_NAMES[from] + ' -> ' + LOCK_STATE_NAMES[to]);
  }
  // no other transitions exist
  assert.equal(t.entries.length, expect.length, 'table is exactly the PRD set');
});

test('lock system: 1.2 s seek, solid lock, release-to-fire, 0.8 s reload, flare breaks', () => {
  const calls = [];
  const lock = new LockSystem({
    onEnterLocking: () => calls.push('locking'),
    onLocked: () => calls.push('locked'),
    onLost: () => calls.push('lost'),
    onDecoyed: () => calls.push('decoyed'),
    onFire: () => calls.push('fire'),
    onSeekBeep: () => calls.push('beep'),
  });
  const dt = 1 / 120;
  // no target: stays IDLE
  lock.update(dt, false, false, false, true);
  assert.equal(lock.state, LOCK_STATE.IDLE);
  // target in range + hold -> LOCKING (timer beep starts on the next LOCKING tick)
  lock.update(dt, true, false, true, true);
  assert.equal(lock.state, LOCK_STATE.LOCKING);
  assert.ok(calls.includes('locking'));
  lock.update(dt, true, false, true, true);
  assert.ok(calls.includes('beep'), 'seek beeps start');
  // hold for exactly LOCK_TIME -> LOCKED (solid tone)
  const steps = Math.round(LOCK_TUNING.LOCK_TIME / dt);
  for (let i = 0; i < steps; i++) lock.update(dt, true, false, true, true);
  assert.equal(lock.state, LOCK_STATE.LOCKED, 'locked after ' + LOCK_TUNING.LOCK_TIME + ' s');
  assert.ok(calls.includes('locked'));
  // releasing the button fires (needs ammo)
  const fired = lock.update(dt, true, false, false, true);
  assert.equal(fired, true, 'release fires');
  assert.equal(lock.state, LOCK_STATE.FIRING, 'FIRING right after release');
  lock.update(dt, true, false, false, true); // next tick: missile spawned -> reloading
  assert.equal(lock.state, LOCK_STATE.RELOADING, 'FIRING advances to RELOADING');
  assert.ok(Math.abs(lock.cooldown - LOCK_TUNING.RELOAD_TIME) < 1e-9, 'reload 0.8 s set');
  // reload completes -> IDLE
  for (let i = 0; i < steps; i++) lock.update(dt, false, false, false, true);
  assert.equal(lock.state, LOCK_STATE.IDLE, 'ready after cooldown');
  // flare while locked (re-lock first) breaks the lock. inRange drops on the flare tick:
  // after LOCKED -> IDLE the seeker would otherwise legally re-enter LOCKING the same tick.
  lock.update(dt, true, false, true, true);
  for (let i = 0; i < steps; i++) lock.update(dt, true, false, true, true);
  assert.equal(lock.state, LOCK_STATE.LOCKED);
  lock.update(dt, false, true, true, true); // flarePulse, target lost in the flare cloud
  assert.equal(lock.state, LOCK_STATE.IDLE, 'flare breaks lock');
  assert.ok(calls.includes('decoyed'));
  // lost target during LOCKING resets
  lock.update(dt, true, false, true, true);
  assert.equal(lock.state, LOCK_STATE.LOCKING);
  lock.update(dt, false, false, true, true);
  assert.equal(lock.state, LOCK_STATE.IDLE, 'target lost -> IDLE');
  // cannot fire without ammo even when locked + released
  lock.update(dt, true, false, true, true);
  for (let i = 0; i < steps; i++) lock.update(dt, true, false, true, true);
  assert.equal(lock.state, LOCK_STATE.LOCKED);
  const noAmmo = lock.update(dt, true, false, false, false);
  assert.equal(noAmmo, false, 'no ammo -> no fire request');
  assert.equal(lock.state, LOCK_STATE.LOCKED, 'stays locked without ammo');
});

// ---- Enemy AI FSM (Task 1.5: PATROL->ENGAGE->EVADE->ATTACK_RUN->RTB, DESTROYED terminal) ----

test('AI FSM table covers the PRD paths and DESTROYED is absorbing', () => {
  const t = buildAITable();
  const S = AI_STATE, E = AI_EVENT;
  const expect = [
    [S.PATROL, E.SPOTTED, S.ENGAGE],
    [S.ENGAGE, E.ALIGNED_GUN, S.ATTACK_RUN],
    [S.ENGAGE, E.THREAT, S.EVADE],
    [S.ENGAGE, E.RETREATED, S.RTB],
    [S.ATTACK_RUN, E.THREAT, S.EVADE],
    [S.ATTACK_RUN, E.OVERSHOOT, S.ENGAGE],
    [S.ATTACK_RUN, E.RETREATED, S.RTB],
    [S.EVADE, E.THREAT_GONE, S.ENGAGE],
    [S.RTB, E.SPOTTED, S.ENGAGE],
  ];
  for (const [from, ev, to] of expect) {
    const entry = t.lookup(from, ev);
    assert.ok(entry, 'transition exists from ' + from + ' via ' + ev);
    assert.equal(entry.to, to);
  }
  // DIED from every live state
  for (const s of [S.PATROL, S.ENGAGE, S.ATTACK_RUN, S.EVADE, S.RTB]) {
    assert.ok(t.lookup(s, E.DIED), 'DIED reachable from ' + s);
  }
  // DESTROYED has no outgoing transitions (absorbing)
  for (let ev = 0; ev < E.COUNT; ev++) {
    assert.equal(t.lookup(S.DESTROYED, ev), null, 'DESTROYED absorbs event ' + ev);
  }
});
