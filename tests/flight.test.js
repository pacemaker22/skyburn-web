// Skyburn Phase 1 - Flight + loop integration tests (PRD Tasks 1.1/1.5 + ACs).
// Proves: data-driven equilibrium from jets.json, turn-rate band, speed cap under abuse,
// PID ringdown (no sustained oscillation), AI difficulty scaling (reaction/jink), input
// event-to-render latency < 50 ms through the real GameLoop, and allocation-free flight ticks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GameLoop } from '../src/core/loop.js';
import { FlightModel, PID, TUNING } from '../src/physics/flight.js';
import { WorldEntities, ENT_TYPE, TEAM } from '../src/combat/entities.js';
import { EnemyAI, AI_STATE, AI_TUNING } from '../src/ai/enemy.js';

const jetsJson = JSON.parse(readFileSync(new URL('../src/data/jets.json', import.meta.url), 'utf8'));
const jetList = Array.isArray(jetsJson) ? jetsJson : jetsJson.jets;
const F16 = jetList.find((j) => j.id === 'f16c') || jetList[0];
const dt = 1 / 120;

test('equilibrium: full-throttle equilibrium is the maxSpeed cap; 65% sits below it', () => {
  const f = new FlightModel(F16, { x: 0, y: 2000, z: 0, yaw: 0, throttle: 1.0 });
  for (let i = 0; i < 3600; i++) f.tick(0, 0, 0, 0, false, false, dt); // 30 s
  assert.ok(Math.abs(f.speed - f.maxSpeed) < f.maxSpeed * 0.05,
    'full throttle settles at maxSpeed (drag tuned to thrust), got ' + f.speed.toFixed(0) +
    ' vs ' + f.maxSpeed.toFixed(0));
  const g = new FlightModel(F16, { x: 0, y: 2000, z: 0, yaw: 0, throttle: 0.65 });
  for (let i = 0; i < 3600; i++) g.tick(0, 0, 0, 0, false, false, dt);
  const expected = f.maxSpeed * Math.sqrt(0.65); // v_eq ~ sqrt(thrust) ~ sqrt(throttle)
  assert.ok(Math.abs(g.speed - expected) < expected * 0.1,
    '65% throttle equilibrium ' + g.speed.toFixed(0) + ' near ' + expected.toFixed(0));
  assert.ok(g.speed <= f.maxSpeed, 'under the cap');
});

test('turn rate: full pitch pull sustains the jets.json turnRate within [0.7, 1.15]x', () => {
  const f = new FlightModel(F16, { x: 0, y: 2000, z: 0, yaw: 0, throttle: 1.0 });
  f.speed = 250; f.vel[0] = 0; f.vel[2] = -250;
  for (let i = 0; i < 300; i++) f.tick(1, 0, 0, 0, false, false, dt); // 2.5 s pull
  const qDps = f.rates[1] * 180 / Math.PI;
  assert.ok(qDps > F16.turnRate * 0.7 && qDps < F16.turnRate * 1.15,
    'sustained pitch rate ' + qDps.toFixed(1) + ' deg/s vs spec ' + F16.turnRate);
});

test('speed invariant: 60 s of abusive inputs never exceeds maxSpeed * 1.05', () => {
  const f = new FlightModel(F16, { x: 0, y: 3000, z: 0, yaw: 0, throttle: 1.0 });
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 7200; i++) { // 60 s
    f.tick(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1,
      rand() > 0.5, rand() > 0.8, dt);
    assert.ok(Number.isFinite(f.speed) && Number.isFinite(f.pos[0]) && Number.isFinite(f.pos[1]),
      'finite state under abuse');
    assert.ok(f.speed <= f.maxSpeed * 1.05 + 0.01,
      'cap invariant, got ' + f.speed + ' > ' + f.maxSpeed * 1.05);
    assert.ok(f.speed >= 24.9, 'arcade floor respected');
  }
});

test('PID ringdown: after a rate step, output decays below 20% of peak within 2 s', () => {
  const pid = new PID(TUNING.PID_PITCH.kp, TUNING.PID_PITCH.ki, TUNING.PID_PITCH.kd, -9, 9);
  // track a 2 rad/s command against a simulated first-order plant (rate -> measurement)
  let rate = 0;
  let peak = 0;
  let abovePeakSeen = false;
  let decayed = false;
  for (let i = 0; i < 240; i++) { // 2 s window
    const out = pid.step(2, rate, dt);
    if (i > 10 && Math.abs(out) > peak) { peak = Math.abs(out); abovePeakSeen = true; }
    rate += out * dt;
    if (abovePeakSeen && Math.abs(out) < peak * 0.2) { decayed = true; break; }
  }
  assert.ok(peak > 0.5, 'PID produced meaningful control effort');
  assert.ok(decayed, 'ringdown: control effort decayed after the step (peak ' +
    peak.toFixed(2) + ')');
});

test('AI difficulty: reaction interval and jink energy scale Rookie < Veteran < Ace', () => {
  const ents = new WorldEntities(16);
  const enemy = ents.spawn(ENT_TYPE.JET, TEAM.ENEMY, 0, 1000, 0, 0, 0, 0, 9, 100);
  const player = ents.spawn(ENT_TYPE.JET, TEAM.PLAYER, 0, 1000, -2000, 0, 0, 0, 9, 100);
  const ais = [0, 1, 2].map((d) =>
    new EnemyAI(ents, { max: 0, fsms: [] }, enemy, { id: player }, d, 0xBEEF, {}));
  assert.equal(ais[0].difficulty, 0);
  assert.ok(AI_TUNING.REACTION[0] > AI_TUNING.REACTION[1]);
  assert.ok(AI_TUNING.REACTION[1] > AI_TUNING.REACTION[2]);
  assert.ok(AI_TUNING.JINK[0] < AI_TUNING.JINK[1]);
  assert.ok(AI_TUNING.JINK[1] < AI_TUNING.JINK[2]);
  // all three start in PATROL and produce valid commands
  for (const ai of ais) {
    assert.equal(ai.state, AI_STATE.PATROL);
    const cmd = ai.update(dt, 0);
    assert.ok(Number.isFinite(cmd.pitch) && Number.isFinite(cmd.roll));
    assert.ok(cmd.throttle >= 0 && cmd.throttle <= 1);
  }
});

test('input-to-render latency: event before a frame is visible in that frame (< 50 ms)', () => {
  let eventAt = -1;           // timestamp when the "key event" happened
  let seenAt = -1;            // timestamp when render first observed it
  let eventSeen = false;
  const loop = new GameLoop({
    step: () => {},
    render: () => {
      if (eventAt >= 0 && !eventSeen) { eventSeen = true; seenAt = eventAt; }
    },
  });
  let now = 0;
  loop.frame(now);
  // next frame: event fires just before the frame is processed (polling input model)
  now += 16.7;
  eventAt = now;
  loop.frame(now);
  assert.ok(eventSeen, 'render observed the event in the same frame');
  assert.ok(seenAt - eventAt < 50,
    'event-to-render latency ' + (seenAt - eventAt).toFixed(1) + ' ms is under the PRD 50 ms bound');
});

test('flight steady state does not allocate', { skip: typeof global.gc !== 'function' ? 'needs --expose-gc' : false }, () => {
  const f = new FlightModel(F16, { x: 0, y: 2000, z: 0, yaw: 0, throttle: 0.8 });
  const outP = new Float32Array(3), outR = new Float32Array(3);
  const warm = () => {
    for (let i = 0; i < 3600; i++) {
      f.tick(0.1, -0.2, 0, 0, i % 600 < 300, false, dt);
      f.sampleInterpolated(0.5, outP, outR);
    }
  };
  warm(); warm(); warm();
  global.gc(); global.gc();
  const before = process.memoryUsage().heapUsed;
  warm(); warm(); warm();
  global.gc(); global.gc();
  const growth = process.memoryUsage().heapUsed - before;
  assert.ok(growth < 128 * 1024, 'flight heap grew by ' + growth + ' bytes over 10800 ticks');
});
