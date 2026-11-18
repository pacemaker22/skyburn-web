// Skyburn Phase 4 - Profiler (Task 4.5): named CPU timers + frame counters for the dev
// HUD and the verification report. Zero allocation in the hot path (preallocated stat
// objects, EMA smoothing, out-param snapshot). Timers measure wall time with
// performance.now (Node + browser both provide it); they are dev tooling - the
// verification gate for the 60 fps AC is documented in docs/VERIFICATION_REPORT.md.

export const PROFILER_TUNING = {
  EMA_K: 0.08,          // smoothing factor (matches GameLoop.stats style)
};

export class Profiler {
  constructor() {
    this.timers = new Map();   // name -> { ms (EMA), last, open (start time or -1) }
    this.counters = new Map(); // name -> last integer value (draw calls, entity counts)
    this.frameMs = 0;          // whole-frame EMA
  }

  // Open a named timing scope. Nested/reentrant opens of the same name are ignored
  // (first open wins) so wiring it around possibly-recursive calls stays safe.
  begin(name) {
    let t = this.timers.get(name);
    if (t === undefined) {
      t = { ms: 0, last: 0, open: -1 };
      this.timers.set(name, t);
    }
    if (t.open < 0) t.open = performance.now();
  }

  // Close the named scope (must pair with begin). Accumulates an EMA of the duration.
  end(name) {
    const t = this.timers.get(name);
    if (!t || t.open < 0) return;
    const dt = performance.now() - t.open;
    t.open = -1;
    t.last = dt;
    t.ms += (dt - t.ms) * PROFILER_TUNING.EMA_K;
  }

  // Set/refresh a counter (draw calls, entities, missiles, ...).
  count(name, value) { this.counters.set(name, value); }

  // Per-frame bookkeeping: whole-frame time EMA.
  frame(dtMs) { this.frameMs += (dtMs - this.frameMs) * PROFILER_TUNING.EMA_K; }

  // Snapshot for the HUD/report. Writes into the caller object when given (no alloc).
  snapshot(out) {
    const o = out || { timers: {}, counters: {} };
    o.timers = o.timers || {};
    o.counters = o.counters || {};
    this.timers.forEach((t, name) => { o.timers[name] = t.ms; });
    this.counters.forEach((v, name) => { o.counters[name] = v; });
    o.frameMs = this.frameMs;
    return o;
  }

  // One-line summary for the dev HUD.
  line() {
    const parts = ['frame ' + this.frameMs.toFixed(1) + ' ms'];
    this.timers.forEach((t, name) => {
      parts.push(name + ' ' + t.ms.toFixed(2) + ' ms');
    });
    this.counters.forEach((v, name) => {
      parts.push(name + ' ' + v);
    });
    return parts.join(' / ');
  }

  reset() { this.timers.clear(); this.counters.clear(); this.frameMs = 0; }
}
