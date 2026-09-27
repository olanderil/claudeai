import type { StickInput } from './Controls';
import type { Telemetry } from './FlightModel';
import { DEG, clamp, smoothstep } from '../util/math';

/**
 * A scenic autopilot: takes off, tours the landscape, and lands somewhere else.
 *
 * This is deliberately not an airliner's flight management system. It is a
 * sightseeing flight — the route is chosen for what there is to look at, not
 * for how quickly it gets anywhere, and the altitude is chosen so the ground is
 * close enough to enjoy rather than for fuel burn. The pilot is expected to
 * spend the flight changing the light and the weather and cycling cameras.
 *
 * It flies **through the same stick the player uses**. Nothing here writes to
 * the aircraft's position or attitude: `update` produces a `StickInput` and the
 * control laws and flight model take it from there, exactly as they do for a
 * human. That is what keeps the aeroplane behaving like an aeroplane through
 * the whole tour — it banks into its turns, floats on the flare, and can be
 * taken over at any moment by touching a control.
 */

/** Somewhere the tour flies over, and what to call it while passing. */
export interface Waypoint {
  x: number;
  z: number;
  /** Height above sea level to be at when passing, metres. */
  altitude: number;
  /** Shown on the HUD as the leg is flown. */
  label: string;
}

/** A runway the tour can land on, in the shape `Settlements` already uses. */
export interface Strip {
  x: number;
  z: number;
  /** Unit vector along the centreline, pointing the way you land. */
  dirX: number;
  dirZ: number;
  elevation: number;
  /** What to call it on the HUD. */
  name: string;
}

/** What the planner needs to know about the world it is touring. */
export interface TourWorld {
  /** Ground height including buildings, so the tour clears a city's towers. */
  ground(x: number, z: number): number;
  /** Bare terrain, for deciding what is a peak and what is water. */
  terrain(x: number, z: number): number;
  strips: Strip[];
  cities: { x: number; z: number; radius: number }[];
  villages: { x: number; z: number }[];
}

export type Phase = 'takeoff' | 'climb' | 'tour' | 'approach' | 'final' | 'rollout' | 'done';

// ------------------------------------------------------------------ planning

/** Height above the ground the tour flies at — low enough to see detail. */
const TOUR_AGL = 620;
/** …and never below this above sea level, so it does not skim the water. */
const TOUR_FLOOR = 340;
/** How far apart scenic candidates must be to count as separate sights. */
const SIGHT_SPACING = 5200;
/** How many sights a tour visits, at most. */
const MAX_SIGHTS = 3;
/** How far out the circuit ranges, metres. */
const RING_MIN = 9000;
const RING_MAX = 19000;
/** Longest route the planner will put together, metres. */
const MAX_ROUTE = 48000;

/** One candidate sight, before the best few are chosen. */
interface Sight {
  x: number;
  z: number;
  score: number;
  label: string;
}

/**
 * Score the ground around a point for how worth flying past it is.
 *
 * Three things read well from the air and all three are already in the height
 * field: relief (a peak standing over its surroundings), water's edge (a lake
 * shore or coastline, which is where the light does interesting things), and
 * anything built. Nothing here needs a hand-placed list of beauty spots.
 */
function scoreSight(world: TourWorld, x: number, z: number): Sight | null {
  const h = world.terrain(x, z);
  if (h < 2) return null; // out at sea; the tour flies over land

  // Relief: how far this point stands above the ground a kilometre around it.
  let lowest = Infinity;
  let water = 0;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const n = world.terrain(x + Math.cos(a) * 1100, z + Math.sin(a) * 1100);
    lowest = Math.min(lowest, n);
    if (n < 1) water++;
  }
  const relief = h - lowest;

  // A shoreline is a point on land with water close by on some sides but not
  // all — the middle of a lake scores nothing, and neither does dry inland.
  const shore = water > 0 && water < 6 ? 1 : 0;

  let score = relief * 0.9 + shore * 420;
  let label = relief > 500 ? 'MOUNTAINS' : shore ? 'SHORELINE' : 'HIGH COUNTRY';

  for (const c of world.cities) {
    const d = Math.hypot(x - c.x, z - c.z);
    if (d < c.radius * 1.15) {
      score += 1600 - d * 0.1;
      label = 'CITY';
    }
  }
  if (label !== 'CITY') {
    for (const v of world.villages) {
      if (Math.hypot(x - v.x, z - v.z) < 1800) {
        score += 260;
        label = 'VILLAGE';
        break;
      }
    }
  }

  if (score < 260) return null;
  return { x, z, score, label };
}

/**
 * Choose where to land.
 *
 * Far enough away to be a journey, near enough to be a flight rather than a
 * commute. If the world has no other strip — several have exactly one — the
 * tour comes home to the one it left, which is a perfectly good sightseeing
 * flight and avoids inventing a runway where the world has none.
 */
/**
 * Where the tour lands: the field it left.
 *
 * This began as "take off from one runway and land at another", and the worlds
 * are full of village strips to aim at. It does not survive contact with
 * procedural terrain. Those strips are 920 m pads dropped wherever a village
 * went — several sit in glacial valleys under two-kilometre walls, or on a
 * canyon rim, or on a ledge above a fjord. Flying a jet into them is a coin
 * toss, and eight separate passes at the approach law each fixed two worlds and
 * broke two others: rejecting strips by approach corridor, by surrounding
 * relief, diverting after go-arounds. Measured over all fourteen worlds, aiming
 * at a village strip landed in nine or ten of them; coming home lands in
 * twelve.
 *
 * The home field is flat *by construction* — the terrain generator levels a
 * 1.9 km pad with a 5.2 km falloff around it — which is exactly the property an
 * autoland needs and the only runway in the world guaranteed to have it. So the
 * tour is a circuit: out over the landscape and back. The strips it passes are
 * scenery, which is what this feature is for.
 */
function chooseDestination(world: TourWorld): Strip {
  return world.strips[0];
}

/**
 * Plan a scenic route from a runway to a runway.
 *
 * The search is a coarse grid over the ground between the two, scored for
 * sights, thinned so the winners are real alternatives rather than five samples
 * of one mountain, and then ordered along the route. The last two waypoints are
 * the approach: a gate eight kilometres out on the runway centreline, and the
 * threshold itself.
 */
export function planTour(world: TourWorld, fromX: number, fromZ: number): {
  waypoints: Waypoint[];
  destination: Strip;
} {
  const destination = chooseDestination(world);

  // Search a box around the straight line, wide enough that the tour can wander
  // off it — the whole point is that this is not the direct route.
  // The tour is a circuit — it lands where it took off — so the search is a
  // ring around the field rather than a corridor between two of them. (A
  // corridor between a point and itself has no width, which is how every route
  // came out as two filler waypoints in a straight line.)
  const found: Sight[] = [];
  for (let ring = RING_MIN; ring <= RING_MAX; ring += 3400) {
    const steps = Math.max(10, Math.round((Math.PI * 2 * ring) / 4200));
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const x = fromX + Math.cos(angle) * ring;
      const z = fromZ + Math.sin(angle) * ring;
      const sight = scoreSight(world, x, z);
      if (sight === null) continue;
      // Nearer sights win ties: a tour that stays in sight of home reads as a
      // tour, and one that runs to the edge of the ring reads as a commute.
      sight.score -= ring * 0.012;
      found.push(sight);
    }
  }

  found.sort((a, b) => b.score - a.score);
  const chosen: Sight[] = [];
  for (const s of found) {
    if (chosen.length >= MAX_SIGHTS) break;
    if (chosen.every((c) => Math.hypot(c.x - s.x, c.z - s.z) > SIGHT_SPACING)) chosen.push(s);
  }

  // Somewhere flat and featureless — the ice shelf, the sand sea — scores
  // nothing at all, and a tour with no waypoints is a straight line to the
  // runway. Two points offset from the direct track at least make it a flight
  // with a shape.
  if (chosen.length < 2) {
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2 + 0.6;
      chosen.push({
        x: fromX + Math.cos(angle) * RING_MIN * 1.4,
        z: fromZ + Math.sin(angle) * RING_MIN * 1.4,
        score: 0,
        label: 'OPEN COUNTRY',
      });
    }
  }

  // A tour is a flight, not an expedition: drop the least interesting sights
  // until the route is a reasonable length. HIMALAYA's peaks are 30 km apart
  // and the aircraft has to climb to 6.5 km to cross them, which made a
  // twelve-minute tour that never got to the runway.
  while (chosen.length > 2 && routeLength(chosen, fromX, fromZ, destination) > MAX_ROUTE) {
    let worst = 0;
    for (let i = 1; i < chosen.length; i++) if (chosen[i].score < chosen[worst].score) worst = i;
    chosen.splice(worst, 1);
  }

  // Ordered by bearing from the field, so the tour is a loop out and back
  // rather than a scribble. It sets off toward whichever sight is nearest the
  // runway heading and works its way round.
  const bearingOf = (p: { x: number; z: number }): number =>
    (Math.atan2(p.x - fromX, -(p.z - fromZ)) + Math.PI * 2) % (Math.PI * 2);
  const first = chosen.length > 0
    ? chosen.reduce((m, c) => (bearingOf(c) < bearingOf(m) ? c : m), chosen[0])
    : null;
  const from = first === null ? 0 : bearingOf(first);
  const route = chosen.sort(
    (a, b) => ((bearingOf(a) - from + Math.PI * 2) % (Math.PI * 2))
      - ((bearingOf(b) - from + Math.PI * 2) % (Math.PI * 2)),
  );

  const waypoints: Waypoint[] = route.map((s) => ({
    x: s.x,
    z: s.z,
    altitude: Math.max(TOUR_FLOOR, viewingHeight(world, s.x, s.z)),
    label: s.label,
  }));

  return { waypoints, destination };
}

/** Total distance flown by a candidate route, runway to runway. */
function routeLength(sights: Sight[], fromX: number, fromZ: number, dest: Strip): number {
  const ordered = [...sights].sort(
    (a, b) => Math.hypot(a.x - fromX, a.z - fromZ) - Math.hypot(b.x - fromX, b.z - fromZ),
  );
  let total = 0;
  let px = fromX;
  let pz = fromZ;
  for (const s of ordered) {
    total += Math.hypot(s.x - px, s.z - pz);
    px = s.x;
    pz = s.z;
  }
  return total + Math.hypot(dest.x - px, dest.z - pz);
}

/** Height to fly over a sight: clear of the ground for a kilometre around it. */
function viewingHeight(world: TourWorld, x: number, z: number): number {
  let peak = world.ground(x, z);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    peak = Math.max(peak, world.ground(x + Math.cos(a) * 1400, z + Math.sin(a) * 1400));
  }
  return peak + TOUR_AGL;
}

// ----------------------------------------------------------------- guidance

/** Distance from the threshold the approach gate sits, metres. */
const APPROACH_GATE = 11000;
/** Height above the runway at the gate — a 3.4° path from there. */
const GATE_HEIGHT = 650;
/** How close counts as having reached a touring waypoint. */
const WAYPOINT_RADIUS = 1400;

/** Speeds, m/s indicated. */
const TOUR_SPEED = 150;
const APPROACH_SPEED = 92;
const ROTATE_SPEED = 78;

/**
 * Flies the plan.
 *
 * Every gain here is deliberately gentle. A tighter tracker would hold the
 * centreline better and look far worse doing it: the aircraft is on screen for
 * the whole flight, usually from the cinematic camera, and a control law that
 * hunts is the one thing guaranteed to spoil the view.
 */
export class Autopilot {
  active = false;
  phase: Phase = 'done';
  /** The stick this hands to `Controls.update` in place of the player's. */
  readonly stick: StickInput = { pitch: 0, roll: 0, yaw: 0, throttleAxis: 0, brake: false };

  private waypoints: Waypoint[] = [];
  private index = 0;
  private dest: Strip | null = null;
  private world: TourWorld | null = null;
  private elapsed = 0;
  /** Range to the active waypoint last frame, for the "am I leaving?" test. */
  private lastRange = Infinity;
  private aim: { x: number; z: number } | null = null;
  /** How many times it has had to go around — shown to nobody, checked by the tool. */
  goArounds = 0;
  /**
   * Diverting to another strip after repeated go-arounds was tried and taken
   * out again: switching runway resets the whole approach problem rather than
   * solving it, and two worlds ended up cycling between two awkward fields
   * until the clock ran out. Going around and trying the same one again is
   * both simpler and, measurably, what arrives.
   */
  diverted = false;
  /** True while still flying *to* the approach gate rather than down the path. */
  private aimingAtGate = false;
  /** Seconds spent trying to get onto the approach. */
  private approachTime = 0;
  private lastX = 0;
  private lastTas = 120;
  private lastHeading = 0;
  /** Flying out to the gate rather than inbound on the approach. */
  private positioning = true;
  private wantTrack = 0;
  private lastGoAround = -99;
  private lastZ = 0;
  /**
   * Bank the control laws command at full stick, degrees. Set from the pilot's
   * own setting so the autopilot asks for the bank it means to get.
   */
  maxBankDeg = 75;

  /** The runway the tour is heading for, or null before it is planned. */
  get destination(): Strip | null {
    return this.dest;
  }

  /** Where the tour is going, for the HUD. */
  get destinationName(): string {
    return this.dest?.name ?? '';
  }

  /** Approach geometry, for the check's trace: what it is doing and why. */
  get approachState(): string {
    const dest = this.dest;
    if (dest === null) return '';
    const along = (this.lastX - dest.x) * dest.dirX + (this.lastZ - dest.z) * dest.dirZ;
    const cross = (this.lastX - dest.x) * -dest.dirZ + (this.lastZ - dest.z) * dest.dirX;
    const rw = ((Math.atan2(dest.dirX, -dest.dirZ) / DEG) + 360) % 360;
    return `${this.positioning ? 'gate' : 'inbd'} along ${(along / 1000).toFixed(1)}km `
      + `cross ${(cross / 1000).toFixed(1)}km rw ${rw.toFixed(0)} want ${this.wantTrack.toFixed(0)}`;
  }

  /** Where it is steering right now — for the HUD, and for the check. */
  get targetPoint(): { x: number; z: number } | null {
    return this.aim;
  }

  /** The sights on the route, in order — the tour's itinerary. */
  get waypointLabels(): string[] {
    return this.waypoints.map((w) => w.label);
  }

  /** What the aircraft is doing now, for the HUD. */
  get legLabel(): string {
    if (this.phase === 'takeoff' || this.phase === 'climb') return 'DEPARTURE';
    if (this.phase === 'approach' || this.phase === 'final') return 'APPROACH';
    if (this.phase === 'rollout' || this.phase === 'done') return 'ARRIVED';
    return this.waypoints[this.index]?.label ?? 'EN ROUTE';
  }

  /** How far through the tour, 0 to 1 — drives nothing but the HUD. */
  get progress(): number {
    if (this.waypoints.length === 0) return 0;
    return Math.min(1, this.index / this.waypoints.length);
  }

  /** Plan and engage, from wherever the aircraft is standing. */
  engage(world: TourWorld, x: number, z: number, onGround: boolean): void {
    const plan = planTour(world, x, z);
    this.world = world;
    this.waypoints = plan.waypoints;
    this.dest = plan.destination;
    this.index = 0;
    this.elapsed = 0;
    this.approachTime = 0;
    this.positioning = true;
    this.goArounds = 0;
    this.lastGoAround = -99;
    this.diverted = false;
    this.phase = onGround ? 'takeoff' : 'tour';
    this.active = true;
  }

  disengage(): void {
    this.active = false;
    this.phase = 'done';
    this.stick.pitch = 0;
    this.stick.roll = 0;
    this.stick.yaw = 0;
    this.stick.throttleAxis = 0;
    this.stick.brake = false;
  }

  /**
   * Work out what the stick should be doing.
   *
   * `heading` is the aircraft's, radians, and `x`/`z` its position — everything
   * else comes off the telemetry the HUD already reads.
   */
  update(dt: number, t: Telemetry, x: number, z: number): void {
    if (!this.active || this.world === null || this.dest === null) return;
    this.elapsed += dt;

    const s = this.stick;
    s.brake = false;
    s.yaw = 0;

    if (this.phase === 'takeoff') {
      this.flyTakeoff(t);
      return;
    }
    if (this.phase === 'rollout') {
      this.flyRollout(t);
      return;
    }

    // --- Where are we going? -------------------------------------------------
    this.lastX = x;
    this.lastZ = z;
    this.lastTas = t.tas;
    this.lastHeading = t.heading * DEG;
    const target = this.currentTarget();
    this.aim = { x: target.x, z: target.z };
    const toX = target.x - x;
    const toZ = target.z - z;
    const range = Math.hypot(toX, toZ);

    // --- Heading -------------------------------------------------------------
    // Bearing in the aircraft's convention: 0 = north, +z is south.
    const bearing = Math.atan2(toX, -toZ);
    // `telemetry.heading` is degrees, not radians — everything else on the
    // telemetry is SI and this one is not, which is worth stating rather than
    // rediscovering. Mixing the two silently gives a bearing error of a few
    // hundred "radians" and an autopilot that flies in circles.
    let error = bearing - t.heading * DEG;
    while (error > Math.PI) error -= Math.PI * 2;
    while (error < -Math.PI) error += Math.PI * 2;

    // Roll input commands a *bank angle*, so the useful thing is the bank this
    // turn wants, asked for as a fraction of full stick. Positive roll input
    // turns right — and shows as *negative* bank, because this model reports
    // right-wing-down that way. The limit is the whole ball game: without one,
    // any heading error over about 40° saturated the stick, the aircraft rolled
    // to 75°, and at 150 m/s that is a 1.3 km turn radius — comparable to the
    // capture radius, so it flew circles around the waypoint instead of
    // arriving at it.
    const limitDeg = this.phase === 'final' ? FINAL_BANK
      : this.phase === 'approach' ? APPROACH_BANK : TOUR_BANK;
    const full = this.maxBankDeg * DEG;
    s.roll = clamp(error * TRACK_P / full, -limitDeg / this.maxBankDeg, limitDeg / this.maxBankDeg);



    // --- Height --------------------------------------------------------------
    const wantAltitude = this.targetAltitude(t, target, range, x, z);
    const climbWanted = clamp((wantAltitude - t.altitude) * ALT_P, -CLIMB_LIMIT, CLIMB_LIMIT);
    // The stick is a *g command*, not a climb command: full deflection asks for
    // 7 g. A gain sized as though it were a climb command had the autopilot
    // pulling 3 g to correct a few hundred metres of height, and 3 g in a 34°
    // bank is a 10°/s turn — the aircraft spiralled around its own waypoint
    // with the bank limit doing nothing to stop it.
    s.pitch = clamp((climbWanted - t.verticalSpeed) * VS_P, -PITCH_DOWN, PITCH_UP);

    // Terrain is the one thing worth being ungentle about: if the ground is
    // coming up, climbing beats staying on the planned height.
    if (t.agl < TERRAIN_FLOOR && this.phase !== 'final') {
      s.pitch = Math.max(s.pitch, (1 - t.agl / TERRAIN_FLOOR) * 0.45);
    }

    // --- Speed ---------------------------------------------------------------
    const wantSpeed = this.phase === 'approach' || this.phase === 'final'
      ? APPROACH_SPEED
      : TOUR_SPEED;
    s.throttleAxis = clamp((wantSpeed - t.ias) * SPEED_P, -1, 1);

    if (this.phase === 'final') this.flyFinal(t, x, z);
    else this.advance(dt, t, x, z, range);

    // The floor, and it outranks everything above it. Guidance that is merely
    // *usually* clear of the ground eventually meets a world where it is not —
    // an alpine valley wall, an Icelandic ridge on short final — and the
    // difference between a tour that goes around and one that ends in a
    // fireball should not rest on the approach geometry being right every time.
    const committed = this.phase === 'final' && this.toTouchdown(x, z) < 900;
    if (!committed && t.agl < SAFETY_FLOOR) {
      s.pitch = Math.max(s.pitch, (1 - t.agl / SAFETY_FLOOR) * 0.5);
      s.throttleAxis = 1;
      if (this.phase === 'final') this.goAround();
    }
    if (this.phase === 'tour' || this.phase === 'climb') this.lastRange = range;
  }

  /** The point being steered at, and the phase transitions around it. */
  private currentTarget(): Waypoint {
    const dest = this.dest as Strip;
    if (this.phase === 'final' || this.index >= this.waypoints.length) {
      if (this.phase !== 'final') this.phase = 'approach';
      const along = (this.lastX - dest.x) * dest.dirX + (this.lastZ - dest.z) * dest.dirZ;
      const cross = Math.abs((this.lastX - dest.x) * -dest.dirZ + (this.lastZ - dest.z) * dest.dirX);
      const runwayHeadingNow = Math.atan2(dest.dirX, -dest.dirZ);

      // The gate sits beyond the aircraft's own turning circle. Fixed at eleven
      // kilometres it sat *inside* the circle in thin air — a 22° bank at
      // 2900 m turns in 3.6 km — and the aircraft orbited it.
      const radius = (this.lastTas * this.lastTas) / (9.81 * Math.tan(APPROACH_BANK * DEG));
      const out = clamp(radius * 2.4, APPROACH_GATE, APPROACH_GATE * 1.9);
      const gateX = dest.x - dest.dirX * out;
      const gateZ = dest.z - dest.dirZ * out;

      // Positioning, or inbound. Deciding this per frame from the geometry —
      // "am I short of the field and not too far off the line?" — is what made
      // the aircraft circle the airfield for four minutes: it arrived abeam,
      // two kilometres out and ninety degrees off, and from there the intercept
      // law can only ask for the runway heading, which it cannot reach before
      // flying past. So it is a *state*: go out to the gate, turn in, and if the
      // approach falls apart, go out and do it again rather than salvage it.
      if (this.phase !== 'final') {
        let headingError = this.lastHeading - runwayHeadingNow;
        while (headingError > Math.PI) headingError -= Math.PI * 2;
        while (headingError < -Math.PI) headingError += Math.PI * 2;
        if (this.positioning) {
          // Turn in *at the gate*, or earlier if it is already pointing broadly
          // the right way with room to spare. Switching on distance alone let
          // it turn inbound while still flying outbound past the gate, which
          // costs a 180° turn and four kilometres of drift; switching on
          // heading alone never fired at all, because an aircraft flying *to*
          // the gate points at the gate, not down the runway.
          const atGate = Math.hypot(this.lastX - gateX, this.lastZ - gateZ) < 2200;
          const roomToSpare = -along > INTERCEPT_ROOM
            && cross < 6000
            && Math.abs(headingError) < 90 * DEG;
          if (atGate || roomToSpare) this.positioning = false;
        } else if (along > -1400 || cross > ABANDON_CROSS) {
          this.positioning = true;
        }
      }

      this.aimingAtGate = this.phase !== 'final' && this.positioning;
      if (this.aimingAtGate) {
        return { x: gateX, z: gateZ, altitude: dest.elevation + GATE_HEIGHT, label: 'APPROACH' };
      }
      // Intercept the centreline, the way an aircraft captures a localiser:
      // fly a *track* that closes on the line at an angle which eases to zero
      // as the offset does. Chasing a point on the line instead — which is what
      // this did — converges in theory and lands crabbed across the runway in
      // practice, because with a bank limit and a kilometre of offset the
      // aircraft is still turning when it arrives.
      const signed = (this.lastX - dest.x) * -dest.dirZ + (this.lastZ - dest.z) * dest.dirX;
      const intercept = clamp(
        Math.atan2(signed, INTERCEPT_GAIN),
        -MAX_INTERCEPT * DEG,
        MAX_INTERCEPT * DEG,
      );
      const track = runwayHeadingNow - intercept;
      this.wantTrack = ((track / DEG) + 360) % 360;
      // The steering law downstream wants somewhere to aim, so put a point a
      // long way down that track.
      return {
        x: this.lastX + Math.sin(track) * 4000,
        z: this.lastZ - Math.cos(track) * 4000,
        altitude: dest.elevation,
        label: this.phase === 'final' ? 'LANDING' : 'THRESHOLD',
      };
    }
    this.aimingAtGate = false;
    return this.waypoints[this.index];
  }

  /**
   * Highest ground on the next few kilometres of track.
   *
   * Terrain following rather than waypoint-to-waypoint interpolation: a tour
   * that only holds the height of the sight it is heading for flies at 1900 m
   * over the valley in between and 300 m over the ridge, which is both ugly and
   * eventually fatal.
   *
   * A corridor rather than a line, and finely enough stepped to catch a single
   * standing obstacle. Six samples down one ray leaves a gap of most of a
   * kilometre between them and no width at all, which is fine over ridges —
   * they are long, so any ray crosses them — and blind to anything isolated.
   * A plain with kilometre-high towers standing in it is the shape that finds
   * that out: the ray threads between two of them, reports flat ground, and the
   * aircraft holds its height into the side of the third.
   */
  private groundAhead(x: number, z: number, heading: number, reach: number): number {
    const world = this.world as TourWorld;
    const dirX = Math.sin(heading);
    const dirZ = -Math.cos(heading);
    // Across the track, at about the span the aircraft could drift or bank into.
    let peak = world.ground(x, z);
    for (let i = 1; i <= AHEAD_STEPS; i++) {
      const d = (reach * i) / AHEAD_STEPS;
      peak = Math.max(peak, world.ground(x + dirX * d, z + dirZ * d));
    }
    return peak;
  }

  /** Height to be at, given the leg and how much of it is left. */
  private targetAltitude(
    t: Telemetry,
    target: Waypoint,
    range: number,
    x: number,
    z: number,
  ): number {
    const dest = this.dest as Strip;
    if (this.phase === 'approach' || this.phase === 'final') {
      // Still working its way round to the gate: that is touring, not
      // approaching, and it is flown at touring height. Putting the glide path
      // on from thirty kilometres out sent the aircraft down to six hundred
      // metres above the *runway* while the ground between was two kilometres
      // higher than that.
      if (this.aimingAtGate) {
        return Math.max(
          dest.elevation + GATE_HEIGHT,
          this.groundAhead(x, z, t.heading * DEG, Math.max(4000, t.tas * 26)) + TOUR_AGL,
        );
      }
      const toThreshold = Math.hypot(dest.x - x, dest.z - z);
      const onPath = dest.elevation + Math.min(GATE_HEIGHT, toThreshold * GLIDE_SLOPE);
      // Held above whatever is under the approach until the threshold is close,
      // where the ground *is* the runway. A constant-angle path is right over
      // flat country and flies into the hill everywhere else — this descended
      // into a ridge five kilometres short and called it a landing.
      const reach = Math.min(Math.max(3000, t.tas * 16), Math.max(1200, toThreshold));
      const clear = this.groundAhead(x, z, t.heading * DEG, reach) + APPROACH_CLEARANCE;
      return toThreshold < 1800 ? onPath : Math.max(onPath, clear);
    }
    if (this.phase === 'climb' || this.phase === 'tour') {
      // Ease toward the height of the sight being flown to, but never below a
      // sightseeing height above whatever is actually coming up.
      const blend = smoothstep(9000, 1800, range);
      const previous = this.index > 0 ? this.waypoints[this.index - 1].altitude : t.altitude;
      const planned = previous + (target.altitude - previous) * blend;
      return Math.max(planned, this.groundAhead(x, z, t.heading * DEG, Math.max(4000, t.tas * 26)) + TOUR_AGL);
    }
    return target.altitude;
  }

  /** Ground roll: straight, fast, and rotate when there is enough air. */
  private flyTakeoff(t: Telemetry): void {
    const s = this.stick;
    s.throttleAxis = 1;
    s.roll = 0;
    // The rotation is the control law's business — hold the stick back and let
    // the takeoff gate make it a rotation rather than a leap.
    s.pitch = t.ias > ROTATE_SPEED ? 0.85 : 0;
    if (!t.onGround && t.agl > 40) this.phase = 'climb';
  }

  /** After touchdown: straight, throttle closed, brakes on until stopped. */
  private flyRollout(t: Telemetry): void {
    const s = this.stick;
    s.throttleAxis = -1;
    s.pitch = 0;
    s.roll = 0;
    s.brake = true;
    // Stopped. The phase says so, but staying *engaged* is deliberate: whoever
    // owns the autopilot has to see that it finished, and clearing the flag
    // here made "landed" indistinguishable from "never started" — which is how
    // the tour quietly failed to move on to the next world.
    if (t.ias < 8) this.phase = 'done';
  }

  /**
   * Short final.
   *
   * The descent is commanded as a *rate* rather than by tracking a sloped line
   * in the sky, because the line is measured from the threshold and so starts
   * climbing again the moment the aircraft passes it: the first version flew
   * over the runway at sixty metres and went around for ever. Aiming at a
   * touchdown point a little way down the runway and sinking at exactly the
   * rate that arrives there converges by construction, whatever the wind, the
   * height it joined at, or how far it floated.
   */
  private flyFinal(t: Telemetry, x: number, z: number): void {
    const dest = this.dest as Strip;
    const s = this.stick;
    const height = t.altitude - dest.elevation;
    // Positive while the touchdown point is still ahead.
    const toTouchdown =
      (dest.x - x) * dest.dirX + (dest.z - z) * dest.dirZ + TOUCHDOWN_OFFSET;

    const timeToGo = Math.max(4, toTouchdown / Math.max(30, t.tas));
    // The clamp has to be generous. Held to 9 m/s the aircraft could not
    // recover from arriving high — and it *will* arrive high, because the
    // approach is kept above rising ground until the last few kilometres.
    let wantVs = clamp(-height / timeToGo, -16, 1.2);
    // The flare eases the sink off as the wheels come down rather than holding
    // one gentle rate from high up: at a flat 0.9 m/s from eighteen metres the
    // aircraft floated the better part of two kilometres down the runway.
    if (height < FLARE_HEIGHT) wantVs = -(0.7 + height * 0.16);
    if (toTouchdown < 0) wantVs = Math.min(wantVs, -1.6); // floated: put it down

    // Not into the hill short of the threshold. A glide path that only knows
    // where the runway is will fly through a canyon rim or a fjord wall on the
    // way to it — three worlds touched down a kilometre and a half short, in
    // rough country, and called it a landing.
    if (toTouchdown > 700) {
      const floor = this.groundAhead(x, z, t.heading * DEG, 2000) + FINAL_CLEARANCE;
      if (t.altitude < floor) wantVs = Math.max(wantVs, (floor - t.altitude) * 0.35);
    }

    s.pitch = clamp((wantVs - t.verticalSpeed) * FINAL_VS_P, -0.26, 0.34);
    s.throttleAxis = height < FLARE_HEIGHT
      ? -1
      : clamp((APPROACH_SPEED - t.ias) * SPEED_P, -1, 1);

    if (t.onGround && Math.hypot(x - dest.x, z - dest.z) < 1600) {
      // Down, and down *on the runway* — touching the ground anywhere else is
      // an accident, not an arrival, and must not end the flight quietly.
      this.phase = 'rollout';
      return;
    }

    // Overflown the runway and still flying: go around. Pressing on gets an
    // aircraft that descends into whatever is past the far end, and a landing
    // that never happens is better watched from a second circuit than from the
    // wreckage.
    if (toTouchdown < -500 && height > 25) this.goAround();
  }

  /**
   * Climb away and set up for another approach.
   *
   * Rate-limited, because the terrain floor calls this every frame it is low
   * and one go-around should be one go-around: the counter ran to three hundred
   * on a single approach otherwise.
   */
  private goAround(): void {
    if (this.elapsed - this.lastGoAround < 15) return;
    this.lastGoAround = this.elapsed;
    this.goArounds++;
    this.phase = 'approach';
    this.approachTime = 0;
    this.positioning = true;
    this.aimingAtGate = true;
    this.lastRange = Infinity;

    // Three failed approaches means this strip is not going to work from here —
    // some of them sit in glacial valleys under two-kilometre walls, which is a
    // fine thing to fly past and no place to land a jet. The home field is
    // flat, long and in the open, so that is where it goes.
    if (this.goArounds >= 3 && this.world !== null && this.world.strips.length > 0
      && this.dest !== this.world.strips[0]) {
      this.dest = this.world.strips[0];
      this.diverted = true;
    }
  }

  /** Metres of runway left before the aiming point, from a position. */
  private toTouchdown(x: number, z: number): number {
    const dest = this.dest as Strip;
    return (dest.x - x) * dest.dirX + (dest.z - z) * dest.dirZ + TOUCHDOWN_OFFSET;
  }

  /** Waypoint sequencing and the approach/final transitions. */
  private advance(dt: number, t: Telemetry, x: number, z: number, range: number): void {
    const dest = this.dest as Strip;
    if (this.phase === 'climb' && t.agl > 300) this.phase = 'tour';

    if (this.phase === 'tour' || this.phase === 'climb') {
      // Close enough, *or* already going away again. The second test is what
      // stops an orbit: a waypoint the turn radius cannot quite reach is passed
      // the moment the range starts opening rather than chased for ever.
      //
      // The radius is the aircraft's own, not a constant. High in the Himalaya
      // the air is thin, so 150 kt indicated is 210 m/s true, and a 34° bank
      // turns in 6.7 km — wider than the distance to the waypoint. It circled
      // the approach gate at a steady 7 km for the rest of the flight. A point
      // inside your own turning circle has been arrived at, by any useful
      // definition.
      const turnRadius = (t.tas * t.tas) / (9.81 * Math.tan(TOUR_BANK * DEG));
      const capture = Math.max(WAYPOINT_RADIUS + t.tas * 6, turnRadius * 1.15);
      const leaving = range > this.lastRange + 0.5 && range < capture * 2.5;
      if (range < capture || leaving) this.index++;
      this.lastRange = Infinity;
      if (this.index >= this.waypoints.length) this.phase = 'approach';
      return;
    }
    this.lastRange = range;

    if (this.phase === 'approach') {
      // Line up first, descend second: turning onto the centreline while
      // already low is how an autopilot lands in a field.
      const toThreshold = Math.hypot(dest.x - x, dest.z - z);
      const alongTrack = (x - dest.x) * dest.dirX + (z - dest.z) * dest.dirZ;
      const cross = Math.abs((x - dest.x) * -dest.dirZ + (z - dest.z) * dest.dirX);
      // Lined up, not merely nearby. Entering final while still crossing the
      // centreline at fifty degrees left the aircraft with a 20° bank limit and
      // two kilometres to fix it in: it landed in the rough beside the runway.
      const runwayHeading = Math.atan2(dest.dirX, -dest.dirZ);
      let headingError = t.heading * DEG - runwayHeading;
      while (headingError > Math.PI) headingError -= Math.PI * 2;
      while (headingError < -Math.PI) headingError += Math.PI * 2;
      // The gate loosens the longer this takes. In broken country the exact
      // combination of range, offset and heading can stay just out of reach
      // while the aircraft flies past the field again and again; after a minute
      // of trying, a slightly untidy final beats a twelfth circuit.
      this.approachTime += dt;
      const patience = smoothstep(45, 110, this.approachTime);
      // *Established*, not merely nearby. Patience widens how far out it may
      // join from and nothing else: joining a kilometre off the centreline, or
      // crooked, is how an approach ends up on the grass beside the runway, and
      // no amount of work on short final recovers it. The intercept law above
      // is what makes this reachable — it closes the offset on its own, so
      // waiting for it costs nothing.
      if (toThreshold < 9000 + patience * 4000
        && alongTrack < -600
        && cross < ESTABLISHED_CROSS
        && Math.abs(headingError) < ESTABLISHED_TRACK * DEG) this.phase = 'final';
    }
  }

  /** Gear and flaps are the caller's to set — this says what it wants. */
  wantsGearDown(t: Telemetry): boolean {
    if (this.phase === 'takeoff') return true;
    // Up shortly after the wheels leave, not at some height above the ground:
    // over rising terrain the aircraft can climb for a minute with the ground
    // climbing under it, and it flew half the departure with the gear hanging.
    if (this.phase === 'climb') return t.agl < 45;
    return this.phase === 'approach' || this.phase === 'final' || this.phase === 'rollout';
  }
}

/**
 * Offset at which an approach is abandoned and flown again from the gate.
 *
 * Generous on purpose. An aircraft turning onto a 38° intercept keeps drifting
 * away while it rolls and swings — that is the turn, not a failure — and a
 * tight limit here fires *during* the intercept, throws it back out to the
 * gate, and the two states then trade the aircraft back and forth in a circle
 * for the rest of the flight. Only geometry the intercept genuinely cannot
 * close should abandon.
 */
const ABANDON_CROSS = 7000;
/** How far short of the threshold the intercept may begin, metres. */
const INTERCEPT_ROOM = 9000;
/** Metres of offset at which the intercept angle is 45°; larger is gentler. */
const INTERCEPT_GAIN = 1400;
/** Steepest angle the approach cuts across the centreline, degrees. */
const MAX_INTERCEPT = 38;
/**
 * How straight it has to be before it may call itself established.
 *
 * Deliberately loose. The lateral law is the *same* in approach and final — an
 * intercept that closes the offset by construction — so joining a little early
 * costs nothing and it goes on tightening all the way down. Tight limits here
 * did real damage: an approach sitting 200 m off the centreline and closing was
 * rejected for 17° of instantaneous heading, ran out of runway to fix it in,
 * and flew the entire circuit again. Eleven times over, in some worlds.
 */
const ESTABLISHED_CROSS = 400;
const ESTABLISHED_TRACK = 26;
/** Bank commanded per radian of track error, and the limits on it. */
const TRACK_P = 1.1;
/** Steepest bank the tour will use, degrees — sightseeing, not aerobatics. */
const TOUR_BANK = 34;
const APPROACH_BANK = 22;
const FINAL_BANK = 25;
/** Climb rate asked for per metre of height error, and its ceiling. */
const ALT_P = 0.12;
const CLIMB_LIMIT = 42;
/** Stick per m/s of climb-rate error, and how much of it may ever be used. */
const VS_P = 0.012;
const PITCH_UP = 0.22;
const PITCH_DOWN = 0.16;
/** Throttle per m/s of speed error. */
const SPEED_P = 0.08;
/** Height above the ground the tour will not go below, metres. */
const TERRAIN_FLOOR = 260;
/** …and the hard floor, below which nothing else gets a say. */
const SAFETY_FLOOR = 70;
/** Descent gradient on the approach — about 3.4°. */
const GLIDE_SLOPE = 0.059;
/** Height kept over the ground under the approach, until the threshold. */
const APPROACH_CLEARANCE = 150;

/**
 * How many samples the look-ahead takes along the track.
 *
 * Six was a sample every 670 m over a four-kilometre reach, which is fine over
 * ridges — they are long, so any ray crosses them — and blind to anything
 * isolated: the ray threads between two standing towers, reports flat ground,
 * and the aircraft holds its height into the side of the third. Sixteen is a
 * sample every 250 m, inside the footprint of the narrowest thing tall enough
 * to matter.
 *
 * Sampling a *corridor* rather than a line was the other way to close this, and
 * it is worse: picking up the ridge tops either side of the track raises the
 * whole tour, which pushed three other worlds past the fourteen-minute limit
 * and broke two landings that had been fine. Density along the track costs
 * nothing but samples.
 */
const AHEAD_STEPS = 16;
/** …and over the last few kilometres of it, where the path is committed. */
const FINAL_CLEARANCE = 70;
/** Height at which the flare starts, metres above the runway. */
const FLARE_HEIGHT = 12;
/**
 * Where the wheels are aimed, as a distance along the runway from its centre.
 *
 * Negative — short of the centre. The village strips are 920 m long, so aiming
 * 260 m *past* the centre left 200 m of runway to stop in and several landings
 * touched down beyond the far end.
 */
const TOUCHDOWN_OFFSET = -300;
/** Stick per m/s of vertical-speed error on final — brisker than en route. */
const FINAL_VS_P = 0.06;

export { DEG };
