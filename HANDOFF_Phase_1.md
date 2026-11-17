# HANDOFF - Phase 1: Core Combat

Status: **PASS** - all Phase 1 acceptance criteria verified; `npm test` = **58/58 green**
(24 Phase 0 + 34 Phase 1), suite runtime ~0.8 s, no hangs. The previously-reported
`node --test` hang is **root-caused and fixed** (see section 5a) - no workarounds remain.

## 1. What was built (file list)

| File | Purpose | Task |
|------|---------|------|
| `src/combat/entities.js` | SoA `WorldEntities` (max 512) + generic `Pool` (O(1) alloc/free/reset) | 1.2 |
| `src/combat/collision.js` | Spatial hash (4096 buckets, CELL_SIZE 128) with **multi-cell registration**, exact sphere/segment tests, `groundHitAt` | 1.6 |
| `src/combat/guns.js` | Hitscan + pooled tracers, 600 RPM, falloff 800→2400 m, spread, muzzle-flash hook | 1.3 |
| `src/combat/missiles.js` | Missile FSM (SPAWN→BOOST→GUIDE→PROXIMITY→HIT/MISS/TIMEOUT→EXPLODE→RECYCLE), PN-flavored lead guidance, 8 m fuse, flare decoy, 64-slot pool | 1.4, 1.6 |
| `src/combat/lockon.js` | Lock FSM exactly per the PRD example table (IDLE→LOCKING→LOCKED→FIRING→RELOADING), hold/release fire, flare break | 1.4 |
| `src/ai/enemy.js` | Enemy AI FSM (PATROL→ENGAGE→EVADE→ATTACK_RUN→RTB), Rookie/Veteran/Ace difficulty scaling | 1.5 |
| `src/ai/fsm.js` | Shared FSM engine + `FSMTable` with forbidden-transition validation | 1.4, 1.5 |
| `src/physics/flight.js` | 6DOF flight model: thrust/drag/lift equilibrium, stall (nose drop, sink, mushy controls), afterburner 1.05x, airbrake, PID rate control, teleport + interpolation | 1.1 |
| `src/world/carrier.js` | Patrol carrier: border turnaround, deck height query, arrestor zone, landing verdict, catapult pose | 1.7 |
| `src/render/particles.js` | GPU particle SoA pool (2000): SMOKE/FLASH/SPARK/DEBRIS/TRAIL, burstExplosion, emitTrail, staged VBO layout | 1.8 |
| `src/render/impactCam.js` | Impact Cam: cinematic cut to player missile impacts | 1.8 |
| `src/core/audio.js` (expanded) | Synthesized guns/locks/explosions/engines, pooled nodes | 1.9 |
| `src/main.js` | Full wiring: input → flight → AI → guns/missiles/lock → particles → renderer; blast damage; flares | all |
| `tests/combat.test.js`, `tests/fsm.test.js` | 19 + 15 tests via Node built-in runner | AC |

No frameworks added - vanilla ES Modules + Node test runner only.

## 2. How to run

```
npm test        # 58/58 green in ~0.8 s (--expose-gc enables the two allocation tests)
npm start       # http://localhost:8080 - fly, shoot, lock, sink the carrier
npm run build   # production dist/ (unchanged from Phase 0)
```

## 3. Test output (pasted)

```
> skyburn-web@1.0.0 test
> node --expose-gc --test tests/

# tests 58
# pass 58
# fail 0
# skipped 0
# duration_ms 816
```

Phase 1 highlights (all deterministic, no sleeps/timing flake):
- combat 12: PN guidance converges on a crossing 180 m/s target from 5 km; 8 m fuse
  detonates within FUSE_RANGE+radius of the live target (same-tick positions via onExplode).
- combat 13: flares seduce the seeker; while countermeasures burn inside DECOY_RANGE the
  fuse only arms on the jet, so the decoyed missile provably misses (seduction asserted via
  `decoyedTimer`).
- combat 14: missile pool cap 64, `-1` when exhausted, recycled slots reused after resolve.
- combat 18: deterministic Veteran band - 40 seeded engagements land in [50%, 80%] hit rate.
- combat 19: guns+missiles+particles+hash steady state allocates < 256 KB over 4x600 ticks
  (runs under `--expose-gc`).
- fsm 33: lock FSM full PRD flow incl. flare break and no-ammo hold.

## 4. AC coverage

| AC | Evidence |
|----|----------|
| Flight model replaces placeholder; stall + afterburner + airbrake | tests 8-11 (combat file), manual fly |
| Guns: 600 RPM hitscan, falloff, tracer pool | tests 6-7 |
| Missiles: lock 1.2 s, fly-by-wire chase, flare break, pool 64 | fsm tests 31-33, combat 12-14 |
| Enemy AI: 3 difficulties, jinks, gun+missile | fsm 34, combat 18 (Veteran band) |
| Carrier: patrol, deck/arrestor/landing, catapult | tests 15-16 |
| Particles: pool cap, bursts bounded, staging layout | test 17 |
| Zero allocation in hot paths | tests 19 (combat) + 46 (loop) |
| Collisions: sphere hash + DDA raycast + ground/sea | tests 3-5 |

## 5. Known issues (with severity)

| Severity | Issue |
|----------|-------|
| Info | `node --test` hang **resolved** (was a game-code bug, not the runner): see 5a. |
| Low | WASM vec3 still on the JS fallback (no clang on this machine) - carried from Phase 0. |
| Low | Missile guidance is "PN-flavored" lead pursuit (tGo = dist/closing), not full PN loop-nulling; converges reliably at Phase 1 engagement ranges. Revisit if ultra-agile jets arrive. |
| Low | Blast damage applies to every alive entity in radius except the shooter; friendly fire is ON by design (the PRD does not forbid it). |

### 5a. Root cause of the reported test-runner "hang" (fixed)

The hang was **not** the test runner. `CollisionWorld`'s `heads` bucket array was
`Int32Array`-zero-initialized, but `0` is a valid slot index and `next[0]` is also 0.
Any collision **query before the first `rebuild()`** walked a bucket chain
`0 -> 0 -> 0 -> ...` forever inside `while (s !== -1)`. The first `tryFire()` in the
allocation test (combat 19) fires before any rebuild, so:

- `node --expose-gc --test` (i.e. `npm test`): combat 19 runs -> child process spins -> hang.
- ad-hoc `node --test` without the flag: combat 19 skips -> suite green (the "flaky" pattern).

Fixes in `src/combat/collision.js`:
1. Constructor fills `heads` with `-1` (root cause; empty buckets are now truly empty).
2. Both chain walks are bounded (`chainGuard = next.length`) as defense in depth.
3. `segmentQuery` keeps its 512-cell DDA guard.

Also fixed while diagnosing (real bugs the investigation exposed):

| Bug | Fix |
|-----|-----|
| Missiles never returned to the pool: `RECYCLE` was skipped without firing `FREED`, so 4 lifecycle tests failed | `update()` fires `FREED` on RECYCLE slots -> SPAWN + `pool.free` |
| Guidance `closing` rate was sign-inverted -> `tGo` collapsed to `dist/60` -> missiles chased a phantom lead point 13 km away and always timed out (0% hit rate) | `closing = (v_missile - v_target) . losDir` (positive when closing); OUT_OF_CHASE miss detection polarity corrected too |
| While flares burned, brief non-decoyed windows let the fuse still kill the jet (flares = no reliable escape) | the seeker chases the flare source while it burns inside DECOY_RANGE; the fuse arms only while tracking the jet; seduction starts >= ~1.2 km out because the jet sits inside the flare sphere (deterministic miss) |
| Non-unit steer (flare offsets) fed the integrator -> `vel = steer * speed` speed explosion | steer normalized to unit length before integration |
| A ray skimming a cell boundary could miss a sphere poking into the visited cell (single-cell registration) | multi-cell registration: entities register in every overlapped cell (slot chains, <= 16 cells/entity); `querySphere` dedupes via generation stamp; `segmentQuery` is idempotent via `bestT`; ~32 KB slots, rebuilt in place per tick |
| `fsm.test.js` lock test float dust: 144 x (1/120) accumulates to 1.1999999999999997 < 1.2 -> re-lock one tick short; and after a flare break the same tick legally re-entered LOCKING (inRange still true) | `lockon.js` compares with a 1 us epsilon (exactly-1.2 s sim time locks); the flare-break tick drops `inRange` in the test (flare cloud hides the target) |
| `main.js` declared an unused `warnIds` buffer | removed |

## 6. Documented deviations from the PRD

1. **Hash grid instead of BVH** for the broad phase (Task 1.6 says "BVH+Sphere+Hash"):
   at Phase 1 scale (<= 512 dynamic entities, rebuilt per tick) a uniform hash is O(n)
   rebuild / O(cell) query with zero allocation; the BVH pays off only with mission-scale
   statics. The API is collision-agnostic (`rebuild/querySphere/segmentQuery`), so a BVH
   can replace the internals in a later phase without touching call sites.
2. **Multi-cell entity registration** (extra to the brief): entities register in every cell
   their x/z AABB overlaps. Without it, boundary-skimming rays miss spheres poking into the
   visited cell (found by a failing spread-shot test).
3. **Flight model uses equilibrium tuning** rather than full aero coefficient tables:
   thrust/drag/lift balance to the Appendix B cruise numbers; stall behavior (nose drop,
   sink, mushy controls with 0.4x authority) is explicit and test-covered. Exact CL/CD
   polars arrive with the Phase 3 damage/energy model if needed.
4. **Auto-gear**: landing gear is implied by altitude over the carrier deck (`deckAt` +
   arrestor zone) instead of a player gear toggle; the PRD controls table has no gear
   binding.
5. **Flares break lock hard while burning**: the decoyed seeker chases the flare source and
   the fuse disarms against the jet (PRD: "flares break lock"); re-acquisition happens
   ~0.5 s after the flares stop, rolled at DECOY_PROB = 2.2/s.

## 7. Next phase starting point

- Phase 2 brief (mission structure, WASM flight model port, carrier landing gameplay,
  damage model) per `PLAN.md`.
- Perf headroom is good: full suite < 1 s.
- Do NOT start Phase 2 until the user says "continue".
