// Skyburn Phase 2 - Mission FSM (Task 2.1): "NOT_STARTED->STAGE_1...->SUCCESS/FAILED,
// transition table, guards pure" on the shared numeric FSM engine. The mission owns its
// ordered stages (Stage instances from stages.js), the protected-asset fail trigger
// (Task 2.3/AC: protected death -> FAILED, never a hang), checkpoint capture/restore
// (Task 2.7) and the debrief results (Task 2.6). One file per FSM; numeric states/events.

import { FSMTable, FSM } from '../ai/fsm.js';
import { Stage } from './stages.js';
import { OBJ_STATE } from './objectives.js';
import { AceBonusSet } from './ace.js';

export const MISSION_STATE = {
  NOT_STARTED: 0, STAGE_ACTIVE: 1, SUCCESS: 2, FAILED: 3, COUNT: 4,
};
export const MISSION_STATE_NAMES = ['NOT_STARTED', 'STAGE_ACTIVE', 'SUCCESS', 'FAILED'];

export const MISSION_EVENT = {
  START: 0,        // NOT_STARTED -> STAGE_ACTIVE (deploys stage 0)
  ADVANCE: 1,      // STAGE_ACTIVE -> STAGE_ACTIVE (guard: more stages; action: deploy next)
  FINISH: 2,       // STAGE_ACTIVE -> SUCCESS      (guard: last stage complete)
  STAGE_FAILED: 3, // STAGE_ACTIVE -> FAILED       (objective failed / protected destroyed)
  RESTART: 4,      // SUCCESS|FAILED -> NOT_STARTED (retry / checkpoint flows)
  COUNT: 5,
};
export const MISSION_EVENT_NAMES = ['START', 'ADVANCE', 'FINISH', 'STAGE_FAILED', 'RESTART'];

// Pure guards (PRD: "guards pure"). ctx = { mission }.
function guardHasNextStage(ctx) { return ctx.mission.stageIndex + 1 < ctx.mission.def.stages.length; }
function guardLastStageDone(ctx) { return !guardHasNextStage(ctx); }
function pureTrue() { return true; }

// One shared immutable transition table. PRD invariant enforced: SUCCESS and FAILED are
// terminal - no transition exists between them or back to STAGE_ACTIVE (validated below).
export function buildMissionTable() {
  const S = MISSION_STATE, E = MISSION_EVENT;
  const t = new FSMTable(S.COUNT, E.COUNT, MISSION_STATE_NAMES, MISSION_EVENT_NAMES);
  t.add(S.NOT_STARTED, E.START, S.STAGE_ACTIVE, pureTrue, (c) => {
    c.mission._beginStage(0, c.mission._pendingSnapshot);
  });
  t.add(S.STAGE_ACTIVE, E.ADVANCE, S.STAGE_ACTIVE, guardHasNextStage, (c) => {
    c.mission._beginStage(c.mission.stageIndex + 1, null);
  });
  t.add(S.STAGE_ACTIVE, E.FINISH, S.SUCCESS, guardLastStageDone, null);
  t.add(S.STAGE_ACTIVE, E.STAGE_FAILED, S.FAILED, pureTrue, null);
  t.add(S.SUCCESS, E.RESTART, S.NOT_STARTED, pureTrue, null);
  t.add(S.FAILED, E.RESTART, S.NOT_STARTED, pureTrue, null);
  t.validate([
    [S.SUCCESS, S.FAILED], [S.FAILED, S.SUCCESS],          // terminal states never switch
    [S.SUCCESS, S.STAGE_ACTIVE], [S.FAILED, S.STAGE_ACTIVE], // and never resume
  ]);
  return t;
}

let _sharedMissionTable = null;
function sharedMissionTable() {
  if (!_sharedMissionTable) _sharedMissionTable = buildMissionTable();
  return _sharedMissionTable;
}

// Difficulty policy for Task 2.7: Rookie = unlimited stage restores, Veteran = 3,
// Ace = 0 (death ends the mission; the debrief offers a full mission restart).
export const RESTORES_BY_DIFFICULTY = [Infinity, 3, 0];
const DIFF_MULT = [1.0, 1.5, 2.0];   // score multiplier per difficulty

export class Mission {
  // def: missions.json entry. map: matching maps.json entry. difficulty: 0|1|2.
  // deps: { ents, missiles, spawner, playerId, hooks { onStageBanner, onCheckpoint,
  //        onProtectedDestroyed, onMissionEvent(msg) } }
  constructor(def, map, difficulty, deps) {
    if (!def || !Array.isArray(def.stages) || def.stages.length === 0) {
      throw new Error('mission: def needs stages');
    }
    this.def = def;
    this.map = map;
    this.difficulty = difficulty;
    this.ents = deps.ents;
    this.spawner = deps.spawner;
    this.playerId = deps.playerId;
    this.hooks = deps.hooks || {};

    this.table = sharedMissionTable();
    this.ctx = { mission: this };
    this.fsm = new FSM(this.table, MISSION_STATE.NOT_STARTED, this.ctx);
    this.stageIndex = -1;
    this.stage = null;
    this.timeSec = 0;
    this.kills = 0;
    this.restores = 0;
    this.maxRestores = RESTORES_BY_DIFFICULTY[difficulty];
    this.checkpoint = null;
    this.protectedGroups = (def.assets || []).map((a) => a.group);
    this.ace = this._makeAce();          // Task 3B.3 (null unless Ace difficulty)
    this._aceResolved = false;

    // preallocated DAG env (groupAlive delegates to the spawner's group registry)
    const spawner = this.spawner;
    this._env = { px: 0, py: 0, pz: 0, groupAlive: (name) => spawner.groupAlive(name) };
  }

  get state() { return this.fsm.state; }
  stateName() { return MISSION_STATE_NAMES[this.fsm.state]; }
  get running() { return this.fsm.state === MISSION_STATE.STAGE_ACTIVE; }
  get stageDef() { return this.stageIndex >= 0 ? this.def.stages[this.stageIndex] : null; }

  // Start (or restart) from stage 0. playerSnapshot: optional checkpoint player payload to
  // restore (Task 2.7); handed back to the caller through onStageBanner -> main applies it.
  start(playerSnapshot) {
    if (this.fsm.state !== MISSION_STATE.NOT_STARTED) {
      this.fsm.fire(MISSION_EVENT.RESTART, this.ctx); // SUCCESS/FAILED -> NOT_STARTED
    }
    this._pendingSnapshot = playerSnapshot || null;
    this.spawner.spawnAssets(this.def.assets || [], this.map);
    this.fsm.fire(MISSION_EVENT.START, this.ctx);     // action deploys stage 0
  }

  // Deploy stage idx: fresh Stage instance (fresh DAG per Task 2.7 - checkpoint restores
  // restart the whole stage), spawner armed, checkpoint captured at stage start.
  _beginStage(idx, playerSnapshot) {
    this.stageIndex = idx;
    this.stage = new Stage(this.def.stages[idx], this.map);
    this.stage.begin(this.spawner, 0xA11CE + idx * 7919 + this.difficulty);
    this.captureCheckpoint(playerSnapshot);
    if (this.hooks.onStageBanner) {
      this.hooks.onStageBanner(idx, this.def.stages[idx], this.def.stages.length);
    }
    if (this.hooks.onMissionEvent) {
      this.hooks.onMissionEvent('stage ' + (idx + 1) + '/' + this.def.stages.length + ' started');
    }
  }

  // One physics tick (mission mode only; main calls this once per fixed step).
  // Drives the stage DAG and the spawner (waves, cruise missiles, despawn).
  tick(dt) {
    if (!this.running) return;
    this.timeSec += dt;
    const e = this.ents, pid = this.playerId;
    this._env.px = e.pos[pid * 3];
    this._env.py = e.pos[pid * 3 + 1];
    this._env.pz = e.pos[pid * 3 + 2];
    this.stage.tick(dt, this._env);
    this.spawner.tick(dt, {
      px: this._env.px, py: this._env.py, pz: this._env.pz,
      canDespawn: (groupName) => this._canDespawn(groupName),
    });

    if (this.stage.complete) {
      const more = this.stageIndex + 1 < this.def.stages.length;
      this.fsm.fire(more ? MISSION_EVENT.ADVANCE : MISSION_EVENT.FINISH, this.ctx);
      if (more) {
        if (this.hooks.onMissionEvent) this.hooks.onMissionEvent('stage complete');
      } else {
        this._resolveAce(true); // SUCCESS: complete under_time / cleanliness bonuses
      }
    } else if (this.stage.failed) {
      this.fsm.fire(MISSION_EVENT.STAGE_FAILED, this.ctx);
      this._resolveAce(false);  // FAILED: sink all still-ACTIVE bonuses
    }
  }

  // Despawn policy (Task 2.3 "despawn far"): far entities may only be freed when no ACTIVE
  // objective still needs their group (destroy targets never silently vanish).
  _canDespawn(groupName) {
    const dag = this.stage ? this.stage.dag : null;
    if (!dag) return true;
    for (let i = 0; i < dag.n; i++) {
      if (dag.state[i] !== OBJ_STATE.ACTIVE) continue;
      const groups = dag.groupsOf[i];
      for (let g = 0; g < groups.length; g++) if (groups[g] === groupName) return false;
    }
    return true;
  }

  // A world entity died. Routes to the stage DAG (kill progress) and fires the protected
  // fail trigger. Returns { group, protected } or null when the entity was not mission-owned.
  noteKill(victimId) {
    const g = this.spawner.noteKill(victimId);
    if (!g) return null;
    this.kills++;
    if (this.ace) this.ace.noteKill(this.kills);   // Ace bonus: min_kills conditions
    this.stage.dag.noteGroupDestroyed(g.name);
    if (g.protected) {
      this.stage.dag.failEscortsOf(g.name);
      if (this.hooks.onProtectedDestroyed) this.hooks.onProtectedDestroyed(g.name);
      // Fail trigger (AC: "Protected death triggers FAILED not hang"): immediately end the
      // stage and the mission instead of waiting for timers to run out.
      this._failStage();
    }
    return g;
  }

  // Force the mission to FAILED from any running state (fail triggers / Ace death).
  failNow(reason) {
    this._failStage();
    if (this.hooks.onMissionEvent && reason) this.hooks.onMissionEvent(reason);
  }

  _failStage() {
    if (this.running) {
      this.fsm.fire(MISSION_EVENT.STAGE_FAILED, this.ctx);
    }
  }

  // ---- Ace Bonus (Task 3B.3) ----
  // Event feeds called by main.js (player actions). No-ops on Rookie/Veteran (no set).
  notePlayerMissileFired() { if (this.ace) this.ace.noteMissileFired(); }
  notePlayerDamaged() { if (this.ace) this.ace.noteDamageTaken(); }

  // Ace difficulty only, and only when the mission defines bonuses. Hooks bubble the
  // completion event to main.js (chime + HUD banner) via deps.hooks.onAceBonus.
  _makeAce() {
    if (this.difficulty !== 2 || !Array.isArray(this.def.aceBonus) ||
      this.def.aceBonus.length === 0) return null;
    const self = this;
    return new AceBonusSet(this.def.aceBonus, {
      onAceBonus: (b) => { if (self.hooks.onAceBonus) self.hooks.onAceBonus(b); },
    });
  }

  // Resolve the set at mission end (terminal; idempotent). SUCCESS completes the
  // time/cleanliness bonuses, FAILED sinks them all.
  _resolveAce(success) {
    if (!this.ace || this._aceResolved) return;
    this._aceResolved = true;
    this.ace.finish(this.timeSec, success);
  }

  // ---- Checkpoints (Task 2.7): captured at every stage start ----
  captureCheckpoint(playerSnapshot) {
    let player = playerSnapshot;
    if (!player) {
      player = this.checkpoint ? this.checkpoint.player : this._snapshotFromEnts();
    }
    this.checkpoint = {
      missionId: this.def.id,
      stageIndex: this.stageIndex,
      difficulty: this.difficulty,
      timeSec: this.timeSec,
      player,
    };
    if (this.hooks.onCheckpoint) this.hooks.onCheckpoint(this.checkpoint);
  }

  // Fallback snapshot straight from the SoA registry (stage transitions mid-flight; the
  // throttle axis is not mirrored into ents, so it keeps a sane cruise value).
  _snapshotFromEnts() {
    const e = this.ents, id = this.playerId;
    return {
      x: e.pos[id * 3], y: e.pos[id * 3 + 1], z: e.pos[id * 3 + 2],
      yaw: e.rot[id * 3], pitch: e.rot[id * 3 + 1], roll: e.rot[id * 3 + 2],
      speed: e.speed[id], throttle: 0.8,
      hp: e.maxHealth[id], missiles: e.missilesLeft[id], flares: e.flareCount[id],
    };
  }

  // Player died with restores remaining (Rookie/Veteran): rebuild the CURRENT stage from its
  // start (checkpoint) state. Player flight state is re-applied by main from checkpoint.player.
  restoreStage() {
    if (this.maxRestores !== Infinity && this.restores >= this.maxRestores) return false;
    this.restores++;
    this.spawner.despawnAll();
    this.spawner.spawnAssets(this.def.assets || [], this.map); // protected assets reset too
    this._beginStage(this.stageIndex, this.checkpoint ? this.checkpoint.player : null);
    return true;
  }

  // Ace retry / debrief "restart mission": back to NOT_STARTED, everything respawned.
  restartMission() {
    this.spawner.despawnAll();
    this.timeSec = 0;
    this.kills = 0;
    this.restores = 0;
    this.ace = this._makeAce();     // bonuses re-earnable on a fresh attempt
    this._aceResolved = false;
    this.start(null);
  }

  // Debrief payload (Task 2.6). success comes from the mission FSM state.
  results() {
    const success = this.fsm.state === MISSION_STATE.SUCCESS;
    const mult = DIFF_MULT[this.difficulty];
    const aceCount = this.ace ? this.ace.completedCount() : 0;
    return {
      missionId: this.def.id,
      title: this.def.title,
      success,
      kills: this.kills,
      timeSec: Math.round(this.timeSec * 10) / 10,
      restores: this.restores,
      difficulty: this.difficulty,
      // Task 3B.3: each earned Ace Bonus adds 300 base score before the difficulty mult.
      score: Math.round((this.def.reward + this.kills * 25 + aceCount * 300) * mult),
      aceBonuses: this.ace ? this.ace.list() : [],
      aceCount,
    };
  }
}
