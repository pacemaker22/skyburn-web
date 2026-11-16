// Verifies the minified dist/ modules still load and behave correctly (minifier sanity check).
import assert from 'node:assert/strict';

const { GameLoop, FIXED_DT_MS } = await import('../dist/src/core/loop.js');
assert.equal(FIXED_DT_MS > 8.33 && FIXED_DT_MS < 8.34, true);
let steps = 0;
const loop = new GameLoop({ step: () => { steps++; }, render: () => {} });
let now = 0;
loop.frame(now);
for (let i = 1; i <= 60; i++) { now += 1000 / 30; loop.frame(now); }
assert.ok(steps >= 235 && steps <= 245, 'minified loop still 120Hz, got ' + steps);

const { InputSystem, ACTION } = await import('../dist/src/core/input.js');
const input = new InputSystem({});
input.setViewportRaw(0, 0, 1000, 1000);
input.setPointer(500, 500);
input.keyDown('KeyW');
const s = input.sample();
assert.equal(s.getAxis(ACTION.THROTTLE), 1);
assert.equal(s.getAxis(ACTION.PITCH), 0);

const { VEC3_JS } = await import('../dist/src/wasm/vec3.js');
const out = new Float32Array(3);
VEC3_JS.cross([1, 0, 0], [0, 1, 0], out);
assert.equal(out[2], 1);

const { Terrain } = await import('../dist/src/world/terrain.js');
const t = new Terrain({ seed: 1337 });
assert.equal(t.heights.length, 65536);

const { AudioSystem } = await import('../dist/src/core/audio.js');
const a = new AudioSystem({});
a.setEngine(0.5, false); // must be a no-op without AudioContext, not a crash

const { assertFinite3, getViolationCount } = await import('../dist/src/verify/invariants.js');
assertFinite3('min', 1, 2, 3);
assert.equal(getViolationCount(), 0);

// GLSL template literals preserved by the minifier
const glsl = await import('../dist/src/render/shaders/basic.glsl.js');
assert.ok(glsl.TERRAIN_VS.startsWith('#version 300 es'), 'TERRAIN_VS intact');
assert.ok(glsl.SKY_FS.includes('smoothstep'), 'SKY_FS intact');
assert.ok(glsl.OCEAN_VS.includes('uTime'), 'OCEAN_VS intact');
assert.ok(!/\breact\b|\bthree\b/i.test(JSON.stringify(Object.keys(glsl))), 'no framework refs');

console.log('MINIFIED-DIST CHECKS: all ok');
