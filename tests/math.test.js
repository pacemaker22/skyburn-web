// Phase 0 - Math tests: vec3 (WASM stub API, Task 0.7) + mat4 (renderer camera math).
// Terrain, jets.json schema and invariants tests continue in this file below.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VEC3_JS, initVec3, getVec3 } from '../src/wasm/vec3.js';
import {
  mat4Identity, mat4Multiply, mat4Perspective, mat4LookAt, mat4Invert, mat4FromYPR,
} from '../src/render/renderer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function transform(m, v, out) {
  const x = v[0], y = v[1], z = v[2], w = v[3];
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
  out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
  return out;
}

// ---- vec3 (Task 0.7: JS fallback with same API as the WASM module) ----

test('vec3 add/sub/scale/cross/dot/length/normalize', () => {
  const a = [1, 2, 3];
  const b = [4, 5, 6];
  const out = new Float32Array(3);
  VEC3_JS.add(a, b, out);
  assert.deepEqual([...out], [5, 7, 9]);
  VEC3_JS.sub(b, a, out);
  assert.deepEqual([...out], [3, 3, 3]);
  VEC3_JS.scale(a, 2, out);
  assert.deepEqual([...out], [2, 4, 6]);
  VEC3_JS.cross([1, 0, 0], [0, 1, 0], out);
  assert.deepEqual([...out], [0, 0, 1]);
  assert.equal(VEC3_JS.dot([1, 2, 3], [4, 5, 6]), 32);
  assert.equal(VEC3_JS.length([3, 4, 0]), 5);
  const len = VEC3_JS.normalize([0, 0, -7], out);
  assert.equal(len, 7);
  assert.deepEqual([...out], [0, 0, -1]);
  const len0 = VEC3_JS.normalize([0, 0, 0], out); // zero vector is safe
  assert.equal(len0, 0);
  assert.deepEqual([...out], [0, 0, 0]);
});

test('vec3 backend init falls back to JS with the same API when no wasm artifact', async () => {
  const backend = await initVec3();
  assert.ok(backend === VEC3_JS || backend.name === 'wasm');
  assert.equal(getVec3(), backend);
  const out = new Float32Array(3);
  backend.add([1, 1, 1], [2, 2, 2], out);
  assert.deepEqual([...out], [3, 3, 3]);
});

// ---- mat4 (Task 0.4 camera math) ----

test('mat4 identity and multiply', () => {
  const I = new Float32Array(16);
  mat4Identity(I);
  const M = new Float32Array(16);
  mat4Multiply(M, I, I);
  assert.deepEqual([...M], [...I]);
  const P = new Float32Array(16);
  mat4Perspective(P, Math.PI / 2, 16 / 9, 0.1, 100);
  const R = new Float32Array(16);
  mat4Multiply(R, I, P); // I * P = P
  assert.deepEqual([...R], [...P]);
});

test('mat4 perspective projects an axis point to ndc center with positive w', () => {
  const P = new Float32Array(16);
  mat4Perspective(P, Math.PI / 2, 16 / 9, 0.5, 1000);
  const clip = new Float32Array(4);
  transform(P, [0, 0, -100, 1], clip); // straight ahead, 100 m (view space -Z)
  assert.equal(clip[0], 0);
  assert.equal(clip[1], 0);
  assert.ok(clip[3] > 0, 'w = -z = 100');
  const zNdc = clip[2] / clip[3];
  assert.ok(zNdc > -1 && zNdc < 1, 'z within clip range, got ' + zNdc);
});

test('mat4 lookAt maps the target to view-space -Z', () => {
  const V = new Float32Array(16);
  mat4LookAt(V, 0, 0, 50, 0, 0, 0, 0, 1, 0);
  const out = new Float32Array(4);
  transform(V, [0, 0, 0, 1], out); // world origin
  assert.ok(Math.abs(out[0]) < 1e-6);
  assert.ok(Math.abs(out[1]) < 1e-6);
  assert.ok(Math.abs(out[2] + 50) < 1e-4, 'origin at -50 in view space, got ' + out[2]);
});

test('mat4 invert roundtrips', () => {
  const P = new Float32Array(16);
  mat4Perspective(P, 1.1, 1.77, 2, 50000);
  const V = new Float32Array(16);
  mat4LookAt(V, 10, 20, 30, -5, 3, -100, 0, 1, 0);
  const VP = new Float32Array(16);
  mat4Multiply(VP, P, V);
  const Inv = new Float32Array(16);
  mat4Invert(Inv, VP);
  const R = new Float32Array(16);
  mat4Multiply(R, VP, Inv);
  for (let i = 0; i < 16; i++) {
    const expect = i % 5 === 0 ? 1 : 0;
    assert.ok(Math.abs(R[i] - expect) < 1e-3, 'roundtrip[' + i + '] = ' + R[i]);
  }
});

test('mat4FromYPR with zero angles equals pure translation', () => {
  const M = new Float32Array(16);
  mat4FromYPR(M, 0, 0, 0, 5, 6, 7);
  assert.deepEqual([...M.slice(12, 15)], [5, 6, 7]);
  assert.deepEqual([...M.slice(0, 3)], [1, 0, 0]);
  assert.deepEqual([...M.slice(4, 7)], [0, 1, 0]);
  assert.deepEqual([...M.slice(8, 11)], [0, 0, 1]);
});

// ---- Perlin + terrain (Task 0.5) ----

import { Perlin2D, Terrain, mulberry32 } from '../src/world/terrain.js';
import {
  assertFinite3, assertSpeedCapped, assertActiveCount,
  getViolationCount, resetInvariants, setInvariantsEnabled,
} from '../src/verify/invariants.js';

test('perlin is deterministic per seed and bounded', () => {
  const p1 = new Perlin2D(42);
  const p2 = new Perlin2D(42);
  const p3 = new Perlin2D(43);
  let differs = false;
  for (let i = 0; i < 200; i++) {
    const x = i * 0.37, y = i * 0.11;
    assert.equal(p1.noise(x, y), p2.noise(x, y), 'same seed deterministic');
    assert.ok(Math.abs(p1.noise(x, y)) <= 1.5, 'noise bounded');
    if (p1.noise(x, y) !== p3.noise(x, y)) differs = true;
  }
  assert.ok(differs, 'different seeds produce different terrain');
});

test('terrain heightmap: 256x256, finite, non-negative, has islands', () => {
  const t = new Terrain({ seed: 1337 });
  assert.equal(t.heights.length, 256 * 256);
  for (let i = 0; i < t.heights.length; i++) {
    assert.ok(Number.isFinite(t.heights[i]), 'finite height at ' + i);
    assert.ok(t.heights[i] >= 0, 'no negative heights');
  }
  assert.ok(t.maxY > 120, 'has land above 120 m, max ' + t.maxY);
  assert.equal(t.heightAt(1e9, 1e9), 0, 'outside patch = open ocean');
  const mesh = t.buildMesh();
  assert.equal(mesh.verts.length, 256 * 256 * 9);
  assert.equal(mesh.idx.length, 255 * 255 * 6);
});

test('seeded PRNG is deterministic', () => {
  const r1 = mulberry32(7);
  const r2 = mulberry32(7);
  for (let i = 0; i < 50; i++) assert.equal(r1(), r2());
});

// ---- jets.json schema (PRD Appendix B) ----

test('jets.json matches the Appendix B schema with F-16C + MiG-29', () => {
  const data = JSON.parse(readFileSync(join(ROOT, 'src/data/jets.json'), 'utf-8'));
  assert.ok(Array.isArray(data.jets));
  assert.ok(data.jets.length >= 40, 'Phase 3A: 40+ jets, got ' + data.jets.length);
  const FIELDS = ['id', 'name', 'country', 'tier', 'thrust', 'drag', 'maxSpeed', 'turnRate',
    'stallSpeed', 'radarRange', 'stealthFactor', 'hardpoints', 'gunDamage', 'flareCount', 'price'];
  const f16 = data.jets.find((j) => j.id === 'f16c');
  const mig = data.jets.find((j) => j.id === 'mig29');
  assert.ok(f16 && mig, 'F-16C and MiG-29 present');
  for (const jet of [f16, mig]) {
    for (const f of FIELDS) assert.ok(jet[f] !== undefined, jet.id + ' missing ' + f);
    assert.ok(jet.maxSpeed > 0 && jet.thrust > 0 && jet.turnRate > 0);
    assert.ok(jet.stealthFactor > 0 && jet.stealthFactor <= 1);
  }
  // F-16C values exactly as the PRD Appendix B example
  assert.equal(f16.thrust, 129000);
  assert.equal(f16.drag, 0.021);
  assert.equal(f16.maxSpeed, 2120);
  assert.equal(f16.turnRate, 18.5);
  assert.equal(f16.stallSpeed, 180);
  assert.equal(f16.radarRange, 8000);
  assert.equal(f16.stealthFactor, 0.65);
  assert.equal(f16.hardpoints, 6);
  assert.equal(f16.gunDamage, 12);
  assert.equal(f16.flareCount, 60);
  assert.equal(f16.price, 1200);
});

// ---- invariants (Task 0.8) ----

test('invariants count violations but never throw', () => {
  resetInvariants();
  assertFinite3('test.finite', 1, 2, 3);
  assert.equal(getViolationCount(), 0);
  assertFinite3('test.finite', NaN, 2, 3);
  assertFinite3('test.finite', 1, Infinity, 3);
  assert.equal(getViolationCount(), 2);
  assertSpeedCapped('test.speed', 100, 588); // fine
  assertSpeedCapped('test.speed', 700, 588); // violation (700 > 588*1.05)
  assert.equal(getViolationCount(), 3);
  assertActiveCount('test.count', 1, 1);
  assertActiveCount('test.count', 2, 1); // violation
  assert.equal(getViolationCount(), 4);
  setInvariantsEnabled(false);
  assertFinite3('test.finite', NaN, 0, 0);
  assert.equal(getViolationCount(), 4, 'no new violations while disabled');
  setInvariantsEnabled(true);
  resetInvariants();
});
