// Skyburn Phase 1 - Carrier Nemesis (Task 1.7): procedural geometry (original boxes, no
// external model), patrol motion, deck height query, arrestor zone, catapult launch.
// Deck/landing logic ("landing speed < 180 knots gear down") uses an AUTOMATIC gear model:
// the PRD controls table defines no gear binding, so gear auto-deploys when slow + low near
// the carrier and retracts when fast (deviation documented in HANDOFF_Phase_1.md).

import { mulberry32 } from './terrain.js';

export const CARRIER_TUNING = {
  LENGTH: 333,           // m (deck run)
  WIDTH: 76,             // m
  DECK_Y: 19,            // deck height above sea level (m)
  PATROL_SPEED: 12,      // m/s
  TURN_RATE: 0.0035,     // rad/s gentle patrol arc
  ARRESTOR_LENGTH: 46,   // arrestor wires zone (stern rect), local z (bow = +z)
  ARRESTOR_OFFSET: 118,  // zone center distance from stern
  LAND_SPEED_MAX: 92.6,  // 180 knots in m/s
  LAND_SINK_MAX: 7.0,    // m/s vertical contact limit
  ROLLOUT_DECEL: 4.5,    // m/s^2 while rolling out on deck
  CATAPULT_ACCEL: 28,    // m/s^2 (0 to ~78 m/s in ~2.8 s over ~110 m)
  CATAPULT_TIME: 2.6,    // s hold before release
  MESH_SEED: 20261117,
};

const KTS = 1.943844; // m/s -> knots (HUD/helper)

export class Carrier {
  constructor(opts) {
    const o = opts || {};
    this.pos = new Float32Array([
      o.x !== undefined ? o.x : 1500, 0,
      o.z !== undefined ? o.z : -1500,
    ]);
    this.prevPos = new Float32Array(this.pos);
    this.yaw = o.yaw !== undefined ? o.yaw : 2.2;
    this.prevYaw = this.yaw;
    this.state = 0;            // 0 = PATROL, 1 = HOLD (jet landed / launching)
    this.holdTimer = 0;
    this.landedId = -1;        // world entity id of a parked jet (-1 = none)
    this.rolloutSpeed = 0;     // jet speed while rolling out (m/s)
    this.launching = false;
    this.launchProgress = 0;
    this.speed = CARRIER_TUNING.PATROL_SPEED;
    this.turnSign = 1;
  }

  get deckY() { return CARRIER_TUNING.DECK_Y; }

  // One physics tick. dt seconds. The carrier never stops (moving-deck landing per PRD).
  update(dt, worldHalf) {
    this.prevPos.set(this.pos);
    this.prevYaw = this.yaw;
    if (this.state === 0 || !this.launching) {
      this.yaw += CARRIER_TUNING.TURN_RATE * this.turnSign * dt;
      if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
      if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
      const fx = Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      this.pos[0] += fx * CARRIER_TUNING.PATROL_SPEED * dt;
      this.pos[2] += fz * CARRIER_TUNING.PATROL_SPEED * dt;
      // turn around before the arena border
      const lim = worldHalf - 2500;
      if (this.pos[0] > lim || this.pos[0] < -lim || this.pos[2] > lim || this.pos[2] < -lim) {
        this.turnSign = -this.turnSign;
      }
    }
    if (this.launching) this.launchProgress += dt;
  }

  // World -> local deck coords (forward dx along heading, lateral dz). Writes into out.
  toLocal(x, z, out) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const wx = x - this.pos[0], wz = z - this.pos[2];
    // forward = (sin(yaw), -cos(yaw)); right = (cos(yaw), sin(yaw))
    out[0] = wx * s - wz * c;   // forward coord (+ = toward bow)
    out[1] = wx * c + wz * s;   // lateral coord (+ = starboard)
    return out;
  }

  // Deck surface height at world (x, z) or -1 when off the deck (i.e. open sky/sea).
  deckAt(x, z) {
    const o = _local;
    this.toLocal(x, z, o);
    if (o[0] >= -CARRIER_TUNING.LENGTH / 2 && o[0] <= CARRIER_TUNING.LENGTH / 2 &&
      Math.abs(o[1]) <= CARRIER_TUNING.WIDTH / 2) {
      return CARRIER_TUNING.DECK_Y;
    }
    return -1;
  }

  // Arrestor zone test: deck-local rect near the stern. Returns true when inside.
  inArrestorZone(x, z) {
    const o = _local;
    this.toLocal(x, z, o);
    const center = -CARRIER_TUNING.LENGTH / 2 + CARRIER_TUNING.ARRESTOR_OFFSET;
    return Math.abs(o[0] - center) <= CARRIER_TUNING.ARRESTOR_LENGTH * 0.5 &&
      Math.abs(o[1]) <= CARRIER_TUNING.WIDTH * 0.42;
  }

  // Touchdown evaluation (called by main when a jet is at deck height inside the deck rect).
  // gearDown/speedMs/sinkRate describe the jet. Returns: 0 = no, 1 = arrested (clean landing),
  // 2 = crash (no gear / too fast / too hard).
  evaluateTouchdown(gearDown, speedMs, sinkRate) {
    if (!gearDown) return 2;
    if (speedMs > CARRIER_TUNING.LAND_SPEED_MAX) return 2;
    if (sinkRate > CARRIER_TUNING.LAND_SINK_MAX) return 2;
    return 1;
  }

  // Catapult start pose (bow, aligned with heading). Writes into out { x, y, z, yaw }.
  catapultPose(out) {
    const fx = Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const bowZ = CARRIER_TUNING.LENGTH / 2 - 40;
    out[0] = this.pos[0] + fx * bowZ;
    out[1] = CARRIER_TUNING.DECK_Y + 2.5;
    out[2] = this.pos[2] + fz * bowZ;
    out[3] = this.yaw;
    return out;
  }

  // Knots helper for the HUD.
  knots(speedMs) { return speedMs * KTS; }

  // ---- Procedural geometry: interleaved [pos3, normal3, color3], Uint16 indices ----
  // Original ship silhouette: hull, angled flight deck, island tower, mast, deck bulge.
  buildMesh() {
    const rnd = mulberry32(CARRIER_TUNING.MESH_SEED);
    void rnd; // reserved for future deck detailing; keeps the generator deterministic
    const out = { verts: [], idx: [], vertCount: 0 };
    const L = CARRIER_TUNING.LENGTH, W = CARRIER_TUNING.WIDTH, DY = CARRIER_TUNING.DECK_Y;
    const HULL = [0.23, 0.25, 0.28], DECK = [0.30, 0.33, 0.36], TOWER = [0.42, 0.45, 0.49],
      DARK = [0.16, 0.17, 0.19];
    // hull (sits in the water, below deck)
    pushBox(out, 0, DY * 0.45, 0, W * 0.62, DY * 0.9, L * 0.96, 0, HULL);
    // flight deck (full width slab, overhangs the hull)
    pushBox(out, 0, DY, 0, W, 2.4, L, 0, DECK);
    // angled landing area strip (visual variety, starboard aft)
    pushBox(out, W * 0.22, DY + 0.3, -L * 0.16, W * 0.34, 0.4, L * 0.55, 0, DARK);
    // island tower (starboard)
    pushBox(out, W * 0.36, DY + 9, L * 0.12, 9, 16, 22, 0, TOWER);
    // mast
    pushBox(out, W * 0.36, DY + 20, L * 0.12, 1.2, 9, 1.2, 0, DARK);
    // bow catapult shuttle track (thin dark strip)
    pushBox(out, 0, DY + 1.35, L * 0.32, 2.2, 0.35, L * 0.3, 0, DARK);
    return {
      verts: new Float32Array(out.verts),
      idx: new Uint16Array(out.idx),
      stride: 9,
    };
  }
}

const _local = new Float32Array(2);

// Shared box builder (same layout conventions as renderer.buildJetLod's pushBox: rotation about
// Y, flat normals, two triangles per face). Duplicated locally to keep render/world decoupled.
function pushBox(out, cx, cy, cz, sx, sy, sz, rotY, col) {
  const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
  const c = Math.cos(rotY), s = Math.sin(rotY);
  const px = [hx, hx, hx, hx, -hx, -hx, -hx, -hx];
  const py = [hy, hy, -hy, -hy, hy, hy, -hy, -hy];
  const pz = [-hz, hz, hz, -hz, -hz, hz, hz, -hz];
  const vx = new Float32Array(8), vy = new Float32Array(8), vz = new Float32Array(8);
  for (let i = 0; i < 8; i++) {
    vx[i] = px[i] * c + pz[i] * s + cx;
    vz[i] = -px[i] * s + pz[i] * c + cz;
    vy[i] = py[i] + cy;
  }
  const faces = [
    [1, 2, 6, 5], [4, 7, 3, 0], [4, 5, 6, 7], [0, 3, 2, 1], [5, 6, 2, 1], [0, 3, 7, 4],
  ];
  const base = out.vertCount;
  for (let f = 0; f < 6; f++) {
    const q = faces[f];
    const ax = vx[q[1]] - vx[q[0]], ay = vy[q[1]] - vy[q[0]], az = vz[q[1]] - vz[q[0]];
    const bx = vx[q[2]] - vx[q[0]], by = vy[q[2]] - vy[q[0]], bz = vz[q[2]] - vz[q[0]];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (let k = 0; k < 4; k++) {
      out.verts.push(vx[q[k]], vy[q[k]], vz[q[k]], nx, ny, nz, col[0], col[1], col[2]);
      out.vertCount++;
    }
    const b2 = base + f * 4;
    out.idx.push(b2, b2 + 1, b2 + 2, b2, b2 + 2, b2 + 3);
  }
}
