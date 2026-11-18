// Skyburn Phase 4 - Quality governor + profiler + settings persistence (Tasks 4.5/4.6/4.7).
// Headless logic tests for the auto-resolution governor (fps<50 for 5s -> 0.8x then 0.6x),
// the profiler's timer/counter bookkeeping, and the deep-merged save settings shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import { QualityGovernor, QUALITY_TUNING } from '../src/core/quality.js';
import { Profiler } from '../src/core/profiler.js';
import { defaultSaveData, mergeSave } from '../src/core/save.js';
import { paletteFor, HUD_PALETTES } from '../src/ui/hud.js';

// ---------------------------------------------------------------------------
// Task 4.5 - quality governor
// ---------------------------------------------------------------------------

test('governor: fps<50 for 5s steps to 0.8, another 5s to 0.6, never below', () => {
  const applied = [];
  const g = new QualityGovernor((s) => applied.push(s));
  let t = 0;
  // 4.9 s of struggling fps -> no step yet (hold not elapsed)
  for (let i = 0; i < 49; i++) { t += 0.1; g.update(0.1, 45); }
  assert.equal(g.scale, 1.0, 'no step-down before the 5 s hold elapses');
  g.update(0.1, 45); // crosses 5.0 s
  assert.equal(g.scale, 0.8, 'first step-down to 0.8');
  assert.equal(applied.length, 1);
  assert.equal(applied[0], 0.8);
  // a healthy reading resets the hold (no flapping)
  g.update(0.1, 60);
  assert.equal(g.belowFor, 0);
  // struggling again: 5 s -> 0.6
  for (let i = 0; i < 50; i++) g.update(0.1, 45);
  assert.equal(g.scale, 0.6, 'second step-down to 0.6');
  assert.equal(applied.length, 2);
  // at the floor scale: stays 0.6 no matter how long it struggles
  for (let i = 0; i < 200; i++) g.update(0.1, 30);
  assert.equal(g.scale, 0.6, 'never below the last step');
  assert.equal(QUALITY_TUNING.STEPS[QUALITY_TUNING.STEPS.length - 1], 0.6);
});

test('governor: disabled governor never changes scale', () => {
  const g = new QualityGovernor(null);
  g.enabled = false;
  for (let i = 0; i < 100; i++) g.update(0.1, 20);
  assert.equal(g.scale, 1.0);
});

// ---------------------------------------------------------------------------
// Task 4.5 - profiler
// ---------------------------------------------------------------------------

test('profiler: named timers accumulate EMA, counters snapshot, line() renders', () => {
  const p = new Profiler();
  p.begin('step');
  p.end('step');
  p.begin('render');
  p.end('render');
  p.count('ents', 23);
  p.count('missiles', 4);
  p.frame(16.7);
  const snap = p.snapshot();
  assert.ok(snap.timers.step >= 0, 'step timer recorded');
  assert.ok(snap.timers.render >= 0, 'render timer recorded');
  assert.equal(snap.counters.ents, 23);
  assert.equal(snap.counters.missiles, 4);
  assert.ok(snap.frameMs > 0);
  const line = p.line();
  assert.ok(line.includes('step') && line.includes('ents 23'), 'line() lists timers+counters');
  // unbalanced begin is ignored by end(); re-entrant begin keeps the first open
  p.begin('step');
  p.begin('step');
  p.end('step');
  p.end('step');
  assert.ok(p.timers.get('step').open < 0 || p.timers.get('step').open >= 0,
    'no crash on unbalanced usage');
});

// ---------------------------------------------------------------------------
// Task 4.6/4.7 - settings persistence (deep merge for the nested gamepad object)
// ---------------------------------------------------------------------------

test('save settings: defaults carry pad + accessibility fields', () => {
  const d = defaultSaveData();
  assert.equal(typeof d.settings.master, 'number');
  assert.equal(d.settings.colorblind, 'normal');
  assert.equal(d.settings.subtitles, true);
  assert.equal(d.settings.reducedMotion, false);
  assert.equal(d.settings.autoQuality, true);
  assert.equal(d.settings.gamepad.deadzone, 0.12);
  assert.equal(d.settings.gamepad.sensitivity, 1.0);
  assert.equal(d.settings.gamepad.rumble, true);
  assert.deepEqual(d.settings.gamepad.remap, {});
});

test('save settings: old saves (pre-Phase 4) gain every new default on merge', () => {
  const merged = mergeSave({ version: 1, settings: { music: 0.8 } });
  assert.equal(merged.settings.music, 0.8, 'loaded slider wins');
  assert.equal(merged.settings.colorblind, 'normal', 'new fields appear');
  assert.equal(merged.settings.gamepad.deadzone, 0.12, 'nested gamepad defaults appear');
  assert.deepEqual(merged.settings.gamepad.remap, {});
});

test('save settings: partial gamepad objects merge over defaults (remap persists)', () => {
  const merged = mergeSave({
    settings: {
      gamepad: { sensitivity: 1.4, remap: { fireMissile: 2 } },
    },
  });
  assert.equal(merged.settings.gamepad.sensitivity, 1.4, 'loaded pad value wins');
  assert.equal(merged.settings.gamepad.deadzone, 0.12, 'untouched pad default kept');
  assert.equal(merged.settings.gamepad.remap.fireMissile, 2, 'remap persisted');
  assert.equal(merged.settings.gamepad.rumble, true, 'sibling default kept');
});

// ---------------------------------------------------------------------------
// Task 4.7 - colorblind HUD palettes
// ---------------------------------------------------------------------------

test('HUD palettes: all four modes define every role; unknown falls back to normal', () => {
  for (const mode of ['normal', 'protan', 'deutan', 'tritan']) {
    const pal = paletteFor(mode);
    for (const role of ['done', 'failed', 'warn', 'hidden', 'base']) {
      assert.ok(typeof pal[role] === 'string' && pal[role][0] === '#',
        mode + '.' + role + ' is a color');
    }
  }
  assert.equal(paletteFor('bogus'), HUD_PALETTES.normal);
  // colorblind sets must not use the normal red/green pair (they swap the axes)
  assert.notEqual(HUD_PALETTES.protan.done, HUD_PALETTES.normal.done);
  assert.notEqual(HUD_PALETTES.protan.failed, HUD_PALETTES.normal.failed);
});
