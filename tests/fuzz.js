// Skyburn Phase 4 - Fuzzer (Task 4.4): N random mission runs with zero crashes,
// NaN corruption or soft-locks. PRD/PLAN: "Fuzz 10000 runs 60s, no soft-lock/crash",
// "deterministic replay 100 replays identical hash".
//
// Standalone gate - NOT part of `npm test` (direct-execution guard at the bottom;
// `node --test` imports this file but runs nothing). Usage:
//   node tests/fuzz.js                      # 10000 runs, seed 0xF022
//   node tests/fuzz.js --runs 200 --quick   # smoke
//   node tests/fuzz.js --replay 100         # 100 double-runs must hash identically
//   npm run fuzz                            # same as the default invocation
//
// Each run: random mission x difficulty x seed, 120 Hz fixed timestep (the real loop's
// clock), random player perturbations every 0.5 s (teleport / damage / missiles),
// sampled invariants (finite, caps, FSM validity) and a frozen-state soft-lock detector
// that exempts pending objective timers (a counting-down timer guarantees progress).

import {
  WorldEntities, ENT_TYPE, TEAM,
} from '../src/combat/entities.js';
import { MissileSystem, MISSILE_TUNING } from '../src/combat/missiles.js';
import { CollisionWorld } from '../src/combat/collision.js';
import { Mission, MISSION_STATE } from '../src/mission/mission.js';
import { Spawner } from '../src/mission/spawner.js';
import { Terrain, mulberry32 } from '../src/world/terrain.js';
import jetsJson from '../src/data/jets.json' with { type: 'json' };
import missionsJson from '../src/data/missions.json' with { type: 'json' };
import mapsJson from '../src/data/maps.json' with { type: 'json' };

const JETS = jetsJson.jets;
const MISSIONS = missionsJson.missions;
const MAPS = mapsJson.maps;
const dt = 1 / 120;

// Progress hash WITHOUT timers/clock: frozen sim state over 25 s of sim time with no
// timer pending = soft-lock. (With a pending timer the DAG is guaranteed to change.)
function hashSim(h) {
  let hash = 0x811c9dc5;
  const mix = (v) => { hash = Math.imul(hash ^ (v | 0), 0x01000193) >>> 0; };
  const mixF = (v) => mix(Math.round(v * 4));
  const e = h.ents;
  for (let i = 0; i < e.count * 3; i++) mixF(e.pos[i]);
  for (let i = 0; i < e.count; i++) { mix(e.alive[i]); mix(e.health[i] * 4); }
  mix(h.missiles.pool.active);
  for (let i = 0; i < h.missiles.pool.max * 3; i++) mixF(h.missiles.pos[i]);
  if (h.mission.stage) {
    for (let i = 0; i < h.mission.stage.dag.n; i++) mix(h.mission.stage.dag.state[i]);
  }
  return hash >>> 0;
}

function buildHarness(missionId, difficulty, seed) {
  const def = MISSIONS.find((m) => m.id === missionId);
  if (!def) throw new Error('fuzz: no mission ' + missionId);
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
    missiles, terrain, jetsData: JETS, playerId, difficulty,
  });
  const mission = new Mission(def, map, difficulty, {
    ents, missiles, spawner, playerId, hooks: {},
  });
  return { def, map, ents, missiles, spawner, mission, playerId, terrain };
}

function finite3(x, y, z) {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}

// One fuzz run. Returns { ok, reason, ticks, ended, hash }.
function runOne(missionId, difficulty, seed, maxSec, actionSeed) {
  const h = buildHarness(missionId, difficulty, seed);
  const rand = mulberry32(actionSeed);
  const maxTicks = Math.round(maxSec / dt);
  const FROZEN_TICKS = Math.round(25 / dt);
  try {
    h.mission.start();
  } catch (e) {
    return { ok: false, reason: 'start threw: ' + e.message, ticks: 0 };
  }
  let lastHash = -1;
  let lastChange = 0;
  let ticks = 0;
  for (let i = 0; i < maxTicks; i++) {
    try {
      h.mission.tick(dt);
    } catch (e) {
      return { ok: false, reason: 'tick threw @' + i + ': ' + e.message, ticks: i };
    }
    ticks = i + 1;
    if (!h.mission.running) break;
    if (i % 60 === 0) {
      // random player perturbation (0.5 s cadence, same style as the replay test)
      const a = rand();
      if (a < 0.4) {
        h.ents.pos[h.playerId * 3] = (rand() - 0.5) * 18000;
        h.ents.pos[h.playerId * 3 + 1] = 400 + rand() * 4000;
        h.ents.pos[h.playerId * 3 + 2] = (rand() - 0.5) * 18000;
      } else if (a < 0.7) {
        const g = h.spawner.jetIds;
        if (g.length > 0) {
          const id = g[(rand() * g.length) | 0];
          if (h.ents.isAlive(id) && h.ents.damage(id, 10 + rand() * 60)) {
            h.mission.noteKill(id);
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
    if ((i & 31) === 0) {
      if (!finite3(h.ents.pos[h.playerId * 3], h.ents.pos[h.playerId * 3 + 1],
        h.ents.pos[h.playerId * 3 + 2])) {
        return { ok: false, reason: 'player position non-finite @' + i, ticks: i };
      }
      if (!(h.missiles.pool.active >= 0 && h.missiles.pool.active <= h.missiles.pool.max)) {
        return { ok: false, reason: 'missile pool active out of range @' + i, ticks: i };
      }
      if (h.ents.activeCount() > h.ents.max) {
        return { ok: false, reason: 'entity cap exceeded @' + i, ticks: i };
      }
      const st = h.mission.state;
      if (st !== MISSION_STATE.STAGE_ACTIVE && st !== MISSION_STATE.SUCCESS &&
        st !== MISSION_STATE.FAILED) {
        return { ok: false, reason: 'mission in unexpected state ' + st + ' @' + i, ticks: i };
      }
      const hash = hashSim(h);
      if (hash !== lastHash) { lastHash = hash; lastChange = i; }
      else if (i - lastChange > FROZEN_TICKS) {
        // soft-lock candidate: frozen 25 s. Legit only if an objective timer is pending
        // (its expiry is guaranteed progress - liveness holds).
        let timerPending = false;
        const dag = h.mission.stage && h.mission.stage.dag;
        if (dag) {
          for (let k = 0; k < dag.n; k++) {
            if (dag.state[k] === 1 && dag.defs[k].timer > 0) { timerPending = true; break; }
          }
        }
        if (!timerPending) {
          return { ok: false, reason: 'soft-lock: sim frozen 25 s, no pending timer @' + i,
            ticks: i };
        }
      }
    }
  }
  return { ok: true, reason: '', ticks, ended: !h.mission.running, hash: hashSim(h) };
}

// ---- CLI ----
function parseArgs(argv) {
  const out = { runs: 10000, seed: 0xF022, replay: 0, maxSec: 60, quick: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') out.runs = parseInt(argv[++i], 10) || out.runs;
    else if (a === '--seed') out.seed = (parseInt(argv[++i], 10) || 0) >>> 0;
    else if (a === '--replay') out.replay = parseInt(argv[++i], 10) || 0;
    else if (a === '--maxsec') out.maxSec = parseFloat(argv[++i]) || out.maxSec;
    else if (a === '--quick') { out.runs = Math.min(out.runs, 200); out.maxSec = 20; }
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log('usage: node tests/fuzz.js [--runs N] [--seed S] [--replay R] [--maxsec S] [--quick]');
    return;
  }
  const t0 = Date.now();
  const rand = mulberry32(opts.seed);
  let failures = 0;
  let totalTicks = 0;
  let ended = 0;
  const reasons = new Map();
  const t0Runs = Date.now();

  if (opts.replay > 0) {
    // Deterministic replay: each seed run twice -> identical final hash.
    let replayBad = 0;
    for (let r = 0; r < opts.replay; r++) {
      const mi = (rand() * MISSIONS.length) | 0;
      const missionId = MISSIONS[mi].id;
      const difficulty = (rand() * 3) | 0;
      const seed = (rand() * 0x7fffffff) | 0;
      const aSeed = (rand() * 0x7fffffff) | 0;
      const runA = runOne(missionId, difficulty, seed, opts.maxSec, aSeed);
      const runB = runOne(missionId, difficulty, seed, opts.maxSec, aSeed);
      totalTicks += runA.ticks + runB.ticks;
      if (!runA.ok || !runB.ok) {
        replayBad++;
        console.error('[fuzz] replay run failed: ' + runA.reason + runB.reason);
      } else if (runA.hash !== runB.hash) {
        replayBad++;
        console.error('[fuzz] REPLAY MISMATCH ' + missionId + ' seed=' + seed +
          ' hashA=' + runA.hash + ' hashB=' + runB.hash);
      }
      if ((r + 1) % 25 === 0) {
        console.log('[fuzz] replay ' + (r + 1) + '/' + opts.replay + ' pairs ok');
      }
    }
    console.log('[fuzz] replay: ' + opts.replay + ' pairs, ' + replayBad + ' mismatches');
    if (replayBad > 0) failures += replayBad;
  }

  for (let r = 0; r < opts.runs; r++) {
    const mi = (rand() * MISSIONS.length) | 0;
    const missionId = MISSIONS[mi].id;
    const difficulty = (rand() * 3) | 0;
    const seed = (rand() * 0x7fffffff) | 0;
    const aSeed = (rand() * 0x7fffffff) | 0;
    const res = runOne(missionId, difficulty, seed, opts.maxSec, aSeed);
    totalTicks += res.ticks;
    if (res.ended) ended++;
    if (!res.ok) {
      failures++;
      console.error('[fuzz] FAIL #' + r + ' ' + missionId + ' diff=' + difficulty +
        ' seed=' + seed + ': ' + res.reason);
      reasons.set(res.reason.split('@')[0], (reasons.get(res.reason.split('@')[0]) || 0) + 1);
      if (failures >= 20) { console.error('[fuzz] too many failures, stopping'); break; }
    }
    if ((r + 1) % 1000 === 0) {
      const dtSec = (Date.now() - t0Runs) / 1000;
      console.log('[fuzz] ' + (r + 1) + '/' + opts.runs + ' runs, ' + totalTicks +
        ' ticks, ' + failures + ' failures (' + dtSec.toFixed(0) + ' s)');
    }
  }
  const wall = (Date.now() - t0) / 1000;
  console.log('[fuzz] ===== SUMMARY =====');
  console.log('[fuzz] runs: ' + opts.runs + '  ticks: ' + totalTicks +
    '  ended-early: ' + ended + '  failures: ' + failures);
  for (const [reason, count] of reasons) console.log('[fuzz]   ' + count + 'x ' + reason);
  console.log('[fuzz] wall time: ' + wall.toFixed(1) + ' s (' +
    (totalTicks / Math.max(1, wall) / 1000).toFixed(1) + 'k ticks/s)');
  if (failures > 0) process.exitCode = 1;
  else console.log('[fuzz] PASS: zero crashes / NaN / soft-locks');
}

// Run only when executed directly (node tests/fuzz.js); a plain import (node --test
// walking tests/) must stay a no-op - the heavy gate is never part of `npm test`.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}



