// Skyburn Phase 0 - Game loop (Task 0.2): fixed timestep 120 Hz physics, variable render with
// interpolation. Accumulator pattern, max 5 steps per frame, spiral-of-death protection.
// No logic in render. No allocation in frame() - all stat objects are preallocated.
// PRD invariant: input is sampled exactly once per physics tick - step() owns sampling.

export const FIXED_HZ = 120;
export const FIXED_DT = 1 / FIXED_HZ;              // seconds
export const FIXED_DT_MS = 1000 / FIXED_HZ;        // milliseconds
export const MAX_STEPS_PER_FRAME = 5;

export class GameLoop {
  constructor(opts) {
    this.step = opts.step;               // fn(dtSeconds)        - fixed physics tick
    this.render = opts.render;           // fn(alpha)            - interpolation render
    this.maxSteps = opts.maxSteps || MAX_STEPS_PER_FRAME;
    this.accumulator = 0;
    this.lastNow = -1;
    // Profiler stats (single preallocated object, mutated in place - zero allocation).
    this.stats = {
      fps: 0, frameMs: 0, stepMs: 0, stepsPerSecond: 0,
      lastSteps: 0, alpha: 0, droppedMs: 0,
    };
    this._stepsAccum = 0;
    this._stepsWindowStart = -1;
    this._emaFrames = 0;
  }

  // Advance one rendered frame. `nowMs` = monotonic timestamp (rAF time or test-provided).
  // Returns number of fixed steps executed this frame (used by tests to prove 120 Hz).
  frame(nowMs) {
    const s = this.stats;
    if (this.lastNow < 0) {
      this.lastNow = nowMs;
      this._stepsWindowStart = nowMs;
      return 0;
    }
    let dt = nowMs - this.lastNow;
    this.lastNow = nowMs;
    if (dt > 250) {
      // Spiral-of-death / background-tab protection: cap the debt we are willing to repay.
      s.droppedMs += dt - 250;
      dt = 250;
    }
    this.accumulator += dt;

    let steps = 0;
    const t0 = performance.now();
    while (this.accumulator >= FIXED_DT_MS && steps < this.maxSteps) {
      this.step(FIXED_DT);
      this.accumulator -= FIXED_DT_MS;
      steps++;
    }
    if (steps === this.maxSteps && this.accumulator >= FIXED_DT_MS) {
      // Backlog still too large after maxSteps: drop it instead of spiraling.
      s.droppedMs += this.accumulator;
      this.accumulator = 0;
    }
    const tStep = performance.now() - t0;

    const alpha = this.accumulator / FIXED_DT_MS;
    s.alpha = alpha;
    this.render(alpha);
    if (steps > 0) this._stepsAccum += steps;

    // rolling stats
    this._emaFrames++;
    const k = 0.08;
    s.frameMs += (dt - s.frameMs) * k;
    s.stepMs += (tStep - s.stepMs) * k;
    s.fps = dt > 0 ? 1000 / dt : 0;
    s.lastSteps = steps;
    if (nowMs - this._stepsWindowStart >= 1000) {
      const span = nowMs - this._stepsWindowStart;
      s.stepsPerSecond = (this._stepsAccum * 1000) / span;
      this._stepsAccum = 0;
      this._stepsWindowStart = nowMs;
    }
    return steps;
  }
}
