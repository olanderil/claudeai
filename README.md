# Horizon 1917

**Eight fronts. Open skies. No quarter given.**

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
  Three machines; land at your aerodrome and stop to refit. Set **Start: On the field**
  on the main menu to begin on the home runway instead, with a wingman lined up behind
  you and a minute before the first wave arrives.
- **Bombers** — the alarm bell goes with you on the runway. Bombers and their escort are
  on the way to your aerodrome, with their time of arrival counting down: open the
  throttle, get off the ground, climb to meet them while your wingmen roll after you and
  the field's guns open up, and keep the hangars standing. The raiders come in over the
  lowest ground — through the pass, in the Alps. Between raids, land to refuel and rearm;
  a gentle three-pointer is worth points. Each raid is heavier than the last, until the
  hangars burn or your machines run out.
- **Campaign** — eight sorties, each with its own front, hour and weather, briefed from
  whichever side you fly for: Dawn Patrol (Flanders), Balloon Busting (Somme), Escort
  (Isonzo), Trench Strafing (Verdun), Night Intercept — a Zeppelin under searchlights
  (Dolomites), Aerodrome Raid (Sinai), The Ace (Morlancourt Ridge) and The White War —
  guns on a glacier pass (Alps).
- **Watch** — the autopilot flies your machine through the fight (or the mission's
  objectives) while the cinematic director films it. Any stick input takes it back;
  slow it down to 0.25× from the bar.

**Opponents** — pick the enemy's level on the main menu (or in the Controls tab):
- **Recruit** — green pilots in smaller formations, softer hits and wilder flak. Your
  guns don't jam, rounds near the lead pip are nudged onto the target, and the machine
  won't pull into a stall. Half score.
- **Pilot** — the squadron average. The game as tuned.
- **Veteran** — bigger formations of pilots who check their tails, break into you and
  lead their shots. An ace from the second wave. Score ×1.5.
- **Ace** — every formation led by an ace, marksmen who never fly straight for long;
  flak finds your height fast. Double score.

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
- Eight fronts — Alps, Sinai, Isonzo, Gallipoli, Dolomites, Somme, Verdun, Flanders —
  with real relief: 3,000 m glaciated peaks around a high pass, dune seas under the
  Judaean hills, the Gallipoli ridges and sea cliffs, chalk downs cut by deep river
  valleys, the Messines ridge and Kemmel Hill. Trench systems, shell-cratered
  no-man's-land, ruined villages, grass aerodromes and streamed 3D trees, under the F18
  sim's sky, clouds, weather, seasons and time of day.
- A sparse HUD in one language: the enemy in signal cyan — a diamond in the air, a
  circle for a balloon, a square on the ground — with lock marks that close in as the
  target comes into range, a hairline to the lead pip, pointers on a ring around the
  sight for what's off screen, and an amber arc on that ring when someone is on your
  tail. Wingmen get an ivory chevron and a letter; objectives a brass caret.
- Procedural sound: rotary blip-switch, inline drone, Vickers and Spandau, flak, explosions
  arriving at the speed of sound, wires singing in a dive.

**Cameras** — chase, cockpit (hold **V** to padlock your target), target view, orbit,
the automatic cinematic director, the director with saved shots and a reel, and the free
camera. Screenshots and video recording from the corner tools.

The cinematic director tells a fight as a story in acts: the **sighting** (over the
shoulder on a long lens at enemy specks, then the enemy introduced), the **merge** (the
head-on joust, a tripod where they cross), the **duel** (cutting faster, on his six, down
the guns), the **reversal** when someone gets on your tail (the tail gunner's view, check
six), the **kill** (a kill cam or the wreck falling past a tripod, in slow motion for a
beat) and the **aftermath** (the camera lets you go while the wreck falls away, and the
cutting slows). It cuts on action — the guns opening up, hits going home, hits taken —
but never through a shot that hasn't landed yet, and never in a strobe. The title
screen's dogfight is filmed the same way.

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
