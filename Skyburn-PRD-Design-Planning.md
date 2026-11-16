# SKYBURN - PRD, Design, Planning
Original game. Vanilla ES Modules + WebGL2 + WASM. No framework.

## How to use with AI agents
- Give agent ONE phase at a time. Sequential, not parallel.
- Each phase: Goal, Files, Tasks, Acceptance Criteria, Handoff.
- If test fails, fix in same phase. Never carry failing test forward.

## 1. Vision
Arcade flight combat game you open in a URL and play instantly. Fast lock-on, Impact Cam, carrier Nemesis, formally verified mission logic.

## 2. Game Modes
| Mode | Description | Session |
|------|-------------|---------|
| Campaign | 14 missions, linear with Ace bonus | 10-15 min per mission |
| Instant Action | Pick jet, map, objective, difficulty | 5-10 min |
| Free Flight | No enemies, practice carrier landing | Unlimited |
| Time Trial | SR-71 recon, time attack | 3-6 min |

## Difficulty
| Difficulty | Damage / AI | Bonus | Checkpoints |
|------------|-------------|-------|-------------|
| Rookie | Aim assist high, enemy HP low | None shown | Unlimited respawn |
| Veteran | Normal damage, limited flares | 1 shown | Limited |
| Ace | Aggressive AI, 1-2 hits can kill | Up to 3 hidden, no HUD markers | No respawn, checkpoint at stage start |

## 3. Mission System - 5 Core Types
| Type | Description | Example |
|------|-------------|---------|
| Air-to-Air Interception | Dogfight, intercept bombers, shoot cruise missiles | Destroy 8x MiG-29s. Intercept 4x Tu-95 before Nemesis. Shoot 12x cruise missiles. |
| Ground Strike & Base Destruction | Bomb airfields, towers, bridges, radar | Destroy runway, 3x SAM sites, comms tower, bridge. |
| Naval Combat | Sink patrol boats, missile ships, destroyers | Sink 6x patrol boats. Sink destroyer with anti-ship missiles. |
| Escort & Base Defense | Protect friendlies | Escort C-130 30 km. Defend oil rig 3 waves. Defend Nemesis 180 sec. |
| Recon & Extraction | High-speed, low-altitude | Canyon run under 100m. Escort defector MiG. SR-71 Mach 3 photo run. |

Campaign: 1 First Flight, 2 Coastal Patrol, 3 Oil Rig Defense, 4 Island Strike, 5 Canyon Run, 6 Carrier Duel, 7 Siege of Nemesis, 8 Defector Escort, 9 Bridge Breaker, 10 Night Interception, 11 Blackbird Run SR-71, 12 Fortress Island, 13 Final Escort, 14 Nemesis Returns.

Mission 7 Example: Stage1 Air-to-Air intercept 2 bomber wings. Stage2 Naval sink 2 missile ships. Stage3 Defend Nemesis 180s. Stage4 Ground strike island airfield. Ace Bonus: sink both ships before they fire, save frigates, destroy airfield in one pass.

## 4. Aircraft Roster
| Region | Aircraft | Role |
|--------|----------|------|
| USA | F-14, F-15C/E/EX, F-16C, F/A-18C/E/F, F-22, F-35A/B/C | Air superiority / multirole / stealth |
| USA | F-4, F-5E, A-10C, AV-8B, F-117 | Legacy / attack / VTOL |
| USA | SR-71 Blackbird [Recon], U-2S [Recon] | Recon only, Mach 3+ dash, no dogfight |
| Russia | MiG-29, MiG-31, MiG-35, Su-27, Su-30SM, Su-33, Su-34, Su-35S, Su-57, Su-75, Su-25 | Interceptor / Flanker / stealth |
| China | J-10C, J-11B, J-15, J-16, J-20, J-35, JF-17, J-7 | Multirole / stealth / carrier |
| Europe | Eurofighter Typhoon, Rafale, Mirage 2000, Gripen, Tornado, Harrier GR.9 | Multirole / strike |
| Other | Tejas, KF-21, FA-50, F-2, F-CK-1, Kfir, A-4, MiG-21, MiG-23 | Regional |

Each jet in src/data/jets.json: thrust, drag, maxSpeed, turnRate, stallSpeed, radarRange, stealthFactor, hardpoints, gunDamage, flareCount. Balancing data-driven.

Weapons: Guns, IR missiles AIM-9/R-73, Radar AIM-120/R-77, Anti-ship Harpoon/Kh-35, Dumb bombs Mk-82, Guided GBU-12, Rockets Hydra, Flares/Chaff. Each: damage, range, speed, turnRate, lockTime, reloadTime, poolSize.

## 5. Controls
| Action | Mouse + Keyboard | Gamepad |
|--------|------------------|---------|
| Steer | Mouse position = heading | Left Stick |
| Throttle | W/S or Wheel | LB/RB |
| Guns | Left Click | RT/R2 |
| Lock/Fire Missile | Right Click Hold/Release | A/Cross |
| Afterburner | Space | Click Left Stick or LT+RT |
| Airbrake | Shift | LT/L2 |
| Flare | F | B/Circle |
| Switch Weapon | G | X/Square |
| Target Next | R/E | Y/Triangle |
| Camera/Map | C/M | Right Stick/Touchpad |

InputState: { pitch, roll, yaw, throttle, fireGun, fireMissile, flare }. Game logic never reads keyboard/gamepad directly. Deadzone 0.12.

## 6. Performance
| Metric | Target |
|--------|--------|
| Frame rate | 60 fps min at 1080p Medium |
| Frame budget | 16.6ms: Input 0.5, Physics 2, AI 2, Render 10, Audio 1 |
| Input latency | Under 50ms |
| Load | Under 2.5s, under 50 MB total |
| Memory | Under 300 MB JS heap, under 250 MB GPU |
| Soft-locks | Zero in 10000 fuzz runs |

## PART B - System Design
Architecture: index.html, src/main.js, src/core/loop.js (120Hz fixed), src/core/input.js, src/core/audio.js, src/render/renderer.js (WebGL2), src/physics/flight.js (WASM), src/ai/, src/world/terrain.js, src/mission/, src/data/jets.json, src/verify/. Loop: Input > Physics 120Hz > AI > Mission FSM > Render interpolation > Audio. No logic in render. No allocation in hot loop.

Computer Architecture: SoA + TypedArrays Float32Array, WASM hot paths, Web Workers for terrain/AI/audio, Object Pools missiles/bullets/particles, Data-Oriented Design, GPU instancing, texture atlases.

Graphics: Forward renderer PBR-ish, Terrain heightmap 1024x1024 4 LOD rings, Ocean plane normal-mapped waves, Sky gradient + sun + billboard clouds, GPU particles, smoke ribbon, afterburner shader, Frustum+BVH culling, Jet LODs High 8k / Med 3k / Low 800 + impostor, Chase cam + FOV kick + Impact Cam slow-mo 0.3s, Post single pass vignette + heat haze + tone mapping.

## Algorithms
| System | Algorithm | Why |
|--------|-----------|-----|
| Flight | 6DOF point mass + PID + lift/drag curves | Arcade stable verifiable |
| Collision | BVH + Sphere-Sphere + Spatial Hash Grid | O(n log n) |
| AI Targeting | A* nav graph + Steering Seek/Evade/Pursuit | Predictable cheap |
| Missile | Proportional Navigation + lead prediction | Realistic |
| Radar | Sweep + priority queue threat+angle | Fast switching |
| Terrain | Quadtree + Heightmap + Raycast DDA | Fast ground collision |
| Rendering | Instancing + Atlas + SoA | 1 draw for 100 missiles |
| Audio | Ring buffer + Object pool | No allocation |
| Missions | DAG of objectives | No cycles, always completable |

## FSMs
- Game: BOOT -> MENU -> HANGAR -> BRIEFING -> LOADING -> PLAYING -> PAUSED -> DEBRIEF -> GAMEOVER
- Player: PARKED -> TAXI -> TAKEOFF -> FLYING -> STALLED -> DAMAGED -> EJECTED -> DESTROYED. Weapons sub-FSM: IDLE -> LOCKING -> LOCKED -> FIRING -> RELOADING -> COOLDOWN
- Missile: SPAWN -> BOOST -> GUIDE -> PROXIMITY -> HIT/MISS/TIMEOUT -> EXPLODE -> RECYCLE. Invariant: GUIDE cannot go to SPAWN.
- Mission: NOT_STARTED -> STAGE_1 -> STAGE_2 -> ... -> SUCCESS/FAILED. Stage: ENTER -> ACTIVE -> CHECK -> COMPLETE/FAIL. Bonus: HIDDEN -> ACTIVE -> COMPLETED/FAILED, never back to HIDDEN.
- Enemy AI: PATROL -> ENGAGE -> EVADE -> ATTACK_RUN -> RTB -> DESTROYED.
One file per FSM. States enum, transition table, guard pure functions, onEnter/onExit.

## Formal Verification
- TLA+ for Mission, Missile, Game FSMs. Prove no deadlock, every ACTIVE eventually SUCCESS/FAILED.
- Invariants: health 0-100, fuel >=0, position finite, activeCount <= MAX.
- Property tests: 10000 random inputs, no NaN, no teleport, speed <= maxSpeed*1.05.
- Deterministic replay: fixed timestep + seeded RNG, same inputs = same outputs.
- Critical: No damage in MENU/PAUSED. Protected HP never <0 without FAILED. Missile cannot hit owner. Never spawn > pool. Input sampled once per tick. DAG acyclic. No NaN/Infinity.

## PART C - Phases
| Phase | Weeks | Deliverable |
|-------|-------|-------------|
| Phase 0 Foundation | 1-2 | One jet over ocean 60fps |
| Phase 1 Core Combat | 3-5 | Dogfight 4 AI, carrier landing |
| Phase 2 Missions | 6-8 | Mission FSM, 4 missions |
| Phase 3 Content | 9-11 | All jets, 14 missions, SR-71 |
| Phase 4 Verification | 12-14 | TLA+ proofs, 10k fuzz, 60fps lock |
| Phase 5 Ship | 15-16 | PWA, saves, beta |

### Phase 0 - Foundation
Goal: One jet over ocean 60fps. No enemies.
Files: index.html, src/main.js, src/core/loop.js, src/core/input.js, src/core/audio.js, src/render/renderer.js, src/render/shaders/basic.glsl.js, src/world/terrain.js, src/world/ocean.js, src/data/jets.json (F-16, MiG-29), src/verify/invariants.js, tests/loop.test.js, HANDOFF_Phase_0.md
Tasks: 0.1 Scaffold index.html ES Modules, build.py. 0.2 Loop fixed 120Hz, interpolation, max 5 steps, profiler FPS. 0.3 Input InputState, Keyboard+Mouse+Gamepad, deadzone 0.12. 0.4 Renderer raw WebGL2, shaders, camera, resize, DPR, dynamic resolution. 0.5 Terrain heightmap 256 procedural, 1 LOD, ocean shader waves, sky, sun, fog. 0.6 Jet placeholder procedural low-poly, 3 LODs, pitch/roll/throttle/speed/lift. 0.7 WASM stub vec3 math, JS fallback same API. 0.8 Invariants no NaN, speed capped, activeCount.
Acceptance: Ocean+terrain+jet 60fps 1080p. Responds mouse/keyboard AND gamepad <50ms. Physics 120Hz even if render 30fps. No GC in frame loop. dist <2MB. npm test green.

### Phase 1 - Core Combat
Goal: Dogfight 4 AI, guns+missiles, land on carrier. If not fun, stop and fix.
Files: src/physics/flight.js, src/ai/enemy.js, src/ai/fsm.js, src/combat/guns.js, src/combat/missiles.js, src/combat/lockon.js, src/combat/collision.js, src/world/carrier.js, src/render/particles.js, src/render/impactCam.js, src/core/audio.js, tests/combat.test.js, tests/fsm.test.js, HANDOFF_Phase_1.md
Tasks: 1.1 Flight 6DOF+PID WASM, lift/drag, stall, speed bleed, afterburner, airbrake, tuning in jets.json. 1.2 Entity SoA Float32Array max 512, pools bullets 500 missiles 64 particles 2000, no new in loop. 1.3 Guns hitscan+tracer 600RPM, falloff, spread, muzzle flash pooled. 1.4 Missiles Lock FSM IDLE->LOCKING 1.2s->LOCKED->FIRING, PN guidance, flares break lock. 1.5 Enemy AI PATROL->ENGAGE->EVADE->ATTACK_RUN->RTB, Seek/Pursuit/Evade, difficulty affects reaction. 1.6 Collision BVH+Sphere+Hash, ground crash, proximity fuse 8m, ship sphere. 1.7 Carrier Nemesis procedural, moving, deck collision, arrestor zone, landing speed <180 knots gear down, catapult. 1.8 Effects GPU particles, smoke ribbon, Impact Cam 0.3s slow-mo, WebAudio pooled engine/gun/missile/explosion/lock. 1.9 HUD v1 speed/alt/throttle/health/missiles/lock/crosshair/target/minimap.
Acceptance: Dogfight 4 AI 5min 60fps no crash. Missile hits 40-60% Veteran, flare breaks. Takeoff+land 3x in row. FSM tests missile cannot GUIDE->SPAWN. No soft-lock, Victory when all AI dead. Latency <50ms.

### Phase 2 - Missions
Goal: Mission FSM + DAG + Briefing/Debrief + 4 missions mixing 5 types.
Files: src/mission/mission.js, objectives.js, stages.js, spawner.js, src/ui/briefing.js, debrief.js, hud.js, src/data/missions.json M1-4, src/data/maps.json, tests/mission.test.js, HANDOFF_Phase_2.md
Tasks: 2.1 Mission FSM NOT_STARTED->STAGE_1...->SUCCESS/FAILED, stage ENTER->ACTIVE->CHECK->COMPLETE/FAIL, transition table, guards pure. 2.2 Objective DAG nodes+dependencies, validation no cycles, topo sort, reject cyclic at load. 2.3 Spawner waves by stage, positions from maps.json, cap entities, despawn far, protected assets HP+fail trigger. 2.4 5 Objective types: Air-to-Air kill+timer, Ground destroy list, Naval sink list, Escort protect+distance, Recon waypoint+alt+time. Each: type, targetIds, count, timer, failCondition. 2.5 Missions 1-4: M1 Training, M2 Coastal Patrol, M3 Oil Rig Defense, M4 Island Strike, JSON briefing/stages/objectives/spawn/win-lose/rewards. 2.6 UI MENU->HANGAR->BRIEFING->LOADING->PLAYING->DEBRIEF, save IndexedDB after debrief. 2.7 Checkpoints save at stage start, restore on death Rookie/Veteran, Ace restart mission. 2.8 HUD v2 objective tracker, stage banner, protected HP, cruise missile warning, distance.
Acceptance: All 4 missions win+lose work. Protected death triggers FAILED not hang. Cyclic JSON rejected. Checkpoint restores ammo/HP. Save persists after close. M3 Oil Rig: if ignore defense, rig dies <3min and fails.

### Phase 3 - Content
Goal: All jets, all 14 missions, SR-71, Impact Cam polish, audio, balancing. Split Agent A Jets, Agent B Missions/Maps, do not edit same files.
Files: src/data/jets.json full 40+, weapons.json, missions.json full 14, maps.json 6 maps, src/render/models.js, src/audio/music.js, src/ui/hangar.js, HANDOFF_Phase_3.md
Tasks A: 3A.1 Jets data all jets, validate schema. 3A.2 Procedural kitbash shared fuselage/wings/tails/canopies, 3 LODs, atlas paint. 3A.3 Weapons data, balance F-22 stealth 0.15, Su-35 turn 1.2x, A-10 armor 2x, SR-71 3.3 Mach no missiles. 3A.4 Hangar UI grid, stats, loadout, compare, unlock credits.
Tasks B: 3B.1 Maps 6: Ocean/Carrier, Island Chain, Desert Canyon, Coastal City, Arctic, Night. 3B.2 Missions 5-14, include SR-71 M11 Mach 3 waypoint photos no dogfight time limit, Finale M14 all 5 types. 3B.3 Ace Bonus HIDDEN->ACTIVE->COMPLETED up to 3 per mission Ace, no HUD marker until completed, chime+debrief. 3B.4 Balancing Veteran 10-15min not 30min, no impossible. 3B.5 Audio music loop, radio chatter, TTS placeholder, volume sliders.
Acceptance: All 40+ jets selectable distinct. All 14 playable win/lose, Ace bonuses trigger. SR-71 finish <6min Mach 3 cannot dogfight. Bundle <50MB, 60fps M7. Balancing 60-80% completion Veteran.

### Phase 4 - Verification + Polish
Goal: Prove correct and fast. No new features except fixes.
Files: verify/mission.tla, missile.tla, game.tla, tests/property.test.js, tests/fuzz.js, src/verify/invariants.js, src/core/profiler.js, docs/VERIFICATION_REPORT.md, HANDOFF_Phase_4.md
Tasks: 4.1 TLA+ specs Mission/Missile/Game, TLC prove no deadlock, every ACTIVE eventually ends, missile always EXPLODE/RECYCLE. 4.2 Invariants dev health/fuel/finite/pool/DAG, strip prod. 4.3 Property 10000 random flight/missile/collision, no NaN, no teleport >500m/tick, speed <= max*1.05. 4.4 Fuzz 10000 runs 60s, no soft-lock/crash, deterministic replay 100 replays identical hash. 4.5 Perf lock profile M7/M11/dogfight, instancing/culling/LOD/dynamic resolution, auto quality if fps<50 for 5s lower to 0.8x then 0.6x. 4.6 Gamepad 3 pads Xbox/PS5/generic, deadzone/sensitivity/rumble/hot-plug/remap. 4.7 Accessibility colorblind HUD, subtitles, reduced motion, volume, pause, settings persist, overflow 720p and 4K.
Acceptance: TLC passes no deadlock. 10000 fuzz zero soft-lock/crash/NaN. Replay 100 identical hash. 60fps 95% frames M7. Gamepad 3 work remap persists. No new features.

### Phase 5 - Ship
Goal: Ship it. PWA, offline, saves, leaderboard optional, beta, final bundle.
Files: manifest.json, sw.js, src/core/save.js, src/core/leaderboard.js optional, docs/README.md, docs/PLAYER_GUIDE.md, HANDOFF_Phase_5.md
Tasks: 5.1 PWA manifest/icons/service worker offline, airplane mode still plays. 5.2 Save IndexedDB progress/unlocks/settings/high scores/checkpoint, export/import JSON, clear save. 5.3 Leaderboard optional Cloudflare/Firebase Time Trial, else local only, do not block ship. 5.4 Final build build.py dist minified JS/WASM/assets, size <50MB, Lighthouse >90. 5.5 Beta 5 players full campaign, fix P0/P1 only, Beta Report. 5.6 Docs README, PLAYER_GUIDE, VERIFICATION_REPORT link.
Acceptance: Offline after first visit. Save persists restart. Lighthouse >90 bundle <50MB. Beta 5 finish M1 no P0. Tag v1.0 release notes.

## Appendices
File Tree: index.html, manifest.json, sw.js, build.py, src/main.js, src/core/loop/input/audio/save/profiler, src/render/renderer/particles/impactCam/models, src/render/shaders, src/physics/flight.js, src/ai/enemy/fsm, src/combat/guns/missiles/lockon/collision, src/mission/mission/objectives/stages/spawner, src/world/terrain/ocean/carrier, src/ui/hangar/briefing/debrief/hud, src/data/jets/weapons/missions/maps, src/verify/invariants, verify/*.tla, tests/*.test.js, docs/*.md

Jet Schema: { id: f16c, name: F-16C Fighting Falcon, country: USA, tier: 2, thrust: 129000, drag: 0.021, maxSpeed: 2120, turnRate: 18.5, stallSpeed: 180, radarRange: 8000, stealthFactor: 0.65, hardpoints: 6, gunDamage: 12, flareCount: 60, price: 1200 }

Mission Schema: { id: m07, title: Siege of the Nemesis, map: ocean, briefing: Defend Nemesis..., stages: [ { id: s1, type: air_to_air, objectives: [{ type: kill, target: bomber, count: 4 }] }, { id: s2, type: naval, objectives: [{ type: sink, target: missile_ship, count: 2 }] } ], aceBonus: [{ id: b1, desc: Sink both ships before they fire, condition: no_missile_fired }] }

FSM Example Table:
| From | Event/Guard | To | Action |
|------|-------------|----|--------|
| IDLE | Target in range + Lock | LOCKING | Start timer beep |
| LOCKING | Timer complete | LOCKED | Solid tone HUD lock |
| LOCKING | Target lost / Flare | IDLE | Reset timer |
| LOCKED | Fire | FIRING | Spawn missile consume ammo |
| FIRING | Missile spawned | RELOADING | Cooldown 0.8s |
| RELOADING | Cooldown done | IDLE | Ready |

Handoff Template: HANDOFF_Phase_X.md must have 1 What built file list 2 How to run 3 Test output 4 FPS 5 Known issues severity 6 Next phase start 7 Screenshots/video.

Risks:
| Risk | Mitigation |
|------|------------|
| WebGL low-end | Dynamic resolution, auto quality, LOD, instancing |
| Gamepad variance | Remapping, deadzone calibration, keyboard fallback |
| Verification creep | Only verify FSMs+invariants not rendering |
| Content 40+ jets | Kitbash shared parts, generated LODs |
| Agent drift framework | Reject non-vanilla, CI checks forbidden imports |

End - Skyburn v2.0 - November 2026