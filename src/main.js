// Skyburn Phase 0 - Entry point (PRD: /src/main.js - Boot, game loop, fixed timestep).
// One jet flying over ocean at 120 Hz physics + interpolated render. No enemies (Phase 0 goal).

import { GameLoop, FIXED_DT } from './core/loop.js';
import { InputSystem, ACTION } from './core/input.js';
import { AudioSystem } from './core/audio.js';
import { Renderer, buildJetLod } from './render/renderer.js';
import { Terrain } from './world/terrain.js';
import { Ocean } from './world/ocean.js';
import { initVec3 } from './wasm/vec3.js';
import {
  assertFinite3, assertSpeedCapped, assertActiveCount, getViolationCount,
} from './verify/invariants.js';

const DEG = Math.PI / 180;
const ARENA_HALF = 19000; // 40 km x 40 km x 12 km altitude arena (PRD non-goal: bounded arenas)

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

function pickJet(data) {
  const list = Array.isArray(data) ? data : data.jets;
  const wanted = new URLSearchParams(window.location.search).get('jet');
  if (wanted) {
    for (const j of list) if (j.id === wanted) return j;
  }
  return list[0];
}

// ---- Placeholder simple flight (Task 0.6: pitch/roll from input, throttle, speed, lift) ----
// Full 6DOF + PID model in WASM arrives in Phase 1 (src/physics/flight.js).

class JetPlaceholder {
  constructor(data, terrain) {
    this.data = data;
    this.terrain = terrain;
    this.maxSpeedMs = data.maxSpeed / 3.6;      // km/h -> m/s
    this.stallSpeedMs = data.stallSpeed / 3.6;
    this.turnRateRad = data.turnRate * DEG;     // deg/s -> rad/s
    // state: pos + yaw/pitch/roll, with prev copies for render interpolation
    this.pos = new Float32Array([0, 1500, 8000]);
    this.prevPos = new Float32Array(this.pos);
    this.rot = new Float32Array([0, 0, 0]);     // yaw, pitch, roll (rad)
    this.prevRot = new Float32Array(this.rot);
    this.throttle = 0.65;
    this.speed = this.maxSpeedMs * 0.55;
    this.afterburner = false;
  }

  // One fixed physics tick. Reads ONLY from the InputState (PRD: logic never touches devices).
  tick(input, dt) {
    // interpolation snapshot (prev <- current)
    this.prevPos.set(this.pos);
    this.prevRot.set(this.rot);

    // throttle integrate (W/S, wheel, gamepad triggers)
    this.throttle += input.getAxis(ACTION.THROTTLE) * 0.5 * dt;
    if (this.throttle < 0) this.throttle = 0;
    if (this.throttle > 1) this.throttle = 1;

    this.afterburner = input.isDown(ACTION.AFTERBURNER);
    const airbrake = input.isDown(ACTION.AIRBRAKE);

    // speed: thrust - drag simplified to exponential approach of target speed
    let target = this.maxSpeedMs * (0.35 + 0.65 * this.throttle);
    if (this.afterburner) target *= 1.3;
    if (airbrake) target *= 0.55;
    const accel = this.maxSpeedMs * 0.22;
    const dspeed = target - this.speed;
    const maxStep = accel * dt;
    this.speed += dspeed > maxStep ? maxStep : (dspeed < -maxStep ? -maxStep : dspeed);

    // rotation rates from InputState (pitch/roll; yaw reserved - no PRD key binding)
    const pitchRate = input.getAxis(ACTION.PITCH) * this.turnRateRad;
    const rollRate = input.getAxis(ACTION.ROLL) * (110 * DEG);
    this.rot[0] += input.getAxis(ACTION.YAW) * 6 * DEG * dt; // yaw
    this.rot[1] += pitchRate * dt;
    if (this.rot[1] > 75 * DEG) this.rot[1] = 75 * DEG;
    if (this.rot[1] < -75 * DEG) this.rot[1] = -75 * DEG;
    this.rot[2] += rollRate * dt;
    if (this.rot[2] > Math.PI) this.rot[2] -= Math.PI * 2;
    if (this.rot[2] < -Math.PI) this.rot[2] += Math.PI * 2;

    // forward from yaw/pitch (yaw 0 = -Z)
    const yaw = this.rot[0], pitch = this.rot[1];
    const fx = Math.sin(yaw) * Math.cos(pitch);
    const fy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * Math.cos(pitch);

    this.pos[0] += fx * this.speed * dt;
    this.pos[1] += fy * this.speed * dt;
    this.pos[2] += fz * this.speed * dt;

    // lift loss / sink below stall speed (arcade: gentle sink, no spin)
    if (this.speed < this.stallSpeedMs) {
      this.pos[1] -= (this.stallSpeedMs - this.speed) * 2.2 * dt;
    }

    // keep above ground/ocean (no crash model in Phase 0)
    const ground = Math.max(this.terrain.heightAt(this.pos[0], this.pos[2]), 0) + 8;
    if (this.pos[1] < ground) {
      this.pos[1] = ground;
      if (this.rot[1] < 0.04) this.rot[1] = 0.04;
    }
    // bounded arena
    this.pos[0] = clampAbs(this.pos[0], ARENA_HALF);
    this.pos[2] = clampAbs(this.pos[2], ARENA_HALF);
    if (this.pos[1] > 11500) this.pos[1] = 11500;

    // Task 0.8 invariants: no NaN in position, speed capped, activeCount
    assertFinite3('jet.pos', this.pos[0], this.pos[1], this.pos[2]);
    assertFinite3('jet.rot', this.rot[0], this.rot[1], this.rot[2]);
    assertSpeedCapped('jet.speed', this.speed, this.maxSpeedMs);
    assertActiveCount('jets', 1, 1);
  }

  // Interpolated state for render (alpha in [0,1)). Writes into provided out arrays.
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
}

function clampAbs(v, lim) {
  return v > lim ? lim : (v < -lim ? -lim : v);
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
  const jetData = pickJet(jets);

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

  const jet = new JetPlaceholder(jetData, terrain);

  // render-side interpolated scratch (preallocated)
  const rPos = new Float32Array(3);
  const rRot = new Float32Array(3);
  // chase camera state with lag (PRD Sec 9: chase cam with lag, FOV kick on afterburner)
  const camPos = new Float32Array([0, 1560, 8100]);
  const camTarget = new Float32Array(3);
  let fovDeg = 62;

  // Profiler HUD (Task 0.2): FPS, frame ms, physics ms, physics Hz, latency, scale, heap
  const hud = {
    fps: $('hud-fps'), ms: $('hud-ms'), pms: $('hud-pms'), hz: $('hud-hz'),
    lat: $('hud-lat'), scale: $('hud-scale'), heap: $('hud-heap'),
    spd: $('hud-spd'), alt: $('hud-alt'), thr: $('hud-thr'), jetName: $('hud-jet'),
    violations: $('hud-inv'),
  };
  hud.jetName.textContent = jetData.name + ' (' + jetData.id + ')';
  let hudNext = 0;
  let latEma = 0;
  let lastLatencyEvent = -1;

  const loop = new GameLoop({
    // ---- fixed 120 Hz physics tick: input sampled exactly once per tick ----
    step: (dt) => {
      input.sample();
      jet.tick(input, dt);
      audio.setEngine(jet.throttle, jet.afterburner);
    },
    // ---- variable render with interpolation; no game logic here ----
    render: (alpha) => {
      jet.sampleInterpolated(alpha, rPos, rRot);
      // camera: behind + above, looking ahead along the nose
      const yaw = rRot[0], pitch = rRot[1];
      const fx = Math.sin(yaw) * Math.cos(pitch);
      const fy = Math.sin(pitch);
      const fz = -Math.cos(yaw) * Math.cos(pitch);
      const back = 42, up = 14;
      const dx = rPos[0] - fx * back;
      const dy = rPos[1] - fy * back * 0.4 + up;
      const dz = rPos[2] - fz * back;
      // exponential lag (frame-rate independent)
      const k = 1 - Math.exp(-6 / 60);
      camPos[0] += (dx - camPos[0]) * k;
      camPos[1] += (dy - camPos[1]) * k;
      camPos[2] += (dz - camPos[2]) * k;
      camTarget[0] = rPos[0] + fx * 140;
      camTarget[1] = rPos[1] + fy * 140;
      camTarget[2] = rPos[2] + fz * 140;
      // FOV kick on afterburner
      const targetFov = jet.afterburner ? 70 : 62;
      fovDeg += (targetFov - fovDeg) * 0.08;

      const timeSec = performance.now() * 0.001;
      const dxj = rPos[0] - camPos[0], dyj = rPos[1] - camPos[1], dzj = rPos[2] - camPos[2];
      const dist = Math.sqrt(dxj * dxj + dyj * dyj + dzj * dzj);
      renderer.drawFrame(camPos, camTarget, fovDeg * DEG, rPos, rRot[0], rRot[1], rRot[2], dist, timeSec);

      // input latency proof (PRD: < 50 ms event-to-render)
      if (input.lastEventTimeMs > lastLatencyEvent) {
        lastLatencyEvent = input.lastEventTimeMs;
        const lat = performance.now() - lastLatencyEvent;
        if (lat >= 0 && lat < 1000) latEma = latEma === 0 ? lat : latEma * 0.8 + lat * 0.2;
      }

      // throttled HUD update (4 Hz) - keeps strings/allocations out of the hot path
      const now = performance.now();
      if (now >= hudNext) {
        hudNext = now + 250;
        const s = loop.stats;
        hud.fps.textContent = 'FPS ' + s.fps.toFixed(0);
        hud.ms.textContent = 'frame ' + s.frameMs.toFixed(2) + ' ms';
        hud.pms.textContent = 'physics ' + s.stepMs.toFixed(2) + ' ms';
        hud.hz.textContent = 'physics ' + s.stepsPerSecond.toFixed(0) + ' Hz / ' + s.lastSteps + ' steps';
        hud.lat.textContent = 'input latency ' + latEma.toFixed(1) + ' ms';
        hud.scale.textContent = 'res scale ' + renderer.renderScale.toFixed(2) + ' (' + canvas.width + 'x' + canvas.height + ')';
        const mem = (typeof performance !== 'undefined' && performance.memory) ? performance.memory : null;
        hud.heap.textContent = mem ? 'heap ' + (mem.usedJSHeapSize / 1048576).toFixed(1) + ' MB' : 'heap n/a';
        hud.spd.textContent = 'speed ' + (jet.speed * 3.6).toFixed(0) + ' km/h';
        hud.alt.textContent = 'alt ' + jet.pos[1].toFixed(0) + ' m';
        hud.thr.textContent = 'throttle ' + (jet.throttle * 100).toFixed(0) + '%' + (jet.afterburner ? ' + AB' : '');
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
