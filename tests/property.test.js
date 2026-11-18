// Skyburn Phase 4 - Property tests (Task 4.3) + seeded-replay determinism (Task 4.4).
// PRD/PLAN: "10000 random flight/missile/collision, no NaN, no teleport >500m/tick,
// speed <= maxSpeed*1.05" + the PRD Part C critical invariants (pool caps, owner-immune
// missiles, DAG acyclic, FSM forbidden pairs) + "replay 100 identical hash".
// All seeded (mulberry32) and headless; fixed 120 Hz ticks like the real loop.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FlightModel } from '../src/physics/flight.js';
import { WorldEntities, Pool, ENT_TYPE, TEAM } from '../src/combat/entities.js';
import {
  MissileSystem, MISSILE_TUNING, buildMissileTable,
} from '../src/combat/missiles.js';
import { CollisionWorld } from '../src/combat/collision.js';
import { topoSort } from '../src/mission/objectives.js';
import { buildGameTable, GAME_STATE, GAME_EVENT } from '../src/main.js';
import {
  Mission, buildMissionTable, MISSION_STATE,
} from '../src/mission/mission.js';
import { Spawner } from '../src/mission/spawner.js';
import { buildAITable, AI_STATE, AI_EVENT } from '../src/ai/enemy.js';
import { mulberry32, Terrain } from '../src/world/terrain.js';
import {
  assertFinite1, assertRange, assertPool, auditPool,
  getViolationCount, resetInvariants,
} from '../src/verify/invariants.js';
import jetsJson from '../src/data/jets.json' with { type: 'json' };
import missionsJson from '../src/data/missions.json' with { type: 'json' };
import mapsJson from '../src/data/maps.json' with { type: 'json' };

const JETS = jetsJson.jets;
const F16 = JETS.find((j) => j.id === 'f16c') || JETS[0];
const MISSIONS = missionsJson.missions;
const MAPS = mapsJson.maps;
const dt = 1 / 120;
const TELEPORT_BOUND = 500; // PRD: no teleport > 500 m per tick

function finite3(x, y, z) {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}

// ---------------------------------------------------------------------------
// Property 1 - flight model under 10000 random inputs
// ---------------------------------------------------------------------------

test('property flight: 10k random inputs - no NaN, no teleport >500m/tick, speed <= max*1.05', () => {
  const rand = mulberry32(0xA11CE);
  const f = new FlightModel(F16, { x: 0, y: 3000, z: 0, yaw: 0, throttle: 1.0 });
  let px = f.pos[0], py = f.pos[1], pz = f.pos[2];
  for (let i = 0; i < 10000; i++) {
    f.tick(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1,
      rand() > 0.5, rand() > 0.8, dt);
    assert.ok(finite3(f.pos[0], f.pos[1], f.pos[2]), 'finite position @' + i);
    assert.ok(finite3(f.rot[0], f.rot[1], f.rot[2]), 'finite rotation @' + i);
    assert.ok(Number.isFinite(f.speed), 'finite speed @' + i);
    const dx = f.pos[0] - px, dy = f.pos[1] - py, dz = f.pos[2] - pz;
    const moved2 = dx * dx + dy * dy + dz * dz;
    assert.ok(moved2 < TELEPORT_BOUND * TELEPORT_BOUND,
      'no teleport @' + i + ': moved ' + Math.sqrt(moved2).toFixed(1) + ' m in one tick');
    px = f.pos[0]; py = f.pos[1]; pz = f.pos[2];
    assert.ok(f.speed <= f.maxSpeed * 1.05 + 1e-6,
      'speed cap @' + i + ': ' + f.speed + ' > ' + f.maxSpeed * 1.05);
    assert.ok(f.speed >= 24.9, 'arcade floor @' + i);
  }
});

// ---------------------------------------------------------------------------
// Property 2 - missiles: 10k random launches, every missile completes the
// lifecycle (EXPLODE), owner is immune, pool caps hold
// ---------------------------------------------------------------------------

test('property missiles: 10k random launches - lifecycle always EXPLODEs, owner immune', () => {
  const rand = mulberry32(0xB0B);
  const ents = new WorldEntities(64);
  const player = ents.spawn(ENT_TYPE.JET, TEAM.PLAYER, 0, 1000, 0, 0, 0, 0, 9, 100);
  const targets = [];
  for (let i = 0; i < 6; i++) {
    targets.push(ents.spawn(ENT_TYPE.JET, TEAM.ENEMY,
      (rand() - 0.5) * 6000, 800 + rand() * 1500, (rand() - 0.5) * 6000, 0, 0, 0, 9, 100));
  }
  let spawned = 0;
  let ownerHits = 0;
  const ms = new MissileSystem(0xF00D, {
    onExplode: (x, y, z, ownerId, targetId2) => {
      // mirror main.js routing: the fuse target takes damage, the owner NEVER does
      if (targetId2 === ownerId) ownerHits++;
      if (targetId2 >= 0 && targetId2 !== ownerId && ents.isAlive(targetId2)) {
        ents.damage(targetId2, MISSILE_TUNING.BLAST_DMG);
      }
      void x; void y; void z;
    },
  });
  for (let i = 0; i < 10000; i++) {
    if (i % 10 === 0 && ms.activeCount() < MISSILE_TUNING.MAX_MISSILES) {
      const shooter = rand() < 0.5 ? player : targets[(rand() * targets.length) | 0];
      // caller contract (lock-on + cruise behave this way): never target the shooter
      let tgt = rand() < 0.15 ? -1 : targets[(rand() * targets.length) | 0];
      if (tgt === shooter) tgt = -1;
      const launch = ents.speed[shooter] + 30 + rand() * 200;
      const yawA = rand() * Math.PI * 2;
      const pitA = (rand() - 0.5) * 0.6;
      const mid = ms.spawn(shooter,
        ents.pos[shooter * 3], ents.pos[shooter * 3 + 1], ents.pos[shooter * 3 + 2],
        Math.cos(pitA) * Math.sin(yawA), Math.sin(pitA), -Math.cos(pitA) * Math.cos(yawA),
        launch, tgt);
      assert.ok(mid >= -1 && mid < MISSILE_TUNING.MAX_MISSILES, 'spawn slot in range');
      if (mid >= 0) spawned++;
    }
    ms.update(dt, ents, null);
    if ((i & 31) === 0) {
      assert.ok(ms.activeCount() >= 0 && ms.activeCount() <= MISSILE_TUNING.MAX_MISSILES,
        'missile pool cap @' + i);
      assert.ok(finite3(ents.pos[player * 3], ents.pos[player * 3 + 1], ents.pos[player * 3 + 2]),
        'player finite @' + i);
    }
  }
  assert.equal(ownerHits, 0, 'a missile never damaged its owner (PRD invariant)');
  // lifecycle completion: stop spawning; LIFE=9 s guarantees every missile reaches
  // EXPLODE -> RECYCLE -> freed (PRD: missile always EXPLODE/RECYCLE)
  for (let i = 0; i < Math.ceil(11 / dt); i++) ms.update(dt, ents, null);
  assert.equal(ms.activeCount(), 0,
    'every missile completed its lifecycle (spawned ' + spawned + ')');
  assert.ok(spawned > 100, 'fuzz actually launched missiles (got ' + spawned + ')');
  assert.equal(auditPool(ms.pool), null, 'missile pool structurally consistent');
});

// ---------------------------------------------------------------------------
// Property 3 - world registry + pools under 10k random churn
// ---------------------------------------------------------------------------

test('property registry: 10k random spawn/kill/damage/alloc/free churn - caps + integrity', () => {
  const rand = mulberry32(0xC0DE);
  const ents = new WorldEntities(32);
  const pool = new Pool(16);
  const poolIds = [];
  for (let i = 0; i < 10000; i++) {
    const op = rand();
    if (op < 0.35) {
      const type = [ENT_TYPE.JET, ENT_TYPE.SHIP, ENT_TYPE.GROUND][(rand() * 3) | 0];
      const team = [TEAM.PLAYER, TEAM.ENEMY, TEAM.NEUTRAL][(rand() * 3) | 0];
      ents.spawn(type, team, (rand() - 0.5) * 20000, rand() * 5000, (rand() - 0.5) * 20000,
        rand() * 6.28, 0, 0, 5 + rand() * 60, 1 + rand() * 99);
    } else if (op < 0.55) {
      const id = (rand() * ents.max) | 0;
      if (ents.isAlive(id)) ents.kill(id);
    } else if (op < 0.8) {
      const id = (rand() * ents.max) | 0;
      if (ents.isAlive(id)) {
        const before = ents.health[id];
        ents.damage(id, rand() * 40);
        const after = ents.health[id];
        assert.ok(after >= 0 && after <= ents.maxHealth[id] + 1e-6,
          'health in [0, maxHealth] after damage @' + i);
        assert.ok(after < before || before <= 0, 'damage reduces or kills @' + i);
      }
    } else if (op < 0.9) {
      const id = pool.alloc();
      if (id >= 0) poolIds.push(id);
      assert.ok(poolIds.length <= 16, 'pool never over-allocates');
    } else if (poolIds.length > 0) {
      const k = (rand() * poolIds.length) | 0;
      pool.free(poolIds[k]);
      poolIds[k] = poolIds[poolIds.length - 1];
      poolIds.pop();
    }
    if ((i & 63) === 0) {
      assert.ok(ents.activeCount() <= ents.max, 'registry cap @' + i);
      assertPool('registry', pool);
    }
  }
  assert.equal(auditPool(pool), null, 'pool audit clean after churn');
  for (let id = 0; id < ents.count; id++) {
    if (ents.isAlive(id)) assertRange('health', ents.health[id], 0, ents.maxHealth[id] + 1e-6);
  }
  assert.equal(getViolationCount(), 0, 'no invariant violations during churn');
});

// ---------------------------------------------------------------------------
// Property 4 - collision queries on random layouts
// ---------------------------------------------------------------------------

test('property collision: 2000 random queries on random layouts - valid, deduped, bounded', () => {
  const rand = mulberry32(0xD00D1E);
  const ents = new WorldEntities(48);
  for (let i = 0; i < 40; i++) {
    ents.spawn(ENT_TYPE.JET, rand() < 0.5 ? TEAM.PLAYER : TEAM.ENEMY,
      (rand() - 0.5) * 24000, 100 + rand() * 4000, (rand() - 0.5) * 24000,
      0, 0, 0, 5 + rand() * 65, 100);
  }
  const col = new CollisionWorld(ents.max);
  const out = new Int32Array(64);
  const hit = { id: -1, dist: 0, px: 0, py: 0, pz: 0 };
  for (let q = 0; q < 2000; q++) {
    col.rebuild(ents);
    const x = (rand() - 0.5) * 24000, y = rand() * 4000, z = (rand() - 0.5) * 24000;
    const r = 10 + rand() * 290;
    const n = col.querySphere(ents, x, y, z, r, out);
    assert.ok(n >= 0 && n <= out.length, 'query count bounded @' + q);
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      const id = out[i];
      assert.ok(id >= 0 && id < ents.count && ents.isAlive(id), 'hit id valid @' + q);
      assert.ok(!seen.has(id), 'querySphere dedupes multi-cell entities @' + q);
      seen.add(id);
      const dx = ents.pos[id * 3] - x, dy = ents.pos[id * 3 + 1] - y,
        dz = ents.pos[id * 3 + 2] - z;
      const rr = r + ents.radius[id];
      assert.ok(dx * dx + dy * dy + dz * dz <= rr * rr + 1e-3,
        'reported hit is a true overlap @' + q);
    }
    const x1 = (rand() - 0.5) * 24000, y1 = rand() * 4000, z1 = (rand() - 0.5) * 24000;
    const got = col.segmentQuery(ents, x, y, z, x1, y1, z1, -1, -1, hit);
    if (got) {
      assert.ok(hit.dist >= 0 && Number.isFinite(hit.dist), 'segment hit distance finite');
      assert.ok(hit.id >= 0 && hit.id < ents.count, 'segment hit id valid');
    }
  }
});

// ---------------------------------------------------------------------------
// Property 5 - objective DAG: random acyclic accepted, cyclic rejected
// ---------------------------------------------------------------------------

test('property DAG: 1000 random acyclic DAGs sort; every cycle is rejected at load', () => {
  const rand = mulberry32(0x1DA6);
  for (let t = 0; t < 1000; t++) {
    const n = 2 + ((rand() * 6) | 0);              // 2..7 nodes
    const order = [];
    for (let i = 0; i < n; i++) order.push('n' + i);
    // shuffle ids, then only allow deps to EARLIER ids -> acyclic by construction
    for (let i = n - 1; i > 0; i--) {
      const k = (rand() * (i + 1)) | 0;
      const tmp = order[i]; order[i] = order[k]; order[k] = tmp;
    }
    const defs = order.map((id, i) => {
      const deps = [];
      for (let d = 0; d < i; d++) if (rand() < 0.3) deps.push(order[d]);
      return { id, deps };
    });
    const sorted = topoSort(defs);                   // must not throw
    assert.equal(sorted.length, n, 'all nodes sorted @' + t);
    const pos = new Map(sorted.map((id, i) => [id, i]));
    for (const def of defs) {
      for (const dep of def.deps) {
        assert.ok(pos.get(dep) < pos.get(def.id), 'deps first @' + t);
      }
    }
    if (t < 300 && n >= 2) {                         // cycle injection must throw
      const defs2 = defs.map((d) => ({ id: d.id, deps: d.deps.slice() }));
      defs2[defs2.length - 1].deps.push(defs2[0].id); // back edge last -> first
      defs2[0].deps.push(defs2[defs2.length - 1].id);
      assert.throws(() => topoSort(defs2), /cyclic|dep/i, 'cycle rejected @' + t);
    }
  }
});

// ---------------------------------------------------------------------------
// Property 6 - FSM tables: reachable-space closure never crosses a forbidden
// pair; terminal states are sinks; missile SPAWN always reaches EXPLODE
// ---------------------------------------------------------------------------

test('property FSM closure: reachable states never cross forbidden pairs (4 tables)', () => {
  const tables = [
    {
      name: 'game', build: buildGameTable, init: GAME_STATE.MENU,
      forbidden: [
        [GAME_STATE.MENU, GAME_STATE.PLAYING], [GAME_STATE.MENU, GAME_STATE.DEBRIEF],
        [GAME_STATE.MENU, GAME_STATE.LOADING], [GAME_STATE.MENU, GAME_STATE.PAUSED],
        [GAME_STATE.BRIEFING, GAME_STATE.PLAYING], [GAME_STATE.HANGAR, GAME_STATE.PLAYING],
        [GAME_STATE.PLAYING, GAME_STATE.MENU], [GAME_STATE.PLAYING, GAME_STATE.HANGAR],
        [GAME_STATE.DEBRIEF, GAME_STATE.PLAYING], [GAME_STATE.PAUSED, GAME_STATE.MENU],
        [GAME_STATE.PAUSED, GAME_STATE.HANGAR], [GAME_STATE.PAUSED, GAME_STATE.BRIEFING],
        [GAME_STATE.PAUSED, GAME_STATE.LOADING], [GAME_STATE.PAUSED, GAME_STATE.DEBRIEF],
      ],
      sinks: [],
    },
    {
      name: 'mission', build: buildMissionTable, init: MISSION_STATE.NOT_STARTED,
      forbidden: [
        [MISSION_STATE.SUCCESS, MISSION_STATE.FAILED],
        [MISSION_STATE.FAILED, MISSION_STATE.SUCCESS],
        [MISSION_STATE.SUCCESS, MISSION_STATE.STAGE_ACTIVE],
        [MISSION_STATE.FAILED, MISSION_STATE.STAGE_ACTIVE],
      ],
      // SUCCESS/FAILED are NOT absolute sinks: the debrief retry fires RESTART back to
      // NOT_STARTED. The invariant is that they never switch to each other and never
      // resume STAGE_ACTIVE - enforced by the forbidden pairs above.
      sinks: [],
    },
    {
      name: 'missile', build: buildMissileTable, init: 0 /* SPAWN */,
      forbidden: [[2, 0]], // GUIDE -> SPAWN (PRD invariant)
      sinks: [],
      mustReach: 7,        // EXPLODE
    },
    {
      name: 'ai', build: buildAITable, init: AI_STATE.PATROL,
      forbidden: [], sinks: [AI_STATE.DESTROYED],
    },
  ];
  for (const spec of tables) {
    const table = spec.build();
    // conservative reachable set: every DEFINED transition is traversable
    const seen = new Set([spec.init]);
    const queue = [spec.init];
    while (queue.length > 0) {
      const st = queue.shift();
      for (let ev = 0; ev < table.numEvents; ev++) {
        const entry = table.lookup(st, ev);
        if (!entry) continue;
        for (const [f, to] of spec.forbidden) {
          assert.ok(!(entry.from === f && entry.to === to),
            spec.name + ': forbidden transition ' + f + '->' + to + ' exists in table');
        }
        if (!seen.has(entry.to)) { seen.add(entry.to); queue.push(entry.to); }
      }
    }
    for (const s of spec.sinks) {
      for (let ev = 0; ev < table.numEvents; ev++) {
        assert.equal(table.lookup(s, ev), null,
          spec.name + ': sink state ' + s + ' has no outgoing transitions');
      }
    }
    if (spec.mustReach !== undefined) {
      assert.ok(seen.has(spec.mustReach),
        spec.name + ': EXPLODE reachable from SPAWN (PRD: missile always explodes)');
    }
  }
  assert.equal(AI_EVENT.COUNT, 7);
  assert.equal(GAME_EVENT.COUNT, 10);
});

// ---------------------------------------------------------------------------
// Task 4.4 - deterministic replay: 100 seeded runs produce identical hashes
// (fixed timestep + seeded RNG everywhere: missiles, spawner, AI, terrain)
// ---------------------------------------------------------------------------

function buildReplayHarness(missionId, seed) {
  const def = MISSIONS.find((m) => m.id === missionId);
  assert.ok(def, 'mission ' + missionId + ' exists');
  const map = MAPS[def.map];
  const ents = new WorldEntities(128);
  const collision = new CollisionWorld(ents.max);
  const blastIds = new Int32Array(64);
  const missiles = new MissileSystem(0x7E57 ^ seed, {
    onExplode: (x, y, z, ownerId, targetId2) => {
      const blast = (id) => ents.damage(id, MISSILE_TUNING.BLAST_DMG);
      if (targetId2 >= 0 && targetId2 !== ownerId && ents.isAlive(targetId2)) blast(targetId2);
      const n = collision.querySphere(ents, x, y, z, MISSILE_TUNING.BLAST_RADIUS, blastIds);
      for (let i = 0; i < n; i++) if (blastIds[i] !== ownerId) blast(blastIds[i]);
    },
  });
  const playerId = ents.spawn(ENT_TYPE.JET, TEAM.PLAYER, 0, 800, 14000, Math.PI, 0, 0, 9, 100);
  ents.missilesLeft[playerId] = 6;
  const terrain = new Terrain({ seed: 1337 });
  const spawner = new Spawner(ents, {
    missiles, terrain, jetsData: JETS, playerId, difficulty: 1,
  });
  const mission = new Mission(def, map, 1, { ents, missiles, spawner, playerId, hooks: {} });
  return { def, map, ents, missiles, spawner, mission, playerId, terrain, seed };
}

// FNV-1a over the sim state (positions, health, pools, FSM states, timers).
function hashHarnessState(h, h0) {
  let hash = (h0 === undefined ? 0x811c9dc5 : h0) >>> 0;
  const mix = (v) => { hash = Math.imul(hash ^ (v | 0), 0x01000193) >>> 0; };
  const mixF = (v) => mix(Math.round(v * 8));
  const e = h.ents;
  for (let i = 0; i < e.count * 3; i++) mixF(e.pos[i]);
  for (let i = 0; i < e.count; i++) { mix(e.health[i] * 8); mix(e.alive[i]); mix(e.type[i]); }
  mix(h.missiles.pool.active);
  for (let i = 0; i < h.missiles.pool.max * 3; i++) mixF(h.missiles.pos[i]);
  mix(h.mission.state);
  mix(Math.round(h.mission.timeSec * 1000));
  if (h.mission.stage) {
    for (let i = 0; i < h.mission.stage.dag.n; i++) mix(h.mission.stage.dag.state[i]);
  }
  return hash >>> 0;
}

test('replay: 100 seeded mission runs produce IDENTICAL state hashes (Task 4.4)', () => {
  const STEPS = 600; // 5 s of sim per run
  const hashes = [];
  for (let pair = 0; pair < 50; pair++) {
    const seed = 0x10000 + pair;
    const runOnce = () => {
      const h = buildReplayHarness('m5', seed);
      const rand = mulberry32(seed ^ 0x5EED); // same seed -> same player actions
      h.mission.start();
      for (let i = 0; i < STEPS && h.mission.running; i++) {
        h.mission.tick(dt);
        if (i % 30 === 0 && h.mission.running) {
          // seeded player actions: teleport, damage, missile launch
          const a = rand();
          if (a < 0.4) {
            h.ents.pos[h.playerId * 3] = (rand() - 0.5) * 16000;
            h.ents.pos[h.playerId * 3 + 1] = 500 + rand() * 3500;
            h.ents.pos[h.playerId * 3 + 2] = (rand() - 0.5) * 16000;
          } else if (a < 0.75) {
            const g = h.spawner.jetIds;
            if (g.length > 0) {
              const id = g[(rand() * g.length) | 0];
              if (h.ents.isAlive(id)) {
                if (h.ents.damage(id, 25) && h.mission) h.mission.noteKill(id);
              }
            }
          } else if (h.ents.missilesLeft[h.playerId] > 0) {
            const g = h.spawner.jetIds;
            const tgt = g.length > 0 ? g[(rand() * g.length) | 0] : -1;
            const mid = h.missiles.spawn(h.playerId,
              h.ents.pos[h.playerId * 3], h.ents.pos[h.playerId * 3 + 1],
              h.ents.pos[h.playerId * 3 + 2], 0, 0, -1,
              h.ents.speed[h.playerId] + 30, tgt);
            if (mid >= 0) h.ents.missilesLeft[h.playerId]--;
          }
        }
        // sampled finite checks (cheap): the sim must never corrupt state
        if ((i & 15) === 0) {
          assert.ok(finite3(h.ents.pos[h.playerId * 3], h.ents.pos[h.playerId * 3 + 1],
            h.ents.pos[h.playerId * 3 + 2]), 'player finite @' + i);
        }
      }
      return hashHarnessState(h);
    };
    const a = runOnce();
    const b = runOnce();                 // identical seed -> must hash identically
    assert.equal(a, b, 'replay pair ' + pair + ' (seed ' + seed + ') hashes identical');
    hashes.push(a);
  }
  // 100 runs executed (50 pairs); every pair self-consistent, pairs independent
  assert.equal(hashes.length, 50);
});

// ---------------------------------------------------------------------------
// Task 4.2 - invariants are dev-gated: counted in dev, silent under the prod
// strip (build.py sets window.__SKYBURN_DEV__ = false in dist/index.html)
// ---------------------------------------------------------------------------

test('invariants: violations count in dev; the prod strip silences them', () => {
  const prev = globalThis.__SKYBURN_DEV__;
  globalThis.__SKYBURN_DEV__ = true;
  resetInvariants();
  assertFinite1('prop.dev', NaN);
  assert.equal(getViolationCount(), 1, 'dev mode counts the violation');
  globalThis.__SKYBURN_DEV__ = false;
  resetInvariants();
  assertFinite1('prop.prod', NaN);
  assertFinite1('prop.prod', Infinity);
  assert.equal(getViolationCount(), 0, 'prod strip: silent, no violation counted');
  if (prev === undefined) delete globalThis.__SKYBURN_DEV__;
  else globalThis.__SKYBURN_DEV__ = prev;
  resetInvariants();
});




