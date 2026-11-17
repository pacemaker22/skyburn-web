// Skyburn Phase 3B - Audio tests (Task 3B.5): volume plumbing is headless-safe (Node has
// no AudioContext), the MusicSystem is a strict no-op without a context, every SFX voice
// routes through the sfx bus (so the SFX slider is independent of music), and the save
// carries slider defaults that merge over older saves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AudioSystem } from '../src/core/audio.js';
import { MusicSystem } from '../src/audio/music.js';
import { defaultSaveData, mergeSave } from '../src/core/save.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('audio: setVolumes stores + clamps without a context; radio/chime are no-ops', () => {
  const a = new AudioSystem({});
  a.setVolumes({ master: 2, sfx: -1 });        // clamped, no ctx -> never throws
  assert.equal(a.masterVolume, 1);
  assert.equal(a.sfxVolume, 0);
  a.setVolumes({ master: 0.5, sfx: 0.8 });
  assert.equal(a.masterVolume, 0.5);
  assert.equal(a.sfxVolume, 0.8);
  a.setVolumes(null);                          // guarded
  assert.equal(a.masterVolume, 0.5);
  a.radio('checkpoint alpha');                 // no ctx: silent no-op
  a.aceChime();
});

test('audio: MusicSystem is a headless no-op that stores its volume', () => {
  const m = new MusicSystem(null);
  m.setVolume(0.7);
  assert.equal(m.volume, 0.7);
  m.setVolume(9);                              // clamped
  assert.equal(m.volume, 1);
  m.start();                                   // no AudioContext in Node -> stays stopped
  assert.equal(m.playing, false);
  m.tick();                                    // scheduler no-ops
  m.stop();
});

test('audio: SFX bus wiring - pools route through sfx, only sfx connects to master', () => {
  const src = readFileSync(join(ROOT, 'src/core/audio.js'), 'utf-8');
  assert.ok(src.includes('gg.connect(sfx)'), 'gun/boom/launch voices on the sfx bus');
  assert.ok(src.includes('bg.connect(sfx)'), 'beep pool on the sfx bus');
  assert.ok(!src.includes('gg.connect(master)'), 'no voice bypasses the sfx bus');
  assert.equal((src.match(/connect\(master\)/g) || []).length, 1,
    'exactly one link into master: the sfx bus itself');
  assert.ok(src.includes('music.setVolume') === false, 'music volume lives in music.js');
});

test('save: settings defaults for the sliders and merge over older saves', () => {
  const base = defaultSaveData();
  assert.equal(typeof base.settings.master, 'number');
  assert.equal(typeof base.settings.music, 'number');
  assert.equal(typeof base.settings.sfx, 'number');
  const merged = mergeSave({ version: 1, settings: { music: 0.8 } });
  assert.equal(merged.settings.music, 0.8, 'loaded slider wins');
  assert.equal(typeof merged.settings.master, 'number', 'old saves gain the other sliders');
});
