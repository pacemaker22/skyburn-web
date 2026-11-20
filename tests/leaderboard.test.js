// Skyburn Phase 5 (Task 5.3): local leaderboard boards - ranking, eviction, tie-breaks,
// corruption tolerance, and the disabled remote backend contract (PRD 5.3: local only,
// do not block ship).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BOARD_SIZE, compareEntries, topEntries, bestEntry, recordScore, RemoteBackend,
} from '../src/core/leaderboard.js';

test('leaderboard: rank + eviction keeps the best BOARD_SIZE runs', () => {
  const boards = {};
  const e = (score, timeSec) => ({ score, timeSec, difficulty: 1, date: '2026-11-20' });
  assert.equal(recordScore(boards, 'm1', e(100, 60)), 1);
  assert.equal(recordScore(boards, 'm1', e(300, 45)), 1);
  assert.equal(recordScore(boards, 'm1', e(200, 50)), 2);
  assert.equal(boards.m1.length, 3);
  assert.equal(boards.m1[0].score, 300);
  for (let s = 400; s < 400 + BOARD_SIZE + 2; s++) recordScore(boards, 'm1', e(s, 30));
  assert.equal(boards.m1.length, BOARD_SIZE, 'board never exceeds BOARD_SIZE');
  assert.equal(boards.m1[0].score, 406, 'best stays on top');
  assert.equal(recordScore(boards, 'm1', e(-5, 1)), -1, 'worse run falls off');
  assert.equal(boards.m1.length, BOARD_SIZE);
});

test('leaderboard: score DESC, then time ASC tie-break', () => {
  const a = { score: 500, timeSec: 90, difficulty: 1, date: '' };
  const b = { score: 500, timeSec: 60, difficulty: 1, date: '' };
  const c = { score: 400, timeSec: 10, difficulty: 1, date: '' };
  assert.equal(compareEntries(b, a) < 0, true, 'faster time ranks first on ties');
  assert.equal(compareEntries(a, c) < 0, true, 'higher score ranks first');
  const boards = {};
  recordScore(boards, 'm2', a);
  recordScore(boards, 'm2', b);
  recordScore(boards, 'm2', c);
  const top = topEntries(boards, 'm2');
  assert.deepEqual(top.map((x) => x.timeSec), [60, 90, 10]);
});

test('leaderboard: corrupt boards tolerated, garbage entries dropped', () => {
  const boards = {
    m3: 'not-an-array',
    m4: [{ score: 10, timeSec: 5, difficulty: 1, date: '' }, 'junk', null,
      { nope: true }, { score: 'NaN' }, { score: NaN }],
  };
  assert.deepEqual(topEntries(boards, 'm3'), []);
  assert.deepEqual(topEntries({}, 'm5'), []);
  const top = topEntries(boards, 'm4');
  assert.equal(top.length, 1);
  assert.equal(top[0].score, 10);
  assert.equal(bestEntry(boards, 'm9'), null);
  assert.equal(recordScore(boards, 'm4', { score: 'x' }), -1);
  assert.equal(recordScore(null, 'm4', { score: 1 }), -1);
  assert.equal(recordScore(boards, '', { score: 1 }), -1);
});

test('leaderboard: recordScore normalizes entries (fixed shape, clamped difficulty)', () => {
  const boards = {};
  recordScore(boards, 'm6', { score: 42, timeSec: 7, difficulty: 9, date: 'd', extra: 1 });
  const entry = boards.m6[0];
  assert.deepEqual(Object.keys(entry).sort(), ['date', 'difficulty', 'score', 'timeSec']);
  assert.equal(entry.difficulty, 2, 'difficulty clamps to 0-2');
  assert.equal(entry.extra, undefined);
});

test('leaderboard: remote backend exists but is hard-disabled (PRD 5.3 local-only)', async () => {
  const remote = new RemoteBackend();
  assert.equal(remote.enabled, false);
  assert.deepEqual(await remote.fetchTop(), []);
  await assert.rejects(() => remote.submit(), /disabled/);
});
