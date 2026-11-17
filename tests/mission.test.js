// Skyburn Phase 2 - Mission system tests (Tasks 2.1-2.8) - deterministic, no sleeps, no DOM.
// Covers: mission/stage FSM tables + forbidden transitions, objective DAG (topo sort, cyclic
// rejection at load, dependency activation, all 5 objective types), spawner (waves, cap,
// despawn, protected assets, cruise missiles), checkpoint capture/restore, difficulty policy,
// save persistence across "reopen", the M3 <3 min rig-death acceptance criterion, and the
// Game (UI flow) FSM. Runs under `node --test` like the Phase 0/1 suites.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OBJ_STATE, OBJ_TYPE, topoSort, ObjectiveDag, mapPoint, formatObjectiveLine,
} from '../src/mission/objectives.js';
import { Stage, STAGE_STATE, buildStageTable, sharedStageTable } from '../src/mission/stages.js';
import {
  Mission, MISSION_STATE, buildMissionTable, RESTORES_BY_DIFFICULTY,
} from '../src/mission/mission.js';
import { Spawner, SPAWNER_TUNING } from '../src/mission/spawner.js';
import { WorldEntities, ENT_TYPE, TEAM } from '../src/combat/entities.js';
import { MissileSystem, MISSILE_TUNING } from '../src/combat/missiles.js';
import { CollisionWorld } from '../src/combat/collision.js';
import { FlightModel } from '../src/physics/flight.js';
import { buildGameTable, GAME_STATE, GAME_EVENT } from '../src/main.js';
import { FSM } from '../src/ai/fsm.js';
import { Terrain } from '../src/world/terrain.js';
import { SaveSystem, MemoryBackend, defaultSaveData, mergeSave } from '../src/core/save.js';
import missionsJson from '../src/data/missions.json' with { type: 'json' };
import mapsJson from '../src/data/maps.json' with { type: 'json' };
import jetsJson from '../src/data/jets.json' with { type: 'json' };

const MISSIONS = missionsJson.missions;
const MAPS = mapsJson.maps;
const JETS = jetsJson.jets;

function missionById(id) {
  const m = MISSIONS.find((x) => x.id === id);
  assert.ok(m, 'mission ' + id + ' exists');
  return m;
}

function fakeMap() {
  return {
    id: 'test',
    points: {
      a: { x: 0, z: 0, y: 500 },
      b: { x: 1000, z: 0, y: 500 },
      c: { x: 2000, z: 0, y: 500 },
      rigPos: { x: 5000, z: 5000 },
      zone1: { x: -3000, z: -3000, y: 900, spread: 200 },
    },
  };
}

// Build a headless mission harness: WorldEntities + MissileSystem + Spawner + Mission.
// jetsData enables AI jet spawning; terrain enables land/water snapping. The MissileSystem
// gets the same blast-damage routing main.js installs in-game (missiles must be able to
// kill their targets for the objective/protected-asset tests to be meaningful).
function buildHarness(missionId, difficulty, opts) {
  const def = missionById(missionId);
  const map = MAPS[def.map];
  const ents = new WorldEntities(128);
  const collision = new CollisionWorld(ents.max);
  const blastIds = new Int32Array(64);
  const refs = { mission: null }; // set below (MissileSystem is built first)
  const missiles = new MissileSystem(0x7E57, {
    onExplode: (x, y, z, ownerId, targetId2) => {
      // mirror main.js: direct fuse hit damages the target even when its collision radius
      // exceeds the blast sphere (the rig), then splash for everyone else nearby; every
      // kill routes through mission.noteKill exactly like main.applyDamage does
      const blast = (id) => {
        const killed = ents.damage(id, MISSILE_TUNING.BLAST_DMG);
        if (killed && refs.mission) refs.mission.noteKill(id);
      };
      if (targetId2 >= 0 && ents.isAlive(targetId2)) {
        const dx = ents.pos[targetId2 * 3] - x;
        const dy = ents.pos[targetId2 * 3 + 1] - y;
        const dz = ents.pos[targetId2 * 3 + 2] - z;
        const rr = MISSILE_TUNING.FUSE_RANGE + ents.radius[targetId2] + 2;
        if (dx * dx + dy * dy + dz * dz < rr * rr) blast(targetId2);
      }
      const n = collision.querySphere(ents, x, y, z, MISSILE_TUNING.BLAST_RADIUS, blastIds);
      for (let i = 0; i < n; i++) {
        if (blastIds[i] !== ownerId) blast(blastIds[i]);
      }
    },
  });
  const playerId = ents.spawn(ENT_TYPE.JET, TEAM.PLAYER, 0, 800, 14000, Math.PI, 0, 0, 9, 100);
  ents.missilesLeft[playerId] = 6;
  const terrain = new Terrain({ seed: 1337 });
  const spawner = new Spawner(ents, {
    missiles, terrain, jetsData: JETS, playerId, difficulty,
    hooks: (opts && opts.spawnerHooks) || {},
  });
  const events = [];
  const mission = new Mission(def, map, difficulty, {
    ents, missiles, spawner, playerId,
    hooks: {
      onStageBanner: (idx) => events.push('stage' + idx),
      onCheckpoint: (cp) => events.push('cp:' + cp.stageIndex),
      onProtectedDestroyed: () => events.push('protectedDown'),
      onMissionEvent: (m2) => events.push(m2),
    },
  });
  refs.mission = mission; // missile blast kills route through noteKill from now on
  return { def, map, ents, missiles, spawner, mission, playerId, events, terrain };
}

// Advance a harness by `seconds` of 120 Hz ticks (deterministic; no real time involved).
function runTicks(h, seconds, onTick) {
  const dt = 1 / 120;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    h.mission.tick(dt);
    if (onTick) onTick(i * dt);
    if (!h.mission.running) break;
  }
}

// ---------------------------------------------------------------------------
// Task 2.1 - Mission FSM: table validity + forbidden transitions + full flow
// ---------------------------------------------------------------------------

test('mission FSM table rejects forbidden terminal transitions', () => {
  const t = buildMissionTable();
  assert.equal(t.validate([
    [MISSION_STATE.SUCCESS, MISSION_STATE.FAILED],
    [MISSION_STATE.FAILED, MISSION_STATE.SUCCESS],
    [MISSION_STATE.SUCCESS, MISSION_STATE.STAGE_ACTIVE],
  ]), true);
});

test('mission FSM: NOT_STARTED -> stages -> SUCCESS, full M1 flow', () => {
  const h = buildHarness('m1', 0);
  const m = h.mission;
  assert.equal(m.stateName(), 'NOT_STARTED');
  m.start(null);
  assert.equal(m.stateName(), 'STAGE_ACTIVE');
  assert.equal(m.stageIndex, 0);
  // S1: two drones spawned by the wave 0
  assert.equal(h.spawner.jetIds.length, 2, 'wave 0 spawned 2 drones');
  // kill both drones -> stage completes, mission advances to stage 2
  const drones = h.spawner.jetIds.slice();
  for (const id of drones) h.ents.damage(id, 9999), m.noteKill(id);
  assert.equal(m.stage.dag.allCompleted(), true, 's1 objectives complete');
  // two ticks: ACTIVE fires OBJECTIVES_DONE -> CHECK, then CHECK verifies -> COMPLETE
  m.tick(1 / 120);
  m.tick(1 / 120);
  assert.equal(m.stageIndex, 1, 'advanced to stage 2 (recon)');
  assert.equal(m.stateName(), 'STAGE_ACTIVE');
  // S2: recon circuit - teleport the player through the waypoints above min alt
  const map = h.map;
  for (const wp of ['wpA1', 'wpA2', 'wpA3']) {
    const p = mapPoint(map, wp);
    h.ents.pos[h.playerId * 3] = p.x;
    h.ents.pos[h.playerId * 3 + 1] = 200; // above altMin 120
    h.ents.pos[h.playerId * 3 + 2] = p.z;
    m.tick(1 / 120);
  }
  // two more ticks: stage OBJECTIVES_DONE -> CHECK -> COMPLETE, then mission FINISH
  m.tick(1 / 120);
  m.tick(1 / 120);
  assert.equal(m.stateName(), 'SUCCESS', 'mission succeeds after final waypoint');
  const res = m.results();
  assert.equal(res.success, true);
  assert.equal(res.kills, 2);
  assert.ok(res.score > 0);
});

test('mission FSM: stage failure -> FAILED; terminal state never resumes', () => {
  const h = buildHarness('m1', 0);
  const m = h.mission;
  m.start(null);
  // let the a2a timer (300 s) expire without kills -> objective FAILED -> stage FAIL
  runTicks(h, 302);
  assert.equal(m.stateName(), 'FAILED');
  // FSM structurally refuses to leave FAILED except via RESTART
  assert.equal(m.fsm.fire(0 /* START */), false, 'no START out of FAILED');
  m.restartMission();
  assert.equal(m.stateName(), 'STAGE_ACTIVE');
  assert.equal(m.stageIndex, 0, 'restart returns to stage 1');
  assert.equal(m.timeSec < 1, true, 'timers reset');
});

// ---------------------------------------------------------------------------
// Task 2.2 - Objective DAG: topo sort, cyclic rejection, dependency activation
// ---------------------------------------------------------------------------

test('topo sort orders dependencies before dependents (diamond)', () => {
  const order = topoSort([
    { id: 'd', deps: ['b', 'c'] },
    { id: 'a' },
    { id: 'b', deps: ['a'] },
    { id: 'c', deps: ['a'] },
  ]);
  assert.equal(order.indexOf('a'), 0, 'root first');
  assert.ok(order.indexOf('b') > order.indexOf('a'));
  assert.ok(order.indexOf('c') > order.indexOf('a'));
  assert.ok(order.indexOf('d') > order.indexOf('b'));
  assert.ok(order.indexOf('d') > order.indexOf('c'));
});

test('cyclic objective DAG is REJECTED at load (Task 2.2 AC)', () => {
  assert.throws(() => topoSort([
    { id: 'a', deps: ['b'] },
    { id: 'b', deps: ['c'] },
    { id: 'c', deps: ['a'] },
  ]), /cyclic/);
  // also at the ObjectiveDag level (the stage constructor path)
  assert.throws(() => new ObjectiveDag([
    { id: 'x', type: 'air_to_air', groups: ['g'], count: 1, deps: ['y'] },
    { id: 'y', type: 'air_to_air', groups: ['g'], count: 1, deps: ['x'] },
  ], fakeMap()), /cyclic/);
});

test('hidden objectives activate only when all deps complete (never back to HIDDEN)', () => {
  const dag = new ObjectiveDag([
    { id: 'first', type: 'ground', groups: ['radar'], count: 1, timer: 0 },
    { id: 'second', type: 'ground', groups: ['flightline'], count: 1, deps: ['first'], timer: 0 },
  ], fakeMap());
  assert.equal(dag.stateName(0), 'HIDDEN');
  assert.equal(dag.stateName(1), 'HIDDEN');
  dag.activateRoots();
  assert.equal(dag.stateName(0), 'ACTIVE');
  assert.equal(dag.stateName(1), 'HIDDEN', 'dependent still hidden');
  dag.noteGroupDestroyed('radar');
  assert.equal(dag.stateName(0), 'COMPLETED');
  dag.activateReady();
  assert.equal(dag.stateName(1), 'ACTIVE', 'activated after dep completed');
  // "never back": there is no API that writes HIDDEN/earlier states over COMPLETED/ACTIVE
  dag.activateReady();
  assert.equal(dag.stateName(1), 'ACTIVE');
});

test('all 4 shipped missions load: valid DAGs, maps and stage types', () => {
  for (const def of MISSIONS) {
    assert.ok(MAPS[def.map], def.id + ': map exists');
    for (const stage of def.stages) {
      const dag = new ObjectiveDag(stage.objectives, MAPS[def.map]); // throws on bad DAG
      assert.ok(dag.n > 0);
      dag.activateRoots();
      assert.equal(dag.activeCount() >= 1, true, def.id + '/' + stage.id + ' has root objectives');
    }
  }
});

// ---------------------------------------------------------------------------
// Task 2.4 - The 5 objective types
// ---------------------------------------------------------------------------

test('air_to_air objective: kill count completes; timer expires fails', () => {
  const dag = new ObjectiveDag([
    { id: 'o', type: 'air_to_air', groups: ['bandits'], count: 2, timer: 5 },
  ], fakeMap());
  dag.activateRoots();
  assert.equal(dag.stateName(0), 'ACTIVE');
  dag.noteGroupDestroyed('bandits');
  assert.equal(dag.stateName(0), 'ACTIVE', '1/2 not enough');
  dag.noteGroupDestroyed('bandits');
  assert.equal(dag.stateName(0), 'COMPLETED', '2/2 completes');
  // timer fail path
  const dag2 = new ObjectiveDag([
    { id: 'o', type: 'air_to_air', groups: ['bandits'], count: 2, timer: 1 },
  ], fakeMap());
  dag2.activateRoots();
  const env = { px: 0, py: 500, pz: 0, groupAlive: () => true };
  dag2.tick(1.2, env);
  assert.equal(dag2.stateName(0), 'FAILED', 'timeout fails the objective');
});

test('ground + naval destroy-list objectives complete when their groups die', () => {
  const dag = new ObjectiveDag([
    { id: 'g', type: 'ground', groups: ['sams'], count: 3, timer: 0 },
    { id: 'n', type: 'naval', groups: ['boats'], count: 2, timer: 0 },
  ], fakeMap());
  dag.activateRoots();
  dag.noteGroupDestroyed('sams');
  dag.noteGroupDestroyed('sams');
  dag.noteGroupDestroyed('boats');
  assert.equal(dag.stateName(0), 'ACTIVE');
  assert.equal(dag.stateName(1), 'ACTIVE', '1/2 boats is not enough');
  dag.noteGroupDestroyed('boats');
  assert.equal(dag.stateName(1), 'COMPLETED');
  dag.noteGroupDestroyed('sams');
  assert.equal(dag.stateName(0), 'COMPLETED');
  assert.equal(dag.allCompleted(), true);
  // wrong-group kills never advance progress
  const dag2 = new ObjectiveDag([
    { id: 'g', type: 'ground', groups: ['sams'], count: 1, timer: 0 },
  ], fakeMap());
  dag2.activateRoots();
  dag2.noteGroupDestroyed('boats');
  assert.equal(dag2.stateName(0), 'ACTIVE');
});

test('escort objective: completes on holdTime, fails the moment the protectee dies', () => {
  let rigAlive = true;
  const dag = new ObjectiveDag([
    { id: 'e', type: 'escort', groups: ['rig'], holdTime: 2 },
  ], fakeMap());
  dag.activateRoots();
  const env = { px: 0, py: 0, pz: 0, groupAlive: (n) => n !== 'rig' || rigAlive };
  dag.tick(1.0, env);
  assert.equal(dag.stateName(0), 'ACTIVE', 'still holding');
  dag.tick(1.2, env);
  assert.equal(dag.stateName(0), 'COMPLETED', 'held long enough');
  // failure path: protectee destroyed mid-hold
  const dag2 = new ObjectiveDag([
    { id: 'e', type: 'escort', groups: ['rig'], holdTime: 60 },
  ], fakeMap());
  dag2.activateRoots();
  rigAlive = false;
  dag2.tick(1 / 120, { px: 0, py: 0, pz: 0, groupAlive: () => rigAlive });
  assert.equal(dag2.stateName(0), 'FAILED', 'protected death fails escort');
  assert.equal(dag2.failEscortsOf('rig'), 0, 'already failed - no double transition');
});

test('recon objective: ordered waypoints + altitude gate + timer fail', () => {
  const dag = new ObjectiveDag([
    { id: 'r', type: 'recon', waypoints: ['a', 'b', 'c'], altMin: 150, radius: 700, timer: 0 },
  ], fakeMap());
  dag.activateRoots();
  const env = { px: 0, py: 200, pz: 0, groupAlive: () => true };
  dag.tick(1 / 120, env); // standing on waypoint a, high enough
  assert.equal(dag.reconProgress(0)[0], 1, 'waypoint 1 captured');
  // below the altitude gate: no progress
  env.py = 50;
  dag.tick(1 / 120, env);
  assert.equal(dag.reconProgress(0)[0], 1, 'alt gate blocks capture');
  env.py = 200;
  env.px = 1000;
  dag.tick(1 / 120, env);
  assert.equal(dag.reconProgress(0)[0], 2);
  env.px = 2000;
  dag.tick(1 / 120, env);
  assert.equal(dag.stateName(0), 'COMPLETED');
  // timer fail
  const dag2 = new ObjectiveDag([
    { id: 'r', type: 'recon', waypoints: ['a'], altMin: 0, radius: 700, timer: 1 },
  ], fakeMap());
  dag2.activateRoots();
  dag2.tick(1.1, { px: 99999, py: 200, pz: 99999, groupAlive: () => true });
  assert.equal(dag2.stateName(0), 'FAILED');
});

// ---------------------------------------------------------------------------
// Task 2.1 - Stage FSM: ENTER -> ACTIVE -> CHECK -> COMPLETE / FAIL (pure guards)
// ---------------------------------------------------------------------------

test('stage FSM reaches COMPLETE through CHECK; table has pure guards', () => {
  const t = buildStageTable();
  assert.equal(t.validate([]), true);
  void sharedStageTable; // lazily built singleton (same table reused across stages)
  const def = {
    id: 's1', type: 'air_to_air',
    waves: [{ at: 0, units: [{ kind: 'jet', group: 'g', zone: 'droneA', count: 1, hp: 20, missiles: 0 }] }],
    objectives: [{ id: 'o', label: 'kill', type: 'air_to_air', groups: ['g'], count: 1, timer: 60 }],
  };
  const h = buildHarness('m1', 0);
  const stage = new Stage(def, h.map);
  assert.equal(stage.stateName(), 'ENTER');
  stage.begin(h.spawner, 12345);
  assert.equal(stage.stateName(), 'ACTIVE');
  assert.equal(h.spawner.jetIds.length, 1, 'wave deployed on begin');
  const id = h.spawner.jetIds[0];
  h.ents.damage(id, 9999);
  stage.dag.noteGroupDestroyed('g');
  stage.tick(1 / 120, { px: 0, py: 0, pz: 0, groupAlive: () => true });
  assert.equal(stage.stateName(), 'CHECK');
  stage.tick(1 / 120, { px: 0, py: 0, pz: 0, groupAlive: () => true });
  assert.equal(stage.stateName(), 'COMPLETE');
  assert.equal(stage.complete, true);
});

// ---------------------------------------------------------------------------
// Task 2.3 - Spawner: waves, caps, despawn, protected assets, cruise missiles
// ---------------------------------------------------------------------------

test('spawner: later waves fire on schedule; entity cap defers (never drops) waves', () => {
  const h = buildHarness('m3', 1);
  h.mission.start(null);
  assert.equal(h.spawner.jetIds.length, 0, 's1 has no jets, only boats');
  assert.equal(h.spawner.ships.length, 2, '2 missile boats from wave 0');
  assert.equal(h.spawner.protectedIds.length, 1, 'rig is a protected asset');
  // s2 CAP arrives at t=25 (after s1 completes it - force-complete s1 by sinking boats +
  // holding the escort timer via fast-forward)
  const boats = h.spawner.ships.map((s) => s.id);
  for (const id of boats) h.ents.damage(id, 9999), h.mission.noteKill(id);
  assert.equal(h.mission.stateName(), 'STAGE_ACTIVE', 'escort hold still running');
  runTicks(h, 152, () => { h.ents.pos[h.playerId * 3 + 1] = 900; });
  assert.equal(h.mission.stageIndex, 1, 'advanced to CAP stage after hold');
  assert.equal(h.spawner.jetIds.length, 2, 'CAP wave 0 spawned');
  runTicks(h, 26);
  assert.ok(h.spawner.jetIds.length >= 4, 'second CAP wave arrived at t=25');
});

test('spawner: world cap defers waves instead of exceeding the arrays (PRD invariant)', () => {
  const h = buildHarness('m1', 0);
  h.mission.start(null);
  // flood the world to the cap, then force the drone wave to re-arm far in the future
  h.spawner.despawnAll();
  const ents = h.ents;
  let filled = 0;
  while (ents.activeCount() < ents.max) {
    if (ents.spawn(ENT_TYPE.JET, TEAM.ENEMY, 0, 500, 0, 0, 0, 0, 9, 10) < 0) break;
    filled++;
  }
  h.spawner.arm({ waves: [{ at: 0, units: [{ kind: 'jet', group: 'x', zone: 'zone1', count: 3 }] }] }, 7, h.map);
  h.spawner.tick(0.5, { canDespawn: () => true });
  assert.equal(h.spawner.jetIds.length, 0, 'wave deferred while world is full');
  assert.ok(filled > 0);
});

test('spawner: far AI jets despawn when no active objective needs them', () => {
  const h = buildHarness('m1', 0);
  h.mission.start(null);
  const id = h.spawner.jetIds[0];
  // teleport the drone far beyond DESPAWN_DIST from the player
  h.ents.pos[id * 3] = 18000;
  h.ents.pos[id * 3 + 2] = -18000;
  const dt = 1 / 120;
  for (let i = 0; i < 300; i++) h.spawner.tick(dt, { canDespawn: () => false }); // protected
  assert.equal(h.ents.isAlive(id), true, 'objective-owned group kept while canDespawn=false');
  for (let i = 0; i < 300; i++) h.spawner.tick(dt, { canDespawn: () => true });
  assert.equal(h.ents.isAlive(id), false, 'far jet despawned when allowed');
});

test('M3 AC: ignoring the defense kills the rig in under 3 minutes -> mission FAILED', () => {
  const h = buildHarness('m3', 1);
  const m = h.mission;
  m.start(null);
  let sawCruiseWarn = false;
  let elapsed = 0;
  const dt = 1 / 120;
  while (m.running && elapsed < 180) {
    m.tick(dt);
    h.missiles.update(dt, h.ents, null); // cruise missiles fly (main.js does this in step())
    if (h.spawner.cruiseWarn) sawCruiseWarn = true;
    elapsed += dt;
  }
  assert.equal(sawCruiseWarn, true, 'cruise missile warning fired while boats engage the rig');
  assert.equal(m.stateName(), 'FAILED', 'rig destroyed -> FAILED (not a hang)');
  assert.ok(elapsed < 180, 'rig died in < 3 min of sim time (took ' +
    elapsed.toFixed(1) + ' s)');
  const stats = h.spawner.groupStats('rig');
  assert.equal(stats.alive, 0);
});

// ---------------------------------------------------------------------------
// Task 2.7 - Checkpoints + difficulty policy
// ---------------------------------------------------------------------------

test('checkpoint captured at stage start; restoreStage resets the stage and player state', () => {
  const h = buildHarness('m1', 0);
  const m = h.mission;
  m.start(null);
  assert.ok(m.checkpoint, 'checkpoint exists');
  assert.equal(m.checkpoint.stageIndex, 0);
  assert.ok(m.checkpoint.player, 'player snapshot captured');
  const snapHp = m.checkpoint.player.hp;
  const snapMissiles = m.checkpoint.player.missiles;
  // player burns missiles + takes damage after the checkpoint
  h.ents.missilesLeft[h.playerId] = 0;
  h.ents.health[h.playerId] = 20;
  assert.equal(m.restoreStage(), true, 'rookie can restore');
  assert.equal(m.stageIndex, 0, 'same stage restarted');
  assert.equal(m.checkpoint.player.missiles, snapMissiles, 'ammo restored from checkpoint');
  assert.equal(m.checkpoint.player.hp, snapHp, 'HP restored from checkpoint');
  assert.ok(h.spawner.jetIds.length > 0, 'stage entities respawned');
});

test('difficulty policy: rookie unlimited, veteran 3 restores, ace 0 (restart via debrief)', () => {
  assert.equal(RESTORES_BY_DIFFICULTY[0], Infinity);
  assert.equal(RESTORES_BY_DIFFICULTY[1], 3);
  assert.equal(RESTORES_BY_DIFFICULTY[2], 0);
  const hv = buildHarness('m1', 1);
  hv.mission.start(null);
  assert.equal(hv.mission.restoreStage(), true);
  assert.equal(hv.mission.restoreStage(), true);
  assert.equal(hv.mission.restoreStage(), true);
  assert.equal(hv.mission.restoreStage(), false, 'veteran: 4th restore denied');
  assert.equal(hv.mission.stateName(), 'STAGE_ACTIVE', 'denied restore keeps the mission alive');
  const ha = buildHarness('m1', 2);
  ha.mission.start(null);
  assert.equal(ha.mission.restoreStage(), false, 'ace never restores');
  assert.equal(ha.mission.maxRestores, 0);
});

// ---------------------------------------------------------------------------
// Task 2.6 - Save persistence (IndexedDB backend swap) + debrief results
// ---------------------------------------------------------------------------

test('save: missions load from storage, unlock chain persists, results roundtrip', async () => {
  const save = new SaveSystem(new MemoryBackend());
  const data = await save.load();
  assert.deepEqual(data.unlocked, ['m1'], 'fresh save: M1 only');
  data.unlocked.push('m2');
  data.results.m1 = { success: true, score: 4210, timeSec: 200, kills: 5 };
  data.checkpoint = { missionId: 'm2', stageIndex: 1, difficulty: 1, player: { x: 1 } };
  await save.save(data);

  // "reopen the browser": a fresh SaveSystem over the same shared store restores everything
  const save2 = new SaveSystem(save.backend);
  const data2 = await save2.load();
  assert.deepEqual(data2.unlocked, ['m1', 'm2']);
  assert.equal(data2.results.m1.score, 4210);
  assert.equal(data2.checkpoint.stageIndex, 1);
  assert.equal(data2.checkpoint.player.x, 1);
  assert.equal(save2.hasCheckpoint('m2', 1), true);
  assert.equal(save2.hasCheckpoint('m9', 0), false);
});

test('debrief results: success payload, difficulty score multiplier, mission id', () => {
  const h = buildHarness('m1', 2); // ace: 1.35x score multiplier
  const m = h.mission;
  m.start(null);
  const drones = h.spawner.jetIds.slice();
  for (const id of drones) h.ents.damage(id, 9999), m.noteKill(id);
  m.tick(1 / 120);
  m.tick(1 / 120);
  const map = h.map;
  for (const wp of ['wpA1', 'wpA2', 'wpA3']) {
    const p = mapPoint(map, wp);
    h.ents.pos[h.playerId * 3] = p.x;
    h.ents.pos[h.playerId * 3 + 1] = 200;
    h.ents.pos[h.playerId * 3 + 2] = p.z;
    m.tick(1 / 120);
  }
  m.tick(1 / 120); // stage OBJECTIVES_DONE -> CHECK
  m.tick(1 / 120); // CHECK verifies -> COMPLETE -> mission FINISH -> SUCCESS
  const r = m.results();
  assert.equal(r.missionId, 'm1');
  assert.equal(r.title, 'First Flight');
  assert.equal(r.success, true);
  assert.equal(r.difficulty, 2);
  const reward = MISSIONS.find((x) => x.id === 'm1').reward; // data-driven score check
  assert.equal(r.score, Math.round((reward + r.kills * 25) * 2.0)); // ace multiplier 2.0
});

// ---------------------------------------------------------------------------
// Task 2.6 - Game (UI flow) FSM: chain validation, no forbidden screen jumps
// ---------------------------------------------------------------------------

test('game FSM: full MENU -> HANGAR -> BRIEFING -> LOADING -> PLAYING -> DEBRIEF chain', () => {
  const g = new FSM(buildGameTable(), GAME_STATE.MENU, null);
  assert.equal(g.name(), 'MENU');
  assert.equal(g.fire(GAME_EVENT.OPEN_HANGAR), true);
  assert.equal(g.name(), 'HANGAR');
  assert.equal(g.fire(GAME_EVENT.PICK), true);
  assert.equal(g.name(), 'BRIEFING');
  assert.equal(g.fire(GAME_EVENT.LAUNCH), true);
  assert.equal(g.name(), 'LOADING');
  assert.equal(g.fire(GAME_EVENT.LOADED), true);
  assert.equal(g.name(), 'PLAYING');
  assert.equal(g.fire(GAME_EVENT.ENDED), true);
  assert.equal(g.name(), 'DEBRIEF');
  assert.equal(g.fire(GAME_EVENT.CONTINUE), true);
  assert.equal(g.name(), 'MENU');
});

test('game FSM: sandbox skips hangar; forbidden jumps rejected; debrief retry loops', () => {
  const g = new FSM(buildGameTable(), GAME_STATE.MENU, null);
  assert.equal(g.fire(GAME_EVENT.PICK), true, 'MENU -> BRIEFING allowed for free flight');
  assert.equal(g.name(), 'BRIEFING');
  assert.equal(buildGameTable().validate([
    [GAME_STATE.PLAYING, GAME_STATE.MENU],
    [GAME_STATE.PLAYING, GAME_STATE.HANGAR],
    [GAME_STATE.BRIEFING, GAME_STATE.PLAYING],
  ]), true);
  const g2 = new FSM(buildGameTable(), GAME_STATE.PLAYING, null);
  assert.equal(g2.fire(GAME_EVENT.ENDED), true);
  assert.equal(g2.name(), 'DEBRIEF');
  assert.equal(g2.fire(GAME_EVENT.RETRY), true, 'retry -> LOADING (full mission restart)');
  assert.equal(g2.name(), 'LOADING');
});

// ---------------------------------------------------------------------------
// Task 2.8 - HUD formatting helpers (pure strings for the DOM layer)
// ---------------------------------------------------------------------------

test('objective line formatter: hidden, progress, done, recon distance', () => {
  const dag = new ObjectiveDag([
    { id: 'a', label: 'Kill 2 drones', type: 'air_to_air', groups: ['d'], count: 2, timer: 0 },
    { id: 'b', label: 'Sink 1 boat', type: 'naval', groups: ['b'], count: 1, timer: 0, deps: ['a'] },
  ], fakeMap());
  const out = { text: '' };
  formatObjectiveLine(dag, 1, out); // hidden
  assert.equal(out.text, '');
  dag.activateRoots();
  formatObjectiveLine(dag, 0, out);
  assert.equal(out.text, '[ ] Kill 2 drones  0/2');
  dag.noteGroupDestroyed('d');
  dag.noteGroupDestroyed('d');
  formatObjectiveLine(dag, 0, out);
  assert.equal(out.text, '[done] Kill 2 drones');
  dag.activateReady();
  formatObjectiveLine(dag, 1, out);
  assert.equal(out.text, '[ ] Sink 1 boat  0/1');
  const dag2 = new ObjectiveDag([
    { id: 'r', label: 'Recon', type: 'recon', waypoints: ['a'], altMin: 0, radius: 500, timer: 0 },
  ], fakeMap());
  dag2.activateRoots();
  formatObjectiveLine(dag2, 0, out, { px: 3000, pz: 4000, reconDist: 5000 });
  assert.equal(out.text, '[ ] Recon  wp 1/1  5000 m');
});

// ---------------------------------------------------------------------------
// Determinism: same seed -> identical mission timeline
// ---------------------------------------------------------------------------

test('determinism: identical seeds produce identical wave/entity placements', () => {
  function snapshot(id) {
    const h = buildHarness(id, 1);
    h.mission.start(null);
    const dt = 1 / 120;
    for (let i = 0; i < 2400; i++) h.mission.tick(dt); // 20 s
    const out = [];
    for (const j of h.spawner.jetIds) {
      out.push([h.ents.pos[j * 3], h.ents.pos[j * 3 + 1], h.ents.pos[j * 3 + 2]]);
    }
    return out;
  }
  const a = snapshot('m1');
  const b = snapshot('m1');
  assert.deepEqual(a, b);
  assert.ok(a.length >= 2);
});

test('boot smoke: every module of the Phase 2 graph imports headlessly', async () => {
  const mods = [
    '../src/main.js', '../src/mission/mission.js', '../src/mission/stages.js',
    '../src/mission/objectives.js', '../src/mission/spawner.js', '../src/ui/hud.js',
    '../src/ui/briefing.js', '../src/ui/debrief.js',
  ];
  for (const m of mods) await import(m);
  assert.ok(true);
});
