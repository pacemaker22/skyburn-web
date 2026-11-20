# HANDOFF - Phase 5 Ship (Skyburn v1.0)

Phase 5 completes the PRD build plan. Everything below was executed against
`PLAN.md` (Tasks 5.1-5.6) on top of the tagged Phase 0-4 tree (v0.1-v0.4).

## 1. What was built

| File | Task | What |
|------|------|------|
| `manifest.json` (new) | 5.1 | Installable PWA manifest: fullscreen, landscape, theme `#0a0e14`, 5 icons (64/192/512 "any" + 192/512 "maskable") |
| `icons/*.png` (new) | 5.1 | 5 generated PNGs - ORIGINAL procedural art (navy roundel, cyan horizon, white delta-wing jet). Regenerate: `python tools/gen_icons.py` (pure stdlib, no copied assets) |
| `tools/gen_icons.py` (new) | 5.1 | Pure-Python (zlib+struct) icon rasterizer: supersampled shapes -> PNG, idempotent |
| `sw.js` (new) | 5.1 | Service worker: precache shell + stale-while-revalidate runtime cache (offline after first visit), network-first navigations with cached-index fallback, GET + same-origin guards, versioned cache namespace. `build.py` rewrites `dist/sw.js` with the FULL dist precache list + content-hashed cache name |
| `index.html` (exp.) | 5.1 | manifest link, theme-color, favicon/apple-touch icons, guarded SW registration (secure-context only), title -> "SKYBURN v1.0" |
| `src/core/save.js` (exp.) | 5.2 | Save **v2**: `highScores` field, v1 -> v2 migration on merge (any old shape normalized), `exportJSON()` / `importJSON()` (validate + repair), `SaveSystem.export()/import()` |
| `src/core/leaderboard.js` (new) | 5.3 | Local top-5 boards per mission: score DESC + time ASC tie-break, entry normalization, corruption-tolerant reads, `RemoteBackend` stub **hard-disabled** (PRD 5.3: "else local only, do not block ship") - no network calls anywhere |
| `src/main.js` (exp.) | 5.2/5.3 | Debrief records every run on the local board; menu mission buttons show `best <score>`; menu DATA row: EXPORT SAVE (downloads `skyburn-save.json`), IMPORT SAVE (file picker -> validated import -> clean reload), CLEAR SAVE (two-step confirm -> wipe -> reload) |
| `build.py` (exp.) | 5.4 | Copies manifest + icons into dist, emits `dist/sw.js` (full precache list, SHA-1-hashed cache namespace), reports the 50 MB Phase 5 size gate on top of the Phase 0 2 MB gate |
| `tests/pwa.test.js` (new) | 5.1 | Manifest installability, real PNG signatures, SW lifecycle/guards, index wiring |
| `tests/save.test.js` (new) | 5.2 | v2 defaults, v1 migration, malformed-board repair, export/import validation + roundtrip, clear |
| `tests/leaderboard.test.js` (new) | 5.3 | Rank/eviction, tie-breaks, corrupt tolerance, disabled remote contract |
| `tests/_dist_check.mjs` (exp.) | 5.4 | dist manifest/icons/sw (hashed cache + full precache), minified save + leaderboard behavior |
| `docs/README.md` (new) | 5.6 | Project overview, quick start, repo map, doc index |
| `docs/PLAYER_GUIDE.md` (new) | 5.6 | Install/offline, full keyboard+gamepad controls, difficulties/checkpoints/hangar, saves, troubleshooting |
| `docs/BETA_REPORT.md` (new) | 5.5 | Automated beta evidence, zero open P0/P1, human-beta protocol |
| `HANDOFF_Phase_5.md` (new) | - | This file |
| `PLAN.md` (exp.) | - | Execution status: Phases 3B/4/5 checked |

Not built (by PRD design): hosted leaderboard backend (optional task 5.3, local-only
shipped instead), real-device Lighthouse run (see 4. below).

## 2. How to run

```bash
npm test                 # 143/143 green
npm run build            # python build.py -> dist/ (0.34 MB)
node tests/_dist_check.mjs   # minified dist behavior + PWA artifacts
npm start                # dev: raw sources at http://localhost:8080
python -m http.server 8080 --directory dist   # ship bundle
```

Offline check (AC "offline after first visit"): serve `dist/` over http://localhost,
load the page once, DevTools -> Network -> Offline (or airplane mode), reload - the
game boots and plays from the service-worker cache. SW requires a secure context
(https / localhost); on plain-http LAN IPs the game still runs, just without caching.

## 3. Test output

```
TAP version 13
# tests 143
# pass 143
# fail 0
# cancelled 0
# skipped 0
EXIT:0
```

New in Phase 5: save v2 (6), leaderboard (5), PWA (4) = 15 tests added, none of the
128 pre-existing tests touched or weakened.

```
[build] total: 339375 bytes (0.34 MB)
[build] OK: dist/ under 2 MB limit
[build] Phase 5 AC: dist 0.34 MB < 50 MB ship limit
MINIFIED-DIST CHECKS: all ok
```

Ship-bundle HTTP smoke: 200 OK for index.html, manifest.json, sw.js, icons/icon-192.png,
src/main.js, src/data/jets.json. `dist/sw.js` carries `VERSION = 'v1-5946446c'` and a
36-entry precache list.

## 4. FPS / performance

No rendering hardware in this environment (headless), so Phase 5 ran no new frame-time
measurement - **and added none to the frame loop**: the service worker only runs on
lifecycle/fetch events; leaderboard writes happen once per debrief; menu DATA buttons
are event-driven. The Phase 4 performance lock stands as the ship reference: 60 fps,
95% of frames on the M7/dogfight profiles (see `docs/VERIFICATION_REPORT.md`), auto
quality governor (0.8x -> 0.6x) if fps < 50 for 5 s. The Phase 5 AC "Lighthouse > 90"
needs a real browser run; the structural prerequisites are verified by tests (manifest
installability, icon sizes, SW guards, single-page shell, no render-blocking resources
beyond the module entry, dist 0.34 MB).

## 5. Known issues (severity)

| Sev | Issue |
|-----|-------|
| Low | Music is a single 8 s procedural ambient loop by design (layering deferred from Phase 3B; not a Phase 5 task) |
| Low | Radio TTS voice varies by OS (speechSynthesis placeholder); squawk + banners always work |
| Low | Service worker is inactive on plain-http LAN IPs (browser secure-context rule): game runs, offline caching does not. https/localhost unaffected |
| Low | Leaderboards are local-only by PRD choice; `RemoteBackend` stub throws if ever called (hard-off) |
| Low | IMPORT SAVE performs a clean `location.reload()` after import - intended (boot() re-merges all systems from the new save) |
| Low | Human beta (5 testers, full campaign) not executable in this environment - protocol documented in docs/BETA_REPORT.md; automated evidence shows zero open P0/P1 |
| Low | "Lighthouse > 90" requires a real-browser audit; structural prerequisites verified by tests |

## 6. Next phase / post-ship

The PRD phase list ends here (Phase 5 = ship, tag v1.0). Post-ship backlog, in PRD
order of preference:

1. Run the human beta per `docs/BETA_REPORT.md` section 3; fix P0/P1 only.
2. Real-device Lighthouse audit (target > 90) + first mobile-ish fullscreen sanity pass.
3. Optional task 5.3 completion: Cloudflare Worker + KV Time-Trial leaderboard behind
   `RemoteBackend` (feature-detected, offline-safe) - the local boards already match
   its entry shape.
4. Release channel hygiene: cache-busting on data JSON edits is automatic via the
   hashed SW namespace; remember `npm run build` before every deploy.

## 7. Release notes - v1.0 (tag `v1.0`)

SKYBURN 1.0 - the full PRD campaign ships: 14 missions + free flight, 42 jets,
Ace Bonuses, carrier ops, verified physics/AI (TLA+, 10k fuzz, deterministic replay),
60 fps performance lock, installable offline PWA, IndexedDB saves with
export/import/clear, local high-score boards, full player + dev documentation.

- PWA: installable (any + maskable icons), offline after first visit, per-build
  hashed service-worker cache namespaces (no stale deploys).
- Saves: v2 format (auto-migrates v1), human-readable export, repaired imports,
  confirmed wipe.
- Leaderboards: local top-5 per mission (score desc, time tiebreak); best shown in
  the mission menu; hosted backend intentionally not shipped (PRD 5.3).
- Docs: README, PLAYER_GUIDE, BETA_REPORT, VERIFICATION_REPORT (Phase 4), handoffs
  for all six phases.

