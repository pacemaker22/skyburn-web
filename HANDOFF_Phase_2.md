# HANDOFF - Phase 2: Missions

Status: **PASS** - all Phase 2 acceptance criteria verified; `npm test` = **83/83 green**
(58 prior + 25 new mission-suite tests, counted 83 total), no hangs. Committed as
`c08a2d7` ("Phase 2: missions (Tasks 2.1-2.8)"), tagged `v0.3`.

## 1. What was built (file list)

| File | Purpose | Task |
|------|---------|------|
| `src/mission/mission.js` | Mission FSM (NOT_STARTED→STAGE_*→SUCCESS/FAILED, structurally validated), difficulty policy (Rookie ∞ / Veteran 3 / Ace 0 restores), `noteKill`/fail triggers, checkpoints, `results()`, START action deploys stage 0 | 2.1, 2.7 |
| `src/mission/objectives.js` | Objective DAG: topo sort, cyclic load rejection, 5 objective types (air/ground/naval/escort/recon), timer fails, `failEscortsOf` (no-hang guarantee), pure `formatObjectiveLine` | 2.2, 2.4 |
| `src/mission/stages.js` | Stage FSM (ENTER→ACTIVE→CHECK→COMPLETE/FAIL), one Stage per deployment (fresh DAG per restore) | 2.1 |
| `src/mission/spawner.js` | Waves-by-stage spawner: seeded zone placement, land/water snapping, protected rig, missile boats + cruise missiles (`cruiseWarn`), throttled far-despawn, `despawnAll`; `arm()` spawns due-at-0 waves synchronously | 2.3 |
| `src/ui/briefing.js` | Briefing overlay: mission title/intro/objectives/loadout, LAUNCH/BACK | 2.6 |
| `src/ui/debrief.js` | Debrief overlay: score/kills/time, CONTINUE (persists save) / RETRY | 2.6, 2.7 |
| `src/ui/hud.js` | MissionHud: objective tracker (hidden = `''`), stage banner, protected HP bar, blinking cruise-missile warning | 2.8 |
| `src/data/missions.json` | M1 Training, M2 Coastal Patrol, M3 Oil Rig Defense, M4 Island Strike | 2.5 |
| `src/data/maps.json` | ocean/coast/rig/island zone layouts (named zones + radii) | 2.5 |
| `src/core/save.js` | IndexedDB save (memory backend for tests): progress, unlock chain, results, checkpoints, `hasCheckpoint()` | 2.6 |
| `src/combat/entities.js` (exp.) | `ENT_TYPE.GROUND`, per-entity `variant` (boat 2 / rig 3 / SAM 4 / hangar 5 / radar 6), `freeSlotCount()` | 2.3 |
| `src/combat/missiles.js` (exp.) | `onExplode(targetId)` - fuse hits always damage the tracked target (big-target fix) | 2.3 |
| `src/render/renderer.js` (exp.) | `setShipMeshes`/`setGroundMesh`, procedural `buildShipLod`/`buildRigLod`/`buildGroundLod` | 2.3 |
| `src/main.js` (rewritten ~1390 ln) | `buildGameTable` Game FSM, boot/save/persist, `buildWorld()` factory (free-flight sandbox preserved), mission wiring + hooks, checkpoint snapshot/restore on death, mission-aware damage routing, MissionHud + minimap | all |
| `tests/mission.test.js` (~620 ln) | 25 tests: FSM tables, DAG validation, all 5 objective types, stage FSM, spawner, checkpoints + difficulty policy, save roundtrip, debrief results (data-driven), Game FSM chain, HUD formatter, determinism, boot smoke | AC |

## 2. How to run

```
npm test        # 83/83 green (node --expose-gc --test tests/)
npm start       # menu -> hangar -> briefing -> fly M1-M4; free flight still in sandbox
npm run build   # production dist/
```

## 3. Test output (pasted)

```
# tests 83
# pass 83
# fail 0
```

Highlights:
- Objective DAG: cyclic mission JSON rejected at load; topo order drives stage checks;
  escort objective never hangs when its protected asset dies (`failEscortsOf`).
- Checkpoints: stage-start snapshot restores exactly (ents/player/mission stage index);
  Ace bypasses restores (immediate fail), Veteran consumes 3.
- Debrief results computed from `missions.json` data (multiplier 2.0, M1 reward 200),
  not hardcoded - test recomputes expectations from the same JSON.
- Determinism: same seed → identical spawner placement and mission event sequence.
- Boot smoke: `buildWorld()` free-flight sandbox still boots headless (browser boot is
  `typeof document`-guarded).

## 4. FPS / performance numbers

Not re-measured in Phase 2: no hot-path changes (renderer only gained 3 static meshes;
sim additions are pooled). Frame budget re-verification is scheduled Phase 4 task 4.5.
Phase 1 numbers (60 fps dogfight, 0 GC steady-state) remain the baseline; mission-suite
GC-steady tests run under `--expose-gc` without growth.

## 5. Known issues (with severity)

| Sev | Issue |
|-----|-------|
| Med | Visuals are placeholder quality (planned): all vehicles are `pushBox` assemblies, single sun-lambert shader, heavy fog. Jet kitbash is Task 3A.2, maps 3B.1, shader polish rides along. |
| Med | No music/radio audio yet (Task 3B.5). SFX from Phase 1 only. |
| Low | Missile guidance still "PN-flavored" lead pursuit (carried from Phase 1). |
| Low | Menu/briefing/debrief screens are functional DOM, minimal styling; polish deferred to Phase 3 UI work. |
| Low | Cruise missiles detonate fuse-only on their tracked big target (rig radius 45 m > BLAST_RADIUS 30 m). Intended after the Phase 2 fix; splash still applies to small entities. |
| Low | `updateCarrierOps(sdt, input)` `input` param unused (kept for signature stability). |

## 6. Next phase starting point

Phase 3A (Jets + Hangar): expand `src/data/jets.json` from 2 → 40+ jets (schema in
PLAN.md Appendix + optional `armor`/`loadout`/`shape`/`paint`), create
`src/data/weapons.json`, kitbash jet meshes in new `src/render/models.js` (shared
fuselage/wings/tails/canopies, 3 LODs, per-shape paint), upgrade hangar to grid +
stats + loadout + compare + credit unlocks (save gains `credits` + owned-jet list).
Balance anchors: F-22 stealth 0.15, Su-35 turn 1.2x baseline, A-10 armor 2x,
SR-71 Mach 3.3 no missiles. `tests/math.test.js` asserts "exactly 2 jets" - update
when roster expands. Jet mesh is currently one shared LOD set (`renderer.setJetLods`);
kitbash should key per-shape LOD sets off `ents.variant`.

## 7. Screenshots / video

Not captured (headless environment; WebGL requires a browser). Manual check:
`npm start` → fly M3 rig defense (boats + cruise missiles + protected rig HP bar +
checkpoint restore on death) and M4 island strike (recon waypoints + ground units).
