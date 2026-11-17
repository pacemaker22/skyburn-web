// Skyburn Phase 3B - Procedural music loop (Task 3B.5). Fully synthesized (no audio
// assets: the bundle stays tiny): a slow minor-pentatonic bass line under a detuned pad
// chord, scheduled ahead on the AudioContext clock by tick() (called from the main loop;
// the per-tick work is two AudioParam automations at most). Volumes: music gain multiplies
// into the AudioSystem master so the MASTER slider covers everything. Safe to import in
// Node (no AudioContext): every entry point guards on the context.

const STEP_SEC = 0.5;                          // sequencer step (bass notes)
const STEPS = 16;                              // bar length (8 s loop)
const BASS_SEQ = [0, 0, 3, 0, 5, 7, 3, 2, 0, 0, 3, 0, 10, 7, 3, 2]; // semitones over A1
const PAD_ROOTS = [0, -4, -7, -9];             // Am F C G (per 4 steps)
const A1 = 55;                                 // Hz

export class MusicSystem {
  // audio: the shared AudioSystem (its ctx + master gain); may be null (own ctx fallback).
  constructor(audio) {
    this.audio = audio || null;
    this.volume = 0.5;
    this._ctx = null;          // own context fallback (only when audio has none)
    this._out = null;          // music gain node
    this._bass = null;
    this._bassGain = null;
    this._padA = null;
    this._padB = null;
    this._padGain = null;
    this._nextStep = 0;        // AudioContext time of the next scheduled step
    this._step = 0;            // step index in the loop
    this.playing = false;
  }

  _context() {
    if (this.audio && this.audio.ctx) return this.audio.ctx;
    if (!this._ctx) {
      const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return null;
      this._ctx = new AC();
    }
    return this._ctx;
  }

  // One-time voice construction (init-time only, like every other node pool).
  _build(ctx) {
    const out = ctx.createGain();
    out.gain.value = this.volume;
    const dest = (this.audio && this.audio.master) ? this.audio.master : ctx.destination;
    out.connect(dest);
    this._out = out;

    this._bass = ctx.createOscillator();
    this._bass.type = 'triangle';
    this._bass.frequency.value = A1;
    this._bassGain = ctx.createGain();
    this._bassGain.gain.value = 0;
    this._bass.connect(this._bassGain);
    this._bassGain.connect(out);
    this._bass.start();

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 720;
    filt.Q.value = 0.6;
    this._padA = ctx.createOscillator();
    this._padA.type = 'sawtooth';
    this._padA.frequency.value = A1 * 2;
    this._padB = ctx.createOscillator();
    this._padB.type = 'sawtooth';
    this._padB.frequency.value = A1 * 2 * 1.006;
    this._padGain = ctx.createGain();
    this._padGain.gain.value = 0;
    this._padA.connect(filt);
    this._padB.connect(filt);
    filt.connect(this._padGain);
    this._padGain.connect(out);
    this._padA.start();
    this._padB.start();
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this._out) this._out.gain.value = this.volume;
  }

  start() {
    const ctx = this._context();
    if (!ctx || this.playing) return;
    if (!this._out) this._build(ctx);
    this.playing = true;
    this._step = 0;
    this._nextStep = ctx.currentTime + 0.1;
  }

  stop() {
    this.playing = false;
  }

  // Lookahead scheduler: call once per frame from the render path. Cheap (compares the
  // context clock and schedules at most a step or two of AudioParam automation).
  tick() {
    if (!this.playing) return;
    const ctx = this._context();
    if (!ctx) return;
    const horizon = ctx.currentTime + 0.5;
    let guard = 4; // never schedule more than 2 s ahead in one frame
    while (this._nextStep < horizon && guard-- > 0) {
      this._scheduleStep(ctx, this._step % STEPS, this._nextStep);
      this._step++;
      this._nextStep += STEP_SEC;
    }
    if (this._nextStep < ctx.currentTime) this._nextStep = ctx.currentTime + 0.1; // tab stall
  }

  _scheduleStep(ctx, step, t) {
    // bass note: short pluck through a fast envelope
    this._bass.frequency.setValueAtTime(A1 * Math.pow(2, BASS_SEQ[step] / 12), t);
    this._bassGain.gain.setValueAtTime(0.0001, t);
    this._bassGain.gain.exponentialRampToValueAtTime(0.30, t + 0.02);
    this._bassGain.gain.exponentialRampToValueAtTime(0.001, t + STEP_SEC * 0.9);
    // pad chord change every 4 steps: slow attack, long release
    if (step % 4 === 0) {
      const root = A1 * 2 * Math.pow(2, PAD_ROOTS[(step / 4) | 0] / 12);
      this._padA.frequency.setValueAtTime(root, t);
      this._padB.frequency.setValueAtTime(root * 1.006, t);
      this._padGain.gain.setTargetAtTime(0.05, t, 0.8);
      this._padGain.gain.setTargetAtTime(0.012, t + 1.4, 0.6);
    }
  }
}
