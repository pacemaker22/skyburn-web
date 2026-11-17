// Skyburn Phase 2 - Mission spawner (Task 2.3): "waves by stage, positions from maps.json,
// cap entities, despawn far, protected assets HP+fail trigger".
// - Waves: per stage (missions.json), sorted by `at`; deferred (never dropped) when the world
//   entity cap is hit - the PRD invariant is that the game never exceeds the arrays.
// - Positions: named zones from maps.json with deterministic spread (seeded RNG); ground
//   units snap to land, ships/rig snap to water (procedural terrain may differ from guesses).
// - Protected assets: mission-level `assets` (e.g. the oil rig) with HP; their death fires
//   the mission fail trigger (handled in mission.js noteKill).
// - Cruise missiles: boats fire pooled missiles at a target group (M3 rig attack); a per-slot
//   life override makes them long-range. Triggers the HUD cruise missile warning (Task 2.8).
// Spawn-time allocation only; per-tick work is allocation-free.

import { ENT_TYPE, TEAM } from '../combat/entities.js';
import { FlightModel } from '../physics/flight.js';
import { EnemyAI } from '../ai/enemy.js';
import { MISSILE_TUNING } from '../combat/missiles.js';
import { mulberry32 } from '../world/terrain.js';

export const SPAWNER_TUNING = {
  DESPAWN_DIST: 9000,     // m from the player before "despawn far" may apply
  DESPAWN_EVERY: 2.0,     // s between despawn scans
  MAX_JETS: 24,           // registry cap for spawned AI jets (WorldEntities caps at 512)
  CRUISE_LIFE: 120,       // s cruise-missile life override (long-range: boats fire from ~8 km)
  CRUISE_SPEED: 240,      // m/s launch speed (motor accelerates toward the target)
  CRUISE_CLIMB: 0.06,     // initial climb fraction in the launch direction
  SHIP_RADIUS: 26,        // collision sphere for boats
  RIG_RADIUS: 45,         // collision sphere for the rig (override via asset def)
  GROUND_RADIUS: 9,
  SNAP_STEP: 130,         // m per ring when snapping zones onto land/water
  SNAP_RINGS: 48,
};

// Deterministic zone resolution: point + spread ring (seeded; called at spawn time only).
function zonePosition(map, zoneName, rng, out) {
  const p = map && map.points ? map.points[zoneName] : undefined;
  if (!p) throw new Error('map "' + (map ? map.id : '?') + '": unknown zone "' + zoneName + '"');
  const spread = p.spread || 0;
  const a = rng() * Math.PI * 2;
  const r = spread > 0 ? Math.sqrt(rng()) * spread : 0;
  out[0] = p.x + Math.cos(a) * r;
  out[1] = p.y !== undefined ? p.y : 0;
  out[2] = p.z + Math.sin(a) * r;
  return p;
}

// Snap a world position onto land (ground units) or water (ships/rig) with an outward
// spiral search over the procedural heightfield. Deterministic; spawn-time only.
function snapSurface(terrain, x, z, wantLand, out) {
  if (!terrain || !terrain.heightAt) { out[0] = x; out[2] = z; return; }
  if ((terrain.heightAt(x, z) > 2) === wantLand) { out[0] = x; out[2] = z; return; }
  const T = SPAWNER_TUNING;
  for (let ring = 1; ring <= T.SNAP_RINGS; ring++) {
    const r = ring * T.SNAP_STEP;
    const steps = 6 + ring * 2;
    for (let s = 0; s < steps; s++) {
      const a = (s / steps) * Math.PI * 2;
      const sx = x + Math.cos(a) * r;
      const sz = z + Math.sin(a) * r;
      if ((terrain.heightAt(sx, sz) > 2) === wantLand) { out[0] = sx; out[2] = sz; return; }
    }
  }
  out[0] = x; out[2] = z; // give up: keep the requested spot (spawn is still valid)
}

export class Spawner {
  // deps: { missiles, terrain, jetsData (jets.json list), playerId, difficulty,
  //         hooks { onJetSpawned(id, flight, ai), onCruiseLaunch(targetId), audio } }
  constructor(ents, deps) {
    this.ents = ents;
    this.missiles = deps.missiles || null;
    this.terrain = deps.terrain || null;
    this.jetsData = deps.jetsData || [];
    this.playerId = deps.playerId;
    this.difficulty = deps.difficulty !== undefined ? deps.difficulty : 1;
    this.hooks = deps.hooks || {};
    this.map = deps.map || null;
    this.reset();
  }

  reset() {
    this.groups = [];                 // [{ name, ids[], alive, total, protected }]
    this.groupIndex = new Map();      // name -> index
    this.entGroup = new Int32Array(this.ents.max).fill(-1); // ent id -> group index
    this.jetIds = [];
    this.jetFlights = [];
    this.jetAIs = [];
    this.ships = [];                  // [{ id, cruise { targetIdx, cd, every } | null }]
    this.protectedIds = [];
    this.waves = [];
    this.waveCursor = 0;
    this.missionTime = 0;
    this.despawnTimer = 0;
    this.cruiseWarn = false;
    this.rng = mulberry32(0x5EAD0);
    this._seed = 0xBEEF;
  }

  // ---- per-stage arming ----
  arm(stageDef, seed, map) {
    if (map) this.map = map;
    this.rng = mulberry32(seed === undefined ? 0x5EAD0 : seed);
    this.waves = (stageDef.waves || []).slice().sort((a, b) => a.at - b.at);
    this.waveCursor = 0;
    this.missionTime = 0;
    this.despawnTimer = 0;
    this._spawnDueWaves(); // waves scheduled at t=0 deploy synchronously with the stage
  }

  // Deploy every wave whose time has come; deferred (not dropped) when the world is full.
  _spawnDueWaves() {
    while (this.waveCursor < this.waves.length &&
      this.waves[this.waveCursor].at <= this.missionTime) {
      if (!this.spawnWave(this.waves[this.waveCursor])) break;
      this.waveCursor++;
    }
  }

  _group(name, protectedGroup) {
    let gi = this.groupIndex.get(name);
    if (gi === undefined) {
      gi = this.groups.length;
      this.groupIndex.set(name, gi);
      this.groups.push({ name, ids: [], alive: 0, total: 0, protected: !!protectedGroup });
    } else {
      this.groups[gi].protected = this.groups[gi].protected || !!protectedGroup;
    }
    return gi;
  }

  _register(gi, id) {
    const g = this.groups[gi];
    g.ids.push(id);
    g.alive++;
    g.total++;
    this.entGroup[id] = gi;
  }

  _release(gi, id) {
    const g = this.groups[gi];
    if (g && g.alive > 0) g.alive--;
    this.entGroup[id] = -1;
    if (this.ents.type[id] !== ENT_TYPE.NONE) this.ents.kill(id);
  }

  // Mission-level protected assets (the oil rig). Called once per mission start.
  spawnAssets(assets, map) {
    const out = [0, 0, 0];
    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      zonePosition(map, a.zone, this.rng, out);
      if (a.kind === 'rig') {
        snapSurface(this.terrain, out[0], out[2], false, out); // rig floats: want water
        const id = this.ents.spawn(ENT_TYPE.SHIP, TEAM.PLAYER, out[0], 6, out[2], 0.5, 0, 0,
          a.radius || SPAWNER_TUNING.RIG_RADIUS, a.hp || 150);
        if (id < 0) throw new Error('spawner: world full spawning protected asset');
        this.ents.variant[id] = 3;
        this._register(this._group(a.group, true), id);
        this.protectedIds.push(id);
      }
    }
  }

  // Spawn one wave. Returns false when the world entity cap is near - the wave is deferred
  // (retried next tick, Task 2.3 "cap entities": never exceed the arrays, never drop).
  spawnWave(wave) {
    const map = this.map;
    const units = wave.units || [];
    const out = [0, 0, 0];
    for (let u = 0; u < units.length; u++) {
      const spec = units[u];
      const gi = this._group(spec.group, false);
      for (let c = 0; c < (spec.count || 1); c++) {
        if (this.ents.activeCount() >= this.ents.max - 8) return false;
        zonePosition(map, spec.zone, this.rng, out);
        if (spec.kind === 'jet') this._spawnJet(spec, gi, out[0], out[1], out[2]);
        else if (spec.kind === 'ship') this._spawnShip(spec, gi, out);
        else if (spec.kind === 'ground') this._spawnGround(spec, gi, out);
      }
    }
    return true;
  }

  _spawnJet(spec, gi, x, y, z) {
    const T = SPAWNER_TUNING;
    if (this.jetIds.length >= T.MAX_JETS) return -1;
    let jetData = this.jetsData[0];
    for (let i = 0; i < this.jetsData.length; i++) {
      if (this.jetsData[i].id === (spec.jet || 'mig29')) { jetData = this.jetsData[i]; break; }
    }
    const e = this.ents;
    const dx = e.pos[this.playerId * 3] - x, dz = e.pos[this.playerId * 3 + 2] - z;
    const yaw = Math.atan2(dx, -dz); // face the player at spawn
    const f = new FlightModel(jetData, { x, y: Math.max(300, y || 900), z, yaw, throttle: 0.75 });
    const id = e.spawn(ENT_TYPE.JET, TEAM.ENEMY, f.pos[0], f.pos[1], f.pos[2],
      f.rot[0], f.rot[1], 0, 9, spec.hp || 100);
    if (id < 0) return -1;
    e.missilesLeft[id] = spec.missiles !== undefined ? spec.missiles : 4;
    e.flareCount[id] = jetData.flareCount;
    e.speed[id] = f.speed;
    this._seed = (this._seed + 0x9E37) | 0;
    const ai = new EnemyAI(e, this.missiles, id, { id: this.playerId },
      spec.difficulty !== undefined ? spec.difficulty : this.difficulty, this._seed, {});
    ai.missiles = this.missiles; // threat scan needs the live system
    this._register(gi, id);
    this.jetIds.push(id);
    this.jetFlights.push(f);
    this.jetAIs.push(ai);
    if (this.hooks.onJetSpawned) this.hooks.onJetSpawned(id, f, ai);
    return id;
  }

  _spawnShip(spec, gi, out) {
    snapSurface(this.terrain, out[0], out[2], false, out);
    const id = this.ents.spawn(ENT_TYPE.SHIP, TEAM.ENEMY, out[0], 4, out[2],
      this.rng() * Math.PI * 2, 0, 0, SPAWNER_TUNING.SHIP_RADIUS, spec.hp || 120);
    if (id < 0) return -1;
    this.ents.variant[id] = 2; // missile boat mesh
    this._register(gi, id);
    const cruise = spec.cruise ? {
      targetIdx: this.groupIndex.get(spec.cruise.targetGroup),
      every: spec.cruise.every || 45,
      cd: spec.cruise.firstAt || 20,
    } : null;
    this.ships.push({ id, cruise });
    return id;
  }

  _spawnGround(spec, gi, out) {
    snapSurface(this.terrain, out[0], out[2], true, out); // ground units need land
    const y = this.terrain ? Math.max(2, this.terrain.heightAt(out[0], out[2])) : 2;
    const id = this.ents.spawn(ENT_TYPE.GROUND, TEAM.ENEMY, out[0], y, out[2],
      this.rng() * Math.PI * 2, 0, 0, SPAWNER_TUNING.GROUND_RADIUS, spec.hp || 60);
    if (id < 0) return -1;
    this.ents.variant[id] = spec.variant || 4; // 4 SAM, 5 hangar, 6 radar
    this._register(gi, id);
    return id;
  }

  // ---- per-tick orchestration (allocation-free) ----
  tick(dt, ctx) {
    this.missionTime += dt;

    // waves by stage (deferred, not dropped, when the world cap is near)
    this._spawnDueWaves();

    // cruise missile launches from boats (Task 2.8 warning source)
    const T = SPAWNER_TUNING;
    for (let s = 0; s < this.ships.length; s++) {
      const ship = this.ships[s];
      if (!ship.cruise || !this.ents.isAlive(ship.id)) continue;
      const tid = this._firstAliveOfGroup(ship.cruise.targetIdx);
      if (tid < 0) continue;
      ship.cruise.cd -= dt;
      if (ship.cruise.cd <= 0) {
        ship.cruise.cd = ship.cruise.every;
        this._launchCruise(ship.id, tid);
      }
    }

    // cruise missile warning: any live missile targeting a protected asset
    this.cruiseWarn = false;
    if (this.missiles) {
      for (let m = 0; m < this.protectedIds.length; m++) {
        const pid2 = this.protectedIds[m];
        if (this.ents.isAlive(pid2) && this._missileTargets(pid2)) {
          this.cruiseWarn = true;
          break;
        }
      }
      if (this.hooks.onCruiseWarn) this.hooks.onCruiseWarn(this.cruiseWarn);
    }

    // despawn far (Task 2.3), throttled
    this.despawnTimer -= dt;
    if (this.despawnTimer <= 0) {
      this.despawnTimer = T.DESPAWN_EVERY;
      this._despawnFar(ctx);
    }
  }

  _firstAliveOfGroup(gi) {
    if (gi === undefined || gi === null) return -1;
    const g = this.groups[gi];
    if (!g) return -1;
    for (let i = 0; i < g.ids.length; i++) {
      if (this.ents.isAlive(g.ids[i])) return g.ids[i];
    }
    return -1;
  }

  _missileTargets(entityId) {
    const ms = this.missiles;
    for (let m = 0; m < ms.max; m++) {
      const st = ms.fsms[m].state;
      if (st === 0 || st === 8) continue; // SPAWN / RECYCLE
      if (ms.targetId[m] === entityId) return true;
    }
    return false;
  }

  _launchCruise(shipId, targetId) {
    const T = SPAWNER_TUNING;
    const e = this.ents;
    const sx = e.pos[shipId * 3], sy = e.pos[shipId * 3 + 1] + 8, sz = e.pos[shipId * 3 + 2];
    let dx = e.pos[targetId * 3] - sx;
    let dy = e.pos[targetId * 3 + 1] - sy;
    let dz = e.pos[targetId * 3 + 2] - sz;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= len;
    dy = dy / len + T.CRUISE_CLIMB;
    dz /= len;
    const slot = this.missiles.spawn(shipId, sx, sy, sz, dx, dy, dz, T.CRUISE_SPEED, targetId);
    if (slot >= 0) this.missiles.life[slot] = T.CRUISE_LIFE; // long-range cruise profile
    if (this.hooks.onCruiseLaunch) this.hooks.onCruiseLaunch(targetId);
    if (this.hooks.audio) this.hooks.audio.missileLaunch();
  }

  _despawnFar(ctx) {
    const T = SPAWNER_TUNING;
    const e = this.ents;
    const px = e.pos[this.playerId * 3], pz = e.pos[this.playerId * 3 + 2];
    for (let i = this.jetIds.length - 1; i >= 0; i--) {
      const id = this.jetIds[i];
      if (!e.isAlive(id)) continue;
      const dx = e.pos[id * 3] - px, dz = e.pos[id * 3 + 2] - pz;
      if (dx * dx + dz * dz < T.DESPAWN_DIST * T.DESPAWN_DIST) continue;
      const gi = this.entGroup[id];
      const g = gi >= 0 ? this.groups[gi] : null;
      if (g && ctx && ctx.canDespawn && !ctx.canDespawn(g.name)) continue;
      this._release(gi, id);
      this.jetIds.splice(i, 1);
      this.jetFlights.splice(i, 1);
      this.jetAIs.splice(i, 1);
    }
  }

  // ---- mission bookkeeping (called by mission.js) ----
  groupAlive(name) {
    const gi = this.groupIndex.get(name);
    if (gi === undefined) return false;
    return this.groups[gi].alive > 0;
  }

  groupStats(name) {
    const gi = this.groupIndex.get(name);
    if (gi === undefined) return null;
    const g = this.groups[gi];
    return { alive: g.alive, total: g.total, protected: g.protected };
  }

  // A world entity died (any cause). Returns { name, protected } or null when not ours.
  noteKill(id) {
    const gi = this.entGroup[id];
    if (gi < 0) return null;
    const g = this.groups[gi];
    if (g.alive > 0) g.alive--;
    this.entGroup[id] = -1;
    return { name: g.name, protected: g.protected };
  }

  // Full teardown (stage restart / mission restart): frees every mission-owned entity.
  despawnAll() {
    for (let gi = 0; gi < this.groups.length; gi++) {
      const g = this.groups[gi];
      for (let i = 0; i < g.ids.length; i++) {
        const id = g.ids[i];
        this.entGroup[id] = -1;
        if (this.ents.type[id] !== ENT_TYPE.NONE) this.ents.kill(id);
      }
    }
    this.jetIds.length = 0;
    this.jetFlights.length = 0;
    this.jetAIs.length = 0;
    this.ships.length = 0;
    this.protectedIds.length = 0;
    this.groups.length = 0;
    this.groupIndex.clear();
    this.waves.length = 0;
    this.waveCursor = 0;
    this.missionTime = 0;
  }
}
