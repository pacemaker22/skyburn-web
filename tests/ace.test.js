// Skyburn Phase 3B - Ace Bonus FSM tests (Task 3B.3): condition parsing (reject at load),
// ACTIVE -> COMPLETED/FAILED monotonicity, mission-level wiring (Ace only, event feeds,
// results payload) and the M11 SR-71 success path earning every camera-run bonus. Headless.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AceBonusSet, parseAceCondition, ACE_KIND } from '../src/mission/ace.js';
import { WorldEntities, ENT_TYPE, TEAM } from '../src/combat/entities.js';
import { MissileSystem } from '../src/combat/missiles.js';
import { Spawner } from '../src/mission/spawner.js';
import { Mission } from '../src/mission/mission.js';
import { Terrain } from '../src/world/terrain.js';
import missionsJson from '../src/data/missions.json' with { type: 'json' };
import mapsJson from '../src/data/maps.json' with { type: 'json' };
import jetsJson from '../src/data/jets.json' with { type: 'json' };

const MISSIONS = missionsJson.missions;
const MAPS = mapsJson.maps;
const JETS = jetsJson.jets;
const m5 = MISSIONS.find((m) => m.id === 'm5');
const m9 = MISSIONS.find((m) => m.id === 'm9');
const m11 = MISSIONS.find((m) => m.id === 'm11');

// ---------------------------------------------------------------------------
// Condition parsing: unknown kinds and missing parameters are rejected at load

test('ace: condition parsing accepts the four kinds and rejects garbage', () => {
  assert.equal(parseAceCondition('no_missile_fired').kind, ACE_KIND.NO_MISSILE);
  assert.equal(parseAceCondition('no_damage_taken').kind, ACE_KIND.NO_DAMAGE);
  const ut = parseAceCondition('under_time:300');
  assert.equal(ut.kind, ACE_KIND.UNDER_TIME);
  assert.equal(ut.param, 300);
  const mk = parseAceCondition('min_kills:12');
  assert.equal(mk.kind, ACE_KIND.MIN_KILLS);
  assert.equal(mk.param, 12);
  assert.throws(() => parseAceCondition('nope'), /unknown condition/);
  assert.throws(() => parseAceCondition('min_kills'), /needs a positive parameter/);
  assert.throws(() => parseAceCondition('under_time:abc'), /needs a positive parameter/);
  assert.throws(() => parseAceCondition(42), /must be a string/);
});

// ---------------------------------------------------------------------------
// AceBonusSet FSM: monotonic states, completion hooks, terminal finish

test('ace: set starts ACTIVE, completes min_kills with a hook, caps at 3 defs', () => {
  const seen = [];
  const set = new AceBonusSet([
    { id: 'b1', desc: 'six kills', condition: 'min_kills:6' },
    { id: 'b2', desc: 'clean', condition: 'no_damage_taken' },
  ], { onAceBonus: (b) => seen.push(b.id) });
  for (const s of set.list()) assert.equal(s.stateName, 'ACTIVE', 'entry state ACTIVE');
  assert.throws(() => new AceBonusSet([
    { id: 'a', condition: 'min_kills:1' }, { id: 'b', condition: 'min_kills:2' },
    { id: 'c', condition: 'min_kills:3' }, { id: 'd', condition: 'min_kills:4' },
  ]), /1-3 bonus defs/);
  assert.throws(() => new AceBonusSet([{ id: 'x' }]), /needs id \+ condition/);
  set.noteKill(5);
  assert.equal(set.completedCount(), 0, 'below threshold: nothing yet');
  set.noteKill(6);
  assert.equal(set.completedCount(), 1, 'min_kills completes on the feed');
  assert.deepEqual(seen, ['b1'], 'completion hook fired exactly once');
  // terminal: finish() cannot resurrect COMPLETED even when the mission ends in failure
  set.finish(10, false);
  assert.equal(set.completedCount(), 1, 'COMPLETED is terminal even on mission failure');
  assert.equal(set.list()[1].stateName, 'FAILED');
  set.noteKill(99); // resolved set ignores further events
  assert.equal(set.completedCount(), 1);
});

test('ace: violations fail instantly; finish resolves under_time and cleanliness', () => {
  const set = new AceBonusSet([
    { id: 'm', desc: 'no missiles', condition: 'no_missile_fired' },
    { id: 'd', desc: 'no damage', condition: 'no_damage_taken' },
    { id: 't', desc: 'under 5 min', condition: 'under_time:300' },
  ]);
  set.noteMissileFired();
  assert.equal(set.list()[0].stateName, 'FAILED', 'missile -> instant FAILED');
  set.noteDamageTaken();
  assert.equal(set.list()[1].stateName, 'FAILED', 'damage -> instant FAILED');
  set.finish(299, true); // still-ACTIVE under_time inside the budget
  assert.equal(set.list()[2].stateName, 'COMPLETED');
  assert.equal(set.completedCount(), 1);

  const set2 = new AceBonusSet([{ id: 't', desc: 'under 5 min', condition: 'under_time:300' }]);
  set2.finish(301, true);
  assert.equal(set2.list()[0].stateName, 'FAILED', 'over the budget -> FAILED');

  const set3 = new AceBonusSet([{ id: 'd', desc: 'no damage', condition: 'no_damage_taken' }]);
  set3.finish(50, true); // clean success at mission end completes cleanliness bonuses
  assert.equal(set3.list()[0].stateName, 'COMPLETED');

  const set4 = new AceBonusSet([{ id: 'd', desc: 'no damage', condition: 'no_damage_taken' }]);
  set4.finish(50, false); // failed mission sinks everything still pending
  assert.equal(set4.list()[0].stateName, 'FAILED');
});

// ---------------------------------------------------------------------------
// Mission-level wiring (mirrors main.js: player feeds + noteKill routing)

function buildHarness(def, difficulty) {
  const map = MAPS[def.map];
  const ents = new WorldEntities(128);
  const missiles = new MissileSystem(0xACE5, {});
  const playerId = ents.spawn(ENT_TYPE.JET, TEAM.PLAYER, 0, 2500, 14000, Math.PI, 0, 0, 9, 100);
  ents.missilesLeft[playerId] = def.id === 'm11' ? 0 : 6; // SR-71 is unarmed
  const terrain = new Terrain({ seed: 1337 });
  const spawner = new Spawner(ents, {
    missiles, terrain, jetsData: JETS, playerId, difficulty, map,
  });
  const events = [];
  const mission = new Mission(def, map, difficulty, {
    ents, missiles, spawner, playerId,
    hooks: { onAceBonus: (b) => events.push('ace:' + b.id) },
  });
  return { def, map, ents, missiles, spawner, mission, playerId, events, terrain };
}

test('mission: Ace Bonus set exists on Ace only; missile feed fails the bonus silently', () => {
  const hAce = buildHarness(m5, 2);
  hAce.mission.start(null);
  assert.ok(hAce.mission.ace, 'Ace difficulty builds the set');
  assert.equal(hAce.mission.ace.n, 3);
  const hVet = buildHarness(m5, 1);
  hVet.mission.start(null);
  assert.equal(hVet.mission.ace, null, 'no Ace set on Veteran');
  hAce.mission.notePlayerMissileFired();
  assert.equal(hAce.mission.ace.list()[0].stateName, 'FAILED');
  assert.deepEqual(hAce.events, [], 'violations never fire the completion hook');
});

test('mission: kill feed drives min_kills; mission end sinks the rest; results payload', () => {
  const h = buildHarness(m9, 2);
  h.mission.start(null);
  const dt = 1 / 120;
  // sink the 4 task-force boats -> stage completes and the CAP stage deploys
  for (const s of h.spawner.ships.slice()) {
    h.ents.damage(s.id, 9999);
    h.mission.noteKill(s.id);
  }
  for (let i = 0; i < 120; i++) h.mission.tick(dt);
  assert.equal(h.mission.stageIndex, 1, 'advanced to the CAP stage');
  while (h.spawner.jetIds.length < 6 && h.mission.running) h.mission.tick(dt); // 2nd wave 30 s
  let kills = 4;
  for (const id of h.spawner.jetIds.slice()) {
    h.ents.damage(id, 9999);
    h.mission.noteKill(id);
    kills++;
  }
  assert.equal(kills, 10);
  assert.equal(h.mission.ace.completedCount(), 1, 'min_kills:10 completed');
  assert.deepEqual(h.events, ['ace:b1'], 'completion hook fired exactly once');
  h.mission.failNow('test-end');
  const res = h.mission.results();
  assert.equal(res.success, false);
  assert.equal(res.aceCount, 1);
  assert.equal(res.aceBonuses.length, 3);
  assert.equal(res.aceBonuses[0].earned, true, 'earned bonus survives the failure');
  assert.equal(res.aceBonuses[1].earned, false, 'pending bonuses sink with the mission');
});

test('mission: M11 Oxcart - recon gates complete, all three Ace bonuses earned', () => {
  const h = buildHarness(m11, 2);
  h.mission.start(null);
  const dt = 1 / 120;
  for (let i = 0; i < 600; i++) h.mission.tick(dt); // 5 s: scramble wave deploys
  for (const id of h.spawner.jetIds.slice()) {
    h.ents.damage(id, 9999);   // nothing in their inventory can catch the Blackbird
    h.mission.noteKill(id);
  }
  for (const wp of ['wpO1', 'wpO2', 'wpO3', 'wpO4', 'wpO5']) {
    const p = h.map.points[wp];
    h.ents.pos[h.playerId * 3] = p.x;
    h.ents.pos[h.playerId * 3 + 1] = 2500;   // above the altMin gate
    h.ents.pos[h.playerId * 3 + 2] = p.z;
    for (let i = 0; i < 240; i++) h.mission.tick(dt); // 2 s per camera gate
  }
  assert.equal(h.mission.stateName(), 'SUCCESS', 'five gates captured -> mission success');
  const res = h.mission.results();
  assert.equal(res.success, true);
  assert.ok(res.timeSec < 300, 'well inside the 5-minute bonus budget');
  assert.equal(res.aceCount, 3, 'under_time + no_damage + no_missile all earned');
  assert.ok(res.score > m11.reward, 'ace bonuses add to the score');
});

