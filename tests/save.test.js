// Skyburn Phase 5 (Task 5.2): save v2 - highScores field, v1 migration, export/import,
// clear. The backend contract is proven headlessly via MemoryBackend (shared module
// store simulates "close the page, reopen the page" exactly like the browser).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SAVE_VERSION, defaultSaveData, mergeSave, exportJSON, importJSON,
  SaveSystem, MemoryBackend,
} from '../src/core/save.js';

test('save v2: defaults carry highScores + current version', () => {
  const base = defaultSaveData();
  assert.equal(base.version, SAVE_VERSION);
  assert.deepEqual(base.highScores, {});
});

test('save v2: v1 saves migrate (version normalized, data kept, highScores filled)', () => {
  const old = mergeSave({ version: 1, credits: 777, unlocked: ['m1', 'm2'],
    results: { m1: { success: true, score: 10, timeSec: 9, kills: 1 } } });
  assert.equal(old.version, SAVE_VERSION);
  assert.deepEqual(old.highScores, {});
  assert.equal(old.credits, 777);
  assert.deepEqual(old.unlocked, ['m1', 'm2']);
  assert.equal(old.results.m1.success, true);
});

test('save v2: malformed highScores boards dropped, well-formed arrays kept', () => {
  const merged = mergeSave({ highScores: { m1: [{ score: 5 }], m2: 'junk', m3: 42 } });
  assert.deepEqual(Object.keys(merged.highScores), ['m1']);
});

test('save v2: exportJSON pretty-prints the merged current shape', () => {
  const text = exportJSON({ credits: 321 });
  assert.ok(text.includes('"credits": 321'));
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, SAVE_VERSION);
  assert.deepEqual(parsed.highScores, {});
});

test('save v2: importJSON validates and repairs partial/corrupt files', () => {
  const data = importJSON('{"credits": 555, "garbage": {"x": 1}}');
  assert.equal(data.credits, 555);
  assert.deepEqual(data.highScores, {}, 'missing fields get defaults');
  assert.equal(data.settings.master, 0.22);
  assert.equal(data.garbage, undefined, 'unknown fields dropped');
  assert.throws(() => importJSON(''), /empty/);
  assert.throws(() => importJSON('   \n  '), /empty/);
  assert.throws(() => importJSON('not json {'), /valid JSON/);
  assert.throws(() => importJSON('[1,2,3]'), /save object/);
  assert.throws(() => importJSON('null'), /save object/);
});

test('save v2: export -> clear -> import roundtrip (close + reopen)', async () => {
  MemoryBackend.reset();
  const s1 = new SaveSystem(new MemoryBackend());
  const d = await s1.load();
  d.credits = 4321;
  d.unlocked.push('m2', 'm3');
  await s1.save(d);
  const exported = await s1.export();

  await s1.clear();
  const empty = await new SaveSystem(new MemoryBackend()).load();
  assert.equal(empty.credits, 1500, 'clear wipes back to fresh defaults');

  const s2 = new SaveSystem(new MemoryBackend());
  await s2.import(exported);
  const back = await s2.load();
  assert.equal(back.credits, 4321);
  assert.deepEqual(back.unlocked, ['m1', 'm2', 'm3']);
  assert.equal(back.version, SAVE_VERSION);
});
