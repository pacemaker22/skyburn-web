// Skyburn Phase 1 - Impact Cam (Task 1.8): "Impact Cam 0.3s slow-mo". On a kill/heavy hit the
// camera cuts to a side view of the impact point and sim time scales to 0.35x for 0.3 s
// (real-time), ramping back out. Pure state machine, no allocation; main reads timeScale each
// frame and passes scaled dt into the sim, and may override the chase camera while active.

export const IMPACT_TUNING = {
  DURATION: 0.3,        // s (real time, PRD)
  TIME_SCALE: 0.35,     // sim speed during the effect
  EASE_IN: 0.06,        // s to reach full slow-mo
  EASE_OUT: 0.09,       // s ramping back to 1x
  CAM_DIST: 55,         // m side-view offset from the impact point
  CAM_HEIGHT: 14,
};

export class ImpactCam {
  constructor() {
    this.active = false;
    this.timer = 0;          // countdown of the effect (real seconds)
    this.timeScale = 1;
    this.pos = new Float32Array(3);   // impact point (world)
    this.camPos = new Float32Array(3);
    this.camTarget = new Float32Array(3);
  }

  trigger(x, y, z) {
    this.pos[0] = x; this.pos[1] = y; this.pos[2] = z;
    this.timer = IMPACT_TUNING.DURATION;
    this.active = true;
    this.timeScale = 1; // ramps down on first update
  }

  // dtReal: real frame time (NOT scaled). Updates timeScale + internal camera pose.
  update(dtReal, camPos, camTarget) {
    if (!this.active) return;
    this.timer -= dtReal;
    if (this.timer <= 0) {
      this.active = false;
      this.timeScale = 1;
      return;
    }
    const elapsed = IMPACT_TUNING.DURATION - this.timer;
    const T = IMPACT_TUNING;
    // ease in -> hold -> ease out
    let scale = T.TIME_SCALE;
    if (elapsed < T.EASE_IN) {
      scale = 1 + (T.TIME_SCALE - 1) * (elapsed / T.EASE_IN);
    } else if (this.timer < T.EASE_OUT) {
      scale = 1 + (T.TIME_SCALE - 1) * (this.timer / T.EASE_OUT);
    }
    this.timeScale = scale;

    // side-view cut: offset perpendicular to the camera->impact direction
    let dx = this.pos[0] - camPos[0];
    let dz = this.pos[2] - camPos[2];
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= d; dz /= d;
    this.camPos[0] = this.pos[0] - dz * T.CAM_DIST;
    this.camPos[1] = this.pos[1] + T.CAM_HEIGHT;
    this.camPos[2] = this.pos[2] + dx * T.CAM_DIST;
    this.camTarget[0] = this.pos[0];
    this.camTarget[1] = this.pos[1];
    this.camTarget[2] = this.pos[2];
  }
}
