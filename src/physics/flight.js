// Skyburn Phase 1 - 6DOF flight model + PID rate controllers (Task 1.1).
// Tuning comes from jets.json (thrust/drag/maxSpeed/turnRate/stallSpeed) plus the tuning
// constants below (documented, original values). WASM-first like vec3 (Task 0.7 pattern):
// fetch('./flight.wasm') is attempted once and falls back to this JS reference implementation
// with the SAME API - on this machine no wasm32 toolchain exists, so the JS path runs.
//
// Model (arcade-6DOF, deterministic):
//  - orientation: Euler yaw/pitch/roll integrated from body rates with bank-to-turn coupling:
//      pitchDot = q*cos(roll)                    (pull while banked climbs)
//      yawDot   = -q*sin(roll) + r/cos(pitch)    (pull while banked turns the heading)
//      rollDot  = p
//  - three PID controllers (pitch/roll/yaw) track commanded body rates from InputState;
//    PID output = angular acceleration (clamped), incl. integral anti-windup.
//  - airspeed scalar ODE: thrust/mass - quadratic drag - gravity component along the path
//    (climbing bleeds speed, diving gains it). Afterburner raises acceleration and the cap to
//    maxSpeed*1.05 (PRD invariant: speed <= maxSpeed*1.05 - AB accelerates to the cap faster,
//    it does not break it).
//  - stall below stallSpeed: lift collapses -> nose-drop torque, sink, mushy controls (0.4x).
//  - zero allocation per tick (preallocated scratch, out-param interpolation).

import { assertFinite3, assertFinite1, assertSpeedCapped } from '../verify/invariants.js';

export const TUNING = {
  GRAVITY: 9.81,
  PITCH_RATE_MAX_SCALE: 1.0,   // pitch rate cap = turnRate (deg/s from jets.json)
  ROLL_RATE_MAX_DEG: 110,      // roll rate cap (arcade snappy)
  YAW_RATE_MAX_DEG: 9,         // rudder yaw (no key binding in PRD table; AI coordination use)
  PID_PITCH: { kp: 5.2, ki: 0.9, kd: 0.55 },
  PID_ROLL: { kp: 7.0, ki: 0.5, kd: 0.30 },
  PID_YAW: { kp: 3.2, ki: 0.3, kd: 0.25 },
  ANG_ACCEL_MAX: 9.0,          // rad/s^2 clamp on PID output (authority)
  SLIP_ALIGN: 2.6,             // 1/s how fast velocity aligns to the nose
  SLIP_GAIN: 0.22,             // slip generated per turn-load (sideslip float)
  STALL_SINK: 2.2,             // sink accel factor below stall (m/s per m/s deficit)
  STALL_NOSE_DROP: 0.9,        // rad/s^2 nose-drop torque in stall
  STALL_AUTHORITY: 0.4,        // control authority multiplier in stall
  AB_SPOOL: 2.4,               // afterburner accel multiplier
  AB_CAP_SCALE: 1.05,          // AB cap = maxSpeed * 1.05 (PRD invariant bound)
  DRAG_AIRBRAKE: 2.6,          // airbrake drag multiplier
  INDUCED_DRAG: 0.35,          // induced drag factor per (g-1)^2 (speed bleed in turns)
  RHO: 1.225,                  // sea-level air density (kg/m^3)
  WING_AREA: 27.9,             // F-16-class reference wing area (m^2) - pairs with jets.json drag
  THROTTLE_RATE: 0.5,          // throttle axis integration 1/s
  MASS_KG: 9500,               // F-16 class empty+fuel (thrust/mass drives accel)
  PITCH_CLAMP_DEG: 78,         // Euler singularity guard
};

// Textbook PID with anti-windup (integral clamp) and derivative-on-measurement off
// (derivative on error, clamped). step() returns the control output, zero allocation.
export class PID {
  constructor(kp, ki, kd, outMin, outMax) {
    this.kp = kp; this.ki = ki; this.kd = kd;
    this.outMin = outMin; this.outMax = outMax;
    this.integral = 0;
    this.prevError = 0;
    this.primed = false;
    this.out = 0;
  }

  step(target, actual, dt) {
    const err = target - actual;
    this.integral += err * dt;
    const iMax = Math.abs(this.outMax) / Math.max(1e-6, this.ki);
    if (this.integral > iMax) this.integral = iMax;
    if (this.integral < -iMax) this.integral = -iMax;
    const d = this.primed ? (err - this.prevError) / dt : 0;
    this.prevError = err;
    this.primed = true;
    let o = this.kp * err + this.ki * this.integral + this.kd * d;
    if (o > this.outMax) o = this.outMax;
    if (o < this.outMin) o = this.outMin;
    this.out = o;
    return o;
  }

  reset() { this.integral = 0; this.prevError = 0; this.primed = false; this.out = 0; }
}
export class FlightModel {
  // jetData: entry from jets.json. opts: { x, y, z, yaw, pitch, throttle }
  constructor(jetData, opts) {
    const o = opts || {};
    this.data = jetData;
    this.maxSpeed = jetData.maxSpeed / 3.6;          // km/h -> m/s
    this.stallSpeed = jetData.stallSpeed / 3.6;
    this.turnRate = jetData.turnRate * (Math.PI / 180);
    this.thrustN = jetData.thrust;
    this.dragCoef = jetData.drag;

    // pose (Euler, rad) + prev copies for render interpolation
    this.pos = new Float32Array([o.x || 0, o.y || 1500, o.z || 8000]);
    this.prevPos = new Float32Array(this.pos);
    this.rot = new Float32Array([o.yaw || 0, o.pitch || 0, 0]);
    this.prevRot = new Float32Array(this.rot);

    // full 6DOF state
    this.vel = new Float32Array(3);       // world velocity (forward*speed + slip)
    this.slip = new Float32Array(3);      // sideslip residual (float during stall)
    this.rates = new Float32Array(3);     // body p (roll), q (pitch), r (yaw) rad/s
    this.speed = this.maxSpeed * (o.throttle !== undefined ? 0.35 + 0.65 * o.throttle : 0.65);
    this.throttle = o.throttle !== undefined ? o.throttle : 0.65;
    this.afterburner = false;
    this.airbrake = false;
    this.stalled = false;
    this.gLoad = 1;                       // load factor (for induced drag + HUD)

    this.pidPitch = new PID(TUNING.PID_PITCH.kp, TUNING.PID_PITCH.ki, TUNING.PID_PITCH.kd,
      -TUNING.ANG_ACCEL_MAX, TUNING.ANG_ACCEL_MAX);
    this.pidRoll = new PID(TUNING.PID_ROLL.kp, TUNING.PID_ROLL.ki, TUNING.PID_ROLL.kd,
      -TUNING.ANG_ACCEL_MAX * 1.5, TUNING.ANG_ACCEL_MAX * 1.5);
    this.pidYaw = new PID(TUNING.PID_YAW.kp, TUNING.PID_YAW.ki, TUNING.PID_YAW.kd,
      -TUNING.ANG_ACCEL_MAX, TUNING.ANG_ACCEL_MAX);

    // WASM hook (Task 1.1 "WASM"): same pattern as vec3 - try the artifact, fall back to JS.
    this.backend = 'js-fallback';
  }

  async initBackend() {
    try {
      if (typeof fetch !== 'function' || typeof WebAssembly === 'undefined') {
        throw new Error('WebAssembly unavailable');
      }
      const url = new URL('./flight.wasm', import.meta.url);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('flight.wasm not available (' + resp.status + ')');
      const bytes = await resp.arrayBuffer();
      await WebAssembly.instantiate(bytes);
      this.backend = 'wasm'; // artifact validated; hot path stays JS until exports are wired
    } catch (e) {
      this.backend = 'js-fallback';
    }
    return this.backend;
  }

  // One fixed 120 Hz tick. Commands in [-1, 1]; throttleAxis [-1,1]; dt seconds.
  tick(pitchCmd, rollCmd, yawCmd, throttleAxis, afterburner, airbrake, dt) {
    // interpolation snapshot
    this.prevPos.set(this.pos);
    this.prevRot.set(this.rot);

    // throttle integration
    this.throttle += throttleAxis * TUNING.THROTTLE_RATE * dt;
    if (this.throttle < 0) this.throttle = 0;
    if (this.throttle > 1) this.throttle = 1;
    this.afterburner = !!afterburner;
    this.airbrake = !!airbrake;

    // authority: stalled aircraft responds mushy
    const auth = this.stalled ? TUNING.STALL_AUTHORITY : 1;

    // ---- PID body-rate control (Task 1.1: PID) ----
    const qCmd = pitchCmd * this.turnRate * TUNING.PITCH_RATE_MAX_SCALE * auth;
    const pCmd = rollCmd * (TUNING.ROLL_RATE_MAX_DEG * Math.PI / 180) * auth;
    const rCmd = yawCmd * (TUNING.YAW_RATE_MAX_DEG * Math.PI / 180) * auth;
    let angAccP = this.pidPitch.step(qCmd, this.rates[1], dt);
    let angAccR = this.pidRoll.step(pCmd, this.rates[0], dt);
    let angAccY = this.pidYaw.step(rCmd, this.rates[2], dt);
    if (angAccP > TUNING.ANG_ACCEL_MAX) angAccP = TUNING.ANG_ACCEL_MAX;
    if (angAccP < -TUNING.ANG_ACCEL_MAX) angAccP = -TUNING.ANG_ACCEL_MAX;
    if (angAccR > TUNING.ANG_ACCEL_MAX * 1.5) angAccR = TUNING.ANG_ACCEL_MAX * 1.5;
    if (angAccR < -TUNING.ANG_ACCEL_MAX * 1.5) angAccR = -TUNING.ANG_ACCEL_MAX * 1.5;

    // stall nose-drop torque (unstable breakup when lift collapses)
    if (this.stalled) angAccP -= TUNING.STALL_NOSE_DROP;

    this.rates[1] += angAccP * dt; // q
    this.rates[0] += angAccR * dt; // p
    this.rates[2] += angAccY * dt; // r

    // ---- Euler integration with bank-to-turn coupling ----
    const p = this.rates[0], q = this.rates[1], r = this.rates[2];
    const roll = this.rot[2], pitch = this.rot[1];
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const cp = Math.max(0.2, Math.cos(pitch)); // Euler singularity guard
    this.rot[1] += q * cr * dt;                       // pitchDot
    this.rot[0] += (-q * sr + r / cp) * dt;           // yawDot (banked pull = heading change)
    this.rot[2] += p * dt;                            // rollDot
    const LIMIT = TUNING.PITCH_CLAMP_DEG * Math.PI / 180;
    if (this.rot[1] > LIMIT) this.rot[1] = LIMIT;
    if (this.rot[1] < -LIMIT) this.rot[1] = -LIMIT;
    if (this.rot[2] > Math.PI) this.rot[2] -= Math.PI * 2;
    if (this.rot[2] < -Math.PI) this.rot[2] += Math.PI * 2;
    this.rot[0] = wrapAngle(this.rot[0]);

    // ---- airspeed ODE: thrust - drag - gravity-along-path (+ lift-induced drag) ----
    const yaw = this.rot[0];
    const pit = this.rot[1];
    const fx = Math.sin(yaw) * Math.cos(pit);
    const fy = Math.sin(pit);
    const fz = -Math.cos(yaw) * Math.cos(pit);

    const cap = this.afterburner ? this.maxSpeed * TUNING.AB_CAP_SCALE : this.maxSpeed;
    const thrustAcc = (this.thrustN / TUNING.MASS_KG) * this.throttle *
      (this.afterburner ? TUNING.AB_SPOOL : 1);
    // aerodynamic drag: 0.5 * rho * v^2 * S * Cd / mass (Cd from jets.json).
    // Equilibrium: full throttle ~= maxSpeed (F-16: 13.1 m/s^2 drag at 588.9 m/s).
    const dragBase = 0.5 * TUNING.RHO * TUNING.WING_AREA * this.dragCoef *
      this.speed * this.speed / TUNING.MASS_KG;
    const drag = dragBase * (this.airbrake ? TUNING.DRAG_AIRBRAKE : 1);
    // induced drag grows with turn load (tight pulls bleed energy - PRD "speed bleed")
    const load = 1 + Math.abs(q) * 2.4;
    this.gLoad = load;
    const induced = TUNING.INDUCED_DRAG * (load - 1) * (load - 1) * dragBase;
    // gravity along flight path: climbing (fy > 0) bleeds, diving gains
    const gravityAlong = TUNING.GRAVITY * fy;

    let acc = thrustAcc - drag - induced - gravityAlong;
    this.speed += acc * dt;

    // stall detection + hard speed caps (PRD invariant: speed <= maxSpeed * 1.05)
    this.stalled = this.speed < this.stallSpeed;
    if (this.speed > cap) this.speed = cap;
    if (this.speed < 25) this.speed = 25; // never fully stop mid-air (arcade floor)

    // velocity = forward * speed + decaying slip (float during stall / hard turns)
    const align = 1 - Math.exp(-TUNING.SLIP_ALIGN * dt);
    this.slip[0] -= this.slip[0] * align;
    this.slip[1] -= this.slip[1] * align;
    this.slip[2] -= this.slip[2] * align;
    this.vel[0] = fx * this.speed + this.slip[0];
    this.vel[1] = fy * this.speed + this.slip[1];
    this.vel[2] = fz * this.speed + this.slip[2];

    // integrate position
    this.pos[0] += this.vel[0] * dt;
    this.pos[1] += this.vel[1] * dt;
    this.pos[2] += this.vel[2] * dt;

    // stall sink (lift loss below stall speed - Phase 0 arcade behavior preserved)
    if (this.stalled) {
      this.pos[1] -= (this.stallSpeed - this.speed) * TUNING.STALL_SINK * dt;
    }

    // Task 1.1 invariants (Phase 0 invariants module, dev-only)
    assertFinite3('flight.pos', this.pos[0], this.pos[1], this.pos[2]);
    assertFinite3('flight.rot', this.rot[0], this.rot[1], this.rot[2]);
    assertFinite1('flight.speed', this.speed);
    assertSpeedCapped('flight.speed', this.speed, this.maxSpeed);
  }

  // Interpolated pose for render (alpha in [0,1)); writes into caller arrays (no allocation).
  sampleInterpolated(alpha, outPos, outRot) {
    outPos[0] = this.prevPos[0] + (this.pos[0] - this.prevPos[0]) * alpha;
    outPos[1] = this.prevPos[1] + (this.pos[1] - this.prevPos[1]) * alpha;
    outPos[2] = this.prevPos[2] + (this.pos[2] - this.prevPos[2]) * alpha;
    for (let i = 0; i < 3; i++) {
      let a = this.prevRot[i], b = this.rot[i];
      let d = b - a;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      outRot[i] = a + d * alpha;
    }
  }

  // Instant teleport (carrier catapult placement / respawn). No interpolation ghosts.
  teleport(x, y, z, yaw, pitch) {
    this.pos[0] = x; this.pos[1] = y; this.pos[2] = z;
    this.prevPos.set(this.pos);
    if (yaw !== undefined) this.rot[0] = yaw;
    if (pitch !== undefined) this.rot[1] = pitch;
    this.prevRot.set(this.rot);
  }
}

function wrapAngle(a) {
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}
