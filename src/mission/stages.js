// Skyburn Phase 2 - Stage FSM (Task 2.1): "stage ENTER->ACTIVE->CHECK->COMPLETE/FAIL,
// transition table, guards pure". Built on the shared numeric FSM engine (src/ai/fsm.js).
// One Stage instance per mission stage; the stage owns that stage's objective DAG.
// The mission (mission.js) orchestrates: begin() deploys the stage (spawner + checkpoint),
// tick() evaluates the DAG and fires the transition events.

import { FSMTable, FSM } from '../ai/fsm.js';
import { ObjectiveDag } from './objectives.js';

export const STAGE_STATE = { ENTER: 0, ACTIVE: 1, CHECK: 2, COMPLETE: 3, FAIL: 4, COUNT: 5 };
export const STAGE_STATE_NAMES = ['ENTER', 'ACTIVE', 'CHECK', 'COMPLETE', 'FAIL'];

export const STAGE_EVENT = {
  DEPLOYED: 0,          // ENTER -> ACTIVE   (waves armed + objectives activated)
  OBJECTIVES_DONE: 1,   // ACTIVE -> CHECK   (pure guard upstream: dag.allCompleted())
  OBJECTIVE_FAILED: 2,  // ACTIVE -> FAIL    (any objective FAILED or protected destroyed)
  VERIFIED_OK: 3,       // CHECK -> COMPLETE (guard: dag.allCompleted())
  VERIFIED_BAD: 4,      // CHECK -> FAIL     (guard: dag.anyFailed())
  COUNT: 5,
};
export const STAGE_EVENT_NAMES =
  ['DEPLOYED', 'OBJECTIVES_DONE', 'OBJECTIVE_FAILED', 'VERIFIED_OK', 'VERIFIED_BAD'];

// Pure guards (PRD: "guards pure"). ctx = { dag }.
function guardAllComplete(ctx) { return ctx.dag.allCompleted(); }
function guardAnyFailed(ctx) { return ctx.dag.anyFailed(); }
function pureTrue() { return true; }

// One shared, immutable transition table (valid: no duplicate (from,event) pairs).
export function buildStageTable() {
  const S = STAGE_STATE, E = STAGE_EVENT;
  const t = new FSMTable(S.COUNT, E.COUNT, STAGE_STATE_NAMES, STAGE_EVENT_NAMES);
  t.add(S.ENTER, E.DEPLOYED, S.ACTIVE, pureTrue, null);
  t.add(S.ACTIVE, E.OBJECTIVES_DONE, S.CHECK, guardAllComplete, null);
  t.add(S.ACTIVE, E.OBJECTIVE_FAILED, S.FAIL, pureTrue, null);
  t.add(S.CHECK, E.VERIFIED_OK, S.COMPLETE, guardAllComplete, null);
  t.add(S.CHECK, E.VERIFIED_BAD, S.FAIL, guardAnyFailed, null);
  return t;
}

let _sharedTable = null;
export function sharedStageTable() {
  if (!_sharedTable) _sharedTable = buildStageTable();
  return _sharedTable;
}

export class Stage {
  // def: one missions.json stage { id, type, waves[], objectives[] }. map: maps.json entry.
  constructor(def, map) {
    this.def = def;
    this.id = def.id;
    this.map = map;
    this.dag = new ObjectiveDag(def.objectives, map);
    this.ctx = { dag: this.dag };
    this.fsm = new FSM(sharedStageTable(), STAGE_STATE.ENTER, this.ctx);
  }

  // Deploy: arm the spawner with this stage's waves, activate root objectives, open the FSM.
  begin(spawner, seed) {
    spawner.arm(this.def, seed, this.map);
    this.dag.activateRoots();
    this.fsm.fire(STAGE_EVENT.DEPLOYED, this.ctx);
  }

  // One physics tick. env = { px, py, pz, groupAlive(name) } for the DAG evaluation.
  // Returns the current stage state.
  tick(dt, env) {
    const S = STAGE_STATE, E = STAGE_EVENT;
    const st = this.fsm.state;
    if (st === S.ACTIVE) {
      this.dag.activateReady();
      this.dag.tick(dt, env);
      if (this.dag.anyFailed()) this.fsm.fire(E.OBJECTIVE_FAILED, this.ctx);
      else if (this.dag.allCompleted()) this.fsm.fire(E.OBJECTIVES_DONE, this.ctx);
    } else if (st === S.CHECK) {
      this.fsm.fire(this.dag.allCompleted() ? E.VERIFIED_OK : E.VERIFIED_BAD, this.ctx);
    }
    this.fsm.tick(dt);
    return this.fsm.state;
  }

  get state() { return this.fsm.state; }
  stateName() { return STAGE_STATE_NAMES[this.fsm.state]; }
  get complete() { return this.fsm.state === STAGE_STATE.COMPLETE; }
  get failed() { return this.fsm.state === STAGE_STATE.FAIL; }
}
