// Skyburn Phase 1 - Combat tests (PRD Tasks 1.1-1.7 + ACs).
// Proves: pool caps (bullets 500 / missiles 64 / entities 512, no new in loop), hitscan guns
// (600 RPM cadence, falloff, spread), collision hash + segment raycast + ground crash,
// 6DOF flight equilibrium/stall/cap, missile PN convergence + 8 m proximity fuse + flare
// decoy, carrier deck/arrestor/catapult, deterministic Veteran missile hit-rate band,
// and allocation-free steady state of the combat systems (--expose-gc).

import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool, WorldEntities, ENT_TYPE, TEAM, WORLD_MAX } from '../src/combat/entities.js';
import { CollisionWorld, groundHitAt } from '../src/combat/collision.js';
import { GunSystem, GUN_TUNING } from '../src/combat/guns.js';
import { MissileSystem, MISSILE_TUNING, MISSILE_STATE } from '../src/combat/missiles.js';
import { FlightModel, PID } from '../src/physics/flight.js';
import { Carrier, CARRIER_TUNING } from '../src/world/carrier.js';
import { Terrain } from '../src/world/terrain.js';
import { ParticleSystem } from '../src/render/particles.js';

// ---- Task 1.2: pools + SoA registry ----

test('Pool: O(1) alloc/free, hard cap (alloc -1 when full), reset restores capacity', () => {
  const p = new Pool(4);
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const id = p.alloc();
    assert.ok(id >= 0, 'alloc within capacity');
    ids.push(id);
  }
  assert.equal(p.alloc(), -1, 'cap respected: -1 when exhausted (no new in loop)');
  assert.equal(p.active, 4);
  p.free(ids[1]);
  p.free(ids[3]);
  assert.equal(p.active, 2);
  const a = p.alloc(), b = p.alloc();
  assert.equal(p.alloc(), -1, 'refilled to cap');
  assert.ok(ids.includes(a) && ids.includes(b), 'freed slots are reused');
  p.reset();
  assert.equal(p.active, 0);
  for (let i = 0; i < 4; i++) assert.ok(p.alloc() >= 0);
});

test('WorldEntities: spawn/damage/kill lifecycle, cap at 512, slot reuse', () => {
  const ents = new WorldEntities(WORLD_MAX);
  const ids = [];
  for (let i = 0; i < 10; i++) {
    ids.push(ents.spawn(ENT_TYPE.JET, TEAM.ENEMY, i * 10, 100, 0, 0, 0, 0, 9, 100));
  }
  assert.equal(ents.count, 10);
  assert.equal(ents.activeCount(), 10);
  assert.equal(ents.damage(ids[3], 40), false, '40 dmg does not kill 100 hp');
  assert.equal(ents.health[ids[3]], 60);
  assert.equal(ents.damage(ids[3], 60), true, 'exact kill returns true');
  assert.equal(ents.isAlive(ids[3]), false);
  assert.equal(ents.activeCount(), 9);
  const reused = ents.spawn(ENT_TYPE.JET, TEAM.PLAYER, 5, 5, 5, 0, 0, 0, 9, 100);
  assert.equal(reused, ids[3], 'killed slot is reused (stable high-water count)');
  assert.equal(ents.count, 10);
  // cap: spawn until full
  const ents2 = new WorldEntities(8);
  let spawned = 0;
  while (ents2.spawn(ENT_TYPE.JET, TEAM.ENEMY, 0, 0, 0, 0, 0, 0, 1, 1) >= 0) spawned++;
  assert.equal(spawned, 8, 'capacity respected');
  assert.equal(ents2.spawn(ENT_TYPE.JET, TEAM.ENEMY, 0, 0, 0, 0, 0, 0, 1, 1), -1);
});

// ---- Task 1.6: collision (hash + spheres + segment raycast + ground) ----

function makeWorld(n) {
  const ents = new WorldEntities(64);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = ents.spawn(ENT_TYPE.JET, i % 2 === 0 ? TEAM.PLAYER : TEAM.ENEMY,
      (i % 3) * 100, 500, Math.floor(i / 3) * 100, 0, 0, 0, 9, 100);
    ids.push(id);
  }
  ents.collision = new CollisionWorld(ents.max);
  ents.collision.rebuild(ents);
  return { ents, ids };
}

test('collision hash: querySphere finds neighbors, ignores distant and dead entities', () => {
  const { ents, ids } = makeWorld(6);
  const out = new Int32Array(32);
  // entity 0 at (0,500,0); entity 3 at (0,500,100) is 100 m away -> inside a 150 m query
  const n = ents.collision.querySphere(ents, 0, 500, 0, 150, out);
  assert.ok(n >= 2, 'found self + near neighbor, got ' + n);
  let foundNear = false, foundFar = false;
  for (let i = 0; i < n; i++) {
    if (out[i] === ids[3]) foundNear = true;
    if (out[i] === ids[5]) foundFar = true; // (200,500,100) is ~224 m away
  }
  assert.ok(foundNear, 'near entity found');
  assert.ok(!foundFar, 'far entity not found');
  ents.kill(ids[3]);
  ents.collision.rebuild(ents);
  const n2 = ents.collision.querySphere(ents, 0, 500, 0, 150, out);
  for (let i = 0; i < n2; i++) assert.notEqual(out[i], ids[3], 'dead entity excluded');
});

test('collision segmentQuery: ray vs sphere hit point and distance are exact', () => {
  const { ents } = makeWorld(0);
  const id = ents.spawn(ENT_TYPE.JET, TEAM.ENEMY, 500, 500, 0, 0, 0, 0, 10, 100);
  ents.collision.rebuild(ents);
  const hit = { id: -1, dist: 0, px: 0, py: 0, pz: 0 };
  // ray from origin along +x through the sphere center at (500,500,0)
  const found = ents.collision.segmentQuery(ents, 0, 500, 0, 1000, 500, 0, -1, -1, hit);
  assert.equal(found, true, 'ray hits the sphere');
  assert.equal(hit.id, id);
  assert.ok(Math.abs(hit.dist - 490) < 1e-3, 'enters at 500-10=490 m, got ' + hit.dist);
  assert.ok(Math.abs(hit.px - 490) < 1e-3 && Math.abs(hit.py - 500) < 1e-3);
  // ray away from the sphere misses
  const miss = { id: -1, dist: 0, px: 0, py: 0, pz: 0 };
  const found2 = ents.collision.segmentQuery(ents, 0, 500, 0, 1000, 900, 0, -1, -1, miss);
  assert.equal(found2, false, 'ray past the sphere misses');
  // team filter
  const found3 = ents.collision.segmentQuery(ents, 0, 500, 0, 1000, 500, 0, -1, TEAM.PLAYER, miss);
  assert.equal(found3, false, 'team filter excludes the enemy sphere');
});

test('groundHitAt: terrain and sea-level crash detection', () => {
  const terrain = new Terrain({ seed: 1337 });
  // above open ocean (far from island center): surface = sea level 0
  assert.equal(groundHitAt(terrain, 0, 50, 20000, 5), -1, '50 m above the sea is safe');
  assert.equal(groundHitAt(terrain, 0, 3, 20000, 5), 0, '3 m above the sea is a hit');
  // above the island: find a high point to test terrain height usage
  let highY = 0, hx = 0, hz = 0;
  for (let x = -2000; x <= 2000; x += 137) {
    for (let z = -2000; z <= 2000; z += 131) {
      const h = terrain.heightAt(x, z);
      if (h > highY) { highY = h; hx = x; hz = z; }
    }
  }
  assert.ok(highY > 50, 'island has terrain above 50 m (got ' + highY + ')');
  assert.equal(groundHitAt(terrain, hx, highY - 2, hz, 5), highY, 'below terrain -> hit');
  assert.equal(groundHitAt(terrain, hx, highY + 40, hz, 5), -1, 'above terrain -> safe');
});

// ---- Task 1.3: guns (600 RPM, falloff, spread, pooled tracers) ----

function makeShooter(ents, id, team, x, y, z, yaw) {
  return {
    id, team, gunDamage: 12, world: ents,
    noseX: x, noseY: y, noseZ: z,
    fx: Math.sin(yaw), fy: 0, fz: -Math.cos(yaw),
  };
}

test('guns: 600 RPM cadence, tracer pool cap and expiry', () => {
  const { ents } = makeWorld(0);
  const target = ents.spawn(ENT_TYPE.JET, TEAM.ENEMY, 0, -9999, 0, 0, 0, 0, 9, 100); // out of reach
  void target;
  const guns = new GunSystem(42, ents.collision);
  const shooter = makeShooter(ents, 0, TEAM.PLAYER, 0, 500, 0, 0); // firing along -z, no targets
  const dt = 1 / 120;
  let cooldown = 0;
  let shots = 0;
  for (let i = 0; i < 240; i++) { // 2 s held trigger
    const before = guns.pool.active;
    cooldown = guns.tryFire(shooter, true, cooldown, dt);
    if (guns.pool.active > before) shots++;
    guns.update(dt);
  }
  assert.ok(shots >= 19 && shots <= 21,
    '600 RPM over 2 s -> ~20 shots, got ' + shots);
  assert.ok(guns.activeCount() <= GUN_TUNING.MAX_TRACERS, 'tracer pool cap respected');
  // cadence: two immediate calls with cooldown pending must not double-fire
  const c2 = guns.tryFire(shooter, true, 0.05, dt);
  assert.ok(c2 > 0, 'cooldown still pending');
  // release resets toward zero
  for (let i = 0; i < 30; i++) cooldown = guns.tryFire(shooter, false, cooldown, dt);
  assert.equal(cooldown, 0, 'released trigger drains cooldown');
});

test('guns: hitscan damages the nearest enemy with distance falloff; tracers expire', () => {
  const { ents, ids } = makeWorld(0);
  const near = ents.spawn(ENT_TYPE.JET, TEAM.ENEMY, 0, 500, -500, 0, 0, 0, 9, 100);
  const far = ents.spawn(ENT_TYPE.JET, TEAM.ENEMY, 0, 500, -2200, 0, 0, 0, 9, 100);
  ents.collision = new CollisionWorld(ents.max);
  ents.collision.rebuild(ents);
  const guns = new GunSystem(7, ents.collision);
  const dmgLog = [];
  guns.hooks.onHit = (hitId, dmg) => dmgLog.push([hitId, dmg]);
  const shooter = makeShooter(ents, ids[0] ?? 99, TEAM.PLAYER, 0, 500, 0, 0);
  shooter.id = 99; // not a real entity id; skipId just won't match
  guns.tryFire(shooter, true, 0, 1 / 120);
  assert.equal(dmgLog.length, 1, 'one hit');
  assert.equal(dmgLog[0][0], near, 'nearest entity hit (near target is 500 m)');
  assert.equal(dmgLog[0][1], 12, 'full damage inside 800 m');
  // far target: fire straight at it
  const shooter2 = makeShooter(ents, 99, TEAM.PLAYER, 0, 500, -1700, 0);
  shooter2.fz = -1; shooter2.fx = 0;
  dmgLog.length = 0;
  guns.tryFire(shooter2, true, 0, 1 / 120);
  assert.equal(dmgLog.length, 1);
  assert.equal(dmgLog[0][0], far, 'far target hit at ~500 m from shooter2');
  assert.equal(dmgLog[0][1], 12, 'still full damage at 500 m');
  // beyond FALLOFF_END: minimum fraction
  const shooter3 = makeShooter(ents, 99, TEAM.PLAYER, 0, 500, -500, 0);
  shooter3.fz = -1;
  ents.pos[far * 3 + 2] = -500 - 2500; // 2500 m ahead
  ents.collision.rebuild(ents);
  dmgLog.length = 0;
  guns.tryFire(shooter3, true, 0, 1 / 120);
  assert.equal(dmgLog.length, 1);
  assert.ok(Math.abs(dmgLog[0][1] - 12 * GUN_TUNING.MIN_DMG_FRAC) < 0.01,
    'minimum damage fraction at 2500 m, got ' + dmgLog[0][1]);
  // tracers expire back into the pool
  for (let i = 0; i < 20; i++) guns.update(0.03);
  assert.equal(guns.activeCount(), 0, 'all tracers expired and freed');
});

// ---- Task 1.1: flight model (6DOF+PID, equilibrium, stall, cap) ----

const JET = {
  id: 'testjet', name: 'Test Jet',
  maxSpeed: 1200,     // km/h -> 333.3 m/s cap
  stallSpeed: 220,    // km/h -> 61.1 m/s
  turnRate: 20,       // deg/s max pitch rate
  thrust: 76000,      // N
  drag: 0.021,        // Cd
};

test('flight model: velocity is forward (equilibrium) and speed stays under maxSpeed', () => {
  const f = new FlightModel(JET, { x: 0, y: 2000, z: 0, yaw: 0, throttle: 1.0 });
  for (let i = 0; i < 1200; i++) {
    f.tick(0, 0, 0, 0, false, false, 1 / 120);
  }
  assert.ok(f.speed > 200, 'cruising speed builds up, got ' + f.speed);
  assert.ok(f.speed <= f.maxSpeed + 0.5, 'speed capped at maxSpeed');
  // velocity aligns with the nose (arcade "velocity is forward")
  const yaw = f.rot[0], pitch = f.rot[1];
  const fx = Math.sin(yaw) * Math.cos(pitch), fy = Math.sin(pitch),
    fz = -Math.cos(yaw) * Math.cos(pitch);
  const vl = Math.sqrt(f.vel[0] * f.vel[0] + f.vel[1] * f.vel[1] + f.vel[2] * f.vel[2]) || 1;
  const dot = (f.vel[0] / vl) * fx + (f.vel[1] / vl) * fy + (f.vel[2] / vl) * fz;
  assert.ok(dot > 0.999, 'velocity aligned with nose (dot ' + dot.toFixed(5) + ')');
  // PID holders settled near zero with neutral input
  assert.ok(Math.abs(f.pidPitch.out) < 0.2 && Math.abs(f.pidRoll.out) < 0.2,
    'attitude PIDs settled, got pitch ' + f.pidPitch.out + ' roll ' + f.pidRoll.out);
});

test('flight model: stall below stallSpeed (nose drop, sink, mushy controls, recovery)', () => {
  const f = new FlightModel(JET, { x: 0, y: 2000, z: 0, yaw: 0, throttle: 1.0 });
  const stallMs = JET.stallSpeed / 3.6;
  f.speed = stallMs - 10; // below stall
  f.vel[0] = 0; f.vel[1] = -f.speed; f.vel[2] = 0;
  f.tick(0, 0, 0, 0, false, false, 1 / 120); // tick 1: flags the stall (end-of-tick check)
  assert.ok(f.stalled, 'stall flag set');
  const y0 = f.pos[1];
  const pitchMid = f.rot[1];
  f.tick(0, 0, 0, 0, false, false, 1 / 120); // tick 2: nose-drop torque + sink act
  assert.ok(f.rot[1] < pitchMid, 'nose dropped while stalled');
  assert.ok(f.pos[1] < y0, 'sinking while stalled');
  // mushy controls: stalled roll response is weaker than clean response. Measure the SETTLED
  // roll rate (40 ticks): a single tick saturates the torque clamp in both regimes.
  for (let i = 0; i < 40; i++) f.tick(0, 1, 0, 0, false, false, 1 / 120);
  const rateStalled = f.rates[0];
  f.speed = stallMs + 60;
  f.tick(0, 0, 0, 0, false, false, 1 / 120);
  assert.ok(!f.stalled, 'stall clears above stall speed');
  f.rot[2] = 0;
  f.rates[0] = 0;
  f.pidRoll.reset();
  for (let i = 0; i < 40; i++) f.tick(0, 1, 0, 0, false, false, 1 / 120);
  const rateClean = f.rates[0];
  assert.ok(Math.abs(rateClean) > Math.abs(rateStalled) * 1.5,
    'clean flight has more roll authority than stall (' + rateClean + ' vs ' + rateStalled + ')');
});

test('flight model: PID tracks commanded rates; banked pull turns the heading', () => {
  const f = new FlightModel(JET, { x: 0, y: 2000, z: 0, yaw: 0, throttle: 1.0 });
  f.speed = 250; f.vel[0] = 0; f.vel[2] = -250;
  const dt = 1 / 120;
  // roll to ~90 degrees bank
  for (let i = 0; i < 240; i++) f.tick(0, 1, 0, 0, false, false, dt);
  assert.ok(Math.abs(f.rot[2]) > 1.2, 'banked past ~70 degrees, got ' + f.rot[2].toFixed(2));
  // now hold full pitch: pitch rate converges near turnRate (20 deg/s) and heading turns
  const yawBefore = f.rot[0];
  for (let i = 0; i < 240; i++) f.tick(1, 0.2, 0, 0, false, false, dt);
  const q = f.rates[1];
  assert.ok(q > (JET.turnRate * Math.PI / 180) * 0.6,
    'pitch rate near commanded turnRate, got ' + (q * 180 / Math.PI).toFixed(1) + ' deg/s');
  const yawRate = Math.abs(wrapDelta(f.rot[0], yawBefore)) / (240 * dt);
  assert.ok(yawRate > (JET.turnRate * Math.PI / 180) * 0.4,
    'banked pull turns the heading, got ' + (yawRate * 180 / Math.PI).toFixed(1) + ' deg/s');
});

function wrapDelta(a, b) {
  let d = a - b;
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

test('flight model: afterburner cap 1.05x, airbrake slows, teleport + interpolation', () => {
  const f = new FlightModel(JET, { x: 0, y: 2000, z: 0, yaw: 0, throttle: 1.0 });
  for (let i = 0; i < 1800; i++) f.tick(0, 0, 0, 0, true, false, 1 / 120); // 15 s AB
  assert.ok(f.speed <= f.maxSpeed * 1.05 + 0.5,
    'AB caps at maxSpeed*1.05 (PRD invariant), got ' + f.speed);
  assert.ok(f.speed > f.maxSpeed, 'AB pushes past the normal cap');
  const f2 = new FlightModel(JET, { x: 0, y: 2000, z: 0, yaw: 0, throttle: 1.0 });
  for (let i = 0; i < 600; i++) f2.tick(0, 0, 0, 0, false, false, 1 / 120);
  const fast = f2.speed;
  for (let i = 0; i < 300; i++) f2.tick(0, 0, 0, 0, false, true, 1 / 120); // airbrake 2.5 s
  assert.ok(f2.speed < fast - 5, 'airbrake bleeds speed: ' + fast + ' -> ' + f2.speed);
  // teleport + interpolated sampling
  f2.teleport(111, 222, 333, 2.5, 0.1);
  assert.equal(f2.pos[0], 111); assert.equal(f2.pos[2], 333);
  const outP = new Float32Array(3), outR = new Float32Array(3);
  f2.sampleInterpolated(0.5, outP, outR);
  assert.ok(Math.abs(outP[0] - 111) < 1e-6, 'sample at alpha 0.5 equals teleport target');
});


// ---- Task 1.4: missiles (PN guidance, proximity fuse, flares, pool) ----

function makeTargetWorld() {
  const ents = new WorldEntities(64);
  ents.collision = new CollisionWorld(ents.max);
  const shooter = ents.spawn(ENT_TYPE.JET, TEAM.PLAYER, 0, 1000, 0, 0, 0, 0, 9, 100);
  const target = ents.spawn(ENT_TYPE.JET, TEAM.ENEMY, 3000, 1000, -4000, 0, 0, 0, 9, 100);
  return { ents, shooter, target };
}

test('missiles: PN guidance converges on a crossing target; 8 m fuse detonates', () => {
  const { ents, shooter, target } = makeTargetWorld();
  const explosions = [];
  const ms = new MissileSystem(11, {
    onExplode: (x, y, z) => explosions.push([x, y, z,
      ents.pos[target * 3], ents.pos[target * 3 + 1], ents.pos[target * 3 + 2]]),
  });
  ents.vel[target * 3] = 180;                       // crossing target at 180 m/s
  ents.speed[target] = 180;
  // straight-ahead launch toward the target general direction
  const dl = Math.sqrt(3000 * 3000 + 4000 * 4000);
  const mid = ms.spawn(shooter, 0, 1000, 0, 3000 / dl, 0, -4000 / dl, 250, target);
  assert.ok(mid >= 0, 'missile spawned');
  const dt = 1 / 120;
  let steps = 0;
  while (ms.activeCount() > 0 && steps < 1200) {
    ms.update(dt, ents, null);
    ents.prevPos[target * 3] = ents.pos[target * 3];
    ents.prevPos[target * 3 + 1] = ents.pos[target * 3 + 1];
    ents.prevPos[target * 3 + 2] = ents.pos[target * 3 + 2];
    ents.pos[target * 3] += ents.vel[target * 3] * dt; // target flies straight
    ents.pos[target * 3 + 2] += ents.vel[target * 3 + 2] * dt;
    steps++;
  }
  assert.equal(explosions.length, 1, 'exactly one detonation');
  // explosion and target positions captured on the same tick the fuse resolved
  const [ex, ey, ez, tx, ty, tz] = explosions[0];
  const d = Math.sqrt((ex - tx) ** 2 + (ey - ty) ** 2 + (ez - tz) ** 2);
  assert.ok(d < MISSILE_TUNING.FUSE_RANGE + ents.radius[target] + 2,
    'detonation within fuse range of the target, got ' + d.toFixed(1) + ' m');
  assert.ok(steps < 1000, 'converged well before timeout (' + steps + ' steps)');
});

test('missiles: flares seduce the seeker (decoyed missile misses a flaring target)', () => {
  const { ents, shooter, target } = makeTargetWorld();
  let seduced = false;
  let missDistance = Infinity;
  const ms = new MissileSystem(11, {
    onExplode: (x, y, z) => {
      const dx = x - ents.pos[target * 3];
      const dy = y - ents.pos[target * 3 + 1];
      const dz = z - ents.pos[target * 3 + 2];
      missDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    },
    flareActive: (tid, out) => {
      if (tid !== target) return false;
      out[0] = ents.pos[target * 3] - 200;
      out[1] = ents.pos[target * 3 + 1] - 300;
      out[2] = ents.pos[target * 3 + 2];
      return true; // flares always burn in this test
    },
  });
  const dl = Math.sqrt(3000 * 3000 + 4000 * 4000);
  const mid = ms.spawn(shooter, 0, 1000, 0, 3000 / dl, 0, -4000 / dl, 250, target);
  const dt = 1 / 120;
  let steps = 0;
  while (ms.activeCount() > 0 && steps < 1200) {
    ms.update(dt, ents, null);
    if (ms.decoyedTimer[mid] > 0) seduced = true;
    ents.pos[target * 3] += 180 * dt;
    steps++;
  }
  assert.equal(ms.activeCount(), 0, 'missile resolved');
  assert.ok(seduced, 'flare decoy seduced the seeker');
  assert.ok(missDistance > MISSILE_TUNING.FUSE_RANGE + ents.radius[target],
    'decoyed missile missed the flaring target (miss distance ' +
    missDistance.toFixed(1) + ' m)');
});

test('missiles: pool cap at 64 (spawn -1 when exhausted), recycled slots reused', () => {
  const { ents, shooter } = makeTargetWorld();
  const ms = new MissileSystem(11, {});
  const ids = [];
  for (let i = 0; i < MISSILE_TUNING.MAX_MISSILES; i++) {
    const id = ms.spawn(shooter, 0, 1000, 0, 0, 0, -1, 100, -1);
    assert.ok(id >= 0, 'spawn within cap');
    ids.push(id);
  }
  assert.equal(ms.spawn(shooter, 0, 1000, 0, 0, 0, -1, 100, -1), -1, 'cap -> -1');
  assert.equal(ms.activeCount(), MISSILE_TUNING.MAX_MISSILES);
  // timeout resolve frees slots
  for (let i = 0; i < 1200; i++) ms.update(1 / 120, ents, null);
  assert.equal(ms.activeCount(), 0, 'all missiles timed out and recycled');
  const id = ms.spawn(shooter, 0, 1000, 0, 0, 0, -1, 100, -1);
  assert.ok(id >= 0 && ids.includes(id), 'recycled slot reused');
});

// ---- Task 1.7: carrier (deck query, arrestor, catapult, moving deck) ----

test('carrier: deck height query, arrestor zone, and landing verdict thresholds', () => {
  const carrier = new Carrier({ x: 0, z: 0, yaw: 0 }); // heading -z (north)
  carrier.update(0, 20000); // no motion
  assert.equal(carrier.deckAt(0, 100), CARRIER_TUNING.DECK_Y, 'deck point -> deck height');
  assert.equal(carrier.deckAt(0, -100), CARRIER_TUNING.DECK_Y);
  assert.equal(carrier.deckAt(0, 500), -1, 'off the deck -> -1');
  assert.equal(carrier.deckAt(60, 0), -1, 'past the beam -> -1');
  // arrestor zone sits near the stern (local z = -L/2 + offset). With yaw=0 the bow points
  // toward -z, so the stern-side zone center is at world z = +(L/2 - ARRESTOR_OFFSET).
  assert.equal(carrier.inArrestorZone(0, CARRIER_TUNING.LENGTH / 2 -
    CARRIER_TUNING.ARRESTOR_OFFSET), true, 'stern zone is the arrestor area');
  assert.equal(carrier.inArrestorZone(0, 0), false, 'mid-deck is not the arrestor area');
  // landing verdicts: clean catch, too fast, too hard, no gear
  assert.equal(carrier.evaluateTouchdown(true, 80, 3), 1, 'clean arrested landing');
  assert.equal(carrier.evaluateTouchdown(true, CARRIER_TUNING.LAND_SPEED_MAX + 5, 3), 2,
    'over 180 kn -> crash');
  assert.equal(carrier.evaluateTouchdown(true, 80, CARRIER_TUNING.LAND_SINK_MAX + 1), 2,
    'hard impact -> crash');
  assert.equal(carrier.evaluateTouchdown(false, 80, 3), 2, 'no gear -> crash');
});

test('carrier: patrol motion updates pose; catapult pose points along the heading', () => {
  const carrier = new Carrier({ x: 0, z: 0, yaw: 0 });
  const z0 = carrier.pos[2];
  carrier.update(1.0, 20000);
  assert.ok(carrier.pos[2] < z0, 'moves forward (heading -z)');
  assert.ok(Math.abs(carrier.pos[0]) < 0.5, 'no lateral drift on a straight heading');
  const pose = new Float32Array(4);
  carrier.catapultPose(pose);
  // bow catapult start: 40 m aft of the bow along the CURRENT heading (the ship patrolled
  // during update, so the expectation is derived from the live pose, not the origin)
  const bowZ = CARRIER_TUNING.LENGTH / 2 - 40;
  const hfx = Math.sin(carrier.yaw), hfz = -Math.cos(carrier.yaw);
  assert.ok(Math.abs(pose[2] - (carrier.pos[2] + hfz * bowZ)) < 1e-4,
    'catapult start near the bow, got z ' + pose[2]);
  assert.ok(Math.abs(pose[0] - (carrier.pos[0] + hfx * bowZ)) < 1e-4,
    'catapult start along the heading, got x ' + pose[0]);
  assert.ok(pose[1] > CARRIER_TUNING.DECK_Y, 'catapult start above the deck');
  assert.ok(Math.abs(pose[3] - carrier.yaw) < 1e-5,
    'launch aligned with the ship heading (pose yaw is float32)');
  // border turnaround flips the turn sign
  const c2 = new Carrier({ x: 19800, z: 0, yaw: 0 });
  const before = c2.turnSign;
  c2.update(0.5, 20000);
  assert.equal(c2.turnSign, -before, 'turn sign flips near the arena border');
});

// ---- Task 1.8: particles (pool cap + burst + staging) ----

test('particles: pool cap at max, bursts stay bounded, staging matches live set', () => {
  const ps = new ParticleSystem(200, 5);
  for (let i = 0; i < 500; i++) ps.burstExplosion(0, 100, 0);
  assert.ok(ps.activeCount() <= 200, 'pool cap respected under spam');
  const staged = ps.stage();
  assert.equal(staged, ps.activeCount(), 'stage() emits exactly the live particles');
  for (let i = 0; i < 200; i++) ps.update(1 / 120);
  assert.ok(ps.activeCount() < 200, 'particles expire over time');
  // staged layout: 8 floats per particle
  assert.equal(ps.staging.length, 200 * 8);
});

// ---- AC: deterministic Veteran missile hit-rate band (50-80%) ----

test('deterministic Veteran band: repeated AI missile engagements land in [0.5, 0.8]', () => {
  // Simulate the decisive phase only: missile already in the air (BOOST done), target doing a
  // mild turn at 180 m/s - the part that determines hit/miss. 40 launches, deterministic RNG.
  const RESULTS = [];
  for (let trial = 0; trial < 40; trial++) {
    const ents = new WorldEntities(16);
    ents.collision = new CollisionWorld(16);
    const shooter = ents.spawn(ENT_TYPE.JET, TEAM.PLAYER, 0, 1000, 0, 0, 0, 0, 9, 100);
    const target = ents.spawn(ENT_TYPE.JET, TEAM.ENEMY, 3000, 1000, -4000, 0, 0, 0, 9, 100);
    ents.vel[target * 3] = 180 * Math.cos(trial * 0.35);
    ents.vel[target * 3 + 2] = -180 * Math.sin(trial * 0.35) - 60;
    ents.speed[target] = 180;
    // A detonation counts as a HIT only if it resolved within fuse range of the live target;
    // onExplode captures the target position on the same tick -> true miss distance.
    let missDistance = Infinity;
    const ms = new MissileSystem(0x5EED + trial, {
      flareActive: null,
      onExplode: (x, y, z) => {
        const dx = x - ents.pos[target * 3];
        const dy = y - ents.pos[target * 3 + 1];
        const dz = z - ents.pos[target * 3 + 2];
        missDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      },
    });
    const dl = Math.sqrt(3000 * 3000 + 4000 * 4000);
    ms.spawn(shooter, 0, 1000, 0, 3000 / dl, 0, -4000 / dl, 250, target);
    const dt = 1 / 120;
    for (let s = 0; s < 1080 && missDistance === Infinity; s++) {
      ms.update(dt, ents, null);
      ents.prevPos[target * 3] = ents.pos[target * 3];
      ents.prevPos[target * 3 + 1] = ents.pos[target * 3 + 1];
      ents.prevPos[target * 3 + 2] = ents.pos[target * 3 + 2];
      ents.pos[target * 3] += ents.vel[target * 3] * dt;
      ents.pos[target * 3 + 2] += ents.vel[target * 3 + 2] * dt;
    }
    RESULTS.push(missDistance < MISSILE_TUNING.FUSE_RANGE + ents.radius[target] + 2);
  }
  const hitRate = RESULTS.filter(Boolean).length / RESULTS.length;
  assert.ok(hitRate >= 0.5 && hitRate <= 0.8,
    'Veteran band 50-80%, got ' + (hitRate * 100).toFixed(0) + '%');
});

// ---- AC: allocation-free steady state (PRD: zero allocation in the hot path) ----

test('combat systems steady state does not allocate (guns, missiles, particles, hash)', { skip: typeof global.gc !== 'function' ? 'needs --expose-gc' : false }, () => {
  const { ents, shooter, target } = makeTargetWorld();
  ents.vel[target * 3] = 150; ents.speed[target] = 150;
  const ms = new MissileSystem(3, { onExplode: () => {}, flareActive: null });
  const guns = new GunSystem(3, ents.collision);
  const particles = new ParticleSystem(1000, 3);
  guns.hooks.onMuzzle = (x, y, z, dx, dy, dz) => particles.muzzleFlash(x, y, z, dx, dy, dz);
  guns.hooks.onHit = () => {};
  const shooterView = makeShooter(ents, shooter, TEAM.PLAYER, 0, 1000, 0, 0.4);
  const dt = 1 / 120;
  let gunCd = 0, spawnCd = 0;
  const warm = () => {
    for (let i = 0; i < 600; i++) {
      gunCd = guns.tryFire(shooterView, true, gunCd, dt);
      guns.update(dt);
      if (spawnCd <= 0) { ms.spawn(shooter, 0, 1000, 0, 0, 0, -1, 200, target); spawnCd = 1; }
      spawnCd -= dt;
      ms.update(dt, ents, (x, y, z) => particles.emitTrail(x, y, z));
      particles.update(dt);
      particles.stage();
      ents.collision.rebuild(ents);
      ents.collision.querySphere(ents, 0, 1000, 0, 3000, new Int32Array(64));
    }
  };
  warm(); warm();
  global.gc(); global.gc();
  const before = process.memoryUsage().heapUsed;
  warm(); warm();
  global.gc(); global.gc();
  const after = process.memoryUsage().heapUsed;
  const growth = after - before;
  assert.ok(growth < 256 * 1024, 'steady-state heap grew by ' + growth + ' bytes');
});
