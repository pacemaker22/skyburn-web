// Skyburn Phase 2 - Persistence (Tasks 2.6 + 2.7): progress, unlocks, mission results,
// checkpoints and settings survive a page close (AC "Save persists after close").
// Backend is pluggable: IndexedDB in the browser (PRD stack), a shared in-memory store for
// Node tests (two SaveSystem instances over the same store simulate close + reopen), so the
// save CONTRACT is testable headlessly. No save calls in the hot loop - debrief + checkpoints
// only. Data shape is a small plain JSON object (structured-clone safe).

export const SAVE_KEY = 'save1';
// Phase 5 (Task 5.2): v2 adds highScores (local leaderboard boards). mergeSave migrates
// any older shape to SAVE_VERSION on load, so v1 saves keep working unchanged.
export const SAVE_VERSION = 2;

// Fresh save data (merged over loaded data so new fields appear after updates).
export function defaultSaveData() {
  return {
    version: SAVE_VERSION,
    difficulty: 1,                 // 0 rookie, 1 veteran, 2 ace
    unlocked: ['m1'],              // mission ids the player may launch
    results: {},                   // missionId -> { success, score, timeSec, kills }
    // Phase 5 (Task 5.2 + 5.3): local leaderboard boards,
    // missionId -> array of { score, timeSec, difficulty, date } (top entries only,
    // sizing/ordering owned by core/leaderboard.js).
    highScores: {},
    checkpoint: null,              // { missionId, stageIndex, difficulty, timeSec, player {...} }
    credits: 1500,                 // Task 3A.4: earned from debrief, spent on jets
    ownedJets: ['f16c', 'mig29'],  // Task 3A.4: jets the hangar may select (starter pair)
    // Task 3B.5: volume sliders (master/SFX on the audio graph, music on the MusicSystem).
    // Phase 4 (Tasks 4.6/4.7): pad + accessibility settings, all persisted here.
    settings: {
      master: 0.22, music: 0.5, sfx: 0.9,
      colorblind: 'normal',        // normal | protan | deutan | tritan (HUD palette)
      subtitles: true,             // radio chatter text line
      reducedMotion: false,        // no impact-cam slow-mo cut, no warning blink
      autoQuality: true,           // fps<50 for 5s -> render scale 0.8 then 0.6
      gamepad: {
        deadzone: 0.12,            // PRD default
        sensitivity: 1.0,          // stick output multiplier (0 < s <= 2)
        rumble: true,              // dual-rumble on hits/launches
        remap: {},                 // action name -> pad button index ({} = standard map)
      },
    },
  };
}

// Shallow-ish merge of a loaded (possibly partial/older) object onto defaults.
export function mergeSave(loaded) {
  const base = defaultSaveData();
  if (!loaded || typeof loaded !== 'object') return base;
  const out = base;
  // Migration: any loaded shape (v1, v2, future) is normalized to the CURRENT version.
  out.version = SAVE_VERSION;
  if (typeof loaded.difficulty === 'number') out.difficulty = loaded.difficulty;
  if (Array.isArray(loaded.unlocked)) out.unlocked = loaded.unlocked.slice();
  if (loaded.results && typeof loaded.results === 'object') {
    out.results = Object.assign({}, loaded.results);
  }
  // Phase 5 (Task 5.2): migrate high-score boards; only accept well-formed arrays.
  if (loaded.highScores && typeof loaded.highScores === 'object') {
    const boards = {};
    for (const k of Object.keys(loaded.highScores)) {
      if (Array.isArray(loaded.highScores[k])) boards[k] = loaded.highScores[k];
    }
    out.highScores = boards;
  }
  if (loaded.checkpoint && typeof loaded.checkpoint === 'object') out.checkpoint = loaded.checkpoint;
  if (typeof loaded.credits === 'number' && isFinite(loaded.credits)) out.credits = loaded.credits;
  if (Array.isArray(loaded.ownedJets)) out.ownedJets = loaded.ownedJets.slice();
  if (loaded.settings && typeof loaded.settings === 'object') {
    // Phase 4: deep-merge the nested gamepad object so older saves (no gamepad key)
    // and partial saves (e.g. only deadzone) both get full defaults.
    // NOTE: sBase must be captured from a FRESH defaultSaveData() BEFORE the assign
    // below - out === base, and Object.assign copies loaded.settings.gamepad by
    // REFERENCE over the default object, which would alias gBase to the loaded one
    // and silently drop untouched defaults (deadzone/rumble).
    const sBase = defaultSaveData().settings;
    out.settings = Object.assign({}, sBase, loaded.settings);
    const gBase = sBase.gamepad;
    const gLoaded = (loaded.settings.gamepad && typeof loaded.settings.gamepad === 'object')
      ? loaded.settings.gamepad : {};
    out.settings.gamepad = Object.assign({}, gBase, gLoaded);
    out.settings.gamepad.remap = Object.assign({}, gBase.remap, gLoaded.remap || {});
  }
  return out;
}

// ---- Phase 5 (Task 5.2): save-file export / import (plain JSON, human-inspectable) ----
// Export pretty-prints the CURRENT merged shape; import is the reverse: parse (throws on
// invalid JSON), merge onto defaults (repairs partial/corrupt files field by field) and
// return the normalized data. Callers decide transport (browser: file download +
// <input type="file">; Node tests: plain strings).
export function exportJSON(data) {
  return JSON.stringify(mergeSave(data || defaultSaveData()), null, 2);
}

export function importJSON(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('import: empty save file');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('import: not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('import: not a save object');
  }
  return mergeSave(parsed);
}

// ---- In-memory backend: module-level store shared by ALL instances (per process). ----
// This is what makes "save persists after close" provable in Node: create system A, save,
// drop it, create system B, load -> data survives, exactly like a reopened page.
export class MemoryBackend {
  constructor() { void 0; }
  async load() {
    const store = MemoryBackend._store;
    return store === null ? null : JSON.parse(store);
  }
  async save(data) { MemoryBackend._store = JSON.stringify(data); }
  async clear() { MemoryBackend._store = null; }
  static reset() { MemoryBackend._store = null; }
}
MemoryBackend._store = null;

// ---- IndexedDB backend (browser). Tiny kv store: db "skyburn", object store "kv". ----
export class IdbBackend {
  constructor() {
    this._db = null;
    this._opening = null;
  }
  _open() {
    if (this._db) return Promise.resolve(this._db);
    if (this._opening) return this._opening;
    this._opening = new Promise((resolve, reject) => {
      const req = indexedDB.open('skyburn', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
    });
    return this._opening;
  }
  async load() {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(SAVE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('indexedDB read failed'));
    });
  }
  async save(data) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(data, SAVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('indexedDB write failed'));
    });
  }
  async clear() {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(SAVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('indexedDB clear failed'));
    });
  }
}

// Browser default backend selector (Node tests inject MemoryBackend explicitly).
export function pickBackend() {
  if (typeof indexedDB !== 'undefined' && indexedDB && indexedDB.open) return new IdbBackend();
  return new MemoryBackend();
}

export class SaveSystem {
  constructor(backend) {
    this.backend = backend || pickBackend();
  }

  // Loads + merges onto defaults. Never throws for missing data (returns defaults).
  async load() {
    let raw = null;
    try { raw = await this.backend.load(); } catch (e) { raw = null; }
    this._lastLoaded = mergeSave(raw);
    return this._lastLoaded;
  }

  async save(data) {
    await this.backend.save(mergeSave(data));
    return true;
  }

  async clear() {
    await this.backend.clear();
    return true;
  }

  // Phase 5 (Task 5.2): export the whole save (merged current shape) as a JSON string.
  async export() {
    const data = await this.load();
    return exportJSON(data);
  }

  // Phase 5 (Task 5.2): import a JSON string (validates + repairs), persist it and
  // return the normalized data. Throws on invalid input - the caller surfaces that.
  async import(text) {
    const data = importJSON(text);
    await this.backend.save(data);
    this._lastLoaded = data;
    return data;
  }

  // Checkpoint query (Task 2.7): does a saved checkpoint match this mission + stage?
  hasCheckpoint(missionId, stageIndex) {
    const cp = this._lastLoaded && this._lastLoaded.checkpoint;
    if (!cp) return false;
    return cp.missionId === missionId && cp.stageIndex === stageIndex;
  }
}
