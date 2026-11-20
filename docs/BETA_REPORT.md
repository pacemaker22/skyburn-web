# SKYBURN v1.0 - Beta Report (Task 5.5)

**Scope note (honesty first):** this build was produced and verified in a headless
development environment - **no human playtesters were available here**. The PRD beta
protocol ("5 players finish the full campaign; fix P0/P1 only") therefore cannot be
executed inside this environment. This report documents (a) the automated evidence that
substitutes for the machine-checkable parts of beta, (b) zero open P0/P1 from that
evidence, and (c) the exact protocol for running the human beta when testers exist.

## 1. Automated beta evidence (this environment)

| Check | Result |
|-------|--------|
| Full test suite (`npm test`) | **143/143 pass**, 0 fail, 0 skipped (node 22, 2.05 s) |
| Phase 4 fuzz (`npm run fuzz`: 10 000 runs, 100 replays) | zero soft-locks / crashes / NaN, 100/100 identical replay hashes (see VERIFICATION_REPORT.md) |
| TLA+ (Mission / Missile / Game) | TLC: no deadlock, every ACTIVE ends, missile always EXPLODE/RECYCLE |
| Ship build (`npm run build`) | OK - dist 0.34 MB (< 50 MB AC), forbidden-import scan clean |
| Minified dist behavior (`tests/_dist_check.mjs`) | all ok: loop 120 Hz, input, invariants, GLSL intact, save v2 + leaderboard, PWA artifacts |
| Ship bundle HTTP smoke | 200 OK: index.html, manifest.json, sw.js, icons, modules, data |
| PWA structure tests (`tests/pwa.test.js`) | manifest installable (192/512 + maskable PNGs), SW guards correct, index wiring present |
| Save/leaderboard tests | export -> clear -> import roundtrip, v1->v2 migration, corrupt-board tolerance |

## 2. Open defects

| Severity | Count | Items |
|----------|-------|-------|
| P0 (blocker) | **0** | - |
| P1 (major) | **0** | - |
| Low / accepted | see below | music is a single 8 s procedural loop by design; radio TTS voice varies by OS; service worker inactive on plain-http LAN IPs (no offline there, game unaffected); local leaderboards only (hosted backend explicitly out of scope per PRD 5.3) |

## 3. Human beta protocol (run when 5 testers are available)

1. Recruit 5 players: at least one keyboard+mouse only, one gamepad only, one on a
   low-end laptop (integrated GPU).
2. Each tester: fresh browser profile -> first visit -> go offline (airplane mode) ->
   reload -> confirm the game still boots and plays (AC: "offline after first visit").
3. Each tester plays the full campaign M1 -> M14 on Veteran. Minimum gate: everyone
   finishes M1 without a P0.
4. File every defect with: mission, stage, difficulty, input method, browser+OS,
   reproduction steps, severity (P0 crash/soft-lock/progress loss, P1 major gameplay
   or save defect, P2 polish).
5. Fix **P0/P1 only**; re-run `npm test` + `npm run fuzz` + `npm run build` after each
   fix; no new features during beta (PRD rule).
6. Append the signed-off results to this report and re-tag if any fix landed.
