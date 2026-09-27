# Horizon F18

**Fourteen worlds. Open skies. Endless ways to fly.**

A realistic 3D flight simulator in the browser — F/A-18-class fighter, six-degree-of-freedom
aerodynamics, procedural terrain. Built with Three.js and TypeScript.

**The shipped build is a single self-contained HTML file.** Double-click it; no server, no
install, no network. Three.js and all game code are inlined, and it works offline.

## Running it

Build the standalone file:

```bash
npm install && npm run build
```

That produces `dist/flight-sim.html` (~660 KB). Open it directly in any browser — it runs
from `file://`.

For development, with hot reload:

```bash
npm run dev
```

## Controls

| Key | Action |
| --- | --- |
| `←` / `→` | Turn left / right — hold longer to bank steeper and turn tighter |
| `↑` / `↓` | Pitch — nose up / nose down |
| `W` / `S` | Pitch, stick-style — push down / pull up |
| `A` / `D` | Same as left / right |
| `Q` / `E` | Rudder left / right |
| `Shift` / `Ctrl` | Throttle — past 90% lights the afterburner |
| `B` | Wheel brakes |
| `L` | Landing gear up / down |
| `G` | Flight assists on / off |
| `C` | Camera — chase / cockpit / orbit / cinematic / free / director |
| `M` | Mouse as flight stick |
| `Space` | Open / close the Style panel |
| `F` | Scenic flight — the autopilot takes off, tours the landscape and lands itself |
| `N` | New world — a fresh landscape from a new seed, without landing |
| `T` | Time of day — dawn, morning, noon, golden hour, dusk, blue hour |
| `R` | Weather — clear, hazy, overcast, rain, storm |
| `Backspace` | Reset to the runway |
| `P` | Pause |
| `H` | Show / hide every shortcut |

The two pitch bindings are deliberately opposite: the arrow keys are direct (press
up, the nose goes up) while `W`/`S` behave like a stick (push forward for nose down).

`N` regenerates the landscape underneath a flight in progress. Airborne, the aircraft keeps
its altitude, attitude and speed — the only thing that cannot be kept is being in clear air,
because the new height field is generated with no knowledge of where the aircraft happens to
be and a peak can come up through it. Anything left with less than 400 m underneath it is
lifted just clear of the new ground, which is a smaller lie than spawning inside a mountain.
On the ground there is no flight worth preserving, so it starts again on the new world's own
runway.

The World tab carries the same action as a pair — **New World** and **New World + Takeoff**,
differing only in whether you keep flying. Both leave the *landscape* alone and reseed
whatever is selected, because the selector that chooses it sits directly above them and a
button that overrode it would be fighting the user. `N` is the one that also picks a
different world: it is the "take me somewhere else entirely" action, and it has no selector
next to it to contradict.

The landscape selector preserves a flight too. It changes the scenery without rerolling it —
picking Fjords means you want to see fjords, not a different set of fjords each time you press
it. All four routes now go through one function, so none of them can forget to keep you in the
air; the selector used to drop you back on the runway because it was the one path that did its
own thing.

Tips appear **one at a time**. They used to be independent — each showing whenever its own
situation applied — and on every takeoff three applied at once and stacked over the view the whole
thing exists to show. They are a priority list now: the first line whose situation holds is the
line you get. The scenic flight alternates its status line with its hints rather than showing
both, never offers the gear prompt (it raises the gear itself, a few seconds after the wheels
leave), and the Controls tab can turn tips off entirely.

The key list has two depths. The screen that follows the titles carries only the eleven
bindings needed to fly and look around; a wall of eighteen is not what anyone wants at the
moment they are trying to get airborne. `H`, `Escape` or the **Help** tab adds the rest, and
it stays that way for the session.

A gamepad works too: right stick flies, left stick is throttle, shoulders are rudder.

Four buttons sit in the top right: **radio**, **screenshot**, **record**, and **fullscreen**
(rightmost). They are children of the body rather than of the title overlay — put inside the
overlay they inherited its `hidden` and vanished the moment the game started, which is the one
time you actually want them.

### Tips that get out of the way

A hint that is always on screen stops being a hint and becomes furniture, and the whole point of
this sim is the view behind it. So the tips run on a duty cycle: a line comes up, holds for **9
seconds**, and then the screen is left alone for **26** before anything else is allowed to appear.
Nothing is displayed continuously — not the scenic flight's own status line either.

The ones that teach a key are said **once each** and then retire for the session. There is no
value in the eleventh telling of "press C to cycle cameras": either it landed the first time or a
tip was never going to be the thing that fixed it. The exceptions are the lines that answer a
question you can have more than once — "throttle with SHIFT and rise up at speed 150+" is how you
take off, and every flight starts there.

Dismissing them is a **×** on the tip's own corner, which fades in when the pointer is near it. A
dismiss belongs to the thing it dismisses; the pill that used to sit under the stack was a second
object to look at, which is the opposite of the point.

### The black rectangle in the sky

Preetham's solar disc is `vSunE * 19000.0`, which peaks around **7.6e5** — and the scene renders
into a **half-float** target, whose ceiling is **65504**. Every pixel of the sun was therefore
`Inf`. `Inf` through the bloom's separable blur becomes `NaN`, `NaN` resolves to black, and the
blur works in mips — so one overflowing pixel came back as a black **rectangle**, flickering,
because the disc's `smoothstep` is 0.00002 wide and whether a given pixel is over the edge changes
from frame to frame. It showed up exactly where the sun is in shot: `sun rim`, `ground plate`.

`SkyClamp.ts` bounds the sky's output at 1e4 — four orders of magnitude above the bloom threshold,
so the sun still blows out completely and still blooms hard, but with a finite number; ACES maps
anything past ~16 to white regardless. It is a string splice into three's own `Sky.js`, so
`check:sky` runs the splice against the shipped shader and fails if a three upgrade ever rewords
the line, rather than letting the clamp quietly stop applying.

Two earlier suspects were also fixed on the way, and both were real: the camera could sit **below
sea level** in the planted shots (measured at −175 m over deep water, lens pointed up — from under
the surface the ocean covers the whole sky), and the ocean quad lay two thirds **outside the far
plane**, where log depth clamps everything to the sky's own depth with the two sorted by an
unstable tie-break. The camera's floor is now the ground *or the water*, the far plane is 300 km,
and the sky has a `renderOrder`.

### The radio

Twenty channels chosen for a cockpit — three shades of ambient for high cruise, two space stations,
a lounge pair for the golden age of jet travel, beats for flying at night — with a volume slider
and a file picker for your own music, which loops rather than falling silent four minutes into a
twelve-minute tour.

It is the one part of the sim that reaches the network, and it does so only when asked. The audio
element is created with **no source and `preload = 'none'`**, so the sim still *loads* with no
network at all — the title screen and the whole world come up on one request, the page itself. The
stream is a second request, made when the flight starts.
Volume goes through `HTMLMediaElement.volume` rather than a Web Audio graph on purpose — routing
these streams through an `AudioContext` would need a `crossOrigin` attribute and would fail
silently on every station that does not send the header.

**Captures contain the 3D and nothing else**, and that costs nothing to arrange: the HUD is a
second canvas and the tips, the panel and the shot label are DOM, so capturing `#scene` alone
excludes all of it. The obvious alternative — hide the interface, capture, put it back — would
flash the UI on every screenshot and fly the aircraft blind through a recording.

- **Screenshot** is taken in the same task as the draw, immediately after `engine.render`.
  Without that the drawing buffer is already cleared and the image comes out blank; the usual fix
  is `preserveDrawingBuffer: true`, which taxes every frame to make one screenshot cheap.
- **Record** streams the same canvas through `MediaRecorder` at 60 fps, and the button itself is
  the only recording indicator — anything on screen would be a thing that is deliberately not in
  the file. Click again to stop and save.

**Recordings are MP4/H.264**, not WebM. `MediaRecorder` in current Chrome and Safari writes MP4
directly, so the file opens in QuickTime, Photos, iMovie, Premiere, Windows or a phone with no
codec pack and no VLC — which is the whole point of a video you want to watch or cut. The format
is picked from an ordered list at record time:

| | | |
| --- | --- | --- |
| `video/mp4;codecs=avc1.640028` | H.264 High | first choice — plays anywhere |
| `video/mp4;codecs=hvc1.1.6.L93.B0` | H.265 | smaller, patchier playback (Windows wants the HEVC extension) |
| `video/webm;codecs=vp9` | VP9 | for browsers whose `MediaRecorder` cannot write MP4 |

The HEVC string has to be fully qualified: Chrome rejects a bare `hvc1` and accepts
`hvc1.1.6.L93.B0`, which looks exactly like "HEVC is unsupported" if you probe it the obvious way.

Verified without a browser in the loop: `file(1)` reports *ISO Media, MP4 Base Media v1*, the box
walk shows `ftyp`(isom) `moov` `moof`/`mdat` with an `avcC` record, and **macOS QuickLook renders
a thumbnail from it** — that is AVFoundation decoding the file, not Chrome. One note on the
container: `MediaRecorder` writes *fragmented* MP4, which every modern player handles but a few
old tools dislike; remux with `ffmpeg -c copy` if you meet one.

Both captures land in the browser's downloads as `horizon-f18-<world>-<timestamp>`, and neither
contains a pixel of interface.

**Taking off:** hold `Shift` to full throttle, keep straight with `Q`/`E`, and ease back on
`S` at about 150 kt. Gear up with `L` once you're climbing.

## The cinematic camera

Thirty-eight setups in three scales, cut by a director rather than shuffled. The grammar matters
more than the shot list: it walks the scale ladder in one direction so a run leads you in or leads
you out, mirrors every off-axis shot onto the side it is working so the aircraft keeps crossing
frame the same way, and only crosses the line after a neutral on-axis shot.

**Moves now agree with the ladder.** Whether a shot pushes in or pulls out is *derived* from its
own numbers rather than authored, and the pool is filtered to match the direction of travel.
Coming back up the ladder — close, medium, wide — a medium shot that pushed in fought the
retreat and made the cut to the wide read as a jump. Five setups exist only for the way out
(`peel away`, `drop back`, `wide retreat`, `lift out`, `departure`).

**Lead room.** Every shot used to aim at the aircraft, which centres it — the one framing an
operator never chooses. Shots now aim *ahead* of the nose, by a per-scale distance, so the subject
sits back off centre with room to move into.

**Framed against the world, not just the aircraft:**

- `into the sun`, `sun rim` put the subject between the lens and the sun. The best light this sim
  makes was previously reached only by accident.
- `landmark pass`, `landmark low` put the nearest city or peak behind the aircraft.
- `crane pass`, `ground plate`, `runway plate` are planted in the world; the crane booms as the
  aircraft goes by.
- `reverse dolly zoom` is the Vertigo the other way — pulling out while the lens narrows.
- A little handheld drift on the closest setups: two slow sines an irrational ratio apart, so it
  never repeats into a mechanical wobble.

**The director cuts on events, not only on a timer** — the rotation and the touchdown request a
shot tagged for them, because those are moments a director cuts *to*. It also declines shots that
sit far below the aircraft when there is no room underneath, and declines landmark shots when
there is no landmark.

One fault worth recording: the backlit shots first pointed at nothing at all. `world.sun` is the
direction to the sun; `sunLight.position` is a *place* that follows the aircraft so the shadow
frustum stays with it. Normalising the latter gives a "sun direction" dominated by where the
aircraft happens to be.

### The free camera

`C` cycles to it, or pick **FREE** in the Style tab. Drag to orbit, wheel to zoom, shift-drag to
push the aircraft off centre, `1`–`4` for set views (astern, abeam, nose-on, overhead) and `X` to
switch between holding station on the aircraft and holding it on the world.

Three decisions worth stating:

- **It lives in the aircraft's yaw frame by default.** The aeroplane then keeps its place in the
  frame while the world turns underneath it. World-locked — `X` — it becomes a fly-by every time
  the aircraft turns, which is occasionally what you want and usually not.
- **The drag moves the camera directly**, a quarter of a degree per pixel, with only a little
  residual spin left over for the flick. It was first built the other way round — the drag fed a
  *rate* that decayed — which has a nasty property: a slow, steady drag, which is exactly what you
  do when framing something, has each frame's contribution eaten by the decay before the next
  arrives. The camera would barely move. The range was always a full circle; it simply would not
  go there at any speed anyone would naturally use, and it read as a camera locked to the tail.
- **Zoom is multiplicative**, so a click of the wheel moves the same *proportion* of the distance
  at six metres as at six hundred.

**Eight saved views on `1`–`8`.** They start as a spread rather than eight variations on
"behind" — astern, abeam, nose-on, overhead, low six, a high wide, a tight wingtip and a long lens
at 320 m — and `shift`+number overwrites any of them with whatever you have framed — so the presets and the saves
are the same four slots rather than two competing sets. They persist in `localStorage`, which is
the only place a single file opened from disk can put anything; every read and write is wrapped,
because a private window or a strict `file://` policy must never stop the sim starting.

**It does not shake**, and getting there took three goes. The obvious cause was the speed shake the
chase view uses — a hand-aimed camera should no more tremble than a tripod does, so the free
camera opts out of it as the cinematic director already did. Removing it barely helped: measured,
the camera was still jittering three times as much as the chase view it was supposed to be
calmer than. The real cause was that this camera took the aircraft's yaw *and* its aim raw, while
the chase view has always damped both. An aeroplane is permanently making small yaw corrections —
gusts, dutch roll, the control laws — and with the camera's bearing welded to that yaw, every one
of them moved the camera and its aim at once.

| frame-to-frame camera rotation | median | worst |
| --- | --- | --- |
| chase, low and fast | 0.106° | 0.223° |
| free, before | 0.384° | 1.984° |
| free, after | 0.002° | 0.014° |

That fixed the *world*, and revealed the rest: the aircraft was still trembling against a now-steady
frame, and only below 60 fps. The drawn aircraft advances in *simulated* time, which lags real time
by anything from zero to one physics step; an exponential filter on the camera runs on *wall* time.
The two clocks disagree by up to 8 ms — two metres at 240 m/s — and that difference lands on the
subject and nowhere else. At 60 fps against 120 Hz physics the step count per frame is a constant
two and the disagreement is constant; below it the count alternates and the error changes every
frame, which is precisely when it reads as shaking.

So the free camera is **rigid to the aircraft**: no positional smoothing, no smoothing of the aim,
only the heading damped. An orbit camera bolted to its subject cannot let that subject move at all,
and any residual timing wobble goes to the scenery, where two metres at a kilometre is nothing.
Measured as the aircraft's screen position, frame to frame:

| | median | worst |
| --- | --- | --- |
| chase | 0.14 px | 0.44 px |
| orbit | 0.15 px | 0.37 px |
| **free** | **0 px** | **0 px** |

It never touches the flying controls. The mouse is already a virtual stick under `M`, on pointer
lock; this is a plain drag on the canvas, kept in separate state, and the drag handler ignores the
mouse entirely while the stick has it. The check drives real mouse events through the debugger and
asserts the aileron and elevator do not move while the camera is dragged.

### The director

`C` again, past the free camera. The cinematic director runs exactly as it does on its own — it
picks the shots, holds the grammar, cuts on its own clock — but the shot it is playing is now
yours to reshape:

| | |
| --- | --- |
| drag | swing the camera round the aircraft, and raise or lower it |
| wheel | how far away it sits |
| `,` `.` | cut straight to another setup, ignoring the ladder |
| `X` | pin the current setup so it stops cutting away |
| `Z` | put the shot back the way it was written |
| `1`–`9` | cut to a saved setup and hold it; `shift`+number saves the one you are watching |

All of it is also a bar at the bottom of the screen, under the tip line and on screen only in
the director: **‹ shot name ›**, an **auto / pinned** toggle, the sliders, and a **?** that lists
the keys. The tip above it is left with the one thing no button can show you — that the shot is
reshaped by dragging — and it says so for thirty seconds and then gets out of the way, since it is
an introduction to the mode rather than a permanent caption on the view. Leaving the director and
coming back starts it again. Clicking the name opens the whole
library, in three columns by scale, each shot marked with what it does — *push in*, *pull out*,
*hold*, *planted*, *backlit*, *landmark*. Those marks are derived from the shot's own numbers
rather than written next to them, so the list cannot come to disagree with what the camera does,
and a shot added to `Cinematic.ts` appears in the picker without anyone maintaining a second list.

The keys started out as `[` and `]` — still accepted, no longer advertised — which is fine on a US
layout and wrong everywhere else: on a Nordic keyboard those two key *positions* print `å` and
`¨`, and `[` itself is `AltGr`+`8`. `,` and `.` are unshifted, adjacent, in the same physical
place on every common layout, and are already the step-back / step-forward pair in every video
editor.

The point is that **an adjustment belongs to the shot, not to the moment**. Reshape the wingtip
pass once and it is reshaped every time it comes round, in every world, in a later session — the
tweaks are stored against the shot's name in `localStorage`. It works because the shot library was
always data: a start offset, an end offset, a look target and an FOV ramp. Handing over the two
numbers a camera operator actually reaches for — how far, how high — costs nothing and gives up
none of the sequencing.

A pinned shot still *plays*: its move runs to the end and holds there. It simply never hands over.

### Length and travel, not speed

The sliders behind the bar's second icon are **length** and **travel**, and it is worth saying why
there is no "camera speed" among them. A shot is a move from `from` to `to` parameterised by
`elapsed / duration`, so speed is travel ÷ hold: ship all three and each slider silently moves the
others. These two are independent, and each does one thing you can see.

- **Length** — seconds the shot stays on screen. Changing it re-times the shot in progress, or the
  slider would appear to do nothing until the setup came round again. (`hold` in the code, since
  that is what a shot's duration is called everywhere else in it.)
- **Travel** — how much of the written move actually gets made. Everything that travels reads this
  one number: the dolly, the orbit, the crane's boom, the focal ramp. At 0 a shot becomes a
  locked-off frame; at 2 it sweeps twice as far. One value, and it means the same thing in all
  thirty-eight setups, because every setup was already a move rather than a viewpoint.

Above them are three **pace** presets — Calm, Standard, Kinetic — which are the same two numbers
applied to every shot at once, because most people want the outcome rather than the sliders. They
multiply with the per-shot values rather than replacing them.

While a scenic flight is running, the **tour rate** joins them on the bar — the same 0.5×–3× that
lives in the World panel, which is where you set it before taking off; the bar is where you reach
for it while watching. One setter serves both, so they cannot disagree about which is selected.

The **cinematic** view gets the same three controls, but laid *along the bar* rather than behind a
button: `CALM STANDARD KINETIC │ LENGTH ──●── 1.00× · 4.0 s │ TRAVEL ──●── 1.00×`, one row, 32 px
tall. That camera has exactly three things worth reaching for, and a popover to hold three
controls is a door in front of a doorway. The director keeps its panel, because it has three
columns of things to say. There the sliders drive the shot on screen and opening them holds it;
on the cinematic bar they drive the pace itself. That is also why the pace is stored as two numbers rather
than as a chosen preset: the sliders can leave it between two of them.

### The reel

Nine saved shots, and a running order made of them. A **reel** is the shortest true name for it:
a sequence of setups spliced together and played in order, looping at the end.

The slots are a row of nine buttons in the panel as well as the number keys. Clicking one recalls
it. Clicking an **empty** one saves into it — there is nothing else it could sensibly do — and the
**Save** button arms an overwrite so a filled slot can be replaced without reaching for the
keyboard. `shift`+number still does it directly.

The reel starts as *every filled slot in slot order*, so it plays the moment there is anything to
play. The chips under it are the order: **drag one to move it, click one to drop it** (the shot
stays saved, it just leaves the running order). Playing shows `REEL 2/4` where the bar otherwise
says AUTO or PINNED — leaving it reading AUTO while a reel played was the one thing on that bar
that was simply untrue.

Implementation-wise the reel is one idea in `Cinematic.ts`: a **queue of `(shot, tweak)` pairs**
that `cut()` reads off instead of choosing. Everything else — durations, moves, planting, pace,
the ground clamp — is untouched, because none of it was ever about *which* shot came next. And
because each entry carries the shape it was saved in, a reel is a list of framings rather than of
shot names: the same setup can appear twice, framed differently.

Anything that picks a shot by hand — a number key, the picker, `,` `.`, pinning — takes the reel
off the air. A running order somebody keeps overriding is not a running order.

`check:director` composes a four-entry reel out of slots 1, 3, 5 and 9, orders it `9 → 1 → 5 → 3`,
and asserts the played sequence over nine cuts is exactly that order repeating.

Below them are **replay** and **loop**. A pin used to mean the move ran once and then held its
last frame for as long as you held it, which is a photograph rather than a shot; loop is on by
default, so a held setup repeats instead. Replaying a *planted* shot re-anchors it to where the
aircraft is now — otherwise a crane played again half a minute later runs its boom through the
piece of sky the aeroplane left. On an eased shot the offset is deliberately not snapped back:
it glides to the top of the move, so a loop reads as the camera coming back round rather than as
a cut to the same setup.

One shot is kept out of the rotation entirely. **departure** — the aeroplane leaving, pulling away
to 460 m — reads as an ending, and an ending twelve minutes before the end is just a camera falling
behind. It is marked `reserved`, so the sequencer never picks it and only the takeoff can ask for
it by tag. Measured over 270 consecutive cuts across 30 setups, it appears zero times, and the
takeoff still reaches it.

`check:director` measures both. Held against a planted crane with a 120 m boom (the one shot with
no easing anywhere in it, so it is the only honest ruler), travel 0/1/2 gives 0.0 / 120.0 / 240.0 m
to within a tenth of a metre, and Calm and Kinetic give 74.4 m over 8.1 s and 180.0 m over 4.0 s —
distance from one knob, seconds from the other. On an *eased* shot the camera arrives short of the
written end — 317 m of a 345 m move — and that is correct: a first-order follow chasing a target
moving at v settles v/k behind it. Doubling the travel still doubles what the camera does, because
the move and the error scale together.

### Depth of field

Real, depth-based, and switchable in the Style tab (**Deep focus** / **Shallow**). Twelve of the
thirty-eight setups ask for it — close and medium shots — so a single sequence shows both looks.

The focus distance is *given*, never searched for: the director knows exactly where the subject
is, so there is no autofocus to hunt, and a rack focus is that number moving.

**The subject is not a point.** The first version divided the circle of confusion by distance,
which is what a thin lens does and gives the wrong answer here: an aircraft seventeen metres long,
shot from eight, spans twice its own focus distance in depth, so the thing the lens was focused on
came out soft along with everything else. There is now a band either side of the focus plane that
stays perfectly sharp, sized to the *subject* rather than to the distance — wide enough to hold
the whole airframe from any angle — with the falloff starting beyond it.

The trap is the depth buffer. The renderer uses `logarithmicDepthBuffer`, so the depth attachment
holds `log2(1 + w) / log2(far + 1)` and not what the textbook formula expects. Read it the obvious
way and you get a plausible-looking, completely wrong blur. Inverted properly it is
`w = 2^(depth · log2(far + 1)) − 1`.

The strength was pulled back after seeing it in motion: it was reading as an effect rather than as
a lens. Apertures are 0.36–0.96 and the blur radius is capped at 16 px, which separates the
aircraft from its background without making the landscape unrecognisable.

**Cost, honestly:** one full-screen pass, twelve poisson taps, each also sampling depth so a sharp
foreground cannot smear over itself. Pixels near the focus plane cost two fetches and stop. The
pass is skipped entirely when the current shot does not ask for it, it is off below MEDIUM
quality, and it never runs outside the cinematic camera. What this repo's harness **cannot** tell
you is the GPU cost: `loop.frameMs` measures JavaScript time, and headless Chrome renders in
software, so a measurement here says nothing about a real GPU — the toggle and the on-screen fps
are the way to judge it on your own hardware.

## The scenic flight

`F`, or **Fly a Scenic Tour** in the World tab. The autopilot takes off, tours the landscape and
lands itself, in the cinematic camera, while the HUD suggests the things you can do meanwhile —
change the light, the weather, the view. Touching a *flight* control hands you back the aircraft;
`C`, `T` and `R` do not, because those are the point.

It is not an airliner's flight management system, and it is not trying to be. The route is chosen
for what there is to look at and the height for what you can see from it — a few hundred metres
above whatever is coming up, rather than an efficient cruise altitude.

**It flies the same stick you do.** Nothing in it writes to the aircraft's position or attitude:
it produces a `StickInput` and the control laws and flight model take it from there, exactly as
they do for a human. That is what keeps it behaving like an aeroplane for the whole tour — it
banks into its turns, floats in the flare, and can be taken over mid-manoeuvre.

**It does not stop.** Landing rolls straight into a fresh random world and the next departure —
a tour that ended by parking on the runway of the world it had just shown you would be an odd
place to leave someone who asked for a scenic flight. `F` or `Backspace` during the pause cancels
the handover and gives you the aircraft where it stands.

That handover exposed a nice little fault. The autopilot cleared its own `active` flag on
stopping, so the owner's "has it finished?" test — `active && phase === 'done'` — could never be
true, and "landed" was indistinguishable from "never started". The flag now means *engaged*, and
only the owner clears it.

**Speed.** 0.5× to 3×, in the World tab. This is the *clock*, not the throttle — the aircraft is
not flown faster, because at three times the speed a jet's turning circle grows ninefold and the
tour stops fitting the landscape it was planned around. Simulated time runs faster instead, by
taking *more* fixed steps per frame rather than bigger ones: the aerodynamic integration is only
stable because the step is 1/120 s, so stretching it to 1/40 would change the flight model rather
than the clock.

The camera is deliberately left out of it. Everything handed the render callback stays on real
time, so the cinematic director's shots hold their own pace — which is what stops a 3× tour
looking like a fast-forwarded video. Measured over 75 seconds of the same Harbour tour:

| | ground per real minute | camera cuts per real minute |
| --- | --- | --- |
| 1× | 8.5 km | 13.6 |
| 3× | 27.8 km | 13.6 |

**Where it goes.** Three things read well from the air and all three are already in the height
field: relief, the water's edge, and anything built. A ring of candidate points around the field
is scored on those, thinned so the winners are separate sights rather than five samples of one
mountain, and ordered by bearing so the tour is a loop rather than a scribble.

**Where it lands: the field it left.** This began as "take off from one runway and land on
another", and the worlds are full of village strips to aim at. It does not survive contact with
procedural terrain. Those strips are 920 m pads dropped wherever a village went — several sit in
glacial valleys under two-kilometre walls, on a canyon rim, on a ledge above a fjord. Eight
separate passes at the approach law each fixed two worlds and broke two others; rejecting strips
by approach corridor and by surrounding relief helped and did not settle it. Measured across all
fourteen worlds, aiming at a village strip landed in nine or ten of them and coming home lands in
twelve. The home field is flat *by construction* — the terrain generator levels a 1.9 km pad with
a 5.2 km falloff — which is the one property an autoland can rely on. So the tour is a circuit,
and the strips it passes are scenery.

```
npm run check:autopilot
```

Flies the whole tour, in every world, at the physics rate, and checks what a passenger would
notice: that it got off the ground, stayed off it, went somewhere worth going, and put the wheels
on the airfield rather than beside it. It is the only way to test this — a sightseeing autopilot
is exactly the sort of feature that works when you try it and fails on the eleventh world, into
rising ground, in a case nobody flies by hand.

Every fault in it was found this way and none of them by flying: a heading loop mixing degrees
with radians; a bank limit missing, so at 150 m/s the turning circle was wider than the capture
radius and the aircraft orbited its own waypoint for twelve minutes; an altitude gain sized as
though the stick were a climb command when it is a *g* command, so it pulled 3 g to correct a few
hundred metres and spiralled; a glide path measured from the threshold, which starts climbing
again the moment you pass it, so it flew over the runway at sixty metres for ever.

**The check had to be made reproducible before any of that meant anything.** `FlightModel` seeds
its gust cycle with `Math.random()`, so no two runs flew the same weather — and the touchdown
point moved by a couple of hundred metres between identical runs. Several tuning passes that
looked like improvements had changed nothing at all; failures appeared to wander between worlds
because they were partly noise. The phase is settable now and the check pins it, so the same code
gives the same landing twice.

**Landing: an intercept, not a chase.** The approach used to pursue a point on the extended
centreline, which converges on paper and lands crabbed across the runway in practice — with a bank
limit and a kilometre of offset the aircraft is still turning when it arrives, so it touched down
300 to 900 m off the centreline, diagonally, and ran off the side. It now flies a *track*, the way
an aircraft captures a localiser: a closing angle that eases to zero as the offset does. Typical
touchdowns went from 300–900 m off the centreline to **5–73 m**.

Three things had to be right together, and each one broke the other two while I found them:

- The **abandon threshold**. An aircraft rolling onto a 38° intercept keeps drifting away while it
  turns — that is the turn, not a failure. A tight limit fired *during* the intercept, threw the
  approach back out to the gate, and the two states then traded the aircraft back and forth in a
  circle for the rest of the flight.
- The **established test**. An approach sitting 200 m off the centreline and closing was rejected
  for 17° of instantaneous heading, ran out of room, and flew the whole circuit again — eleven
  times over in some worlds. The lateral law is the same either side of that gate, so joining a
  little early costs nothing and it goes on tightening all the way down.
- **Where the turn-in happens.** Switching on distance alone turned inbound while still flying
  outbound past the gate, which costs a 180° turn and four kilometres of drift; switching on
  heading alone never fired at all, because an aircraft flying *to* the gate points at the gate,
  not down the runway.

**Known limitations,** measured with the gusts pinned: ten of the thirteen runway worlds complete
the tour and land, eight of them within 73 m of the centreline. Isles (151 m) and Canyon (258 m)
touch down wide of it but on the flat field; Fjords, Himalaya and Alpine fly the approach and
never satisfy it inside the time budget, so they circle rather than crash. All of it is reported
by the check rather than hidden. Closing the last of it means a full circuit — downwind, base and
final legs with a configuration schedule — rather than the single intercept used here.

## How it works

The flight model is a rigid body integrated at a fixed 120 Hz, decoupled from rendering,
with the visual pose interpolated between physics states. Forces come from classical
aerodynamics rather than scripted behaviour, so the handling is emergent:

- Lift from a CL/alpha curve that blends to a flat-plate response past the stall
- Parasitic + induced drag, transonic wave drag through Mach 1, and gear drag
- Pitch, roll and yaw moments from standard stability derivatives, with control
  authority falling off as the flow separates at high alpha
- Air density and thrust lapse with altitude, plus inlet ram recovery — without
  which thrust decays with density while drag keeps climbing with V², and the
  aircraft can never reach its top speed

Performance, all measured rather than asserted:

| | |
| --- | --- |
| Max speed | 1907 km/h (Mach 1.79) at 15 km |
| Max speed at sea level | 1451 km/h (Mach 1.19) |
| Takeoff | Unsticks at 162 kt, 10.6° nose-up three seconds later |
| 200 → 400 kt at 3 km | 13.0 s |
| 300 → 600 kt at 2 km | 18.6 s |
| Roll rate | ~240°/s |
| Stall | 16° angle of attack |

Thrust is set above the real Hornet's 98/158 kN to give that acceleration; the top speed
is not clamped anywhere, it is where the drag curve and available thrust balance.

Flight assists (`G`, on by default) sit *on top* of that rather than replacing it — they
only move the stick. Turn them off and the aircraft can be stalled and departed like the
real thing.

With assists on the pitch axis is a **load-factor command system**: the stick asks for a g
loading and one damped loop drives the elevator to achieve it. Several nice properties
fall out of that formulation:

- Neutral stick commands 1 g, which holds the current flight path — so the aircraft keeps
  a climb or descent hands-off, with no trim integrator.
- A banked turn needs 1/cos(bank) g, so folding that into the command sustains turns
  without a separate loop.
- The structural and angle-of-attack limits become clamps on the *command* rather than
  gates on the *output*.

That last point matters. An earlier version had four things writing to the same elevator
signal — turn sustain, auto-trim, an alpha limiter and a G limiter — and the limiters were
multiplicative gates (`elevator *= 1 - …`). A gate switches in and out against the surface
slew rate and buzzes the nose up and down; worse, the turn-sustain loop regulated toward
1 g in level flight and so fought every deliberate climb or dive. Expressing limits as
bounds on the command removes that whole class of oscillation. Gains are scheduled on
dynamic pressure, because elevator effectiveness rises with it and fixed gains go
effectively high-gain — and unstable — at speed.

### Rotation

Holding the stick back on the runway used to put the stabilators at **100% of travel** and the
aircraft left the ground at **84°/s**, reaching **38° nose-up** three seconds later — a jet
behaving like a startled bird. Three separate things were wrong, and only measuring the takeoff
frame by frame separated them.

The assists are off while the wheels are down, so the stick drove the surfaces raw. Cutting that
authority alone was not enough: the aircraft still rotated at 22°/s and was pulling 3.5 g *before
it left the ground*. What makes it a rotation rather than a wind-up is a **pitch-rate damper**
during the ground roll — stick against rate settles at a rate instead of accelerating until the
surface runs out of travel.

Then the handover itself. The load-factor loop engages the instant the wheels leave, and its
command had been parked at 1 g while on the ground. Meeting an aircraft already pulling 3.5 g, it
saw an error of −2.3 g and shoved the nose down to **−1.4 g**: the nose went 16° up, back through
1°, and up again. A porpoise, with the tailplanes swinging through their full travel to drive it.
The loop now takes over already matched to what the aircraft is doing.

Full authority is handed back over a height band — a smoothstep from 10 to 170 m AGL — and the
gate is **monotonic**, re-arming only on touchdown. That matters: keyed to altitude alone it would
re-engage every time you flew low over terrain, which is exactly where you want the full envelope.

| | before | after |
| --- | --- | --- |
| peak pitch rate | 84°/s | 8°/s at rotation |
| stabilator travel used | 100% | 46% |
| pitch attitude 3 s after unstick | 37.8° | 10.6° |
| worst g excursion | −1.4 g | 0.7 g |
| unstick to 1000 m | 9.4 s | 10.5 s |

The last row is the one worth watching: the climb costs one second, all of it spent below 170 m,
and the aircraft pulls the same 6.6 g as before once it is clear.

### Turning

Left/right commands a **bank angle**, not a roll rate, and the aircraft automatically
pulls the extra lift a level turn at that bank needs. This matters: a bank on its own
only drops the nose and spirals — the heading change comes from the horizontal component
of lift, which has to be sustained at a load factor of 1/cos(bank). The commanded bank
ramps while the key is held, so holding longer banks further and turns harder.

Measured turn rates track the textbook `g·tan(φ)/V` to within 1%:

| Bank | Time for a 180° turn |
| --- | --- |
| 30° | 158 s |
| 50° | 76 s |
| 75° | ~25 s |

Slowing down tightens the turn considerably — that is real, not a limitation. With
assists off you get the raw aircraft, which will happily roll inverted and spiral into
the ground if you hold the stick over.

### The aircraft

Two faults worth recording, both visible only from angles nobody had looked from.

**The engines had no undersides.** The nozzles were bare open-ended tubes, and an open tube's
inner wall faces *away* from a camera behind the aircraft — so it was back-face culled, and from
astern you looked straight through the engines at the sea. Each is now an engine bay, a nozzle
with a liner drawn inside out, and a turbine face closing the far end so there is no sky up the
pipe.

**The wings were slabs.** `panel` extruded one constant depth across the whole planform, so a
5 m wing carried its root thickness all the way to the tip and read as a plank with a sharpened
edge. The section now thins outboard — a single pass over the vertices after the extrusion, since
the span is X and the thickness is Y by then — on a curve rather than a straight line, because
real sections hold most of their depth over the inboard half and lose it quickly outboard. Every
flying surface has its own taper, and the root sections are thinner too.

**There was nobody in it.** Helmet, visor, shoulders and a seat headrest, sized against the eye
point the cockpit camera already used, so the head sits where the pilot's head actually is. Hidden
in the cockpit view for the obvious reason. It also does not cast a shadow — it is added after the
pass that sets `castShadow`, along with the rest of the interior.

### The carrier deck

The deck flashed before takeoff and not in flight, worst at noon. Two defects, both the same
shape — surfaces sharing a plane:

- **The hull's top face and the flight deck's top face were both at exactly y = 20.000**, over
  a 58 x 304 m overlap. That is the whole middle of the deck: two large opaque upward faces at
  identical depth, guaranteed to fight. The hull now sits a metre lower, its top buried inside
  the deck slab where nothing can see it.
- **The markings were five plates stacked on the deck**, and their spacing had drifted to 5 mm
  in one place. They are painted into the deck's texture now, so the deck is a single surface.

Why the ground and not the air: parked, the chase camera is about 6 m up looking down 330 m of
deck, very nearly edge-on, and at a grazing angle the depth difference between two
almost-coplanar surfaces projects to almost nothing along the view ray. Flying, you look *down*
at the deck and it hides. `polygonOffset`, the usual remedy, is unavailable — the renderer runs
a logarithmic depth buffer, so fragments write `gl_FragDepth` and polygon offset does not apply
to a shader-written depth.

```
npm run check:deck
```

The check compares the top faces of every pair of horizontal surfaces at deck level whose
footprints actually overlap. Two things it had to get right, both of which produced wrong
answers first:

- **Real footprints, not bounding boxes.** The landing area is canted 9°, which inflates its
  axis-aligned box from 26 m wide to 59 m and reports the axial centreline dashes as sitting on
  it when they do not. It uses separating axes over the turned rectangles.
- **No thickness filter.** Selecting "thin plates" looked reasonable and silently skipped the
  deck slab and the hull — the two largest surfaces up there, and the ones that were actually
  coplanar. The check passed while testing nothing. It now selects on *presenting an upward face
  at deck level*, whatever the thickness.

### Cities

Four of the fourteen worlds have one, and they are the same system pointed at different ground.

Buildings cannot be terrain. Every landscape is `terrainHeight(x, z)`, sampled by both the mesh
generator and the collision sampler, and that works because hills are smooth. Towers are not:
the quadtree's finest chunk is `262144 / 2¹⁰ = 256 m` across at 24 segments, so **10.7 m per
vertex**. A 30 m tower is three vertices and the LOD rounds it into a bump.

So the buildings are geometry — but they are *planned* first, which is what lets very different
cities share one system. The plan has the same shape as the ones the villages, the rivers and
the pyramids use: search the ground once when the world is chosen, bake the answer into a flat
grid, and settle every later question with one lookup. That matters because `cityHeight` sits on
the collision path — 120 Hz for the aircraft, and again for every terrain vertex — so it can
afford an index but never a search. Collision then joins the seam the carrier deck already uses,
`groundHeight = max(terrain, …)`, so flying into a tower and landing on a roof need no new code.

**Where a city goes is a rule, not a drawing:**

```
buildable = flat enough  AND  low enough  AND  out of the water
```

which is how cities actually sit, and gives a plausible footprint on any terrain without anyone
tracing a coastline. Towers cluster toward district centres, the fringe thins to low-rise, and
steep ground stays green — so the grid breaks against the landscape by itself. Buildings stand on
the *highest* ground their footprint touches and are sunk past the lowest, so nothing floats on a
slope and nothing is buried in one.

Each world has a **metropolis, and towns that keep turning up wherever you fly** — because one
city in an empty world is a diorama, and a ring of suburbs around it is only a slightly larger
diorama. The first version searched a bounded area near the metropolis, which meant flying out
past its own neighbourhood ran out of places for good.

Towns now sit on a **global 9 km grid that has no edge**. A hash decides whether a cell carries
one at all, and where in the cell it stands; places within `KEEP_RADIUS` of the aircraft are
planned, and dropped again past `DROP_RADIUS`, so what exists is only ever what is near you. The
grid is also what keeps them apart: one candidate per cell, jittered no more than ±18% of a cell
so that the nearest two can never be closer than 5.7 km while the largest pair of towns together
span 4.6 — separate places with countryside between, by construction rather than by a rejection
test. A cell whose ground the rule turns down is marked barren and never reconsidered.

A town is not a small metropolis. One number — `scale`, from 0.2 to 1 — drives how far a place
sprawls, how many districts it has, and how tall it is allowed to get, so a market town of 25 m
blocks and a downtown of 250 m towers are the same code. Landmarks belong to the metropolis
alone: a village does not have a 400 m spire. Anything the ground allows fewer than 90 buildings
is abandoned rather than built: a dozen houses is a hamlet you fly over without noticing, and the
point of these is that finding one is an event.

Flying 126 km in a straight line from the runway, counting the places met on the way:

| | places met | buildings at once | tallest | metropolis planned in | worst town mid-flight |
| --- | --- | --- | --- | --- | --- |
| Island City | 16 | 26,427 | 500 m | 92 ms | 6.5 ms |
| Harbour | 28 | 22,134 | 444 m | 34 ms | 4.7 ms |
| Domes | 21 | 39,556 | 358 m | 59 ms | 9.0 ms |
| Gulf | 19 | 16,474 | 760 m | 24 ms | 3.8 ms |

The last column is the one that matters for smoothness: a town is planned in the frame it comes
into range, at most one per frame, so its cost lands on a single frame of a 16.7 ms budget.
Halving the height samples per lot — the footprint's own corners now give the slope, instead of
sampling four more points 30 m away and then sampling the corners as well — took the worst case
from 20 ms to 8. The metropolis is planned once, at world load, next to a terrain rebuild that
costs far more.

Island City keeps a hand-drawn island because it is meant to be a particular place; the other three
are rules, and change with the seed. That difference is the whole point of the refactor — the
first version of this file had one island's shape, park and landmarks written into it.

**Windows are procedural — no textures.** The floor grid comes from the fragment's height inside
its own building, recovered from the instance matrix, and a hash per window decides whether that
one is lit. Two things had to be right before it read as a city rather than an effect: past about
one window per pixel the grid cannot be resolved and sampling it anyway gives a different answer
every frame, so beyond that the pattern is replaced by its own average, with the footprint taken
from the rasteriser; and occupancy is *per building*, because with one average brightness the
whole place glows as a single slab.

**Making it fast enough to fly through.** The first version was one pair of instanced meshes with
`frustumCulled = false` — three draw calls, which sounds ideal and is the wrong trade. Every
building was submitted each frame whatever the camera looked at, *and* again for the shadow pass,
into a frustum at most 2.2 km across. Down among the towers that cost about a third of the frame
rate.

| | before | after |
| --- | --- | --- |
| Triangles submitted per frame | 690k | **426k** |
| Instances casting shadows | 100% | **33%** |
| Meshes the renderer can cull | 0 | **28 of 28** |

Tiles of 1.6 km get real bounding spheres, so the half of the city behind you is discarded — a
single mesh spanning nineteen kilometres never leaves the frustum and so can never be culled.
Only tiles that could land inside the shadow frustum cast into it. The low-rise backdrop, most of
the count, is dropped beyond 5.5 km where the ground tint carries the city anyway.

`receiveShadow` is deliberately *not* toggled per frame the way `castShadow` is: it is part of the
material's program, so changing it recompiles shaders. The low-rise simply never receives.

That per-fragment cost is worth dwelling on, because the usual intuition is wrong here. The
renderer uses a logarithmic depth buffer, so fragments write `gl_FragDepth`, which **disables
early-Z**. In a forest of towers the depth complexity is high and every hidden fragment still runs
the full PBR shader. Anything constant across a building therefore belongs in the vertex shader: a
box has 24 vertices and rather more fragments than that. Per-building tone and occupancy moved
there, and the window colour reuses the hash that already decided whether the window is lit — four
hashes per fragment down to one.

```
npm run check:city
```

Per city: the meshes and the collision sampler must agree about where the roofs are, no two
buildings may share ground, streets and gaps must stay walkable, the skyline must have real
spread, there must be several separate places, and the renderer must be able to cull and
shadow-gate what it draws. It also **flies each world 126 km** and counts the places met, which
is the only way to test a world that streams: a check that plans one position and looks around
it cannot tell a world full of towns from one that stops just past the metropolis. The same
flight times how long the dearest town takes to appear, after planning one world and throwing it
away — cold, the first town costs 21 ms and warm it costs 8, and measuring the cold number would
be measuring V8's compiler rather than the planner.

**Land has to rise out of the water, not be blended down into it.** Three of these worlds
computed a land *mask* and faded the surface across it — `lerp(seabed, surface, land)`. That one
habit produced four different-looking faults. Gulf's city belt sat two metres above the waterline
for kilometres, so the metropolis read as standing on a shoal, and no rule against building in the
water helped, because the ground genuinely was land. Every island near the mask's threshold came
out as a paper-flat plate with a cliff into deep water. Island City's outer islands were scaled to
nothing before they were drawn — the hills were in the height field the whole time. And where the
fade left terrain hovering near y = 0 across a wide band, it was coplanar with the ocean plane and
stippled along the entire coast at a grazing angle.

The fix is the same three lines in each: keep the field *signed*, return a seabed that drops clear
of the ocean plane at once, and multiply the land surface by a narrow band at the shore so it
rises from zero. Beaches, not shelves. On top of that, no building may stand with a corner in the
water — a test of its *lowest* corner, since testing the centre puts buildings on spits with half
the footprint in the sea.

That flight caught what the fixed-position checks could not. Three worlds had land only within
about 16 km of the airfield and open sea beyond — fine for a metropolis placed at a fixed point,
and nowhere at all to discover. It also caught the reverse: **towns planned inside the
metropolis**. The rule reserved the grid cell at the origin, which reads as correct until you
notice the metropolis is nowhere near the origin — Harbour's is 9.5 km up the coast with a 7.2 km
radius. Two street grids were being laid over each other: 764 pairs of buildings sharing ground,
roofs disagreeing with the collision height by up to 130 m, and −1.3 km of "countryside" between
the nearest two places.

The "no two buildings share ground" and "roofs agree" checks earned their keep immediately.
Lots were indexed into the lookup grid **by their centre alone**, so any building straddling a
bucket boundary was invisible from the far side — and because the query arrives from a float32
instance matrix while the plan is float64, a lot sitting exactly on a boundary could be filed
one side and looked up from the other. That is a roof the aircraft falls straight through. Lots
now go into every bucket their footprint touches. A separate fault: the landmark cleared
neighbours using a multiple of its *own* radius, ignoring the neighbour's half-width, so a lot
just outside that circle still shared ground with a 760 m tower. Across all worlds: **no world without a city may see one**.
That last check exists because the ground tint leaked once — it was sampled for every terrain
vertex in every world without asking whether the world had a city, so Manhattan's street grid and
a green Central Park were painted across all of them, a few kilometres south of whichever runway
you happened to be on. A gate a caller can forget is not a gate; it lives inside the module now.

### The island world's own surroundings

Every other landscape here is `terrainHeight(x, z)`, sampled by both the mesh generator and the
collision sampler. That works because hills are smooth. Towers are not: the quadtree's finest
chunk is `262144 / 2¹⁰ = 256 m` across at 24 segments, so **10.7 m per vertex**. A 30 m tower is
three vertices and the LOD rounds it into a bump. Even the pyramids only get away with it by
being hundreds of metres wide.

So the buildings are geometry. What survives is the *discipline* that makes the height field
trustworthy: one deterministic description of the city, read by both the instanced meshes and
the collision sampler, so the two cannot drift apart. Collision then joins the seam the carrier
deck already uses — `groundHeight = max(terrain, …)` — and flying into a tower, or landing on a
roof, needs no new code at all. A probe walks every instance and asks the ground its height at
that building's own centre; they agree to 0.00 m.

The grid is Manhattan's: streets every 92 m, avenues every 276 m. Long thin blocks are why its
avenues feel like canyons and its cross-streets do not. Heights come from two district bumps —
Midtown and the Financial District — rather than a flat random, because a skyline reads through
*silhouette variation*, not through uniformly random heights, which just look like a bar chart.
Median building 56 m, 99th percentile 277 m, tallest 500 m.

**Windows are procedural — no textures.** The floor grid comes from the fragment's height inside
its own building, recovered from the instance matrix, and a hash per window decides whether that
one is lit. Two things had to be fixed before it looked like a city rather than an effect:

- **Aliasing.** Past about one window per pixel the grid cannot be resolved, and sampling it
  anyway gives a different answer every frame — a field of sparkling specks where a lit tower
  should be. Beyond that the pattern is replaced by its own average, with the footprint taken
  from the rasteriser rather than a distance guessed in advance. Exactly the fix the sea's wave
  normals needed.
- **Occupancy is per building, not global.** With one average brightness for everything, the
  island glowed as a single slab. Offices empty at different rates; varying the lit fraction per
  tower is what turns the mass back into separate buildings.

The city is gated in **one place** — inside the module — rather than at its call sites. There
are three of those: the terrain's ground shaping, the collision sampler, and the ground tint
carried on every terrain vertex. Two of them had the gate and the third did not, so Manhattan's
street grid and a green Central Park were painted across the ground of *all eleven worlds*, a
few kilometres south of whichever runway you were sitting on. A gate a caller can forget is not
a gate. A check now walks every other world and asserts the city is invisible to it.

Two more faults in the city's own surroundings, both found only by taking a screenshot from the
runway rather than from the air:

- **The harbour guard drowned the airfield.** Open water is forced around the island so a
  reseed cannot beach it — the Pacific's trick for keeping deep water under the carrier — but
  the island's north tip was 3.7 km from the runway and the guard reaches 5.6 km, putting the
  field 6.5 m under. The island moved ten kilometres south, and the guard now fades out near
  the origin so it can never reach a runway whatever distance the island is placed at.
- **The mainland read as water.** Its height took `max(0, relief)`, discarding the half of the
  noise that is negative and leaving six kilometres of dead flat ground between 3 and 12 m — and
  the splat blends beach sand into anything below 34 m. A flat pale sheet at sea level looks
  exactly like sea. The shape term is a 0..1 profile now, giving hills to 280 m, and the airfield
  sits at 48 m, clear of the sand band. Its palette was wrong too: greys chosen to read as
  "urban" are only ever used by the *countryside*, because the island paints its own asphalt.

**Making it fast enough to fly through.** The first version was one pair of instanced meshes
with `frustumCulled = false` — three draw calls, which sounds ideal and is the wrong trade. All
19,392 buildings were submitted every frame whatever the camera was looking at, *and* again for
the shadow pass, into a shadow frustum that is at most 2.2 km across. Down among the towers that
cost about a third of the frame rate.

The island is cut into 1.6 km tiles now, each bucketed by material and by whether it is skyline
(≥ 90 m) or backdrop:

| | before | after |
| --- | --- | --- |
| Triangles submitted per frame | 690k | **426k** |
| Instances casting shadows | 100% | **33%** |
| Meshes the renderer can cull | 0 | **28 of 28** |

Three things do the work. Tiles get real bounding spheres, so the renderer can discard the half
of the island behind you — a single mesh spanning nineteen kilometres never leaves the frustum
and so can never be culled. Only tiles that could land inside the shadow frustum cast into it.
And the low-rise backdrop, three quarters of the count, is dropped beyond 5.5 km, where the
ground tint carries the city anyway.

`receiveShadow` is deliberately *not* toggled per frame the way `castShadow` is: it is part of
the material's program, so changing it recompiles shaders. Instead the low-rise simply never
receives — a shadow-map lookup is several taps under PCFSoftShadowMap, paid per fragment.

That per-fragment cost is worth dwelling on, because the usual intuition is wrong here. The
renderer uses a logarithmic depth buffer, so fragments write `gl_FragDepth`, which **disables
early-Z**. In a forest of towers the depth complexity is high and every hidden fragment still
runs the full PBR shader. So anything constant across a building belongs in the vertex shader:
a box has 24 vertices and rather more fragments than that. The per-building tone and window
occupancy moved there, and the window colour now reuses the hash that already decided whether
the window is lit — four hashes per fragment down to one.

Nineteen thousand four hundred buildings, 233k triangles. Asking the ground its height costs 385 ms per million
samples against 301 for a world with no city — the lot lookup is a fixed number of divides with
no neighbour search, because unlike the butte and karst fields it sits on the collision path.

### Finding the canyon

Switching to Canyon mid-flight showed no canyon. The gorge was still in the height field —
1,337 m deep on a transect — but only **2% of an 80 x 80 km area** was gorge floor, so arriving
anywhere at random put you on featureless rim plateau. It had never mattered while selecting a
landscape dropped you at its airfield, which sits beside the gorge; keeping the flight instead
made it obvious.

Two faults behind it. The width term was `1700 ± 1100`, so where the noise ran low the
"mile-deep gorge" narrowed to a 600 m slot — present, invisible unless you flew into it. And
there was only ever *one* gorge, a single meander line, with tributaries that faded out a few
kilometres either side.

Now the main gorge cannot collapse (`2700 ± 900`), and a branching network is carved across the
whole plateau using the fjords' idiom: `1 − |noise|` gives thin winding lines where a noise
field crosses zero, rather than the round blobs its peaks would give. The threshold was
calibrated against the noise's own distribution rather than guessed — sampling 160,000 points
and reading off what each smoothstep pair would carve — to take about a fifth of the map.

Gorge-floor coverage went from 2.0% to 9.8%.

**Buttes** stand on the plateau between the canyons. The silhouette is the whole thing, and it
has three parts: a talus skirt of fallen debris, a vertical cliff, and a flat cap. A cone gives
none of them at any exponent — what is needed is saturation, full height across most of the
radius then a wall in the last fifth, which is the karst towers' shape with a flat top instead
of a rounded crown. They are added *before* the terracing, so the benches wrap them too, and
banded strata is most of what makes a butte read as a butte.

The first attempt made them 440–1400 m wide and 170–470 m tall, which is a mesa — a low table
you fly over without noticing. A butte is a tower, so it has to be taller than it is wide.

Height sampling for the whole world costs 295 ms per million samples with the buttes in, the
same as Isles and well under Karst's 480 ms, so the nine-cell lookup is effectively free.

### The sea, and why it flashed

The ocean is one flat quad 400 km across, wearing a 512² wave normal map tiled 444 times, at
`roughness: 0.075` — very nearly a mirror. That combination scintillates, and it was reported
as flashing around the carrier in the Pacific at morning, noon and golden hour.

The cause is specular aliasing. One texel covers 1.76 m of sea, and a screen pixel's footprint
on a horizontal plane stretches as roughly `d²·θ/h` — so from 80 m up, 1.5 km away, one pixel
already spans thirteen texels. Past a texel per pixel the shading is decided by normals the
pixel cannot resolve, and mipmapping does not rescue it: averaging normal *vectors* shortens
them but does not widen the specular lobe they imply, so a near-mirror keeps returning
full-strength highlights from whichever sub-pixel wave happens to face the sun. The map
scrolls, the winners change every frame, and the sea sparkles. It showed up at those three
times of day because that is when the sun's specular path is in view.

The fix trades unresolvable detail for roughness — a cheap stand-in for Toksvig/LEAN mapping.
Where a pixel covers more than about a texel, the normal is faded back to the plane and
roughness is raised to 0.34, so distant sea reads as a smooth sheet reflecting the sky, which
is what it looks like from altitude anyway.

The threshold is the *texel footprint*, taken from `dFdx`/`dFdy` of the world position, not a
distance. Distance is the wrong variable: a fade tuned at 600 m altitude is far too late at
80 m, where the grazing angle stretches the same footprint tenfold. The rasteriser already
knows the answer, so ask it. (Interpolating world position across two triangles 400 km wide is
exact — position is linear — whereas a per-vertex distance would not be.)

Measured as the share of pixels that change between two frames 220 ms apart, camera pinned:

| | before | after |
| --- | --- | --- |
| Dawn | 11.5% | 6.4% |
| Morning | 18.9% | 13.4% |
| Noon | 16.2% | 12.2% |
| Golden hour | 32.0% | 19.1% |
| Dusk | 11.8% | 5.5% |

At golden hour the per-pixel magnitude also halved, 27 to 13. What remains is near-field wave
motion, which is meant to move.

### Light and weather

Six times of day and five weathers, all driven from one sun direction so the whole scene
relights coherently.

**Blue hour** is the only preset that cannot be derived from sun elevation. Everything else
here falls out of that one number — intensity, colour, haze — and it works right up until the
sun sets. Below the horizon the light is not a dim *warm* sun but a cool wash from a sky still
lit from underneath, and no function of elevation gives you that, so the preset carries a
`twilight` flag and the lighting reads it: the direct beam drops to a seventh, the sun colour
and both halves of the hemisphere light go cold, and the haze turns deep blue. Leaving the
hemisphere's *ground* colour warm was the tell — it lit the hills a sickly green under a blue
sky.

The sky shader needs more than help. Preetham is extrapolating once the sun is under, and it
returns a muddy brown whatever you do to its turbidity and scattering terms — raising rayleigh
and dropping the mie forward-scatter recovers a blue band at the horizon but leaves the zenith
brown. Rather than fit a second sky model, a wide translucent dome sits between the sky and
everything else: terrain is nearer and has already written depth, so the cast lands only on
sky. It is strongest overhead and fades out by the horizon, which is both what the hour looks
like and what keeps the last warm band above the sunset from being painted over.

Getting the *balance* right mattered more than any single value. The first attempt scaled
everything down together, which left a silhouette under a dim sky. Two of those were backwards:
skylight should *rise* relative to the sun once the sun is the thing that has gone, and the
clouds — lit by a sun that is no longer there — were still at nine tenths of their daylight
brightness, making them the brightest thing in a dark frame. They should be the dark shapes the
last of the sky shows through.

| | before | after | (daylight, for scale) |
| --- | --- | --- | --- |
| Sun | 0.07 | 0.17 | 0.70 at dawn |
| Skylight | 0.09 | 0.44 | 0.18 at dawn |
| Clouds | 0.92 | 0.20 | 1.15 at dawn |

**Stars** appear with the twilight flag, as points rather than a textured dome. With
`sizeAttenuation` off a point is a fixed number of pixels however far away it is, which is how
a star actually behaves: no angular size worth resolving, only a brightness. A dome texture
would be minified into a grey smear at the horizon instead. Magnitudes are distributed as a
square-ish power so most are faint — an evenly bright field reads as noise, not as a sky. Cloud
cover fades them out.

**Rain** is storm without the drama: falling water and a grey sky, no lightning, and a deck
that is dull rather than black.

**Snow** replaces rain outright in winter, in both the rain and storm presets — the same
falling water, arriving differently. It is not rain with different pixels: a raindrop crosses
many pixels in a frame and is therefore a streak, while a flake is a soft round speck that
drifts. Lightning is left alone in a winter storm — thundersnow is real, and a storm should
still feel like one.

Four layers, near to far, and the depth only reads because *everything* moves together:

| | cells | flake | speed | density | brightness |
| --- | --- | --- | --- | --- | --- |
| near | 30 | 4.3 px | fastest | sparse | full |
| | 52 | 3.2 px | | | 0.72 |
| | 86 | 2.3 px | | | 0.52 |
| far | 140 | 1.7 px | slowest | dense | 0.34 |

The first attempt had two layers and scaled the cell count *down* for the far one, which made
distant flakes **larger** than near ones — depth exactly inverted, and the reason it read as
two flat sheets sliding over each other rather than as air with snow in it.

Nothing about it should look like a grid, which is the trap with cell-based particles. Each
flake sits at a random point inside its cell, gets its own size, and wanders sideways on its
own frequency and phase — a single global sway over the top moves the whole field in lockstep
and reads as a curtain. Flake radius is a fraction of *screen height* rather than of a cell, so
a flake is the same size on screen whichever layer it belongs to and whatever the window, and
the cells are squared up by aspect so flakes stay round rather than becoming ellipses on a wide
monitor.

## Worlds

Fourteen landscapes, chosen from the World tab. Each is a height function plus a palette,
airfield elevation and whether it has a sea — swapped behind the same `terrainHeight`
seam the flight model samples for collision, so nothing else has to know.

| World | |
| --- | --- |
| **Isles** | Rolling coastal country, open sea and scattered islands. |
| **Canyon** | A mile-deep gorge, a network of side canyons, and Monument Valley buttes. The strata are *geometry* — the height field is quantised into benches — with banded colour keyed to absolute height so layers stay level across the whole gorge. |
| **Fjords** | Sheer walls and long sea inlets. The channels come from the *zero crossings* of a noise field rather than its peaks, which is what makes them thin and winding instead of round bays. |
| **Himalaya** | A 2.9 km airstrip under 6.4 km peaks. Nothing special-cases the altitude — the thin air simply falls out of the density term, so takeoff is noticeably longer. |
| **Iceland** | Volcanic island: mossy lowlands, black lava highlands, and cratered cones under ice caps that reach unusually low. |
| **Karst** | Limestone towers over paddy, lakes and shallow bays — the one world you fly *through* rather than over. |
| **Dunes** | A sand sea of transverse dune trains, with red inselbergs, mountain massifs, pyramid groups and oasis villages. |
| **Antarctic** | Ice shelf split by black leads, tabular bergs adrift beyond the edge. Uninhabited, and flat enough to land almost anywhere. |
| **Alpine** | Glacial valleys with flat floors and 2 km walls, villages on the floor. |
| **Pacific** | Carrier operations off a tropical volcanic island. You start on the deck. |
| **Island City** | A megacity island in a broad harbour: a street grid, nineteen thousand towers, and lit windows after dark, with wooded bluffs and towns along the mainland coast beyond. The one world that is not a height field — see below. |
| **Harbour** | A megacity crushed between steep green peaks and deep water, its grid fragmenting into ribbons along the shore, and towns scattered down the coast for as far as you fly. |
| **Domes** | Granite domes standing out of a bay — flat-topped giants, slender stacks, some straight out of the water — with rolling green country between them, the city filling every gap, and settlements strung along the shore beyond. |
| **Gulf** | A supertall on a desert shore with a dune sea running in behind, and a far coast across the water with its own dunes, bare ranges and towns. |

The four newest are built almost entirely from machinery the earlier worlds already
needed, which is the point of keeping a world down to one height function:

- **Karst towers** are the volcano placement grid with a different profile. A power
  falloff gives a cone at *any* exponent — high is pointed, low is a dome with a flared
  skirt. A tower needs saturation instead: full height across most of the radius, then a
  wall in the last quarter of it, which is a smoothstep and the same shape the desert
  inselbergs use for their mesa tops.
- **Antarctic leads** are the fjord trick unchanged — `1 − |noise|` picks out a field's
  zero crossings rather than its peaks, so you get thin winding cracks instead of round
  holes. Two vein fields at different scales, because one at the fjords' settings leaves
  most of the shelf featureless.
- **Dunes** are a sum of two sines along a rotated axis, their crest lines wandering with
  a very slow noise, sharpened by a power so the troughs are wide and the crests narrow.
- **Alpine valleys** reuse the canyon's meandering centreline with a U-profile instead of
  a V. The wall has to be packed into the outer 40% of the half-width: spread across the
  whole of it, it climbs at about 30° and reads as a hillside rather than a wall.
- **Karst lakes** are pulled below sea level so the existing ocean plane fills them, which
  costs no second water surface at all. They are cut into the *plain* before the towers
  are combined in, so a tower standing in a lake still stands — that silhouette is the
  whole reason to want karst in the first place. The shoreline is a noise-warped radius:
  a circular bowl cut by a flat water plane gives a perfectly circular shore, which reads
  as a drilled hole rather than a lake.
- **Pyramids** exist twice over. As terrain they would round off into lumps at the LOD you
  see them from, so they are also an instanced mesh — one draw call for the whole map,
  with flat shading for four hard ridges meeting at a point. The height-field copy is what
  lets you fly into one: it rides the same seam as the carrier deck, combined by height,
  so the flight model treats a pyramid face as ordinary sloping ground.

**The tree line is now per-world.** It had been a fixed 420–1000 m band, which is right
for a coastline and wrong everywhere else — an alpine valley floor at 1200 m came out the
colour of high scree, so the one world built around green valleys under snow peaks
rendered uniformly grey. The dunes needed the opposite: a line high enough that the rock
tone reaches only the inselbergs rather than tinting the whole sand sea.

Season now *modifies* whatever palette a world defines rather than replacing it, so
picking winter doesn't flatten every world back to the same hills.

Each chunk's bounding sphere is fitted to the geometry's actual vertical extent. A
sphere centred on y = 0 with a fixed radius is fine while terrain stays near sea level,
but in a range whose peaks are kilometres up a summit chunk falls entirely outside its
own bounds and the renderer culls it while it is still on screen — which showed as
near-field terrain going transparent or flickering. In Himalaya that affected 37% of
chunks, overrunning by up to 1650 m.

## Rivers

Every world but the Canyon and the Dunes has one — the two that are dry on purpose.

**Rivers are traced, not sampled.** The first version generated them the way the fjord
inlets are generated: the zero crossings of a noise field, thin winding lines, nearly free
to evaluate per sample. It looked plausible in a screenshot and was wrong in flight —
measured by walking each channel outward from its lowest point, between a quarter and a
half of every river ran the wrong way. That is not a tuning problem. A bed derived from
noise climbs wherever the noise climbs, and smoothing the reference field only makes the
local maxima longer, not fewer: replacing the reference with the world's broad shape moved
the figure from 40% to 38%.

Water does not follow noise, it follows gravity, and gravity needs a *path* rather than a
field. So each river is walked downhill from a source to the sea, once per world and seed,
and the only per-sample question is "how far am I from the nearest traced segment?" — the
same shape as the villages and the airstrips: search up front into a small array, hash
grid over it, one lookup that misses almost everywhere.

The properties then fall out for free rather than being tuned for:

- **The bed descends monotonically**, because it was walked downhill. Where the trace has
  to cross a rise, the recorded bed stays level and the carve cuts through — which is what
  a river gorge is, and also what keeps the bed non-increasing by construction.
- **The channel is continuous**, because a polyline is. The noise version shattered into
  up to 1146 disconnected pieces per world with over a thousand isolated specks; the
  traced version is 2–10 pieces and **zero** specks.
- **The count is exact**, because you choose how many to trace.

Two details the tracer needs. It searches only the forward half-plane, or the walk turns
straight back the way it came the moment the ground ahead rises and collapses into a knot.
And it may push through up to 34 consecutive uphill steps — a river meeting a basin fills
it and spills over the low point, and without that allowance every trace stopped at the
first hollow, which on real terrain is a few kilometres from every source.

Where a river ends inland rather than at the coast it leaves a **tarn**: the lake it would
have filled. That is what gives the two worlds with no sea — Himalaya and Alpine — somewhere
for their water to arrive.

**There is no second water surface anywhere.** The ocean is a plane at sea level and cannot
reach a valley 1200 m up, so a river is terrain: carved into a channel, then shaded and
polished until it reads as water. Low roughness does most of that work — it lets the
channel pick up the sky through the environment map exactly as the sea does, which is why
it catches the sun instead of looking like dark paint.

Measured across the eight worlds, walking every channel from its outlet: **4–17% of steps
run against the flow**, down from 26–42%. The residual is almost all bank cells rather than
the channel floor; the floor itself cannot rise, because it was walked.

## Villages and airstrips

Every world but the Antarctic is settled — 45 to 300 villages, with 7 to 26 of them
carrying a **gravel airstrip you can land on**. The ice shelf opts out: a cluster of
pitched-roof farmhouses on sea ice would be worse than an empty one, and the shelf is
flat enough to put down on almost anywhere. Villages sit on a jittered grid, filtered to gentle ground
inside that world's habitable band. Lower the gear in flight and a tip gives you range and
relative bearing to the nearest strip.

**What makes a village visible is the farmland, not the buildings.** A house is 8–13 m
across, which is one or two pixels from a normal cruise; the first version of this had
villages you could fly straight over without noticing. Each village now clears a few
hundred metres of ground into a mosaic of ploughed earth and pasture, and *that* is what
you see from the air — hundreds of metres of colour rather than a handful of specks.

The tint is a vertex attribute on the terrain mesh, sampled per vertex during chunk build
and blended in the terrain shader. Painting it as decals on top would have been easier and
wrong: a flat patch over rolling ground has to be lifted clear of the coarse chunks that
replace it at distance, and then it floats when you fly close. Blended into the surface
itself it is correct at every LOD, for free. The tones stay near the surrounding
vegetation in *brightness* and differ in *hue* — lifting the luminance instead reads as
bleached rock, which is exactly what the first attempt looked like.

Density is set for flying, not for plausible rural population. Flying straight out from
the runway on any of 24 headings, you pass within sight of a village on 17–24 of them,
first sighting at a median of 6–29 km, and 3–11 villages per 90 km leg.

Landing needs no code in the flight model at all. The strip is a flattened pad blended
into `terrainHeight`, and `terrainHeight` *is* the collision surface — so rollout, gear
load, liftoff and crash detection all work on a village strip for the same reason they
work on the carrier deck: it is simply ground that happens to be flat.

Three details do most of the work:

- **Placement is decided once per world and seed, not per sample.** Choosing a site takes
  a dozen height evaluations, and `terrainHeight` runs ~700 times per terrain chunk across
  hundreds of chunks. Searching per sample would multiply the cost of the whole height
  field. The plan goes into a small array up front; the per-sample path is one hash-grid
  lookup that misses almost everywhere. Measured cost: **+1 to +25 ns** on a 144–273 ns
  call, and **+0.08 to +0.14 ms** on a ~1.8 ms chunk build, with no terrain holes in any
  world at any seed.
- **The graded shoulder is long — 340 m lengthwise, 210 m across.** Not for looks: a
  coarse LOD chunk may have only one vertex spanning the whole shoulder, and a long ramp
  is what keeps the rendered ground next to the runway at pad height instead of cutting
  through it.
- **A clear approach is part of the placement test.** A flat pad in the bottom of a bowl
  is not a runway. The ground on the extended centreline has to stay under a 2.5° surface
  out to 3.2 km from at least one end, and that end becomes the landing direction. The
  surface is deliberately *shallower* than the ~3° an aircraft actually flies — an
  approach surface as steep as the glide path guarantees nothing, because terrain sitting
  right on the limit is then exactly where the aeroplane wants to be.

Villages are capped at 300 and airstrips at 26 per world, chosen by a per-site rank, and
strips go to the *closest* eligible villages first — assigning them evenly across the map
sounds fairer and puts the nearest one 30 km from the runway, which is far enough that you
never find one. Habitability varies enormously — the canyon rim is a flat plateau where
nearly every candidate passes, the isles are half ocean — so where the first-choice
standard finds too little, it relaxes in tiers rather than leaving the map empty.

Verified across all ten worlds × several seeds: **every strip supports a takeoff without a
crash** (450+ strips, 405–1484 m ground roll — the long ones are Himalayan strips at 4 km
in thin air — with under 24 m of lateral drift), the pad is flat to **0.000 m** across its
whole landable footprint as sampled by the flight model, and the steepest terrain in any
approach corridor is **2.5°**. No terrain holes in any world at any seed, with chunk build
times from 2.1 ms (Canyon) to 4.1 ms (Karst — towers, lakes and rivers in one height
field). The build is time-budgeted, so the heavier worlds spill work onto later frames
rather than dropping one; the hole count is what proves that is working.

## The terrain

A continent mask decides land against sea, biased upward near the origin so the airfield
is always well inland. Land gets rolling hills plus ridged mountains away from the coast;
the sea falls to a shelf and then deep water. Roughly half the map is land, with peaks
past 1600 m and coastline about 30 km out.

Terrain is a **quadtree LOD**: chunks subdivide toward the camera down to ~256 m, are
cached by node key, and are generated against a per-frame time budget so flying never
stalls the frame. Cracks between LOD levels are hidden with skirts, and vertex normals
are evaluated analytically from the height field rather than from the mesh, which keeps
shading continuous across chunk and LOD joins instead of showing a seam at every edge.

Surfacing is a procedural splat injected into a standard PBR material — beach, grass,
scree, rock and snow blended by elevation and slope, broken up with noise at three scales
and given fine relief that fades out with distance. Because it stays a
`MeshStandardMaterial`, it still takes shadows and image-based lighting.

The sea is an ordinary PBR surface rather than a planar-reflection water shader: low
roughness so it picks up the sky through the environment map, plus a seamless procedural
wave normal map built from a sum of directional sine waves. That avoids rendering the
whole world a second time for reflections that barely register from altitude.

## Rendering

The scene is drawn **linear into a half-float target**, bloom runs on those true
HDR values, and ACES tone mapping is applied once at the end. Order matters: bloom
on already-tone-mapped colour washes the whole image instead of picking out
highlights. Anti-aliasing is MSAA on that target rather than an image-space
filter, because the hard cases here are long thin terrain silhouettes.

The bloom threshold sits well above 1.0. A sunlit landscape in this scene is
already past 1.0 in linear HDR, so a threshold near 1 blooms *everything* — the
first version rendered a white screen. At 4.0 only the sun, snow and the
afterburner bleed.

**Terrain casts shadows**, so ridges shadow valleys. The sun's shadow frustum is
sized from height above ground — tight down low where you can see detail, wider
as you climb — and its centre is snapped to whole shadow-map texels, without
which every shadow edge crawls as the aircraft moves.

**Clouds** are a cumulus deck of camera-facing billboards in a single instanced
draw call, grouped into clusters so they read as individual clouds, wrapping
toroidally around the camera so the field never runs out. They are shaded from
explicit colours rather than the scene's sun light: a deck sits *above* the
weather and stays bright even when the ground below is sunless.

Quality presets (Low → Ultra) move resolution, MSAA, bloom, shadow map size,
terrain shadow casting and cloud density together, from the Style tab.

## Start screen

The title screen plays over the sim itself: a random world, a random seed, a daylight hour,
and the aircraft hands-off in cruise with the cinematic director working the camera. Five
beats fade through the middle of frame — the wordmark, *Flight Simulator*, what the sim is,
then one sentence each on changing the world and on changing the camera — and the key list
follows them.

The beats are CSS animations rather than JavaScript, so they run on the compositor and stay
smooth while terrain chunks are still being built behind them. Three things had to be true
for that to work:

- **They start on the first painted frame, not at parse.** With `intro` in the markup the
  animations began the moment the stylesheet landed, and the title card played out over a
  black screen while the world was still being generated. `main.ts` adds the class after a
  double `requestAnimationFrame`.
- **The sequence ends on its own `animationend`, not a timer.** The CSS clock starts at the
  first frame after the class is applied; a wall-clock `setTimeout` starts immediately. While
  the world is building, that first frame can land the better part of a second late, and a
  fixed timeout then fires partway through the closing beat. The last beat reports its own
  completion instead, and the timeout survives only as a backstop.
- **The help panel is the default state.** `intro` *hides* it rather than revealing it, so a
  browser that never runs the script still lands on something useful instead of a stalled
  title card.

The type is placed against a camera it does not control. The cinematic director holds its
subject near the middle of frame, so the beats sit above the geometric centre — the aircraft
gets the lower half and crosses under the rule rather than through the wordmark. The
wordmark is `nowrap` with a viewport-scaled size that keeps its eleven tracked-out characters
on one line at any width; left to wrap it split as "HORIZON / F18", which read as a mistake.
Every line below the wordmark holds one line on a desktop too — by an explicit break where
the copy has a sentence boundary, and by measure where it does not. Left to wrap they
orphaned their last two words, and "of the day." sitting alone under a full line reads as a
mistake on a title card.

One click skips the beats and shows the keys; the next starts the flight. `H` afterwards
reopens the keys and never replays the titles.

## The airframe

Every flying surface comes out of one `panel()` helper that extrudes a trapezoid from a
root chord, a tip chord, a span and a sweep. That sharing is what makes the aircraft
consistent — and it is also what made it uniformly wrong for a long time.

The helper builds its planform in XY and then rotates it into the airframe. It rotated the
wrong way: `rotateX(-π/2)` sends the planform's +Y to **−Z**, so a positive `sweep` moved
every tip chord *forward*. Wings, leading-edge strakes, stabilators and fins were all
swept the wrong way, and because they were all wrong together the aircraft still looked
broadly plausible from most angles. What gave it away was the **ailerons floating in clear
air**: they are positioned where an aft-swept trailing edge would be, and the wing's
trailing edge had raked the other way. The fix is one sign, but it moves every surface.

The tails were three separate problems:

- **Stabilators mounted outside the aircraft.** The hinge sat at x = 1.30 where the
  fuselage is only 0.94 wide, so the root hung 30 cm clear of the body and the stabilator
  read as a loose slab flying in formation. They were also 7.6 m across against the real
  aircraft's 6.6.
- **The rudder written as independent numbers.** Its planform was authored separately from
  the fin's, so the two drifted out of register — buried inside the fin at the root and
  poking out of it at the tip. It is now *derived* from the fin by `rudderOf()`, hinged on
  the 70% chord line, so the pair cannot disagree.
- **The fin cant inverted.** Rotating about +Z by +θ carries a point that is straight up
  toward −X, so `side * 0.35` leaned the right fin *inboard*. The pair met over the spine
  in a Λ, with the right rudder's tip measuring out at x = 0.10 — all but on the
  centreline. A Hornet's fins splay outward into a V.

None of this is eyeballed. A probe walks the built model and measures it against the real
F/A-18C, which is the only way to catch a fault that is symmetric enough to look
deliberate:

| | model | F/A-18C |
|---|---|---|
| Length | 17.85 m | 17.07 m |
| Wingspan | 12.70 m | 12.31 m (with launcher rails) |
| Height | 4.67 m | 4.66 m |
| Stabilator span | 6.73 m | 6.58 m |
| Fin height | 2.20 m | 2.10 m |

The same probe asserts that every panel's tip chord is *aft* of its root, that each root
sits inside the fuselage skin at its station, and that the fin tips point outboard. Length
runs 0.78 m long because of the nozzle overhang; closing that would mean rescaling the
fuselage and re-aligning the cockpit eye point, for nothing anyone can see.

```
npm run check:airframe
```

### Keeping the camera out of the ground

The chase boom is fixed in the *aircraft's* frame — 4 m up, 17.5 m back — so pitching up
swings it down: `4·cos θ − 17.5·sin θ` is +4 m level, −0.7 m at 15° nose-up and −3.8 m at 25°.
On a takeoff rotation, where the aircraft itself is only a gear height off the runway, that
buries the lens in the tarmac. Both outside cameras now clamp to 3 m above whatever is under
them — after the follow lerp as well as before it, since easing between two points that each
clear the ground can still pass through a rise between them.

Clamping rather than shortening the boom keeps the framing intact at every other attitude.
Measured over a rotation sweep: 6.4 m level, 3.3 m at 10°, then held at exactly 3.0 m from 12°
onward instead of reaching 0.17 m at 20° and going under at 25°.

## Cockpit

The cockpit view is a modelled interior rather than a camera at the pilot's eye. It has to
be: the fuselage is a closed surface with its front faces outward, so from the inside every
one of its polygons is culled and you see straight through it — including straight down
through the belly at the ground. Whatever the pilot sees has to be modelled facing inward.

It is deliberately **minimal**: a glass canopy bow, a rail down each side, a curved
coaming, the nose of the aircraft sloping away beyond it, and a stick that moves with the
controls. Nothing else. Instrument panels, bezels, switch rows and a HUD combiner
frame all add clutter to a view whose entire job is to look out of, and every readout they
could carry is already on the HUD. Everything that is there is a swept curve — flat slabs
and rectangular frames are what made an earlier version look like scaffolding.

The bow is **glass rather than structure**. As a dark frame it read as a black rainbow
through the middle of the view — the single heaviest thing on screen in a view whose whole
job is to look out of. A tinted, rounded rail catches a highlight and marks where the
windscreen ends without blocking anything, and a shallower arc keeps its apex clear of the
sightline.

Three things decide whether the rest works, and all three are geometry rather than
detail:

- **The canopy has to sit on the fuselage, not in it.** At that station the body is already
  0.69 m tall; with the glass at 0.30 the pilot's eye ended up 9 cm *above* his own canopy,
  flying along on top of the aircraft looking down at it.
- **The coaming has to sit at the nose's own silhouette line**, about 24° below the
  sightline. Higher and it covers the nose, leaving a forward view that is a horizon and
  nothing else — the pilot could be sitting anywhere. Much lower and the eye starts to see
  *under* the nose, where the fuselage's faces are culled and the terrain shows straight
  through the aircraft.
- **The tub is not decoration.** It is the only thing stopping the view downward from
  passing through the culled belly, which is the one artefact that would give the whole
  illusion away. Checked at level flight, a shallow descent and a 42° dive.

The field of view is *narrower* here than in the outside views, not wider. A wide angle
from the eye point shrinks the canopy frame into the middle of the screen, which is the
opposite of sitting inside it.

## Cinematic camera

A fourth view (`C` cycles into it) that cuts between twenty-three setups on its own:
establishing wides, orbits high and close, cranes, a vertical rise, bird's eye, pull-back
reveals, frontal pushes, three-quarter front and rear, side profiles, a lateral dolly,
low tracking, climb reveals, wingtip and canopy close-ups, tail chase, belly rear, a nose
chase, a rising arc, an overtake and a low fly-by. The HUD hides itself and the current
setup is named in the corner; the frame stays full-window.

Every shot is a *move* — a start offset, an end offset and a focal length that changes
across it — rather than a fixed viewpoint, because a camera that only sits still reads as
a security monitor. Two families do the work:

- **Tracking** shots hold their offset in the aircraft's own frame, so the camera flies
  with it.
- **Locked** shots plant the camera in world space at the cut and leave it there. These
  are the ones that sell speed: the aircraft is the only thing moving, and the ground
  streaks past underneath it.

### The grammar

The order matters more than the contents — shuffling a good shot list still gives a
slideshow. Four rules, in the order they matter:

1. **Work the scale in one direction.** The sequence steps wide → medium → close, then
   turns round and comes back out, so a run either leads you in or leads you out rather
   than jumping about. Verified against the running build: every one of 22 consecutive
   cuts moved exactly one step.
2. **Hold the line.** Every off-axis setup is stored once and *mirrored* onto whichever
   side the sequence is currently working, so the aircraft keeps crossing frame the same
   way across a cut. The side may only change after an on-axis shot — head-on, dead
   astern, directly overhead — which is the legitimate way to cross the axis. Verified:
   zero crossings that were not off a neutral shot.
3. **Never the same setup twice running**, and never two locked shots in a row: both are
   "the aircraft flies through frame", and back to back they read as one botched shot.
4. **Cut on the scale's own beat.** Wides are held 4.8–6.4 s because they need reading;
   closes go at 3.0–4.2 s because they are one idea each.

Rule 2 needed a nudge in practice. Left purely to chance the line is *never* crossed —
measured, the camera sat on the same side for 22 cuts running, which is faithful to the
rule and monotonous. After five cuts on one side the director now steers toward an on-axis
shot, and since every scale carries at least one, there is always something to cut to.

The one non-obvious mechanic is that easing is applied to the camera's **offset**, not to
its world position. Lagging the world position looks equivalent and is not: a first-order
follow at rate *k* trailing a target moving at *v* settles at an error of *v/k*, and at
230 m/s even a fairly stiff *k* leaves the camera tens of metres behind — which turned a
26 m close-up into a distant speck. Easing the offset keeps the camera rigid with respect
to the aircraft and smooths only the move within the shot.

The camera is floored against the terrain, since several setups deliberately drop below
the aircraft and a low pass over a ridge would otherwise put the lens inside the hill.

### The title screen

The start screen plays the cinematic camera live over a **randomly chosen world and seed**
at a daylight hour, with the aircraft hands-off in cruise. Press start and you land on that
same world's runway — same seed, same weather — with the controls your own.

Its cruise altitude is taken from the highest ground along the next 60 km of track rather
than from a fixed number: cruise holds whatever altitude it is given, and a fixed one flies
into the Himalaya inside a minute. If a bad draw still puts it into a ridge, the flight is
quietly relaunched rather than showing a crash message over the title.

The overlay behind the text had to become a scrim. It was an opaque gradient, which is why
the scene it has always been rendering was never visible.

## Tips

Contextual hints appear over the HUD only while they apply and retire themselves once
acted on — no dismiss button. On the runway you get the takeoff prompt until you're fast
enough to rotate; climbing through 1000 m with the gear still down prompts you to raise
it. The gear hint is gated on *climbing*, so it stays quiet on approach when the gear is
supposed to be down.

Gear down and airborne reads as looking for somewhere to land, so that is when the
nearest village airstrip is called out with its range and relative bearing. It disappears
on touchdown and never shows while cruising with the gear up.

## In-game panel

Three tabs along the bottom of the screen:

- **World** — the terrain seed, and a button to generate a fresh landscape. The airfield
  is always flat, at the same elevation, and reliably inland whatever the seed does,
  because the radial terms that guarantee that are never seeded.
- **Style** — time of day, weather, season and graphics quality. Heavier weather means
  *more and bigger cloud*, not more haze — piling on fog to signal bad weather just greys
  the frame out and hides the landscape. Storm additionally brings rain, lightning and
  thunder. Season drives the ground palette and the snow line.
- **Controls** — manual/cruise mode, flight assists, HUD options, sensitivity, max bank
  angle, camera view and field of view. Cruise holds altitude and
  keeps the wings level between inputs. The centre HUD symbology (pitch ladder, waterline,
  flight-path marker) is **off by default** — it sits in the middle of the view and
  clutters most flying — and can be switched back on here.

The panel stops key events reaching the flight controls, so adjusting a slider with the
keyboard doesn't also fly the aircraft.

## Layout

```
src/
  core/      Engine (renderer, tone mapping, IBL), fixed-step Loop, Input
  flight/    FlightModel (6-DOF aero), Controls (assists), Aircraft (procedural jet),
             Cockpit (the modelled interior)
  world/     Terrain (height field + quadtree LOD), Worlds (the six presets),
             Settlements (villages + landable airstrips), Carrier, Ocean, Clouds,
             World (sky, sun, airfield, and what is visible per preset)
  camera/    CameraRig — chase / cockpit / orbit / cinematic
             Cinematic — the shot list and the director that sequences it
  ui/        HUD — canvas overlay, symbology derived from the camera
             Panel — bottom tabbed settings UI
  util/      math, noise
```

`terrainHeight(x, z)` in `world/Terrain.ts` is the single source of truth for ground
elevation: the flight model samples it for collision and every terrain chunk is built
from it, so the visible surface and the collision surface cannot disagree. That one seam
is why an aircraft carrier and a village airstrip are both landable without the flight
model knowing either exists.

## Status

Phases 1–3 are complete — flight core, LOD terrain, ocean, sky, weather and seasons,
HDR post-processing, terrain shadows, clouds, quality presets, camera, HUD and the
settings panel — plus six worlds, an aircraft carrier, and villages with landable
airstrips.

Still to come (Phases 4–5): engine and wind **audio** (the sim is currently silent,
probably the largest remaining gap), AI-generated PBR textures and a detailed jet
model, and speed effects like sonic booms and vapour cones.

Also still to come from the settlement work: **rivers** running from the mountains to the
sea, and **roads** linking the villages.

Known rough edges:
- The HUD overlaps itself at narrow or portrait window aspect ratios. It lays out
  correctly at ordinary widescreen sizes.
- Clouds are billboards, not a raymarched volume. They read well as a deck seen from
  above or below, but flying directly through one is less convincing than the real thing.
- Village airstrips are 920 m of flat pad. That is enough to take off from everywhere
  measured, but a fast landing will overrun the far end onto natural ground — the brakes
  in this model need roughly twice that from an approach at 180 kt.
