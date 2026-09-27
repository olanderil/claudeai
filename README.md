# Horizon 1917

**Seven fronts. Open skies. No quarter given.**

A First World War air-combat game in the browser. Fly a Sopwith Camel or SPAD S.XIII
for the Royal Flying Corps, or a Fokker Dr.I or Albatros D.V for the Luftstreitkräfte,
over procedurally generated Western Front battlefields — with the weather, time of day,
seasons and cinematic camera director of the Horizon F18 flight simulator it grew from.

Built with Three.js and TypeScript. **The shipped build is one self-contained HTML file**:
no server logic, no CDN, no asset files. Put it on any static host — or double-click it.

## Running it

```bash
npm install
npm run build      # → dist/index.html (~1.3 MB, everything inlined)
npm run dev        # development server with hot reload
```

Deploy by copying `dist/index.html` to any web server (or open it from disk). The only
network access is the optional internet radio in the corner tools.

Add `?quality=low|medium|high|ultra` to the URL to pick the graphics preset up front
(it can also be changed in the **Style** tab).

## What's in it

**Modes**
- **Quick Battle** — offensive patrol against endless, escalating waves of enemy scouts,
  with an ace leading from the third wave. Kite balloons over the enemy lines for the taking.
  Three machines; land at your aerodrome and stop to refit.
- **Campaign** — seven sorties, each with its own front, hour and weather, briefed from
  whichever side you fly for: Dawn Patrol (Flanders), Balloon Busting (Somme), Escort
  (Isonzo), Trench Strafing (Verdun), Night Intercept — a Zeppelin under searchlights
  (Dolomites), Aerodrome Raid (Sinai) and The Ace (Morlancourt Ridge).
- **Watch** — the autopilot flies your machine through the fight (or the mission's
  objectives) while the cinematic director films it. Any stick input takes it back;
  slow it down to 0.25× from the bar.

**The war**
- Six aircraft modelled and painted procedurally: Camel, SPAD, Dr.I, Albatros, DH.4
  two-seater and Gotha G.V bomber — period liveries (RFC roundels, French five-colour
  camouflage, Fokker streaking, printed lozenge fabric, the red triplane), fabric ribs,
  rotary engines that spin, prop blur, muzzle flash, rear gunners, visible damage.
- Biplane flight model: the nose follows the stick, hard pulls bleed speed, stalls drop
  a wing, and rotary engines add their gyroscopic pull (the Camel turns right fast, left slow).
- Synchronised machine guns that heat and jam, tracers, a real lead pip; flak ("Archie")
  that gets your range the longer you loiter over the lines — white bursts from Allied
  guns, black from German.
- Kite balloons that are winched down when attacked, a burning Zeppelin that breaks its
  back, hangars, AA guns, batteries, MG nests, lorries and dumps with wreck states; bombs.
- AI pilots that hunt, evade, extend, fly as your wingmen, escort, attack ground targets
  and fly bomber routes with gunners shooting back.
- Seven fronts — Flanders, Somme, Verdun, Isonzo, Dolomites, Gallipoli, Sinai — with
  trench systems, shell-cratered no-man's-land, ruined villages, grass aerodromes and
  streamed 3D trees, under the F18 sim's sky, clouds, weather, seasons and time of day.
- Procedural sound: rotary blip-switch, inline drone, Vickers and Spandau, flak, explosions
  arriving at the speed of sound, wires singing in a dive.

**Cameras** — chase, cockpit (hold **V** to padlock your target), target view, orbit,
the automatic cinematic director (with combat shots and kill cams), the director with
saved shots and a reel, and the free camera. Screenshots and video recording from the
corner tools.

## Controls

| Key | Action |
| --- | --- |
| `↑` / `↓` | Pitch — nose up / nose down |
| `←` / `→` | Roll left / right |
| `Q` / `E` | Rudder |
| `Shift` / `Ctrl` | Throttle up / down; `1`–`0` set it directly |
| `Space` / left mouse | Fire — short bursts, hot guns jam |
| `B` | Drop a bomb |
| `T` | Next target |
| `C` | Camera: chase, cockpit, target, orbit, cinematic, director, free |
| `V` | Hold to look at your target (cockpit) |
| `M` | Mouse as flight stick |
| `F` | Watch — hand the controls to the autopilot |
| `P` / `Esc` | Pause |
| `H` | Help |
| `O` | Style panel · `Y` time of day · `R` weather · `N` new front · `Tab` map |
| `W` / `S`, `A` / `D` | Stick-style pitch, and roll |

Gamepad: right stick flies, left stick throttle, right trigger fires, left trigger bombs,
X next target, Y camera, Start pause.

## Project layout

```
src/
  main.ts            wiring: loop, input, cameras, menus, panels, capture
  game/              Game (modes, player input, targeting, watch), Mode, QuickBattle, Campaign
  combat/            Plane (flight model), Brain (AI), Battle, Ballistics, Particles, Effects,
                     Targets, Airframes (+ airframes/), GroundModels (+ ground/), Types
  world/             World, Worlds (the fronts), Front, Terrain, Settlements, Vegetation, …
  camera/            CameraRig, Cinematic (the director), Subject
  audio/             Sfx (+ sfx/), Radio
  ui/                CombatHUD, Menus, Panel, Tips
  render/            PostFX, Quality
tools/               headless checks and model viewers
```

## Checks

```bash
npm run check:combat      # flight model performance, AI dogfight, bomber route, scramble
npm run check:combatcam   # target view and kill cam framing
npm run check:director    # the cinematic director
npm run check:freecam     # free camera
npm run check:orbit       # orbit camera
npm run check:sky         # sky stays finite under bloom
npm run check:daylight    # the day/night cycle
```

`tools/hangar.ts` and `tools/ground-viewer.ts` are standalone viewers for the aircraft
and ground models (bundle with esbuild, open from a one-line HTML page).

---

Design: [sometek.fi](https://sometek.fi). Built on the Horizon F18 flight simulator.
