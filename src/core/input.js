// Skyburn Phase 0 - Input abstraction (Task 0.3).
// Keyboard + Mouse + Gamepad API all write into ONE InputState struct. Game logic never reads
// devices directly (PRD Sec 5). Deadzone 0.12. Remapping table lives here in code.
// sample() is called exactly once per physics tick (PRD critical invariant).
// Zero allocation in sample(): all buffers preallocated, out-param style.

export const DEADZONE = 0.12;

// Canonical InputState fields (PRD Sec 5) plus the extra actions from the controls table.
export const ACTION = {
  PITCH: 0, ROLL: 1, YAW: 2, THROTTLE: 3,        // analog axes, range [-1, 1]
  FIRE_GUN: 4, FIRE_MISSILE: 5, FLARE: 6,        // buttons
  AFTERBURNER: 7, AIRBRAKE: 8,                   // buttons (held)
  SWITCH_WEAPON: 9, TARGET_NEXT: 10, TARGET_NEAREST: 11, CAMERA: 12, // edge buttons
  COUNT: 13,
};

// Remapping table in code (PRD: "Remapping table in code"). Key code -> action name.
// Mouse-aim pointer position drives pitch/roll (mouse position = desired heading).
export const KEY_REMAP = {
  KeyW: 'throttle_up', KeyS: 'throttle_down',
  Space: 'afterburner',
  ShiftLeft: 'airbrake', ShiftRight: 'airbrake',
  KeyF: 'flare',
  KeyG: 'switch_weapon',
  KeyR: 'target_next', KeyE: 'target_nearest',
  KeyC: 'camera', KeyM: 'camera',
};

// Gamepad standard-mapping indices (per PRD controls table).
export const GAMEPAD_MAP = {
  AXIS_LEFT_X: 0,   // roll
  AXIS_LEFT_Y: 1,   // pitch
  BUTTON_A: 0,      // lock / fire missile
  BUTTON_B: 1,      // flare
  BUTTON_X: 2,      // switch weapon
  BUTTON_Y: 3,      // target next
  BUTTON_LB: 4,     // throttle down
  BUTTON_RB: 5,     // throttle up
  BUTTON_LT: 6,     // airbrake (analog trigger)
  BUTTON_RT: 7,     // guns (analog trigger)
  BUTTON_L3: 10,    // afterburner (click left stick)
  BUTTON_DPAD_UP: 12, BUTTON_DPAD_DOWN: 13, // throttle trim
};

const NAME_TO_INDEX = {
  pitch: ACTION.PITCH, roll: ACTION.ROLL, yaw: ACTION.YAW, throttle: ACTION.THROTTLE,
  fireGun: ACTION.FIRE_GUN, fireMissile: ACTION.FIRE_MISSILE, flare: ACTION.FLARE,
  afterburner: ACTION.AFTERBURNER, airbrake: ACTION.AIRBRAKE,
  switch_weapon: ACTION.SWITCH_WEAPON, target_next: ACTION.TARGET_NEXT,
  target_nearest: ACTION.TARGET_NEAREST, camera: ACTION.CAMERA,
  throttle_up: ACTION.THROTTLE, throttle_down: ACTION.THROTTLE,
};

// Small integer ids for held-key flags (no string keys in the hot path).
const CODE_ID = {};
{
  let id = 0;
  for (const code of Object.keys(KEY_REMAP)) CODE_ID[code] = id++;
  CODE_ID['KeyQ'] = id++; // reserved, no binding in PRD table
  CODE_ID['KeyZ'] = id++;
}
const CODE_COUNT = Object.keys(CODE_ID).length;
const CODE_ACTION = new Int8Array(CODE_COUNT);
const CODE_SIGN = new Float32Array(CODE_COUNT);
for (const code of Object.keys(KEY_REMAP)) {
  const id = CODE_ID[code];
  const name = KEY_REMAP[code];
  CODE_ACTION[id] = NAME_TO_INDEX[name];
  CODE_SIGN[id] = name === 'throttle_down' ? -1 : 1;
}
const THROTTLE_AXIS = ACTION.THROTTLE;

export class InputSystem {
  constructor(opts) {
    this.onFirstInput = (opts && opts.onFirstInput) || null;
    // The InputState struct - preallocated typed arrays, mutated in place.
    this.analog = new Float32Array(ACTION.COUNT);   // current analog values
    this.buttons = new Uint8Array(ACTION.COUNT);    // current held state 0/1
    this.prevButtons = new Uint8Array(ACTION.COUNT); // previous tick held state (edges)
    this.edges = new Uint8Array(ACTION.COUNT);      // 1 = pressed since last sample
    // keyboard
    this.held = new Uint8Array(CODE_COUNT);
    this._throttleKey = 0;       // -1 / 0 / +1 from W/S
    // mouse (mouse position = desired heading)
    this.pointerX = 0;           // normalized [-1, 1], 0 = screen center
    this.pointerY = 0;
    this._rectCx = 0; this._rectCy = 0; this._rectHalfW = 1; this._rectHalfH = 1;
    this.mouseFireGun = 0;       // left button held
    this.mouseLockHeld = 0;      // right button held (lock)
    this._wheelThrottle = 0;     // accumulated wheel delta -> throttle axis
    // gamepad
    this.gamepadIndex = -1;
    this.virtualGamepad = null;  // tests inject state here
    this._gpOut = new Array(4);  // [rollAxis, pitchAxis, throttleTrigger, buttonsRef]
    this._stickOut = new Float32Array(2);
    // Phase 4 (Task 4.6): pad settings (persisted in save.settings.gamepad) -
    // deadzone, sensitivity, rumble toggle and a per-action button remap.
    this.onPadChange = (opts && opts.onPadChange) || null;
    this.dz = DEADZONE;
    this.sensitivity = 1;
    this.rumbleEnabled = true;
    this.PB = null;              // action name -> pad button index (built from settings)
    this.setPadSettings((opts && opts.padSettings) || null);
    // input latency proof (PRD: respond < 50 ms)
    this.lastEventTimeMs = -1;
    this._hadEvent = false;
    this._firstInputSent = false;
  }

  // ---- DOM wiring (browser only; tests call keyDown/keyUp/pointerMove directly) ----
  attach(canvas, win) {
    const w = win || window;
    this._canvas = canvas;
    w.addEventListener('keydown', (e) => {
      if (e.code === 'Space') e.preventDefault();
      if (!e.repeat) this.keyDown(e.code, e.timeStamp);
    });
    w.addEventListener('keyup', (e) => this.keyUp(e.code, e.timeStamp));
    canvas.addEventListener('pointermove', (e) => {
      this.setPointer(e.clientX, e.clientY);
      this._markEvent(e.timeStamp);
    });
    canvas.addEventListener('pointerdown', (e) => {
      this.setPointer(e.clientX, e.clientY);
      this._markEvent(e.timeStamp);
      this.mouseDown(e.button);
      this._notifyFirstInput();
    });
    w.addEventListener('pointerup', (e) => this.mouseUp(e.button, e.timeStamp));
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._wheelThrottle += -e.deltaY * 0.0015;
      this._markEvent(e.timeStamp);
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.setViewport();
  }

  setViewport() {
    if (!this._canvas) return;
    const r = this._canvas.getBoundingClientRect();
    this._rectCx = r.left + r.width * 0.5;
    this._rectCy = r.top + r.height * 0.5;
    this._rectHalfW = Math.max(1, r.width * 0.5);
    this._rectHalfH = Math.max(1, r.height * 0.5);
  }

  // Direct viewport setup (used by unit tests without a DOM).
  setViewportRaw(left, top, width, height) {
    this._rectCx = left + width * 0.5;
    this._rectCy = top + height * 0.5;
    this._rectHalfW = Math.max(1, width * 0.5);
    this._rectHalfH = Math.max(1, height * 0.5);
  }

  // ---- Event ingestion (also used directly by unit tests) ----
  _markEvent(t) {
    if (t !== undefined && isFinite(t)) this.lastEventTimeMs = t;
    this._hadEvent = true;
  }

  _notifyFirstInput() {
    if (!this._firstInputSent && this.onFirstInput) { this._firstInputSent = true; this.onFirstInput(); }
  }

  keyDown(code, t) {
    const id = CODE_ID[code];
    if (id === undefined) return;
    this.held[id] = 1;
    this._markEvent(t);
    this._notifyFirstInput();
  }

  keyUp(code, t) {
    const id = CODE_ID[code];
    if (id === undefined) return;
    this.held[id] = 0;
    this._markEvent(t);
  }

  mouseDown(button) {
    if (button === 0) this.mouseFireGun = 1;
    if (button === 2) this.mouseLockHeld = 1;
  }

  mouseUp(button, t) {
    if (button === 0) this.mouseFireGun = 0;
    if (button === 2) this.mouseLockHeld = 0;
    this._markEvent(t);
  }

  setPointer(clientX, clientY) {
    this.pointerX = clamp((clientX - this._rectCx) / this._rectHalfW, -1, 1);
    this.pointerY = clamp((clientY - this._rectCy) / this._rectHalfH, -1, 1);
  }

  setVirtualGamepad(v) { this.virtualGamepad = v; }

  // ---- Phase 4 (Task 4.6): pad settings, hot-plug, rumble ----

  // Apply user pad settings (save.settings.gamepad). Rebuilds the button bindings:
  // remap entries override the standard-mapping defaults; out-of-range entries fall
  // back to the default so a corrupt save can never break the pad.
  setPadSettings(s) {
    const g = s || {};
    this.dz = (typeof g.deadzone === 'number' && g.deadzone >= 0 && g.deadzone <= 0.5)
      ? g.deadzone : DEADZONE;
    this.sensitivity = (typeof g.sensitivity === 'number' && g.sensitivity > 0)
      ? Math.min(2, g.sensitivity) : 1;
    this.rumbleEnabled = g.rumble !== false;
    const R = (g.remap && typeof g.remap === 'object') ? g.remap : {};
    const def = (name, d) =>
      (typeof R[name] === 'number' && R[name] >= 0 && R[name] <= 17) ? R[name] : d;
    this.PB = {
      fireGun: def('fireGun', GAMEPAD_MAP.BUTTON_RT),
      fireMissile: def('fireMissile', GAMEPAD_MAP.BUTTON_A),
      flare: def('flare', GAMEPAD_MAP.BUTTON_B),
      switchWeapon: def('switchWeapon', GAMEPAD_MAP.BUTTON_X),
      targetNext: def('targetNext', GAMEPAD_MAP.BUTTON_Y),
      airbrake: def('airbrake', GAMEPAD_MAP.BUTTON_LT),
      afterburner: def('afterburner', GAMEPAD_MAP.BUTTON_L3),
    };
  }

  // Hot-plug wiring (browser only; called from main alongside attach()).
  // gamepadconnected also counts as first input (unlocks audio like a keypress).
  attachPadHotPlug(win) {
    const w = win || (typeof window !== 'undefined' ? window : null);
    if (!w || !w.addEventListener) return;
    w.addEventListener('gamepadconnected', (e) => {
      if (this.gamepadIndex < 0) this.gamepadIndex = e.gamepad.index;
      this._markEvent(undefined);
      this._notifyFirstInput();
      if (this.onPadChange) this.onPadChange(true, e.gamepad && e.gamepad.id);
    });
    w.addEventListener('gamepaddisconnected', (e) => {
      if (this.gamepadIndex === e.gamepad.index) {
        this.gamepadIndex = -1;
        this.virtualGamepad = null;
      }
      if (this.onPadChange) this.onPadChange(false, e.gamepad && e.gamepad.id);
    });
  }

  // Dual-rumble, best effort (Task 4.6): no-op headlessly, on pads without the
  // vibration API, or when the user disabled rumble. strength 0..1, ms <= 500.
  rumble(strength, ms) {
    if (!this.rumbleEnabled) return;
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
    const pad = navigator.getGamepads()[this.gamepadIndex];
    const act = pad && pad.vibrationActuator;
    if (!act || !act.playEffect) return;
    try {
      const s = Math.max(0, Math.min(1, strength));
      act.playEffect('dual-rumble', {
        duration: Math.max(0, Math.min(500, ms | 0)),
        strongMagnitude: s, weakMagnitude: s * 0.7,
      });
    } catch (e) { void e; /* unsupported effect - ignore */ }
  }

  // ---- Per-tick sampling (PRD invariant: exactly once per physics tick) ----
  sample() {
    const a = this.analog, b = this.buttons, e = this.edges, prev = this.prevButtons;
    b.fill(0);
    a.fill(0);

    // --- keyboard ---
    let throttleAxis = 0;
    for (let id = 0; id < CODE_COUNT; id++) {
      if (!this.held[id]) continue;
      const act = CODE_ACTION[id];
      if (act < 0) continue;
      if (act === THROTTLE_AXIS) throttleAxis += CODE_SIGN[id];
      else b[act] = 1;
    }

    // --- mouse: position = desired heading (PRD Sec 5) ---
    // Center small deadzone so resting the mouse does not drift the jet.
    const mx = applyDz(this.pointerX, 0.06);
    const my = applyDz(this.pointerY, 0.06);
    // screen up => nose up; screen right => bank right. Mouse-aim curve, clamped.
    a[ACTION.PITCH] = clamp(-my * 1.35, -1, 1);
    a[ACTION.ROLL] = clamp(mx * 1.35, -1, 1);
    if (this.mouseFireGun) b[ACTION.FIRE_GUN] = 1;
    // Right Click Hold/Release: release edge fires the missile.
    if (this.mouseLockHeld) b[ACTION.FIRE_MISSILE] = 1;
    throttleAxis += clamp(this._wheelThrottle, -1, 1);
    this._wheelThrottle = 0;

    // --- gamepad (hot-plug safe: polled every tick) ---
    const gp = this._pollGamepad();
    if (gp) {
      const [lx, ly, triggers, padButtons] = gp;
      // sticks win over mouse when pushed beyond deadzone ("two schemes, equal")
      if (lx !== 0 || ly !== 0) {
        // Task 4.6: user sensitivity scales the deadzone-corrected stick output
        a[ACTION.ROLL] = clamp(lx * this.sensitivity, -1, 1);
        a[ACTION.PITCH] = clamp(ly * this.sensitivity, -1, 1);
      }
      throttleAxis += triggers;
      // Task 4.6: buttons go through the persisted remap bindings (this.PB)
      if (padButtons[this.PB.fireGun]) b[ACTION.FIRE_GUN] = 1;
      if (padButtons[this.PB.fireMissile]) b[ACTION.FIRE_MISSILE] = 1;
      if (padButtons[this.PB.flare]) b[ACTION.FLARE] = 1;
      if (padButtons[this.PB.switchWeapon]) b[ACTION.SWITCH_WEAPON] = 1;
      if (padButtons[this.PB.targetNext]) b[ACTION.TARGET_NEXT] = 1;
      if (padButtons[this.PB.afterburner] ||
        (trigVal(padButtons, this.PB.airbrake) > 0.9 &&
          trigVal(padButtons, this.PB.fireGun) > 0.9)) b[ACTION.AFTERBURNER] = 1;
      if (trigVal(padButtons, this.PB.airbrake) > 0.5) b[ACTION.AIRBRAKE] = 1;
    }

    a[ACTION.THROTTLE] = clamp(throttleAxis, -1, 1);

    // edges = pressed since last sample (computed against the freshly composed state)
    for (let i = 0; i < ACTION.COUNT; i++) {
      e[i] = b[i] & (1 ^ prev[i]);
      prev[i] = b[i];
    }
    this._hadEvent = false;
    return this; // InputState
  }

  getAxis(action) { return this.analog[action]; }
  isDown(action) { return this.buttons[action] === 1; }
  wasPressed(action) { return this.edges[action] === 1; }
  hadEvent() { return this._hadEvent; }

  // Poll real gamepad or the injected virtual one. Returns null when absent.
  // Out-arrays are preallocated; per-stick radial deadzone 0.12 (PRD).
  _pollGamepad() {
    let axes = null, buttons = null;
    if (this.virtualGamepad) {
      axes = this.virtualGamepad.axes;
      buttons = this.virtualGamepad.buttons;
    } else if (typeof navigator !== 'undefined' && navigator.getGamepads) {
      const pads = navigator.getGamepads();
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (p && p.connected) {
          axes = p.axes; buttons = p.buttons; this.gamepadIndex = i;
          break;
        }
      }
      if (!axes) this.gamepadIndex = -1;
    }
    if (!axes) return null;
    deadzoneRadial(axes[GAMEPAD_MAP.AXIS_LEFT_X], axes[GAMEPAD_MAP.AXIS_LEFT_Y],
      this.dz, this._stickOut);
    this._gpOut[0] = this._stickOut[0];
    this._gpOut[1] = -this._stickOut[1]; // stick up = nose up
    this._gpOut[2] = (btnVal(buttons, GAMEPAD_MAP.BUTTON_RB) - btnVal(buttons, GAMEPAD_MAP.BUTTON_LB))
      + (btnVal(buttons, GAMEPAD_MAP.BUTTON_DPAD_UP) - btnVal(buttons, GAMEPAD_MAP.BUTTON_DPAD_DOWN));
    this._gpOut[3] = buttons; // reference, not copied (no allocation)
    return this._gpOut;
  }
}

// ---- Pure helpers (exported for unit tests) ----

export function clamp(v, lo, hi) {
  const r = v < lo ? lo : (v > hi ? hi : v);
  return r === 0 ? 0 : r; // normalize -0 to 0 (Object.is semantics)
}

// Deadzone with smooth re-entry: inside dz -> 0, outside -> rescaled to full range.
export function applyDz(v, dz) {
  const m = v < 0 ? -v : v;
  if (m <= dz) return 0;
  return (v / m) * ((m - dz) / (1 - dz));
}

// Radial deadzone on a stick pair (PRD: deadzone 0.12 for sticks). Writes into out (no allocation).
export function deadzoneRadial(x, y, dz, out) {
  const m = Math.sqrt(x * x + y * y);
  if (m <= dz) { out[0] = 0; out[1] = 0; return out; }
  const scale = ((m - dz) / (1 - dz)) / m;
  out[0] = x * scale; out[1] = y * scale;
  return out;
}

function btnVal(buttons, i) {
  if (!buttons) return 0;
  const b = buttons[i];
  if (b === undefined) return 0;
  return typeof b === 'object' ? (b.value || (b.pressed ? 1 : 0)) : b;
}

function trigVal(buttons, i) { return btnVal(buttons, i); }
