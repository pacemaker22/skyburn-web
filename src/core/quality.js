// Skyburn Phase 4 - Quality governor (Task 4.5): auto resolution scale.
// PRD/PLAN: "auto quality: if fps < 50 for 5 s, lower resolution to 0.8x then 0.6x".
// Pure decision logic (headless-testable): the caller feeds fps samples with the real
// elapsed time and receives the scale to apply (apply callback fires only on changes).
// The governor only steps DOWN (recovery is manual via the [ ] keys or a mission reload)
// - an oscillating scale would stutter worse than a steady lower one.

export const QUALITY_TUNING = {
  FPS_FLOOR: 50,          // fps below this counts as "struggling"
  HOLD_SECONDS: 5,        // must stay below the floor this long before stepping down
  STEPS: [1.0, 0.8, 0.6], // allowed render scales (index 0 = full)
};

export class QualityGovernor {
  // apply: fn(scale) called only when the scale actually changes (setRenderScale).
  constructor(apply, opts) {
    this.apply = apply || null;
    this.steps = (opts && opts.steps) || QUALITY_TUNING.STEPS;
    this.fpsFloor = (opts && opts.fpsFloor) || QUALITY_TUNING.FPS_FLOOR;
    this.holdSeconds = (opts && opts.holdSeconds) || QUALITY_TUNING.HOLD_SECONDS;
    this.index = 0;          // current index into steps (0 = full res)
    this.scale = this.steps[0];
    this.belowFor = 0;       // seconds accumulated below the floor since the last step-down
    this.enabled = true;
  }

  // dtSec: real elapsed seconds for this sample; fps: current fps reading (EMA).
  // Returns the current scale. Side effect: fires apply() on a step-down.
  update(dtSec, fps) {
    if (!this.enabled) return this.scale;
    if (this.index >= this.steps.length - 1) return this.scale; // already at the floor scale
    if (fps < this.fpsFloor) {
      this.belowFor += dtSec;
      // epsilon: repeated float addition (0.1 * 50) can land just under the target
      if (this.belowFor >= this.holdSeconds - 1e-9) {
        this.index++;
        this.scale = this.steps[this.index];
        this.belowFor = 0;
        if (this.apply) this.apply(this.scale);
      }
    } else {
      this.belowFor = 0;   // a single good frame window resets the hold (no flapping)
    }
    return this.scale;
  }
}
