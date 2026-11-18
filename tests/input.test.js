// Phase 0 - Input tests: InputState struct, remap table, deadzone 0.12, edge detection,
// keyboard + mouse + virtual gamepad sampling (PRD Task 0.3 + AC "input tests green").

import test from 'node:test';
import assert from 'node:assert/strict';
import { InputSystem, ACTION, DEADZONE, KEY_REMAP, deadzoneRadial, applyDz } from '../src/core/input.js';

function makeInput() {
  return new InputSystem({});
}

test('InputState struct exposes the canonical PRD fields', () => {
  const i = makeInput();
  i.sample();
  // PRD Sec 5: { pitch, roll, yaw, throttle, fireGun, fireMissile, flare }
  assert.equal(typeof i.getAxis(ACTION.PITCH), 'number');
  assert.equal(typeof i.getAxis(ACTION.ROLL), 'number');
  assert.equal(typeof i.getAxis(ACTION.YAW), 'number');
  assert.equal(typeof i.getAxis(ACTION.THROTTLE), 'number');
  assert.equal(typeof i.isDown(ACTION.FIRE_GUN), 'boolean');
  assert.equal(typeof i.isDown(ACTION.FIRE_MISSILE), 'boolean');
  assert.equal(typeof i.wasPressed(ACTION.FLARE), 'boolean');
});

test('remapping table covers the PRD controls (keyboard)', () => {
  const need = ['KeyW', 'KeyS', 'Space', 'ShiftLeft', 'KeyF', 'KeyG', 'KeyR', 'KeyE', 'KeyC', 'KeyM'];
  for (const code of need) {
    assert.ok(KEY_REMAP[code], 'missing remap for ' + code);
  }
});

test('keyboard: W/S drive throttle axis, F is an edge-triggered flare', () => {
  const i = makeInput();
  i.keyDown('KeyW');
  let s = i.sample();
  assert.equal(s.getAxis(ACTION.THROTTLE), 1);
  i.keyUp('KeyW');
  s = i.sample();
  assert.equal(s.getAxis(ACTION.THROTTLE), 0);

  i.keyDown('KeyF');
  s = i.sample();
  assert.equal(s.wasPressed(ACTION.FLARE), true, 'flare edge on press');
  s = i.sample();
  assert.equal(s.wasPressed(ACTION.FLARE), false, 'no flare edge while held');
  i.keyUp('KeyF');
  s = i.sample();
  assert.equal(s.wasPressed(ACTION.FLARE), false, 'no flare edge on release');
});

test('mouse position = desired heading (screen up = pitch up, right = roll right)', () => {
  const i = makeInput();
  i.setViewportRaw(0, 0, 1920, 1080); // canvas rect: center (960, 540)
  i.setPointer(960, 540); // center
  let s = i.sample();
  assert.equal(s.getAxis(ACTION.PITCH), 0);
  assert.equal(s.getAxis(ACTION.ROLL), 0);
  i.setPointer(960, 54); // near top
  s = i.sample();
  assert.ok(s.getAxis(ACTION.PITCH) > 0.9, 'pitch up at top, got ' + s.getAxis(ACTION.PITCH));
  i.setPointer(1920, 540); // right edge
  s = i.sample();
  assert.ok(s.getAxis(ACTION.ROLL) > 0.9, 'roll right at right edge, got ' + s.getAxis(ACTION.ROLL));
});

test('virtual gamepad: radial deadzone 0.12 and analog axes', () => {
  const i = makeInput();
  // inside deadzone -> zero (vector magnitude sqrt(0.06^2+0.07^2) ~= 0.092 < 0.12)
  i.setVirtualGamepad({ axes: [0.06, -0.07, 0, 0], buttons: [] });
  let s = i.sample();
  assert.equal(s.getAxis(ACTION.ROLL), 0);
  assert.equal(s.getAxis(ACTION.PITCH), 0);
  // outside deadzone -> rescaled analog value
  i.setVirtualGamepad({ axes: [0.5, 0, 0, 0], buttons: [] });
  s = i.sample();
  const expected = (0.5 - DEADZONE) / (1 - DEADZONE);
  assert.ok(Math.abs(s.getAxis(ACTION.ROLL) - expected) < 1e-6,
    'rescaled roll, got ' + s.getAxis(ACTION.ROLL) + ' expected ' + expected);
  // RT fires guns, A locks/fires missile, B flare edge
  i.setVirtualGamepad({
    axes: [0, 0, 0, 0],
    buttons: { 7: { value: 1, pressed: true }, 0: { value: 1, pressed: true }, 1: { value: 1, pressed: true } },
  });
  s = i.sample();
  assert.equal(s.isDown(ACTION.FIRE_GUN), true, 'RT = guns');
  assert.equal(s.isDown(ACTION.FIRE_MISSILE), true, 'A = lock/fire missile');
  assert.equal(s.wasPressed(ACTION.FLARE), true, 'B = flare edge');
});

test('gamepad triggers drive throttle: RB up / LB down (PRD controls table)', () => {
  const i = makeInput();
  i.setVirtualGamepad({
    axes: [0, 0, 0, 0],
    buttons: { 5: { value: 1, pressed: true } }, // RB
  });
  let s = i.sample();
  assert.equal(s.getAxis(ACTION.THROTTLE), 1);
  i.setVirtualGamepad({
    axes: [0, 0, 0, 0],
    buttons: { 4: { value: 1, pressed: true } }, // LB
  });
  s = i.sample();
  assert.equal(s.getAxis(ACTION.THROTTLE), -1);
});

test('deadzone helpers: radial scaling math', () => {
  const out = new Float32Array(2);
  // magnitude sqrt(0.08^2 + 0.08^2) ~= 0.113 < 0.12 -> inside deadzone
  deadzoneRadial(0.08, 0.08, 0.12, out);
  assert.equal(out[0], 0);
  assert.equal(out[1], 0);
  deadzoneRadial(1, 0, 0.12, out);
  assert.ok(Math.abs(out[0] - 1) < 1e-6, 'full deflection stays full');
  const v = applyDz(-0.56, 0.12);
  assert.ok(Math.abs(v + (0.56 - 0.12) / 0.88) < 1e-6);
});

// ---- Phase 4 (Task 4.6): pad settings - sensitivity, deadzone, remap, hot-plug ----

test('pad settings: user deadzone and sensitivity apply to stick sampling', () => {
  const i = new InputSystem({ padSettings: { deadzone: 0.3, sensitivity: 1.5 } });
  i.setVirtualGamepad({ axes: [0.2, 0, 0, 0], buttons: [] });
  let s = i.sample();
  assert.equal(s.getAxis(ACTION.ROLL), 0, '0.2 < dz 0.3 -> inside deadzone');
  i.setVirtualGamepad({ axes: [1.0, 0, 0, 0], buttons: [] });
  s = i.sample();
  const base = (1 - 0.3) / (1 - 0.3); // rescale with dz 0.3 -> 1.0
  assert.ok(Math.abs(s.getAxis(ACTION.ROLL) - Math.min(1, base * 1.5)) < 1e-6,
    'sensitivity scales the rescaled output, got ' + s.getAxis(ACTION.ROLL));
  // out-of-range settings fall back to the PRD defaults (corrupt save protection)
  const j = new InputSystem({ padSettings: { deadzone: 9, sensitivity: -2 } });
  assert.equal(j.dz, DEADZONE);
  assert.equal(j.sensitivity, 1);
});

test('pad remap: persisted bindings override the standard map; defaults survive garbage', () => {
  const i = new InputSystem({
    padSettings: { remap: { fireMissile: 5, flare: 0, switchWeapon: 99 } },
  });
  // RB (5) = missile (remapped), A (0) = flare (remapped)
  i.setVirtualGamepad({
    axes: [0, 0, 0, 0],
    buttons: { 5: { value: 1, pressed: true }, 0: { value: 1, pressed: true } },
  });
  let s = i.sample();
  assert.equal(s.isDown(ACTION.FIRE_MISSILE), true, 'fireMissile remapped to RB (5)');
  assert.equal(s.isDown(ACTION.FLARE), true, 'flare remapped to A (0)');
  assert.equal(s.isDown(ACTION.FIRE_GUN), false, 'RT not remapped, not pressed');
  // garbage remap entry (99) falls back to the default binding (X = 2)
  i.setVirtualGamepad({ axes: [0, 0, 0, 0], buttons: { 2: { value: 1, pressed: true } } });
  s = i.sample();
  assert.equal(s.isDown(ACTION.SWITCH_WEAPON), true,
    'switchWeapon: 99 is out of range -> falls back to default X (2)');
});

test('pad hot-plug: connect/disconnect callbacks fire and index stays fresh', () => {
  const i = new InputSystem({});
  const handlers = {};
  const fakeWin = {
    addEventListener: (name, fn) => { handlers[name] = fn; },
  };
  const events = [];
  i.onPadChange = (connected, id) => events.push([connected, id]);
  i.attachPadHotPlug(fakeWin);
  assert.ok(handlers.gamepadconnected && handlers.gamepaddisconnected,
    'both listeners registered');
  handlers.gamepadconnected({ gamepad: { index: 2, id: 'Xbox Pad' } });
  assert.equal(i.gamepadIndex, 2, 'connect claims the free slot');
  assert.deepEqual(events[0], [true, 'Xbox Pad']);
  handlers.gamepaddisconnected({ gamepad: { index: 2, id: 'Xbox Pad' } });
  assert.equal(i.gamepadIndex, -1, 'disconnect releases the slot');
  assert.deepEqual(events[1], [false, 'Xbox Pad']);
});

test('rumble: no-throw headlessly (no navigator vibration API in Node)', () => {
  const i = new InputSystem({});
  i.rumble(0.5, 100);   // must be a silent no-op without a pad
  i.rumble(2, -5);      // out-of-range values clamp inside
  assert.ok(true);
});
