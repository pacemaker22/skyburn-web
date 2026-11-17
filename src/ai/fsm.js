// Skyburn Phase 1 - Table-driven FSM engine (PRD: "Everything is an FSM: states enum,
// transition table, pure guards, onEnter/onExit. One file per FSM.").
// This module is the shared ENGINE; each concrete FSM (missile, lock, enemy AI, player, game)
// owns its own file + table built with these classes.
// Fully numeric: states/events are small ints, the table is a flat Int32Array -> zero allocation
// and no string keys in the hot path. Names exist only for debug prints and test assertions.

// Guard functions are pure: (ctx) -> boolean. Action hooks receive (ctx) and may mutate ctx.
// onExit/onEnter are optional per-state hooks: called around every successful transition.

export class FSMTable {
  // numStates/numEvents are the enum sizes; states/events are dense ints [0..n).
  constructor(numStates, numEvents, stateNames, eventNames) {
    this.numStates = numStates;
    this.numEvents = numEvents;
    this.stateNames = stateNames;   // string[] (debug only)
    this.eventNames = eventNames;   // string[] (debug only)
    this.slot = new Int32Array(numStates * numEvents); // 0 = no transition, else entries idx+1
    this.entries = [];              // { from, event, to, guard, action } (built once at init)
    this.onEnter = new Array(numStates).fill(null); // fn(state, ctx) after transition into state
    this.onExit = new Array(numStates).fill(null);  // fn(state, ctx) before transition out
  }

  add(from, event, to, guard, action) {
    const idx = from * this.numEvents + event;
    if (this.slot[idx] !== 0) {
      throw new Error('FSM duplicate transition ' + this.stateNames[from] + ' --' +
        this.eventNames[event] + '-> in table');
    }
    this.entries.push({ from, event, to, guard: guard || null, action: action || null });
    this.slot[idx] = this.entries.length;
  }

  lookup(from, event) {
    const idx = this.slot[from * this.numEvents + event];
    return idx === 0 ? null : this.entries[idx - 1];
  }

  // Structural validation (called once at init by each concrete FSM; also unit-tested):
  // - every `to` is a defined state id (caller guarantees by construction, re-checked here)
  // - forbidden pairs (e.g. missile GUIDE cannot -> SPAWN) are rejected.
  // forbidden = array of [fromState, toState] pairs.
  validate(forbidden) {
    for (const e of this.entries) {
      if (!(e.to >= 0 && e.to < this.numStates)) throw new Error('FSM bad target state');
      if (!(e.from >= 0 && e.from < this.numStates)) throw new Error('FSM bad source state');
    }
    if (forbidden) {
      for (const e of this.entries) {
        for (let i = 0; i < forbidden.length; i++) {
          if (e.from === forbidden[i][0] && e.to === forbidden[i][1]) {
            throw new Error('FSM forbidden transition ' + this.stateNames[e.from] + ' -> ' +
              this.stateNames[e.to] + ' (PRD invariant)');
          }
        }
      }
    }
    return true;
  }
}

export class FSM {
  constructor(table, initialState, ctx) {
    this.table = table;
    this.state = initialState;
    this.prevState = initialState;   // state before the most recent fire() (for tests/debug)
    this.timeInState = 0;            // seconds accumulated in current state (advance via tick)
    this.transitions = 0;            // total fired count (deterministic replay/debug)
    this.lastEvent = -1;
    this.ctx = ctx || null;
    const hook = table.onEnter[this.state];
    if (hook) hook(this.state, this.ctx);
  }

  // Advance state time (call once per physics tick; no allocation).
  tick(dt) { this.timeInState += dt; }

  // Attempt an event transition. Returns true when the transition was taken.
  fire(event, ctx) {
    const c = ctx || this.ctx;
    const entry = this.table.lookup(this.state, event);
    if (!entry) return false;
    if (entry.guard && !entry.guard(c)) return false;
    const xHook = this.table.onExit[this.state];
    if (xHook) xHook(this.state, c);
    this.prevState = this.state;
    this.state = entry.to;
    this.timeInState = 0;
    this.transitions++;
    this.lastEvent = event;
    if (entry.action) entry.action(c);
    const eHook = this.table.onEnter[this.state];
    if (eHook) eHook(this.state, c);
    return true;
  }

  name() { return this.table.stateNames[this.state]; }
}
