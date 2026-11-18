// Skyburn Phase 2 - Entry point: mission system wiring (PRD Phase 2) on top of the Phase 1
// core combat sandbox. Game FSM: MENU -> HANGAR -> BRIEFING -> LOADING -> PLAYING -> DEBRIEF
// (Task 2.6) with forbidden transitions validated. Missions M1-M4 run through the Mission /
// Stage / ObjectiveDag / Spawner modules; free flight (Phase 1 dogfight + carrier ops) stays
// available from the menu as a sandbox. Checkpoints (Task 2.7) persist through
// core/save.js (IndexedDB) at every stage start and restore on death (Rookie/Veteran).

import { GameLoop, FIXED_DT } from './core/loop.js';
import { InputSystem, ACTION } from './core/input.js';
import { AudioSystem } from './core/audio.js';
import { MusicSystem } from './audio/music.js';
import { SaveSystem, defaultSaveData } from './core/save.js';
import { QualityGovernor } from './core/quality.js';   // Task 4.5: auto render scale
import { Profiler } from './core/profiler.js';         // Task 4.5: dev timing HUD
import {
  Renderer, buildShipLod, buildRigLod, buildGroundLod,
} from './render/renderer.js';
import { buildJetKitLod, SHAPE_IDS, shapeIndexFor } from './render/models.js';
import { Terrain } from './world/terrain.js';
import { Ocean } from './world/ocean.js';
import { Carrier, CARRIER_TUNING } from './world/carrier.js';
import { WorldEntities, TEAM, ENT_TYPE } from './combat/entities.js';
import { CollisionWorld, groundHitAt } from './combat/collision.js';
import { FlightModel } from './physics/flight.js';
import { GunSystem, GUN_TUNING } from './combat/guns.js';
import { MissileSystem, MISSILE_TUNING } from './combat/missiles.js';
import { LockSystem, LOCK_STATE } from './combat/lockon.js';
import { EnemyAI } from './ai/enemy.js';
import { ParticleSystem, P_KIND } from './render/particles.js';
import { ImpactCam } from './render/impactCam.js';
import { FSMTable, FSM } from './ai/fsm.js';
import { Spawner } from './mission/spawner.js';
import { Mission, MISSION_STATE } from './mission/mission.js';
import { BriefingScreen } from './ui/briefing.js';
import { DebriefScreen } from './ui/debrief.js';
import { MissionHud } from './ui/hud.js';
import { HangarScreen, creditsForRun } from './ui/hangar.js';
import { initVec3 } from './wasm/vec3.js';
import {
  assertFinite3, assertSpeedCapped, assertActiveCount, getViolationCount,
} from './verify/invariants.js';

const DEG = Math.PI / 180;
const ARENA_HALF = 19000;
const PLAYER_MAX_ENTS = 512;
const SPAWNER_JET_CAP = 24; // mirrors SPAWNER_TUNING.MAX_JETS (scene arrays sized to it)

// ---- Game FSM (Task 2.6): MENU -> HANGAR -> BRIEFING -> LOADING -> PLAYING -> DEBRIEF ----
// Exported table builder (like buildMissileTable) so tests/mission.test.js can validate the
// UI flow structurally: no forbidden jumps (e.g. MENU straight into PLAYING).
// Phase 4 (Task 4.7): PLAYING <-> PAUSED (PRD Game FSM has PAUSED; no sim step runs there,
// which structurally guarantees "no damage in PAUSED").
export const GAME_STATE = {
  MENU: 0, HANGAR: 1, BRIEFING: 2, LOADING: 3, PLAYING: 4, PAUSED: 5, DEBRIEF: 6, COUNT: 7,
};
export const GAME_STATE_NAMES =
  ['MENU', 'HANGAR', 'BRIEFING', 'LOADING', 'PLAYING', 'PAUSED', 'DEBRIEF'];
export const GAME_EVENT = {
  OPEN_HANGAR: 0, BACK: 1, PICK: 2, LAUNCH: 3, LOADED: 4, ENDED: 5, RETRY: 6, CONTINUE: 7,
  PAUSE: 8, RESUME: 9, COUNT: 10,
};
export const GAME_EVENT_NAMES =
  ['OPEN_HANGAR', 'BACK', 'PICK', 'LAUNCH', 'LOADED', 'ENDED', 'RETRY', 'CONTINUE',
    'PAUSE', 'RESUME'];

export function buildGameTable() {
  const S = GAME_STATE, E = GAME_EVENT;
  const t = new FSMTable(S.COUNT, E.COUNT, GAME_STATE_NAMES, GAME_EVENT_NAMES);
  t.add(S.MENU, E.OPEN_HANGAR, S.HANGAR, null, null);
  t.add(S.HANGAR, E.BACK, S.MENU, null, null);
  t.add(S.HANGAR, E.PICK, S.BRIEFING, null, null);
  t.add(S.MENU, E.PICK, S.BRIEFING, null, null);   // sandbox/free flight: no hangar stop
  t.add(S.BRIEFING, E.BACK, S.MENU, null, null);
  t.add(S.BRIEFING, E.LAUNCH, S.LOADING, null, null);
  t.add(S.LOADING, E.LOADED, S.PLAYING, null, null);
  t.add(S.PLAYING, E.ENDED, S.DEBRIEF, null, null);
  t.add(S.PLAYING, E.PAUSE, S.PAUSED, null, null);   // Task 4.7: pause freezes the sim step
  t.add(S.PAUSED, E.RESUME, S.PLAYING, null, null);
  t.add(S.DEBRIEF, E.RETRY, S.LOADING, null, null);
  t.add(S.DEBRIEF, E.CONTINUE, S.MENU, null, null);
  // PRD flow invariant: screens only advance along the defined chain.
  t.validate([
    [S.MENU, S.PLAYING], [S.MENU, S.DEBRIEF], [S.MENU, S.LOADING], [S.MENU, S.PAUSED],
    [S.BRIEFING, S.PLAYING], [S.HANGAR, S.PLAYING], [S.PLAYING, S.MENU],
    [S.PLAYING, S.HANGAR], [S.DEBRIEF, S.PLAYING], [S.PAUSED, S.MENU],
    [S.PAUSED, S.HANGAR], [S.PAUSED, S.BRIEFING], [S.PAUSED, S.LOADING],
    [S.PAUSED, S.DEBRIEF], [S.DEBRIEF, S.PAUSED],
  ]);
  return t;
}

function $(id) { return document.getElementById(id); }

function showError(msg) {
  const el = $('err');
  if (el) { el.hidden = false; el.textContent = msg; }
}

async function loadJSON(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Failed to load ' + url + ': ' + resp.status);
  return resp.json();
}

function pickJet(data, wantedId) {
  const list = Array.isArray(data) ? data : data.jets;
  if (wantedId) {
    for (const j of list) if (j.id === wantedId) return j;
  }
  const wanted = new URLSearchParams(window.location.search).get('jet');
  if (wanted) {
    for (const j of list) if (j.id === wanted) return j;
  }
  return list[0];
}

// Difficulty from the URL (?diff=0 rookie, 1 veteran default, 2 ace).
function pickDifficulty() {
  const d = parseInt(new URLSearchParams(window.location.search).get('diff') || '1', 10);
  return Number.isFinite(d) ? Math.max(0, Math.min(2, d)) : 1;
}

// ---- Boot ----

async function boot() {
  const canvas = $('gl');
  if (!canvas) { showError('Missing #gl canvas'); return; }

  // ---- persistence FIRST (TDZ hardening + never-crash save guard) ----
  // saveData must exist before ANY boot code reads it. The old Phase-4 regression class:
  // consumers (audio/input/HUD palette wiring) reading saveData above its declaration,
  // crashing boot with "Cannot access 'saveData' before initialization". The block now
  // sits at the very top of boot(), ahead of every consumer. Failure-proof by design:
  // save.load() already merges defaults and swallows backend errors, but if anything
  // else goes wrong (blocked storage, corrupt record, future reorder) saveData falls
  // back to the canonical fresh save and boot continues - it never crashes on save state.
  const save = new SaveSystem();
  let saveData = null;
  try {
    saveData = await save.load();
  } catch (e) {
    saveData = null; // backend threw (IndexedDB blocked / private mode): use defaults
  }
  if (!saveData) {
    // Fresh save via defaultSaveData() in core/save.js. Do NOT inline a partial object
    // here (e.g. { credits, unlocked, settings } only): boot closures write the full
    // shape - saveData.results[...] (debrief), saveData.unlocked.push(...), checkpoint.
    saveData = defaultSaveData();
  }
  async function persistSave() {
    try { await save.save(saveData); } catch (e) { /* never block gameplay on IO */ }
  }

  // Mission HUD is created FIRST, before anything that can touch missionHud runs.
  // TDZ fix: the palette/reduced-motion wiring further down used missionHud while its
  // old declaration sat below it in this scope, crashing boot with "Cannot access
  // 'missionHud' before initialization". Stays inside boot() (not module scope) because
  // Node tests import this module headlessly and have no `document` there.
  const missionHud = new MissionHud(document);

  // Task 0.7: WASM vec3 stub (falls back to JS with the same API when no toolchain artifact)
  initVec3().catch(() => {});

  let jets, missionsData, mapsData, weaponsData;
  try {
    [jets, missionsData, mapsData, weaponsData] = await Promise.all([
      loadJSON('./src/data/jets.json'),
      loadJSON('./src/data/missions.json'),
      loadJSON('./src/data/maps.json'),
      loadJSON('./src/data/weapons.json'),
    ]);
  } catch (e) {
    showError('Failed to load game data: ' + e.message);
    return;
  }
  const jetList = Array.isArray(jets) ? jets : jets.jets;
  const missions = missionsData.missions;
  const maps = mapsData.maps;
  const weapons = weaponsData.weapons;
  // Task 3A.4: weapon id -> display name for hangar loadout labels.
  const weaponNames = {};
  for (const w of weapons) weaponNames[w.id] = w.name;

  let renderer;
  try {
    renderer = new Renderer(canvas);
  } catch (e) {
    showError(e.userFacing ? e.message : 'Renderer init failed: ' + e.message);
    return;
  }

  const terrain = new Terrain({ seed: 1337 });
  const ocean = new Ocean({});
  renderer.setTerrain(terrain.buildMesh());
  renderer.setOcean(ocean.buildMesh());
  // Task 3A.2 kitbash: one LOD set per shape family; ents.variant keys the renderer.
  for (const j of jetList) j._shapeIdx = shapeIndexFor(j);
  renderer.setJetLodSets(SHAPE_IDS.map((shape) => [0, 1, 2].map(
    (level) => buildJetKitLod({ shape }, level))));
  renderer.setCarrier(new Carrier({}).buildMesh());
  renderer.setShipMeshes([buildShipLod(), buildRigLod()]);
  renderer.setGroundMesh(buildGroundLod());

  // (saveData/persistSave are set up at the very top of boot() - see the persistence
  // block there. The consumers below only read it, after the declaration.)
  const audio = new AudioSystem({});
  const music = new MusicSystem(audio);   // Task 3B.5: procedural music loop
  audio.setVolumes(saveData.settings);    // menu sliders (persisted)
  music.setVolume(saveData.settings && saveData.settings.music !== undefined
    ? saveData.settings.music : 0.5);
  const input = new InputSystem({
    onFirstInput: () => {
      if (audio.init()) { audio.resume(); music.start(); }
    },
    // Task 4.6: persisted pad settings (deadzone/sensitivity/rumble/remap)
    padSettings: saveData.settings && saveData.settings.gamepad,
  });
  input.attach(canvas, window);
  input.attachPadHotPlug(window);   // Task 4.6: hot-plug (connect/disconnect)
  missionHud.setPalette(saveData.settings && saveData.settings.colorblind);
  missionHud.reducedMotion = !!(saveData.settings && saveData.settings.reducedMotion);

  let difficulty = saveData.difficulty !== undefined ? saveData.difficulty : pickDifficulty();

  // ---- world + screens state ----
  let world = null;          // active sim session (free flight or mission)
  let pendingLaunch = null;  // { free, missionDef, map, difficulty, jetData }
  const game = new FSM(buildGameTable(), GAME_STATE.MENU, null);

  // (missionHud is created at the top of boot() - see the TDZ fix note there.)
  // Task 4.7: pause overlay (shown while the Game FSM is in PAUSED; the sim is frozen)
  const pauseEl = document.createElement('div');
  pauseEl.id = 'pause-overlay';
  pauseEl.textContent = 'PAUSED - ESC / P TO RESUME';
  pauseEl.hidden = true;
  document.body.appendChild(pauseEl);
  const briefing = new BriefingScreen(document, {
    onLaunch: () => fireGame(GAME_EVENT.LAUNCH),
    onBack: () => fireGame(GAME_EVENT.BACK),
  });
  const debrief = new DebriefScreen(document, {
    onContinue: () => { void persistSave(); fireGame(GAME_EVENT.CONTINUE); },
    onRetry: () => fireGame(GAME_EVENT.RETRY),
  });

  function fireGame(event) {
    const prev = game.state;
    const took = game.fire(event);
    if (took) onGameTransition(prev, game.state);
    return took;
  }

  function onGameTransition(prev, next) {
    if (prev === GAME_STATE.MENU) menuHide();
    else if (prev === GAME_STATE.HANGAR) hangarHide();
    else if (prev === GAME_STATE.BRIEFING) briefing.hide();
    else if (prev === GAME_STATE.DEBRIEF) debrief.hide();
    // Task 4.7: PLAYING -> PAUSED keeps the HUD up (the world stays on screen, frozen)
    else if (prev === GAME_STATE.PLAYING && next !== GAME_STATE.PAUSED) missionHud.hide();

    if (next === GAME_STATE.MENU) {
      world = null; // session over; free the sim until the next launch
      refreshMenu();
      menuShow();
    } else if (next === GAME_STATE.HANGAR) {
      hangarShow();
      } else if (next === GAME_STATE.BRIEFING) {
      const p = pendingLaunch;
      briefing.show(p.freeDef || p.missionDef, (p.map ? p.map.id : 'ocean'),
        ['ROOKIE', 'VETERAN', 'ACE'][p.difficulty],
        p.jetData.name + ' (' + p.jetData.id + ')');
    } else if (next === GAME_STATE.LOADING) {
      world = buildWorld(pendingLaunch);
      setTimeout(() => fireGame(GAME_EVENT.LOADED), 350); // brief LOADING beat
    } else if (next === GAME_STATE.PLAYING) {
      missionHud.show();
      pauseEl.hidden = true;
      audio.resume();
      music.start();   // Task 3B.5 (idempotent)
    } else if (next === GAME_STATE.PAUSED) {
      pauseEl.hidden = false;   // Task 4.7: frozen world + overlay; no sim step
    } else if (next === GAME_STATE.DEBRIEF) {
      const res = world ? world.takeResults() : null;
      if (res && res.missionId) {
        saveData.results[res.missionId] = {
          success: res.success, score: res.score, timeSec: res.timeSec, kills: res.kills,
        };
        if (res.success) {
          const unlock = pendingLaunch.missionDef.unlocks;
          if (unlock && saveData.unlocked.indexOf(unlock) < 0) saveData.unlocked.push(unlock);
          saveData.checkpoint = null; // mission won: no resume checkpoint
        }
        // Task 3A.4 economy: credits from reward + score (win) or score slice (loss)
        saveData.credits = (saveData.credits || 0) + creditsForRun(pendingLaunch.missionDef, res);
        saveData.difficulty = world.difficulty;
        void persistSave(); // Task 2.6: save IndexedDB after debrief
      }
      debrief.show(res || {
        title: 'Sandbox', success: true, kills: 0, timeSec: 0, score: 0, difficulty,
      });
    }
  }

  // ---- world builder: one sim session (free flight OR one mission run) ----
  // Kept as a factory so each mission launch starts from a pristine SoA registry (the PRD
  // caps entities at 512 per world). All Phase 1 systems are wired exactly as before.
  function buildWorld(opts) {
    const freeMode = !!opts.free;
    const missionDef = opts.missionDef || null;
    const map = opts.map || maps.ocean;
    // Phase 3B: every map rebuilds the procedural terrain from its own seed and applies
    // its atmosphere preset (fog/sun/sky gradient). setTerrain frees the previous GPU
    // buffers; the shadowing const below is the world-scoped terrain for this session.
    const terrain = new Terrain({ seed: map.seed !== undefined ? map.seed : 1337 });
    renderer.setTerrain(terrain.buildMesh());
    renderer.setAtmosphere(map.atmosphere || null);
    const worldDifficulty = opts.difficulty !== undefined ? opts.difficulty : difficulty;
    const playerData = opts.jetData;
    const enemyData = jetList.find((j) => j.id === 'mig29') || jetList[jetList.length - 1];

    // ---- world state (Task 1.2: SoA registry, max 512) ----
    const ents = new WorldEntities(PLAYER_MAX_ENTS);
    const collision = new CollisionWorld(ents.max);

    // player start: free flight = Phase 1 pose; missions = map's playerStart zone facing
    // the mission center (forward = (sin yaw, -cos yaw) -> yaw = atan2(-x, z) to face origin)
    let startX = 0, startY = 800, startZ = 14000, startYaw = Math.PI;
    if (!freeMode) {
      const ps = map.points.playerStart || { x: 0, z: 14000, y: 800 };
      startX = ps.x; startY = ps.y !== undefined ? ps.y : 800; startZ = ps.z;
      startYaw = Math.atan2(-startX, startZ);
    }
    const playerFlight = new FlightModel(playerData,
      { x: startX, y: startY, z: startZ, yaw: startYaw, throttle: 0.8 });
    const playerId = ents.spawn(ENT_TYPE.JET, TEAM.PLAYER,
      playerFlight.pos[0], playerFlight.pos[1], playerFlight.pos[2],
      playerFlight.rot[0], playerFlight.rot[1], 0, 9, 100);
    ents.missilesLeft[playerId] = playerData.hardpoints > 0 ? 6 : 0; // SR-71: unarmed recon
    ents.flareCount[playerId] = playerData.flareCount;
    ents.speed[playerId] = playerFlight.speed;
    ents.armor[playerId] = playerData.armor || 1;      // Task 3A.3
    ents.variant[playerId] = playerData._shapeIdx !== undefined ? playerData._shapeIdx : 0;

    // carrier: free flight only (Phase 1 landing gameplay); missions use a stub so the
    // shared helpers (deckAt etc.) stay allocation-free without branching
    const carrier = freeMode
      ? new Carrier({ x: 1500, z: -2500, yaw: 2.2 })
      : {
        pos: new Float32Array([0, 0, 0]), yaw: 0, deckY: 0,
        deckAt: () => -1, update: () => {},
        evaluateTouchdown: () => 3, toLocal: (x, z, out) => out,
        catapultPose: (out) => out, knots: (s) => s * 1.943844,
      };
    const carrierId = freeMode
      ? ents.spawn(ENT_TYPE.SHIP, TEAM.NEUTRAL,
        carrier.pos[0], 10, carrier.pos[2], carrier.yaw, 0, 0, 70, 2500)
      : -1;

    // ---- dynamic enemy registry (Phase 1 free flight seeds 4; missions spawn via waves) ----
    const enemyIds = [];
    const enemyFlight = [];
    const enemyAI = [];
    let N_ENEMY = 0;

    // ---- mission runtime (Tasks 2.1-2.8) ----
    let mission = null;
    let spawner = null;
    let cruiseWarn = false;
    let lastRadioMs = -999999;   // Task 3B.5 radio throttle (stage transitions)
    if (!freeMode) {
      spawner = new Spawner(ents, {
        missiles: null, terrain, jetsData: jetList, playerId,
        difficulty: worldDifficulty, map,
        hooks: {
          onJetSpawned: (id, flight, ai) => {
            enemyIds.push(id); enemyFlight.push(flight); enemyAI.push(ai);
            N_ENEMY = enemyIds.length;
          },
          onCruiseWarn: (on) => { cruiseWarn = on; },
          audio,
        },
      });
      mission = new Mission(missionDef, map, worldDifficulty, {
        ents, missiles: null, spawner, playerId,
        hooks: {
          // Task 2.7: checkpoint captured at every stage start -> persist via save.js
          onCheckpoint: (cp) => {
            saveData.checkpoint = cp;
            void persistSave();
          },
          onStageBanner: (idx, stageDef, total) => {
            missionHud.banner('STAGE ' + (idx + 1) + '/' + total + ' - ' +
              (stageDef.type || '').toUpperCase().replace('_', ' '));
          },
          onProtectedDestroyed: () => missionHud.banner('KESTREL-4 DESTROYED'),
          onMissionEvent: (msg) => {
            // Task 3B.5: radio chatter on stage transitions (squawk + TTS placeholder)
            const nowMs = performance.now();
            if (nowMs - lastRadioMs < 3000) return;
            lastRadioMs = nowMs;
            audio.radio(msg);
            // Task 4.7: subtitles for radio chatter (persisted toggle)
            if (saveData.settings && saveData.settings.subtitles) missionHud.subtitle(msg);
          },
          onAceBonus: (b) => {
            // Task 3B.3: the ONLY in-flight ace marker is the completion banner + chime
            missionHud.banner('ACE BONUS - ' + b.desc);
            audio.aceChime();
          },
        },
      });
    }

    // ---- combat systems ----
    const particles = new ParticleSystem(2000, 0x9E3779B);
    const impactCam = new ImpactCam();

    const flareTimer = new Float32Array(ents.max);   // >0 while flares burn (per entity)
    const flarePos = new Float32Array(ents.max * 3);
    const gunCd = new Float32Array(ents.max);        // per-entity gun cooldown
    const smokeCd = new Float32Array(ents.max);      // damage-smoke emitter throttle
    const enemyMissileCd = new Float32Array(64);
    const blastIds = new Int32Array(64);

    const missiles = new MissileSystem(0x51D3, {
      onExplode: (x, y, z, ownerId, targetId2) => {
        particles.burstExplosion(x, y, z);
        audio.explosion();
        // direct fuse hit: the seeker resolved on this target (within FUSE_RANGE + radius),
        // so it takes the full blast even when its radius exceeds the blast sphere (rig)
        if (targetId2 >= 0 && ents.isAlive(targetId2) &&
          ents.type[targetId2] !== ENT_TYPE.NONE) {
          const dx = ents.pos[targetId2 * 3] - x;
          const dy = ents.pos[targetId2 * 3 + 1] - y;
          const dz = ents.pos[targetId2 * 3 + 2] - z;
          const rr = MISSILE_TUNING.FUSE_RANGE + ents.radius[targetId2] + 2;
          if (dx * dx + dy * dy + dz * dz < rr * rr) {
            applyDamage(targetId2, MISSILE_TUNING.BLAST_DMG);
          }
        }
        // splash damage (Task 1.6/1.4): every alive entity within BLAST_RADIUS takes 60
        const n = collision.querySphere(ents, x, y, z, MISSILE_TUNING.BLAST_RADIUS, blastIds);
        for (let i = 0; i < n; i++) {
          const id = blastIds[i];
          if (id === ownerId) continue;
          applyDamage(id, MISSILE_TUNING.BLAST_DMG, x, y, z);
        }
        if (impactCam.active === false && ownerId === playerId) {
          impactCam.trigger(x, y, z); // Impact Cam on player missile impacts (Task 1.8)
        }
      },
      flareActive: (targetId, outPos) => {
        if (flareTimer[targetId] <= 0) return false;
        outPos[0] = flarePos[targetId * 3];
        outPos[1] = flarePos[targetId * 3 + 1];
        outPos[2] = flarePos[targetId * 3 + 2];
        return true;
      },
    });
    if (spawner) spawner.missiles = missiles; // cruise missiles + threat scans
    if (mission) mission.start(playerSnapshot()); // deploys stage 0 + first checkpoint (Task 2.7)

    // free flight: 4 AI enemies spread around the arena (Phase 1 AC, preserved as sandbox)
    if (freeMode) {
      N_ENEMY = 4;
      for (let i = 0; i < N_ENEMY; i++) {
        const ang = i * (Math.PI / 2) + 0.4;
        const f = new FlightModel(enemyData, {
          x: Math.cos(ang) * 5200, y: 900 + i * 260, z: Math.sin(ang) * 5200,
          yaw: ang + Math.PI, throttle: 0.75,
        });
        const id = ents.spawn(ENT_TYPE.JET, TEAM.ENEMY, f.pos[0], f.pos[1], f.pos[2],
          f.rot[0], f.rot[1], 0, 9, 100);
        ents.missilesLeft[id] = 4;
        ents.flareCount[id] = enemyData.flareCount;
        ents.speed[id] = f.speed;
        ents.armor[id] = enemyData.armor || 1;
        ents.variant[id] = enemyData._shapeIdx !== undefined ? enemyData._shapeIdx : 0;
        enemyIds.push(id);
        enemyFlight.push(f);
        const ai = new EnemyAI(ents, null, id, { id: playerId }, worldDifficulty, 0xBEEF + i, {});
        enemyAI.push(ai);
      }
    }
    for (const ai of enemyAI) ai.missiles = missiles; // threat scan needs the live system

    // ---- game state ----
    let playerState = 'FLYING';   // FLYING | LANDING_ROLL | PARKED | CATAPULT | DESTROYED
    let respawnTimer = 0;
    let catapultTimer = 0;
    let rolloutSpeed = 0;
    let victory = false;
    let simTime = 0;
    let warnCd = 0;
    let ended = false;            // mission end observed (success or fail)
    let endTimer = -1;
    let restoreFlash = 0;

    // player shooter view (preallocated; mutated before each tryFire)
    const shooterView = {
      id: playerId, team: TEAM.PLAYER, gunDamage: playerData.gunDamage,
      noseX: 0, noseY: 0, noseZ: 0, fx: 0, fy: 1, fz: 0, world: ents,
    };

    // Player checkpoint snapshot (Task 2.7) - captured at every stage start via onCheckpoint.
    function playerSnapshot() {
      return {
        x: playerFlight.pos[0], y: playerFlight.pos[1], z: playerFlight.pos[2],
        yaw: playerFlight.rot[0], pitch: playerFlight.rot[1], roll: playerFlight.rot[2],
        speed: playerFlight.speed, throttle: playerFlight.throttle,
        hp: ents.maxHealth[playerId],
        missiles: ents.missilesLeft[playerId], flares: ents.flareCount[playerId],
      };
    }

    function applyPlayerSnapshot(s) {
      if (!s) return;
      playerFlight.teleport(s.x, s.y, s.z, s.yaw, s.pitch);
      playerFlight.rot[2] = s.roll;
      playerFlight.prevRot.set(playerFlight.rot);
      playerFlight.speed = s.speed;
      playerFlight.throttle = s.throttle !== undefined ? s.throttle : playerFlight.throttle;
      playerFlight.pidPitch.reset(); playerFlight.pidRoll.reset(); playerFlight.pidYaw.reset();
      ents.alive[playerId] = 1;
      ents.type[playerId] = ENT_TYPE.JET;
      ents.health[playerId] = s.hp;
      ents.maxHealth[playerId] = s.hp;
      ents.missilesLeft[playerId] = s.missiles;
      ents.flareCount[playerId] = s.flares;
      syncEntity(playerId, playerFlight);
      playerState = 'FLYING';
    }

    function applyDamage(id, dmg, hx, hy, hz) {
      const killed = ents.damage(id, dmg);
      if (id === playerId && mission) mission.notePlayerDamaged(); // Task 3B.3 ace feed
      if (id === playerId) input.rumble(killed ? 1.0 : 0.6, killed ? 350 : 180); // Task 4.6
      if (killed) {
        particles.burstExplosion(ents.pos[id * 3], ents.pos[id * 3 + 1], ents.pos[id * 3 + 2]);
        audio.explosion();
        if (mission) mission.noteKill(id); // Task 2.3/2.4: kill routing -> DAG progress
      } else if (hx !== undefined) {
        particles.spawn(P_KIND.FLASH, hx, hy, hz, 0, 2, 0, 0.5, 6, 1, 0.8, 0.4); // hit flash
      }
    }

    // guns: one shared hitscan system; per-entity cooldowns live in gunCd.
    // collision (created above with the ents registry) is INJECTED here - GunSystem owns
    // the reference and never reads ents.collision (the ents object has no such property).
    const guns = new GunSystem(0xC0FFEE, collision);
    guns.hooks.onHit = (hitId, dmg, px, py, pz, shooterId) => {
      applyDamage(hitId, dmg, px, py, pz);
    };
    guns.hooks.onMuzzle = (mx, my, mz, dx, dy, dz) => {
      particles.muzzleFlash(mx, my, mz, dx, dy, dz);
      audio.gun();
    };

    // player lock FSM (Task 1.4) with audio hooks
    let targetId = -1;
    const lock = new LockSystem({
      onEnterLocking: () => {},
      onLocked: () => audio.lockTone(true),
      onLost: () => { audio.lockTone(false); targetId = -1; },
      onDecoyed: () => { audio.lockTone(false); targetId = -1; },
      onFire: () => {},
      onSeekBeep: () => audio.lockSeekBeep(),
    }, LOCK_STATE.IDLE);

    function syncEntity(id, flight) {
      ents.prevPos[id * 3] = flight.prevPos[0];
      ents.prevPos[id * 3 + 1] = flight.prevPos[1];
      ents.prevPos[id * 3 + 2] = flight.prevPos[2];
      ents.pos[id * 3] = flight.pos[0];
      ents.pos[id * 3 + 1] = flight.pos[1];
      ents.pos[id * 3 + 2] = flight.pos[2];
      ents.prevRot[id * 3] = flight.prevRot[0];
      ents.prevRot[id * 3 + 1] = flight.prevRot[1];
      ents.prevRot[id * 3 + 2] = flight.prevRot[2];
      ents.rot[id * 3] = flight.rot[0];
      ents.rot[id * 3 + 1] = flight.rot[1];
      ents.rot[id * 3 + 2] = flight.rot[2];
      ents.vel[id * 3] = flight.vel[0];
      ents.vel[id * 3 + 1] = flight.vel[1];
      ents.vel[id * 3 + 2] = flight.vel[2];
      ents.speed[id] = flight.speed;
      // auto-gear (see carrier.js header): deploy slow+low near the ship, retract fast
      const dxc = ents.pos[id * 3] - carrier.pos[0];
      const dzc = ents.pos[id * 3 + 2] - carrier.pos[2];
      const dShip = Math.sqrt(dxc * dxc + dzc * dzc);
      ents.gearDown[id] = (flight.speed < 110 && ents.pos[id * 3 + 1] < 350 && dShip < 2500) ? 1 : 0;
    }

    function noseOf(id, view) {
      const yaw = ents.rot[id * 3], pitch = ents.rot[id * 3 + 1];
      const fx = Math.sin(yaw) * Math.cos(pitch);
      const fy = Math.sin(pitch);
      const fz = -Math.cos(yaw) * Math.cos(pitch);
      view.noseX = ents.pos[id * 3] + fx * 7;
      view.noseY = ents.pos[id * 3 + 1] + fy * 7;
      view.noseZ = ents.pos[id * 3 + 2] + fz * 7;
      view.fx = fx; view.fy = fy; view.fz = fz;
    }

    // Pick nearest/next alive enemy for the lock FSM (in-range check is done per tick).
    function pickTarget(next) {
      let best = -1;
      if (next) {
        const startIdx = enemyIds.indexOf(targetId);
        for (let k = 1; k <= N_ENEMY; k++) {
          const cand = enemyIds[(startIdx + k) % N_ENEMY];
          if (cand !== undefined && ents.isAlive(cand)) { best = cand; break; }
        }
      } else {
        let bestD = Infinity;
        for (let i = 0; i < N_ENEMY; i++) {
          const cand = enemyIds[i];
          if (!ents.isAlive(cand)) continue;
          const dx = ents.pos[cand * 3] - ents.pos[playerId * 3];
          const dy = ents.pos[cand * 3 + 1] - ents.pos[playerId * 3 + 1];
          const dz = ents.pos[cand * 3 + 2] - ents.pos[playerId * 3 + 2];
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bestD) { bestD = d; best = cand; }
        }
      }
      targetId = best;
      if (best === -1) lock.targetLost();
    }

    function spawnMissileFor(shooterEntId, tgtId, view) {
      noseOf(shooterEntId, view);
      const launchSpeed = ents.speed[shooterEntId] + 30;
      const mid = missiles.spawn(shooterEntId, view.noseX, view.noseY, view.noseZ,
        view.fx, view.fy, view.fz, launchSpeed, tgtId);
      if (mid >= 0) {
        audio.missileLaunch();
        input.rumble(0.45, 120); // Task 4.6: launch feedback (no-op without a pad)
        if (shooterEntId === playerId && mission) mission.notePlayerMissileFired(); // 3B.3
        return true;
      }
      return false; // pool full
    }

    // ---- shared physics-tick helpers ----
    const nearIds = new Int32Array(32);
    const deckLocal = new Float32Array(2);
    const enemyView = {
      id: -1, team: TEAM.ENEMY, gunDamage: 12,
      noseX: 0, noseY: 0, noseZ: 0, fx: 0, fy: 1, fz: 0, world: ents,
    };

    function killJet(id) {
      applyDamage(id, 9999);
      if (id === playerId) {
        playerState = 'DESTROYED';
        respawnTimer = 2.5;
        // free flight keeps the Phase 1 auto-respawn; missions route through checkpoints
        // (Task 2.7) in the DESTROYED branch of step() below.
      }
    }

    // Terrain/ocean/deck interaction for one flying jet (Task 1.6 "ground crash" + Task 1.7
    // deck landing). isPlayer: player lands via arrestor; AI never lands (they crash).
    function handleJetEnvironment(id, flight, isPlayer) {
      const x = ents.pos[id * 3], y = ents.pos[id * 3 + 1], z = ents.pos[id * 3 + 2];
      const deck = carrier.deckAt(x, z);
      const g = groundHitAt(terrain, x, y, z, 5);
      const surface = deck >= 0 ? deck : (g >= 0 ? g : -1);
      if (surface < 0 || y > surface + 5) return;

      if (deck >= 0 && isPlayer && playerState === 'FLYING') {
        const sinkRate = Math.max(0, -flight.vel[1]);
        const verdict = carrier.evaluateTouchdown(ents.gearDown[id] === 1, flight.speed, sinkRate);
        if (verdict === 1) {
          // arrested: stick to the deck (store deck-local offset; the ship keeps moving)
          carrier.toLocal(x, z, deckLocal);
          playerState = 'LANDING_ROLL';
          rolloutSpeed = Math.min(flight.speed, 60);
          flight.teleport(x, deck + 2.2, z, carrier.yaw, 0);
          flight.speed = rolloutSpeed;
          audio.beep(880, 0.25, 0.3);
          return;
        }
        killJet(id); // crashed into the deck (no gear / too fast / too hard)
        return;
      }
      killJet(id); // terrain/ocean impact (or AI hitting the deck)
    }

    // Carrier deck ops for the player: LANDING_ROLL -> PARKED -> CATAPULT -> FLYING (Task 1.7).
    // Free flight only (missions have no carrier; the stub never reports a deck).
    function updateCarrierOps(dt, input) {
      const flight = playerFlight;
      if (playerState === 'LANDING_ROLL') {
        rolloutSpeed = Math.max(0, rolloutSpeed - CARRIER_TUNING.ROLLOUT_DECEL * dt);
        // ride the deck: world pos from stored local offset + live carrier pose
        const c = Math.cos(carrier.yaw), s = Math.sin(carrier.yaw);
        const wx = carrier.pos[0] + deckLocal[0] * s + deckLocal[1] * c;
        const wz = carrier.pos[2] - deckLocal[0] * c + deckLocal[1] * s;
        flight.teleport(wx, CARRIER_TUNING.DECK_Y + 2.2, wz, carrier.yaw, 0);
        flight.speed = rolloutSpeed;
        if (rolloutSpeed <= 2) {
          playerState = 'PARKED';
          catapultTimer = 0;
          audio.beep(660, 0.2, 0.25);
        }
      } else if (playerState === 'PARKED') {
        // hold brakes until full throttle requests a catapult launch
        if (input.getAxis(ACTION.THROTTLE) > 0.5) {
          catapultTimer += dt;
          if (catapultTimer === dt) audio.beep(520, 0.4, 0.3); // spool-up cue (first tick)
          if (catapultTimer >= CARRIER_TUNING.CATAPULT_TIME) {
            playerState = 'CATAPULT';
            rolloutSpeed = 0;
            carrier.catapultPose(_catPose);
            carrier.toLocal(_catPose[0], _catPose[2], deckLocal);
            flight.teleport(_catPose[0], _catPose[1], _catPose[2], _catPose[3], 0);
            flight.speed = 0;
            flight.throttle = 1;
          }
        } else {
          catapultTimer = 0;
        }
        syncParkedEntity();
      } else if (playerState === 'CATAPULT') {
        rolloutSpeed += CARRIER_TUNING.CATAPULT_ACCEL * dt;
        const c = Math.cos(carrier.yaw), s = Math.sin(carrier.yaw);
        // slide forward along the deck from the catapult start
        deckLocal[0] += rolloutSpeed * dt;
        const wx = carrier.pos[0] + deckLocal[0] * s + deckLocal[1] * c;
        const wz = carrier.pos[2] - deckLocal[0] * c + deckLocal[1] * s;
        flight.teleport(wx, CARRIER_TUNING.DECK_Y + 2.2, wz, carrier.yaw, 0);
        flight.speed = rolloutSpeed;
        if (rolloutSpeed >= 82) {
          playerState = 'FLYING';
          flight.teleport(wx, CARRIER_TUNING.DECK_Y + 6, wz, carrier.yaw, 4 * DEG);
          audio.beep(980, 0.3, 0.3);
        }
      }
    }

    const _catPose = new Float32Array(4);

    function syncParkedEntity() {
      ents.prevPos[playerId * 3] = ents.pos[playerId * 3];
      ents.prevPos[playerId * 3 + 1] = ents.pos[playerId * 3 + 1];
      ents.prevPos[playerId * 3 + 2] = ents.pos[playerId * 3 + 2];
      ents.pos[playerId * 3] = playerFlight.pos[0];
      ents.pos[playerId * 3 + 1] = playerFlight.pos[1];
      ents.pos[playerId * 3 + 2] = playerFlight.pos[2];
      ents.rot[playerId * 3] = carrier.yaw;
      ents.prevRot[playerId * 3] = carrier.yaw;
      ents.speed[playerId] = playerFlight.speed;
    }

    // In-range test for the lock FSM: radar range + 30 degree seeker cone (Task 1.4).
    function lockInRange() {
      if (targetId < 0 || !ents.isAlive(targetId)) return false;
      const dx = ents.pos[targetId * 3] - ents.pos[playerId * 3];
      const dy = ents.pos[targetId * 3 + 1] - ents.pos[playerId * 3 + 1];
      const dz = ents.pos[targetId * 3 + 2] - ents.pos[playerId * 3 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > playerData.radarRange) return false;
      const yaw = ents.rot[playerId * 3], pitch = ents.rot[playerId * 3 + 1];
      const fx = Math.sin(yaw) * Math.cos(pitch), fy = Math.sin(pitch),
        fz = -Math.cos(yaw) * Math.cos(pitch);
      return (fx * dx + fy * dy + fz * dz) / (d || 1) > 0.866; // cos 30°
    }

    function clampToArena(pos) {
      if (pos[0] > ARENA_HALF) pos[0] = ARENA_HALF;
      if (pos[0] < -ARENA_HALF) pos[0] = -ARENA_HALF;
      if (pos[2] > ARENA_HALF) pos[2] = ARENA_HALF;
      if (pos[2] < -ARENA_HALF) pos[2] = -ARENA_HALF;
      if (pos[1] > 11500) pos[1] = 11500;
    }

    function deployFlare(id) {
      flareTimer[id] = 2.0;
      flarePos[id * 3] = ents.pos[id * 3];
      flarePos[id * 3 + 1] = ents.pos[id * 3 + 1] - 4;
      flarePos[id * 3 + 2] = ents.pos[id * 3 + 2];
      particles.emitFlare(ents.pos[id * 3], ents.pos[id * 3 + 1] - 3, ents.pos[id * 3 + 2],
        ents.vel[id * 3], ents.vel[id * 3 + 1], ents.vel[id * 3 + 2]);
    }

    // Mission death flow (Task 2.7): Rookie/Veteran restore the stage-start checkpoint
    // (ammo/HP/stage), Ace ends the mission (debrief offers a full restart).
    function handleMissionDeath() {
      if (!mission || !mission.running) return;
      const restored = mission.restoreStage();
      if (restored) {
        applyPlayerSnapshot(mission.checkpoint ? mission.checkpoint.player : null);
        restoreFlash = 1.6;
        audio.beep(740, 0.3, 0.3);
      } else {
        // Ace (no restores) or Veteran out of restores: fail immediately, no hang
        mission.failNow('aircraft destroyed');
      }
    }

    // ---- fixed 120 Hz physics tick (PRD: input sampled exactly once per tick) ----
    function step(dt) {
      simTime += dt;
      input.sample();
      const sdt = dt * impactCam.timeScale; // Impact Cam slow-mo (Task 1.8)

      // --- mission orchestration (stages, objectives, waves, cruise missiles) ---
      if (mission) mission.tick(sdt);

      // --- player ---
      if (ents.isAlive(playerId)) {
        if (playerState === 'FLYING') {
          playerFlight.tick(input.getAxis(ACTION.PITCH), input.getAxis(ACTION.ROLL),
            input.getAxis(ACTION.YAW), input.getAxis(ACTION.THROTTLE),
            input.isDown(ACTION.AFTERBURNER), input.isDown(ACTION.AIRBRAKE), sdt);
          syncEntity(playerId, playerFlight);
          handleJetEnvironment(playerId, playerFlight, true);
          // bounded arena (PRD non-goal: bounded arenas)
          clampToArena(playerFlight.pos);
        } else {
          updateCarrierOps(sdt, input);
        }

        // target cycling (Task 1.9 / controls table: R next, E nearest)
        if (input.wasPressed(ACTION.TARGET_NEXT)) pickTarget(true);
        if (input.wasPressed(ACTION.TARGET_NEAREST)) pickTarget(false);

        // lock FSM + missiles (Task 1.4)
        const inRange = lockInRange();
        const fireReq = lock.update(sdt, inRange, false,
          input.isDown(ACTION.FIRE_MISSILE), ents.missilesLeft[playerId] > 0);
        if (fireReq) {
          if (spawnMissileFor(playerId, targetId, shooterView)) {
            ents.missilesLeft[playerId]--;
          }
          lock.notifySpawned();
        }

        // guns (Task 1.3)
        noseOf(playerId, shooterView);
        gunCd[playerId] = guns.tryFire(shooterView, input.isDown(ACTION.FIRE_GUN),
          gunCd[playerId], sdt);

        // flares (PRD: F key) - decoy enemy missiles + break enemy locks (via flareTimer)
        if (input.wasPressed(ACTION.FLARE) && ents.flareCount[playerId] > 0) {
          ents.flareCount[playerId]--;
          deployFlare(playerId);
        }
        if (restoreFlash > 0) restoreFlash -= sdt;
      } else if (mission) {
        // mission mode: checkpoint restore (Rookie/Veteran) or fail (Ace / out of restores)
        respawnTimer -= dt;
        if (respawnTimer <= 0) handleMissionDeath();
      } else {
        // free flight: auto-respawn keeps the sandbox playable (PRD: no soft-locks)
        respawnTimer -= dt;
        if (respawnTimer <= 0) {
          ents.type[playerId] = ENT_TYPE.JET;
          ents.alive[playerId] = 1;
          ents.health[playerId] = ents.maxHealth[playerId];
          ents.missilesLeft[playerId] = 6;
          ents.flareCount[playerId] = playerData.flareCount;
          playerFlight.teleport(0, 900, 14000, Math.PI, 0);
          playerFlight.speed = playerFlight.maxSpeed * 0.6;
          playerFlight.throttle = 0.8;
          playerFlight.pidPitch.reset(); playerFlight.pidRoll.reset(); playerFlight.pidYaw.reset();
          syncEntity(playerId, playerFlight);
          playerState = 'FLYING';
        }
      }

      // --- enemies (Task 1.5 + Phase 2 spawner registry; dynamic count) ---
      for (let i = 0; i < N_ENEMY; i++) {
        const eid = enemyIds[i];
        if (!ents.isAlive(eid)) continue;
        const ai = enemyAI[i];
        const f = enemyFlight[i];
        const cmd = ai.update(sdt, simTime);
        const throttleAxis = cmd.throttle > f.throttle ? 1 : (cmd.throttle < f.throttle ? -1 : 0);
        f.tick(cmd.pitch, cmd.roll, cmd.yaw, throttleAxis, cmd.afterburner, cmd.airbrake, sdt);
        syncEntity(eid, f);
        clampToArena(f.pos);
        handleJetEnvironment(eid, f, false);

        enemyView.gunDamage = enemyData.gunDamage;
        noseOf(eid, enemyView);
        gunCd[eid] = guns.tryFire(enemyView, cmd.fireGun, gunCd[eid], sdt);

        enemyMissileCd[i] -= sdt;
        if (cmd.spawnMissile && enemyMissileCd[i] <= 0 && ents.missilesLeft[eid] > 0) {
          if (spawnMissileFor(eid, playerId, enemyView)) {
            ents.missilesLeft[eid]--;
            enemyMissileCd[i] = 6;
          }
        }
        if (cmd.flareNow && ents.flareCount[eid] > 0) {
          ents.flareCount[eid]--;
          deployFlare(eid);
          if (eid === targetId) lock.targetFlared(); // PRD: flares break lock
        }
      }

      // --- missiles (Task 1.4: PN guidance + proximity fuse; Phase 2 cruise missiles too) ---
      missiles.update(sdt, ents, (x, y, z) => { particles.emitTrail(x, y, z); });

      // --- carrier (Task 1.7: moving deck; free flight only) ---
      if (freeMode) {
        carrier.update(sdt, ARENA_HALF);
        ents.prevPos[carrierId * 3] = ents.pos[carrierId * 3];
        ents.prevPos[carrierId * 3 + 1] = ents.pos[carrierId * 3 + 1];
        ents.prevPos[carrierId * 3 + 2] = ents.pos[carrierId * 3 + 2];
        ents.pos[carrierId * 3] = carrier.pos[0];
        ents.pos[carrierId * 3 + 1] = 10;
        ents.pos[carrierId * 3 + 2] = carrier.pos[2];
        ents.rot[carrierId * 3] = carrier.yaw;
        ents.prevRot[carrierId * 3] = carrier.yaw;
      }

      // --- collision pass (Task 1.6: spatial hash + spheres; jet-jet rams, jet-ship) ---
      collision.rebuild(ents);
      for (let j = 0; j < N_ENEMY + 1; j++) {
        const id = j === 0 ? playerId : enemyIds[j - 1];
        if (!ents.isAlive(id)) continue;
        const n = collision.querySphere(ents, ents.pos[id * 3], ents.pos[id * 3 + 1],
          ents.pos[id * 3 + 2], ents.radius[id] + 12, nearIds);
        for (let k = 0; k < n; k++) {
          const oid = nearIds[k];
          if (oid === id) continue;
          if (ents.type[oid] === ENT_TYPE.JET && oid > id) {
            // mid-air ram: both take heavy damage (pair processed once via oid > id)
            applyDamage(id, 55);
            applyDamage(oid, 55);
          } else if (ents.type[oid] === ENT_TYPE.SHIP && ents.type[id] === ENT_TYPE.JET &&
            ents.pos[id * 3 + 1] < 120) {
            // ship hull hit at sea level (deck landings are handled by handleJetEnvironment;
            // the rig deck sits at ~26 m so low passes over it still collide here)
            killJet(id);
          }
        }
      }

      // --- flare burn timers ---
      for (let i = 0; i < ents.count; i++) {
        if (flareTimer[i] > 0) flareTimer[i] -= sdt;
      }

      // --- damage smoke (health < 35% -> oily trail, Task 1.8) ---
      for (let j = 0; j < N_ENEMY + 1; j++) {
        const id = j === 0 ? playerId : enemyIds[j - 1];
        if (!ents.isAlive(id)) continue;
        smokeCd[id] -= sdt;
        if (ents.health[id] < ents.maxHealth[id] * 0.35 && smokeCd[id] <= 0) {
          smokeCd[id] = 0.06;
          particles.emitDamageSmoke(ents.pos[id * 3], ents.pos[id * 3 + 1], ents.pos[id * 3 + 2],
            ents.vel[id * 3], ents.vel[id * 3 + 1], ents.vel[id * 3 + 2]);
        }
      }

      // --- missile warning (incoming at the player) ---
      warnCd -= sdt;
      if (warnCd <= 0 && ents.isAlive(playerId)) {
        let warned = false;
        for (let m = 0; m < missiles.max && !warned; m++) {
          const st = missiles.fsms[m].state;
          if (st === 0 || st === 8) continue; // SPAWN / RECYCLE
          if (missiles.targetId[m] === playerId) {
            const dx = missiles.pos[m * 3] - ents.pos[playerId * 3];
            const dy = missiles.pos[m * 3 + 1] - ents.pos[playerId * 3 + 1];
            const dz = missiles.pos[m * 3 + 2] - ents.pos[playerId * 3 + 2];
            if (dx * dx + dy * dy + dz * dz < 2200 * 2200) {
              audio.warnBeep();
              warnCd = 0.55;
              warned = true;
            }
          }
        }
      }

      // --- particles + end conditions ---
      particles.update(sdt);
      if (mission) {
        // mission end (SUCCESS or FAILED): brief beat for the final explosion, then debrief
        if (!ended && !mission.running &&
          (mission.state === MISSION_STATE.SUCCESS || mission.state === MISSION_STATE.FAILED)) {
          ended = true;
          endTimer = 1.4;
          missionHud.banner(mission.state === MISSION_STATE.SUCCESS
            ? 'MISSION SUCCESS' : 'MISSION FAILED');
          audio.beep(mission.state === MISSION_STATE.SUCCESS ? 1320 : 220, 0.5, 0.3);
        } else if (ended && endTimer > 0) {
          endTimer -= sdt;
        }
      } else if (!victory) {
        // free flight sandbox AC (Phase 1): victory when all 4 AI are destroyed
        let anyAlive = false;
        for (let i = 0; i < N_ENEMY; i++) if (ents.isAlive(enemyIds[i])) anyAlive = true;
        if (!anyAlive) {
          victory = true;
          audio.beep(1320, 0.5, 0.3);
        }
      }

      // --- audio (Task 1.8) ---
      audio.setEngine(playerFlight.throttle, playerFlight.afterburner);
      audio.setWind(Math.min(1, playerFlight.speed / playerFlight.maxSpeed));

      // --- invariants (Task 0.8 discipline carried into Phase 2) ---
      assertFinite3('player.pos', ents.pos[playerId * 3], ents.pos[playerId * 3 + 1],
        ents.pos[playerId * 3 + 2]);
      assertSpeedCapped('player.speed', playerFlight.speed, playerFlight.maxSpeed);
      for (let i = 0; i < N_ENEMY; i++) {
        const eid = enemyIds[i];
        if (!ents.isAlive(eid)) continue;
        assertFinite3('enemy.pos', ents.pos[eid * 3], ents.pos[eid * 3 + 1], ents.pos[eid * 3 + 2]);
        assertSpeedCapped('enemy.speed', enemyFlight[i].speed, enemyFlight[i].maxSpeed);
      }
      assertActiveCount('ents', ents.activeCount(), ents.max);
      assertActiveCount('missiles', missiles.activeCount(), missiles.max);
      assertActiveCount('tracers', guns.activeCount(), GUN_TUNING.MAX_TRACERS);
    }

    // ---- render side (interpolation + chase cam + HUD v1/v2) ----
    const rPos = new Float32Array(3);
    const rRot = new Float32Array(3);
    const camPos = new Float32Array([0, 900, 14500]);
    const camTarget = new Float32Array(3);
    let fovDeg = 62;
    const tracerData = new Float32Array(GUN_TUNING.MAX_TRACERS * 2 * 7);
    const MAX_SHIPS = 8;
    const MAX_GROUNDS = 32;
    const scene = {
      jetCount: 0,
      jetPos: new Float32Array((SPAWNER_JET_CAP + 1) * 3),
      jetRot: new Float32Array((SPAWNER_JET_CAP + 1) * 3),
      jetDist: new Float32Array(SPAWNER_JET_CAP + 1),
      jetKind: new Uint8Array(SPAWNER_JET_CAP + 1), // kitbash shape set per jet (Task 3A.2)
      carrierX: 0, carrierY: 0, carrierZ: 0, carrierYaw: 0,
      shipCount: 0,
      shipPos: new Float32Array(MAX_SHIPS * 3),
      shipRot: new Float32Array(MAX_SHIPS),
      shipKind: new Uint8Array(MAX_SHIPS),
      groundCount: 0,
      groundPos: new Float32Array(MAX_GROUNDS * 3),
      groundRot: new Float32Array(MAX_GROUNDS),
    };
    const projOut = new Float32Array(3);

    // HUD element handles (Task 1.9 + Phase 2 widgets)
    const hud = {
      fps: $('hud-fps'), ms: $('hud-ms'), pms: $('hud-pms'), hz: $('hud-hz'),
      lat: $('hud-lat'), scale: $('hud-scale'), heap: $('hud-heap'),
      spd: $('hud-spd'), alt: $('hud-alt'), thr: $('hud-thr'), jetName: $('hud-jet'),
      violations: $('hud-inv'),
      hp: $('hud-hp'), hpBar: $('hud-hp-bar'), msl: $('hud-msl'), lock: $('hud-lock'),
      banner: $('hud-banner'), targetBox: $('hud-target'), minimap: $('hud-map'),
      state: $('hud-state'),
    };
    hud.jetName.textContent = playerData.name + ' (' + playerData.id + ') diff ' +
      ['Rookie', 'Veteran', 'Ace'][worldDifficulty] + (freeMode ? '  sandbox' : '');
    const mapCtx = hud.minimap ? hud.minimap.getContext('2d') : null;
    let hudNext = 0;
    let latEma = 0;
    let lastLatencyEvent = -1;
    let lastRenderNow = -1;

    function updateTracers() {
      let v = 0;
      const pool = guns.pool;
      for (let i = 0; i < pool.max; i++) {
        if (guns.ttl[i] <= 0) continue;
        const o = v * 7;
        tracerData[o] = guns.pos0[i * 3]; tracerData[o + 1] = guns.pos0[i * 3 + 1];
        tracerData[o + 2] = guns.pos0[i * 3 + 2];
        tracerData[o + 3] = 1.0; tracerData[o + 4] = 0.92; tracerData[o + 5] = 0.55;
        tracerData[o + 6] = Math.min(1, guns.ttl[i] / 0.055);
        const o2 = o + 7;
        tracerData[o2] = guns.pos1[i * 3]; tracerData[o2 + 1] = guns.pos1[i * 3 + 1];
        tracerData[o2 + 2] = guns.pos1[i * 3 + 2];
        tracerData[o2 + 3] = 1.0; tracerData[o2 + 4] = 0.85; tracerData[o2 + 5] = 0.4;
        tracerData[o2 + 6] = 0;
        v += 2;
      }
      return v;
    }

    function drawMinimap() {
      if (!mapCtx) return;
      const w = hud.minimap.width, h = hud.minimap.height, half = w / 2;
      const scale = half / 8000; // 8 km radius view
      mapCtx.clearRect(0, 0, w, h);
      mapCtx.fillStyle = 'rgba(6, 14, 22, 0.72)';
      mapCtx.fillRect(0, 0, w, h);
      mapCtx.strokeStyle = '#2e5a72';
      mapCtx.beginPath();
      mapCtx.arc(half, half, half - 2, 0, Math.PI * 2);
      mapCtx.stroke();
      const px = ents.pos[playerId * 3], pz = ents.pos[playerId * 3 + 2];
      const pyaw = ents.rot[playerId * 3];
      const c = Math.cos(-pyaw), s = Math.sin(-pyaw);
      // carrier (free flight) + rig (protected asset)
      if (freeMode) {
        const dx0 = carrier.pos[0] - px, dz0 = carrier.pos[2] - pz;
        const rx0 = dx0 * c - dz0 * s, rz0 = dx0 * s + dz0 * c;
        mapCtx.fillStyle = '#cfd8dc';
        mapCtx.fillRect(half + rx0 * scale - 3, half + rz0 * scale - 2, 6, 4);
      }
      for (let g = 0; g < (spawner ? spawner.protectedIds.length : 0); g++) {
        const pid2 = spawner.protectedIds[g];
        if (!ents.isAlive(pid2)) continue;
        const dx0 = ents.pos[pid2 * 3] - px, dz0 = ents.pos[pid2 * 3 + 2] - pz;
        const rx0 = dx0 * c - dz0 * s, rz0 = dx0 * s + dz0 * c;
        mapCtx.fillStyle = '#7fd67f';
        mapCtx.fillRect(half + rx0 * scale - 3, half + rz0 * scale - 3, 6, 6);
      }
      // enemies (red) + lock target (yellow) - dynamic registry
      for (let i = 0; i < N_ENEMY; i++) {
        const eid = enemyIds[i];
        if (!ents.isAlive(eid)) continue;
        const dx = ents.pos[eid * 3] - px, dz = ents.pos[eid * 3 + 2] - pz;
        const rx = dx * c - dz * s, rz = dx * s + dz * c;
        mapCtx.fillStyle = eid === targetId ? '#ffd54f' : '#e57373';
        mapCtx.fillRect(half + rx * scale - 2, half + rz * scale - 2, 4, 4);
      }
      // player (center chevron)
      mapCtx.fillStyle = '#81d4fa';
      mapCtx.fillRect(half - 1, half - 3, 2, 6);
    }

    function render(alpha, now) {
      let realDt = lastRenderNow < 0 ? 0.016 : (now - lastRenderNow) / 1000;
      lastRenderNow = now;
      if (realDt > 0.25) realDt = 0.25;

      // interpolated player pose
      playerFlight.sampleInterpolated(alpha, rPos, rRot);

      // chase camera (Phase 0 behavior: lag + FOV kick on afterburner)
      const yaw = rRot[0], pitch = rRot[1];
      const fx = Math.sin(yaw) * Math.cos(pitch);
      const fy = Math.sin(pitch);
      const fz = -Math.cos(yaw) * Math.cos(pitch);
      const back = 42, up = 14;
      const dx = rPos[0] - fx * back;
      const dy = rPos[1] - fy * back * 0.4 + up;
      const dz = rPos[2] - fz * back;
      const k = 1 - Math.exp(-6 / 60);
      camPos[0] += (dx - camPos[0]) * k;
      camPos[1] += (dy - camPos[1]) * k;
      camPos[2] += (dz - camPos[2]) * k;
      camTarget[0] = rPos[0] + fx * 140;
      camTarget[1] = rPos[1] + fy * 140;
      camTarget[2] = rPos[2] + fz * 140;
      const targetFov = playerFlight.afterburner ? 70 : 62;
      fovDeg += (targetFov - fovDeg) * 0.08;

      // Impact Cam (Task 1.8): real-time 0.3 s slow-mo + camera cut
      impactCam.update(realDt, camPos, camTarget);
      if (impactCam.active) {
        camPos[0] = impactCam.camPos[0]; camPos[1] = impactCam.camPos[1];
        camPos[2] = impactCam.camPos[2];
        camTarget[0] = impactCam.camTarget[0]; camTarget[1] = impactCam.camTarget[1];
        camTarget[2] = impactCam.camTarget[2];
      }

      // scene fill: player first, then alive enemies (interpolated from the SoA registry)
      let n = 0;
      if (ents.isAlive(playerId)) {
        scene.jetPos[n * 3] = rPos[0]; scene.jetPos[n * 3 + 1] = rPos[1];
        scene.jetPos[n * 3 + 2] = rPos[2];
        scene.jetRot[n * 3] = rRot[0]; scene.jetRot[n * 3 + 1] = rRot[1];
        scene.jetRot[n * 3 + 2] = rRot[2];
        scene.jetKind[n] = ents.variant[playerId];
        n++;
      }
      for (let i = 0; i < N_ENEMY; i++) {
        const eid = enemyIds[i];
        if (!ents.isAlive(eid)) continue;
        scene.jetPos[n * 3] = ents.prevPos[eid * 3] + (ents.pos[eid * 3] - ents.prevPos[eid * 3]) * alpha;
        scene.jetPos[n * 3 + 1] = ents.prevPos[eid * 3 + 1] +
          (ents.pos[eid * 3 + 1] - ents.prevPos[eid * 3 + 1]) * alpha;
        scene.jetPos[n * 3 + 2] = ents.prevPos[eid * 3 + 2] +
          (ents.pos[eid * 3 + 2] - ents.prevPos[eid * 3 + 2]) * alpha;
        for (let a = 0; a < 3; a++) {
          const ra = ents.prevRot[eid * 3 + a], rb = ents.rot[eid * 3 + a];
          let d = rb - ra;
          if (d > Math.PI) d -= Math.PI * 2;
          if (d < -Math.PI) d += Math.PI * 2;
          scene.jetRot[n * 3 + a] = ra + d * alpha;
        }
        scene.jetKind[n] = ents.variant[eid];
        n++;
      }
      scene.jetCount = n;
      for (let i = 0; i < n; i++) {
        const ddx = scene.jetPos[i * 3] - camPos[0];
        const ddy = scene.jetPos[i * 3 + 1] - camPos[1];
        const ddz = scene.jetPos[i * 3 + 2] - camPos[2];
        scene.jetDist[i] = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
      }
      // Phase 2: boats + rig (kind: variant 2 -> mesh 0, variant 3 -> mesh 1) and ground units
      let sn = 0, gn = 0;
      for (let id = 0; id < ents.count; id++) {
        if (!ents.isAlive(id)) continue;
        if (ents.type[id] === ENT_TYPE.SHIP && id !== carrierId && sn < MAX_SHIPS) {
          scene.shipPos[sn * 3] = ents.pos[id * 3];
          scene.shipPos[sn * 3 + 1] = ents.pos[id * 3 + 1];
          scene.shipPos[sn * 3 + 2] = ents.pos[id * 3 + 2];
          scene.shipRot[sn] = ents.rot[id * 3];
          scene.shipKind[sn] = ents.variant[id] === 3 ? 1 : 0;
          sn++;
        } else if (ents.type[id] === ENT_TYPE.GROUND && gn < MAX_GROUNDS) {
          scene.groundPos[gn * 3] = ents.pos[id * 3];
          scene.groundPos[gn * 3 + 1] = ents.pos[id * 3 + 1];
          scene.groundPos[gn * 3 + 2] = ents.pos[id * 3 + 2];
          scene.groundRot[gn] = ents.rot[id * 3];
          gn++;
        }
      }
      scene.shipCount = sn;
      scene.groundCount = gn;
      scene.carrierX = carrier.pos[0]; scene.carrierY = freeMode ? 0 : -9999;
      scene.carrierZ = carrier.pos[2]; scene.carrierYaw = carrier.yaw;

      const timeSec = now * 0.001;
      renderer.drawFrame(camPos, camTarget, fovDeg * DEG, scene, timeSec);
      renderer.drawTracers(tracerData, updateTracers());

      // HUD target box (Task 1.9): project the lock target to screen space
      if (hud.targetBox) {
        if (targetId >= 0 && ents.isAlive(targetId) && !impactCam.active) {
          renderer.project(projOut, camPos,
            ents.pos[targetId * 3], ents.pos[targetId * 3 + 1], ents.pos[targetId * 3 + 2]);
          if (projOut[2] > 0) {
            hud.targetBox.style.display = 'block';
            hud.targetBox.style.left = (projOut[0] - 14) + 'px';
            hud.targetBox.style.top = (projOut[1] - 14) + 'px';
            hud.targetBox.style.borderColor =
              lock.state === LOCK_STATE.LOCKED ? '#ffd54f' : '#ff8a65';
          } else {
            hud.targetBox.style.display = 'none';
          }
        } else {
          hud.targetBox.style.display = 'none';
        }
      }

      drawMinimap();

      // input latency proof (PRD: < 50 ms event-to-render)
      if (input.lastEventTimeMs > lastLatencyEvent) {
        lastLatencyEvent = input.lastEventTimeMs;
        const lat = performance.now() - lastLatencyEvent;
        if (lat >= 0 && lat < 1000) latEma = latEma === 0 ? lat : latEma * 0.8 + lat * 0.2;
      }

      // HUD v2 objective tracker + protected HP + cruise missile warning (Task 2.8)
      if (mission && mission.stage) {
        const dag = mission.stage.dag;
        let reconDist = -1;
        for (let i = 0; i < dag.n; i++) {
          const d = dag.reconDistance(i, ents.pos[playerId * 3], ents.pos[playerId * 3 + 2]);
          if (d >= 0) { reconDist = d; break; }
        }
        let protectedHpFrac = 1;
        for (let g = 0; g < spawner.protectedIds.length; g++) {
          const pid2 = spawner.protectedIds[g];
          if (ents.isAlive(pid2)) {
            protectedHpFrac = ents.health[pid2] / ents.maxHealth[pid2];
            break;
          }
        }
        missionHud.update(now, mission, reconDist, protectedHpFrac);
      }

      // throttled HUD text (4 Hz) - strings stay out of the hot path
      if (now >= hudNext) {
        hudNext = now + 250;
        const s = loopStats;
        hud.fps.textContent = 'FPS ' + s.fps.toFixed(0);
        hud.ms.textContent = 'frame ' + s.frameMs.toFixed(2) + ' ms';
        hud.pms.textContent = 'physics ' + s.stepMs.toFixed(2) + ' ms';
        hud.hz.textContent = 'physics ' + s.stepsPerSecond.toFixed(0) + ' Hz / ' + s.lastSteps + ' steps';
        hud.lat.textContent = 'input latency ' + latEma.toFixed(1) + ' ms';
        hud.scale.textContent = 'res scale ' + renderer.renderScale.toFixed(2) +
          ' (' + canvas.width + 'x' + canvas.height + ')';
        // Phase 4 (Task 4.5): profiler line (named step/render timers + counters)
        if (hud.heap) profiler.count('missiles', missiles.activeCount());
        if (hud.heap) hud.heap.textContent = 'profiler ' + profiler.line();
        hud.spd.textContent = 'speed ' + (playerFlight.speed * 3.6).toFixed(0) + ' km/h' +
          (ents.gearDown[playerId] ? ' + gear' : '');
        hud.alt.textContent = 'alt ' + ents.pos[playerId * 3 + 1].toFixed(0) + ' m';
        hud.thr.textContent = 'throttle ' + (playerFlight.throttle * 100).toFixed(0) + '%' +
          (playerFlight.afterburner ? ' + AB' : '');
        // Task 1.9: health / missiles / lock / state
        const hpFrac = Math.max(0, ents.health[playerId] / ents.maxHealth[playerId]);
        hud.hp.textContent = 'health ' + Math.round(hpFrac * 100) + '%';
        hud.hpBar.style.width = (hpFrac * 100).toFixed(0) + '%';
        hud.hpBar.style.background = hpFrac > 0.35 ? '#7fd67f' : '#ff6b6b';
        hud.msl.textContent = 'missiles ' + ents.missilesLeft[playerId] +
          '  flares ' + ents.flareCount[playerId];
        hud.lock.textContent = 'lock ' + lock.stateName() +
          (targetId >= 0 && ents.isAlive(targetId) ? '  tgt ' + (enemyIds.indexOf(targetId) + 1) : '  ---');
        hud.lock.style.color = lock.state === LOCK_STATE.LOCKED ? '#ffd54f' : '#cfe8ff';
        hud.state.textContent = restoreFlash > 0 ? 'CHECKPOINT RESTORED - stage restart' :
          playerState === 'FLYING' ? '' :
          playerState === 'PARKED' ? 'ON DECK - hold W to catapult' :
          playerState === 'CATAPULT' ? 'CATAPULT...' :
          playerState === 'LANDING_ROLL' ? 'ROLLOUT...' : 'DESTROYED - ' +
            (mission ? 'checkpoint' : 'respawning');
        if (hud.banner) {
          if (freeMode && victory) {
            hud.banner.textContent = 'VICTORY - all hostile aircraft destroyed';
            hud.banner.hidden = false;
          }
        }
        const v = getViolationCount();
        hud.violations.textContent = v === 0 ? 'invariants OK' : 'INVARIANT VIOLATIONS: ' + v;
        hud.violations.style.color = v === 0 ? '#9f9' : '#f66';
      }
    }

    // ---- session object consumed by the Game FSM (boot scope) ----
    return {
      ents, playerId, mission, spawner,
      freeMode, difficulty: worldDifficulty, missionDef, map,
      step, render,
      isEnded() { return ended && endTimer <= 0; },
      takeResults() {
        if (mission) return mission.results();
        return {
          title: 'Free Flight', success: victory, kills: 0,
          timeSec: Math.round(simTime), score: 0, difficulty: worldDifficulty, restores: 0,
        };
      },
    };
  }

  // ---- menu + hangar screens (Task 3A.4: hangar is a grid + stats + compare + credits) ----
  let selectedJet = jetList.find((j) => jetOwnedSave(j)) || jetList[0];
  const menuEl = document.createElement('div');
  menuEl.id = 'screen-menu';
  menuEl.className = 'skyburn-screen';
  document.body.appendChild(menuEl);

  function refreshMenu() {
    menuEl.innerHTML =
      '<div class="sb-panel">' +
      '<div class="sb-kicker">SKYBURN</div>' +
      '<h1>OPERATIONS</h1>' +
      '<div class="sb-menu-list" id="menu-list"></div>' +
      '<div class="sb-sub">DIFFICULTY</div>' +
      '<div class="sb-row" id="menu-diff"></div>' +
      '<div class="sb-meta" style="margin-top:10px">Phase 3 - missions M1-M14 across eight ' +
      'sectors, plus free flight. Checkpoints save at every stage start.</div>' +
      '</div>';
    const list = menuEl.querySelector('#menu-list');
    for (const def of missions) {
      const btn = document.createElement('button');
      btn.className = 'sb-btn';
      const unlocked = saveData.unlocked.indexOf(def.id) >= 0;
      const done = saveData.results[def.id];
      btn.innerHTML = (unlocked ? def.title : def.title + ' [LOCKED]') +
        '<small>' + (done ? (done.success ? 'CLEARED - ' + done.score : 'attempted') :
          'reward ' + def.reward) + '</small>';
      if (!unlocked) {
        btn.classList.add('locked');
      } else {
        btn.addEventListener('click', () => {
          pendingLaunch = {
            free: false, missionDef: def, map: maps[def.map], difficulty, jetData: selectedJet,
          };
          fireGame(GAME_EVENT.PICK);
        });
      }
      list.appendChild(btn);
    }
    const free = document.createElement('button');
    free.className = 'sb-btn';
    free.innerHTML = 'FREE FLIGHT SANDBOX<small>dogfight + carrier ops (Phase 1)</small>';
    free.addEventListener('click', () => {
      pendingLaunch = {
        free: true, missionDef: null,
        freeDef: {
          title: 'Free Flight Sandbox',
          briefing: 'Open training airspace: 4 hostiles patrol the sector and carrier Nemesis ' +
            'is on station. Land on the deck slow (<180 kn) with gear, hold W to catapult.',
          map: 'ocean',
          stages: [{ objectives: [{ label: 'Survive and score kills' }] }],
          reward: 0,
        },
        map: maps.ocean, difficulty, jetData: selectedJet,
      };
      fireGame(GAME_EVENT.PICK);
    });
    list.appendChild(free);

    const diffRow = menuEl.querySelector('#menu-diff');
    const diffNote = ['unlimited checkpoints', '3 checkpoints', 'no respawn'];
    ['ROOKIE', 'VETERAN', 'ACE'].forEach((name, i) => {
      const b = document.createElement('button');
      b.className = 'sb-btn' + (i === difficulty ? ' primary' : '');
      b.textContent = name + ' - ' + diffNote[i];
      b.addEventListener('click', () => {
        difficulty = i;
        saveData.difficulty = i;
        void persistSave();
        refreshMenu();
      });
      diffRow.appendChild(b);
    });

    // Task 3B.5: volume sliders (persisted in saveData.settings; applied immediately)
    const settings = saveData.settings || (saveData.settings = {});
    const volRow = document.createElement('div');
    volRow.className = 'sb-vol-row';
    [['master', 'MASTER', (v) => audio.setVolumes({ master: v })],
     ['music', 'MUSIC', (v) => music.setVolume(v)],
     ['sfx', 'SFX', (v) => audio.setVolumes({ sfx: v })]].forEach(([key, label, apply]) => {
      const wrap = document.createElement('div');
      wrap.className = 'sb-vol';
      const name = document.createElement('span');
      name.textContent = label;
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '1';
      slider.step = '0.05';
      slider.value = String(settings[key] !== undefined ? settings[key] : 0.5);
      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        settings[key] = v;
        apply(v);
        void persistSave();
      });
      wrap.appendChild(name);
      wrap.appendChild(slider);
      volRow.appendChild(wrap);
    });
    menuEl.querySelector('.sb-panel').appendChild(volRow);

    // ---- Phase 4 (Tasks 4.6 + 4.7): gamepad + accessibility settings (persisted) ----
    const gp = settings.gamepad || (settings.gamepad =
      { deadzone: 0.12, sensitivity: 1.0, rumble: true, remap: {} });
    const mkToggle = (label, get, set) => {
      const b = document.createElement('button');
      b.className = 'sb-btn';
      const paint = () => { b.textContent = label + ': ' + (get() ? 'ON' : 'OFF'); };
      b.addEventListener('click', () => { set(!get()); paint(); void persistSave(); });
      paint();
      return b;
    };
    const gpRow = document.createElement('div');
    gpRow.className = 'sb-vol-row';
    gpRow.appendChild(mkToggle('RUMBLE', () => gp.rumble !== false, (v) => {
      gp.rumble = v;
      input.setPadSettings(gp);
    }));
    [['deadzone', 'DZ', 0, 0.3, 0.01], ['sensitivity', 'SENS', 0.5, 2, 0.1]].forEach(
      ([key, label, min, max, step]) => {
        const wrap = document.createElement('div');
        wrap.className = 'sb-vol';
        const name = document.createElement('span');
        name.textContent = label;
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = String(min);
        slider.max = String(max);
        slider.step = String(step);
        slider.value = String(typeof gp[key] === 'number' ? gp[key] : key === 'deadzone' ? 0.12 : 1);
        slider.addEventListener('input', () => {
          gp[key] = parseFloat(slider.value);
          input.setPadSettings(gp);
          void persistSave();
        });
        wrap.appendChild(name);
        wrap.appendChild(slider);
        gpRow.appendChild(wrap);
      });
    // face-button remap cycles (persisted; standard mapping is the fallback)
    const CYCLE = [0, 1, 2, 3, 4, 5, 10];            // A B X Y LB RB L3
    const CYCLE_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'L3'];
    const PB_DEFAULT = { fireMissile: 0, flare: 1, switchWeapon: 2, targetNext: 3 };
    Object.keys(PB_DEFAULT).forEach((key) => {
      const label = { fireMissile: 'MISSILE', flare: 'FLARE',
        switchWeapon: 'WEAPON', targetNext: 'TARGET' }[key];
      const b = document.createElement('button');
      b.className = 'sb-btn';
      const paint = () => {
        const cur = gp.remap[key] !== undefined ? gp.remap[key] : PB_DEFAULT[key];
        const idx = CYCLE.indexOf(cur);
        b.textContent = label + ': ' + (idx >= 0 ? CYCLE_NAMES[idx] : '?');
      };
      b.addEventListener('click', () => {
        const cur = gp.remap[key] !== undefined ? CYCLE.indexOf(gp.remap[key])
          : CYCLE.indexOf(PB_DEFAULT[key]);
        const next = CYCLE[(cur + 1) % CYCLE.length];
        if (next === PB_DEFAULT[key]) delete gp.remap[key];  // keep the save minimal
        else gp.remap[key] = next;
        input.setPadSettings(gp);
        paint();
        void persistSave();
      });
      paint();
      gpRow.appendChild(b);
    });
    menuEl.querySelector('.sb-panel').appendChild(gpRow);

    const accRow = document.createElement('div');
    accRow.className = 'sb-vol-row';
    const PAL_MODES = ['normal', 'protan', 'deutan', 'tritan'];
    const palB = document.createElement('button');
    palB.className = 'sb-btn';
    const paintPal = () => {
      palB.textContent = 'HUD COLORS: ' + (settings.colorblind || 'normal').toUpperCase();
    };
    palB.addEventListener('click', () => {
      const cur = PAL_MODES.indexOf(settings.colorblind || 'normal');
      settings.colorblind = PAL_MODES[(cur + 1) % PAL_MODES.length];
      missionHud.setPalette(settings.colorblind);
      paintPal();
      void persistSave();
    });
    paintPal();
    accRow.appendChild(palB);
    accRow.appendChild(mkToggle('SUBTITLES', () => settings.subtitles !== false,
      (v) => { settings.subtitles = v; }));
    accRow.appendChild(mkToggle('REDUCED MOTION', () => !!settings.reducedMotion,
      (v) => { settings.reducedMotion = v; missionHud.reducedMotion = v; }));
    accRow.appendChild(mkToggle('AUTO QUALITY', () => settings.autoQuality !== false,
      (v) => { settings.autoQuality = v; quality.enabled = v; }));
    menuEl.querySelector('.sb-panel').appendChild(accRow);
  }
  function menuShow() { menuEl.hidden = false; refreshMenu(); }
  function menuHide() { menuEl.hidden = true; }

  const hangar = new HangarScreen(document, {
    jets: jetList,
    weaponNames,
    getSave: () => saveData,
    onSelect: (jet) => {
      selectedJet = jet;
      if (pendingLaunch) pendingLaunch.jetData = jet;
      fireGame(GAME_EVENT.PICK);
    },
    onBuy: () => { void persistSave(); },
    onBuyFail: (reason) => {
      audio.beep(reason === 'insufficient-credits' ? 180 : 240, 0.15, 0.2);
    },
    onBack: () => fireGame(GAME_EVENT.BACK),
  });
  function jetOwnedSave(jet) {
    return saveData.ownedJets && saveData.ownedJets.indexOf(jet.id) >= 0;
  }
  function hangarShow() { hangar.show(selectedJet); }
  function hangarHide() { hangar.hide(); }

  // ---- attract camera behind the menus (slow ocean orbit, no sim) ----
  const attractCamPos = new Float32Array([7000, 1800, 0]);
  const attractCamTarget = new Float32Array([0, 200, 0]);
  const attractScene = {
    jetCount: 0,
    jetPos: new Float32Array(3), jetRot: new Float32Array(3), jetDist: new Float32Array(1),
    carrierX: 0, carrierY: -9999, carrierZ: 0, carrierYaw: 0,
    shipCount: 0,
    shipPos: new Float32Array(3), shipRot: new Float32Array(1), shipKind: new Uint8Array(1),
    groundCount: 0, groundPos: new Float32Array(3), groundRot: new Float32Array(1),
  };
  function renderAttract(now) {
    const t = now * 0.001;
    const r = 7200;
    attractCamPos[0] = Math.cos(t * 0.02) * r;
    attractCamPos[1] = 1900;
    attractCamPos[2] = Math.sin(t * 0.02) * r;
    renderer.drawFrame(attractCamPos, attractCamTarget, 58 * DEG, attractScene, t);
  }

  // ---- main loop driver: sim only in PLAYING; attract render behind every screen ----
  // Phase 4 (Task 4.7): PAUSED renders the frozen world (no sim step runs, which
  // structurally guarantees the PRD "no damage in PAUSED" invariant).
  // Phase 4 (Task 4.5): profiler timers around step/render + auto quality governor
  // (fps < 50 for 5 s -> render scale 0.8 then 0.6; user toggle persisted).
  const quality = new QualityGovernor((scale) => renderer.setRenderScale(scale));
  quality.enabled = !(saveData.settings && saveData.settings.autoQuality === false);
  const profiler = new Profiler();
  let loopStats = null;
  const loop = new GameLoop({
    step: (dt) => {
      if (game.state === GAME_STATE.PLAYING && world) {
        profiler.begin('step');
        world.step(dt);
        profiler.end('step');
        if (world.isEnded()) fireGame(GAME_EVENT.ENDED);
      }
    },
    render: (alpha) => {
      const now = performance.now();
      music.tick();   // Task 3B.5: lookahead scheduler (cheap; no-op when not playing)
      if ((game.state === GAME_STATE.PLAYING || game.state === GAME_STATE.PAUSED) && world) {
        profiler.begin('render');
        world.render(alpha, now);
        profiler.end('render');
        profiler.count('draws', renderer.drawCalls);
        profiler.count('ents', world.ents.activeCount());
      } else {
        renderAttract(now);
      }
      if (quality.enabled) quality.update(loop.stats.frameMs / 1000, loop.stats.fps);
    },
  });
  loopStats = loop.stats;

  // resize handling: DPR scaling + dynamic resolution ([ and ] keys adjust render scale)
  function doResize() {
    renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    input.setViewport();
  }
  window.addEventListener('resize', doResize);
  doResize();

  window.addEventListener('keydown', (e) => {
    if (e.code === 'BracketLeft') renderer.setRenderScale(renderer.renderScale - 0.1);
    if (e.code === 'BracketRight') renderer.setRenderScale(renderer.renderScale + 0.1);
    // Task 4.7: pause/resume (PRD Game FSM PLAYING <-> PAUSED). No sim step runs in
    // PAUSED - the loop only steps in PLAYING - so no damage can occur while paused.
    if (e.code === 'Escape' || e.code === 'KeyP') {
      if (game.state === GAME_STATE.PLAYING) fireGame(GAME_EVENT.PAUSE);
      else if (game.state === GAME_STATE.PAUSED) fireGame(GAME_EVENT.RESUME);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) audio.suspend();
  });

  function frameCb(nowMs) {
    loop.frame(nowMs);
    requestAnimationFrame(frameCb);
  }
  refreshMenu();
  menuShow();
  requestAnimationFrame(frameCb);
}

// Auto-boot only in a browser (Node tests import this module headlessly).
if (typeof document !== 'undefined') {
  boot().catch((e) => showError('Boot failed: ' + (e && e.message ? e.message : e)));
}
