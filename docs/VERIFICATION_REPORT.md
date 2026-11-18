# Skyburn - Verification Report

## Phase 4 - Formal verification, fuzzing, hardening (final phase)

Date: 2026-11-18. Environment: Node 22 (Windows), JDK 23, tla2tools 1.8.0.

### Task 4.1 - TLA+ specs, model-checked with TLC

| Spec | Mirrors | TLC result |
|------|---------|------------|
| `verify/missile.tla` (+ `.cfg`) | `buildMissileTable()` in `src/combat/missiles.js` | **No error has been found** - 48 states, deadlock-free, `SpawnOnlyFromRecycle` (PRD: GUIDE never -> SPAWN), liveness `EventuallyExploded` |
| `verify/mission.tla` (+ `.cfg`) | `buildMissionTable()` in `src/mission/mission.js` | **No error has been found** - `TerminalSticky` (SUCCESS/FAILED never switch or resume a stage), `ActiveTerminates` liveness |
| `verify/game.tla` (+ `.cfg`) | `buildGameTable()` in `src/main.js` (incl. Phase 4 PAUSED) | **No error has been found** - `NoForbiddenJump` (PRD forbidden pairs), deadlock-free |

Run: `java -cp tla2tools.jar tlc2.TLC -deadlock verify\<module>.tla`
(tla2tools.jar is the 1.8.0 release; the 2.19 jar throws a parse-time NPE on Java 23
before reporting the real error.)

### Task 4.2 - Property-based test suite (`tests/property.test.js`)

Part of `npm test` (127/127 passing). Seeded (mulberry32) property tests:

- **missiles**: 10k random launches through the real FSM/pool - every missile ends
  EXPLODEd -> RECYCLEd, the pool fully drains, and a missile never damages its owner.
  **Found a real shipping bug**: `_ctxCache[i].slot` was hardcoded `0`, so every
  `onExplode`/`onFreed` routed through slot 0 - salvo explosions detonated at slot 0's
  position/owner and every recycle freed slot 0 (duplicate free-list entries; all other
  slots leaked after ~64 lifetime launches, starving the pool late-game). Fixed in
  `src/combat/missiles.js` (`slot: i`). Throughput in the probe went 135 -> 593 spawns
  with a clean 0-active drain.
- **registry**: 10k random spawn/kill/damage churn - caps, free-list integrity, no leaks.
- **collision hash**: 2000 random sphere queries on random layouts - valid, deduped, bounded.
- **FSM closure**: 1000 random DAGs + all 4 FSM tables - no duplicate transitions, no
  forbidden pair ever crossed, terminals behave per the PRD (debrief retry allowed).
- **economy/hangar/roster/weapons**: schema + invariants over full data files.

### Task 4.3 - Invariant audit

`src/verify/invariants.js` extended with the Phase 4 checks (missile pool integrity,
FSM closure) and wired into the existing dev-HUD violation counter. `npm test` includes
the audit tests.

### Task 4.4 - Fuzz gate (`tests/fuzz.js`)

`npm run fuzz` = `node tests/fuzz.js --runs 10000 --replay 100`:

- **runs: 10000, ticks: 73,436,463, failures: 0** (102 s, ~719k ticks/s) -
  zero crashes, zero NaN/Inf leaks, zero soft-locks (no mission hung past its caps).
- **replay determinism: 100 same-seed pairs, 0 mismatches** - every pair of identical
  seeded runs produced byte-identical state hashes (Task PRD "same input -> same output").

### Task 4.5 - Performance instrumentation + polish

- `src/core/profiler.js`: named CPU timers (EMA), counters, snapshot/line; wired around
  `world.step`/`world.render` and shown in the dev HUD (`profiler frame ... / step ...`).
- `src/core/quality.js`: auto quality governor - fps < 50 held for 5 s steps the render
  scale 1.0 -> 0.8 -> 0.6 (never lower, no flapping, disabled by the settings toggle).
- Deferred Phase 3B polish landed in `src/render/shaders/basic.glsl.js`:
  - JET_FS: Blinn-Phong sun highlight + subtle rim light + gentle filmic tonemap.
  - SKY_FS: procedural drifting cloud layer (3 octaves of value noise on a virtual
    plane, horizon-faded), bound via the new `uTime` uniform (renderer passes `timeSec`).

### Task 4.6 - Gamepad completeness

- Hot-plug: `attachPadHotPlug()` (connect/disconnect listeners, `onPadChange` callback,
  pad connect counts as first input and unlocks audio).
- Rumble: `input.rumble(strength, ms)` (dual-rumble actuator; on missile launch and
  player damage; no-op without a pad or when disabled).
- Settings (persisted in `saveData.settings.gamepad`, deep-merged onto defaults in
  `src/core/save.js`): deadzone (default 0.12), sensitivity (0.5-2), rumble toggle,
  per-action button remap with out-of-range garbage fallback to the standard map.
- Menu UI: RUMBLE toggle, DZ/SENS sliders, MISSILE/FLARE/WEAPON/TARGET remap cyclers.
- Tests: `tests/input.test.js` (settings, remap, hot-plug, rumble no-throw).

### Task 4.7 - Pause, subtitles, accessibility, resolution coverage

- **Pause**: Game FSM `PLAYING <-> PAUSED` (ESC/P). The loop never steps the sim in
  PAUSED (structural "no damage while paused"), renders the frozen world + overlay.
  Covered by the existing game-FSM tests + a TLA+ PAUSED model.
- **Subtitles**: `settings.subtitles` -> radio chatter shows a `#hud-subtitle` line.
- **Colorblind palettes**: `settings.colorblind` = normal | protan | deutan | tritan;
  objective/HP colors switch via `HUD_PALETTES` (blue/orange and teal/rose sets).
- **Reduced motion**: `settings.reducedMotion` disables the cruise-warning blink.
- **Auto quality toggle** persisted (`settings.autoQuality`).
- **720p/4K overflow**: `@media (max-height: 760px)` compacts panels; 4K query scales
  HUD/panel type up (`min-width: 2200px and min-height: 1150px`).

### Defects found and fixed during Phase 4

1. **missiles.js ctx-cache slot 0 bug** (critical, found by the property suite) - see 4.2.
2. **main.js boot TDZ crash**: `audio.setVolumes(saveData.settings)` ran before
   `const saveData = await save.load()` - temporal-dead-zone ReferenceError at boot.
   Persistence block moved above the audio/input wiring (which also needs the settings).
3. **save.js settings merge aliasing**: `out === base` + `Object.assign` copying
   `loaded.settings.gamepad` by reference made the nested-defaults merge a no-op
   (untouched defaults like deadzone/rumble silently dropped). Fixed with a pristine
   `defaultSaveData().settings` captured before the assign.

### Final gates

- `npm test`: **127/127 passing** (was 116; +11 Phase 4 tests).
- `npm run fuzz`: **10000 runs / 73.4M ticks / 0 failures / 100 replay pairs identical**.
- TLC (3 specs): **No error has been found** x3.
- `python build.py`: **OK** - dist/ 0.31 MB (< 2 MB limit), no forbidden imports.
- `node --check` on every touched module: clean.
