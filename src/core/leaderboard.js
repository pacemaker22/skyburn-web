// Skyburn Phase 5 (Task 5.3) - local leaderboards ("high scores").
// PRD: a hosted leaderboard backend (Cloudflare/Firebase Time Trial) is OPTIONAL - "else
// local only, do not block ship". This module ships the LOCAL boards (persisted in
// save.js `highScores`, missionId -> entry array) plus a clearly-disabled RemoteBackend
// stub so a future backend plugs in without touching callers. No network calls anywhere:
// offline play is never affected.
//
// Board contract:
//  - entry shape: { score: number, timeSec: number, difficulty: 0|1|2, date: ISO string }
//  - ranking: score DESC, then faster time first; equal entries keep insertion (archive)
//    order via stable sort.
//  - boards hold at most BOARD_SIZE entries; worse runs fall off the bottom.
//  - all functions are defensive: corrupt/partial boards (non-arrays, garbage entries)
//    are skipped, never thrown - a broken save must not crash the menu/debrief.

export const BOARD_SIZE = 5;

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const score = typeof entry.score === 'number' && isFinite(entry.score)
    ? entry.score : null;
  if (score === null) return null;
  const timeSec = typeof entry.timeSec === 'number' && isFinite(entry.timeSec)
    ? entry.timeSec : 0;
  const difficulty = typeof entry.difficulty === 'number' && isFinite(entry.difficulty)
    ? Math.max(0, Math.min(2, entry.difficulty | 0)) : 1;
  const date = typeof entry.date === 'string' ? entry.date : '';
  return { score, timeSec, difficulty, date };
}

// Sort comparator: score DESC, then time ASC (missing/invalid time sorts last).
export function compareEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const ta = (a && typeof a.timeSec === 'number' && isFinite(a.timeSec))
    ? a.timeSec : Infinity;
  const tb = (b && typeof b.timeSec === 'number' && isFinite(b.timeSec))
    ? b.timeSec : Infinity;
  if (ta !== tb) return ta - tb;
  return 0;
}

// Sorted defensive copy of one board (defaults to the full BOARD_SIZE).
export function topEntries(boards, missionId, n) {
  const count = typeof n === 'number' && n > 0 ? n : BOARD_SIZE;
  if (!boards || typeof boards !== 'object') return [];
  const arr = boards[missionId];
  if (!Array.isArray(arr)) return [];
  const clean = [];
  for (const e of arr) {
    const norm = normalizeEntry(e);
    if (norm) clean.push(norm);
  }
  clean.sort(compareEntries);
  return clean.slice(0, count);
}

// Best entry for a mission, or null when the board is empty/corrupt.
export function bestEntry(boards, missionId) {
  const top = topEntries(boards, missionId, 1);
  return top.length ? top[0] : null;
}

// Insert a run into a mission's board. MUTATES `boards` (the caller's saveData object,
// mirroring how main.js treats save fields) and returns the 1-based rank of the new
// entry, or -1 if it did not make the board / inputs were invalid.
export function recordScore(boards, missionId, entry) {
  if (!boards || typeof boards !== 'object') return -1;
  if (typeof missionId !== 'string' || !missionId) return -1;
  const norm = normalizeEntry(entry);
  if (!norm) return -1;
  const list = Array.isArray(boards[missionId]) ? boards[missionId].slice() : [];
  list.push(norm);
  list.sort(compareEntries);          // stable: equal entries keep insertion order
  const trimmed = list.slice(0, BOARD_SIZE);
  boards[missionId] = trimmed;
  const idx = trimmed.indexOf(norm);
  return idx >= 0 ? idx + 1 : -1;
}

// Optional remote backend (PRD 5.3: Cloudflare/Firebase Time Trial). DISABLED by design -
// shipping must not depend on a hosted service, and the game must stay fully offline.
// To enable later: implement submit()/fetchTop() against a real endpoint and gate the UI
// on `backend.enabled`; local boards keep working regardless.
export class RemoteBackend {
  constructor(opts) {
    this.opts = opts || null;
    this.enabled = false;             // hard off: no network calls, no ship dependency
  }
  async submit() {
    throw new Error('RemoteBackend disabled: local leaderboards only (PRD 5.3)');
  }
  async fetchTop() {
    return [];
  }
}
