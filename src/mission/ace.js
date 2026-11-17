// Skyburn Phase 3B - Ace Bonus FSM (Task 3B.3): "HIDDEN -> ACTIVE -> COMPLETED/FAILED,
// up to 3 per mission on Ace difficulty, no HUD marker until completed, chime + debrief."
// State arrays follow the objectives.js pattern: monotonic Uint8 writes, no code path ever
// writes an earlier state (structurally: ACTIVE is the entry state, COMPLETED/FAILED are
// terminal, finish() resolves at most once). Pure data/logic module: no DOM, no WebGL.
// Node-testable (tests/ace.test.js).

export const ACE_STATE = { HIDDEN: 0, ACTIVE: 1, COMPLETED: 2, FAILED: 3, COUNT: 4 };
export const ACE_STATE_NAMES = ['HIDDEN', 'ACTIVE', 'COMPLETED', 'FAILED'];

export const ACE_KIND = { NO_MISSILE: 0, NO_DAMAGE: 1, UNDER_TIME: 2, MIN_KILLS: 3, COUNT: 4 };
const KIND_NAMES = ['no_missile_fired', 'no_damage_taken', 'under_time', 'min_kills'];

// Condition strings from missions.json: 'no_missile_fired' | 'no_damage_taken' |
// 'under_time:<sec>' | 'min_kills:<n>'. Throws on unknown kinds and missing parameters
// (reject at load, mirroring the objective DAG's cyclic-dep rejection).
export function parseAceCondition(cond) {
  if (typeof cond !== 'string') throw new Error('ace: condition must be a string');
  const i = cond.indexOf(':');
  const name = i < 0 ? cond : cond.slice(0, i);
  for (let k = 0; k < ACE_KIND.COUNT; k++) {
    if (KIND_NAMES[k] !== name) continue;
    const p = i < 0 ? NaN : Number(cond.slice(i + 1));
    if (k >= ACE_KIND.UNDER_TIME && !(isFinite(p) && p > 0)) {
      throw new Error('ace: condition "' + cond + '" needs a positive parameter');
    }
    return { kind: k, param: isFinite(p) ? p : 0 };
  }
  throw new Error('ace: unknown condition "' + cond + '"');
}

// One Ace Bonus set per mission run (Ace difficulty only - mission.js builds it). The
// engine feeds events; time-gated and cleanliness bonuses resolve at mission end.
export class AceBonusSet {
  // defs: missions.json aceBonus array (1-3 entries: { id, desc, condition }).
  // hooks: { onAceBonus({ id, desc, index }) } fires the moment a bonus COMPLETES
  // (banner + chime; per PRD there is NO HUD marker before completion).
  constructor(defs, hooks) {
    if (!Array.isArray(defs) || defs.length === 0 || defs.length > 3) {
      throw new Error('ace: 1-3 bonus defs required, got ' + (defs ? defs.length : 'none'));
    }
    this.hooks = hooks || {};
    this.n = defs.length;
    this.ids = [];
    this.descs = [];
    this.state = new Uint8Array(this.n);      // all ACTIVE (HIDDEN -> ACTIVE at mission start)
    this.kind = new Uint8Array(this.n);
    this.param = new Float32Array(this.n);
    this.clean = new Uint8Array(this.n);      // 1 while no violation observed
    for (let i = 0; i < this.n; i++) {
      const d = defs[i];
      if (!d || !d.id || !d.condition) throw new Error('ace: bonus needs id + condition');
      const c = parseAceCondition(d.condition);
      this.ids.push(d.id);
      this.descs.push(d.desc || d.id);
      this.kind[i] = c.kind;
      this.param[i] = c.param;
      this.clean[i] = 1;
      this.state[i] = ACE_STATE.ACTIVE; // HIDDEN -> ACTIVE at mission start
    }
    this.resolved = false;                    // finish() ran (terminal for the whole set)
  }

  // ---- event feed (mission.js; all no-ops once the set is resolved) ----
  noteMissileFired() { this._violate(ACE_KIND.NO_MISSILE); }

  noteDamageTaken() { this._violate(ACE_KIND.NO_DAMAGE); }

  // totalKills: the mission's kill counter after this kill.
  noteKill(totalKills) {
    if (this.resolved) return;
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== ACE_STATE.ACTIVE) continue;
      if (this.kind[i] === ACE_KIND.MIN_KILLS && totalKills >= this.param[i]) this._complete(i);
    }
  }

  // Mission end (SUCCESS or FAILED): resolve the remaining bonuses. Terminal FSM event -
  // every still-ACTIVE bonus ends COMPLETED or FAILED here; nothing stays pending.
  finish(timeSec, success) {
    if (this.resolved) return;
    this.resolved = true;
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== ACE_STATE.ACTIVE) continue;
      if (!success) { this.state[i] = ACE_STATE.FAILED; continue; }
      if (this.kind[i] === ACE_KIND.UNDER_TIME) {
        if (timeSec <= this.param[i]) this._complete(i);
        else this.state[i] = ACE_STATE.FAILED;
      } else if (this.clean[i]) {
        this._complete(i);
      } else {
        this.state[i] = ACE_STATE.FAILED;
      }
    }
  }

  _violate(kind) {
    if (this.resolved) return;
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] === ACE_STATE.ACTIVE && this.kind[i] === kind) {
        this.clean[i] = 0;
        this.state[i] = ACE_STATE.FAILED;
      }
    }
  }

  _complete(i) {
    this.state[i] = ACE_STATE.COMPLETED;
    if (this.hooks.onAceBonus) {
      this.hooks.onAceBonus({ id: this.ids[i], desc: this.descs[i], index: i });
    }
  }

  completedCount() {
    let n = 0;
    for (let i = 0; i < this.n; i++) if (this.state[i] === ACE_STATE.COMPLETED) n++;
    return n;
  }

  // Debrief payload (allocated once at debrief, never in the loop).
  list() {
    const out = [];
    for (let i = 0; i < this.n; i++) {
      out.push({
        id: this.ids[i], desc: this.descs[i],
        earned: this.state[i] === ACE_STATE.COMPLETED,
        stateName: ACE_STATE_NAMES[this.state[i]],
      });
    }
    return out;
  }
}
