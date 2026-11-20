# SKYBURN - Player Guide (v1.0)

## 1. Install / play

1. Open the game URL in Chrome, Edge or Firefox (a WebGL2-capable desktop browser).
2. That first visit downloads the whole game. From then on it works **offline**
   (airplane mode included) - the service worker keeps every asset cached.
3. Optional: install it as an app. Chrome/Edge: the install icon in the address bar
   (or menu -> "Install SKYBURN"). It then runs fullscreen from its own window.
4. Progress, unlocks, settings and high scores are stored in the browser (IndexedDB)
   automatically after every mission and at every checkpoint.

Note: on plain `http://` over a LAN IP (not `localhost`) browsers refuse service workers -
the game still runs, just without offline caching. `https://` or `localhost` = full PWA.

## 2. Controls

### Keyboard + mouse

| Action | Input |
|--------|-------|
| Steer (pitch/roll) | Move the mouse |
| Throttle | `W` / `S` or mouse wheel |
| Afterburner | `Space` |
| Airbrake | `Shift` |
| Fire guns | Hold **Left mouse button** |
| Fire missile | Hold **Right mouse button** to lock, **release** to fire |
| Flares | `F` |
| Switch weapon | `G` |
| Target next / nearest | `R` / `E` |
| Camera / map | `C` / `M` |
| Resolution scale | `[` / `]` |
| Pause | `Esc` or `P` |

### Gamepad

| Action | Input |
|--------|-------|
| Steer | Left stick |
| Throttle | Left stick Y / triggers |
| Fire gun | RT |
| Fire missile | Hold `A` (Cross) to lock, release to fire |
| Afterburner | Click left stick (L3) or LT+RT |
| Airbrake | LT / L2 |
| Flare | `B` (Circle) |
| Switch weapon | `X` (Square) |
| Target next | `Y` (Triangle) |
| Camera / map | Right stick / touchpad |

Remap face buttons, deadzone and sensitivity in MENU -> gamepad row (persists).
Three pad types supported (Xbox / PS / generic), hot-plug anytime, rumble on hits.

## 3. Game flow

MENU -> HANGAR -> BRIEFING -> LOADING -> PLAYING (Esc = PAUSED) -> DEBRIEF.

- **Difficulty** (menu): ROOKIE = unlimited checkpoint restores, VETERAN = 3,
  ACE = no respawn. Ace runs can earn up to 3 hidden **Ace Bonus** objectives per
  mission - they never show in the HUD; earned ones appear in the debrief.
- **Checkpoints** save at every stage start; dying restores the stage (Rookie/Veteran).
- **Hangar**: buy jets with credits earned from missions (score = credits). Stats bars,
  side-by-side compare, loadout labels. The SR-71 is the M11 recon aircraft - unarmed,
  Mach 3, survive the photo run.
- 14 missions unlock in a chain (win a mission to unlock the next), plus a free-flight
  sandbox (dogfight + carrier takeoff/landing: approach the deck slow, < 180 kn, gear
  down; hold `W` on deck to catapult).

## 4. Scores and saves

- Every finished run is recorded on the mission's **local top-5 board** (score first,
  faster time breaks ties). The menu shows your best per mission.
- **EXPORT SAVE** writes `skyburn-save.json` (human-readable). **IMPORT SAVE** restores
  a file (partial/corrupt files are repaired field-by-field; garbage is rejected).
  **CLEAR SAVE** wipes everything after a confirmation click.
- Settings (volumes, colorblind HUD palette, subtitles, reduced motion, auto quality,
  gamepad) persist in the same save.

## 5. Troubleshooting

| Problem | Fix |
|---------|-----|
| Black screen / "WebGL2" error | Update the browser / enable hardware acceleration |
| Low FPS | The auto-quality governor drops render scale automatically; force lower with `[` |
| No sound until first input | Intended: browsers require a click/key before audio starts |
| Lost progress | Do not use private/incognito windows; use EXPORT SAVE as backup |
| Gamepad not detected | Press a button while the game has focus; re-map in the menu |

Radio chatter uses the browser speech synthesis where available (placeholder; the squawk
and banner systems always work). Music is one procedural ambient loop by design.
