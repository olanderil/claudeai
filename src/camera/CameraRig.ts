import * as THREE from 'three';
import { clamp, damp, moveTowards, smoothstep } from '../util/math';
import {
  CinematicDirector, slerpDirection,
  type ShotTweak, type ShotSlot, type LandmarkTarget,
} from './Cinematic';
import type { CameraSubject, CameraTelemetry, CombatBody, CombatContext } from './Subject';

export type { CameraSubject, CameraTelemetry, CombatBody, CombatContext } from './Subject';

export type CameraMode = 'chase' | 'cockpit' | 'target' | 'orbit' | 'cinematic' | 'free' | 'director';

/**
 * What the orbit sliders may ask for: metres, metres, and revolutions/minute.
 *
 * Exported so the bar's `min`/`max` and the rig's clamp are the same numbers.
 * Sized for a scout eight and a half metres across: six metres is a wingtip's
 * breadth off the airframe, a hundred and twenty is a machine small in a wide
 * frame.
 */
export const ORBIT_LIMITS = {
  distance: [6, 120] as const,
  height: [-15, 60] as const,
  rate: [0, 8] as const,
};

// Order matters twice over: it is the order of the picker in the Controls tab
// and the order the camera key cycles through. The target view sits straight
// after the cockpit because the two are the fighting views; Director sits
// directly after Cinematic because it is the same view with the controls
// exposed, and Free is last because it stops following the aeroplane at all.
export const CAMERA_MODES: CameraMode[] =
  ['chase', 'cockpit', 'target', 'orbit', 'cinematic', 'director', 'free'];

/** Least air an outside camera keeps between itself and the ground, metres. */
const CAMERA_MIN_CLEARANCE = 2.0;

/**
 * Chase boom at the reference scale: up, and back, metres — and the point
 * ahead of the nose it looks at. Back far enough for a scout to fill about
 * half the width of the frame, which is what a jet at seventeen metres did.
 */
const CHASE_UP = 2.3;
const CHASE_BACK = 10.5;
const CHASE_LOOK_UP = 0.9;
const CHASE_LOOK_AHEAD = 7;
/** How quickly the boom swings round after the aircraft's attitude, 1/s. */
const CHASE_SWING = 5;

/**
 * Target view at the reference scale: how far behind the player on the line
 * from the target, and how far above that line. Nineteen degrees of elevation
 * lifts the bandit clear of the top wing in the picture even with the player
 * standing on a wingtip in a 60° turn, which sweeps the upper wing a good
 * eighteen degrees up the frame.
 */
const TARGET_BACK = 12.5;
const TARGET_UP = 4.3;
/** Most the target line is allowed to climb or dive, radians (70°). */
const TARGET_MAX_ELEVATION = 1.22;
/** How far from the player toward the target the aim sits, as a fraction of the angle. */
const TARGET_AIM = 0.58;
/** Fastest the target line turns, rad/s of arc: a swing, never a whip. */
const TARGET_TURN = 3.2;
/** Seconds to ease between the chase and the target view as targets come and go. */
const TARGET_EASE = 1.1;

/**
 * How much of a jolt from `addShake` reaches a camera riding the aircraft. At
 * this, a solid hit (1) rocks the view about half a degree.
 */
const IMPULSE_GAIN = 2.2;

/** Cockpit near plane: the gunsight and windscreen are a hand's width away. */
const COCKPIT_NEAR = 0.05;
/** How far the pilot's head may turn and nod, radians. */
const HEAD_YAW = 2.6;
const HEAD_PITCH_DOWN = -0.55;
const HEAD_PITCH_UP = 1.35;

/**
 * Camera behaviour for each view.
 *
 * The chase camera swings rather than lags. It used to trail the aircraft's
 * *position* with a first-order follow, which at a jet's speed sat thirty
 * metres behind the boom; at a scout's size even the seven metres that makes
 * at fifty metres a second is most of the shot. Now the boom is rigid to the
 * aeroplane and only its *attitude* is eased, so a hard turn swings the camera
 * out and shows the bank, and a little speed-driven surge drops it back when
 * the aeroplane accelerates. Its up-vector only partially follows the roll —
 * fully rolling with the aircraft is disorienting, not rolling at all feels
 * detached.
 */
export class CameraRig {
  mode: CameraMode = 'chase';

  /** Near plane used outside the cockpit, metres. */
  defaultNear = 0.5;

  /**
   * Whether a kill takes the camera away from the outside player views (chase,
   * target, orbit) for the kill cam. Off by default: in a dogfight the pilot's
   * view is the pilot's. The cinematic view always shows kills.
   */
  killCamOutside = false;

  private readonly position = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  private readonly _desired = new THREE.Vector3();
  private readonly _lookAt = new THREE.Vector3();
  private readonly _aircraftUp = new THREE.Vector3();
  private readonly _blendUp = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _shakeEuler = new THREE.Euler();
  private readonly _shakeQuat = new THREE.Quaternion();
  private readonly _flyby = new THREE.Vector3();
  private readonly _miss = new THREE.Vector3();
  private readonly _step = new THREE.Vector3();
  private readonly _v1 = new THREE.Vector3();
  private readonly _v2 = new THREE.Vector3();
  private readonly _v3 = new THREE.Vector3();
  private readonly _v4 = new THREE.Vector3();
  private readonly _m = new THREE.Matrix4();

  /** The aircraft the cameras are following. */
  private subject: CameraSubject | null = null;
  /** The fight as main.ts last described it. */
  private readonly combat: CombatContext = { target: null, threat: null };

  private orbitAngle = 0;
  /**
   * What the orbit camera does, all four of it.
   *
   * `distance` and `height` are metres at rest; the ring still widens a little
   * with airspeed on top of `distance`. `rate` is revolutions per minute and
   * `direction` is +1 for clockwise seen from above.
   */
  readonly orbit = { distance: 16, height: 4, rate: 2.5, direction: 1 };
  /** Eased orbit offset from the aircraft — the ring, not the world position, is smoothed. */
  private readonly orbitOffset = new THREE.Vector3();
  private fov = 60;
  /** Field of view before the speed-driven widening, degrees. */
  private baseFov = 60;
  private initialised = false;

  // ---------------------------------------------------------------- shake
  /** Smooth low-frequency shake — buffet, hits, ground rush. Damped. */
  private rumble = 0;
  /** High-frequency buzz — the engine and the guns. Damped. */
  private buzz = 0;
  /** Impulses from `addShake`, decaying. */
  private impulse = 0;
  private shakeClock = 0;
  /** Engine power 0..1 from main.ts, or null to guess from the telemetry. */
  private enginePower: number | null = null;
  private engineRotary = true;
  private gunfire = false;

  // ---------------------------------------------------------------- chase
  /** Eased copy of the aircraft's attitude, for the chase boom's swing. */
  private readonly chaseQuat = new THREE.Quaternion();
  /** Slow copy of the airspeed; the difference is the surge. */
  private chaseTas = 0;

  // -------------------------------------------------------------- cockpit
  private readonly cockpitQuat = new THREE.Quaternion();
  private headYaw = 0;
  private headPitch = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private padlock = false;
  /** Which shoulder the padlock is looking over: +1 left, −1 right, 0 not yet. */
  private padlockSide = 0;

  // --------------------------------------------------------------- target
  /** Damped direction from the player toward the target, and its parts. */
  private readonly tgtDir = new THREE.Vector3(0, 0, -1);
  private tgtAz = Math.PI;
  private tgtEl = 0;
  /** Damped camera up for the target view. */
  private readonly tgtUp = new THREE.Vector3(0, 1, 0);
  /** Damped direction the target view is lifted off the line in. */
  private readonly tgtOff = new THREE.Vector3(0, 1, 0);
  /** Where the target was last seen, for easing back out to the chase. */
  private readonly tgtLast = new THREE.Vector3();
  private tgtKnown = false;
  /** 0 is the chase view, 1 is the target view; eased between. */
  private tgtBlend = 0;
  /** Field of view the target view needed to hold both, eased. */
  private tgtFit = 0;

  /** Kill cam playing in an outside view, so the view knows to snap back after. */
  private killOutside = false;

  private readonly director = new CinematicDirector();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    /** Terrain sampler, so the cinematic camera never ends up underground. */
    private readonly groundHeight: (x: number, z: number) => number = () => -Infinity,
  ) {}

  /**
   * Reshape the orbit. Every value is clamped here rather than trusted from the
   * UI, because the same numbers come back off disk from a previous session.
   */
  setOrbit(next: Partial<{ distance: number; height: number; rate: number; direction: number }>):
  void {
    // NaN survives a plain clamp — every comparison against it is false — and a
    // NaN radius puts the camera at no position at all, which renders as a
    // black frame that nothing on the bar can recover from.
    const set = (v: number | undefined, [lo, hi]: readonly [number, number], now: number) =>
      (v === undefined || !Number.isFinite(v) ? now : Math.min(hi, Math.max(lo, v)));
    this.orbit.distance = set(next.distance, ORBIT_LIMITS.distance, this.orbit.distance);
    this.orbit.height = set(next.height, ORBIT_LIMITS.height, this.orbit.height);
    this.orbit.rate = set(next.rate, ORBIT_LIMITS.rate, this.orbit.rate);
    // Reversing mid-circle keeps the angle: the camera turns around from where
    // it is rather than jumping to the mirrored side of the aircraft.
    if (next.direction !== undefined) this.orbit.direction = next.direction < 0 ? -1 : 1;
  }

  /** Name of the running setup, or null in the views the director does not drive. */
  get shotName(): string | null {
    return this.directing() ? this.director.shotName : null;
  }

  cycle(): CameraMode {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
    this.initialised = false;
    this.handBack();
    this.director.cancelKill();
    this.director.reset();
    return this.mode;
  }

  /**
   * Leaving the director gives the camera back to the sequence. The cinematic
   * camera is the hands-off one; it must never come up pinned.
   */
  private handBack(): void {
    if (this.mode === 'director') return;
    this.director.setPinned(false);
    if (this.reelOn) this.stopReel();
  }

  /**
   * Drop every bit of smoothing and tracking, for one frame.
   *
   * Needed whenever the aircraft is moved discontinuously (reset, respawn,
   * another subject) — otherwise the camera spends seconds flying across the
   * map to catch up, a planted free camera watches the spot the aeroplane left,
   * and the target view swings in from wherever the last bandit was.
   */
  snap(): void {
    this.initialised = false;
    this.director.cancelKill();
    this.director.reset();
    this.killOutside = false;
    this.freeTrackKnown = false;
    this.freeTrack.set(0, 0, 0);
    this.freeAnchored = false;
    this.freeReshape = false;
    this.freeSpinAz = 0;
    this.freeSpinEl = 0;
    this.freeYawKnown = false;
    this.tgtKnown = false;
    this.tgtFit = 0;
    this.rumble = 0;
    this.buzz = 0;
    this.impulse = 0;
    this.headYaw = this.lookYaw;
    this.headPitch = this.lookPitch;
  }

  /**
   * Follow a different aircraft.
   *
   * The old one gets its cockpit hidden again — it may be flying on as an AI
   * machine, and an interior drawn through its fuselage would be visible from
   * everywhere — and everything is snapped, because a new subject is a cut.
   * `update` calls this itself when handed a different subject, so this is
   * only needed to switch ahead of the next frame.
   */
  setSubject(subject: CameraSubject | null): void {
    if (subject === this.subject) return;
    if (this.subject !== null) this.subject.setCockpitVisible(false);
    this.subject = subject;
    this.snap();
  }

  /** The aircraft currently followed, if any. */
  get currentSubject(): CameraSubject | null {
    return this.subject;
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.initialised = false;
    this.handBack();
    this.director.cancelKill();
    this.director.reset();
  }

  get fieldOfView(): number {
    return this.baseFov;
  }

  setFieldOfView(deg: number): void {
    this.baseFov = clamp(deg, 40, 110);
  }

  /** What the cinematic director frames against — see `CinematicDirector`. */
  setDirectorContext(
    sun: THREE.Vector3,
    landmark: THREE.Vector3 | null,
    structure: LandmarkTarget | null,
    agl: number,
  ): void {
    this.director.setContext(sun, landmark, structure, agl);
  }

  /**
   * The fight: the enemy being fought or locked, and the most dangerous one on
   * the player's tail. Call every frame (or whenever either changes); the
   * vectors are held by reference and read afresh each frame.
   */
  setCombatContext(ctx: CombatContext): void {
    this.combat.target = ctx.target;
    this.combat.threat = ctx.threat;
    this.director.setCombat(this.combat);
  }

  /** Whether a landmark tripod has anything to stand on — see the shot picker. */
  landmarkTripodReady(): boolean {
    return this.director.tripodReady();
  }

  /** Cut to a named setup: the shot picker, and the dev console. */
  forceShot(name: string): boolean {
    if (this.reelOn) this.stopReel();
    return this.director.force(name);
  }

  // ------------------------------------------------------------- the free camera
  /**
   * Free camera state: where you have dragged it to.
   *
   * Spherical, around the aircraft, in the aircraft's *yaw* frame — so the
   * aeroplane holds its place in the frame and the world turns underneath it.
   * The distance is in reference-scout units: a bomber is framed as a scout is.
   */
  private freeAzimuth = Math.PI; // behind
  private freeElevation = 0.2;
  private freeDistance = 14;
  /** Aim offset from the aircraft, metres, from a shift-drag. */
  private readonly freeAim = new THREE.Vector3();
  private freeWorldLocked = false;
  /**
   * Where a world-locked camera is standing: a *place*, chosen *ahead* of the
   * aircraft, so the aeroplane flies at the lens, whips past it, and shrinks
   * away behind.
   */
  private readonly freeAnchor = new THREE.Vector3();
  private freeAnchored = false;
  /**
   * A drag or a wheel has asked for a different angle on the shot in progress
   * — "same shot, seen from over here", not "give me another shot".
   */
  private freeReshape = false;
  /**
   * Which way the aircraft is actually going, as a direction — not where its
   * nose points, and deliberately not a speed. A fly-by has to be planted on
   * the path the aeroplane will fly, and `tas` already carries the speed.
   */
  private readonly freeTrack = new THREE.Vector3();
  private readonly freeLastPos = new THREE.Vector3();
  private freeTrackKnown = false;
  /** Whether a plain drag reframes instead of orbiting. */
  private freeReframe = false;
  /** Damped copy of the aircraft's heading, so gusts do not reach the frame. */
  private freeYaw = 0;
  private freeYawKnown = false;
  /** Velocity carried between frames, so the drag has some weight. */
  private freeSpinAz = 0;
  private freeSpinEl = 0;

  /**
   * Apply a mouse gesture to the free camera. Ignored in the other modes.
   *
   * The drag moves the camera *directly*, one pixel to a fixed angle, and only
   * leaves a little residual spin behind for the flick.
   */
  moveFreeCamera(dx: number, dy: number, wheel: number, pan: boolean): void {
    if (this.mode !== 'free') return;
    // The render loop calls this every frame whether or not the mouse moved, so
    // an empty gesture has to be nothing at all.
    if (dx === 0 && dy === 0 && wheel === 0) return;
    if (this.freeWorldLocked) this.freeReshape = true;
    else this.freeAnchored = false;
    if (pan || this.freeReframe) {
      // Shift-drag nudges what the camera is *looking at* rather than where it
      // is, which is how you put the aircraft off-centre deliberately.
      this.freeAim.x = clamp(this.freeAim.x + dx * 0.025, -30, 30);
      this.freeAim.y = clamp(this.freeAim.y - dy * 0.025, -20, 20);
    } else {
      this.freeAzimuth += dx * ORBIT_PER_PIXEL;
      // Drag *up*, camera goes up and over the subject.
      this.freeElevation = clamp(this.freeElevation - dy * ORBIT_PER_PIXEL * 0.8, -1.35, 1.35);
      this.freeSpinAz += dx * ORBIT_PER_PIXEL * 0.10;
      this.freeSpinEl -= dy * ORBIT_PER_PIXEL * 0.08;
    }
    if (wheel !== 0) {
      // Multiplicative, so a click of the wheel moves the same *proportion* at
      // four metres and at four hundred.
      this.freeDistance = clamp(this.freeDistance * Math.exp(wheel * 0.0011), 3.5, 600);
    }
  }

  /**
   * Nine saved viewpoints, on the number keys. They start as nine that are
   * worth having, and any of them can be overwritten.
   */
  private readonly views: FreeView[] = [
    /* 1 astern    */ { azimuth: Math.PI, elevation: 0.16, distance: 14, aimX: 0, aimY: 0, worldLocked: false },
    /* 2 abeam     */ { azimuth: Math.PI / 2, elevation: 0.08, distance: 16, aimX: 0, aimY: 0, worldLocked: false },
    /* 3 nose-on   */ { azimuth: 0, elevation: 0.14, distance: 17, aimX: 0, aimY: 0, worldLocked: false },
    /* 4 overhead  */ { azimuth: Math.PI, elevation: 1.20, distance: 28, aimX: 0, aimY: 0, worldLocked: false },
    /* 5 low six   */ { azimuth: Math.PI, elevation: -0.38, distance: 12, aimX: 0, aimY: 0, worldLocked: false },
    /* 6 high wide */ { azimuth: Math.PI * 0.72, elevation: 0.50, distance: 65, aimX: 0, aimY: 0, worldLocked: false },
    /* 7 wingtip   */ { azimuth: Math.PI * 0.58, elevation: 0.05, distance: 7, aimX: 0, aimY: 0, worldLocked: false },
    /* 8 long lens */ { azimuth: Math.PI * 1.28, elevation: 0.22, distance: 160, aimX: 0, aimY: 0, worldLocked: false },
    // The one world-locked default: from here the next turn the aircraft makes
    // swings it right through the frame.
    /* 9 fly-by    */ { azimuth: Math.PI * 0.5, elevation: 0.05, distance: 36, aimX: 0, aimY: 0, worldLocked: true },
  ];

  /** How many view slots there are — the bar builds its buttons from this. */
  get freeViewCount(): number {
    return this.views.length;
  }

  /** Put the camera where slot `i` says. */
  recallFreeView(i: number): void {
    const v = this.views[i];
    if (v === undefined) return;
    this.freeSpinAz = 0;
    this.freeSpinEl = 0;
    this.freeAzimuth = v.azimuth;
    this.freeElevation = v.elevation;
    this.freeDistance = v.distance;
    this.freeAim.set(v.aimX, v.aimY, 0);
    this.freeWorldLocked = v.worldLocked;
    this.freeAnchored = false;
    this.freeReshape = false;
  }

  /** Store the current view in slot `i`, and hand it back to be saved to disk. */
  storeFreeView(i: number): FreeView | null {
    if (this.views[i] === undefined) return null;
    this.views[i] = {
      azimuth: this.freeAzimuth,
      elevation: this.freeElevation,
      distance: this.freeDistance,
      aimX: this.freeAim.x,
      aimY: this.freeAim.y,
      worldLocked: this.freeWorldLocked,
    };
    return this.views[i];
  }

  /** Views remembered from a previous session. */
  loadFreeViews(saved: (FreeView | null)[]): void {
    saved.forEach((v, i) => {
      if (v !== null && this.views[i] !== undefined) this.views[i] = v;
    });
  }

  get savedViews(): FreeView[] {
    return this.views;
  }

  /**
   * Apply a mouse gesture to the orbit camera. Ignored in the other modes.
   *
   * Dragging up and down raises and lowers the ring, the wheel opens it out and
   * pulls it in, and horizontal drag does nothing at all: bearing is what the
   * orbit *is*. Returns whether anything moved.
   */
  moveOrbitCamera(dy: number, wheel: number): boolean {
    if (this.mode !== 'orbit' || (dy === 0 && wheel === 0)) return false;
    if (dy !== 0) {
      this.setOrbit({ height: this.orbit.height - dy * ORBIT_HEIGHT_PER_PIXEL });
    }
    if (wheel !== 0) {
      this.setOrbit({ distance: this.orbit.distance * Math.exp(wheel * 0.0011) });
    }
    return true;
  }

  /** Whether the free camera holds station on the aircraft or on the world. */
  toggleFreeLock(): boolean {
    this.setFreeLock(!this.freeWorldLocked);
    return this.freeWorldLocked;
  }

  setFreeLock(worldLocked: boolean): void {
    this.freeWorldLocked = worldLocked;
    // Plant afresh, from wherever the camera is standing now.
    this.freeAnchored = false;
    this.freeReshape = false;
  }

  get freeCameraLocked(): boolean {
    return this.freeWorldLocked;
  }

  /** Whether a plain drag currently reframes rather than orbits. */
  setFreeReframe(on: boolean): void {
    this.freeReframe = on;
  }

  get freeReframing(): boolean {
    return this.freeReframe;
  }

  // ------------------------------------------------------------- the fight

  /**
   * Cut to a shot suited to something that just happened.
   *
   * 'takeoff' and 'landing' as before; 'engage' when a fight opens (a bandit
   * locked, or coming into reach); 'hit' when the player is taking hits;
   * 'flak' when archie is bursting round the player. 'kill' plays the kill cam
   * on the current target, if there is one — `requestKillCam` is the better
   * call when the victim is known for certain.
   */
  requestShot(event: string): void {
    if (event === 'kill') {
      const tg = this.combat.target;
      if (tg !== null) this.requestKillCam(tg, 3);
      return;
    }
    this.director.request(event);
  }

  /**
   * An enemy has gone down: follow it for `seconds` and hand back.
   *
   * Plays in the cinematic view, and in the director unless a shot is pinned
   * or a reel is running (the operator is composing). With `killCamOutside` on
   * it also takes over the chase, target and orbit views for its length.
   * Returns whether a kill cam will play.
   *
   * The victim is held by reference, so hand over something whose position
   * keeps moving — the dying aircraft itself, or its render root.
   */
  requestKillCam(victim: CombatBody | CameraSubject, seconds = 3): boolean {
    const body: CombatBody = 'root' in victim
      ? {
        position: victim.root.position,
        quaternion: victim.root.quaternion,
        velocity: victim.velocity,
        cameraScale: victim.cameraScale,
      }
      : victim;
    const directing = this.mode === 'cinematic'
      || (this.mode === 'director' && !this.director.isPinned && !this.reelOn);
    const outside = this.killCamOutside
      && (this.mode === 'chase' || this.mode === 'target' || this.mode === 'orbit');
    if (!directing && !outside) return false;
    return this.director.killCam(body, seconds);
  }

  /** Whether a kill cam is on screen (or about to be). */
  get killCamActive(): boolean {
    return this.director.killActive && (this.directing() || this.killOutside);
  }

  /**
   * How fast the game should run right now, 1 being real time: the director
   * takes a kill in slow motion for a beat. Only while it is on screen.
   */
  get timeWarp(): number {
    return this.directing() ? this.director.timeWarp : 1;
  }

  /** Slow motion on kills, in the views the director films. */
  get slowKills(): boolean {
    return this.director.slowKills;
  }

  setSlowKills(on: boolean): void {
    this.director.slowKills = on;
  }

  /** The act of the fight the director is telling. */
  get act(): string {
    return this.director.currentAct;
  }

  /**
   * A jolt: a hit taken, a shell bursting close, a heavy landing. Adds to
   * whatever is already shaking and dies away over a second or so. 1 is a
   * solid hit; 0.3 a near burst.
   */
  addShake(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.impulse = Math.min(this.impulse + amount, 2.5);
  }

  /** The player's guns are firing: the Vickers hammer the airframe. */
  setGunfire(on: boolean): void {
    this.gunfire = on;
  }

  /**
   * How hard the engine is running, 0..1, and whether it is a rotary — the
   * whole crankcase spinning on the crankshaft, which shakes a scout like
   * nothing else. Until this is called the rig guesses from the telemetry.
   */
  setEngine(power: number, rotary = this.engineRotary): void {
    this.enginePower = Number.isFinite(power) ? clamp(power, 0, 1) : null;
    this.engineRotary = rotary;
  }

  /**
   * Where the pilot is looking, relative to the nose, radians, in the body's
   * own sense of rotation: positive yaw turns the head *left* (about the
   * aircraft's up axis, as three.js turns anything), positive pitch looks up.
   * For a body-frame direction (x, y, z) that is yaw = atan2(−x, −z),
   * pitch = atan2(y, hypot(x, z)). Held until changed, and eased — map a
   * mouse or a hat to it. Looking far round (past ±90°) leans the head out to
   * see past the fuselage, as a pilot checking his six does.
   */
  setCockpitLook(yaw: number, pitch: number): void {
    this.lookYaw = Number.isFinite(yaw) ? clamp(yaw, -HEAD_YAW, HEAD_YAW) : 0;
    this.lookPitch = Number.isFinite(pitch) ? clamp(pitch, HEAD_PITCH_DOWN, HEAD_PITCH_UP) : 0;
  }

  /** Where the pilot's head is actually pointing now, radians. */
  get cockpitLook(): { yaw: number; pitch: number } {
    return { yaw: this.headYaw, pitch: this.headPitch };
  }

  /**
   * Padlock: in the cockpit, keep the head turned toward the target (as far as
   * a neck allows) instead of where `setCockpitLook` says. Typically held on a
   * key.
   */
  setCockpitPadlock(on: boolean): void {
    if (on && !this.padlock) this.padlockSide = 0;
    this.padlock = on;
  }

  // ------------------------------------------------------------- hybrid mode

  /** Reshape the shot the director is playing. */
  adjustShot(dx: number, dy: number, wheel: number): void {
    if (this.mode !== 'director') return;
    this.director.adjust(dx, dy, wheel);
  }

  /** Cut straight to the next or previous setup. */
  stepShot(direction: 1 | -1): void {
    // Anything that picks a shot by hand takes the reel off the air.
    if (this.reelOn) this.stopReel();
    this.director.step(direction);
  }

  /** Hold the current setup instead of cutting on. */
  pinShot(): boolean {
    if (this.reelOn) this.stopReel();
    return this.director.togglePin();
  }

  get shotPinned(): boolean {
    return this.director.isPinned;
  }

  setShotPinned(on: boolean): void {
    if (on && this.reelOn) this.stopReel();
    this.director.setPinned(on);
  }

  /** Run the current shot's move again from the top. */
  replayShot(): void {
    this.director.replay();
  }

  /** Whether every shot is played back to front. */
  get shotReversed(): boolean {
    return this.director.reversingAll;
  }

  setShotReversed(on: boolean): void {
    this.director.setReverseAll(on);
  }

  /** Whether a held shot repeats its move or freezes on its last frame. */
  get shotLoops(): boolean {
    return this.director.loops;
  }

  setShotLooping(on: boolean): void {
    this.director.setLooping(on);
  }

  /** Put the current shot back the way it was written. */
  resetShot(): void {
    this.director.resetShot();
  }

  /** How the current shot has been reshaped — distance, height, swing. */
  get shotTweak(): ShotTweak {
    return this.director.tweak;
  }

  /** Adjustments to save between sessions, and to restore. */
  get shotTweaks(): [string, ShotTweak][] {
    return this.director.allTweaks;
  }

  loadShotTweaks(saved: [string, Partial<ShotTweak>][]): void {
    this.director.loadTweaks(saved);
  }

  /** How long the running shot is held, seconds, as adjusted. */
  get shotSeconds(): number {
    return this.director.shotSeconds;
  }

  /** Hold and travel for the running shot. */
  setShotHold(value: number): void {
    this.director.setHold(value);
  }

  setShotTravel(value: number): void {
    this.director.setTravel(value);
  }

  /** Overall pace — Calm, Standard, Kinetic. */
  get directorStyle(): number {
    return this.director.styleIndex;
  }

  setDirectorStyle(index: number): void {
    this.director.setStyle(index);
  }

  /** The pace as two numbers — what the sliders drive in the cinematic view. */
  get directorPace(): { hold: number; travel: number } {
    return this.director.pace;
  }

  setDirectorPace(hold: number, travel: number): void {
    this.director.setPace(hold, travel);
  }

  // ---------------------------------------------------------- saved setups
  //
  // Nine of them on the number keys, exactly as the free camera has nine saved
  // views: the number keys mean "my saved views" in whichever of the two modes
  // you are in.
  private readonly slots: (ShotSlot | null)[] =
    [null, null, null, null, null, null, null, null, null];

  /**
   * The reel: which slots play, and in what order. Empty means "every filled
   * slot, in slot order".
   */
  private order: number[] = [];
  private reelOn = false;

  /** Save the running shot, in the shape it is in now, into a slot. */
  storeShotSlot(index: number): boolean {
    const name = this.director.shotName;
    if (index < 0 || index >= this.slots.length) return false;
    this.slots[index] = { shot: name, tweak: { ...this.director.tweak } };
    return true;
  }

  /** Cut to a saved setup and hold it. */
  recallShotSlot(index: number): ShotSlot | null {
    const slot = this.slots[index] ?? null;
    if (slot === null) return null;
    if (this.reelOn) this.stopReel();
    this.director.setTweak(slot.shot, slot.tweak);
    if (!this.director.force(slot.shot)) return null;
    this.director.setPinned(true);
    return slot;
  }

  get shotSlots(): (ShotSlot | null)[] {
    return this.slots;
  }

  /** True where a slot has something saved in it. */
  get filledSlots(): boolean[] {
    return this.slots.map((s) => s !== null);
  }

  /** The running order as slot indices — filled slots in slot order by default. */
  get reelOrder(): number[] {
    const filled = this.order.filter((i) => this.slots[i] != null);
    if (filled.length > 0) return filled;
    return this.slots.map((_, i) => i).filter((i) => this.slots[i] != null);
  }

  setReelOrder(order: number[]): void {
    this.order = order.filter((i) => i >= 0 && i < this.slots.length);
    if (this.reelOn) this.playReel();
  }

  get reelPlaying(): boolean {
    return this.reelOn;
  }

  /** Where in the reel we are, as "3/5" — empty when nothing is running. */
  get reelPosition(): string {
    if (!this.reelOn) return '';
    return `${this.director.queuePosition}/${this.director.queueLength}`;
  }

  /** Start the reel. Returns how many setups it will play. */
  playReel(): number {
    const entries = this.reelOrder
      .map((i) => this.slots[i])
      .filter((s): s is ShotSlot => s !== null);
    if (entries.length === 0) return 0;
    this.reelOn = true;
    this.director.setQueue(entries);
    return entries.length;
  }

  stopReel(): void {
    this.reelOn = false;
    this.director.setQueue(null);
  }

  /** Cut to the next entry without waiting out the current one. */
  advanceReel(): void {
    this.director.advanceQueue();
  }

  loadShotSlots(saved: (ShotSlot | null)[]): void {
    for (let i = 0; i < this.slots.length && i < saved.length; i++) {
      const slot = saved[i];
      if (slot === null || typeof slot?.shot !== 'string') continue;
      this.slots[i] = slot;
    }
  }

  /** Aperture and focus plane the current cinematic shot asks for. */
  get lens(): { aperture: number; focusScale: number } {
    return this.directing()
      ? { aperture: this.director.aperture, focusScale: this.director.focusScale }
      : { aperture: 0, focusScale: 1 };
  }

  /**
   * What the lens should be focused on: the subject of the shot on screen —
   * the player, or the enemy in a shot of the enemy, or a kill cam's victim.
   * Measure the focus distance to this rather than to the player.
   */
  get focusPoint(): THREE.Vector3 {
    if (this.directing()) return this.director.focusPoint;
    return this.subject?.root.position ?? this.director.focusPoint;
  }

  /** Whether the director is driving the camera this frame. */
  private directing(): boolean {
    return this.mode === 'cinematic' || this.mode === 'director' || this.killOutside;
  }

  update(dt: number, subject: CameraSubject, t: CameraTelemetry): void {
    if (subject !== this.subject) this.setSubject(subject);
    const pos = subject.root.position;
    const quat = subject.root.quaternion;
    const s = scaleOf(subject.cameraScale);
    this.shakeClock += dt;
    this.impulse *= Math.exp(-3.2 * dt);

    // A kill cam in an outside view takes the camera for its length and hands
    // it back with a snap, so the chase does not ease in from the kill cam.
    const outsideMode = this.mode === 'chase' || this.mode === 'target' || this.mode === 'orbit';
    const killOutside = this.killCamOutside && outsideMode && this.director.killActive;
    if (this.killOutside && !killOutside) this.initialised = false;
    this.killOutside = killOutside;

    const directing = this.directing();
    subject.setCockpitVisible(this.mode === 'cockpit'
      || (directing && this.director.wantsInterior));

    // The director owns the whole camera in this mode — position, aim and focal
    // length — so none of the shared framing below applies to it.
    if (directing) {
      this.director.update(dt, pos, quat, t, this.camera, this.groundHeight,
        { scale: s, eye: subject.eyePoint, velocity: subject.velocity });
      this.camera.near = this.director.nearPlane ?? this.defaultNear;
      this.camera.updateProjectionMatrix();
      // Shake belongs to the player's aircraft. A shot of the enemy does not
      // tremble because the player's engine does, and only a camera bolted to
      // the airframe feels the engine and the guns at all.
      const own = this.director.subjectRole === 'player';
      const rumble = (own && t.stalled === true ? 0.35 : 0)
        + this.impulse * IMPULSE_GAIN * (this.director.mounted ? 1 : 0.5);
      const buzz = this.director.mounted ? this.engineBuzz(t, 0.16) + (this.gunfire ? 0.4 : 0) : 0;
      this.rumble = damp(this.rumble, rumble, rumble > this.rumble ? 16 : 6, dt);
      this.buzz = damp(this.buzz, buzz, 10, dt);
      this.applyShake();
      // Not while a kill cam borrows an outside view: that view has to snap
      // back when it ends, not ease in from wherever the kill cam was.
      this.initialised = !this.killOutside;
      return;
    }

    // Speed drives FOV and a touch of shake — the cheap, reliable speed cues.
    // Sixty metres a second is a scout going well; a dive runs past it.
    const speedFactor = clamp(t.tas / 60, 0, 1.4);
    const targetFov =
      this.mode === 'cockpit'
        // A little wider than the outside views: the cockpit is open, and the
        // wider lens puts the wings and the struts at the edge of vision where
        // a pilot actually sees them.
        ? this.baseFov + 6 + speedFactor * 3
        : this.baseFov - 4 + speedFactor * 9;
    this.fov = this.initialised ? damp(this.fov, targetFov, 3, dt) : targetFov;

    // Shake belongs to the views that are *riding* the aircraft. The free
    // camera is one you are holding and aiming, and a hand-framed shot that
    // trembles reads as a fault rather than as speed.
    const riding = this.mode === 'chase' || this.mode === 'cockpit' || this.mode === 'target';
    const buffet = t.stalled === true ? 0.7 : 0;
    const groundRush = smoothstep(60, 12, t.agl) * speedFactor * 0.3;
    const rumble = this.mode === 'free' ? 0
      : riding ? buffet + groundRush + this.impulse * IMPULSE_GAIN
        : this.impulse * IMPULSE_GAIN * 0.5;
    const buzz = !riding ? 0
      : this.mode === 'cockpit'
        ? this.engineBuzz(t, 0.22) + (this.gunfire ? 0.45 : 0)
        : this.engineBuzz(t, 0.1) + (this.gunfire ? 0.28 : 0);
    // A jolt arrives at once and dies away; the rest come and go gently.
    this.rumble = this.initialised ? damp(this.rumble, rumble, rumble > this.rumble ? 16 : 6, dt) : rumble;
    this.buzz = this.initialised ? damp(this.buzz, buzz, 10, dt) : buzz;

    let near = this.defaultNear;
    switch (this.mode) {
      case 'chase':
        this.updateChase(dt, pos, quat, t, s);
        break;
      case 'cockpit':
        near = COCKPIT_NEAR;
        this.updateCockpit(dt, subject, pos, quat);
        break;
      case 'target':
        this.updateTarget(dt, pos, quat, t, s);
        break;
      case 'orbit':
        this.updateOrbit(dt, pos, t, s);
        break;
      case 'free':
        this.updateFree(dt, pos, quat, t, s, subject.velocity);
        break;
    }

    this.camera.near = near;
    this.camera.fov = this.mode === 'target' ? Math.max(this.fov, this.tgtFit) : this.fov;
    this.camera.updateProjectionMatrix();
    this.applyShake();
    this.initialised = true;
  }

  /** Engine vibration for this view, before the damping. */
  private engineBuzz(t: CameraTelemetry, full: number): number {
    const guess = t.onGround === true && t.tas < 1 ? 0.35 : 0.75;
    const power = this.enginePower ?? guess;
    return full * power * (this.engineRotary ? 1 : 0.55);
  }

  /** Where the chase boom puts the camera, and what it aims at. */
  private chasePose(pos: THREE.Vector3, t: CameraTelemetry, s: number,
    outPos: THREE.Vector3, outLook: THREE.Vector3): void {
    // Accelerating, the camera drops back a touch; slowing, it closes up.
    const surge = clamp((t.tas - this.chaseTas) * 0.12, -1.2, 2.0);
    outPos.set(0, CHASE_UP * s, (CHASE_BACK + surge) * s).applyQuaternion(this.chaseQuat).add(pos);
    outLook.set(0, CHASE_LOOK_UP * s, -CHASE_LOOK_AHEAD * s).applyQuaternion(this.chaseQuat).add(pos);
    this.liftAboveGround(outPos);
  }

  /** Ease the chase boom's attitude and surge toward the aircraft's. */
  private swingChase(dt: number, quat: THREE.Quaternion, t: CameraTelemetry): void {
    if (!this.initialised) {
      this.chaseQuat.copy(quat);
      this.chaseTas = t.tas;
    } else {
      this.chaseQuat.slerp(quat, 1 - Math.exp(-CHASE_SWING * dt));
      this.chaseTas = damp(this.chaseTas, t.tas, 1.5, dt);
    }
  }

  /** The chase camera's up: part of the aircraft's roll, eased. */
  private chaseUp(dt: number, quat: THREE.Quaternion, out: THREE.Vector3): void {
    this._aircraftUp.set(0, 1, 0).applyQuaternion(quat);
    this._blendUp.set(0, 1, 0).lerp(this._aircraftUp, 0.45).normalize();
    if (!this.initialised) out.copy(this._blendUp);
    else out.lerp(this._blendUp, 1 - Math.exp(-8 * dt)).normalize();
  }

  private updateChase(dt: number, pos: THREE.Vector3, quat: THREE.Quaternion,
    t: CameraTelemetry, s: number): void {
    this.swingChase(dt, quat, t);
    this.chasePose(pos, t, s, this.position, this.target);
    this.chaseUp(dt, quat, this.up);
    this.camera.position.copy(this.position);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this.target);
  }

  /**
   * The cockpit: at the pilot's eye, with a little rotational lag so hard
   * manoeuvres read in here too, and a head that turns.
   */
  private updateCockpit(dt: number, subject: CameraSubject, pos: THREE.Vector3,
    quat: THREE.Quaternion): void {
    if (!this.initialised) this.cockpitQuat.copy(quat);
    else this.cockpitQuat.slerp(quat, 1 - Math.exp(-20 * dt));

    // Where the head wants to point: the hat, or the bandit.
    let wantYaw = this.lookYaw;
    let wantPitch = this.lookPitch;
    const tg = this.combat.target;
    if (this.padlock && tg !== null) {
      const eye = this._v1.copy(subject.eyePoint).applyQuaternion(quat).add(pos);
      const b = this._v2.copy(tg.position).sub(eye).applyQuaternion(this._q.copy(quat).invert());
      let yaw = Math.atan2(-b.x, -b.z);
      const pitch = Math.atan2(b.y, Math.hypot(b.x, b.z));
      // Dead astern the bearing flips from +180° to −180°. A head does not
      // snap across the back of the seat: once it has picked a shoulder to
      // look over, it keeps it until the target comes round where it can be
      // seen from the other one.
      if (Math.abs(yaw) > HEAD_YAW - 0.1 && this.padlockSide !== 0
        && Math.sign(yaw) !== this.padlockSide) {
        yaw = this.padlockSide * HEAD_YAW;
      }
      if (Math.abs(yaw) > 0.3) this.padlockSide = Math.sign(yaw);
      wantYaw = clamp(yaw, -HEAD_YAW, HEAD_YAW);
      wantPitch = clamp(pitch, HEAD_PITCH_DOWN, HEAD_PITCH_UP);
    }
    if (!this.initialised) {
      this.headYaw = wantYaw;
      this.headPitch = wantPitch;
    } else {
      this.headYaw = damp(this.headYaw, wantYaw, 9, dt);
      this.headPitch = damp(this.headPitch, wantPitch, 9, dt);
    }

    // Looking round leans the head out to see past the fuselage — and back
    // over the shoulder the pilot rises in his seat to see over the decking.
    // Positive yaw is to the left, so the lean is toward −X.
    const sy = Math.sin(this.headYaw);
    const back = (1 - Math.cos(this.headYaw)) * 0.5;
    this._desired.copy(subject.eyePoint);
    this._desired.x -= sy * 0.1 + Math.sign(sy) * back * 0.08;
    this._desired.y += back * 0.06 + Math.max(0, -this.headPitch) * 0.03;
    this._desired.applyQuaternion(quat).add(pos);
    this.camera.position.copy(this._desired);

    // Body attitude, then the head: yaw about the body's up, then pitch.
    this._q.setFromAxisAngle(AXIS_Y, this.headYaw);
    this._q2.setFromAxisAngle(AXIS_X, this.headPitch);
    this.camera.quaternion.copy(this.cockpitQuat).multiply(this._q).multiply(this._q2);
    this.camera.up.set(0, 1, 0).applyQuaternion(this.cockpitQuat);
  }

  /**
   * The target view: padlock from outside, as the classic flight games did it.
   *
   * The camera sits behind and above the player on the line from the target
   * through the player, and aims between them — the player low in the frame,
   * the bandit above his top wing — so wherever the enemy goes the player can
   * see where he is and which way to pull. With no target it is the chase view,
   * and it eases between the two as targets come and go.
   *
   * Three things keep it from ever flipping. The line's elevation is held
   * inside ±70°, so a bandit straight overhead swings the camera round beneath
   * rather than turning the world over. The line is turned toward the target
   * at a limited rate, so one that flashes past at ten metres swings the view,
   * it does not whip it. And the lens opens as far as it must to hold both:
   * whatever the damping costs in aim, the field of view pays back.
   */
  private updateTarget(dt: number, pos: THREE.Vector3, quat: THREE.Quaternion,
    t: CameraTelemetry, s: number): void {
    // The chase view is always computed: it is what this eases from and to.
    this.swingChase(dt, quat, t);
    const chasePos = this._v3;
    const chaseLook = this._v4;
    this.chasePose(pos, t, s, chasePos, chaseLook);
    this.chaseUp(dt, quat, this.up);

    const tg = this.combat.target;
    if (tg !== null) this.tgtLast.copy(tg.position);
    // Coming in from the plain chase, there is no old line worth swinging
    // from: take the new one as it is and let the blend do the easing.
    const fromChase = this.tgtBlend === 0;
    // A fixed-length ease rather than an exponential one: with a bandit astern
    // the target view is on the far side of the aeroplane, and an exponential
    // start covers most of that swing in its first few frames.
    const want = tg !== null ? 1 : 0;
    if (!this.initialised) this.tgtBlend = want;
    else this.tgtBlend = moveTowards(this.tgtBlend, want, dt / TARGET_EASE);

    // The line from the player to the target, as a bearing and an elevation,
    // each damped on its own. Damping the direction as a vector turns it along
    // the great circle, and for a bandit crossing overhead the great circle runs
    // through the zenith — where "up" for the camera stops existing. Kept as a
    // bearing, the line swings round the vertical instead of over it, and the
    // elevation never passes ±70°.
    const raw = this._v1.copy(this.tgtLast).sub(pos);
    if (raw.lengthSq() < 1e-4 || (!this.tgtKnown && tg === null)) {
      raw.set(0, 0, -1).applyQuaternion(quat);
    }
    const flat = Math.hypot(raw.x, raw.z);
    const rawEl = clamp(Math.atan2(raw.y, flat), -TARGET_MAX_ELEVATION, TARGET_MAX_ELEVATION);
    // Straight overhead there is no bearing worth following: hold the last.
    const rawAz = flat > 1e-3 * raw.length() ? Math.atan2(raw.x, raw.z) : this.tgtAz;
    if (!this.initialised || !this.tgtKnown || fromChase) {
      this.tgtAz = rawAz;
      this.tgtEl = rawEl;
      this.tgtKnown = tg !== null;
    } else {
      let dAz = rawAz - this.tgtAz;
      while (dAz > Math.PI) dAz -= Math.PI * 2;
      while (dAz < -Math.PI) dAz += Math.PI * 2;
      // A bearing is cheap to turn near the vertical — it is a small circle —
      // so the limit is on the arc the camera actually travels.
      const azLimit = (TARGET_TURN * dt) / Math.max(Math.cos(this.tgtEl), 0.3);
      this.tgtAz += clamp(dAz * (1 - Math.exp(-6 * dt)), -azLimit, azLimit);
      const dEl = rawEl - this.tgtEl;
      this.tgtEl += clamp(dEl * (1 - Math.exp(-6 * dt)), -TARGET_TURN * dt, TARGET_TURN * dt);
    }
    const ce = Math.cos(this.tgtEl);
    this.tgtDir.set(ce * Math.sin(this.tgtAz), Math.sin(this.tgtEl), ce * Math.cos(this.tgtAz));
    // Which way is "above the line". World up, square to it — the clamp keeps
    // the line far enough off vertical for that always to exist — bent toward
    // the aeroplane's own up. In a steep turn the wings stand across the
    // picture, and a bandit put straight up the screen sits behind the top
    // wing; put up the *canopy* instead, he sits between the wings, clear. The
    // lens's own roll takes a little of the bank too, as the chase view does.
    const d = this.tgtDir;
    const world = this._v2.set(0, 1, 0).addScaledVector(d, -d.y).normalize();
    const body = this._step.set(0, 1, 0).applyQuaternion(quat);
    body.addScaledVector(d, -body.dot(d));
    const across = smoothstep(0.3, 0.8, body.length());
    if (across > 0) body.normalize();
    const offWant = this._v1.copy(world).multiplyScalar(1 - 0.65 * across)
      .addScaledVector(body, 0.65 * across).normalize();
    const upWant = world.multiplyScalar(1 - 0.3 * across).addScaledVector(body, 0.3 * across)
      .normalize();
    if (!this.initialised) {
      this.tgtUp.copy(upWant);
      this.tgtOff.copy(offWant);
    } else {
      this.tgtUp.lerp(upWant, 1 - Math.exp(-8 * dt)).normalize();
      this.tgtOff.lerp(offWant, 1 - Math.exp(-6 * dt)).normalize();
    }

    const back = (TARGET_BACK + clamp(t.tas, 0, 80) * 0.03) * s;
    const tOff = this._desired.copy(this.tgtDir).multiplyScalar(-back)
      .addScaledVector(this.tgtOff, TARGET_UP * s);

    // Blend the two poses round the player rather than through him: with a
    // bandit astern the target view is *ahead* of the aeroplane, and a straight
    // line from the chase boom to there runs through the cockpit.
    const b = smoothstep(0, 1, this.tgtBlend);
    swingAround(chasePos.sub(pos), tOff, b, this.position);
    this.position.add(pos);
    const tgtScale = scaleOf(tg?.cameraScale);
    // A target that has come to sit on the lens (a collision course seen from
    // behind the player) is not allowed to put the camera inside it.
    if (b > 0) {
      keepAway(this.position, this.tgtLast, 5.5 * tgtScale);
      keepAway(this.position, pos, 5.2 * s);
    }
    this.liftAboveGround(this.position);

    const toChase = this._v1.copy(chaseLook).sub(this.position).normalize();
    let fit = 0;
    if (b > 0) {
      const toP = this._v2.copy(pos).sub(this.position);
      const dP = Math.max(toP.length(), 1);
      toP.divideScalar(dP);
      // Aimed at where the damped line says the target is, not at the target:
      // a new one on the far side of the sky is swung onto, not cut to. The
      // lens is fitted to the real one whenever it is anywhere near the frame.
      const range = this.tgtLast.distanceTo(pos);
      const toV = this._v3.copy(pos).addScaledVector(this.tgtDir, range).sub(this.position);
      const dV = Math.max(toV.length(), 1);
      toV.divideScalar(dV);
      const aimT = slerpDirection(toP, toV, TARGET_AIM, this._v4);
      slerpDirection(toChase, aimT, b, this._lookAt);
      this.camera.up.copy(this._blendUp.copy(this.up).lerp(this.tgtUp, b).normalize());
      this.target.copy(this.position).add(this._lookAt);
      this.camera.position.copy(this.position);
      this.camera.lookAt(this.target);
      // How wide the lens must be to hold both, measured in the camera's own
      // frame so the wider horizontal field is used where it is available.
      const toT = this._v4.copy(this.tgtLast).sub(this.position);
      const dT = Math.max(toT.length(), 1);
      toT.divideScalar(dT);
      const real = toT.angleTo(this._lookAt) < 1.1;
      fit = this.fitBoth(toP, dP, s, real ? toT : toV, real ? dT : dV, tgtScale) * b;
    } else {
      this._lookAt.copy(toChase);
      this.target.copy(this.position).add(this._lookAt);
      this.camera.up.copy(this.up);
      this.camera.position.copy(this.position);
      this.camera.lookAt(this.target);
    }
    // Opens fast, closes slowly: late to widen is a target out of frame, late
    // to narrow is only a lens that breathes.
    if (!this.initialised) this.tgtFit = fit;
    else this.tgtFit += (fit - this.tgtFit) * (1 - Math.exp(-(fit > this.tgtFit ? 20 : 1.5) * dt));
    this.tgtFit = Math.min(Math.max(this.tgtFit, fit), 110);
  }

  /**
   * Vertical field of view, degrees, that holds both directions (with room for
   * the aircraft around each) given how the camera is now aimed.
   */
  private fitBoth(toP: THREE.Vector3, dP: number, s: number,
    toT: THREE.Vector3, dT: number, sT: number): number {
    this.camera.updateMatrixWorld(true);
    const inv = this._m.copy(this.camera.matrixWorld).invert();
    // Horizontal and vertical half-angles off the lens axis, each padded by
    // the aircraft round it.
    let needX = 0;
    let needY = 0;
    for (let k = 0; k < 2; k++) {
      const v = this._step.copy(k === 0 ? toP : toT).transformDirection(inv);
      const pad = k === 0 ? Math.atan((3.5 * s) / dP) : Math.atan((3.5 * sT) / dT);
      const forward = Math.max(-v.z, 0.05);
      needX = Math.max(needX, Math.atan(Math.abs(v.x) / forward) + pad);
      needY = Math.max(needY, Math.atan(Math.abs(v.y) / forward) + pad);
    }
    const aspect = this.camera.aspect > 0 ? this.camera.aspect : 16 / 9;
    // Horizontal half-angle back to the vertical field it implies.
    const fromX = Math.atan(Math.tan(Math.min(needX, 1.5)) / aspect);
    const half = Math.min(Math.max(needY, fromX) / 0.9, 1.5);
    return 2 * half * (180 / Math.PI);
  }

  /**
   * The camera you drive yourself.
   */
  private updateFree(dt: number, pos: THREE.Vector3, quat: THREE.Quaternion,
    t: CameraTelemetry, s: number, velocity: THREE.Vector3 | undefined): void {
    this.trackAircraft(dt, pos, velocity);
    this.freeAzimuth += this.freeSpinAz;
    this.freeElevation = clamp(this.freeElevation + this.freeSpinEl, -1.35, 1.35);
    const decay = Math.exp(-9 * dt);
    this.freeSpinAz *= decay;
    this.freeSpinEl *= decay;

    // The aircraft's heading. Tracked in both locks: the world lock uses it to
    // decide where to *plant*, so that throwing the switch does not move the
    // camera — it only stops it following.
    this._q.copy(quat);
    const yaw = Math.atan2(
      2 * (this._q.w * this._q.y + this._q.x * this._q.z),
      1 - 2 * (this._q.y * this._q.y + this._q.x * this._q.x),
    );

    // Smoothed, and by the shortest way round: the aeroplane is permanently
    // making small yaw corrections, and a camera welded to them jitters.
    if (!this.freeYawKnown) {
      this.freeYaw = yaw;
      this.freeYawKnown = true;
    }
    let delta = yaw - this.freeYaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.freeYaw += delta * (1 - Math.exp(-5 * dt));

    const distance = this.freeDistance * s;
    const a = this.freeAzimuth + this.freeYaw;
    const horizontal = Math.cos(this.freeElevation) * distance;
    this._desired.set(
      pos.x + Math.sin(a) * horizontal,
      pos.y + Math.sin(this.freeElevation) * distance,
      pos.z + Math.cos(a) * horizontal,
    );
    this.liftAboveGround(this._desired);

    // Rigid to the aircraft, deliberately: the drawn aircraft advances in
    // simulated time and an exponential filter on the camera runs on wall time,
    // and the disagreement between the two is visible on the aircraft and
    // nowhere else. Bolted to the subject, the aircraft cannot move in frame.
    if (this.freeWorldLocked) {
      // Standing in the world: take station once, then let the aircraft go,
      // and re-plant once the aeroplane is past and away.
      if (!this.freeAnchored) {
        this.plantFlyby(pos, quat, t, s, null);
      } else if (this.freeReshape) {
        // Same moment of the same pass, from a different place beside it.
        this.heading(this._flyby, quat);
        this.plantFlyby(pos, quat, t, s, this._step.copy(this.freeAnchor).sub(pos).dot(this._flyby));
      } else if (this.flybyOver(pos, quat, t, s)) {
        this.plantFlyby(pos, quat, t, s, null);
      }
      this.freeReshape = false;
      this.position.copy(this.freeAnchor);
    } else {
      this.freeAnchored = false;
      this.position.copy(this._desired);
      this.liftAboveGround(this.position);
    }

    this._lookAt.copy(pos);
    if (this.freeAim.lengthSq() > 0) {
      // The aim offset is in screen terms — right and up as you see it.
      this._blendUp.copy(this._desired).sub(pos);
      this._blendUp.set(-this._blendUp.z, 0, this._blendUp.x).normalize(); // camera-right
      this._lookAt.addScaledVector(this._blendUp, this.freeAim.x * s);
      this._lookAt.y += this.freeAim.y * s;
    }

    this.camera.position.copy(this.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this._lookAt);
  }

  /**
   * The orbit: the *ring* is eased rather than the camera's world position,
   * so the aeroplane never trails off-centre — a world-space follow at fifty
   * metres a second sits eight metres behind, which on a sixteen-metre ring is
   * half the shot. The ring never closes inside a bigger aircraft's wingspan.
   */
  private updateOrbit(dt: number, pos: THREE.Vector3, t: CameraTelemetry, s: number): void {
    this.orbitAngle += dt * this.orbit.direction * this.orbit.rate * (Math.PI / 30);
    const radius = Math.max(this.orbit.distance, 5.5 * s) + t.tas * 0.08;
    this._desired.set(
      Math.cos(this.orbitAngle) * radius,
      this.orbit.height,
      Math.sin(this.orbitAngle) * radius,
    );
    if (!this.initialised) this.orbitOffset.copy(this._desired);
    else this.orbitOffset.lerp(this._desired, 1 - Math.exp(-6 * dt));
    this.position.copy(this.orbitOffset).add(pos);
    // The orbit radius puts the camera well to the side, which over broken
    // ground can easily be inside a hill the aircraft is clearing.
    this.liftAboveGround(this.position);

    this.camera.position.copy(this.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(pos);
  }

  /**
   * Keep a smoothed idea of where the aircraft is heading. From its velocity
   * when the subject reports one; otherwise from where it has been, treating
   * an implausible step as a fresh start rather than a very fast aeroplane.
   */
  private trackAircraft(dt: number, pos: THREE.Vector3, velocity: THREE.Vector3 | undefined): void {
    if (dt > 0 && this.freeTrackKnown) {
      this._step.copy(pos).sub(this.freeLastPos);
      const moved = this._step.length();
      if (moved > TELEPORT) {
        this.freeTrackKnown = false;
        // A reset, or a new subject. A planted camera has every right to stay
        // where it was put while the aircraft flies, but not when the aircraft
        // simply reappears somewhere else.
        this.freeAnchored = false;
      } else {
        const speed = velocity?.length() ?? 0;
        if (velocity !== undefined && speed > 1) this._step.copy(velocity).divideScalar(speed);
        else if (moved > 1e-3) this._step.divideScalar(moved);
        else this._step.set(0, 0, 0);
        if (this._step.lengthSq() > 0) {
          if (this.freeTrack.lengthSq() < 1e-6) this.freeTrack.copy(this._step);
          else this.freeTrack.lerp(this._step, 1 - Math.exp(-3 * dt)).normalize();
        }
      }
    }
    if (!this.freeTrackKnown) {
      this.freeTrack.set(0, 0, 0);
      this.freeTrackKnown = true;
    }
    this.freeLastPos.copy(pos);
  }

  /**
   * The direction the aircraft is travelling, into `out` — falling back to the
   * nose when there is no track yet.
   */
  private heading(out: THREE.Vector3, quat: THREE.Quaternion): void {
    if (this.freeTrack.lengthSq() > 0.25) out.copy(this.freeTrack).normalize();
    else out.set(0, 0, -1).applyQuaternion(quat);
  }

  /**
   * Stand a camera in the aircraft's path, for it to fly at and then past.
   *
   * The framing the pilot set still decides how the aeroplane goes by: only the
   * part of that offset lying *along* the flight path is thrown away, replaced
   * by a lead long enough to watch it come in. What is left is the miss.
   */
  private plantFlyby(pos: THREE.Vector3, quat: THREE.Quaternion, t: CameraTelemetry, s: number,
    keepAlong: number | null): void {
    this.heading(this._flyby, quat);

    this._miss.copy(this._desired).sub(pos);
    this._miss.addScaledVector(this._flyby, -this._miss.dot(this._flyby));

    // A framing from dead astern misses by nothing at all, which would put the
    // lens exactly on the flight path for the aircraft to fly through.
    const miss = Math.max(MIN_MISS * s, this.freeDistance * s * 0.35);
    if (this._miss.lengthSq() < miss * miss) {
      if (this._miss.lengthSq() > 1) this._miss.setLength(miss);
      else this._miss.set(1, 0, 0).applyQuaternion(quat).multiplyScalar(miss);
    }

    // Far enough ahead to be worth watching it arrive — unless this is a
    // reframe, which keeps whatever is left of the pass.
    let lead = keepAlong ?? Math.max(t.tas * LEAD_SECONDS, this.freeDistance * s * 3, MIN_LEAD * s);

    // A descending track plants the station below the ground, and lifting it
    // back out silently wrecks the shot. Shorten the lead until the station
    // clears the terrain, so it stays *on* the path and the shot is briefer.
    if (keepAlong === null) {
      for (let i = 0; i < 8 && this.clearance(pos, lead) < CAMERA_MIN_CLEARANCE; i++) lead *= 0.6;
    }

    this.freeAnchor.copy(pos).add(this._miss).addScaledVector(this._flyby, lead);
    // Still the backstop, for a dive straight at a hillside.
    this.liftAboveGround(this.freeAnchor);
    this.freeAnchored = true;
  }

  /** How far a station at this lead would sit above the ground under it. */
  private clearance(pos: THREE.Vector3, lead: number): number {
    this._step.copy(pos).add(this._miss).addScaledVector(this._flyby, lead);
    return this._step.y - this.groundHeight(this._step.x, this._step.z);
  }

  /**
   * Whether the aeroplane is past the camera and far enough gone to cut.
   *
   * "Past" is the sign of the camera's bearing along the track, not a
   * distance: planting puts the aircraft a long way off to begin with. "Gone"
   * scales with speed, so a slow machine is not re-planted while it is still
   * a shape and a fast one is not held until it is a dot.
   */
  private flybyOver(pos: THREE.Vector3, quat: THREE.Quaternion, t: CameraTelemetry,
    s: number): boolean {
    this.heading(this._flyby, quat);
    this._miss.copy(this.freeAnchor).sub(pos);
    if (this._miss.dot(this._flyby) > 0) return false;
    return this._miss.length() > Math.max(this.freeDistance * s * 8, t.tas * FLYBY_SECONDS,
      MIN_FLYBY * s);
  }

  /**
   * Hold an outside camera above whatever is under it.
   *
   * The chase offset is fixed in the *aircraft's* frame, so pitching up swings
   * it downward — on a tail-dragger sitting nose-high on the grass, right into
   * it. Clamping here rather than shortening the boom keeps the framing intact
   * at every other attitude.
   */
  private liftAboveGround(p: THREE.Vector3): void {
    const floor = this.groundHeight(p.x, p.z) + CAMERA_MIN_CLEARANCE;
    if (p.y < floor) p.y = floor;
  }

  /**
   * Rotational shake, applied after aiming so it never fights the look-at.
   *
   * Two kinds, because they feel different. The rumble — buffet, a hit, the
   * ground rushing by — is a few smooth sines at a handful of hertz: it rocks
   * the view. The buzz — a rotary at full chat, a pair of Vickers — is noise
   * every frame: it blurs it.
   */
  private applyShake(): void {
    if (this.rumble < 0.001 && this.buzz < 0.001) return;
    const t = this.shakeClock;
    const r = this.rumble * 0.006;
    const b = this.buzz * 0.006;
    this._shakeEuler.set(
      (Math.sin(t * 23.1) + 0.6 * Math.sin(t * 37.7 + 1.3)) * 0.5 * r
        + (Math.random() - 0.5) * b,
      (Math.sin(t * 19.3 + 2.1) + 0.6 * Math.sin(t * 41.9)) * 0.5 * r
        + (Math.random() - 0.5) * b,
      (Math.sin(t * 17.9 + 0.7) + 0.5 * Math.sin(t * 29.3 + 2.9)) * 0.8 * r
        + (Math.random() - 0.5) * b * 1.6,
    );
    this.camera.quaternion.multiply(this._shakeQuat.setFromEuler(this._shakeEuler));
  }
}

/** One stored free-camera viewpoint. */
export interface FreeView {
  azimuth: number;
  elevation: number;
  distance: number;
  aimX: number;
  aimY: number;
  worldLocked: boolean;
}

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);

/** A subject's scale, defended: the camera must never be the reason for a NaN. */
function scaleOf(v: number | undefined): number {
  return v !== undefined && Number.isFinite(v) && v > 0 ? clamp(v, 0.3, 6) : 1;
}

const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();
const _sm = new THREE.Vector3();
const _su = new THREE.Vector3();
const _sd = new THREE.Vector3();

/**
 * Blend two offsets from a centre by swinging round it, into `out`: the
 * direction turns, the length eases. Through the midpoint of the two
 * directions — which is the great circle when they are apart — and, as they
 * come to point opposite ways and there stops being a shortest way round,
 * through a midpoint lifted over the top instead. Never under, never through.
 */
function swingAround(a: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  const la = a.length();
  const lb = b.length();
  if (t <= 0 || la < 1e-6 || lb < 1e-6) return out.copy(t >= 1 ? b : a);
  if (t >= 1) return out.copy(b);
  const ua = _sa.copy(a).divideScalar(la);
  const ub = _sb.copy(b).divideScalar(lb);
  const mid = _sm.copy(ua).add(ub);
  // 0 while they are within 120° of each other, 1 when directly opposite.
  const lift = Math.max(0, 1 - mid.length());
  _su.set(0, 1, 0).addScaledVector(ua, -ua.y);
  if (_su.lengthSq() < 1e-8) _su.set(1, 0, 0);
  mid.addScaledVector(_su.normalize(), lift * 2).normalize();
  const dir = t < 0.5 ? slerpDirection(ua, mid, t * 2, _sd) : slerpDirection(mid, ub, t * 2 - 1, _sd);
  return out.copy(dir).multiplyScalar(la + (lb - la) * t);
}

/** Push `p` out to at least `gap` from `centre`, along the line between them. */
function keepAway(p: THREE.Vector3, centre: THREE.Vector3, gap: number): void {
  const dx = p.x - centre.x;
  const dy = p.y - centre.y;
  const dz = p.z - centre.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= gap * gap) return;
  const d = Math.sqrt(d2);
  if (d < 1e-4) {
    p.set(centre.x, centre.y + gap, centre.z);
    return;
  }
  const k = gap / d;
  p.set(centre.x + dx * k, centre.y + dy * k, centre.z + dz * k);
}

/**
 * Metres of orbit height per pixel of drag. The full range is seventy-five
 * metres, so this puts it about four hundred pixels apart.
 */
const ORBIT_HEIGHT_PER_PIXEL = 0.19;

/**
 * How far the aircraft may draw away from a world-locked camera before it takes
 * fresh station: this many seconds of flight, or eight framing distances, or
 * the floor below — whichever is furthest. Three and a half seconds reads as a
 * shot that ends; much less and the re-plant reads as a stutter.
 */
const FLYBY_SECONDS = 3.5;
const MIN_FLYBY = 120;

/**
 * How many seconds of approach a fly-by is planted with. At fifty metres a
 * second that is two hundred and fifty metres of the aeroplane growing in the
 * frame — a scout is a readable shape from there.
 */
const LEAD_SECONDS = 5;
/** The shortest approach a fly-by is ever planted with, metres (scaled). */
const MIN_LEAD = 60;

/**
 * The closest a fly-by will let the aircraft pass the lens, metres at the
 * reference scale: near enough to be a whip, clear of an 8.5 m wingspan.
 */
const MIN_MISS = 6;

/** A one-frame move further than this is a reset, not flight, metres. */
const TELEPORT = 200;

/**
 * Radians of orbit per pixel of drag — about a quarter of a degree, so a
 * comfortable 300 px drag swings the camera through roughly seventy degrees.
 */
const ORBIT_PER_PIXEL = 0.004;
