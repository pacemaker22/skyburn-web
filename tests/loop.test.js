// Phase 0 - Loop tests (PRD AC: "npm test shows loop, input, math tests green").
// Proves: physics runs at 120 Hz even when render drops to 30 fps; max 5 steps per frame;
// spiral-of-death protection drops backlog; alpha stays in [0,1); no heap growth in the loop.

import test from 'node:test';
import assert from 'node:assert/strict';
import { GameLoop, FIXED_DT_MS, MAX_STEPS_PER_FRAME } from '../src/core/loop.js';

test('physics runs at 120 Hz while render drops to 30 fps', () => {
  let steps = 0;
  const loop = new GameLoop({ step: () => { steps++; }, render: () => {} });
  // 90 rendered frames at 30 fps = 3 simulated seconds => expect ~360 physics steps
  let now = 0;
  loop.frame(now); // first frame initializes
  const perFrame = [];
  for (let i = 1; i <= 90; i++) {
    now += 1000 / 30;
    const s = loop.frame(now);
    perFrame.push(s);
  }
  assert.ok(steps >= 355 && steps <= 363, 'expected ~360 steps, got ' + steps);
  for (const s of perFrame) {
    assert.ok(s <= MAX_STEPS_PER_FRAME, 'never more than maxSteps per frame');
  }
  // flush the stats window with one more regular frame, then check measured steps/s ~= 120
  loop.frame(now + 8.5);
  const hz = loop.stats.stepsPerSecond;
  assert.ok(hz >= 115 && hz <= 125, 'stepsPerSecond ~120, got ' + hz);
});

test('accumulator caps at maxSteps and drops backlog (spiral-of-death protection)', () => {
  let steps = 0;
  const loop = new GameLoop({ step: () => { steps++; }, render: () => {} });
  let now = 0;
  loop.frame(now);
  for (let i = 0; i < 10; i++) {
    now += 1000; // 1 s per rendered frame - far behind the 120 Hz simulation
    const s = loop.frame(now);
    assert.equal(s, MAX_STEPS_PER_FRAME, 'exactly maxSteps per frame under huge backlog');
  }
  // 10 frames * 5 steps = 50 steps total, NOT 1200 (backlog dropped, no spiral)
  assert.equal(steps, 10 * MAX_STEPS_PER_FRAME);
  assert.ok(loop.stats.droppedMs > 0, 'dropped time is accounted');
});

test('interpolation alpha always stays in [0, 1)', () => {
  const loop = new GameLoop({ step: () => {}, render: () => {} });
  let now = 0;
  loop.frame(now);
  for (let i = 1; i <= 1000; i++) {
    now += 7.3; // irregular frame pacing
    loop.frame(now);
    const a = loop.stats.alpha;
    assert.ok(a >= 0 && a < 1, 'alpha in [0,1), got ' + a);
  }
});

test('fixed step is exactly 1/120 s and render is called once per frame', () => {
  const dts = [];
  let renders = 0;
  const loop = new GameLoop({
    step: (dt) => dts.push(dt),
    render: () => { renders++; },
  });
  let now = 0;
  loop.frame(now);
  for (let i = 1; i <= 120; i++) {
    now += 1000 / 60; // 60 fps render for 2 simulated seconds
    loop.frame(now);
  }
  assert.ok(dts.length > 0);
  for (const dt of dts) assert.equal(dt, FIXED_DT_MS / 1000);
  assert.equal(renders, 120, 'one render per frame');
});

test('no heap growth in the frame loop (allocation-free steady state)', { skip: typeof global.gc !== 'function' ? 'needs --expose-gc' : false }, () => {
  let steps = 0;
  const loop = new GameLoop({ step: () => { steps++; }, render: () => {} });
  let now = 0;
  loop.frame(now);
  for (let i = 1; i <= 500; i++) { now += 16.7; loop.frame(now); } // warmup
  global.gc(); global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 1; i <= 2000; i++) { now += 16.7; loop.frame(now); } // ~4000 physics steps
  global.gc(); global.gc();
  const after = process.memoryUsage().heapUsed;
  const growth = after - before;
  assert.ok(growth < 512 * 1024, 'heap grew by ' + growth + ' bytes over 2000 frames');
});
