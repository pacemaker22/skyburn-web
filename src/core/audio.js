// Skyburn Phase 1 - Core audio (PRD file list: src/core/audio.js; Task 1.8 "WebAudio pooled
// engine/gun/missile/explosion/lock"). Fully synthesized - original, no external assets.
// Everything is preallocated node pools driven by param automation (zero allocation per call).
// Safe to import in Node (no AudioContext): every entry point guards on this.ctx.

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
    this._gunPool = null;    // [{gain, filter}] gated noise voices
    this._gunCursor = 0;
    this._boomPool = null;   // explosion voices
    this._boomCursor = 0;
    this._launchPool = null; // missile launch voices
    this._launchCursor = 0;
    this._lockOsc = null;
    this._lockGain = null;
    this._windGain = null;
    this._windFilter = null;
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
    // shared white-noise buffer (1 s, mono) - created once, reused by every noise voice
    const len = ctx.sampleRate;
    const nbuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ndata = nbuf.getChannelData(0);
    for (let i = 0; i < len; i++) ndata[i] = Math.random() * 2 - 1;
    this._noiseBuf = nbuf;

    // gun pool (6 gated noise voices through bandpass) - rapid fire
    this._gunPool = [];
    for (let i = 0; i < 6; i++) {
      const src = ctx.createBufferSource();
      src.buffer = nbuf; src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 1.1;
      const gg = ctx.createGain(); gg.gain.value = 0;
      src.connect(bp); bp.connect(gg); gg.connect(master);
      src.start();
      this._gunPool.push({ gain: gg, filter: bp });
    }

    // explosion pool (3 voices: noise -> lowpass sweep down)
    this._boomPool = [];
    for (let i = 0; i < 3; i++) {
      const src = ctx.createBufferSource();
      src.buffer = nbuf; src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 800;
      const gg = ctx.createGain(); gg.gain.value = 0;
      src.connect(lp); lp.connect(gg); gg.connect(master);
      src.start();
      this._boomPool.push({ gain: gg, filter: lp });
    }

    // missile launch pool (2 voices: noise -> highpass whoosh)
    this._launchPool = [];
    for (let i = 0; i < 2; i++) {
      const src = ctx.createBufferSource();
      src.buffer = nbuf; src.loop = true;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 600;
      const gg = ctx.createGain(); gg.gain.value = 0;
      src.connect(hp); hp.connect(gg); gg.connect(master);
      src.start();
      this._launchPool.push({ gain: gg, filter: hp });
    }

    // lock tone (dedicated osc; seeking beeps + solid locked tone)
    this._lockOsc = ctx.createOscillator();
    this._lockOsc.type = 'square';
    this._lockOsc.frequency.value = 950;
    this._lockGain = ctx.createGain();
    this._lockGain.gain.value = 0;
    this._lockOsc.connect(this._lockGain); this._lockGain.connect(master);
    this._lockOsc.start();

    // wind (looping noise -> lowpass, gain follows airspeed)
    const wsrc = ctx.createBufferSource();
    wsrc.buffer = nbuf; wsrc.loop = true;
    this._windFilter = ctx.createBiquadFilter();
    this._windFilter.type = 'lowpass';
    this._windFilter.frequency.value = 300;
    this._windGain = ctx.createGain();
    this._windGain.gain.value = 0;
    wsrc.connect(this._windFilter); this._windFilter.connect(this._windGain);
    this._windGain.connect(master);
    wsrc.start();
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

  // Airspeed wind noise (speed01 = speed / maxSpeed).
  setWind(speed01) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = Math.max(0, Math.min(1, speed01));
    this._windGain.gain.setTargetAtTime(s * s * 0.16, t, 0.25);
    this._windFilter.frequency.setTargetAtTime(200 + s * 900, t, 0.25);
  }

  // One gun shot (600 RPM -> called at most every 100 ms): short bandpassed noise crack.
  gun() {
    if (!this.ctx) return;
    const v = this._gunPool[this._gunCursor];
    this._gunCursor = (this._gunCursor + 1) % this._gunPool.length;
    const t = this.ctx.currentTime;
    v.filter.frequency.setValueAtTime(700 + Math.random() * 500, t);
    v.gain.gain.setValueAtTime(0.5, t);
    v.gain.gain.setTargetAtTime(0, t, 0.028);
  }

  // Missile launch whoosh.
  missileLaunch() {
    if (!this.ctx) return;
    const v = this._launchPool[this._launchCursor];
    this._launchCursor = (this._launchCursor + 1) % this._launchPool.length;
    const t = this.ctx.currentTime;
    v.filter.frequency.setValueAtTime(500, t);
    v.filter.frequency.setTargetAtTime(2400, t, 0.35);
    v.gain.gain.setValueAtTime(0.42, t);
    v.gain.gain.setTargetAtTime(0, t, 0.30);
  }

  // Explosion: low rumble with a downward filter sweep.
  explosion() {
    if (!this.ctx) return;
    const v = this._boomPool[this._boomCursor];
    this._boomCursor = (this._boomCursor + 1) % this._boomPool.length;
    const t = this.ctx.currentTime;
    v.filter.frequency.setValueAtTime(1400, t);
    v.filter.frequency.setTargetAtTime(90, t, 0.45);
    v.gain.gain.setValueAtTime(0.85, t);
    v.gain.gain.setTargetAtTime(0, t, 0.55);
  }

  // Lock FSM audio (Task 1.8 "lock"): seeking beeps while LOCKING, solid tone when LOCKED,
  // silence otherwise.
  lockSeekBeep() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._lockOsc.frequency.setValueAtTime(920, t);
    this._lockGain.gain.setValueAtTime(0.16, t);
    this._lockGain.gain.setTargetAtTime(0, t, 0.05);
  }

  lockTone(on) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._lockOsc.frequency.setValueAtTime(1180, t);
    this._lockGain.gain.setTargetAtTime(on ? 0.12 : 0, t, 0.02);
  }

  // Missile warning (incoming missile on the player): urgent double blip.
  warnBeep() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.beepAt(1500, 0.09, 0.3, t);
    this.beepAt(1500, 0.09, 0.3, t + 0.13);
  }

  // Short UI blip through the beep pool.
  beep(freq, durationSec, volume) {
    if (!this.ctx) return;
    this.beepAt(freq, durationSec, volume, this.ctx.currentTime);
  }

  beepAt(freq, durationSec, volume, when) {
    const v = this._beepPool[this._beepCursor];
    this._beepCursor = (this._beepCursor + 1) % this._beepPool.length;
    const dur = durationSec || 0.08;
    v.osc.frequency.setValueAtTime(freq || 660, when);
    v.gain.gain.setValueAtTime(volume || 0.25, when);
    v.gain.gain.setTargetAtTime(0, when, dur * 0.5);
  }
}
