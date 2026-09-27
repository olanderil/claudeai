import * as THREE from 'three';
import { clamp, damp, smoothstep } from '../util/math';
import type { Aircraft } from '../flight/Aircraft';
import { CinematicDirector, type ShotTweak, type ShotSlot, type LandmarkTarget } from './Cinematic';
import type { Telemetry } from '../flight/FlightModel';

export type CameraMode = 'chase' | 'cockpit' | 'orbit' | 'cinematic' | 'free' | 'director';

/**
 * What the orbit sliders may ask for: metres, metres, and revolutions/minute.
 *
 * Exported so the bar's `min`/`max` and the rig's clamp are the same numbers.
 */
export const ORBIT_LIMITS = {
  distance: [12, 160] as const,
  height: [-20, 80] as const,
  rate: [0, 8] as const,
};

// Order matters twice over: it is the order of the picker in the Controls tab
// and the order the camera key cycles through. Director sits directly after
// Cinematic because it is the same view with the controls exposed, and Free is
// last because it is the one that stops following the aeroplane at all.
export const CAMERA_MODES: CameraMode[] =
  ['chase', 'cockpit', 'orbit', 'cinematic', 'director', 'free'];

/** Least air an outside camera keeps between itself and the ground, metres. */
const CAMERA_MIN_CLEARANCE = 3.0;

/**
 * Camera behaviour for each view.
 *
 * The chase camera is a critically-damped follow rather than a rigid mount: it
 * lags slightly under acceleration, which is what sells the sense of speed. Its
 * up-vector only partially follows the aircraft's roll — fully rolling with the
 * jet is disorienting, not rolling at all feels detached.
 */
export class CameraRig {
  mode: CameraMode = 'chase';

  private readonly position = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  private readonly _desired = new THREE.Vector3();
  private readonly _lookAt = new THREE.Vector3();
  private readonly _aircraftUp = new THREE.Vector3();
  private readonly _blendUp = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _shakeEuler = new THREE.Euler();
  private readonly _shakeQuat = new THREE.Quaternion();
  private readonly _flyby = new THREE.Vector3();
  private readonly _miss = new THREE.Vector3();
  private readonly _step = new THREE.Vector3();

  private orbitAngle = 0;
  /**
   * What the orbit camera does, all four of it.
   *
   * `distance` and `height` are metres at rest; the ring still widens with
   * airspeed on top of `distance`, because a fixed radius that frames the
   * aircraft on the runway whips past far too fast at 400 kt. `rate` is
   * revolutions per minute and `direction` is +1 for clockwise seen from
   * above, so flipping it is a sign and not a special case.
   */
  readonly orbit = { distance: 34, height: 9, rate: 2.1, direction: 1 };
  private fov = 58;
  /** Field of view before the speed-driven widening, degrees. */
  private baseFov = 58;
  private shake = 0;
  private initialised = false;

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
    // black frame that nothing on the bar can recover from. A corrupt save file
    // is enough to get one here, so it is turned away at the door.
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
    return this.mode === 'cinematic' || this.mode === 'director'
      ? this.director.shotName
      : null;
  }

  cycle(): CameraMode {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
    this.initialised = false;
    this.handBack();
    this.director.reset();
    return this.mode;
  }

  /**
   * Leaving the director gives the camera back to the sequence.
   *
   * The pin and the reel are the director's controls, and `reset` never cleared
   * them — so a pin (which opening the sliders applies *for* you) followed by a
   * switch to the cinematic view left that view holding one setup and, with
   * looping on, replaying it forever. The cinematic camera is the hands-off
   * one; it must never come up pinned.
   */
  private handBack(): void {
    if (this.mode === 'director') return;
    this.director.setPinned(false);
    if (this.reelOn) this.stopReel();
  }

  /**
   * Drop the smoothing for one frame. Needed whenever the aircraft is moved
   * discontinuously (reset, respawn) — otherwise the camera spends several
   * seconds flying across the map to catch up.
   */
  snap(): void {
    this.initialised = false;
    this.director.reset();
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.initialised = false;
    this.handBack();
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

  /** Whether a landmark tripod has anything to stand on — see the shot picker. */
  landmarkTripodReady(): boolean {
    return this.director.tripodReady();
  }

  /** Cut to a named setup: the shot picker, and the dev console. */
  forceShot(name: string): boolean {
    if (this.reelOn) this.stopReel();
    return this.director.force(name);
  }

  /**
   * Free camera state: where you have dragged it to.
   *
   * Spherical, around the aircraft, in the aircraft's *yaw* frame — so the
   * aeroplane holds its place in the frame and the world turns underneath it.
   * That is the aircraft lock, and it is what this always does.
   *
   * The world lock takes the station this describes, plants a camera there, and
   * leaves it: see `freeAnchor`.
   */
  private freeAzimuth = Math.PI; // behind
  private freeElevation = 0.22;
  private freeDistance = 26;
  /** Aim offset from the aircraft, metres, from a shift-drag. */
  private readonly freeAim = new THREE.Vector3();
  private freeWorldLocked = false;
  /**
   * Where a world-locked camera is standing.
   *
   * The world lock used to hold only a *bearing*, and keep travelling with the
   * aircraft. That made it very nearly invisible: the camera still followed the
   * aeroplane everywhere, so the aircraft never moved in frame, never got
   * closer or further, and never went past. The only cue was which way it was
   * facing, and then only mid-turn — in level flight the two locks were the
   * same picture.
   *
   * This holds a *place* instead, and the place is chosen *ahead* of the
   * aircraft: the aeroplane flies at the lens, whips past it, and shrinks away
   * behind. Planting where the aircraft already is would only ever give the
   * second half of that, which is the dull half.
   */
  private readonly freeAnchor = new THREE.Vector3();
  private freeAnchored = false;
  /**
   * A drag or a wheel has asked for a different angle on the shot in progress.
   *
   * Distinct from unplanting. Reaching for the framing used to drop the anchor
   * outright, which took fresh station a full lead up the road — so every
   * attempt to adjust the angle threw away the shot and started the approach
   * again from a kilometre out. Reframing is not "give me another shot": it is
   * "same shot, seen from over here".
   */
  private freeReshape = false;
  /**
   * Which way the aircraft is actually going, as a direction — not where its
   * nose points, and deliberately not a speed.
   *
   * A fly-by has to be planted on the path the aeroplane will fly. Using the
   * nose instead looks identical in level cruise and falls apart the moment it
   * is doing anything: under power it sits nose-high and climbs, so a camera
   * planted along the nose ends up above and ahead of a track that goes
   * somewhere else, and the aircraft crawls towards it without ever arriving.
   *
   * Only the direction is taken from here. Dividing the step by `dt` to get a
   * speed as well looks obvious and is wrong: the aircraft advances in
   * simulated time, in whole physics steps the loop may not have had room to
   * finish, while `dt` is the real frame. The two agree at a healthy frame rate
   * and diverge badly at a poor one, and the resulting speed — five times over,
   * in a slow frame — went straight into the lead, planting the camera a mile
   * and a half up the road. `tas` already carries the speed, correctly.
   */
  private readonly freeTrack = new THREE.Vector3();
  private readonly freeLastPos = new THREE.Vector3();
  private freeTrackKnown = false;
  /**
   * Whether a plain drag reframes instead of orbiting.
   *
   * Shift-drag has always done this; the toggle exists because reframing is a
   * two-handed gesture you hold for a while, and because a modifier leaves no
   * trace on screen of what the mouse is currently going to do.
   */
  private freeReframe = false;
  /** Damped copy of the aircraft's heading, so gusts do not reach the frame. */
  private freeYaw = 0;
  /** Velocity carried between frames, so the drag has some weight. */
  private freeSpinAz = 0;
  private freeSpinEl = 0;

  /**
   * Apply a mouse gesture to the free camera. Ignored in the other modes.
   *
   * The drag moves the camera *directly*, one pixel to a fixed angle, and only
   * leaves a little residual spin behind for the flick. Feeding the drag in as
   * a decaying rate — which is what this did — has a nasty property: a slow,
   * steady drag, which is exactly what you do when framing something, has each
   * frame's contribution eaten by the decay before the next arrives, so the
   * camera barely moves. The range was always a full circle; it just would not
   * go there at any speed you would naturally use.
   */
  moveFreeCamera(dx: number, dy: number, wheel: number, pan: boolean): void {
    if (this.mode !== 'free') return;
    // The render loop calls this every frame whether or not the mouse moved, so
    // an empty gesture has to be nothing at all. Taking the early return out
    // makes a world-locked camera re-plant on every frame, which is precisely
    // the aircraft lock wearing the other lock's label.
    if (dx === 0 && dy === 0 && wheel === 0) return;
    // Reaching for the framing means you want it applied now, not to a station
    // the camera left behind ten seconds ago — but for a planted camera that
    // means moving where it stands, not restarting the fly-by.
    if (this.freeWorldLocked) this.freeReshape = true;
    else this.freeAnchored = false;
    if (pan || this.freeReframe) {
      // Shift-drag nudges what the camera is *looking at* rather than where it
      // is, which is how you put the aircraft off-centre deliberately.
      this.freeAim.x = clamp(this.freeAim.x + dx * 0.05, -60, 60);
      this.freeAim.y = clamp(this.freeAim.y - dy * 0.05, -40, 40);
    } else {
      this.freeAzimuth += dx * ORBIT_PER_PIXEL;
      // Drag *up*, camera goes up and over the subject — the convention every
      // 3D tool uses. Taking the raw sign sends it under the aeroplane instead.
      this.freeElevation = clamp(this.freeElevation - dy * ORBIT_PER_PIXEL * 0.8, -1.35, 1.35);
      // What is left over carries the movement on for a moment after release.
      this.freeSpinAz += dx * ORBIT_PER_PIXEL * 0.10;
      this.freeSpinEl -= dy * ORBIT_PER_PIXEL * 0.08;
    }
    if (wheel !== 0) {
      // Multiplicative, so a click of the wheel moves the same *proportion* at
      // six metres and at six hundred.
      this.freeDistance = clamp(this.freeDistance * Math.exp(wheel * 0.0011), 6, 900);
    }
  }

  /**
   * Nine saved viewpoints, on the number keys.
   *
   * They start as nine that are worth having, and any of them can be
   * overwritten with whatever you have framed. That is nicer than a separate
   * set of "presets" and "saves": the defaults are simply the first thing in
   * each slot.
   */
  private readonly views: FreeView[] = [
    // A spread of distance and height rather than nine variations on "behind".
    /* 1 astern    */ { azimuth: Math.PI, elevation: 0.16, distance: 26, aimX: 0, aimY: 0, worldLocked: false },
    /* 2 abeam     */ { azimuth: Math.PI / 2, elevation: 0.08, distance: 30, aimX: 0, aimY: 0, worldLocked: false },
    /* 3 nose-on   */ { azimuth: 0, elevation: 0.14, distance: 34, aimX: 0, aimY: 0, worldLocked: false },
    /* 4 overhead  */ { azimuth: Math.PI, elevation: 1.20, distance: 55, aimX: 0, aimY: 0, worldLocked: false },
    /* 5 low six   */ { azimuth: Math.PI, elevation: -0.38, distance: 22, aimX: 0, aimY: 0, worldLocked: false },
    /* 6 high wide */ { azimuth: Math.PI * 0.72, elevation: 0.50, distance: 130, aimX: 0, aimY: 0, worldLocked: false },
    /* 7 wingtip   */ { azimuth: Math.PI * 0.58, elevation: 0.02, distance: 12, aimX: 0, aimY: 0, worldLocked: false },
    /* 8 long lens */ { azimuth: Math.PI * 1.28, elevation: 0.22, distance: 320, aimX: 0, aimY: 0, worldLocked: false },
    // The one world-locked default. Nothing else in the list shows what that
    // lock does, and from here the next turn the aircraft makes swings it right
    // through the frame — which is the whole point of the setting.
    /* 9 fly-by    */ { azimuth: Math.PI * 0.5, elevation: 0.05, distance: 70, aimX: 0, aimY: 0, worldLocked: true },
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
   * The same two gestures the free camera uses, minus the one this view owns:
   * dragging up and down raises and lowers the ring, the wheel opens it out and
   * pulls it in, and horizontal drag does nothing at all. Bearing is what the
   * orbit *is* — it sweeps on its own, at a rate the bar sets — so a sideways
   * drag could only fight the thing you came here to watch.
   *
   * Returns whether anything moved, so the caller knows when the bar's readouts
   * need redrawing and when the settings are worth writing out.
   */
  moveOrbitCamera(dy: number, wheel: number): boolean {
    if (this.mode !== 'orbit' || (dy === 0 && wheel === 0)) return false;
    if (dy !== 0) {
      // Drag up, camera rises — the same sign as the free camera's elevation,
      // and as every other 3D tool. A flat rate rather than one scaled by the
      // radius: this is a distance in metres, the bar states it in metres, and
      // a drag that covered eight metres near the aircraft and eighty out wide
      // would make the readout look broken.
      this.setOrbit({ height: this.orbit.height - dy * ORBIT_HEIGHT_PER_PIXEL });
    }
    if (wheel !== 0) {
      // Multiplicative, so a click of the wheel moves the same *proportion* at
      // twelve metres and at a hundred and sixty.
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

  /** Cut to a shot suited to something that just happened. */
  requestShot(event: string): void {
    this.director.request(event);
  }

  // ------------------------------------------------------------- hybrid mode

  /** Reshape the shot the director is playing. */
  adjustShot(dx: number, dy: number, wheel: number): void {
    if (this.mode !== 'director') return;
    this.director.adjust(dx, dy, wheel);
  }

  /** Cut straight to the next or previous setup. */
  stepShot(direction: 1 | -1): void {
    // Anything that picks a shot by hand takes the reel off the air — the reel
    // is a running order, and a running order somebody keeps overriding is not
    // one. Same reasoning as recalling a slot.
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

  /** Whether a held shot repeats its move or freezes on its last frame. */
  /** Whether every shot is played back to front. */
  get shotReversed(): boolean {
    return this.director.reversingAll;
  }

  setShotReversed(on: boolean): void {
    this.director.setReverseAll(on);
  }

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
  // Eight of them on the number keys, exactly as the free camera has eight
  // saved views: the number keys mean "my saved views" in whichever of the two
  // modes you are in, which is one rule to learn rather than two.
  private readonly slots: (ShotSlot | null)[] =
    [null, null, null, null, null, null, null, null, null];

  /**
   * The reel: which slots play, and in what order.
   *
   * Empty means "every filled slot, in slot order", so a reel works the moment
   * there is something to play without anyone having to compose one first.
   * Ordering it is then an edit of this array.
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

  /**
   * Cut to a saved setup and hold it.
   *
   * Holding is the point: a slot is something you saved because you wanted to
   * look at it, and a sequence that cut away four seconds later would make the
   * key useless. The auto/pinned button is the way back to the sequence.
   */
  recallShotSlot(index: number): ShotSlot | null {
    const slot = this.slots[index] ?? null;
    if (slot === null) return null;
    // Choosing a shot by hand stops the reel: two things cannot both be
    // deciding what is on screen.
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
    return this.mode === 'cinematic' || this.mode === 'director'
      ? { aperture: this.director.aperture, focusScale: this.director.focusScale }
      : { aperture: 0, focusScale: 1 };
  }

  update(dt: number, aircraft: Aircraft, t: Telemetry): void {
    const pos = aircraft.root.position;
    const quat = aircraft.root.quaternion;
    aircraft.setCockpitVisible(this.mode === 'cockpit');

    // The director owns the whole camera in this mode — position, aim and focal
    // length — so none of the shared framing below applies to it.
    if (this.mode === 'cinematic' || this.mode === 'director') {
      this.director.update(dt, pos, quat, t, this.camera, this.groundHeight);
      this.shake = damp(this.shake, t.stalled ? 0.35 : 0, 6, dt);
      this.applyShake();
      this.initialised = true;
      return;
    }

    // Speed drives FOV and a touch of shake — the cheap, reliable speed cues.
    const speedFactor = clamp(t.tas / 400, 0, 1.4);
    const targetFov =
      this.mode === 'cockpit'
        // Narrower than the outside views, not wider. A wide angle from the eye
        // point shrinks the canopy frame into the middle of the screen, which is
        // the opposite of sitting inside it.
        ? this.baseFov - 5 + speedFactor * 6
        : this.baseFov - 2 + speedFactor * 14 + t.afterburner * 4;
    this.fov = damp(this.fov, targetFov, 3, dt);

    // Speed shake belongs to the views that are *riding* the aircraft. The free
    // camera is one you are holding and aiming, and a hand-framed shot that
    // trembles reads as a fault rather than as speed — the cinematic director
    // opts out of it for the same reason.
    const buffet = t.stalled ? 0.7 : 0;
    const groundRush = smoothstep(260, 60, t.agl) * speedFactor * 0.35;
    const wanted = this.mode === 'free' ? 0 : buffet + groundRush + t.afterburner * 0.12;
    this.shake = damp(this.shake, wanted, 6, dt);

    switch (this.mode) {
      case 'chase':
        this.updateChase(dt, pos, quat);
        break;
      case 'cockpit':
        this.updateCockpit(dt, aircraft, pos, quat);
        break;
      case 'orbit':
        this.updateOrbit(dt, pos, t);
        break;
      case 'free':
        this.updateFree(dt, pos, quat, t);
        break;
    }

    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
    this.applyShake();
    this.initialised = true;
  }

  private updateChase(dt: number, pos: THREE.Vector3, quat: THREE.Quaternion): void {
    this._desired.set(0, 4.0, 17.5).applyQuaternion(quat).add(pos);
    this._lookAt.set(0, 1.0, -10).applyQuaternion(quat).add(pos);
    this.liftAboveGround(this._desired);

    if (!this.initialised) {
      this.position.copy(this._desired);
      this.target.copy(this._lookAt);
    } else {
      const k = 1 - Math.exp(-7 * dt);
      this.position.lerp(this._desired, k);
      this.target.lerp(this._lookAt, 1 - Math.exp(-11 * dt));
    }
    // Again after the lerp: easing between two points that are each above the
    // ground can still pass through a rise between them.
    this.liftAboveGround(this.position);

    // Blend a fraction of the aircraft's roll into the camera up-vector.
    this._aircraftUp.set(0, 1, 0).applyQuaternion(quat);
    this._blendUp.set(0, 1, 0).lerp(this._aircraftUp, 0.45).normalize();
    this.up.lerp(this._blendUp, 1 - Math.exp(-8 * dt)).normalize();

    this.camera.position.copy(this.position);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this.target);
  }

  private updateCockpit(
    dt: number,
    aircraft: Aircraft,
    pos: THREE.Vector3,
    quat: THREE.Quaternion,
  ): void {
    this._desired.copy(aircraft.eyePoint).applyQuaternion(quat).add(pos);
    this.camera.position.copy(this._desired);

    // A little rotational lag so hard manoeuvres read in the cockpit too.
    if (!this.initialised) this._q.copy(quat);
    else this._q.slerp(quat, 1 - Math.exp(-24 * dt));
    this.camera.quaternion.copy(this._q);
    this.camera.up.set(0, 1, 0).applyQuaternion(this._q);
  }

  /**
   * The camera you drive yourself.
   *
   * The drag sets a *rate* that decays rather than moving the camera directly:
   * a raw one-to-one drag feels like scrubbing a video, and every flick leaves
   * the camera exactly where the mouse stopped. With a little weight it settles
   * instead, which is what makes hand-held camera work look deliberate.
   */
  private updateFree(dt: number, pos: THREE.Vector3, quat: THREE.Quaternion, t: Telemetry): void {
    this.trackAircraft(dt, pos);
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

    // Smoothed, and by the shortest way round.
    //
    // Taking the yaw raw is what made this camera shake. The aeroplane is
    // permanently making small yaw corrections — gusts, the dutch roll, the
    // control laws — and with the camera's bearing welded to that yaw, every
    // one of them moved the camera *and* its aim at once. The chase view has
    // always damped both; this had neither, and jittered three times as much.
    let delta = yaw - this.freeYaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.freeYaw += delta * (1 - Math.exp(-5 * dt));

    const a = this.freeAzimuth + this.freeYaw;
    const horizontal = Math.cos(this.freeElevation) * this.freeDistance;
    this._desired.set(
      pos.x + Math.sin(a) * horizontal,
      pos.y + Math.sin(this.freeElevation) * this.freeDistance,
      pos.z + Math.cos(a) * horizontal,
    );
    this.liftAboveGround(this._desired);

    // Rigid to the aircraft, deliberately.
    //
    // Every other view smooths its position, and for a camera that is *riding*
    // the aeroplane that is right. For one that orbits it, it is what makes the
    // subject shake: the drawn aircraft advances in simulated time, which lags
    // real time by anything from zero to one physics step, while an
    // exponential filter on the camera runs on wall time. The two clocks
    // disagree by up to 8 ms — two metres at 240 m/s — and that difference is
    // visible on the aircraft and nowhere else. Below 60 fps the disagreement
    // changes every frame, which is exactly when it reads as shaking.
    //
    // Bolted to the subject, the aircraft cannot move in frame at all. Any
    // residual timing wobble goes to the scenery, where two metres at a
    // kilometre is nothing.
    if (this.freeWorldLocked) {
      // Standing in the world: take station once, then let the aircraft go.
      //
      // It is re-planted once the aeroplane is past and away, which turns the
      // lock into a run of fly-bys rather than a single one ending in a dot on
      // the horizon.
      if (!this.freeAnchored) {
        this.plantFlyby(pos, quat, t, null);
      } else if (this.freeReshape) {
        // Same moment of the same pass, from a different place beside it: hold
        // how far along the track the station sits and change only the miss.
        this.heading(this._flyby, quat);
        this.plantFlyby(pos, quat, t, this._step.copy(this.freeAnchor).sub(pos).dot(this._flyby));
      } else if (this.flybyOver(pos, quat)) {
        this.plantFlyby(pos, quat, t, null);
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
      // The aim offset is in screen terms — right and up as you see it — so it
      // is applied in the camera's own frame, not the world's.
      this._blendUp.copy(this._desired).sub(pos);
      this._blendUp.set(-this._blendUp.z, 0, this._blendUp.x).normalize(); // camera-right
      this._lookAt.addScaledVector(this._blendUp, this.freeAim.x);
      this._lookAt.y += this.freeAim.y;
    }

    this.camera.position.copy(this.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this._lookAt);
  }

  private updateOrbit(dt: number, pos: THREE.Vector3, t: Telemetry): void {
    this.orbitAngle += dt * this.orbit.direction * this.orbit.rate * (Math.PI / 30);
    const radius = this.orbit.distance + t.tas * 0.05;
    this._desired.set(
      pos.x + Math.cos(this.orbitAngle) * radius,
      pos.y + this.orbit.height,
      pos.z + Math.sin(this.orbitAngle) * radius,
    );
    this.liftAboveGround(this._desired);
    if (!this.initialised) this.position.copy(this._desired);
    else this.position.lerp(this._desired, 1 - Math.exp(-6 * dt));
    // The orbit radius puts the camera tens of metres to the side, which over
    // broken ground can easily be inside a hill the aircraft is clearing.
    this.liftAboveGround(this.position);

    this.camera.position.copy(this.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(pos);
  }

  /**
   * Keep a smoothed idea of where the aircraft is heading, from where it has
   * been. A reset or a change of world teleports it, so an implausible step is
   * treated as a fresh start rather than a very fast aeroplane.
   */
  private trackAircraft(dt: number, pos: THREE.Vector3): void {
    if (dt > 0 && this.freeTrackKnown) {
      this._step.copy(pos).sub(this.freeLastPos);
      const moved = this._step.length();
      if (moved > TELEPORT) {
        this.freeTrackKnown = false;
        // A reset, or a new landscape. A planted camera has every right to stay
        // where it was put while the aircraft flies, but not when the aircraft
        // stops flying and simply reappears somewhere else — that leaves the
        // shot pointed at a speck on the far side of the world.
        this.freeAnchored = false;
      }
      else if (moved > 1e-3) {
        this._step.divideScalar(moved);
        if (this.freeTrack.lengthSq() < 1e-6) this.freeTrack.copy(this._step);
        else this.freeTrack.lerp(this._step, 1 - Math.exp(-3 * dt)).normalize();
      }
    }
    if (!this.freeTrackKnown) {
      this.freeTrack.set(0, 0, 0);
      this.freeTrackKnown = true;
    }
    this.freeLastPos.copy(pos);
  }

  /**
   * The direction the aircraft is travelling, into `out`.
   *
   * Falls back to the nose when there is no track yet — a parked aeroplane has
   * none, and a fly-by of one is a still life whatever we choose.
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
   * by a lead long enough to watch it come in. What is left is the miss — how
   * far to the side, how far above — and that is kept exactly.
   */
  private plantFlyby(pos: THREE.Vector3, quat: THREE.Quaternion, t: Telemetry,
    keepAlong: number | null): void {
    this.heading(this._flyby, quat);

    this._miss.copy(this._desired).sub(pos);
    this._miss.addScaledVector(this._flyby, -this._miss.dot(this._flyby));

    // A framing from dead astern misses by nothing at all, which would put the
    // lens exactly on the flight path for the aircraft to fly through. Every
    // shot gets a miss; the direction of the pilot's framing is kept, so an
    // overhead view still passes overhead rather than being shoved sideways.
    const miss = Math.max(MIN_MISS, this.freeDistance * 0.35);
    if (this._miss.lengthSq() < miss * miss) {
      if (this._miss.lengthSq() > 1) this._miss.setLength(miss);
      else this._miss.set(1, 0, 0).applyQuaternion(quat).multiplyScalar(miss);
    }

    // Far enough ahead to be worth watching it arrive, and never so close that
    // a slow aeroplane is on top of the camera before the shot has begun —
    // unless this is a reframe, which keeps whatever is left of the pass. That
    // number is negative once the aeroplane is past, and it should be: you can
    // change the angle on a departing aircraft without it flying back at you.
    let lead = keepAlong ?? Math.max(t.tas * LEAD_SECONDS, this.freeDistance * 3);

    // A descending track plants the station below the ground, and lifting it
    // back out — which is what has to happen, a buried camera sees nothing —
    // silently wrecks the shot: the station leaves the flight path, and the
    // aeroplane that was going to pass at fourteen metres passes a kilometre
    // and a half overhead instead. Shorten the lead until the station clears
    // the terrain, so it stays *on* the path and the shot is merely briefer.
    // Backing off geometrically rather than solving for it makes no assumption
    // about the ground being flat, which over this terrain it is not.
    // Only when taking fresh station. A reframe has a lead it must keep, and
    // shortening it to dodge the ground would be the shot skipping forwards
    // under the pilot's hand; the lift below covers that case instead.
    if (keepAlong === null) {
      for (let i = 0; i < 8 && this.clearance(pos, lead) < CAMERA_MIN_CLEARANCE; i++) lead *= 0.6;
    }

    this.freeAnchor.copy(pos).add(this._miss).addScaledVector(this._flyby, lead);
    // Still the backstop, for a dive straight at a cliff face where no lead is
    // short enough. That shot is lost either way; the camera should at least
    // not be inside a hill.
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
   * "Past" is the sign of the camera's bearing along the nose, not a distance:
   * planting puts the aircraft most of a kilometre away to begin with, so a
   * plain distance test would call the shot over on the frame it started.
   */
  private flybyOver(pos: THREE.Vector3, quat: THREE.Quaternion): boolean {
    this.heading(this._flyby, quat);
    this._miss.copy(this.freeAnchor).sub(pos);
    // Still ahead on the current track: the shot has not happened yet. This is
    // also what rescues a shot the aeroplane has turned out of — the camera
    // falls behind the new track, and the next line cuts to a fresh one.
    if (this._miss.dot(this._flyby) > 0) return false;
    return this._miss.length() > Math.max(this.freeDistance * 8, MIN_FLYBY);
  }

  /**
   * Hold an outside camera above whatever is under it.
   *
   * The chase offset is fixed in the *aircraft's* frame, so pitching up swings
   * it downward: 4 m up and 17.5 m back becomes 0.7 m *below* the aircraft at
   * 15° nose-up and 3.8 m below at 25°. On a takeoff rotation, where the
   * aircraft itself is only a gear height off the runway, that buries the lens
   * in the tarmac. Clamping here rather than shortening the boom keeps the
   * framing intact at every other attitude.
   */
  private liftAboveGround(p: THREE.Vector3): void {
    const floor = this.groundHeight(p.x, p.z) + CAMERA_MIN_CLEARANCE;
    if (p.y < floor) p.y = floor;
  }

  /** Rotational jitter, applied after aiming so it never fights the look-at. */
  private applyShake(): void {
    if (this.shake < 0.001) return;
    const a = this.shake * 0.006;
    this._shakeEuler.set(
      (Math.random() - 0.5) * a,
      (Math.random() - 0.5) * a,
      (Math.random() - 0.5) * a * 1.6,
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

/**
 * Metres of orbit height per pixel of drag.
 *
 * The full range is a hundred metres, so this puts it four hundred pixels
 * apart — a deliberate drag rather than a flick, and roughly what the slider
 * beside it costs to sweep end to end.
 */
const ORBIT_HEIGHT_PER_PIXEL = 0.25;

/**
 * How far the aircraft may draw away from a world-locked camera before it takes
 * fresh station, metres — a floor under the distance-scaled threshold.
 *
 * At 220 m/s this is a little over three seconds — long enough to read as a
 * shot that ends, where a couple of hundred metres re-plants roughly once a
 * second and reads as a stutter. The aeroplane is small by the end of it, which
 * is what watching one fly away looks like.
 */
const MIN_FLYBY = 700;

/**
 * How many seconds of approach a fly-by is planted with.
 *
 * At 220 m/s that is most of a kilometre of the aeroplane growing in the frame,
 * which with the departure above makes a shot around seven seconds long.
 */
const LEAD_SECONDS = 4;

/**
 * The closest a fly-by will let the aircraft pass the lens, metres.
 *
 * Near enough to be a whip, far enough that the aeroplane does not fly through
 * the camera — which is what a framing from dead astern would otherwise ask for.
 */
const MIN_MISS = 14;

/** A one-frame move further than this is a reset, not flight, metres. */
const TELEPORT = 500;

/**
 * Radians of orbit per pixel of drag — about a quarter of a degree, so a
 * comfortable 300 px drag swings the camera through roughly seventy degrees and
 * a full circle is two of them.
 */
const ORBIT_PER_PIXEL = 0.004;
