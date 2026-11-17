// Skyburn Phase 1 - Entry point: dogfight vs 4 AI + carrier Nemesis operations (PRD Phase 1).
// Wiring: Input -> FlightModel (6DOF+PID) -> Lock FSM -> Guns/Missiles -> Collision -> Particles
// -> Audio, at fixed 120 Hz with render interpolation. No logic in render; no allocation in the
// hot path (all scratch preallocated). Victory when all AI are destroyed (PRD AC).
// Carrier ops: auto-gear approach -> arrestor landing (< 180 kn) -> deck hold -> catapult.

import { GameLoop, FIXED_DT } from './core/loop.js';
import { InputSystem, ACTION } from './core/input.js';
import { AudioSystem } from './core/audio.js';
import { Renderer, buildJetLod } from './render/renderer.js';
import { Terrain } from './world/terrain.js';
import { Ocean } from './world/ocean.js';
import { Carrier, CARRIER_TUNING } from './world/carrier.js';
import { WorldEntities, TEAM, ENT_TYPE } from './combat/entities.js';
import { CollisionWorld, groundHitAt } from './combat/collision.js';
import { FlightModel } from './physics/flight.js';
import { GunSystem, GUN_TUNING } from './combat/guns.js';
import { MissileSystem, MISSILE_TUNING } from './combat/missiles.js';
import { LockSystem, LOCK_STATE } from './combat/lockon.js';
import { EnemyAI, AI_STATE } from './ai/enemy.js';
import { ParticleSystem, P_KIND } from './render/particles.js';
import { ImpactCam } from './render/impactCam.js';
import { initVec3 } from './wasm/vec3.js';
import {
  assertFinite3, assertSpeedCapped, assertActiveCount, getViolationCount,
} from './verify/invariants.js';

const DEG = Math.PI / 180;
const ARENA_HALF = 19000;
const PLAYER_MAX_ENTS = 512;

function $(id) { return document.getElementById(id); }

function showError(msg) {
  const el = $('err');
  if (el) { el.hidden = false; el.textContent = msg; }
}

async function loadJets() {
  const resp = await fetch('./src/data/jets.json');
  if (!resp.ok) throw new Error('Failed to load src/data/jets.json: ' + resp.status);
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

  // Task 0.7: WASM vec3 stub (falls back to JS with the same API when no toolchain artifact)
  initVec3().catch(() => {});

  let jets;
  try {
    jets = await loadJets();
  } catch (e) {
    showError('Failed to load jets data: ' + e.message);
    return;
  }
  const jetList = Array.isArray(jets) ? jets : jets.jets;
  const playerData = pickJet(jets, 'f16c');
  const enemyData = jetList.find((j) => j.id === 'mig29') || jetList[jetList.length - 1];
  const difficulty = pickDifficulty();

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
  renderer.setJetLods([buildJetLod(0), buildJetLod(1), buildJetLod(2)]);

  const audio = new AudioSystem({});
  const input = new InputSystem({ onFirstInput: () => { if (audio.init()) audio.resume(); } });
  input.attach(canvas, window);

  // ---- world state (Task 1.2: SoA registry, max 512) ----
  const ents = new WorldEntities(PLAYER_MAX_ENTS);
  const collision = new CollisionWorld(ents.max);

  // player starts airborne heading toward the carrier operating area
  const playerFlight = new FlightModel(playerData, { x: 0, y: 800, z: 14000, yaw: Math.PI, throttle: 0.8 });
  const playerId = ents.spawn(ENT_TYPE.JET, TEAM.PLAYER,
    playerFlight.pos[0], playerFlight.pos[1], playerFlight.pos[2],
    playerFlight.rot[0], playerFlight.rot[1], 0, 9, 100);
  ents.missilesLeft[playerId] = 6;
  ents.flareCount[playerId] = playerData.flareCount;
  ents.speed[playerId] = playerFlight.speed;

  const carrier = new Carrier({ x: 1500, z: -2500, yaw: 2.2 });
  const carrierId = ents.spawn(ENT_TYPE.SHIP, TEAM.NEUTRAL,
    carrier.pos[0], 10, carrier.pos[2], carrier.yaw, 0, 0, 70, 2500);

  // 4 AI enemies (Task 1.5 / AC "Dogfight 4 AI"), spread around the arena
  const N_ENEMY = 4;
  const enemyIds = [];
  const enemyFlight = [];
  const enemyAI = [];
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
    enemyIds.push(id);
    enemyFlight.push(f);
    const ai = new EnemyAI(ents, null, id, { id: playerId }, difficulty, 0xBEEF + i, {});
    enemyAI.push(ai);
  }

  // ---- combat systems ----
  const particles = new ParticleSystem(2000, 0x9E3779B);
  const impactCam = new ImpactCam();

  const flareTimer = new Float32Array(ents.max);   // >0 while flares burn (per entity)
  const flarePos = new Float32Array(ents.max * 3);
  const gunCd = new Float32Array(ents.max);        // per-entity gun cooldown
  const smokeCd = new Float32Array(ents.max);      // damage-smoke emitter throttle
  const enemyMissileCd = new Float32Array(N_ENEMY);
  const blastIds = new Int32Array(64);

  const missiles = new MissileSystem(0x51D3, {
    onExplode: (x, y, z, ownerId) => {
      particles.burstExplosion(x, y, z);
      audio.explosion();
      // blast damage (Task 1.6/1.4): every alive entity within BLAST_RADIUS takes 60
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
  for (const ai of enemyAI) ai.missiles = missiles; // threat scan needs the live system

  function applyDamage(id, dmg, hx, hy, hz) {
    const killed = ents.damage(id, dmg);
    if (killed) {
      particles.burstExplosion(ents.pos[id * 3], ents.pos[id * 3 + 1], ents.pos[id * 3 + 2]);
      audio.explosion();
    } else if (hx !== undefined) {
      particles.spawn(P_KIND.FLASH, hx, hy, hz, 0, 2, 0, 0.5, 6, 1, 0.8, 0.4); // hit flash
    }
  }

  // guns: one shared hitscan system; per-entity cooldowns live in gunCd
  const guns = new GunSystem(0xC0FFEE);
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

  // ---- game state ----
  let playerState = 'FLYING';   // FLYING | LANDING_ROLL | PARKED | CATAPULT | DESTROYED
  let respawnTimer = 0;
  let catapultTimer = 0;
  let rolloutSpeed = 0;
  let victory = false;
  let defeat = false;
  let simTime = 0;
  let warnCd = 0;

  // player shooter view (preallocated; mutated before each tryFire)
  const shooterView = {
    id: playerId, team: TEAM.PLAYER, gunDamage: playerData.gunDamage,
    noseX: 0, noseY: 0, noseZ: 0, fx: 0, fy: 1, fz: 0, world: ents,
  };

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
      for (let k = 1; k <= N_ENEMY; k++) {
        const cand = enemyIds[(enemyIds.indexOf(targetId) + k) % N_ENEMY];
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
      defeat = false; // respawn keeps the fight going (PRD: no soft-locks)
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

  // ---- fixed 120 Hz physics tick (PRD: input sampled exactly once per tick) ----
  function step(dt) {
    simTime += dt;
    input.sample();
    const sdt = dt * impactCam.timeScale; // Impact Cam slow-mo (Task 1.8)

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
    } else {
      // destroyed: auto-respawn keeps the game playable (PRD: no soft-locks)
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
        lock.targetLost();
      }
    }

    // --- enemies (Task 1.5) ---
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

    // --- missiles (Task 1.4: PN guidance + proximity fuse) ---
    missiles.update(sdt, ents, (x, y, z) => { particles.emitTrail(x, y, z); });

    // --- carrier (Task 1.7: moving deck) ---
    carrier.update(sdt, ARENA_HALF);
    ents.prevPos[carrierId * 3] = ents.pos[carrierId * 3];
    ents.prevPos[carrierId * 3 + 1] = ents.pos[carrierId * 3 + 1];
    ents.prevPos[carrierId * 3 + 2] = ents.pos[carrierId * 3 + 2];
    ents.pos[carrierId * 3] = carrier.pos[0];
    ents.pos[carrierId * 3 + 1] = 10;
    ents.pos[carrierId * 3 + 2] = carrier.pos[2];
    ents.rot[carrierId * 3] = carrier.yaw;
    ents.prevRot[carrierId * 3] = carrier.yaw;

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
        } else if (ents.type[oid] === ENT_TYPE.SHIP && playerState === 'FLYING') {
          // ship hull hit (deck landings are handled separately by handleJetEnvironment)
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

    // --- particles + victory check (PRD AC: victory when all AI dead) ---
    particles.update(sdt);
    if (!victory) {
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

    // --- invariants (Task 0.8 discipline carried into Phase 1) ---
    assertFinite3('player.pos', ents.pos[playerId * 3], ents.pos[playerId * 3 + 1], ents.pos[playerId * 3 + 2]);
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

  // ---- render side (interpolation + chase cam + HUD v1) ----
  const rPos = new Float32Array(3);
  const rRot = new Float32Array(3);
  const camPos = new Float32Array([0, 900, 14500]);
  const camTarget = new Float32Array(3);
  let fovDeg = 62;
  const tracerData = new Float32Array(GUN_TUNING.MAX_TRACERS * 2 * 7);
  const scene = {
    jetCount: 0,
    jetPos: new Float32Array((N_ENEMY + 1) * 3),
    jetRot: new Float32Array((N_ENEMY + 1) * 3),
    jetDist: new Float32Array(N_ENEMY + 1),
    carrierX: 0, carrierY: 0, carrierZ: 0, carrierYaw: 0,
  };
  const projOut = new Float32Array(3);

  // HUD element handles (Task 1.9: speed/alt/throttle/health/missiles/lock/crosshair/target/minimap)
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
    ['Rookie', 'Veteran', 'Ace'][difficulty];
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
    // carrier
    let dx = carrier.pos[0] - px, dz = carrier.pos[2] - pz;
    let rx = dx * c - dz * s, rz = dx * s + dz * c;
    mapCtx.fillStyle = '#cfd8dc';
    mapCtx.fillRect(half + rx * scale - 3, half + rz * scale - 2, 6, 4);
    // enemies (red) + lock target (yellow)
    for (let i = 0; i < N_ENEMY; i++) {
      const eid = enemyIds[i];
      if (!ents.isAlive(eid)) continue;
      dx = ents.pos[eid * 3] - px; dz = ents.pos[eid * 3 + 2] - pz;
      rx = dx * c - dz * s; rz = dx * s + dz * c;
      mapCtx.fillStyle = eid === targetId ? '#ffd54f' : '#e57373';
      mapCtx.fillRect(half + rx * scale - 2, half + rz * scale - 2, 4, 4);
    }
    // player (center chevron)
    mapCtx.fillStyle = '#81d4fa';
    mapCtx.fillRect(half - 1, half - 3, 2, 6);
  }

  const loop = new GameLoop({
    // ---- fixed 120 Hz physics ----
    step: (dt) => { step(dt); },
    // ---- variable render with interpolation; no game logic here ----
    render: (alpha) => {
      const now = performance.now();
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
        n++;
      }
      scene.jetCount = n;
      for (let i = 0; i < n; i++) {
        const ddx = scene.jetPos[i * 3] - camPos[0];
        const ddy = scene.jetPos[i * 3 + 1] - camPos[1];
        const ddz = scene.jetPos[i * 3 + 2] - camPos[2];
        scene.jetDist[i] = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
      }
      scene.carrierX = carrier.pos[0]; scene.carrierY = 0; scene.carrierZ = carrier.pos[2];
      scene.carrierYaw = carrier.yaw;

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

      // throttled HUD text (4 Hz) - strings stay out of the hot path
      if (now >= hudNext) {
        hudNext = now + 250;
        const s = loop.stats;
        hud.fps.textContent = 'FPS ' + s.fps.toFixed(0);
        hud.ms.textContent = 'frame ' + s.frameMs.toFixed(2) + ' ms';
        hud.pms.textContent = 'physics ' + s.stepMs.toFixed(2) + ' ms';
        hud.hz.textContent = 'physics ' + s.stepsPerSecond.toFixed(0) + ' Hz / ' + s.lastSteps + ' steps';
        hud.lat.textContent = 'input latency ' + latEma.toFixed(1) + ' ms';
        hud.scale.textContent = 'res scale ' + renderer.renderScale.toFixed(2) +
          ' (' + canvas.width + 'x' + canvas.height + ')';
        const mem = (typeof performance !== 'undefined' && performance.memory) ? performance.memory : null;
        hud.heap.textContent = mem ? 'heap ' + (mem.usedJSHeapSize / 1048576).toFixed(1) + ' MB' : 'heap n/a';
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
        hud.state.textContent = playerState === 'FLYING' ? '' :
          playerState === 'PARKED' ? 'ON DECK - hold W to catapult' :
          playerState === 'CATAPULT' ? 'CATAPULT...' :
          playerState === 'LANDING_ROLL' ? 'ROLLOUT...' : 'DESTROYED - respawning';
        if (hud.banner) {
          if (victory) {
            hud.banner.textContent = 'VICTORY - all hostile aircraft destroyed';
            hud.banner.hidden = false;
          } else if (!ents.isAlive(playerId)) {
            hud.banner.textContent = 'AIRCRAFT DESTROYED';
            hud.banner.hidden = false;
          } else {
            hud.banner.hidden = true;
          }
        }
        const v = getViolationCount();
        hud.violations.textContent = v === 0 ? 'invariants OK' : 'INVARIANT VIOLATIONS: ' + v;
        hud.violations.style.color = v === 0 ? '#9f9' : '#f66';
      }
    },
  });

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
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) audio.suspend();
  });

  // main loop driver
  function frameCb(nowMs) {
    loop.frame(nowMs);
    requestAnimationFrame(frameCb);
  }
  requestAnimationFrame(frameCb);
}

boot().catch((e) => showError('Boot failed: ' + (e && e.message ? e.message : e)));

﻿
