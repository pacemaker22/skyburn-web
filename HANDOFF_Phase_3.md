# HANDOFF - Phase 3: Content

Status: **PASS** - all Phase 3 acceptance criteria verified; `npm test` = **108/108 green**
(94 prior + 14 new: 6 Ace Bonus + 4 audio/save + 4 content-integrity), no hangs. 3A was
committed as `2a5550a`; 3B committed as the "Phase 3B" commit, tagged `v0.4`.

## 1. What was built (file list)

Phase 3 was split A (Jets + Hangar, done in 3A) and B (Missions + Maps + Audio, done here).

| File | Purpose | Task |
|------|---------|------|
| `src/data/jets.json` (3A) | 42 jets, 10 countries, tiers 1-5, unique prices, optional `armor`/`loadout`/`shape`/`paint`; Appendix B values byte-identical for F-16C/MiG-29 | 3A.1 |
| `src/data/weapons.json` (3A) | 2 guns + 5 IR/radar missiles with per-jet loadouts | 3A.3 |
| `src/render/models.js` (3A) | Kitbash jet meshes: 7 shape families x 3 LODs, `shapeIndexFor()` mapping | 3A.2 |
| `src/ui/hangar.js` (3A, exp.) | Hangar grid/stats/loadout/compare + pure economy helpers; `creditsForRun` now pays 200/earned Ace Bonus (win) or 100/ace (loss) | 3A.4 + 3B.3 |
| `src/data/maps.json` (exp.) | **8 maps**: ocean, coast, rig, island (seeds added) + **desert, city, arctic, night** with per-map `seed` and `atmosphere` presets (fog/sun/zenith/horizon); ocean gained boat/CAP/recon zones for M9/M11, island gained taskforce/samRow2/wpI/capC for M14 | 3B.1 |
| `src/data/missions.json` (exp.) | **14 missions**: M5 Canyon Run, M6 Harbor Blitz, M7 Convoy Escort, M8 Night Insertion, M9 Task Force, M10 Iron Storm, M11 Oxcart (SR-71), M12 Fortress Coast, M13 Polar Stack, M14 Stormbreak finale; M1-M4 gained `aceBonus` and M4 now unlocks M5 (linear chain m1->...->m14) | 3B.2 + 3B.3 |
| `src/mission/ace.js` (new) | Ace Bonus FSM: ACTIVE -> COMPLETED/FAILED (monotonic, terminal `finish()`), 4 condition kinds (`no_missile_fired`, `no_damage_taken`, `under_time:<s>`, `min_kills:<n>`), parse-rejects unknown at load, `onAceBonus` completion hook, debrief `list()` | 3B.3 |
| `src/mission/mission.js` (exp.) | Ace set built only on Ace difficulty (`_makeAce`), event feeds `notePlayerMissileFired`/`notePlayerDamaged`, kill feed via `noteKill`, `_resolveAce` on SUCCESS/FAILED, rebuilt on `restartMission`; `results()` gains `aceBonuses`/`aceCount`; +300 base score per earned bonus | 3B.3 |
| `src/mission/spawner.js` (exp.) | Protected friendly `ship` assets (escort targets for M7/M12/M14) - same fail-trigger + cruise-target machinery as the rig | 3B.2 |
| `src/render/renderer.js` (exp.) | `setAtmosphere()` (per-map fog/sun/sky-gradient uniforms, sun normalized), re-callable `setTerrain`/`setOcean` that free old GPU buffers (per-map terrain rebuild) | 3B.1 |
| `src/render/shaders/basic.glsl.js` (exp.) | SKY_FS takes `uZenith`/`uHorizon` uniforms (was hardcoded) | 3B.1 |
| `src/audio/music.js` (new) | Procedural music loop (pentatonic bass + detuned pad, lookahead scheduler on the audio clock, zero audio assets), own volume under the shared master | 3B.5 |
| `src/core/audio.js` (exp.) | SFX bus (`sfx` GainNode) under master so SFX and MUSIC sliders are independent; `setVolumes()` (clamped, init-safe), `radio()` squawk + speechSynthesis TTS placeholder, `aceChime()` | 3B.5 + 3B.3 |
| `src/core/save.js` (exp.) | `settings` defaults `{ master, music, sfx }`; `mergeSave` deep-merges settings so old saves gain the sliders | 3B.5 |
| `src/main.js` (exp.) | Per-map terrain + atmosphere in `buildWorld`; radio chatter hook (throttled) + Ace banner/chime hook; player missile/damage ace feeds; menu volume sliders (persisted); `music.start()` on first input + PLAYING, `music.tick()` in the render path | 3B.1/3/5 |
| `src/ui/briefing.js` (exp.) | Meta shows recommended aircraft (M11 SR-71) + hidden Ace Bonus count | 3B.2/3 |
| `src/ui/debrief.js` (exp.) | "ACE BONUS n/3" note line with earned descriptions | 3B.3 |
| `index.html` (exp.) | Volume slider CSS (`.sb-vol*`) | 3B.5 |
| `tests/ace.test.js` (new) | 6 tests: condition parsing, FSM monotonicity/hooks/finish, Ace-only set, kill feed + failure sink + results payload, M11 recon success earns all 3 bonuses | 3B.3 |
| `tests/audio.test.js` (new) | 4 tests: headless volume plumbing/clamps, MusicSystem no-op, SFX-bus structural wiring (no voice bypasses sfx), settings defaults + merge | 3B.5 |
| `tests/content.test.js` (exp.) | +4 tests: 8-map integrity (seeds/atmosphere/every referenced zone exists), 14-mission chain + schema + M14 all-5-types, stage timer budgets (<= 1440 s, M11 <= 360 s), Ace-Bonus credits | 3B.1/2/4 |
| `tests/mission.test.js` (exp.) | Debrief score check now data-driven incl. the ace term (+300/earned bonus before the difficulty multiplier) | 3B.3 |

## 2. How to run

```
npm test        # 108/108 green (node --test; includes the minified-dist check)
npm start       # menu (volume sliders) -> hangar -> briefing -> fly M1-M14; free flight intact
npm run build   # dist/ = 0.30 MB (< 2 MB limit; < 50 MB acceptance bound)
```

Manual tour: launch M11 in an owned SR-71 (or buy it, 6000 cr) - five camera gates over the
ocean, 5.5-minute timer, nothing can catch you. M14 is the 4-stage finale (recon, escort +
naval, ground, 8-jet CAP sweep). Switch maps to feel desert haze / arctic glare / night.
Right of the difficulty row: MASTER / MUSIC / SFX sliders (persisted).

## 3. Test output (paste)

```
# tests 108
# pass 108
# fail 0
# duration_ms ~870
MINIFIED-DIST CHECKS: all ok
[build] total: 296507 bytes (0.30 MB)
[build] OK: dist/ under 2 MB limit
```

## 4. FPS / performance numbers

- Suite runtime ~0.9 s headless (node --expose-gc --test).
- Bundle 0.30 MB minified (acceptance: < 50 MB; project gate: < 2 MB) - audio added zero
  bytes (fully procedural), maps+missions +~25 KB raw.
- Per-frame audio cost: one `MusicSystem.tick()` (clock compare; at most two AudioParam
  automations), everything else event-driven pools. No render-path allocations added.
- `setAtmosphere`/`setTerrain` run once per world build (LOADING beat), never per frame.
- Real-GPU 60 fps on M7-class scenes must be eyeballed on the test machine (headless env
  renders via SwiftShader; the profiler HUD remains in place for that check).

## 5. Known issues (with severity)

| Sev | Issue |
|-----|-------|
| Med | Visual polish still rides ahead: atmosphere + per-map terrain landed, but entity specular/rim, tonemap and cloud billboards are deferred to Phase 4 (clouds were the one "rides along" item not pulled into 3B). |
| Low | Radio TTS is the intended placeholder (speechSynthesis, voice varies by OS). Squawk + stage banners always work. |
| Low | M11 `recommendedJet` is advisory (briefing banner); the hangar selection is still honored if the player insists. SR-71 is unarmed by design, so any jet can technically finish it - just slower. |
| Low | Music is a single 8 s ambient loop by design (original, procedural); layering/variation deferred to Phase 5 if wanted. |
| Low | Timer budgets are fail-ceilings (tested <= 1440 s); the "60-80% Veteran completion" acceptance remains a human-playtest metric - the data supports it but playtesting is out of scope for this environment. |
| Low | Menu sliders are re-created by `refreshMenu` (menu rebuilds on every change) - values persist, only an in-progress drag can be interrupted by a menu refresh (no gameplay impact). |

## 6. Next phase starting point

Phase 4 - Verification + Polish (no new features except fixes):
1. TLA+ specs (mission/missile/game) + TLC proofs (`verify/*.tla`).
2. `tests/property.test.js` + `tests/fuzz.js` (10k random flight/missile ticks: no NaN, no
   teleport > 500 m/tick, speed <= max*1.05); `src/verify/invariants.js` strip for prod.
3. Profiler pass (`src/core/profiler.js`), 60 fps lock on M7-class scenes, real-GPU check.
4. Graphics polish that rode out of 3B: cloud billboards, entity specular/rim + tonemap.
5. End Phase 4 with `HANDOFF_Phase_4.md` + tag (plan rule: no phase closes without both).

## 7. Screenshots / video

Not captured in this environment (headless). Visual verification route: `npm start` ->
menu -> M11 (arctic glare is M13; night is M8) and watch the desert/arctic/night atmosphere
presets, the Ace Bonus completion banners (fly clean), and the debrief "ACE BONUS n/3"
line. The profiler HUD (top-left) shows live FPS/frame ms for the 60 fps check.

