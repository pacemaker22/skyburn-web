// Skyburn Phase 0 - Core audio (PRD file list: src/core/audio.js). Fully synthesized with
// WebAudio - original, no external assets. Pooled nodes: one engine voice (2 detuned saws +
// lowpass) and a small fixed pool of beep voices. Safe to import in Node (no AudioContext).

export class AudioSystem {
  constructor(opts) {
    this.masterVolume = (opts && opts.volume) !== undefined ? opts.volume : 0.22;
    this.ctx = null;
    this._engineOscA = null;
    this._engineOscB = null;
    this._engineFilter = null;
    this._engineGain = null;
    this._beepPool = null;   // [{osc, gain, busy}]
    this._beepCursor = 0;
  }

  // Lazily create the context; must be called from a user gesture handler.
  init() {
    if (this.ctx) return true;
    const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return false;
    const ctx = new AC();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = this.masterVolume;
    master.connect(ctx.destination);
    this.master = master;
    // engine voice: two detuned saws through a lowpass
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 320;
    filt.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    const oA = ctx.createOscillator();
    oA.type = 'sawtooth';
    oA.frequency.value = 60;
    const oB = ctx.createOscillator();
    oB.type = 'sawtooth';
    oB.frequency.value = 61.7;
    oA.connect(filt); oB.connect(filt);
    filt.connect(g); g.connect(master);
    oA.start(); oB.start();
    this._engineOscA = oA; this._engineOscB = oB;
    this._engineFilter = filt; this._engineGain = g;
    // beep pool (4 voices, reused forever - no per-sound allocation)
    this._beepPool = [];
    for (let i = 0; i < 4; i++) {
      const bo = ctx.createOscillator();
      bo.type = 'square';
      bo.frequency.value = 440;
      const bg = ctx.createGain();
      bg.gain.value = 0;
      bo.connect(bg); bg.connect(master);
      bo.start();
      this._beepPool.push({ osc: bo, gain: bg, busy: false });
    }
    return true;
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }

  // Map throttle/afterburner onto the engine voice. Allocation-free (param automation only).
  setEngine(throttle01, afterburner) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const ab = afterburner ? 1 : 0;
    const f = 55 + throttle01 * 70 + ab * 28;
    const cut = 300 + throttle01 * 1300 + ab * 900;
    const vol = 0.10 + throttle01 * 0.22 + ab * 0.10;
    this._engineOscA.frequency.setTargetAtTime(f, t, 0.08);
    this._engineOscB.frequency.setTargetAtTime(f * 1.028, t, 0.08);
    this._engineFilter.frequency.setTargetAtTime(cut, t, 0.10);
    this._engineGain.gain.setTargetAtTime(vol, t, 0.10);
  }

  // Short UI blip through the beep pool (lock tone, etc. later phases).
  beep(freq, durationSec, volume) {
    if (!this.ctx) return;
    const v = this._beepPool[this._beepCursor];
    this._beepCursor = (this._beepCursor + 1) % this._beepPool.length;
    const t = this.ctx.currentTime;
    const dur = durationSec || 0.08;
    v.osc.frequency.setValueAtTime(freq || 660, t);
    v.gain.gain.setValueAtTime(volume || 0.25, t);
    v.gain.gain.setTargetAtTime(0, t, dur * 0.5);
  }
}
