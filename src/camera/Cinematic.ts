import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../util/math';
import type { CameraTelemetry, CombatBody, CombatContext } from './Subject';

/**
 * A director for the cinematic camera.
 *
 * Two ideas do most of the work here, and neither is about the individual shots.
 *
 * The first is that a shot is a *move* — a start offset, an end offset and a
 * focal length that changes across it — rather than a viewpoint. A camera that
 * only sits still reads as a security monitor however well it is placed.
 *
 * The second is that the order matters more than the contents. Shuffling a good
 * shot list gives a slideshow. What gives a sequence shape is grammar: work
 * through a scale in one direction so the audience is led in or led out, hold
 * the line so the subject keeps moving the same way across a cut, and punctuate
 * the end of a phrase rather than running on. That is what `cut` implements.
 *
 * The library is authored for a 1917 scout — about 6.5 m long, 8.5 m across
 * the wings, cruising at 50 m/s — and every framing distance is multiplied by
 * the subject's `cameraScale`, so the same wingtip shot frames a Camel and a
 * Gotha. Times are not scaled: a shot is held as long whatever it shows.
 *
 * And it knows about the fight. When there is an enemy within reach the
 * sequence leans on the combat setups — over the shoulder at the bandit, from
 * beside the player at the target, from the bandit back at the player — and a
 * kill cuts to the victim going down for a few seconds before handing back.
 */

export type Scale = 'wide' | 'medium' | 'close';

const SCALES: Scale[] = ['wide', 'medium', 'close'];

/**
 * A landmark the camera can work with, rather than merely aim past.
 *
 * `y` is the ground it stands on and `height` is how far it rises above that,
 * so a tripod can be put at its foot or level with its top without the camera
 * having to know what a church spire is.
 */
export interface LandmarkTarget {
  x: number;
  y: number;
  z: number;
  height: number;
  /** How far it spreads from its own axis, metres. */
  radius: number;
  kind: string;
}

/** What the rig tells the director about the aircraft it is following. */
export interface DirectorSubject {
  /** `cameraScale` of the player's aircraft; 1 is a single-seat scout. */
  scale?: number;
  /** Body-space pilot eye, for the mounted setups. */
  eye?: THREE.Vector3;
  /** World velocity, m/s. */
  velocity?: THREE.Vector3;
}

interface ShotSpec {
  name: string;
  scale: Scale;
  /**
   * Which side of the flight path the camera sits on.
   *
   * 1 means off to one side — these are *mirrored* onto whichever side the
   * sequence is currently working, which both doubles the library for free and
   * is what lets the line be held. 0 means on the axis itself: head-on, dead
   * astern, directly overhead. Those are neutral, and a neutral shot is the
   * legitimate way to cross to the other side.
   */
  side: 0 | 1;
  /**
   * Camera offset in the subject's frame: +X right, +Y up, +Z aft. Metres at
   * the reference scale — multiplied by the subject's `cameraScale`.
   */
  from: [number, number, number];
  to: [number, number, number];
  /** What the camera is aimed at, offset in the subject's frame. */
  look?: [number, number, number];
  /** Focal feel, in degrees of field of view, across the move. */
  fov: [number, number];
  /**
   * Plant the camera in world space at the cut rather than carrying it with the
   * aircraft — the fly-by. `to` is ignored.
   */
  locked?: boolean;
  /** Radians swept around the aircraft over the shot. */
  orbit?: number;
  /** Dutch angle, radians. */
  roll?: number;
  /** Easing of the offset. 0 is rigid; higher is looser. */
  lag?: number;
  /** A move that should run at constant speed rather than easing in and out. */
  linear?: boolean;
  /** Override the duration this shot's scale would otherwise get. */
  seconds?: [number, number];
  /**
   * Where the camera sits relative to something in the world rather than to
   * the aircraft's heading.
   *
   * 'sun' puts the subject between the lens and the sun — a silhouette,
   * rim-lit at low sun. 'landmark' puts the nearest village, church or fort
   * behind the subject, and 'structure' does the same with the nearest *built*
   * landmark, which is a different question with a different answer.
   *
   * 'target' and 'threat' are the fight: the frame's −Z points from the player
   * at the enemy being fought (or at the one on the player's tail), so an
   * offset aft of the player is over the shoulder with the bandit beyond it.
   * 'player' is the same thing seen from the target's side, for shots whose
   * subject is the enemy. These three read all of `from` — X is to the side of
   * that line, Y above it — and the line itself is damped, so a bandit that
   * crosses overhead swings the camera round rather than flipping it.
   */
  azimuth?: 'sun' | 'landmark' | 'structure' | 'target' | 'threat' | 'player';
  /**
   * Who the shot is of. The player unless it says otherwise: 'target' is the
   * enemy being fought, framed in its own velocity frame, and 'victim' is an
   * aircraft that has just been shot down — the kill cam.
   */
  subject?: 'player' | 'target' | 'victim';
  /**
   * Frame two aircraft rather than one: aim this far from the subject toward
   * the other one (the target, the threat, or — for a shot of the target — the
   * player), and open the lens as they separate so both stay in the picture.
   */
  pair?: number;
  /**
   * Bolted to the airframe. The offset is read in the aircraft's full body
   * frame — it pitches and rolls with it — and 'eye' measures it from the
   * pilot's eye rather than the CG. The camera rolls with the aeroplane: the
   * world tilts past, which is what an on-board camera looks like.
   */
  mount?: 'body' | 'eye';
  /** Aim along the guns, drifting onto the target when it is near the sight. */
  guns?: boolean;
  /** Show the cockpit interior (and hide the pilot's head) for this shot. */
  interior?: boolean;
  /** Near clip plane this shot needs, metres. */
  near?: number;
  /**
   * Part of the combat pool: preferred while there is an enemy in reach.
   * Shots that need a target or a threat are combat shots whatever this says.
   */
  combat?: boolean;
  /** A combat shot that also works, and is dealt, in plain flight. */
  scenic?: boolean;
  /**
   * Plant this locked shot at the landmark instead of on the flight path —
   * or, for 'merge', beside the point where the player and the target are
   * going to pass each other.
   *
   * For 'landmark', `from` is read in the landmark's own frame: −Z points from
   * the landmark toward the aeroplane, so a negative Z stands the camera out in
   * front of it and a positive Z puts the landmark between the lens and the
   * subject. And it is in *landmark sizes*, not in metres: a ruined village,
   * a church and a castle are nowhere near a common size, and a standoff in
   * metres that frames one of them buries the lens in another. Stated as a
   * multiple, one number composes the same picture at every one of them.
   *
   * For 'merge', X is how far to the side of the player's track the tripod
   * stands and Y how far above the meeting point, both scaled by the player.
   */
  anchor?: 'landmark' | 'merge';
  /**
   * For anchored shots: how far up the landmark to stand, as a fraction of its
   * height. 0 is the ground at its foot; 1 is level with the top of it.
   */
  anchorHeight?: number;
  /**
   * For anchored shots: the landmarks this one is written for. Undefined means
   * it works at anything.
   */
  anchorKind?: string[];
  /**
   * For locked shots: where in the shot the aircraft should reach the camera,
   * as a fraction of the shot's length.
   *
   * A tripod is placed a certain distance up the track, but how long the
   * aeroplane takes to get there is that distance over its speed — so a fixed
   * offset and a fixed duration only agree at one airspeed. Stating the intent
   * instead lets the distance follow from it: the camera goes
   * `tas * duration * pass` metres up the track, so the pass lands where the
   * shot was composed to put it whatever the aeroplane is doing.
   */
  pass?: number;
  /** For locked shots: a boom, in world metres (scaled), run across the shot. */
  anchorMove?: [number, number, number];
  /** Handheld: radians of slow drift added to the aim. */
  float?: number;
  /** Lead room, in metres ahead of the nose, overriding the per-scale default. */
  lead?: number;
  /** Aperture for this shot: 0 keeps everything sharp, ~1.4 is a fast lens. */
  dof?: number;
  /** Focus plane across the shot, as a multiple of the subject's distance. */
  rack?: [number, number];
  /** Events this shot is suitable for. */
  tags?: string[];
  /**
   * Kept out of the ordinary rotation: the sequencer never picks it, and it is
   * reached only when an event asks for it by tag (or by hand, from the
   * picker). For a shot that means something — the aircraft leaving — playing
   * it in the middle of a cruise says the opposite of what it is for.
   */
  reserved?: boolean;
}

/**
 * The shot list. Offsets are metres for a single-seat scout, and X is always
 * positive — the sequencer mirrors them onto whichever side it is working.
 *
 * The reference airframe, which is what "close" is measured against: the
 * propeller disc is about 1.3 m in radius a little over three metres ahead of
 * the CG, the upper wing is 8.5 m across and sits 1.2 m above the CG, the lower
 * one a little narrower and 0.3 m below, the tail is 3.5 m aft and the pilot's
 * eye about a metre up and half a metre aft. Nothing carried with the aircraft
 * comes nearer the CG than 5.2 m unless it is bolted on (`mount`), where the
 * geometry was placed by hand.
 *
 * The aircraft's nose points along −Z, so a negative Z offset puts the camera
 * *ahead* of it, which for a locked shot is what gives it something to fly at.
 */
const SHOTS: ShotSpec[] = [
  // ------------------------------------------------------------------- wide
  {
    name: 'establishing', scale: 'wide', side: 1, from: [62, 20, 40], to: [47, 15, 30],
    fov: [34, 30], lag: 2.2,
  },
  {
    name: 'orbit high', scale: 'wide', side: 1, from: [46, 22, 10], to: [34, 15, 8],
    orbit: -Math.PI * 0.55, fov: [36, 30], lag: 2.5,
  },
  {
    name: 'crane down', scale: 'wide', side: 1, from: [16, 110, 34], to: [7, 36, 13],
    fov: [52, 40], lag: 2,
  },
  {
    // Lead room cut right down. Aiming ahead of the nose leaves the subject
    // space to move into, which is right from beside the aircraft and wrong
    // from directly above it: there is no 'ahead' on screen up here.
    name: 'bird’s eye', scale: 'wide', side: 0, from: [0, 75, 4], to: [0, 56, 17],
    look: [0, 0, -3], fov: [46, 46], lag: 3, lead: 3.5,
  },
  {
    name: 'vertical rise', scale: 'wide', side: 0, from: [0, 16, 35], to: [0, 100, 70],
    fov: [42, 48], lag: 2, linear: true,
  },
  {
    name: 'pull-back reveal', scale: 'wide', side: 1, from: [11, 3.5, 13], to: [64, 22, 58],
    fov: [44, 32], lag: 2.5,
  },
  {
    name: 'high astern', scale: 'wide', side: 0, from: [0, 27, 74], to: [0, 19, 52],
    fov: [36, 32], lag: 3,
  },
  // ----------------------------------------------------------- the narrative
  //
  // Every other shot in this library aims *at* the aeroplane. These two are
  // about the flight rather than the aircraft: one shows what it is going
  // towards, and one simply stops for a while.
  {
    // Over the shoulder. The lead is enormous on purpose — aiming two hundred
    // metres up the track drops the aeroplane into the bottom of the frame and
    // hands the rest of the picture to the country it is flying into.
    name: 'over the shoulder', scale: 'medium', side: 0,
    from: [0, 3, 12], to: [0, 2.4, 9.5], look: [0, 0.7, 0],
    lead: 200, fov: [40, 36], lag: 4,
  },
  {
    // The rest. Long, still, and nearly flat: ten seconds of holding.
    name: 'the rest', scale: 'wide', side: 1,
    from: [100, 22, 72], to: [97, 21.5, 69], look: [0, -7, 0],
    fov: [30, 30], lag: 2.4, float: 16e-4, seconds: [8.5, 10.5],
  },
  // --------------------------------------------- wide, level with the aircraft
  //
  // The offset is applied in the aircraft's yaw frame alone, so a zero here is
  // the aircraft's own altitude however it is pitched or banked, and the camera
  // keeps world-up — the aeroplane rolls, the horizon does not. Each of these
  // aims a few metres *below* the aircraft, which lifts subject and horizon
  // together onto an upper third and leaves the rest to the country.
  {
    // The landscape shot. Far out on a long lens, so the ground stacks up the
    // way it does through a real telephoto, and the aeroplane is a small hard
    // shape in a wide soft frame.
    name: 'long lens', scale: 'wide', side: 1, from: [245, 1, 20], to: [205, 0, 5],
    look: [0, -14, 0], fov: [22, 20], lag: 3,
  },
  {
    // Dead astern at the aircraft's own height: it sits on the horizon with the
    // land running away to the vanishing point behind it.
    name: 'level astern', scale: 'wide', side: 0, from: [0, 0.5, 140], to: [0, 0, 90],
    look: [0, -8, 0], fov: [26, 22], lag: 3.5,
  },
  {
    name: 'sun path', scale: 'wide', side: 0, azimuth: 'sun', from: [0, 1.5, 115],
    to: [0, 0.5, 72], look: [0, -7, 0], fov: [28, 24], lag: 3, dof: 0.3,
  },
  {
    // The opposite lens. Close off the wingtip and wide enough that the country
    // wraps round behind — level like the others, and reads nothing like them.
    name: 'wing walk', scale: 'wide', side: 1, from: [22, 0, 3], to: [36, 1.2, -9],
    look: [0, -3.5, 0], fov: [48, 44], lag: 4, lead: 10, float: 16e-4,
  },
  {
    // A level orbit: the horizon itself swings round behind the aeroplane.
    name: 'level orbit', scale: 'wide', side: 1, from: [118, 1, 28], to: [108, 0.5, 24],
    look: [0, -9, 0], orbit: -Math.PI * 0.375, fov: [30, 27], lag: 3,
  },
  {
    // Planted at the aircraft's own altitude up the track: it grows from a
    // speck and goes past at eye height.
    name: 'level pass', scale: 'wide', side: 1, locked: true, pass: 0.75, from: [40, 0, -250],
    to: [40, 0, -250], look: [0, -15, 0], fov: [34, 30], seconds: [4.6, 5.8],
  },
  // ----------------------------------------------------------------- medium
  {
    name: 'side profile', scale: 'medium', side: 1, from: [40, 3.5, -4], to: [21, 2, 1.5],
    fov: [38, 34], lag: 3,
  },
  {
    name: 'frontal push', scale: 'medium', side: 0, from: [1.5, 2, -54], to: [0.5, 1, -16],
    fov: [40, 32], lag: 5,
  },
  {
    name: 'three-quarter front', scale: 'medium', side: 1, from: [23, 5, -30],
    to: [13, 3, -15], fov: [42, 36], lag: 4, dof: 0.54,
  },
  {
    name: 'three-quarter rear', scale: 'medium', side: 1, from: [20, 7, 28],
    to: [12, 4, 17], fov: [44, 38], lag: 4,
  },
  {
    name: 'lateral dolly', scale: 'medium', side: 1, from: [20, 2.5, -19], to: [20, 2.5, 19],
    fov: [44, 44], lag: 4, linear: true,
  },
  {
    name: 'overtake', scale: 'medium', side: 1, locked: true, pass: 0.36, from: [7, 4, -70],
    to: [7, 4, -70], fov: [46, 34], seconds: [2.6, 3.4], reserved: true,
    tags: ['flourish'],
  },
  {
    name: 'low tracking', scale: 'medium', side: 1, from: [17, -9.5, -10], to: [11, -5, -4],
    fov: [46, 40], lag: 4, dof: 0.48, float: 3e-3,
  },
  {
    name: 'climb reveal', scale: 'medium', side: 1, from: [28, -13, 32], to: [10.5, 11.5, 19],
    fov: [44, 36], lag: 2.5,
  },
  // ------------------------------------------------------------------ close
  {
    // Just outboard of the upper wingtip and a little behind it, looking in
    // along the bays — struts, wires and the pilot beyond. The end of the push
    // is the shot, so it stops a metre and a half clear of the tip.
    name: 'wingtip', scale: 'close', side: 1, from: [8.2, 1.9, 3.0], to: [5.6, 1.5, 1.2],
    look: [0, 0.9, -1.2], fov: [58, 52], roll: -0.09, lag: 6, dof: 0.9, float: 4e-3,
  },
  {
    // Ahead of the wing and above it, looking down and back into the open
    // cockpit: the pilot's head over the coaming, the gun breeches in front of
    // him. Above the upper wing on purpose — from level with it, the wing is
    // all you would see.
    name: 'open cockpit', scale: 'close', side: 1, from: [6.5, 3.2, -5.0],
    to: [4.2, 2.4, -2.6], look: [0, 1.0, 0.5], fov: [52, 46], lag: 6, dof: 0.96, float: 5e-3,
  },
  {
    name: 'tail chase', scale: 'close', side: 0, from: [0, 2.2, 12], to: [0, 1.7, 7.5],
    look: [0, 0.3, 3], fov: [50, 44], lag: 6, dof: 0.66,
  },
  {
    name: 'belly rear', scale: 'close', side: 1, from: [3.5, -6.5, 26], to: [1.6, -2.4, 12],
    look: [0, -0.3, 1], fov: [50, 44], lag: 5,
  },
  {
    // Pushing in on the nose while the lens widens: the background stretches
    // away behind a spinning propeller that barely changes size.
    name: 'nose chase', scale: 'close', side: 1, from: [6.5, 1.4, -17], to: [3.2, 0.9, -7.5],
    look: [0, 0.3, -1], fov: [44, 56], lag: 6, dof: 0.78,
  },
  {
    // Held twice as long as a close shot normally is: the arc is most of a
    // half-circle, and at the usual three-and-a-bit seconds it was a whip pan.
    name: 'orbit close', scale: 'close', side: 1, from: [13, 2.5, 3], to: [9.5, 1.6, 2],
    orbit: Math.PI * 0.85, fov: [50, 44], lag: 4, seconds: [6, 8.4],
  },
  {
    name: 'rising arc', scale: 'close', side: 1, from: [10, -3.5, 4.5], to: [8, 4.5, 2],
    orbit: Math.PI * 0.5, fov: [52, 46], lag: 4, seconds: [3.75, 5.25],
  },
  {
    // Bolted to the fuselage above and behind the pilot's right shoulder,
    // looking forward over his head, the guns and the top wing at whatever is
    // ahead. With a bandit out there it is the fight; without, the country.
    name: 'pilot’s shoulder', scale: 'close', side: 1, mount: 'eye',
    from: [0.42, 0.34, 0.8], to: [0.32, 0.27, 0.58], look: [0, 0.15, -40],
    fov: [62, 58], lag: 5, near: 0.08, combat: true, scenic: true,
  },
  {
    // The rotary up close: level with the cowling, just outside the disc and
    // a little ahead of it, looking back past the blur at the pilot. Carried
    // in the body frame, so the world wheels past as the aeroplane rolls.
    name: 'prop close-up', scale: 'close', side: 1, mount: 'body',
    from: [2.4, 0.5, -4.7], to: [1.9, 0.4, -3.9], look: [0, 0.6, -0.6],
    fov: [54, 50], lag: 5, near: 0.1, dof: 0.7,
  },
  {
    name: 'fly-by low', scale: 'close', side: 1, locked: true, pass: 0.78, from: [18, -6, -250],
    to: [18, -6, -250], fov: [38, 30], roll: 0.05, seconds: [4.8, 5.8], reserved: true,
    tags: ['flourish'],
  },
  // ------------------------------------------------------------- new angles
  {
    // The only setup with the horizon along the bottom of frame: planted on the
    // ground (the floor catches it) beside the aeroplane's path.
    name: 'ground plate', scale: 'wide', side: 1, locked: true, pass: 0.62, from: [30, -200, -300],
    to: [30, -200, -300], fov: [40, 34], anchorMove: [0, 10, 0], seconds: [4.6, 5.6],
    tags: ['takeoff'],
  },
  {
    // Underneath, looking up: the aeroplane against sky, nothing else in frame.
    name: 'underside', scale: 'close', side: 1, from: [4.5, -10, 7.5], to: [2.5, -5.5, 3.5],
    look: [0, 0, -1], fov: [54, 48], lag: 5, dof: 0.72,
  },
  {
    // Vertigo the other way: pull out while the lens narrows, so the background
    // crowds in behind a subject that holds its size.
    name: 'reverse dolly zoom', scale: 'medium', side: 1, from: [7.5, 2, -9.5],
    to: [27, 6, -35], fov: [58, 34], lag: 5, dof: 0.48,
  },
  {
    // Planted close and abeam: the pan speed comes free from the geometry.
    name: 'whip pass', scale: 'close', side: 1, locked: true, pass: 0.33, from: [11, -2, -80],
    to: [11, -2, -80], fov: [52, 52], seconds: [3.4, 4.2], reserved: true,
    tags: ['flourish'],
  },
  {
    // The quiet one. Opens on a soft wash of country and lets the aeroplane
    // resolve out of it.
    name: 'rack focus', scale: 'close', side: 1, from: [8.2, 1.3, 4.4], to: [7.2, 1.1, 3.4],
    look: [0, 0.3, -1], fov: [46, 44], lag: 5, dof: 1.3, rack: [2.6, 1],
    seconds: [3.2, 4.2], reserved: true, tags: ['flourish'],
  },
  {
    // Planted on the nose axis rather than abeam: it grows from a dot and the
    // aim whips through half a circle as it goes over. Seven metres up, so
    // eight and a half metres of wing pass underneath and not through.
    name: 'head-on pass', scale: 'close', side: 0, locked: true, pass: 0.8, from: [0, 7, -200],
    to: [0, 7, -200], fov: [44, 38], seconds: [3, 3.9], reserved: true, tags: ['flourish'],
  },
  // ------------------------------------------ flourishes that are not fly-bys
  {
    // Somebody standing in a field. Planted far out and low, so the aeroplane
    // crosses the frame small and distant — the world watching it go past.
    name: 'ground witness', scale: 'wide', side: 1, locked: true, pass: 0.55,
    from: [380, -220, -600], to: [380, -220, -600],
    fov: [26, 24], seconds: [5.0, 6.4], reserved: true, tags: ['flourish'],
  },
  {
    // Across the sun's disc, on a long lens, close. Held nearly still so the
    // aeroplane does the moving and goes to silhouette for a beat.
    name: 'sun crossing', scale: 'close', side: 0, azimuth: 'sun',
    from: [0, 1.5, 30], to: [0, 1, 23],
    fov: [30, 26], lag: 4, dof: 0.5, seconds: [3.0, 3.9],
    reserved: true, tags: ['flourish'],
  },
  {
    // The village or the fort held in frame while the aeroplane crosses it.
    name: 'landmark plant', scale: 'wide', side: 0, azimuth: 'landmark',
    from: [0, 13, 100], to: [0, 11, 86],
    fov: [30, 28], lag: 3.5, seconds: [4.4, 5.6],
    reserved: true, tags: ['flourish'],
  },
  {
    // The arrival beat: a long lens with the landmark behind the subject, so
    // it looms instead of receding and this reads as flying *to* somewhere.
    name: 'the approach', scale: 'wide', side: 0, azimuth: 'landmark',
    from: [0, 8, 150], to: [0, 6.5, 125], fov: [24, 21], lag: 3,
    seconds: [4.6, 5.8],
  },
  {
    name: 'into the sun', scale: 'medium', side: 0, azimuth: 'sun',
    from: [0, 3, 30], to: [0, 2, 19], look: [0, 0.3, -2],
    fov: [40, 34], lag: 4, dof: 0.54,
  },
  {
    name: 'sun rim', scale: 'close', side: 0, azimuth: 'sun',
    from: [0, 1.8, 10.5], to: [0, 1.4, 7], look: [0, 0.4, -1.5],
    fov: [48, 42], lag: 5, dof: 0.84, float: 0.004,
  },
  {
    name: 'landmark pass', scale: 'wide', side: 0, azimuth: 'landmark',
    from: [0, 19, 70], to: [0, 14, 45], fov: [34, 30], lag: 3, tags: ['landmark'],
  },
  {
    name: 'landmark low', scale: 'medium', side: 0, azimuth: 'landmark',
    from: [0, 4, 35], to: [0, 3, 23], look: [0, 0.3, -1],
    fov: [42, 36], lag: 4, dof: 0.42, tags: ['landmark'],
  },
  {
    // The longest lens in the library, pointed at a built landmark. A spire or
    // a keep on an ordinary lens sits on the horizon looking like scenery;
    // compressed, it stands behind the aeroplane at its real importance.
    name: 'summit line', scale: 'wide', side: 0, azimuth: 'structure',
    from: [0, 9, 170], to: [0, 7.5, 140], fov: [22, 19], lag: 3,
    seconds: [4.8, 6.0],
  },

  // ------------------------------------------- planted at the landmark itself
  //
  // The ordinary tripod stands where the aeroplane is going. These stand at
  // something, and the something is in the frame. All of them sit on the far
  // side of the landmark from the aeroplane, so it is the landmark the lens
  // looks past.
  {
    // Foreground, and a focus pull off it.
    name: 'landmark rack', scale: 'medium', side: 1, locked: true,
    anchor: 'landmark', from: [0.15, 0.07, 2.0], to: [0.15, 0.07, 2.0],
    fov: [38, 34], dof: 1.25, rack: [0.45, 1.0], seconds: [4.6, 5.8],
  },
  {
    // Up at it. Close in under a spire or a tower, so it runs the full height
    // of frame and the aeroplane crosses the top of it.
    name: 'the sentinel', scale: 'wide', side: 1, locked: true,
    anchor: 'landmark',
    anchorKind: ['church', 'spire', 'tower', 'belfry', 'balloon', 'lighthouse', 'mast'],
    from: [0.30, 0.03, 1.7], to: [0.30, 0.03, 1.7], fov: [50, 44],
    seconds: [4.8, 6.0],
  },
  {
    // Level with the top of the wall. Looking *down* on a fort is the ordinary
    // aerial view of one; being level with it is the angle that says how high
    // the thing was built.
    name: 'the battlement', scale: 'wide', side: 1, locked: true,
    anchor: 'landmark',
    anchorKind: ['castle', 'fort', 'citadel', 'chateau', 'abbey', 'monastery', 'observatory'],
    anchorHeight: 0.78,
    from: [0.42, 0.06, 3.6], to: [0.42, 0.06, 3.6], fov: [40, 35],
    anchorMove: [0, 0.14, 0], seconds: [5.0, 6.2],
  },
  {
    // Low behind broken walls, so they cut across the aircraft as it passes.
    // Occlusion is the strongest depth cue there is.
    name: 'ruin pass', scale: 'medium', side: 1, locked: true,
    anchor: 'landmark',
    anchorKind: ['village', 'ruin', 'town', 'farm', 'factory', 'powerplant'],
    anchorHeight: 0.18,
    from: [0.07, 0.05, 1.2], to: [0.07, 0.05, 1.2], fov: [36, 32], dof: 0.7,
    seconds: [4.4, 5.6],
  },
  {
    // Among the sails. They already turn, so the near one sweeping through the
    // frame costs nothing and is the only moving foreground there is.
    name: 'mill sails', scale: 'medium', side: 1, locked: true,
    anchor: 'landmark', anchorKind: ['windmill', 'mill', 'turbine'], anchorHeight: 0.34,
    from: [0.25, 0.02, 1.7], to: [0.25, 0.02, 1.7], fov: [44, 38], dof: 1.1,
    rack: [0.5, 1.0], seconds: [4.4, 5.6],
  },
  {
    // A ground-anchored crane: planted in the world, booming up as it passes.
    name: 'crane pass', scale: 'wide', side: 1, locked: true, pass: 0.5,
    from: [55, -28, -200], to: [55, -28, -200], fov: [42, 36],
    anchorMove: [0, 56, 0], seconds: [5.0, 6.2],
  },
  {
    // Beside the grass strip, low, for the take-off run and the landing.
    name: 'field plate', scale: 'medium', side: 1, locked: true, pass: 0.44,
    from: [22, -14, -130], to: [22, -14, -130], fov: [44, 34],
    seconds: [4.0, 5.0], tags: ['takeoff', 'landing'],
  },

  // ------------------------------------------------------- the way back out
  // Every one of these *pulls out*. The scale ladder runs both ways, and coming
  // back up it — close, medium, wide — a medium shot that pushes in fights the
  // direction of travel and makes the cut to the wide feel like a jump.
  {
    name: 'peel away', scale: 'close', side: 1,
    from: [5.6, 0.9, 2.2], to: [12, 4.5, 11], fov: [52, 46], lag: 4, dof: 0.54,
  },
  {
    name: 'drop back', scale: 'medium', side: 0,
    from: [0, 1.8, 9], to: [0, 6, 46], fov: [46, 40], lag: 3.5, dof: 0.36,
  },
  {
    name: 'wide retreat', scale: 'medium', side: 1,
    from: [14, 4, 10.5], to: [46, 14, 43], fov: [44, 38], lag: 3, linear: true,
  },
  {
    name: 'lift out', scale: 'wide', side: 1,
    from: [33, 12, 26], to: [85, 56, 72], fov: [40, 34], lag: 2.4, linear: true,
  },
  {
    // The aeroplane leaving. Only at the departure — it reads as an ending.
    name: 'departure', scale: 'wide', side: 0,
    from: [0, 14, 56], to: [0, 42, 215], fov: [38, 30], lag: 2.2, linear: true,
    tags: ['takeoff'], reserved: true,
  },

  // ================================================================ the fight
  //
  // Everything above is a shot of an aeroplane. These are shots of a fight,
  // and a fight has two aircraft in it: most of them are framed on the line
  // between the player and the enemy (`azimuth: 'target'`), aim between the
  // two (`pair`), and open the lens as they separate so neither leaves frame.
  {
    // Over the Vickers breeches, a hand's width above the pilot's eye: the
    // gun camera. Aims down the barrels and drifts onto the bandit when he is
    // near the sight.
    name: 'guns-eye', scale: 'close', side: 0, mount: 'eye', guns: true, interior: true,
    from: [0.0, 0.14, -0.32], to: [0.0, 0.12, -0.42], look: [0, 0.1, -80],
    fov: [46, 42], lag: 6, near: 0.05, combat: true, scenic: true, tags: ['engage'],
  },
  {
    // Over the shoulder at the bandit: behind and above the player on the line
    // from the enemy, both of them in frame.
    name: 'on his six', scale: 'close', side: 0, azimuth: 'target', pair: 0.45,
    from: [1.2, 2.6, 11], to: [0.8, 2.0, 8], lead: 0, fov: [52, 48], lag: 4,
    tags: ['engage'],
  },
  {
    // A wingman's view: from off the player's wing, looking across at the
    // target.
    name: 'wingman view', scale: 'medium', side: 1, azimuth: 'target', pair: 0.55,
    from: [13, 3, 5], to: [10, 2.2, 2], lead: 0, fov: [50, 46], lag: 3,
    tags: ['engage'],
  },
  {
    // From beyond the bandit, looking back at the player: the enemy big in the
    // foreground and the pursuer behind him.
    name: 'pursuit', scale: 'medium', side: 1, subject: 'target', azimuth: 'player', pair: 0.5,
    from: [3.2, 2.2, 10], to: [2.4, 1.6, 7.5], lead: 0, fov: [48, 44], lag: 3.5,
  },
  {
    // Low, just outboard of the wingtip, looking aft past the tailplane at the
    // one on the player's tail — the view a gunner would have.
    name: 'tail gunner', scale: 'medium', side: 1, azimuth: 'threat', pair: 0.6,
    from: [5.4, -1.6, 2.5], to: [5.0, -1.2, 1.2], lead: 0, fov: [56, 50], lag: 4,
    tags: ['hit'],
  },
  {
    // Ahead of the player, looking back at him and at the machine behind him.
    name: 'check six', scale: 'medium', side: 0, azimuth: 'threat', pair: 0.5,
    from: [1.5, 2.5, 18], to: [1.0, 2.0, 12], lead: 0, fov: [44, 40], lag: 3.5,
    tags: ['hit'],
  },
  {
    // High and behind, looking down past the player at a bandit below: the
    // classic high-side attack.
    name: 'high side', scale: 'medium', side: 1, azimuth: 'target', pair: 0.5,
    from: [8, 16, 14], to: [6, 11, 9], lead: 0, fov: [50, 46], lag: 3,
  },
  {
    // The enemy machine itself, in profile, in its own track.
    name: 'bandit', scale: 'close', side: 1, subject: 'target',
    from: [9, 1.5, 2], to: [7, 1.0, -1.5], look: [0, 0.3, -1], lead: 1,
    fov: [44, 40], lag: 4, dof: 0.6,
  },
  {
    // The whole fight from well outside it: two machines circling.
    name: 'furball', scale: 'wide', side: 1, azimuth: 'target', pair: 0.5,
    from: [80, 28, 55], to: [70, 24, 45], lead: 0, fov: [40, 38], lag: 2,
  },
  {
    // Low and off to the side, looking up at the player against the sky —
    // where the archie bursts.
    name: 'flak burst', scale: 'wide', side: 1, from: [60, -30, -10], to: [52, -24, 5],
    look: [0, 6, 0], fov: [42, 40], lag: 3, combat: true, tags: ['flak'],
  },
  {
    // A tripod beside the point where the two of them are going to pass: they
    // come at the lens, cross, and are gone.
    name: 'crossing', scale: 'medium', side: 1, locked: true, anchor: 'merge', pair: 0.5,
    from: [24, 4, 0], to: [24, 4, 0], lead: 0, fov: [46, 42], seconds: [4.0, 5.4],
    tags: ['engage'],
  },
  {
    // The kill cam: chasing the victim down, a little behind and above it.
    name: 'kill cam', scale: 'medium', side: 1, subject: 'victim',
    from: [9, 5, 15], to: [6.5, 3, 10], lead: 0, fov: [44, 38], lag: 3,
    reserved: true, tags: ['kill'],
  },
  {
    // And the other way of watching one fall: a slow arc round it.
    name: 'kill orbit', scale: 'medium', side: 1, subject: 'victim',
    from: [14, 6, 6], to: [11, 3, 4], orbit: Math.PI * 0.5, lead: 0,
    fov: [42, 38], lag: 3, reserved: true, tags: ['kill'],
  },
];

/** Needs an enemy to be fought: framed against it, or of it. */
function needsTarget(s: ShotSpec): boolean {
  return s.azimuth === 'target' || s.azimuth === 'player' || s.subject === 'target'
    || s.anchor === 'merge';
}

/** Needs somebody on the player's tail. */
function needsThreat(s: ShotSpec): boolean {
  return s.azimuth === 'threat';
}

/** Belongs in the combat pool. */
function isCombat(s: ShotSpec): boolean {
  return s.combat === true || needsTarget(s) || needsThreat(s);
}

/** Dealt in ordinary flight. */
function isScenic(s: ShotSpec): boolean {
  return s.subject !== 'victim' && (!isCombat(s) || (s.scenic === true
    && !needsTarget(s) && !needsThreat(s)));
}

/** Framed on the line between two aircraft. */
function combatAzimuth(s: ShotSpec): boolean {
  return s.azimuth === 'target' || s.azimuth === 'threat' || s.azimuth === 'player';
}

/**
 * Does this shot push in, pull out, or hold its distance?
 *
 * Derived rather than authored, so it cannot drift out of step with the
 * numbers. It is what fixes the complaint that going back *up* the ladder —
 * close, medium, wide — felt wrong: the medium shot was as likely as not to be
 * pushing in, so the sequence was moving closer and then cutting wider, which
 * reads as a jump rather than as a retreat.
 */
function moveOf(shot: ShotSpec, reversed = false): 'in' | 'out' | 'flat' {
  if (shot.locked) return 'flat';
  const a = reversed ? shot.to : shot.from;
  const b = reversed ? shot.from : shot.to;
  const from = Math.hypot(a[0], a[1], a[2]);
  const to = Math.hypot(b[0], b[1], b[2]);
  if (to < from * 0.82) return 'in';
  if (to > from * 1.22) return 'out';
  return 'flat';
}

/**
 * How far into a shot a beat may bring the cut forward.
 *
 * The last thirty per cent of it. Going wider starts cutting shots near half
 * their length, which reads as a jump rather than as an edit.
 */
const BEAT_WINDOW = 0.7;
/** Seconds a planted shot holds after its pass before a beat may cut it. */
const BEAT_AFTER_PASS = 0.35;
/**
 * Degrees of bank, m/s of climb, and g at which a manoeuvre counts as on.
 *
 * A scout spends half its life banked past thirty degrees and pulls three or
 * four g in a fight without thinking about it, so these sit far above where a
 * jet's would: at the jet's fourteen degrees nearly every frame of a dogfight
 * was a beat and the clock stopped setting the pace.
 */
const BEAT_ON = [38, 6, 2.3];
/** And where it counts as over again. */
const BEAT_OFF = [12, 2, 1.3];

/**
 * How far up the track a tripod may be planted, metres at the reference scale.
 *
 * The floor matters on the grass, where the aeroplane starts at a standstill
 * and a distance derived from its speed would otherwise put the camera on top
 * of it; the ceiling keeps a fast dive from planting the shot beyond the haze.
 */
const REACH_MIN = 28;
const REACH_MAX = 700;

const ORIENTATIONS: readonly boolean[] = [false, true];

/**
 * The run a landmark tripod is judged against, seconds — the length a wide
 * shot usually gets, since eligibility is decided before the duration is.
 */
const TRIPOD_RUN = 5;
/** How far off the track a landmark can be and still fill any of the frame. */
const TRIPOD_MISS = 350;
/**
 * How high the aeroplane can be for a tripod on the ground to be worth it.
 *
 * The camera is standing at the landmark, so the aircraft's height above the
 * ground is its distance at the closest point. A seven-metre scout at 400 m is
 * a speck over a church, and the shot is a picture of the church with a fly
 * on it.
 */
const TRIPOD_CEILING = 350;

/**
 * Cuts that must pass between one flourish and the next.
 *
 * They are punctuation. Two in quick succession is not emphasis, it is a tic.
 */
const FLOURISH_GAP = 5;

/**
 * How much a camera has to swing round the aircraft before the direction of it
 * is worth carrying across a cut, radians.
 */
const SWING_MATTERS = 0.52;

/** How many setups back the sequencer remembers, for the sake of variety. */
const RECENT_MEMORY = 9;

/** How many flourishes back to remember. */
const FLOURISH_MEMORY = 4;

/**
 * How close the enemy has to be for the sequence to be about the fight, m.
 *
 * Six hundred metres is about where a scout stops being a dot: beyond it the
 * combat framings show a player and a speck, which is a scenic shot with an
 * excuse.
 */
export const COMBAT_RANGE = 600;
/** Share of cuts that go to a combat setup while there is a fight on. */
const COMBAT_SHARE = 0.75;

/**
 * Nearest a carried camera may come to an aircraft's CG, metres at the
 * reference scale — half the span and a metre. The frames that swing with the
 * fight can put an authored offset anywhere relative to the wings, so this is
 * enforced rather than trusted.
 */
const GAP = 5.2;
/** Least height a director camera keeps above the ground, metres. */
const FLOOR = 3;
/** Pilot's eye, body frame, when the subject does not say. */
const DEFAULT_EYE = new THREE.Vector3(0, 1.0, 0.5);
/** How far off the nose the guns-eye will drift toward a target, radians. */
const GUN_CONE = 0.45;

/** Whether a shot goes anywhere at all — a still frame reads the same backwards. */
function movesAtAll(shot: ShotSpec): boolean {
  if (shot.orbit !== undefined && shot.orbit !== 0) return true;
  if (shot.anchorMove !== undefined) return true;
  return Math.hypot(shot.to[0] - shot.from[0], shot.to[1] - shot.from[1],
    shot.to[2] - shot.from[2]) > 0.2;
}

/**
 * Signed radians the camera swings around the aircraft over a shot.
 *
 * The continuity cue that survives a cut. Which way the camera is *travelling*
 * round the subject is read instantly and remembered; how far away it was is
 * not. Both halves count — the bearing changes because the setup moves, and
 * again because the shot orbits — and both flip when the shot is reversed.
 */
function swingOf(shot: ShotSpec, reversed: boolean, side: number): number {
  if (shot.locked) {
    // A planted camera has the strongest direction cue in the library: the
    // aeroplane flies past a fixed lens, so the bearing sweeps from nearly
    // astern round to nearly ahead, and which way round depends only on which
    // side it is planted.
    const fx = shot.from[0] * side;
    const fz = shot.from[2];
    if (fz >= 0) return 0; // planted behind: it only recedes
    return -Math.atan2(fx, fz);
  }
  const a = reversed ? shot.to : shot.from;
  const b = reversed ? shot.from : shot.to;
  let d = Math.atan2(b[0] * side, b[2]) - Math.atan2(a[0] * side, a[2]);
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  // Minus, and this is not a detail: the rotation applied per frame maps a
  // camera at (x, z) to (x cos - z sin, x sin + z cos), which *decreases* the
  // bearing atan2(x, z) as the angle grows.
  return d - (shot.orbit ?? 0) * (reversed ? -1 : 1) * side;
}

/** One shot, described well enough to list and choose from. */
export interface ShotInfo {
  name: string;
  scale: Scale;
  /** Whether the move pushes in, pulls out, or holds its distance. */
  move: 'in' | 'out' | 'flat';
  /** Planted in the world rather than carried with the aircraft. */
  locked: boolean;
  /** Framed against something in the world rather than against the aircraft. */
  framing: 'sun' | 'landmark' | 'target' | 'threat' | null;
  /** Written for a fast lens. */
  shallow: boolean;
  /** Punctuation: dealt between runs rather than stepped through. */
  flourish: boolean;
  /** Part of the combat pool. */
  combat: boolean;
  /** Needs an enemy in reach to mean anything. */
  needsTarget: boolean;
}

/**
 * The one name the picker offers for every landmark-anchored setup.
 *
 * They are genuinely different shots, but choosing between them means knowing
 * whether the thing off the nose is a church or a fort — which is the
 * director's job, not the operator's.
 */
export const LANDMARK_TRIPOD = 'landmark tripod';

/** The setups that entry stands for. */
const TRIPOD_SHOTS = SHOTS.filter((s) => s.anchor === 'landmark');

/**
 * The shot library, described for the picker.
 *
 * Derived from the specs rather than written out again, so a shot added above
 * appears in the UI without anyone having to remember a second list. The kill
 * cams are left out: they are only ever a shot *of* something that has just
 * been shot down, and from the picker there is nothing to point them at.
 */
export function shotCatalogue(): ShotInfo[] {
  const listed: ShotInfo[] = [];
  let collapsed = false;
  for (const s of SHOTS) {
    if (s.subject === 'victim') continue;
    if (s.anchor === 'landmark') {
      if (collapsed) continue;
      collapsed = true;
      listed.push({
        name: LANDMARK_TRIPOD,
        scale: 'wide',
        move: 'flat',
        locked: true,
        framing: 'landmark',
        shallow: true,
        flourish: false,
        combat: false,
        needsTarget: false,
      });
      continue;
    }
    listed.push(describe(s));
  }
  return listed;
}

function describe(s: ShotSpec): ShotInfo {
  let framing: ShotInfo['framing'] = null;
  if (s.azimuth === 'sun') framing = 'sun';
  else if (s.azimuth === 'landmark' || s.azimuth === 'structure') framing = 'landmark';
  else if (s.azimuth === 'threat') framing = 'threat';
  else if (needsTarget(s)) framing = 'target';
  return {
    name: s.name,
    scale: s.scale,
    move: moveOf(s),
    locked: s.locked === true,
    framing,
    shallow: (s.dof ?? 0) > 0,
    flourish: s.tags?.includes('flourish') === true,
    combat: isCombat(s),
    needsTarget: needsTarget(s) || needsThreat(s),
  };
}

/** Lead room by scale, metres ahead of the nose at the reference scale. */
const LEAD: Record<Scale, number> = { wide: 14, medium: 7, close: 2.2 };

/**
 * How long a shot of each scale is held.
 *
 * Wide shots need time to be read; close ones are one idea each and outstay
 * their welcome. Cutting everything on the same beat is what makes a sequence
 * feel mechanical.
 */
const HOLD: Record<Scale, [number, number]> = {
  wide: [4.8, 6.4],
  medium: [3.8, 5.0],
  close: [3.0, 4.2],
};

/** Who a shot ended up being of, this frame. */
export type ShotRole = 'player' | 'target' | 'victim';

export class CinematicDirector {
  private shot: ShotSpec = SHOTS[0];
  private elapsed = 0;
  private duration = 4;

  /** Where in the wide→close range the sequence is, and which way it is going. */
  private scaleIndex = 0;
  private direction: 1 | -1 = 1;
  /** Which side of the flight path the current phrase is shot from. */
  private side: 1 | -1 = 1;
  private lastName = '';
  private wasLocked = false;
  /** Cuts since the last on-axis shot — the only place the line may be crossed. */
  private sinceNeutral = 0;
  /**
   * Whether the shot on screen is being played back to front.
   *
   * A shot is a move from one setup to another, so every one of them is really
   * two: the push in and the pull out, the swing left and the swing right. This
   * doubles the library for nothing, and means the sequencer almost always has
   * a way to carry the camera on in the direction it was already going.
   */
  private reversed = false;
  /** The operator's switch: play everything backwards. */
  private reverseAll = false;
  /** Signed radians the camera swung round the aircraft on the last shot. */
  private lastSwing = 0;
  /** Cuts since the last flourish, so they stay occasional. */
  private sinceFlourish = 0;
  /** The last few setups used, most recent first. */
  private readonly recent: string[] = [];
  /**
   * Which cut each setup was last used on, and how many cuts there have been:
   * the longer a shot goes unused, the more it is worth.
   */
  private readonly lastUsedAt = new Map<string, number>();
  private cutIndex = 0;
  /** Airspeed at the last frame, m/s: a tripod's distance is derived from it. */
  private tas = 0;
  /**
   * Whether each manoeuvre is currently "on", for beat detection.
   *
   * Bank, vertical speed and g, in that order. Each is armed when it passes its
   * upper threshold and disarmed when it falls back through the lower one, and
   * *both* crossings are a beat.
   */
  private readonly beatArmed = [false, false, false];
  /** Set on any frame a manoeuvre began or ended. */
  private beat = false;
  private beatCutCount = 0;

  /** How many cuts a manoeuvre brought forward. Diagnostics only. */
  get beatCuts(): number {
    return this.beatCutCount;
  }
  /** And the same for the punctuation, which has far fewer setups to spend. */
  private readonly recentFlourishes: string[] = [];
  /** A shot an event has asked for, taken at the next cut. */
  private pending: ShotSpec | null = null;

  private readonly anchor = new THREE.Vector3();
  private readonly position = new THREE.Vector3();
  /** Eased camera offset in the subject's frame. */
  private readonly offset = new THREE.Vector3();
  private readonly _from = new THREE.Vector3();
  private readonly _to = new THREE.Vector3();
  private readonly _look = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _a = new THREE.Vector3();
  private readonly _b = new THREE.Vector3();
  private readonly _c = new THREE.Vector3();
  private readonly _r = new THREE.Vector3();
  private readonly _u = new THREE.Vector3();
  private started = false;

  /** Unit vector from the aircraft toward the sun, for backlit setups. */
  private readonly sun = new THREE.Vector3(0.4, 0.5, 0.3);
  /** Something worth putting behind the subject, or null. */
  private landmark: THREE.Vector3 | null = null;
  /** The nearest built landmark, for shots that stand on one. */
  private structure: LandmarkTarget | null = null;
  /**
   * The landmark the *current* shot was planted at, held for the length of
   * the shot: a tripod that re-sited itself halfway through would be a cut.
   */
  private tripod: LandmarkTarget | null = null;
  /** Aircraft heading on the ground, for judging whether a tripod is reachable. */
  private readonly _fwd = new THREE.Vector3();
  /** Set by `force`, so a hand-picked tripod takes the nearest landmark going. */
  private forced = false;
  /** Height above ground, so low shots are not chosen where they cannot work. */
  private agl = 1000;

  // ------------------------------------------------------------- the fight
  private target: CombatContext['target'] = null;
  private threat: CombatContext['threat'] = null;
  /** What the kill cam is following, while it runs. */
  private victim: CombatBody | null = null;
  private killSeconds = 3;
  /** A kill cam has been asked for and not yet cut to. */
  private killPending = false;
  /** The current shot was taken with the enemy it needs actually there. */
  private tookWithTarget = false;
  /** Player's scale, eye and velocity, from the rig. */
  private playerScale = 1;
  private readonly eye = new THREE.Vector3().copy(DEFAULT_EYE);
  private readonly playerVel = new THREE.Vector3();
  /** Who this frame's shot is of, and where they are. */
  private role: ShotRole = 'player';
  private readonly sPos = new THREE.Vector3();
  /** The subject's full attitude (the player's) or its track (anyone else's). */
  private readonly sAtt = new THREE.Quaternion();
  /** The subject's heading alone. */
  private readonly sYaw = new THREE.Quaternion();
  private sScale = 1;
  /** The other aircraft in a two-shot, if there is one. */
  private readonly oPos = new THREE.Vector3();
  private hasOther = false;
  private otherVirtual = false;
  private otherScale = 1;
  /** Damped direction from the other aircraft through the subject. */
  private readonly lineBack = new THREE.Vector3(0, 0, 1);
  private lineKnown = false;
  /** Damped heading of a target or victim, from its velocity. */
  private bodyYaw = 0;
  private bodyYawKnown = false;
  /** Field of view a two-shot needs, eased so the lens breathes rather than jumps. */
  private pairFov = 0;
  /** Where along a merge tripod's shot the two are expected to pass. */
  private mergePass = 0.5;

  get shotName(): string {
    return this.shot.name;
  }

  /** Aperture the current shot wants; 0 is a deep lens. */
  get aperture(): number {
    return this.shot.dof ?? 0;
  }

  /**
   * Where the lens is focused, as a multiple of the distance to the subject.
   */
  get focusScale(): number {
    const rack0 = this.shot.rack;
    const rack = rack0 === undefined ? undefined
      : (this.reversed ? [rack0[1], rack0[0]] as const : rack0);
    if (rack === undefined) return 1;
    return lerp(rack[0], rack[1], clamp(this.elapsed / this.duration, 0, 1));
  }

  /** The point the current shot is about — what the lens should focus on. */
  get focusPoint(): THREE.Vector3 {
    return this.sPos;
  }

  /** Whose shot this is: the player's, the enemy's, or a kill cam's. */
  get subjectRole(): ShotRole {
    return this.role;
  }

  /** Whether this shot is bolted to the player's airframe (so it shakes with it). */
  get mounted(): boolean {
    return this.shot.mount !== undefined && this.role === 'player';
  }

  /** Whether the player's cockpit interior should be drawn for this shot. */
  get wantsInterior(): boolean {
    return this.shot.interior === true && this.role === 'player';
  }

  /** Near clip plane the current shot needs, or null for the default. */
  get nearPlane(): number | null {
    return this.shot.near ?? null;
  }

  /** A kill cam is running, or about to be cut to. */
  get killActive(): boolean {
    return this.killPending
      || (this.shot.subject === 'victim' && this.victim !== null && this.elapsed < this.duration);
  }

  /**
   * Whether a tripod at the nearest landmark would see anything.
   *
   * These shots put the camera at the landmark and aim it at the aeroplane, so
   * they are only shots at all if the aeroplane comes past: far enough ahead
   * that there is an approach to watch, near enough that it arrives inside the
   * shot, and passing close enough that it is not a dot.
   */
  private tripodFor(pos: THREE.Vector3, quat: THREE.Quaternion): LandmarkTarget | null {
    const st = this.structure;
    if (st === null) return null;
    if (this.agl > TRIPOD_CEILING * this.playerScale) return null;
    this._fwd.set(0, 0, -1).applyQuaternion(yawOf(quat, this._q));
    const dx = st.x - pos.x;
    const dz = st.z - pos.z;
    const along = dx * this._fwd.x + dz * this._fwd.z;
    const across = Math.hypot(dx - this._fwd.x * along, dz - this._fwd.z * along);
    const run = Math.max(this.tas, 25) * TRIPOD_RUN;
    if (along < run * 0.12 || along > run * 0.95) return null;
    if (across > TRIPOD_MISS) return null;
    return st;
  }

  /** For the picker: is there anything within reach to stand a camera on? */
  tripodReady(): boolean {
    return this.structure !== null;
  }

  /** What the director frames against: the light, the landscape, the height. */
  setContext(
    sun: THREE.Vector3,
    landmark: THREE.Vector3 | null,
    structure: LandmarkTarget | null,
    agl: number,
  ): void {
    this.sun.copy(sun).normalize();
    this.landmark = landmark;
    this.structure = structure;
    this.agl = agl;
  }

  /**
   * The fight, as the player sees it: who is being fought and who is behind.
   * Held by reference — the vectors are read afresh every frame.
   */
  setCombat(ctx: CombatContext): void {
    this.target = ctx.target;
    this.threat = ctx.threat;
  }

  /** Whether there is an enemy close enough for the sequence to be about it. */
  inCombat(pos: THREE.Vector3): boolean {
    return this.target !== null && this.target.position.distanceTo(pos) < COMBAT_RANGE;
  }

  /**
   * Cut to the victim of a kill and follow it down for `seconds`.
   *
   * Taken at the very next update, ahead of anything else — the reel, a pin,
   * the ladder — because it is the one moment in a fight that everything else
   * can wait for. When it runs out the sequence carries on as if the kill cam
   * had been any other shot.
   */
  killCam(victim: CombatBody, seconds = 3): boolean {
    const pool = SHOTS.filter((s) => s.subject === 'victim');
    if (pool.length === 0) return false;
    this.victim = victim;
    this.killSeconds = clamp(Number.isFinite(seconds) ? seconds : 3, 1, 12);
    this.pending = pool[Math.floor(Math.random() * pool.length)];
    this.killPending = true;
    this.elapsed = this.duration;
    return true;
  }

  /** Drop a kill cam that is running or waiting. */
  cancelKill(): void {
    if (this.pending?.subject === 'victim') this.pending = null;
    this.killPending = false;
    if (this.shot.subject === 'victim') this.elapsed = this.duration;
    this.victim = null;
  }

  /**
   * Live adjustments to whatever shot is playing, kept per shot.
   *
   * The shots are already parameterised moves, so the two numbers a camera
   * operator would actually reach for — how far away, how high — can be handed
   * over without giving up the sequencing, the grammar or the cutting.
   */
  private readonly tweaks = new Map<string, ShotTweak>();
  /** True while the director is held on one setup instead of cutting away. */
  private pinned = false;
  /** The overall pace every shot is measured against. */
  private readonly style = { hold: 1, travel: 1 };
  /** Set by `replay`, honoured on the next update. */
  private replayRequested = false;
  /** The running order, when a reel is playing rather than the director. */
  private queue: ShotSlot[] | null = null;
  /** Index of the next entry to take. */
  private queueAt = 0;
  /** Index of the entry actually on screen, or -1 before the first cut. */
  private queueShown = -1;
  /** Whether a held shot repeats. */
  private looping = true;

  /** The adjustment for a shot, *without* creating one. */
  private tweakFor(name: string): ShotTweak {
    return this.tweaks.get(name) ?? UNTOUCHED;
  }

  /** The adjustment for a shot, creating one if this is the first change. */
  private editable(name: string): ShotTweak {
    let t = this.tweaks.get(name);
    if (t === undefined) {
      t = fresh();
      this.tweaks.set(name, t);
    }
    return t;
  }

  /** How long the shot that is playing will be held, seconds, as adjusted. */
  get shotSeconds(): number {
    return this.duration;
  }

  /** Which preset the pace currently matches, or -1 if it sits between them. */
  get styleIndex(): number {
    return DIRECTOR_STYLES.findIndex(
      (p) => Math.abs(p.hold - this.style.hold) < 0.02
        && Math.abs(p.travel - this.style.travel) < 0.02,
    );
  }

  /** The pace itself, for the sliders that set it directly. */
  get pace(): { hold: number; travel: number } {
    return { ...this.style };
  }

  setStyle(index: number): void {
    const next = DIRECTOR_STYLES[index];
    if (next === undefined) return;
    this.setPace(next.hold, next.travel);
  }

  setPace(hold: number, travel: number): void {
    const previous = this.style.hold;
    this.style.hold = clamp(hold, 0.4, 2.5);
    this.style.travel = clamp(travel, 0, MAX_TRAVEL);
    // Re-time whatever is playing, or the change waits for the next cut and
    // reads as if the control did nothing.
    if (previous > 0) this.retime(this.style.hold / previous);
  }

  /** Hold multiplier for the current shot, 0.4×–2.5× of what it was written as. */
  setHold(value: number): void {
    const t = this.editable(this.shot.name);
    const previous = t.hold;
    t.hold = clamp(value, 0.4, 2.5);
    if (previous > 0) this.retime(t.hold / previous);
  }

  /** Travel multiplier for the current shot: 0 is a locked-off frame. */
  setTravel(value: number): void {
    this.editable(this.shot.name).travel = clamp(value, 0, MAX_TRAVEL);
  }

  /**
   * Stretch or squeeze the shot in progress — never below the time already
   * elapsed plus a moment while there is shot left to protect, or dragging the
   * slider left would end the shot being watched.
   */
  private retime(factor: number): void {
    const running = this.elapsed < this.duration;
    this.duration = clamp(this.duration * factor, running ? this.elapsed + 0.4 : 1.2, 40);
  }

  /** Replace a shot's adjustment wholesale — recalling a saved setup. */
  setTweak(name: string, t: ShotTweak): void {
    if (!SHOTS.some((s) => s.name === name)) return;
    this.tweaks.set(name, { ...t });
  }

  /** Hold this setup, or let the sequence carry on. */
  setPinned(on: boolean): void {
    this.pinned = on;
  }

  // ------------------------------------------------------------------ reels
  //
  // A reel replaces the director's choice with a running order. Everything else
  // — the durations, the moves, the planting, the pace — is untouched: it is
  // only `cut` that stops choosing and starts reading off a list.

  /**
   * Play an ordered list of setups, or pass null to hand the sequence back to
   * the director.
   */
  setQueue(entries: ShotSlot[] | null): void {
    this.queue = entries !== null && entries.length > 0 ? entries : null;
    this.queueAt = 0;
    this.queueShown = -1;
    if (this.queue !== null) {
      // A held shot would never reach the end of its duration, and the reel
      // advances on exactly that.
      this.pinned = false;
      this.elapsed = this.duration;
    }
  }

  get queueLength(): number {
    return this.queue?.length ?? 0;
  }

  /** Which entry is on screen, 1-based, or 0 before the first one has been cut to. */
  get queuePosition(): number {
    if (this.queue === null || this.queueShown < 0) return 0;
    return this.queueShown + 1;
  }

  /** Cut to the next entry now rather than waiting out the current one. */
  advanceQueue(): void {
    if (this.queue === null) return;
    this.elapsed = this.duration;
  }

  /**
   * Run the move again from the top. Deferred to the next update, because
   * restarting a planted shot means re-anchoring it to where the aircraft is
   * *now* — and only `update` is told where that is.
   */
  replay(): void {
    this.replayRequested = true;
  }

  /** Whether a held shot repeats its move or freezes on its last frame. */
  get loops(): boolean {
    return this.looping;
  }

  setLooping(on: boolean): void {
    this.looping = on;
  }

  /** Play every shot back to front. */
  setReverseAll(on: boolean): void {
    this.reverseAll = on;
    this.reversed = on;
  }

  get reversingAll(): boolean {
    return this.reverseAll;
  }

  /** Reshape the current shot. Distances multiply; height and swing add. */
  adjust(dx: number, dy: number, wheel: number): void {
    const t = this.editable(this.shot.name);
    t.azimuth = clamp(t.azimuth + dx * 0.004, -Math.PI, Math.PI);
    t.height = clamp(t.height - dy * 0.1, -60, 120);
    if (wheel !== 0) t.scale = clamp(t.scale * Math.exp(wheel * 0.0011), 0.25, 6);
  }

  /** Put the current shot back the way it was written. */
  resetShot(): void {
    const t = this.tweaks.get(this.shot.name);
    if (t !== undefined && t.hold > 0) this.retime(1 / t.hold);
    this.tweaks.delete(this.shot.name);
  }

  /** Cut to the next or previous setup, ignoring the ladder. */
  step(direction: 1 | -1): void {
    let i = SHOTS.indexOf(this.shot);
    for (let n = 0; n < SHOTS.length; n++) {
      i = (i + direction + SHOTS.length) % SHOTS.length;
      // The kill cams are only a shot of something going down.
      if (SHOTS[i].subject !== 'victim' || this.victim !== null) break;
    }
    this.pending = SHOTS[i];
    this.elapsed = this.duration;
  }

  /** Hold this setup, or let the sequence carry on. */
  togglePin(): boolean {
    this.pinned = !this.pinned;
    return this.pinned;
  }

  get isPinned(): boolean {
    return this.pinned;
  }

  /** How the current shot has been reshaped, for the HUD. */
  get tweak(): ShotTweak {
    return this.tweakFor(this.shot.name);
  }

  /** Every adjustment made so far, for saving between sessions. */
  get allTweaks(): [string, ShotTweak][] {
    return [...this.tweaks.entries()];
  }

  /**
   * Restore saved adjustments. Every field is defaulted rather than trusted: a
   * missing multiplier read as `undefined` would put the camera at NaN — which
   * is a black screen, not a bad shot.
   */
  loadTweaks(saved: [string, Partial<ShotTweak>][]): void {
    const number = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    for (const [name, t] of saved) {
      if (!SHOTS.some((shot) => shot.name === name)) continue;
      this.tweaks.set(name, {
        azimuth: number(t.azimuth, 0),
        height: number(t.height, 0),
        scale: number(t.scale, 1),
        hold: clamp(number(t.hold, 1), 0.4, 2.5),
        travel: clamp(number(t.travel, 1), 0, MAX_TRAVEL),
      });
    }
  }

  /** Cut to a named setup: the shot picker, and the dev console. */
  force(name: string): boolean {
    if (name === LANDMARK_TRIPOD) return this.forceTripod();
    const found = SHOTS.find((s) => s.name === name);
    if (found === undefined) return false;
    this.pending = found;
    this.elapsed = this.duration;
    return true;
  }

  /**
   * Take whichever landmark setup suits what is out there — preferring the
   * one written for this kind of landmark, and falling back to the one that
   * works at anything.
   */
  private forceTripod(): boolean {
    const near = this.structure;
    if (near === null) return false;
    const fitted = TRIPOD_SHOTS.filter((s) => s.anchorKind?.includes(near.kind) === true);
    const general = TRIPOD_SHOTS.filter((s) => s.anchorKind === undefined);
    const pool = fitted.length > 0 && Math.random() < 0.72 ? fitted
      : (general.length > 0 ? general : fitted);
    if (pool.length === 0) return false;
    this.pending = pool[Math.floor(Math.random() * pool.length)];
    this.forced = true;
    this.elapsed = this.duration;
    return true;
  }

  /**
   * Cut now, to something suitable for what just happened: the take-off, the
   * touchdown, an engagement opening, a burst of hits taken.
   */
  request(event: string): void {
    const pool = SHOTS.filter((s) => s.tags?.includes(event) && s.subject !== 'victim'
      && !this.lacks(s));
    if (pool.length === 0) return;
    this.pending = pool[Math.floor(Math.random() * pool.length)];
    this.elapsed = this.duration; // take it on the next update
  }

  reset(): void {
    this.started = false;
    this.elapsed = this.duration; // force a fresh cut on the next update
    this.scaleIndex = 0;
    this.direction = 1;
    this.lineKnown = false;
    this.bodyYawKnown = false;
  }

  /** Whether a shot is missing what it needs to be a shot at all. */
  private lacks(s: ShotSpec): boolean {
    if (s.subject === 'victim') return this.victim === null;
    if (needsTarget(s) && this.target === null) return true;
    if (needsThreat(s) && this.threat === null) return true;
    return false;
  }

  /**
   * Advance the sequence and write the camera pose.
   *
   * `groundHeight` floors the camera: several setups deliberately drop below the
   * aircraft, and without it a low pass over a ridge puts the lens in the hill.
   */
  update(
    dt: number,
    pos: THREE.Vector3,
    quat: THREE.Quaternion,
    t: CameraTelemetry,
    camera: THREE.PerspectiveCamera,
    groundHeight: (x: number, z: number) => number,
    subject?: DirectorSubject,
  ): void {
    this.elapsed += dt;
    this.tas = t.tas;
    this.playerScale = scaleOf(subject?.scale);
    if (subject?.eye !== undefined) this.eye.copy(subject.eye);
    else this.eye.copy(DEFAULT_EYE).multiplyScalar(this.playerScale);
    if (subject?.velocity !== undefined && subject.velocity.lengthSq() > 1) {
      this.playerVel.copy(subject.velocity);
    } else {
      this.playerVel.set(0, 0, -1).applyQuaternion(quat).multiplyScalar(t.tas);
    }
    this.beat = this.manoeuvreBeat(t);
    // A pinned shot still *plays* — its move runs to the end — it simply never
    // hands over to the next one. The clock is the cap, and a beat can bring
    // the cut forward inside the last stretch of it.
    const early = this.elapsed < this.duration && this.beat
      && this.elapsed >= this.duration * BEAT_WINDOW && this.passIsDone();
    if (early) this.beatCutCount++;
    // A combat shot whose enemy has gone — shot down, out of reach, switched —
    // has nothing left to frame. In the hands-off sequence that is a cut; a
    // pin or a reel holds it, on a stand-in ahead of the nose.
    const stranded = this.started && this.tookWithTarget && this.lacks(this.shot)
      && !this.pinned && this.queue === null;
    // And a kill cam ends when it ends, pin or no pin: looping one would be
    // watching the same aeroplane die over and over.
    const killOver = this.started && this.shot.subject === 'victim'
      && this.elapsed >= this.duration;
    const due = this.elapsed >= this.duration || early || stranded;
    if (!this.started || killOver || (due && (!this.pinned || this.pending !== null))) {
      this.cut(pos, quat);
    } else if (this.replayRequested
      || (due && this.pinned && this.looping && this.queue === null)) {
      this.replayRequested = false;
      this.elapsed = 0;
      // The eased offset is left where it is on purpose: it glides back to the
      // start of the move rather than jumping there.
      if (this.shot.locked) this.plant(this.shot, pos, quat);
    }

    const shot = this.shot;
    this.resolve(shot, pos, quat, dt);
    const s = this.sScale;
    const u = clamp(this.elapsed / this.duration, 0, 1);
    // Dollies ease in and out; tracking moves run at constant speed, because a
    // lateral pass that slows to a stop in the middle looks like a mistake.
    const e = shot.linear ? u : smoothstep(0, 1, u);
    const mirror = this.side;

    const tweak = this.tweakFor(shot.name);
    // How much of the written move actually gets made. Everything that travels
    // reads this one number — the dolly, the orbit, the crane's boom and the
    // focal ramp.
    const move = e * tweak.travel * this.style.travel;
    const lag = shot.lag ?? 0;

    if (shot.locked) {
      this.position.copy(this.anchor);
      // A crane: planted in the world, but not dead.
      const boom = shot.anchorMove;
      if (boom !== undefined) {
        // Anchored shots measure everything in landmark sizes, the jib too.
        const unit = shot.anchor === 'landmark' && this.tripod !== null
          ? tripodBulk(this.tripod) : this.playerScale;
        const way = this.reversed ? -1 : 1;
        this.position.x += boom[0] * unit * mirror * move * way;
        this.position.y += boom[1] * unit * move * way;
        this.position.z += boom[2] * unit * move * way;
      }
    } else if (shot.mount !== undefined) {
      // Bolted on: the offset lives in the body frame, measured from the eye or
      // the CG, and the whole thing pitches and rolls with the aeroplane.
      this.legs(shot, move, mirror, 1);
      this.applyTweak(tweak, mirror);
      if (lag > 0 && this.started) this.offset.lerp(this._from, 1 - Math.exp(-lag * dt));
      else this.offset.copy(this._from);
      this.mountPoint(shot, this._a).add(this._b.copy(this.offset).multiplyScalar(s));
      this.position.copy(this._a).applyQuaternion(this.sAtt).add(this.sPos);
    } else if (combatAzimuth(shot)) {
      // On the line between two aircraft: −Z points from the subject at the
      // other one, so aft of the subject is over its shoulder at the other.
      this.legs(shot, move, mirror, s);
      this.applyTweak(tweak, mirror);
      this.lineFrame(dt);
      // Into world terms through the line's own frame.
      this._a.copy(this._r).multiplyScalar(this._from.x)
        .addScaledVector(this._u, this._from.y)
        .addScaledVector(this.lineBack, this._from.z);
      if (lag > 0 && this.started) this.offset.lerp(this._a, 1 - Math.exp(-lag * dt));
      else this.offset.copy(this._a);
      this.position.copy(this.offset).add(this.sPos);
    } else if (shot.azimuth !== undefined) {
      // Framed against the world rather than against the aircraft: the camera
      // goes on the far side of the subject from the sun (or the landmark), so
      // that thing ends up behind it.
      const af = this.legFrom(shot);
      const at = this.legTo(shot);
      this._from.set(af[0], af[1], af[2]);
      this._to.set(at[0], at[1], at[2]);
      this._from.lerp(this._to, move);

      let dirX = -this.sun.x;
      let dirZ = -this.sun.z;
      if (shot.azimuth === 'landmark' && this.landmark !== null) {
        dirX = this.sPos.x - this.landmark.x;
        dirZ = this.sPos.z - this.landmark.z;
      } else if (shot.azimuth === 'structure' && this.structure !== null) {
        dirX = this.sPos.x - this.structure.x;
        dirZ = this.sPos.z - this.structure.z;
      }
      const len = Math.hypot(dirX, dirZ) || 1;
      // Distance and height are the operator's here as well. The swing is not:
      // where these shots sit is the whole point of them.
      const reach = Math.hypot(this._from.x, this._from.z) * tweak.scale * s;
      this._from.set((dirX / len) * reach, this._from.y * tweak.scale * s + tweak.height,
        (dirZ / len) * reach);

      if (lag > 0 && this.started) {
        this.offset.lerp(this._from, 1 - Math.exp(-lag * dt));
      } else {
        this.offset.copy(this._from);
      }
      this.position.copy(this.offset).add(this.sPos);
    } else {
      this.legs(shot, move, mirror, s);

      // Reversing a sweep is not the same as negating it: backwards the shot
      // *starts* a whole sweep round and unwinds.
      const sweep = shot.orbit ?? 0;
      if (sweep) {
        const a = sweep * mirror * (this.reversed ? 1 - move : move);
        const sin = Math.sin(a);
        const cos = Math.cos(a);
        const x = this._from.x * cos - this._from.z * sin;
        const z = this._from.x * sin + this._from.z * cos;
        this._from.set(x, this._from.y, z);
      }
      this.applyTweak(tweak, mirror);

      // Ease the *offset*, not the world position: a follow chasing a moving
      // target settles a constant v/k behind it, which turned close-ups into
      // distant specks. Easing the offset keeps the camera rigid to the
      // aircraft and smooths only the move.
      if (lag > 0 && this.started) {
        this.offset.lerp(this._from, 1 - Math.exp(-lag * dt));
      } else {
        this.offset.copy(this._from);
      }

      // Yaw only. Rolling the whole rig with the aircraft makes every shot
      // tumble with it, which reads as a mistake rather than as style.
      this.position.copy(this.offset).applyQuaternion(this.sYaw).add(this.sPos);
    }

    // Nothing carried with an aeroplane may end up inside one. The authored
    // offsets keep clear on their own; the frames that swing with the fight can
    // put them anywhere relative to the wings, so this is enforced.
    if (!shot.locked && shot.mount === undefined) {
      keepClear(this.position, this.sPos, GAP * s);
      if (this.hasOther && !this.otherVirtual) {
        keepClear(this.position, this.oPos, GAP * this.otherScale);
      }
    }

    const floor = groundHeight(this.position.x, this.position.z) + FLOOR;
    if (this.position.y < floor) this.position.y = floor;

    // Where to look.
    const look = shot.look;
    if (shot.mount !== undefined) {
      this.mountPoint(shot, this._look);
      this._look.x += (look ? look[0] * mirror : 0) * s;
      this._look.y += (look ? look[1] : 0) * s;
      this._look.z += (look ? look[2] : -60) * s;
      this._look.applyQuaternion(this.sAtt).add(this.sPos);
      if (shot.guns === true) this.gunsAim();
    } else {
      // Lead room. Aiming at the aircraft puts it dead centre, which is the one
      // framing a camera operator never chooses: the subject wants space ahead
      // of it to move into.
      const lead = (shot.lead ?? LEAD[shot.scale]) * s;
      this._look
        .set(look ? look[0] * mirror * s : 0, look ? look[1] * s : 0,
          (look ? look[2] * s : 0) - lead)
        .applyQuaternion(this.sAtt)
        .add(this.sPos);
    }

    // A two-shot: aim part of the way from the subject toward the other one,
    // and work out how wide the lens has to be to hold both.
    let fit = 0;
    const pair = shot.pair;
    if (pair !== undefined && this.hasOther) {
      fit = this.pairAim(pair);
    }

    camera.position.copy(this.position);
    if (shot.mount !== undefined) camera.up.set(0, 1, 0).applyQuaternion(this.sAtt);
    else camera.up.set(0, 1, 0);
    camera.lookAt(this._look);
    if (shot.roll) camera.rotateZ(shot.roll * mirror);

    // Handheld. Two slow sines an irrational ratio apart never repeat, which is
    // what stops it reading as a mechanical wobble.
    const float = shot.float ?? 0;
    if (float > 0) {
      const t1 = this.elapsed;
      camera.rotateX(Math.sin(t1 * 0.73) * float + Math.sin(t1 * 1.91) * float * 0.4);
      camera.rotateY(Math.sin(t1 * 0.57 + 1.3) * float + Math.sin(t1 * 1.37) * float * 0.35);
    }

    // The focal ramp is part of the move, so it travels with it: a shot held
    // still keeps its opening lens, and a doubled dolly zoom doubles.
    let fov = lerp(this.legFov(shot, 0), this.legFov(shot, 1), clamp(move, 0, 1.6));
    if (this.role === 'player') fov += clamp(t.tas / 70, 0, 1.1) * 3;
    if (fit > 0) {
      // Opens quickly and closes slowly: late to widen is an aircraft out of
      // frame, late to narrow is only a lens that breathes.
      if (!this.started || this.pairFov <= 0) this.pairFov = fit;
      else this.pairFov += (fit - this.pairFov) * (1 - Math.exp(-(fit > this.pairFov ? 14 : 2) * dt));
      this.pairFov = Math.max(this.pairFov, fit * 0.97);
      fov = Math.max(fov, Math.min(this.pairFov, 100));
    } else {
      this.pairFov = 0;
    }
    camera.fov = fov;
    camera.updateProjectionMatrix();

    this.started = true;
  }

  /** The written move at `move` of the way through, into `_from`, scaled. */
  private legs(shot: ShotSpec, move: number, mirror: number, s: number): void {
    const lf = this.legFrom(shot);
    const lt = this.legTo(shot);
    this._from.set(lf[0] * mirror * s, lf[1] * s, lf[2] * s);
    this._to.set(lt[0] * mirror * s, lt[1] * s, lt[2] * s);
    this._from.lerp(this._to, move);
  }

  /** The operator's own adjustment on `_from`: swing round, in or out, up or down. */
  private applyTweak(tweak: ShotTweak, mirror: number): void {
    if (tweak.azimuth === 0 && tweak.scale === 1 && tweak.height === 0) return;
    const c = Math.cos(tweak.azimuth * mirror);
    const sn = Math.sin(tweak.azimuth * mirror);
    const x = this._from.x * c - this._from.z * sn;
    const z = this._from.x * sn + this._from.z * c;
    this._from.set(x * tweak.scale, this._from.y * tweak.scale + tweak.height, z * tweak.scale);
  }

  /** Where a mounted shot is measured from, in the body frame, into `out`. */
  private mountPoint(shot: ShotSpec, out: THREE.Vector3): THREE.Vector3 {
    return shot.mount === 'eye' ? out.copy(this.eye) : out.set(0, 0, 0);
  }

  /**
   * Work out who this frame's shot is of and who else is in it.
   *
   * The player unless the shot says otherwise and the enemy it names is
   * actually there; a shot asked for by hand without one falls back to the
   * player and a stand-in target ahead of the nose, so the picker never shows
   * a camera pointed at nothing.
   */
  private resolve(shot: ShotSpec, pos: THREE.Vector3, quat: THREE.Quaternion, dt: number): void {
    const who = shot.subject ?? 'player';
    this.otherVirtual = false;
    if (who === 'victim' && this.victim !== null) {
      const v = this.victim;
      this.role = 'victim';
      this.sPos.copy(v.position);
      this.sScale = scaleOf(v.cameraScale);
      this.trackFrame(v.velocity, v.quaternion, dt);
      this.hasOther = false;
      return;
    }
    if (who === 'target' && this.target !== null) {
      const tg = this.target;
      this.role = 'target';
      this.sPos.copy(tg.position);
      this.sScale = scaleOf(tg.cameraScale);
      this.trackFrame(tg.velocity, undefined, dt);
      this.oPos.copy(pos);
      this.otherScale = this.playerScale;
      this.hasOther = true;
      return;
    }
    this.role = 'player';
    this.sPos.copy(pos);
    this.sAtt.copy(quat);
    yawOf(quat, this.sYaw);
    this.sScale = this.playerScale;
    const other = shot.azimuth === 'threat' ? this.threat : this.target;
    const wants = shot.pair !== undefined || combatAzimuth(shot) || shot.guns === true;
    if (other !== null && wants) {
      this.oPos.copy(other.position);
      this.otherScale = scaleOf((other as { cameraScale?: number }).cameraScale);
      this.hasOther = true;
    } else if (wants && (needsTarget(shot) || needsThreat(shot))) {
      // A stand-in, a hundred and fifty metres up the track (or astern, for a
      // threat), so a combat shot picked by hand still frames something.
      const along = needsThreat(shot) ? 150 : -150;
      this.oPos.set(0, 0, along * this.playerScale).applyQuaternion(this.sYaw).add(pos);
      this.otherScale = this.playerScale;
      this.hasOther = true;
      this.otherVirtual = true;
    } else {
      this.hasOther = false;
    }
  }

  /**
   * A yaw frame for an aircraft that is not the player, from where it is going.
   *
   * The velocity rather than the attitude, and on purpose: the subject of a
   * kill cam is spinning, and a camera that took its heading from the nose
   * would spin with it. Where it is *going* changes smoothly even then.
   */
  private trackFrame(vel: THREE.Vector3 | undefined, att: THREE.Quaternion | undefined,
    dt: number): void {
    let raw: number | null = null;
    if (vel !== undefined && vel.x * vel.x + vel.z * vel.z > 4) {
      raw = Math.atan2(-vel.x, -vel.z);
    } else if (att !== undefined) {
      yawOf(att, this._q);
      raw = 2 * Math.atan2(this._q.y, this._q.w);
    }
    if (raw !== null) {
      if (!this.bodyYawKnown || !this.started) {
        this.bodyYaw = raw;
        this.bodyYawKnown = true;
      } else {
        let d = raw - this.bodyYaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this.bodyYaw += d * (1 - Math.exp(-4 * dt));
      }
    }
    this.sYaw.setFromAxisAngle(UP, this.bodyYaw);
    this.sAtt.copy(this.sYaw);
  }

  /**
   * The frame of the line between the two aircraft, damped: `lineBack` points
   * from the other one through the subject, `_r` to its right and `_u` up.
   *
   * Its elevation is held inside ±40°, so a bandit directly overhead swings
   * the camera round over the top rather than standing it on its head, and
   * the swing itself is rate-limited — a target that flashes past at ten
   * metres turns the frame, it does not whip it.
   */
  private lineFrame(dt: number): void {
    this._c.copy(this.sPos).sub(this.oPos);
    if (this._c.lengthSq() < 1e-4) this._c.set(0, 0, 1).applyQuaternion(this.sYaw);
    this._c.normalize();
    clampElevation(this._c, 0.7);
    if (!this.lineKnown || !this.started) {
      this.lineBack.copy(this._c);
      this.lineKnown = true;
    } else {
      dampDirection(this.lineBack, this._c, 5, 2.2, dt);
    }
    // Right = forward × up, with forward = −back.
    this._r.set(-this.lineBack.z, 0, this.lineBack.x);
    if (this._r.lengthSq() < 1e-6) this._r.set(1, 0, 0);
    this._r.normalize().negate();
    // Up = right × forward.
    this._u.copy(this._r).cross(this._b.copy(this.lineBack).negate()).normalize();
  }

  /**
   * Swing the aim a fraction of the way from the subject to the other
   * aircraft, and return the field of view (degrees) that holds both.
   */
  private pairAim(weight: number): number {
    const toLook = this._a.copy(this._look).sub(this.position);
    const dist = Math.max(toLook.length(), 1);
    toLook.divideScalar(dist);
    const toOther = this._b.copy(this.oPos).sub(this.position);
    const dO = Math.max(toOther.length(), 1);
    toOther.divideScalar(dO);
    const aim = slerpDirection(toLook, toOther, weight, this._c);
    this._look.copy(this.position).addScaledVector(aim, dist);
    const toSubject = this._r.copy(this.sPos).sub(this.position);
    const dS = Math.max(toSubject.length(), 1);
    toSubject.divideScalar(dS);
    // Half-angles from the aim to each aircraft, plus the aircraft itself.
    const hs = aim.angleTo(toSubject) + Math.atan((3.2 * this.sScale) / dS);
    const ho = aim.angleTo(toOther) + Math.atan((3.2 * this.otherScale) / dO);
    return 2 * Math.max(hs, ho) * (180 / Math.PI) * 1.08;
  }

  /**
   * The gun camera looks down the barrels — which is the nose — and drifts
   * toward the target when the target is near the sight, so a bandit being
   * lined up sits in the middle of the picture rather than wherever the lead
   * happens to leave him.
   */
  private gunsAim(): void {
    const tg = this.target;
    if (tg === null) return;
    const nose = this._a.copy(this._look).sub(this.position);
    const dist = nose.length();
    if (dist < 1e-3) return;
    nose.divideScalar(dist);
    const to = this._b.copy(tg.position).sub(this.position);
    const d = to.length();
    if (d < 1e-3) return;
    to.divideScalar(d);
    const off = nose.angleTo(to);
    if (off >= GUN_CONE) return;
    const w = 0.55 * (1 - off / GUN_CONE);
    const aim = slerpDirection(nose, to, w, this._c);
    this._look.copy(this.position).addScaledVector(aim, dist);
  }

  /**
   * Choose the next setup.
   *
   * The rules, in the order they matter:
   *
   *  1. Work the scale in one direction — wide, medium, close — so a run either
   *     leads the audience in or leads them out, then turn round at the end.
   *  2. Hold the line. Every off-axis shot is mirrored onto the side the phrase
   *     is being worked from. The side may only change *after* a neutral shot.
   *  3. Never the same setup twice running, and never two locked shots in a row.
   *  4. While there is a fight within reach, most of the cuts go to it.
   */
  private cut(pos: THREE.Vector3, quat: THREE.Quaternion): void {
    // A kill outranks everything, the reel included.
    if (this.pending !== null && this.pending.subject === 'victim') {
      const kill = this.pending;
      this.pending = null;
      if (this.victim !== null) {
        this.take(kill, pos, quat);
        return;
      }
    }
    this.killPending = false;

    // A reel is running: the order is already decided, so none of the grammar
    // below applies. Take the next entry, in its own saved shape.
    if (this.queue !== null && this.queue.length > 0) {
      const entry = this.queue[this.queueAt % this.queue.length];
      this.queueShown = this.queueAt % this.queue.length;
      this.queueAt = (this.queueAt + 1) % this.queue.length;
      const spec = SHOTS.find((s) => s.name === entry.shot);
      if (spec !== undefined) {
        this.setTweak(entry.shot, entry.tweak);
        this.take(spec, pos, quat);
        return;
      }
    }

    // The previous shot decides whether the line may be crossed now.
    const previousWasNeutral = this.started && this.shot.side === 0;
    if (previousWasNeutral && Math.random() < 0.7) this.side = this.side === 1 ? -1 : 1;

    // Step along the scale, turning round at either end of the run.
    let turned = false;
    if (this.started) {
      let next = this.scaleIndex + this.direction;
      if (next < 0 || next >= SCALES.length) {
        this.direction = this.direction === 1 ? -1 : 1;
        next = this.scaleIndex + this.direction;
        turned = true;
      }
      this.scaleIndex = next;
    }
    const want = SCALES[this.scaleIndex];
    const fighting = this.inCombat(pos);

    // A flourish, at the turn of a run — the one place a sharp shot does not
    // interrupt anything. Rarer in a fight, where the fight is the show.
    this.sinceFlourish++;
    if (turned && this.pending === null && this.sinceFlourish >= FLOURISH_GAP
      && Math.random() < (fighting ? 0.2 : 0.55)) {
      const options = SHOTS.filter((sh) => sh.tags?.includes('flourish') === true
        && sh.name !== this.lastName
        && !(sh.locked === true && this.wasLocked)
        && !this.lacks(sh)
        // The low pass looks up from under the aircraft; down on the deck that
        // is a shot of the inside of a hill.
        && !(sh.name === 'fly-by low' && this.agl < 60)
        // Framed against something in the world, so it needs the world to be
        // offering something. Without a landmark it is just an odd angle.
        && !(sh.azimuth === 'landmark' && this.landmark === null)
        && !(sh.azimuth === 'structure' && this.structure === null));
      if (options.length > 0) {
        this.sinceFlourish = 0;
        const unused = options.filter((sh) => !this.recentFlourishes.includes(sh.name));
        const from = unused.length > 0 ? unused : options;
        const flourish = from[Math.floor(Math.random() * from.length)];
        this.recentFlourishes.unshift(flourish.name);
        if (this.recentFlourishes.length > FLOURISH_MEMORY) {
          this.recentFlourishes.length = FLOURISH_MEMORY;
        }
        // Punctuation, but not an interruption: it still hands its direction on
        // to whatever follows.
        this.remember(flourish.name);
        const flourishSwing = swingOf(flourish, false, this.side);
        if (Math.abs(flourishSwing) > SWING_MATTERS) this.lastSwing = flourishSwing;
        this.take(flourish, pos, quat);
        return;
      }
    }

    // An event has asked for something specific — that outranks the ladder, as
    // long as what it needs is still there.
    if (this.pending !== null) {
      const asked = this.pending;
      this.pending = null;
      if (asked.subject !== 'victim' || !this.lacks(asked)) {
        this.take(asked, pos, quat);
        return;
      }
    }

    // Whether a landmark tripod has anything to stand on right now, and
    // whether it is the right sort of landmark for a given shot. A hard
    // exclusion rather than a preference: an anchored shot that falls through
    // to the ordinary planting reads its offsets in the wrong frame and merely
    // looks dull, which is the kind of failure nobody reports.
    const tripod = this.tripodFor(pos, quat);
    const standable = (s: ShotSpec): boolean => {
      if (s.anchor !== 'landmark') return true;
      if (tripod === null) return false;
      return s.anchorKind === undefined || s.anchorKind.includes(tripod.kind);
    };
    const usable = (s: ShotSpec): boolean => s.name !== this.lastName
      && s.reserved !== true && standable(s) && !this.lacks(s);

    // The fight or the flight. Mostly the fight while there is one within
    // reach — but not only, or a long dogfight becomes eight setups on a loop.
    const combatCut = fighting && Math.random() < COMBAT_SHARE;
    const kind = (s: ShotSpec): boolean => (combatCut ? isCombat(s) : isScenic(s));

    let pool = SHOTS.filter(
      (s) => s.scale === want && usable(s) && kind(s) && !(s.locked && this.wasLocked),
    );
    if (pool.length === 0 && combatCut) {
      // Nothing of this scale for the fight as it stands (no threat, say): any
      // combat setup beats dropping out of the fight for a scenic one.
      pool = SHOTS.filter((s) => usable(s) && isCombat(s) && !(s.locked && this.wasLocked));
    }

    // Down low, a shot that hangs under the aircraft is a shot of the inside of
    // a hill — the ground clamp saves it and the framing is lost.
    if (this.agl < 90 * this.playerScale) {
      const safe = pool.filter((s) => Math.min(s.from[1], s.to[1]) > -5);
      if (safe.length > 0) pool = safe;
    }

    // A landmark shot with no landmark to frame against is just an odd angle.
    if (this.landmark === null) {
      const framed = pool.filter((s) => s.azimuth !== 'landmark');
      if (framed.length > 0) pool = framed;
    }
    if (this.structure === null) {
      const built = pool.filter((s) => s.azimuth !== 'structure');
      if (built.length > 0) pool = built;
    }

    if (pool.length === 0) {
      pool = SHOTS.filter((s) => usable(s) && isScenic(s));
    }

    // Steer toward an on-axis shot if the sequence has been working one side for
    // a while. Left to chance the line is never crossed at all.
    if (this.sinceNeutral >= 5) {
      const neutral = pool.filter((s) => s.side === 0);
      if (neutral.length > 0) pool = neutral;
    }

    // Choose the shot *and* which way round to play it, together: scored both
    // ways the library almost always has a version of some shot that carries
    // on the move already in progress.
    const wanted = this.direction === 1 ? 'in' : 'out';
    let best: { shot: ShotSpec; reversed: boolean; score: number } | null = null;
    for (const candidate of pool) {
      for (const reversed of ORIENTATIONS) {
        // Reversing a shot that does not move is the same shot again.
        if (reversed && !movesAtAll(candidate)) continue;
        const move = moveOf(candidate, reversed);
        const swing = swingOf(candidate, reversed, this.side);

        let score = Math.random() * 0.9;
        // Freshness. Strong enough to break a tie between two shots that both
        // carry the move, not strong enough to override the move itself.
        const ago = this.recent.indexOf(candidate.name);
        if (ago >= 0) score -= (RECENT_MEMORY - ago) * (1.9 / RECENT_MEMORY);
        // Starvation: the longer a shot goes unused, the more it is worth, up
        // to a ceiling that clears the deficit a shot that neither dollies nor
        // sweeps gives up below.
        const since = this.cutIndex - (this.lastUsedAt.get(candidate.name) ?? -80);
        score += clamp((since - RECENT_MEMORY) * 0.05, 0, 3.4);
        // Move with the ladder, not against it — a strong preference inside
        // the random spread rather than a rule.
        if (move === wanted) score += 1.4;
        else if (move === 'flat') score += 0.7;
        // Carry the swing on — but only between shots that actually have one,
        // and as a penalty for the wrong way rather than a prize for the right.
        if (Math.abs(this.lastSwing) > SWING_MATTERS && Math.abs(swing) > SWING_MATTERS) {
          score += Math.sign(swing) === Math.sign(this.lastSwing) ? 0.8 : -2.4;
        }
        if (best === null || score > best.score) best = { shot: candidate, reversed, score };
      }
    }

    const pick = best ?? { shot: pool[0] ?? SHOTS[0], reversed: false };
    const swung = swingOf(pick.shot, pick.reversed, this.side);
    if (Math.abs(swung) > SWING_MATTERS) this.lastSwing = swung;
    this.remember(pick.shot.name);
    this.take(pick.shot, pos, quat, pick.reversed);
  }

  /**
   * Did a manoeuvre just start or stop?
   *
   * Both edges of the bank, the climb and the g count, with thresholds set for
   * an aeroplane that turns hard as a matter of course: together they land a
   * beat every few shots in a fight and rather less in a cruise.
   */
  private manoeuvreBeat(t: CameraTelemetry): boolean {
    // Defensive against a partial telemetry: the camera must never be the
    // reason a frame throws.
    const now = [
      Math.abs(t.bank ?? 0) * (180 / Math.PI),
      Math.abs(t.verticalSpeed ?? 0),
      t.loadFactor ?? 1,
    ];
    let fired = false;
    for (let i = 0; i < 3; i++) {
      if (!this.beatArmed[i] && now[i] > BEAT_ON[i]) {
        this.beatArmed[i] = true;
        fired = true;
      } else if (this.beatArmed[i] && now[i] < BEAT_OFF[i]) {
        this.beatArmed[i] = false;
        fired = true;
      }
    }
    return fired;
  }

  /**
   * Whether a planted shot has had its pass yet: a beat landing before that
   * would cut away from the one thing it was set up for.
   */
  private passIsDone(): boolean {
    if (this.shot.locked !== true) return true;
    const p = this.shot.anchor === 'merge' ? this.mergePass : this.shot.pass;
    if (p === undefined) return true;
    return this.elapsed >= this.duration * p + BEAT_AFTER_PASS;
  }

  /** Note a setup as used, and forget the oldest. */
  private remember(name: string): void {
    this.recent.unshift(name);
    if (this.recent.length > RECENT_MEMORY) this.recent.length = RECENT_MEMORY;
    this.lastUsedAt.set(name, this.cutIndex);
    this.cutIndex++;
  }

  /** The setup this shot starts from, given which way round it is playing. */
  private legFrom(shot: ShotSpec): readonly [number, number, number] {
    return this.reversed ? shot.to : shot.from;
  }

  /** And the one it ends at. */
  private legTo(shot: ShotSpec): readonly [number, number, number] {
    return this.reversed ? shot.from : shot.to;
  }

  /** Focal length at either end of the move, in play order. */
  private legFov(shot: ShotSpec, end: 0 | 1): number {
    return shot.fov[this.reversed ? (1 - end) as 0 | 1 : end];
  }

  /** Commit to a shot: duration, side bookkeeping, and planting if it is locked. */
  private take(shot: ShotSpec, pos: THREE.Vector3, quat: THREE.Quaternion,
    reversed = false): void {
    // A kill cam is never played backwards: it has one direction, down.
    this.reversed = shot.subject === 'victim' ? false : (reversed || this.reverseAll);
    this.shot = shot;
    this.lastName = shot.name;
    this.wasLocked = shot.locked === true;
    this.sinceNeutral = shot.side === 0 ? 0 : this.sinceNeutral + 1;
    this.tookWithTarget = (needsTarget(shot) || needsThreat(shot)) && !this.lacks(shot);
    if (shot.subject !== 'victim') this.victim = null;
    this.killPending = false;

    const t = this.tweakFor(shot.name);
    const hold = shot.seconds ?? HOLD[shot.scale];
    this.duration = shot.subject === 'victim'
      ? this.killSeconds
      : clamp(lerp(hold[0], hold[1], Math.random()) * this.style.hold * t.hold, 1.2, 40);
    this.elapsed = 0;
    this.lineKnown = false;
    this.bodyYawKnown = false;
    this.pairFov = 0;

    // Chosen once, at the cut, and held. Relaxed when the operator asked for
    // this shot by hand.
    this.tripod = shot.anchor === 'landmark'
      ? (this.tripodFor(pos, quat) ?? (this.forced ? this.structure : null))
      : null;
    this.forced = false;

    if (shot.locked) this.plant(shot, pos, quat);
    // A cut is a cut: no interpolation across it.
    this.started = false;
  }

  /**
   * Put a locked shot's camera in the world, relative to the aircraft as it is
   * right now — with the operator's adjustment baked in, since there is no
   * per-frame offset to apply it to afterwards.
   */
  private plant(shot: ShotSpec, pos: THREE.Vector3, quat: THREE.Quaternion): void {
    const t = this.tweakFor(shot.name);
    const s = this.playerScale;

    if (shot.anchor === 'merge') {
      this.plantMerge(shot, pos, quat, t);
      return;
    }

    if (shot.anchor === 'landmark' && this.tripod !== null) {
      const st = this.tripod;
      // The landmark's own frame: −Z toward the aeroplane.
      let tx = pos.x - st.x;
      let tz = pos.z - st.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      const put = (x: number, y: number, z: number): void => {
        this._from.set(
          st.x + x * tz - z * tx,
          st.y + y,
          st.z - x * tx - z * tz,
        );
      };
      const lf = this.legFrom(shot);
      // The unit is the landmark's *bulk* — the larger of how tall it stands
      // and how wide it spreads.
      const bulk = tripodBulk(st);
      // The climb is up the *thing*, so it goes on the height even when the
      // bulk is coming from the footprint.
      const climb = (shot.anchorHeight ?? 0) * st.height;
      put(lf[0] * bulk * this.side * t.scale,
        lf[1] * bulk * t.scale + climb + t.height,
        lf[2] * bulk * t.scale);
      const jib = shot.anchorMove;
      if (this.reversed && jib !== undefined) {
        this._from.x += (jib[0] * bulk * this.side) * tz - (jib[2] * bulk) * tx;
        this._from.y += jib[1] * bulk;
        this._from.z += -(jib[0] * bulk * this.side) * tx - (jib[2] * bulk) * tz;
      }
      this.anchor.copy(this._from);
      return;
    }

    const c = Math.cos(t.azimuth * this.side);
    const sn = Math.sin(t.azimuth * this.side);
    const lf = this.legFrom(shot);
    const fx = lf[0] * this.side * t.scale * s;
    // The along-track offset is *when*, not how far away — so the distance
    // knob is left off it deliberately.
    const fz = shot.pass === undefined
      ? lf[2] * t.scale * s
      : -clamp(this.tas * this.duration * shot.pass, REACH_MIN * s, REACH_MAX);
    this._from
      .set(fx * c - fz * sn, shot.from[1] * t.scale * s + t.height,
        fx * sn + fz * c)
      // The ground track, not the whole attitude: where you put a tripod
      // depends on which way the aeroplane is *going*, not on how its nose
      // happens to be pointing at the instant of the cut.
      .applyQuaternion(yawOf(quat, this._q))
      .add(pos);
    // Backwards, the jib begins at the far end of its own travel.
    const boom = shot.anchorMove;
    if (this.reversed && boom !== undefined) {
      this._from.x += boom[0] * this.side * s;
      this._from.y += boom[1] * s;
      this._from.z += boom[2] * s;
    }
    this.anchor.copy(this._from);
  }

  /**
   * A tripod beside the point where the player and the target will pass.
   *
   * Their closest approach is solved from where they are and where they are
   * going. If they are closing and will meet inside the shot, the camera stands
   * off to one side of the midpoint of that meeting; if not — a stern chase,
   * say — it falls back to an ordinary pass on the player's track, which the
   * bandit ahead of him crosses first.
   */
  private plantMerge(shot: ShotSpec, pos: THREE.Vector3, quat: THREE.Quaternion,
    t: ShotTweak): void {
    const s = this.playerScale;
    const tg = this.target;
    const vP = this.playerVel;
    const dur = this.duration;
    let tau = -1;
    if (tg !== null) {
      const rx = tg.position.x - pos.x;
      const ry = tg.position.y - pos.y;
      const rz = tg.position.z - pos.z;
      const vx = tg.velocity.x - vP.x;
      const vy = tg.velocity.y - vP.y;
      const vz = tg.velocity.z - vP.z;
      const vv = vx * vx + vy * vy + vz * vz;
      if (vv > 4) tau = -(rx * vx + ry * vy + rz * vz) / vv;
    }
    const meet = this._a;
    if (tg !== null && tau > 0.5 && tau < dur * 0.85) {
      meet.copy(pos).addScaledVector(vP, tau)
        .add(this._b.copy(tg.position).addScaledVector(tg.velocity, tau))
        .multiplyScalar(0.5);
      this.mergePass = tau / dur;
    } else {
      tau = Math.max(dur * 0.45, REACH_MIN * s / Math.max(vP.length(), 1));
      meet.copy(pos).addScaledVector(vP, tau);
      if (vP.lengthSq() < 1) meet.addScaledVector(this._b.set(0, 0, -1).applyQuaternion(quat), REACH_MIN * s);
      this.mergePass = clamp(tau / dur, 0.1, 0.9);
    }
    // Off to the side of the player's track.
    const fwd = this._b.set(vP.x, 0, vP.z);
    if (fwd.lengthSq() < 1e-3) fwd.set(0, 0, -1).applyQuaternion(yawOf(quat, this._q)).setY(0);
    fwd.normalize();
    const lf = this.legFrom(shot);
    const side = lf[0] * this.side * t.scale * s;
    const c = Math.cos(t.azimuth * this.side);
    const sn = Math.sin(t.azimuth * this.side);
    // Right of track is (-fz, 0, fx); the tweak's swing turns it about the meet.
    const rx = -fwd.z;
    const rz = fwd.x;
    const ox = side * (rx * c - fwd.x * sn);
    const oz = side * (rz * c - fwd.z * sn);
    this.anchor.set(meet.x + ox, meet.y + lf[1] * t.scale * s + t.height, meet.z + oz);
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/** A landmark's size for the anchored shots: the larger of height and spread. */
function tripodBulk(st: LandmarkTarget): number {
  return Math.max(st.height, st.radius * 1.4, 8);
}

/** A subject's scale, defended: the camera must never be the reason for a NaN. */
function scaleOf(v: number | undefined): number {
  return v !== undefined && Number.isFinite(v) && v > 0 ? clamp(v, 0.3, 6) : 1;
}

/** Push `p` out to at least `gap` from `centre`, along the line between them. */
function keepClear(p: THREE.Vector3, centre: THREE.Vector3, gap: number): void {
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
 * The heading part of an attitude, as a quaternion, into `out`.
 *
 * Camera offsets are given in the aircraft's frame but are meant to be read
 * against its *track*: "off the right wing" and "two hundred ahead" describe
 * places, and neither should move because the nose came up.
 */
export function yawOf(quat: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
  out.copy(quat);
  const yaw = Math.atan2(
    2 * (out.w * out.y + out.x * out.z),
    1 - 2 * (out.y * out.y + out.x * out.x),
  );
  return out.setFromAxisAngle(UP, yaw);
}

/** Hold a unit vector's elevation inside ±`max` radians, in place. */
export function clampElevation(v: THREE.Vector3, max: number): THREE.Vector3 {
  const h = Math.hypot(v.x, v.z);
  const el = Math.atan2(v.y, h);
  if (Math.abs(el) <= max) return v;
  const e = Math.sign(el) * max;
  if (h < 1e-6) {
    // Straight up or down, with no bearing to keep: any will do, consistently.
    return v.set(0, Math.sin(e), Math.cos(e));
  }
  const k = Math.cos(e) / h;
  return v.set(v.x * k, Math.sin(e), v.z * k);
}

const _dq = new THREE.Quaternion();
const _dq2 = new THREE.Quaternion();

/**
 * Turn unit vector `cur` toward `want`, exponentially at `rate` and never
 * faster than `maxRate` rad/s. Antiparallel is handled: it picks an axis and
 * swings rather than collapsing through zero, which is what a lerp would do.
 */
export function dampDirection(cur: THREE.Vector3, want: THREE.Vector3, rate: number,
  maxRate: number, dt: number): THREE.Vector3 {
  const angle = Math.acos(clamp(cur.dot(want), -1, 1));
  if (angle < 1e-6) return cur.copy(want);
  const step = Math.min(angle * (1 - Math.exp(-rate * dt)), maxRate * dt);
  _dq.setFromUnitVectors(cur, want);
  _dq2.identity().slerp(_dq, step / angle);
  return cur.applyQuaternion(_dq2).normalize();
}

/** Spherical blend of two unit vectors, into `out`. */
export function slerpDirection(a: THREE.Vector3, b: THREE.Vector3, t: number,
  out: THREE.Vector3): THREE.Vector3 {
  const angle = Math.acos(clamp(a.dot(b), -1, 1));
  if (angle < 1e-5) return out.copy(a);
  _dq.setFromUnitVectors(a, b);
  _dq2.identity().slerp(_dq, t);
  return out.copy(a).applyQuaternion(_dq2).normalize();
}

/**
 * How the operator has reshaped one shot.
 *
 * The first three say where the camera is. The last two say how it moves, and
 * they are deliberately *not* "speed": a shot is a move from `from` to `to`
 * across its duration, so speed is travel ÷ hold and offering all three would
 * give three sliders that silently fight each other.
 */
export interface ShotTweak {
  /** Radians swung around the aircraft. */
  azimuth: number;
  /** Metres up or down. */
  height: number;
  /** Multiplier on how far away the camera sits. */
  scale: number;
  /** Multiplier on how long the shot is held. */
  hold: number;
  /** Multiplier on how far the camera travels across it. 0 is a locked frame. */
  travel: number;
}

/** As far as the travel knob goes. Four times the written move is a long way. */
export const MAX_TRAVEL = 4;

/** A shot with no adjustment yet. */
const fresh = (): ShotTweak => ({ azimuth: 0, height: 0, scale: 1, hold: 1, travel: 1 });

/** The "no adjustment" adjustment, shared and never written to. */
const UNTOUCHED: ShotTweak = fresh();

/**
 * A saved setup: a shot, and the shape it was in when it was saved.
 */
export interface ShotSlot {
  shot: string;
  tweak: ShotTweak;
}

/**
 * Overall pace, multiplied onto every shot on top of its own adjustment.
 */
export interface DirectorStyle {
  name: string;
  hold: number;
  travel: number;
}

export const DIRECTOR_STYLES: DirectorStyle[] = [
  { name: 'Calm', hold: 1.45, travel: 0.62 },
  { name: 'Standard', hold: 1, travel: 1 },
  { name: 'Kinetic', hold: 0.72, travel: 1.5 },
];
