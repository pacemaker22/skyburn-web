// Skyburn Phase 2 - Objective DAG + the 5 objective types (Tasks 2.2 + 2.4).
// PRD: "Objective DAG nodes+dependencies, validation no cycles, topo sort, reject cyclic at
// load" and "5 Objective types: Air-to-Air kill+timer, Ground destroy list, Naval sink list,
// Escort protect+distance, Recon waypoint+alt+time. Each: type, targetIds, count, timer,
// failCondition."
// Objective states follow the PRD bonus-objective FSM: HIDDEN -> ACTIVE -> COMPLETED/FAILED,
// never back to HIDDEN (structurally: no code path writes an earlier state).
// Pure data/logic module: no DOM, no WebGL. Node-testable (tests/mission.test.js).

export const OBJ_STATE = { HIDDEN: 0, ACTIVE: 1, COMPLETED: 2, FAILED: 3, COUNT: 4 };
export const OBJ_STATE_NAMES = ['HIDDEN', 'ACTIVE', 'COMPLETED', 'FAILED'];

export const OBJ_TYPE = { A2A: 0, GROUND: 1, NAVAL: 2, ESCORT: 3, RECON: 4, COUNT: 5 };
export const OBJ_TYPE_NAMES = ['air_to_air', 'ground', 'naval', 'escort', 'recon'];

// Accepts the JSON spelling or the numeric id; throws on unknown types (reject at load).
export function objTypeFromName(name) {
  for (let i = 0; i < OBJ_TYPE.COUNT; i++) if (OBJ_TYPE_NAMES[i] === name) return i;
  if (typeof name === 'number' && name >= 0 && name < OBJ_TYPE.COUNT) return name;
  throw new Error('objective: unknown type "' + name + '"');
}

// ---- Kahn topological sort over { id, deps[] } nodes ----
// Returns ids in dependency order (deps first). Throws on unknown deps and on cycles
// (Task 2.2 "reject cyclic at load"). Deterministic: stable order for equal-rank nodes.
export function topoSort(defs) {
  const byId = new Map();
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    if (byId.has(d.id)) throw new Error('objective: duplicate id "' + d.id + '"');
    byId.set(d.id, i);
  }
  const indeg = new Int32Array(defs.length);
  const outs = [];
  for (let i = 0; i < defs.length; i++) outs.push([]);
  for (let i = 0; i < defs.length; i++) {
    const deps = defs[i].deps || [];
    for (let k = 0; k < deps.length; k++) {
      const j = byId.get(deps[k]);
      if (j === undefined) throw new Error('objective "' + defs[i].id +
        '" depends on unknown objective "' + deps[k] + '"');
      indeg[i]++;
      outs[j].push(i);
    }
  }
  const order = [];
  const queue = [];
  for (let i = 0; i < defs.length; i++) if (indeg[i] === 0) queue.push(i);
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    order.push(defs[i].id);
    const out = outs[i];
    for (let k = 0; k < out.length; k++) {
      if (--indeg[out[k]] === 0) queue.push(out[k]);
    }
  }
  if (order.length !== defs.length) {
    const cyclic = [];
    for (let i = 0; i < defs.length; i++) if (indeg[i] > 0) cyclic.push(defs[i].id);
    throw new Error('objective DAG: cyclic dependency involving: ' + cyclic.join(', '));
  }
  return order;
}

// Point lookup over a maps.json-style zone table: { points: { name: {x, z, y?, r?} } }.
// Used by recon objectives (waypoints). Throws on unknown names (reject at load).
export function mapPoint(map, name) {
  const p = map && map.points ? map.points[name] : undefined;
  if (!p) throw new Error('map: unknown point "' + name + '"');
  return p;
}

export const RECON_DEFAULT_RADIUS = 700;

// One objective DAG for one stage. All per-node runtime state lives in preallocated
// typed arrays (slot = topo position). Zero allocation after construction.
export class ObjectiveDag {
  // defs: validated JSON objectives of one stage. map: { id, points } for recon waypoints.
  constructor(defs, map) {
    if (!Array.isArray(defs) || defs.length === 0) {
      throw new Error('objective DAG: stage needs at least one objective');
    }
    this.map = map;
    this.defs = defs;
    this.order = topoSort(defs);                 // topo order (ids), deps first
    this.idx = new Map();                        // id -> slot
    for (let i = 0; i < this.order.length; i++) this.idx.set(this.order[i], i);
    const n = defs.length;
    this.n = n;
    this.type = new Uint8Array(n);
    this.state = new Uint8Array(n);              // OBJ_STATE, starts HIDDEN
    this.depsOf = new Array(n);                  // slot -> [slot]
    this.groupsOf = new Array(n);                // slot -> [groupName]
    this.need = new Int32Array(n);               // kills required (a2a/ground/naval)
    this.kills = new Int32Array(n);              // kills made among the groups
    this.timer = new Float32Array(n);            // fail countdown (0 = none)
    this.hold = new Float32Array(n);             // escort survive countdown (0 = none)
    this.wp = new Array(n);                      // recon waypoint names
    this.wpIndex = new Int32Array(n);            // recon progress (next waypoint)
    this.altMin = new Float32Array(n);           // recon minimum altitude
    this.radius = new Float32Array(n);           // recon waypoint radius
    this.failOnTimeout = new Uint8Array(n);      // failCondition === 'timeout'
    this.label = new Array(n);                   // HUD label

    for (let i = 0; i < n; i++) {
      const d = defs[i];
      this.type[i] = objTypeFromName(d.type);
      this.label[i] = d.label || OBJ_TYPE_NAMES[this.type[i]];
      const deps = d.deps || [];
      this.depsOf[i] = deps.map((id) => {
        const s = this.idx.get(id);
        if (s === undefined) throw new Error('objective "' + d.id + '": unknown dep "' + id + '"');
        return s;
      });
      const groups = d.groups || [];
      if ((this.type[i] === OBJ_TYPE.A2A || this.type[i] === OBJ_TYPE.GROUND ||
        this.type[i] === OBJ_TYPE.NAVAL) && groups.length === 0) {
        throw new Error('objective "' + d.id + '": type ' + OBJ_TYPE_NAMES[this.type[i]] +
          ' needs groups');
      }
      this.groupsOf[i] = groups;
      this.need[i] = d.count !== undefined ? d.count : 0;
      if (this.type[i] !== OBJ_TYPE.ESCORT && this.type[i] !== OBJ_TYPE.RECON &&
        this.need[i] <= 0) {
        throw new Error('objective "' + d.id + '": kill-type objectives need count > 0');
      }
      this.timer[i] = d.timer !== undefined ? d.timer : 0;
      this.failOnTimeout[i] =
        (d.failCondition === undefined || d.failCondition === 'timeout') ? 1 : 0;
      this.hold[i] = d.holdTime !== undefined ? d.holdTime : 0;
      if (this.type[i] === OBJ_TYPE.ESCORT && this.hold[i] <= 0) {
        throw new Error('objective "' + d.id + '": escort needs holdTime > 0');
      }
      if (this.type[i] === OBJ_TYPE.RECON) {
        const wps = d.waypoints || [];
        if (wps.length === 0) throw new Error('objective "' + d.id + '": recon needs waypoints');
        for (let w = 0; w < wps.length; w++) mapPoint(map, wps[w]); // throws when unknown
        this.wp[i] = wps;
        this.altMin[i] = d.altMin !== undefined ? d.altMin : 0;
        this.radius[i] = d.radius !== undefined ? d.radius : RECON_DEFAULT_RADIUS;
      } else if (d.waypoints) {
        throw new Error('objective "' + d.id + '": waypoints only valid on recon');
      }
    }
  }

  // HIDDEN -> ACTIVE when every dependency is COMPLETED (PRD: never back to HIDDEN).
  // Returns the number of objectives activated this call.
  activateReady() {
    let activated = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== OBJ_STATE.HIDDEN) continue;
      const deps = this.depsOf[i];
      let ready = true;
      for (let k = 0; k < deps.length; k++) {
        if (this.state[deps[k]] !== OBJ_STATE.COMPLETED) { ready = false; break; }
      }
      if (ready) { this.state[i] = OBJ_STATE.ACTIVE; activated++; }
    }
    return activated;
  }

  activateRoots() { return this.activateReady(); }

  // One physics tick. env = { px, py, pz, groupAlive(name) -> bool } (preallocated by caller).
  // Evaluates recon waypoints, escort hold/protection, and timeout fail conditions.
  tick(dt, env) {
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== OBJ_STATE.ACTIVE) continue;
      const t = this.type[i];
      if (t === OBJ_TYPE.RECON) {
        const name = this.wp[i][this.wpIndex[i]];
        const p = mapPoint(this.map, name);
        const dx = p.x - env.px, dz = p.z - env.pz;
        const dy = p.y !== undefined ? p.y - env.py : 0;
        if (dx * dx + dy * dy + dz * dz <= this.radius[i] * this.radius[i] &&
          env.py >= this.altMin[i]) {
          this.wpIndex[i]++;
          if (this.wpIndex[i] >= this.wp[i].length) this.state[i] = OBJ_STATE.COMPLETED;
        }
      } else if (t === OBJ_TYPE.ESCORT) {
        const groups = this.groupsOf[i];
        let alive = true;
        for (let g = 0; g < groups.length; g++) {
          if (!env.groupAlive(groups[g])) { alive = false; break; }
        }
        if (!alive) { this.state[i] = OBJ_STATE.FAILED; continue; }
        this.hold[i] -= dt;
        if (this.hold[i] <= 0) this.state[i] = OBJ_STATE.COMPLETED;
      }
      // shared fail timer (kill types + recon)
      if (this.state[i] === OBJ_STATE.ACTIVE && this.timer[i] > 0) {
        this.timer[i] -= dt;
        if (this.timer[i] <= 0 && this.failOnTimeout[i]) this.state[i] = OBJ_STATE.FAILED;
      }
    }
  }

  // A spawn-group entity died (kill or destruction). Advances a2a/ground/naval progress.
  // Returns the number of objectives completed by this kill.
  noteGroupDestroyed(groupName) {
    let completed = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== OBJ_STATE.ACTIVE) continue;
      const t = this.type[i];
      if (t !== OBJ_TYPE.A2A && t !== OBJ_TYPE.GROUND && t !== OBJ_TYPE.NAVAL) continue;
      const groups = this.groupsOf[i];
      let hit = false;
      for (let g = 0; g < groups.length; g++) if (groups[g] === groupName) { hit = true; break; }
      if (!hit) continue;
      this.kills[i]++;
      if (this.kills[i] >= this.need[i]) { this.state[i] = OBJ_STATE.COMPLETED; completed++; }
    }
    return completed;
  }

  // Called when a protected asset of an escort objective is destroyed -> objective FAILED
  // (the stage/mission treat this as the fail trigger; "protected death triggers FAILED").
  failEscortsOf(groupName) {
    let failed = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== OBJ_STATE.ACTIVE) continue;
      if (this.type[i] !== OBJ_TYPE.ESCORT) continue;
      const groups = this.groupsOf[i];
      for (let g = 0; g < groups.length; g++) {
        if (groups[g] === groupName) { this.state[i] = OBJ_STATE.FAILED; failed++; break; }
      }
    }
    return failed;
  }

  allCompleted() {
    for (let i = 0; i < this.n; i++) if (this.state[i] !== OBJ_STATE.COMPLETED) return false;
    return true;
  }

  anyFailed() {
    for (let i = 0; i < this.n; i++) if (this.state[i] === OBJ_STATE.FAILED) return true;
    return false;
  }

  completedCount() {
    let n = 0;
    for (let i = 0; i < this.n; i++) if (this.state[i] === OBJ_STATE.COMPLETED) n++;
    return n;
  }

  activeCount() {
    let n = 0;
    for (let i = 0; i < this.n; i++) if (this.state[i] === OBJ_STATE.ACTIVE) n++;
    return n;
  }

  stateName(i) { return OBJ_STATE_NAMES[this.state[i]]; }

  // Distance to the current recon waypoint (HUD); -1 when not an active recon objective.
  reconDistance(i, px, pz) {
    if (this.type[i] !== OBJ_TYPE.RECON || this.state[i] !== OBJ_STATE.ACTIVE) return -1;
    const name = this.wp[i][Math.min(this.wpIndex[i], this.wp[i].length - 1)];
    const p = mapPoint(this.map, name);
    const dx = p.x - px, dz = p.z - pz;
    return Math.sqrt(dx * dx + dz * dz);
  }

  reconProgress(i) {
    if (this.type[i] !== OBJ_TYPE.RECON) return [0, 0];
    return [Math.min(this.wpIndex[i], this.wp[i].length), this.wp[i].length];
  }
}

// ---- HUD text formatting (pure; exported for tests, reused by src/ui/hud.js) ----
// out: { text } mutated in place (no allocation when the caller reuses the object).
// extras: { px, pz, reconDist, protectedHpFrac } - preallocated by the HUD.
export function formatObjectiveLine(dag, i, out, extras) {
  const t = dag.type[i];
  const st = dag.state[i];
  let s = '';
  if (st === OBJ_STATE.HIDDEN) s = ''; // hidden objectives never reveal info (PRD AC)
  else if (st === OBJ_STATE.COMPLETED) s = '[done] ' + dag.label[i];
  else if (st === OBJ_STATE.FAILED) s = '[FAILED] ' + dag.label[i];
  else if (t === OBJ_TYPE.A2A || t === OBJ_TYPE.GROUND || t === OBJ_TYPE.NAVAL) {
    s = '[ ] ' + dag.label[i] + '  ' + Math.min(dag.kills[i], dag.need[i]) + '/' + dag.need[i];
  } else if (t === OBJ_TYPE.ESCORT) {
    const frac = extras && extras.protectedHpFrac !== undefined ? extras.protectedHpFrac : 1;
    s = '[ ] ' + dag.label[i] + ' hp ' + Math.round(frac * 100) + '%  hold ' +
      Math.max(0, Math.ceil(dag.hold[i])) + 's';
  } else if (t === OBJ_TYPE.RECON) {
    const prog = dag.reconProgress(i);
    const d = extras && extras.reconDist !== undefined ? extras.reconDist :
      dag.reconDistance(i, extras ? extras.px || 0 : 0, extras ? extras.pz || 0 : 0);
    s = '[ ] ' + dag.label[i] + '  wp ' + Math.min(prog[0] + 1, prog[1]) + '/' + prog[1] +
      (d >= 0 ? '  ' + Math.round(d) + ' m' : '');
  }
  out.text = s;
  return out;
}
