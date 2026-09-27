import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../util/math';
import type { Telemetry } from '../flight/FlightModel';

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
 */

export type Scale = 'wide' | 'medium' | 'close';

const SCALES: Scale[] = ['wide', 'medium', 'close'];

/**
 * A landmark the camera can work with, rather than merely aim past.
 *
 * `y` is the ground it stands on and `height` is how far it rises above that,
 * so a tripod can be put at its foot or level with its top without the camera
 * having to know what a lighthouse is.
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
  /** Camera offset in the aircraft's frame: +X right, +Y up, +Z aft. */
  from: [number, number, number];
  to: [number, number, number];
  /** What the camera is aimed at, offset in the aircraft's frame. */
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
   * Where the camera sits relative to something in the world rather than to the
   * aircraft. 'sun' puts the subject between the lens and the sun — a
   * silhouette, rim-lit at low sun, which is the best light this sim makes and
   * until now was reached only by accident. 'landmark' puts the nearest city or
   * peak behind the subject. 'structure' does the same with the nearest
   * *built* landmark — a castle, a mast, a lighthouse — which is a different
   * question with a different answer, and asking it separately is what stops a
   * summit shot settling for a market town.
   */
  azimuth?: 'sun' | 'landmark' | 'structure';
  /**
   * Plant this locked shot at the landmark instead of on the flight path.
   *
   * The ordinary tripod is placed a certain distance up the track: the camera
   * is somewhere the aeroplane is *going*, and what is behind it is whatever
   * happens to be there. This puts the camera at something instead — at the
   * foot of the lighthouse, on the castle wall, in among the turbines — so the
   * landmark is in the frame with the aircraft rather than merely near it.
   *
   * `from` is read in the landmark's own frame: −Z points from the landmark
   * toward the aeroplane, so a negative Z stands the camera out in front of it
   * and a positive Z puts the landmark between the lens and the subject.
   *
   * And it is in *landmark heights*, not in metres. These things are drawn at
   * 3.4× and they are not close to a common size: a castle stands about 100 m,
   * a lighthouse 130, a cooling tower 230, a mast or a turbine 400. A standoff
   * in metres that frames one of them buries the lens in another — measured,
   * 125 m behind a lighthouse filled the entire frame with white paint and the
   * aeroplane was never in the shot at all. Stated as a multiple, one number
   * composes the same picture at every one of them.
   */
  anchor?: 'landmark';
  /**
   * For anchored shots: how far up the landmark to stand, as a fraction of its
   * height. 0 is the ground at its foot; 1 is level with the top of it.
   */
  anchorHeight?: number;
  /**
   * For anchored shots: the landmarks this one is written for.
   *
   * A shot composed for a lighthouse is a different shot from one composed for
   * a wind farm — the first wants a single vertical filling one side of frame,
   * the second wants to be standing among a dozen moving things. Undefined
   * means it works at anything.
   */
  anchorKind?: string[];
  /**
   * For locked shots: where in the shot the aircraft should reach the camera,
   * as a fraction of the shot's length.
   *
   * A tripod is placed a fixed number of metres up the track, but how long the
   * aeroplane takes to get there is that distance over its speed — so a fixed
   * offset and a fixed duration only agree at one airspeed. Measured, they
   * disagreed badly across the sim's own envelope: at cruise the overtake got
   * its pass a third of the way in and spent the rest of the shot watching the
   * jet recede, and at approach speed the level pass, the low fly-by and the
   * head-on all cut away while the aeroplane was still inbound — which is
   * precisely the speed the plate shots run at, on takeoff and landing.
   *
   * Stating the intent instead lets the distance follow from it: the camera
   * goes `tas * duration * pass` metres up the track, so the pass lands where
   * the shot was composed to put it whatever the aeroplane is doing.
   */
  pass?: number;
  /** For locked shots: a boom, in world metres, run across the shot. */
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
 * The shot list. Offsets are metres, and X is always positive — the sequencer
 * mirrors them onto whichever side it is working.
 *
 * The aircraft's nose points along −Z, so a negative Z offset puts the camera
 * *ahead* of it, which for a locked shot is what gives it something to fly at.
 */
const SHOTS: ShotSpec[] = [
  // ------------------------------------------------------------------- wide
  {
    name: 'establishing', scale: 'wide', side: 1, from: [130, 44, 86], to: [98, 32, 62],
    fov: [34, 30], lag: 2.2,
  },
  {
    name: 'orbit high', scale: 'wide', side: 1, from: [96, 46, 20], to: [72, 32, 16],
    orbit: -Math.PI * 0.55, fov: [36, 30], lag: 2.5,
  },
  {
    name: 'crane down', scale: 'wide', side: 1, from: [34, 250, 74], to: [14, 78, 28],
    fov: [52, 40], lag: 2,
  },
  {
    // Lead room cut to a quarter of what a wide shot normally gets. Aiming
    // ahead of the nose leaves the subject space to move into, which is right
    // from beside the aircraft and wrong from directly above it: there is no
    // 'ahead' on screen up here, so the thirty-four metres a wide shot assumes
    // simply pushed the aeroplane two-thirds of the way to the bottom edge.
    name: 'bird’s eye', scale: 'wide', side: 0, from: [0, 158, 8], to: [0, 118, 36],
    look: [0, 0, -6], fov: [46, 46], lag: 3, lead: 8,
  },
  {
    name: 'vertical rise', scale: 'wide', side: 0, from: [0, 34, 74], to: [0, 215, 150],
    fov: [42, 48], lag: 2, linear: true,
  },
  {
    name: 'pull-back reveal', scale: 'wide', side: 1, from: [24, 7, 28], to: [136, 46, 124],
    fov: [44, 32], lag: 2.5,
  },
  {
    name: 'high astern', scale: 'wide', side: 0, from: [0, 58, 158], to: [0, 40, 112],
    fov: [36, 32], lag: 3,
  },
  // ----------------------------------------------------------- the narrative
  //
  // Every other shot in this library aims *at* the aeroplane. These two are
  // about the flight rather than the aircraft: one shows what it is going
  // towards, and one simply stops for a while. A sequence made only of angles
  // on a subject is a portfolio; these are what make it a journey.
  {
    // Over the shoulder. The lead is enormous on purpose — aiming four hundred
    // metres up the track drops the aeroplane into the bottom of the frame and
    // hands the rest of the picture to the country it is flying into. It is the
    // one shot here where the aircraft is not the subject.
    name: 'over the shoulder', scale: 'medium', side: 0,
    from: [0, 6, 26], to: [0, 5, 20], look: [0, 1.5, 0],
    lead: 420, fov: [40, 36], lag: 4,
  },
  {
    // The rest. Long, still, and nearly flat: no dolly worth the name, no
    // focal ramp, ten seconds of holding. Narration needs somewhere to breathe,
    // and the longest wide in the library was six seconds with something always
    // moving.
    name: 'the rest', scale: 'wide', side: 1,
    from: [210, 46, 150], to: [204, 45, 145], look: [0, -14, 0],
    fov: [30, 30], lag: 2.4, float: 16e-4, seconds: [8.5, 10.5],
  },
  // ------------------------------------------------- wide, level with the jet
  {
    //
    // Every shot above this point looks *down* at the aeroplane: the wide library
    // sat between 26 and 250 metres up, and the only two below it were planted on
    // the ground. Nothing was level, which is the one height at which the horizon
    // runs through the frame and the land reads as land rather than as a map.
    //
    // The offset is applied in the aircraft's yaw frame alone, so a zero here is
    // the aircraft's own altitude however it is pitched or banked, and the camera
    // keeps world-up — the jet rolls, the horizon does not. Each of these aims a
    // few metres *below* the aircraft, which lifts subject and horizon together
    // onto an upper third and leaves the bottom two-thirds to the country.
    // The landscape shot. Far out on a long lens, so ridges stack up behind one
    // another the way they do through a real telephoto, and the aeroplane is a
    // small hard shape in a wide soft frame rather than the subject of a
    // portrait.
    name: 'long lens', scale: 'wide', side: 1, from: [520, 2, 40], to: [430, 0, 10],
    look: [0, -30, 0], fov: [22, 20], lag: 3,
  },
  {
    // Dead astern at the aircraft's own height: it sits on the horizon with the
    // land running away to the vanishing point behind it. `side: 0`, so the
    // sequencer may also use it to cross to the other side of the line.
    name: 'level astern', scale: 'wide', side: 0, from: [0, 1, 300], to: [0, 0, 190],
    look: [0, -18, 0], fov: [26, 22], lag: 3.5,
  },
  {
    // The same idea pointed into the light. `azimuth: 'sun'` already existed but
    // was only ever reached from above; at low sun and at this height the sun
    // sits on the horizon behind the aircraft and its path lies across the water
    // toward the lens.
    name: 'sun path', scale: 'wide', side: 0, azimuth: 'sun', from: [0, 3, 240],
    to: [0, 1, 150], look: [0, -15, 0], fov: [28, 24], lag: 3, dof: 0.3,
  },
  {
    // The opposite lens. Close off the wingtip and wide enough that the country
    // wraps round behind — level like the others, and reads nothing like them.
    // Travel x2.5: a wide sweep out along the wing rather than a nudge. The
    // move runs outward, so it is the far end that goes further.
    name: 'wing walk', scale: 'wide', side: 1, from: [46, 0, 6], to: [76, 2.5, -19],
    look: [0, -7, 0], fov: [48, 44], lag: 4, lead: 22, float: 16e-4,
  },
  {
    // A level orbit. `orbit high` sweeps from forty-six metres up, looking down;
    // from here the horizon itself swings round behind the aeroplane, which is
    // the whole reason to orbit at this height rather than above it.
    // Travel x0.5. Halved in both senses, because for an orbiting shot the
    // sweep *is* most of the travel: a shorter dolly with the same 135 degrees
    // of arc would not be half the move, it would be the same move.
    name: 'level orbit', scale: 'wide', side: 1, from: [250, 2, 60], to: [230, 1, 50],
    look: [0, -20, 0], orbit: -Math.PI * 0.375, fov: [30, 27], lag: 3,
  },
  {
    // Planted at the aircraft's own altitude, six hundred metres up the track:
    // the jet grows from a speck and whips past at eye height. The level
    // counterpart to `crane pass`, which plants sixty metres below.
    name: 'level pass', scale: 'wide', side: 1, locked: true, pass: 0.75, from: [90, 0, -600],
    to: [90, 0, -600], look: [0, -46, 0], fov: [34, 30], seconds: [4.6, 5.8],
  },
  // ----------------------------------------------------------------- medium
  {
    name: 'side profile', scale: 'medium', side: 1, from: [84, 7, -8], to: [44, 4, 3],
    fov: [38, 34], lag: 3,
  },
  {
    name: 'frontal push', scale: 'medium', side: 0, from: [3, 4, -112], to: [1, 2, -34],
    fov: [40, 32], lag: 5,
  },
  {
    name: 'three-quarter front', scale: 'medium', side: 1, from: [48, 11, -62],
    to: [27, 6, -31], fov: [42, 36], lag: 4, dof: 0.54,
  },
  {
    name: 'three-quarter rear', scale: 'medium', side: 1, from: [42, 15, 58],
    to: [25, 8, 35], fov: [44, 38], lag: 4,
  },
  {
    name: 'lateral dolly', scale: 'medium', side: 1, from: [42, 5, -40], to: [42, 5, 40],
    fov: [44, 44], lag: 4, linear: true,
  },
  {
    name: 'overtake', scale: 'medium', side: 1, locked: true, pass: 0.36, from: [15, 8, -160],
    to: [15, 8, -160], fov: [46, 34], seconds: [2.6, 3.4], reserved: true,
    tags: ['flourish'],
  },
  {
    name: 'low tracking', scale: 'medium', side: 1, from: [36, -20, -22], to: [23, -11, -8],
    fov: [46, 40], lag: 4, dof: 0.48, float: 3e-3,
  },
  {
    name: 'climb reveal', scale: 'medium', side: 1, from: [60, -28, 68], to: [22, 24, 40],
    fov: [44, 36], lag: 2.5,
  },
  // ------------------------------------------------------------------ close
  {
    // Travel x1.15. This one pushes in, and the end of a push-in is the shot —
    // so the extra distance is taken at the start. Scaling the far end instead
    // would have walked the lens toward the airframe for no gain.
    name: 'wingtip', scale: 'close', side: 1, from: [15.98, 1.71, 5.6], to: [8.5, 0.9, 1],
    look: [0, 0.6, -3], fov: [58, 52], roll: -0.09, lag: 6, dof: 0.9, float: 4e-3,
  },
  {
    // Travel x1.8, taken at the start. Scaled from the far end it would have
    // finished 3.4 m from the aircraft's centre — inside a machine with a
    // 12.7 m span, with the lens somewhere in the port intake.
    name: 'canopy', scale: 'close', side: 1, from: [14.6, 3.52, -9.56],
    to: [6.5, 1.9, -3.8], look: [0, 1, -4.2], fov: [52, 46], lag: 6, dof: 0.96, float: 5e-3,
  },
  {
    name: 'tail chase', scale: 'close', side: 0, from: [0, 2.4, 24], to: [0, 1.6, 13],
    look: [0, 0.4, 6], fov: [50, 44], lag: 6, dof: 0.66,
  },
  {
    name: 'belly rear', scale: 'close', side: 1, from: [7, -14, 54], to: [3, -4, 25],
    look: [0, -0.5, 2], fov: [50, 44], lag: 5,
  },
  {
    // Pushing in while the lens widens: the background stretches away behind a
    // subject that barely changes size.
    name: 'nose chase', scale: 'close', side: 1, from: [13, 2.6, -36], to: [5, 1.5, -15],
    look: [0, 0.4, -2], fov: [44, 56], lag: 6, dof: 0.78,
  },
  {
    // Held twice as long as a close shot normally is: the arc is most of a
    // half-circle, and at the usual three-and-a-bit seconds it was a whip pan.
    name: 'orbit close', scale: 'close', side: 1, from: [27, 5, 6], to: [19, 3, 4],
    orbit: Math.PI * 0.85, fov: [50, 44], lag: 4, seconds: [6, 8.4],
  },
  {
    name: 'rising arc', scale: 'close', side: 1, from: [21, -7, 9], to: [16, 9, 4],
    orbit: Math.PI * 0.5, fov: [52, 46], lag: 4, seconds: [3.75, 5.25],
  },
  {
    name: 'fly-by low', scale: 'close', side: 1, locked: true, pass: 0.78, from: [40, -13, -640],
    to: [40, -13, -640], fov: [38, 30], roll: 0.05, seconds: [4.8, 5.8], reserved: true,
    tags: ['flourish'],
  },
  // ------------------------------------------------------------- new angles
  {
    // The only setup with the horizon along the bottom of frame.
    name: 'ground plate', scale: 'wide', side: 1, locked: true, pass: 0.62, from: [70, -420, -900],
    to: [70, -420, -900], fov: [40, 34], anchorMove: [0, 24, 0], seconds: [4.6, 5.6],
    tags: ['takeoff'],
  },
  {
    // Underneath, looking up: the jet against sky, nothing else in frame.
    name: 'underside', scale: 'close', side: 1, from: [10, -22, 16], to: [5, -12, 7],
    look: [0, 0, -2], fov: [54, 48], lag: 5, dof: 0.72,
  },
  {
    // Vertigo the other way: pull out while the lens narrows, so the background
    // crowds in behind a subject that holds its size.
    name: 'reverse dolly zoom', scale: 'medium', side: 1, from: [16, 4, -20],
    to: [58, 12, -74], fov: [58, 34], lag: 5, dof: 0.48,
  },
  {
    // Planted close and abeam: the pan speed comes free from the geometry.
    name: 'whip pass', scale: 'close', side: 1, locked: true, pass: 0.33, from: [26, -4, -190],
    to: [26, -4, -190], fov: [52, 52], seconds: [3.4, 4.2], reserved: true,
    tags: ['flourish'],
  },
  {
    // The quiet one. Opens on a soft wash of country and lets the aeroplane
    // resolve out of it — `rack` was in the grammar and one shot in the library
    // used it.
    name: 'rack focus', scale: 'close', side: 1, from: [17, 2.5, 9], to: [15, 2.2, 7],
    look: [0, 0.5, -2], fov: [46, 44], lag: 5, dof: 1.3, rack: [2.6, 1],
    seconds: [3.2, 4.2], reserved: true, tags: ['flourish'],
  },
  {
    // Planted on the nose axis rather than abeam: it grows from a dot and the
    // aim whips through half a circle as it goes over. Fifteen metres up, so
    // twelve and a half metres of wingspan pass underneath and not through.
    name: 'head-on pass', scale: 'close', side: 0, locked: true, pass: 0.8, from: [0, 15, -430],
    to: [0, 15, -430], fov: [44, 38], seconds: [3, 3.9], reserved: true, tags: ['flourish'],
  },
  // ------------------------------------------ flourishes that are not fly-bys
  //
  // The first three punctuation shots — whip pass, overtake, fly-by low — are
  // all the same shot: planted off to one side, locked, watching the aeroplane
  // go by. Only where they are planted differs, so a sequence that reaches for
  // punctuation reaches for the same gesture every time. These four are each a
  // different *kind* of thing: one is only focus, one puts the camera somewhere
  // the other three never go, and two are about the world rather than about the
  // aircraft.
  {
    // Somebody standing on a hill. Planted far out and low, so the aeroplane
    // crosses the frame small and distant — the world watching it go past,
    // rather than the camera going with it. Every other planted shot is a
    // close pass; this is the opposite end of the same idea.
    name: 'ground witness', scale: 'wide', side: 1, locked: true, pass: 0.55,
    from: [900, -520, -1400], to: [900, -520, -1400],
    fov: [26, 24], seconds: [5.0, 6.4], reserved: true, tags: ['flourish'],
  },
  {
    // Across the sun's disc, on a long lens, close. Held nearly still so the
    // aeroplane does the moving and goes to silhouette for a beat.
    name: 'sun crossing', scale: 'close', side: 0, azimuth: 'sun',
    from: [0, 3, 62], to: [0, 2, 48],
    fov: [30, 26], lag: 4, dof: 0.5, seconds: [3.0, 3.9],
    reserved: true, tags: ['flourish'],
  },
  {
    // The city or the peak held in frame while the aeroplane crosses it. The
    // one flourish that is about the world rather than about the aircraft — and
    // the only one that needs the world to be offering something.
    name: 'landmark plant', scale: 'wide', side: 0, azimuth: 'landmark',
    from: [0, 28, 215], to: [0, 24, 185],
    fov: [30, 28], lag: 3.5, seconds: [4.4, 5.6],
    reserved: true, tags: ['flourish'],
  },
  {
    // The arrival beat. Same geometry as the other two landmark shots — the
    // city or the peak ends up behind the subject — but three hundred metres
    // out on a long lens instead of a hundred on a wide one, and compression is
    // the whole difference: the landmark looms instead of receding, so this
    // reads as flying *to* somewhere rather than merely past it.
    name: 'the approach', scale: 'wide', side: 0, azimuth: 'landmark',
    from: [0, 18, 320], to: [0, 14, 265], fov: [24, 21], lag: 3,
    seconds: [4.6, 5.8],
  },
  {
    // Sun behind the subject. Worth having as its own setup rather than hoping.
    name: 'into the sun', scale: 'medium', side: 0, azimuth: 'sun',
    from: [0, 6, 62], to: [0, 4, 40], look: [0, 0.5, -4],
    fov: [40, 34], lag: 4, dof: 0.54,
  },
  {
    name: 'sun rim', scale: 'close', side: 0, azimuth: 'sun',
    from: [0, 2.5, 20], to: [0, 1.8, 12], look: [0, 0.6, -3],
    fov: [48, 42], lag: 5, dof: 0.84, float: 0.004,
  },
  {
    // Hold a city or a peak behind the aircraft as it crosses.
    name: 'landmark pass', scale: 'wide', side: 0, azimuth: 'landmark',
    from: [0, 40, 150], to: [0, 30, 96], fov: [34, 30], lag: 3, tags: ['city'],
  },
  {
    name: 'landmark low', scale: 'medium', side: 0, azimuth: 'landmark',
    from: [0, 8, 74], to: [0, 6, 48], look: [0, 0.5, -2],
    fov: [42, 36], lag: 4, dof: 0.42, tags: ['city'],
  },
  {
    // The longest lens in the library, pointed at a built landmark.
    //
    // A mast is 90 m of lattice and a castle is a hundred metres of wall, and
    // at any ordinary focal length both of them sit on the horizon looking
    // like scenery. Compression is the whole shot: at 20° the summit comes
    // forward and stands behind the aeroplane at something like its real
    // importance, which is what the exaggerated scale was for.
    name: 'summit line', scale: 'wide', side: 0, azimuth: 'structure',
    from: [0, 20, 360], to: [0, 16, 300], fov: [22, 19], lag: 3,
    seconds: [4.8, 6.0],
  },

  // ------------------------------------------- planted at the landmark itself
  //
  // The ordinary tripod stands where the aeroplane is going. These stand at
  // something, and the something is in the frame: the aircraft is what moves
  // through the shot rather than what the shot is of. All of them sit on the
  // far side of the landmark from the aeroplane, so it is the landmark the
  // lens looks past — a camera in front of the tower is a camera with the
  // tower behind it, which is the one arrangement that shows nothing.
  {
    // Foreground, and a focus pull off it. The landmark starts sharp and
    // enormous, and the rack hands the shot over to the aircraft arriving
    // behind it.
    name: 'landmark rack', scale: 'medium', side: 1, locked: true,
    anchor: 'landmark', from: [0.15, 0.07, 2.0], to: [0.15, 0.07, 2.0],
    fov: [38, 34], dof: 1.25, rack: [0.45, 1.0], seconds: [4.6, 5.8],
  },
  {
    // Up at it. Close in under a lighthouse or a mast, so the tower runs the
    // full height of frame and the jet crosses the top of it.
    name: 'the sentinel', scale: 'wide', side: 1, locked: true,
    anchor: 'landmark', anchorKind: ['lighthouse', 'mast'],
    from: [0.30, 0.03, 1.7], to: [0.30, 0.03, 1.7], fov: [50, 44],
    seconds: [4.8, 6.0],
  },
  {
    // Level with the top of the wall. Looking *down* on a hilltop is the
    // ordinary aerial view of one; being level with it is not, and it is the
    // angle that says how high the thing was built. An observatory takes the
    // same setup for the same reason — it is another building put somewhere
    // deliberately high, and the shot is about the height.
    name: 'the battlement', scale: 'wide', side: 1, locked: true,
    anchor: 'landmark', anchorKind: ['castle', 'monastery', 'observatory'], anchorHeight: 0.78,
    from: [0.42, 0.06, 3.6], to: [0.42, 0.06, 3.6], fov: [40, 35],
    anchorMove: [0, 0.14, 0], seconds: [5.0, 6.2],
  },
  {
    // Dead behind the stacks, so they cut across the aircraft as it passes.
    // Occlusion is the strongest depth cue there is and nothing else in the
    // library uses it.
    name: 'stack pass', scale: 'medium', side: 1, locked: true,
    anchor: 'landmark', anchorKind: ['powerplant'], anchorHeight: 0.18,
    from: [0.07, 0.05, 1.2], to: [0.07, 0.05, 1.2], fov: [36, 32], dof: 0.7,
    seconds: [4.4, 5.6],
  },
  {
    // Inside the farm. The blades already turn, so the near one sweeping
    // through the frame costs nothing and is the only moving foreground the
    // sim has.
    name: 'turbine wash', scale: 'medium', side: 1, locked: true,
    anchor: 'landmark', anchorKind: ['turbine'], anchorHeight: 0.34,
    from: [0.25, 0.02, 1.7], to: [0.25, 0.02, 1.7], fov: [44, 38], dof: 1.1,
    rack: [0.5, 1.0], seconds: [4.4, 5.6],
  },
  {
    // A ground-anchored crane: planted in the world, booming up as it passes.
    name: 'crane pass', scale: 'wide', side: 1, locked: true, pass: 0.5,
    from: [120, -60, -420], to: [120, -60, -420], fov: [42, 36],
    anchorMove: [0, 120, 0], seconds: [5.0, 6.2],
  },
  {
    name: 'runway plate', scale: 'medium', side: 1, locked: true, pass: 0.44,
    from: [46, -30, -300], to: [46, -30, -300], fov: [44, 34],
    seconds: [4.0, 5.0], tags: ['takeoff', 'landing'],
  },

  // ------------------------------------------------------- the way back out
  // Every one of these *pulls out*. The scale ladder runs both ways, and coming
  // back up it — close, medium, wide — a medium shot that pushes in fights the
  // direction of travel and makes the cut to the wide feel like a jump.
  {
    name: 'peel away', scale: 'close', side: 1,
    from: [7, 1.2, 4], to: [24, 9, 22], fov: [52, 46], lag: 4, dof: 0.54,
  },
  {
    name: 'drop back', scale: 'medium', side: 0,
    from: [0, 3, 18], to: [0, 12, 96], fov: [46, 40], lag: 3.5, dof: 0.36,
  },
  {
    name: 'wide retreat', scale: 'medium', side: 1,
    from: [30, 8, 22], to: [96, 30, 90], fov: [44, 38], lag: 3, linear: true,
  },
  {
    name: 'lift out', scale: 'wide', side: 1,
    from: [70, 26, 54], to: [180, 120, 150], fov: [40, 34], lag: 2.4, linear: true,
  },
  {
    // The aeroplane leaving. Only at the departure — it reads as an ending, and
    // an ending twelve minutes before the end is just a camera falling behind.
    name: 'departure', scale: 'wide', side: 0,
    from: [0, 30, 120], to: [0, 90, 460], fov: [38, 30], lag: 2.2, linear: true,
    tags: ['takeoff'], reserved: true,
  },
];

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

/** Both ways round, for the sequencer to weigh against each other. */
/**
 * How far up the track a tripod may be planted, metres.
 *
 * The floor matters on the runway, where the aeroplane starts at a standstill
 * and a distance derived from its speed would otherwise put the camera on top
 * of it; the ceiling keeps a fast pass from planting the shot beyond the haze.
 */
/**
 * How far into a shot a beat may bring the cut forward.
 *
 * The last thirty per cent of it. Beats arrive every twelve to eighteen
 * seconds and shots run four or five, so the width of this window is very
 * nearly the whole story: at a fifth only 7% of cuts caught one, at 0.7 it is
 * 14% — about one a half-minute — and the mean shot moves from 4.6 s to 4.5 s.
 * Going wider buys little and starts cutting shots near half their length,
 * which reads as a jump rather than as an edit.
 */
const BEAT_WINDOW = 0.7;
/** Seconds a planted shot holds after its pass before a beat may cut it. */
const BEAT_AFTER_PASS = 0.35;
/** Degrees of bank, m/s of climb, and g at which a manoeuvre counts as on. */
const BEAT_ON = [14, 12, 1.45];
/** And where it counts as over again. */
const BEAT_OFF = [4, 3, 1.12];

const REACH_MIN = 90;
const REACH_MAX = 1800;

const ORIENTATIONS: readonly boolean[] = [false, true];

/**
 * Cuts that must pass between one flourish and the next.
 *
 * They are punctuation. Two in quick succession is not emphasis, it is a tic.
 */
/**
 * The run a landmark tripod is judged against, seconds.
 *
 * Eligibility has to be decided before a shot is chosen, and the duration is
 * not known until it has been — so these use the length a wide shot usually
 * gets rather than the length this one will turn out to have. Close enough:
 * the window it opens is wide, and the miss distance is what actually decides
 * whether the shot works.
 */
const TRIPOD_RUN = 5;
/** How far off the track a landmark can be and still fill any of the frame. */
const TRIPOD_MISS = 900;
/**
 * How high the aeroplane can be for a tripod on the ground to be worth it.
 *
 * The camera is standing at the landmark, so the aircraft's height above the
 * ground *is* the distance to it at the closest point. At two thousand metres
 * a jet seventeen metres long is a speck over a lighthouse, and the shot is a
 * picture of the lighthouse with a fly on it. This is the altitude below which
 * the aeroplane still reads as the subject.
 */
const TRIPOD_CEILING = 900;

const FLOURISH_GAP = 5;

/**
 * How much a camera has to swing round the aircraft before the direction of it
 * is worth carrying across a cut, radians.
 *
 * Thirty degrees. Below that the sweep is incidental — a dolly that happens to
 * cross a few degrees of bearing on its way in — and treating it as a direction
 * to be continued is fitting a rule to noise.
 */
const SWING_MATTERS = 0.52;

/** How many setups back the sequencer remembers, for the sake of variety. */
const RECENT_MEMORY = 9;

/**
 * How many flourishes back to remember.
 *
 * Four of nine: enough that one cannot recur while three others are waiting,
 * not so many that the rare ones — the landmark plant, which needs a landmark —
 * are forced in where they do not belong.
 */
const FLOURISH_MEMORY = 4;

/** Whether a shot goes anywhere at all — a still frame reads the same backwards. */
function movesAtAll(shot: ShotSpec): boolean {
  if (shot.orbit !== undefined && shot.orbit !== 0) return true;
  if (shot.anchorMove !== undefined) return true;
  return Math.hypot(shot.to[0] - shot.from[0], shot.to[1] - shot.from[1],
    shot.to[2] - shot.from[2]) > 0.5;
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
    // A planted camera has the strongest direction cue in the library, and
    // returning zero for it threw that away — worse, it reset the run, so every
    // fly-by broke the chain it should have been carrying. The aeroplane flies
    // past a fixed lens, so the bearing sweeps from nearly astern round to
    // nearly ahead, and which way round depends only on which side it is
    // planted. Reversal does not change that: it runs the jib the other way,
    // not the aircraft.
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
  // bearing atan2(x, z) as the angle grows. So a positive `orbit` swings the
  // camera anticlockwise in bearing terms. Signed the other way, the sequencer
  // scored every candidate exactly backwards and produced 34% continuity across
  // 478 cuts — reliably worse than tossing a coin, which is what being
  // consistently wrong looks like.
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
  framing: 'sun' | 'landmark' | null;
  /** Written for a fast lens. */
  shallow: boolean;
  /** Punctuation: dealt between runs rather than stepped through. */
  flourish: boolean;
}

/**
 * The shot library, described for the picker.
 *
 * Derived from the specs rather than written out again, so a shot added above
 * appears in the UI without anyone having to remember a second list — and so
 * what the UI says about a shot cannot disagree with what the shot does.
 */
/**
 * The one name the picker offers for every landmark-anchored setup.
 *
 * There are four of them and they are genuinely different shots, but choosing
 * between them means knowing whether the thing off the nose is a lighthouse or
 * a cooling tower — which is the director's job, not the operator's. So the
 * list carries one entry and the director picks the setup that suits whatever
 * is actually out there.
 */
export const LANDMARK_TRIPOD = 'landmark tripod';

/** The setups that entry stands for. */
const TRIPOD_SHOTS = SHOTS.filter((s) => s.anchor === 'landmark');

export function shotCatalogue(): ShotInfo[] {
  const listed: ShotInfo[] = [];
  let collapsed = false;
  for (const s of SHOTS) {
    if (s.anchor === 'landmark') {
      // In the place the first of them would have taken, so the list keeps the
      // order the library is written in.
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
      });
      continue;
    }
    listed.push(describe(s));
  }
  return listed;
}

function describe(s: ShotSpec): ShotInfo {
  return {
    name: s.name,
    scale: s.scale,
    move: moveOf(s),
    locked: s.locked === true,
    framing: s.azimuth === 'structure' ? 'landmark' : (s.azimuth ?? null),
    shallow: (s.dof ?? 0) > 0,
    flourish: s.tags?.includes('flourish') === true,
  };
}

/** Lead room by scale, metres ahead of the nose. */
const LEAD: Record<Scale, number> = { wide: 34, medium: 16, close: 5 };

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
   * doubles the library for nothing, and — more usefully — it means the
   * sequencer almost always has a way to carry the camera on in the direction
   * it was already going, which is most of what makes a cut disappear.
   */
  private reversed = false;
  /** The operator's switch: play everything backwards. */
  private reverseAll = false;
  /** Signed radians the camera swung round the aircraft on the last shot. */
  private lastSwing = 0;
  /** Cuts since the last flourish, so they stay occasional. */
  private sinceFlourish = 0;
  /**
   * The last few setups used, most recent first.
   *
   * Continuity and variety pull against each other: scoring hard for "carries
   * the swing on" narrows the field to whichever handful of shots happen to
   * swing that way, and a long sequence started coming back to the same
   * eighteen setups. A camera operator with a good eye for matching also
   * remembers what they shot five minutes ago; this is that memory.
   */
  private readonly recent: string[] = [];
  /**
   * Which cut each setup was last used on, and how many cuts there have been.
   *
   * The list above only ever subtracts, which meant a shot that had never been
   * dealt at all scored exactly the same as one dealt nine cuts ago — so a
   * setup that was merely unfashionable stayed unfashionable forever. This is
   * the other half: the longer a shot goes unused, the more it is worth.
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
   * *both* crossings are a beat: an audience reads the start of a turn as a
   * moment just as readily as the end of one, and counting only the settle
   * halved the supply for no reason.
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
  /** Eased camera offset in the aircraft's frame. */
  private readonly offset = new THREE.Vector3();
  private readonly _from = new THREE.Vector3();
  private readonly _to = new THREE.Vector3();
  private readonly _look = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private started = false;

  /** Unit vector from the aircraft toward the sun, for backlit setups. */
  private readonly sun = new THREE.Vector3(0.4, 0.5, 0.3);
  /** Something worth putting behind the subject, or null. */
  private landmark: THREE.Vector3 | null = null;
  /** The nearest built landmark, for shots that stand on one. */
  private structure: LandmarkTarget | null = null;
  /**
   * The landmark the *current* shot was planted at.
   *
   * Held for the length of the shot rather than read per frame. `structure` is
   * whatever is nearest right now, and at 200 m/s that changes mid-shot — a
   * tripod that re-sited itself halfway through would be a cut, not a camera.
   */
  private tripod: LandmarkTarget | null = null;
  /** Aircraft heading on the ground, for judging whether a tripod is reachable. */
  private readonly _fwd = new THREE.Vector3();
  /** Set by `force`, so a hand-picked tripod takes the nearest landmark going. */
  private forced = false;
  /** Height above ground, so low shots are not chosen where they cannot work. */
  private agl = 1000;

  get shotName(): string {
    return this.shot.name;
  }

  /** Aperture the current shot wants; 0 is a deep lens. */
  get aperture(): number {
    return this.shot.dof ?? 0;
  }

  /**
   * Where the lens is focused, as a multiple of the distance to the aircraft.
   *
   * A shot can rack across the move — pulling focus off the subject and onto
   * what is behind it is the one thing a real lens does that a game camera
   * almost never bothers with.
   */
  get focusScale(): number {
    const rack0 = this.shot.rack;
    const rack = rack0 === undefined ? undefined
      : (this.reversed ? [rack0[1], rack0[0]] as const : rack0);
    if (rack === undefined) return 1;
    return lerp(rack[0], rack[1], clamp(this.elapsed / this.duration, 0, 1));
  }

  /**
   * Whether a tripod at the nearest landmark would see anything.
   *
   * These shots put the camera at the landmark and aim it at the aeroplane, so
   * they are only shots at all if the aeroplane comes past. Two things have to
   * be true: the landmark is far enough ahead that there is an approach to
   * watch and near enough that the jet arrives inside the shot, and the track
   * passes close enough that it is not a dot. Neither is a preference — miss
   * either and the frame holds a tower and an empty sky.
   */
  private tripodFor(pos: THREE.Vector3, quat: THREE.Quaternion): LandmarkTarget | null {
    const st = this.structure;
    if (st === null) return null;
    if (this.agl > TRIPOD_CEILING) return null;
    this._fwd.set(0, 0, -1).applyQuaternion(yawOf(quat, this._q));
    const dx = st.x - pos.x;
    const dz = st.z - pos.z;
    const along = dx * this._fwd.x + dz * this._fwd.z;
    const across = Math.hypot(dx - this._fwd.x * along, dz - this._fwd.z * along);
    const run = Math.max(this.tas, 60) * TRIPOD_RUN;
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
   * Live adjustments to whatever shot is playing, kept per shot.
   *
   * This is what makes the director a collaborator rather than a slideshow:
   * the shots are already parameterised moves, so the two numbers a camera
   * operator would actually reach for — how far away, how high — can be handed
   * over without giving up the sequencing, the grammar or the cutting. And
   * because a tweak is stored against the *shot*, adjusting a wingtip pass once
   * adjusts it every time it comes round again.
   */
  private readonly tweaks = new Map<string, ShotTweak>();
  /** True while the director is held on one setup instead of cutting away. */
  private pinned = false;
  /**
   * The overall pace every shot is measured against.
   *
   * Numbers rather than a chosen preset: the cinematic camera has no shot to
   * hold still while you adjust it, so there the same two sliders drive *this*
   * pair and apply to everything. The presets are three points in the same
   * space, not a separate mechanism.
   */
  private readonly style = { hold: 1, travel: 1 };
  /** Set by `replay`, honoured on the next update. */
  private replayRequested = false;
  /** The running order, when a reel is playing rather than the director. */
  private queue: ShotSlot[] | null = null;
  /** Index of the next entry to take. */
  private queueAt = 0;
  /** Index of the entry actually on screen, or -1 before the first cut. */
  private queueShown = -1;
  /**
   * Whether a held shot repeats. On by default, because the alternative is
   * what a pin used to do on its own: the move runs once, and from then on you
   * are looking at a still photograph of an aeroplane.
   */
  private looping = true;

  /**
   * The adjustment for a shot, *without* creating one.
   *
   * The HUD reads this every frame, and a getter that quietly inserted a
   * default filled the saved file with a no-op entry for every shot the
   * director happened to play.
   */
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

  /**
   * How long the shot that is playing will be held, seconds.
   *
   * The adjusted figure, not the one in the library — it is what the slider is
   * actually setting, so it is what the slider should read out.
   */
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
   * Stretch or squeeze the shot in progress.
   *
   * The duration is fixed at the cut, so without this a hold slider would do
   * nothing until the shot came round again. Never below the time already
   * elapsed plus a moment, or dragging the slider left would end the shot the
   * pilot is watching.
   */
  private retime(factor: number): void {
    // The floor is what stops a leftward drag from ending the shot being
    // watched — but only while there is still shot left to protect. Measured
    // against raw `elapsed` it went wrong on a pinned setup: a pin holds past
    // the duration, `elapsed` climbs for as long as it is held, and half a
    // minute in, the floor had dragged the length out to 31 seconds — which the
    // slider then read out, and which the sequence would really have waited
    // through on unpinning.
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
   * the director. Each entry carries the shape it was saved in, so a reel is a
   * list of *framings* rather than of shot names.
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

  /**
   * Which entry is on screen, 1-based, or 0 before the first one has been cut
   * to. Derived from what was taken rather than from what is next: computing it
   * backwards from the next index reported "4/4" in the moment between starting
   * a four-entry reel and its first cut.
   */
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
   * Run the move again from the top.
   *
   * Deferred to the next update rather than done here, because restarting a
   * planted shot means re-anchoring it to where the aircraft is *now* — and
   * only `update` is told where that is. Without it, a crane replayed after a
   * minute of flying would run its boom in the piece of sky the aircraft left.
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

  /**
   * Play every shot back to front: the push becomes a pull, the swing goes the
   * other way round, the jib comes down instead of up.
   *
   * The operator's switch. With it off the sequencer still reverses shots when
   * doing so carries the camera on in the direction it was already travelling —
   * that is automatic, and the whole reason reversal exists.
   */
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
    t.height = clamp(t.height - dy * 0.22, -120, 260);
    if (wheel !== 0) t.scale = clamp(t.scale * Math.exp(wheel * 0.0011), 0.25, 6);
  }

  /** Put the current shot back the way it was written. */
  resetShot(): void {
    const t = this.tweaks.get(this.shot.name);
    // Undo the hold on the shot in progress too, or a reset leaves it running
    // to a length nothing on screen still claims.
    if (t !== undefined && t.hold > 0) this.retime(1 / t.hold);
    this.tweaks.delete(this.shot.name);
  }

  /** Cut to the next or previous setup, ignoring the ladder. */
  step(direction: 1 | -1): void {
    const i = SHOTS.indexOf(this.shot);
    const next = SHOTS[(i + direction + SHOTS.length) % SHOTS.length];
    this.pending = next;
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
   * Restore saved adjustments.
   *
   * Every field is defaulted rather than trusted: saves written before hold and
   * travel existed have neither, and a missing multiplier read as `undefined`
   * would put the camera at NaN — which is a black screen, not a bad shot.
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
   * Take whichever landmark setup suits what is out there.
   *
   * Preferring the one written for this kind of landmark, and falling back to
   * the one that works at anything — so the entry does something at a wind
   * farm, a castle and a chimney alike, and does the *right* thing at each.
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
   * Cut now, to something suitable for what just happened.
   *
   * Timed cutting is fine for cruising and wrong for events: the rotation, the
   * gear coming up, the touchdown. Those are the moments a director would cut
   * *to*, and the autopilot knows when they happen.
   */
  request(event: string): void {
    const pool = SHOTS.filter((s) => s.tags?.includes(event));
    if (pool.length === 0) return;
    this.pending = pool[Math.floor(Math.random() * pool.length)];
    this.elapsed = this.duration; // take it on the next update
  }

  reset(): void {
    this.started = false;
    this.elapsed = this.duration; // force a fresh cut on the next update
    this.scaleIndex = 0;
    this.direction = 1;
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
    t: Telemetry,
    camera: THREE.PerspectiveCamera,
    groundHeight: (x: number, z: number) => number,
  ): void {
    this.elapsed += dt;
    this.tas = t.tas;
    this.beat = this.manoeuvreBeat(t);
    // A pinned shot still *plays* — its move runs to the end — it simply never
    // hands over to the next one. What happens when it gets there is the loop
    // toggle's business: repeat, or hold on the last frame.
    //
    // The clock is the cap, and a beat can bring the cut forward inside the
    // last stretch of it. Cutting as the aeroplane rolls into a turn or levels
    // off reads as motivated; cutting on a timer that happens to expire
    // mid-manoeuvre reads as a timer. Only forward, never later: waiting for a
    // beat that may not come would stretch every unmotivated shot instead, and
    // a tripod's geometry is derived from the length it was given.
    const early = this.elapsed < this.duration && this.beat
      && this.elapsed >= this.duration * BEAT_WINDOW && this.passIsDone();
    if (early) this.beatCutCount++;
    const due = this.elapsed >= this.duration || early;
    if (!this.started || (due && (!this.pinned || this.pending !== null))) {
      this.cut(pos, quat);
    } else if (this.replayRequested
      || (due && this.pinned && this.looping && this.queue === null)) {
      this.replayRequested = false;
      this.elapsed = 0;
      // The eased offset is left where it is on purpose: it glides back to the
      // start of the move rather than jumping there, so a loop reads as a
      // camera coming back round and not as a cut to the same setup.
      if (this.shot.locked) this.plant(this.shot, pos, quat);
    }

    const shot = this.shot;
    const u = clamp(this.elapsed / this.duration, 0, 1);
    // Dollies ease in and out; tracking moves run at constant speed, because a
    // lateral pass that slows to a stop in the middle looks like a mistake.
    const e = shot.linear ? u : smoothstep(0, 1, u);
    const mirror = this.side;

    const tweak = this.tweakFor(shot.name);
    // How much of the written move actually gets made. Everything that travels
    // reads this one number — the dolly, the orbit, the crane's boom and the
    // focal ramp — so at 0 the shot is a still frame and at 2 it sweeps twice
    // as far, and it is the same idea in every shot in the library.
    const move = e * tweak.travel * this.style.travel;

    if (shot.locked) {
      this.position.copy(this.anchor);
      // A crane: planted in the world, but not dead. `anchorMove` booms it
      // across the shot, which is the difference between a locked-off camera
      // and a camera on a jib.
      const boom = shot.anchorMove;
      if (boom !== undefined) {
        // Anchored shots measure everything in landmark heights, the jib too.
        const unit = shot.anchor === 'landmark' && this.tripod !== null
          ? Math.max(this.tripod.height, this.tripod.radius * 1.4, 12) : 1;
        // Played backwards the jib starts at the top of its travel and comes
        // down; `plant` puts the camera there, and this runs the boom the other
        // way from it.
        const way = this.reversed ? -1 : 1;
        this.position.x += boom[0] * unit * mirror * move * way;
        this.position.y += boom[1] * unit * move * way;
        this.position.z += boom[2] * unit * move * way;
      }
    } else if (shot.azimuth !== undefined) {
      // Framed against the world rather than against the aircraft: the camera
      // goes on the far side of the subject from the sun (or from a city), so
      // that thing ends up behind it.
      const af = this.legFrom(shot);
      const at = this.legTo(shot);
      this._from.set(af[0], af[1], af[2]);
      this._to.set(at[0], at[1], at[2]);
      this._from.lerp(this._to, move);

      let dirX = -this.sun.x;
      let dirZ = -this.sun.z;
      if (shot.azimuth === 'landmark' && this.landmark !== null) {
        dirX = pos.x - this.landmark.x;
        dirZ = pos.z - this.landmark.z;
      } else if (shot.azimuth === 'structure' && this.structure !== null) {
        dirX = pos.x - this.structure.x;
        dirZ = pos.z - this.structure.z;
      }
      const len = Math.hypot(dirX, dirZ) || 1;
      // Distance and height are the operator's here as well. The swing is not:
      // where these shots sit is the whole point of them — the sun or the city
      // is behind the subject — so a hand-turned azimuth would just undo it.
      const reach = Math.hypot(this._from.x, this._from.z) * tweak.scale;
      this._from.set((dirX / len) * reach, this._from.y * tweak.scale + tweak.height,
        (dirZ / len) * reach);

      const lag = shot.lag ?? 0;
      if (lag > 0 && this.started) {
        this.offset.lerp(this._from, 1 - Math.exp(-lag * dt));
      } else {
        this.offset.copy(this._from);
      }
      this.position.copy(this.offset).add(pos);
    } else {
      const lf = this.legFrom(shot);
      const lt = this.legTo(shot);
      this._from.set(lf[0] * mirror, lf[1], lf[2]);
      this._to.set(lt[0] * mirror, lt[1], lt[2]);
      this._from.lerp(this._to, move);

      // Reversing a sweep is not the same as negating it.
      //
      // Forwards the camera is at R(orbit*m) applied to lerp(from, to, m).
      // Running that backwards means evaluating it at 1-m, so the rotation has
      // to be orbit*(1-m) — it *starts* a whole sweep round and unwinds. Merely
      // negating the angle starts it at zero, which is where the forward shot
      // began, so the reversed version leapt to the wrong side of the aircraft
      // and retraced nothing: measured, `level orbit` reversed came out 280 m
      // from the path it was supposed to be walking back along.
      const sweep = shot.orbit ?? 0;
      if (sweep) {
        const a = sweep * mirror * (this.reversed ? 1 - move : move);
        const sin = Math.sin(a);
        const cos = Math.cos(a);
        const x = this._from.x * cos - this._from.z * sin;
        const z = this._from.x * sin + this._from.z * cos;
        this._from.set(x, this._from.y, z);
      }

      // The operator's own adjustment: swing round, in or out, up or down.
      if (tweak.azimuth !== 0 || tweak.scale !== 1 || tweak.height !== 0) {
        const c = Math.cos(tweak.azimuth * mirror);
        const sn = Math.sin(tweak.azimuth * mirror);
        const x = this._from.x * c - this._from.z * sn;
        const z = this._from.x * sn + this._from.z * c;
        this._from.set(x * tweak.scale, this._from.y * tweak.scale + tweak.height, z * tweak.scale);
      }

      // Ease the *offset*, not the world position.
      //
      // Lagging the world position looks equivalent and is not: a first-order
      // follow at rate k trailing a target moving at v settles at an error of
      // v/k, and at 230 m/s even a stiff k leaves the camera tens of metres
      // behind — which turned a 26 m close-up into a distant speck. Easing the
      // offset keeps the camera rigid to the aircraft and smooths only the move.
      const lag = shot.lag ?? 0;
      if (lag > 0 && this.started) {
        this.offset.lerp(this._from, 1 - Math.exp(-lag * dt));
      } else {
        this.offset.copy(this._from);
      }

      // Yaw only. Rolling the whole rig with the aircraft makes every shot
      // tumble with it, which reads as a mistake rather than as style.
      this.position.copy(this.offset).applyQuaternion(yawOf(quat, this._q)).add(pos);
    }

    const floor = groundHeight(this.position.x, this.position.z) + 6;
    if (this.position.y < floor) this.position.y = floor;

    const look = shot.look;
    // Lead room. Aiming at the aircraft puts it dead centre, which is the one
    // framing a camera operator never chooses: the subject wants space ahead of
    // it to move into. Aiming *ahead* of the nose pushes it back off centre.
    const lead = shot.lead ?? LEAD[shot.scale];
    this._look
      .set(look ? look[0] * mirror : 0, look ? look[1] : 0, (look ? look[2] : 0) - lead)
      .applyQuaternion(quat)
      .add(pos);

    camera.position.copy(this.position);
    camera.up.set(0, 1, 0);
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
    camera.fov = lerp(this.legFov(shot, 0), this.legFov(shot, 1), clamp(move, 0, 1.6))
      + clamp(t.tas / 400, 0, 1) * 3;
    camera.updateProjectionMatrix();

    this.started = true;
  }

  /**
   * Choose the next setup.
   *
   * The rules, in the order they matter:
   *
   *  1. Work the scale in one direction — wide, medium, close — so a run either
   *     leads the audience in or leads them out, then turn round at the end.
   *  2. Hold the line. Every off-axis shot is mirrored onto the side the phrase
   *     is being worked from, so the aircraft keeps crossing the frame the same
   *     way. The side may only change *after* a neutral shot, which is the
   *     legitimate way to cross the axis.
   *  3. Never the same setup twice running, and never two locked shots in a row
   *     — both of those are "the aircraft flies through frame", and back to back
   *     they read as one botched shot.
   */
  private cut(pos: THREE.Vector3, quat: THREE.Quaternion): void {
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

    // A flourish, at the turn of a run.
    //
    // The end of a traverse is the one place a sharp shot does not interrupt
    // anything: the camera has just finished leading the audience all the way
    // in or all the way out, and the next run is about to start somewhere else
    // anyway. Dropping one in mid-ladder would break the very progression the
    // ladder exists to make.
    this.sinceFlourish++;
    if (turned && this.pending === null && this.sinceFlourish >= FLOURISH_GAP
      && Math.random() < 0.55) {
      const options = SHOTS.filter((sh) => sh.tags?.includes('flourish') === true
        && sh.name !== this.lastName
        && !(sh.locked === true && this.wasLocked)
        // The low pass looks up from under the aircraft; down on the deck that
        // is a shot of the inside of a hill.
        && !(sh.name === 'fly-by low' && this.agl < 320)
        // Framed against something in the world, so it needs the world to be
        // offering something. Without a landmark it is just an odd angle.
        && !(sh.azimuth === 'landmark' && this.landmark === null)
        && !(sh.azimuth === 'structure' && this.structure === null));
      if (options.length > 0) {
        this.sinceFlourish = 0;
        // Not at random out of the whole set: with three candidates and only
        // "not the last one" to go on, the same flourish came up twice running
        // half the time. The ordinary pool has had a memory for a while; this
        // is the same idea, and it is most of what made the punctuation feel
        // repetitive even before there were more shots to choose from.
        const unused = options.filter((sh) => !this.recentFlourishes.includes(sh.name));
        const from = unused.length > 0 ? unused : options;
        const flourish = from[Math.floor(Math.random() * from.length)];
        this.recentFlourishes.unshift(flourish.name);
        if (this.recentFlourishes.length > FLOURISH_MEMORY) {
          this.recentFlourishes.length = FLOURISH_MEMORY;
        }
        // Punctuation, but not an interruption: it still hands its direction on
        // to whatever follows, so the run picks up where the flourish left off.
        this.remember(flourish.name);
        const flourishSwing = swingOf(flourish, false, this.side);
        if (Math.abs(flourishSwing) > SWING_MATTERS) this.lastSwing = flourishSwing;
        this.take(flourish, pos, quat);
        return;
      }
    }

    // An event has asked for something specific — that outranks the ladder.
    if (this.pending !== null) {
      this.take(this.pending, pos, quat);
      this.pending = null;
      return;
    }

    // Whether a landmark tripod has anything to stand on right now, and
    // whether it is the right sort of landmark for a given shot.
    //
    // A hard exclusion rather than a preference. The soft filters below fall
    // back to the whole library when they empty the pool, and an anchored shot
    // that falls through to the ordinary planting reads its offsets in the
    // aircraft's frame instead of the landmark's — the camera ends up in a
    // plausible-looking place with nothing composed in it, which is the kind
    // of failure nobody reports because it merely looks dull.
    const tripod = this.tripodFor(pos, quat);
    const standable = (s: ShotSpec): boolean => {
      if (s.anchor !== 'landmark') return true;
      if (tripod === null) return false;
      return s.anchorKind === undefined || s.anchorKind.includes(tripod.kind);
    };

    let pool = SHOTS.filter(
      (s) => s.scale === want
        && s.name !== this.lastName
        && s.reserved !== true
        && standable(s)
        && !(s.locked && this.wasLocked),
    );


    // Down low, a shot that sits twenty metres under the aircraft is a shot of
    // the inside of a hill — the ground clamp saves it and the framing is lost.
    if (this.agl < 260) {
      const safe = pool.filter((s) => Math.min(s.from[1], s.to[1]) > -10);
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
      pool = SHOTS.filter((s) => s.name !== this.lastName && s.reserved !== true
        && standable(s));
    }

    // Steer toward an on-axis shot if the sequence has been working one side for
    // a while. Left to chance the line is never crossed at all — measured, the
    // camera sat on the same side for twenty-two cuts running, which is faithful
    // to the rule and monotonous. Every scale carries at least one neutral, so
    // this always has something to offer.
    if (this.sinceNeutral >= 5) {
      const neutral = pool.filter((s) => s.side === 0);
      if (neutral.length > 0) pool = neutral;
    }

    // Choose the shot *and* which way round to play it, together.
    //
    // This is where reversal earns its keep. Scored one orientation at a time
    // the library offers whatever it happens to contain; scored both ways it
    // almost always has a version of some shot that carries on the move already
    // in progress — closing when the ladder is closing, and swinging the same
    // way round the aeroplane as the shot before it. That second one is the
    // continuity rule that matters most at a cut: an audience will forgive a
    // jump in distance and will not forgive the camera suddenly swinging back
    // the other way, because that reads as a mistake rather than as an edit.
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
        // Starvation. The two bonuses below stack to 2.2, the random term
        // spans 0.9, and nothing else ever adds — so a shot that neither
        // dollies with the ladder nor sweeps was 1.5 adrift of one that does
        // both, permanently, and simply never came up. Measured over six
        // thousand cuts the long lens was offered fourteen hundred times and
        // dealt none. Growing this until it can cover that gap costs the
        // preferences nothing in the common case, because a shot that is being
        // dealt never accumulates it.
        // The ceiling has to clear the deficit or the guard does not guard: a
        // shot that neither dollies nor sweeps gives up 0.7 on the ladder and
        // 0.8 on the swing, so at a cap of 1.9 the level wides still lost every
        // round — by a median of 0.88, having come as close as 0.05. Only a
        // shot that is genuinely being passed over ever reaches this cap; one
        // in normal rotation sits nearer 0.6 and the preferences below decide
        // it as before.
        const since = this.cutIndex - (this.lastUsedAt.get(candidate.name) ?? -80);
        score += clamp((since - RECENT_MEMORY) * 0.05, 0, 3.4);
        // Move with the ladder, not against it: going down the scale the camera
        // should be closing in, coming back up it should be backing off.
        // The gap between these two is the whole reason a shot lives or dies,
        // and at 2.2 against 0.7 it was lethal: freshness only ever subtracts
        // and the random term spans 0.9, so a shot that holds its distance
        // could not outscore a fresh one that dollies — not once in six
        // thousand cuts, though it was offered fourteen hundred times. Six
        // wides were unreachable that way, the long lens and the level orbit
        // among them. Keeping the gap inside the random spread leaves the
        // ladder a strong preference instead of a rule.
        if (move === wanted) score += 1.4;
        else if (move === 'flat') score += 0.7;
        // Carry the swing on — but only between shots that actually have one.
        //
        // Measured, most of the library barely swings at all: a tail chase or a
        // high astern sweeps under a degree, a side profile nine. Those have no
        // direction worth being faithful to, and scoring them as though they
        // did spent the whole continuity budget on noise — the rate across a
        // long sequence came out at exactly chance. What reads at a cut is the
        // orbits and the fly-bys, which sweep ninety degrees and more.
        //
        // Weighted as a penalty rather than a prize, which is the asymmetry the
        // rule actually calls for: swinging the wrong way is a mistake, and
        // swinging the right way is merely correct. As a prize it was a
        // catastrophe, because only a sweeping shot can ever collect it and a
        // reversible one collects it every time — so the two orbiting wides won
        // 112 of 180 wide slots between them and five other wides, the
        // establishing shot among them, were never dealt once in six hundred
        // cuts. A large bonus available to one part of the library is not a
        // continuity rule, it is a preference for orbits.
        if (Math.abs(this.lastSwing) > SWING_MATTERS && Math.abs(swing) > SWING_MATTERS) {
          score += Math.sign(swing) === Math.sign(this.lastSwing) ? 0.8 : -2.4;
        }
        if (best === null || score > best.score) best = { shot: candidate, reversed, score };
      }
    }

    const pick = best ?? { shot: pool[0], reversed: false };
    // A shot that barely swings leaves the previous direction standing rather
    // than replacing it with its own noise, so a run of small moves between two
    // orbits does not break the thread between them.
    const swung = swingOf(pick.shot, pick.reversed, this.side);
    if (Math.abs(swung) > SWING_MATTERS) this.lastSwing = swung;
    this.remember(pick.shot.name);
    this.take(pick.shot, pos, quat, pick.reversed);
  }

  /** Commit to a shot: duration, side bookkeeping, and planting if it is locked. */
  /**
   * Did a manoeuvre just start or stop?
   *
   * Thresholds come from flying the scenic tour and measuring what it actually
   * does: it holds twenty-odd degrees of bank almost continuously, so "wings
   * level" alone is worth a beat only once every couple of minutes, while
   * levelling off and the g coming off are frequent. Together, on both edges,
   * they land a beat every twelve to eighteen seconds — every third shot or so,
   * which is often enough to be felt and rare enough to stay an accent.
   */
  private manoeuvreBeat(t: Telemetry): boolean {
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
   * Whether a planted shot has had its pass yet.
   *
   * Bringing a cut forward is free for a carried camera and not for a tripod:
   * the whole point of the shot is the aeroplane going past it, and a beat
   * landing before that would cut away from the one thing it was set up for.
   */
  private passIsDone(): boolean {
    const p = this.shot.pass;
    if (p === undefined || this.shot.locked !== true) return true;
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

  private take(shot: ShotSpec, pos: THREE.Vector3, quat: THREE.Quaternion,
    reversed = false): void {
    this.reversed = reversed || this.reverseAll;
    this.shot = shot;
    this.lastName = shot.name;
    this.wasLocked = shot.locked === true;
    this.sinceNeutral = shot.side === 0 ? 0 : this.sinceNeutral + 1;

    const t = this.tweakFor(shot.name);
    const hold = shot.seconds ?? HOLD[shot.scale];
    this.duration = clamp(
      lerp(hold[0], hold[1], Math.random()) * this.style.hold * t.hold, 1.2, 40);
    this.elapsed = 0;

    // Chosen once, at the cut, and held. Relaxed when the operator asked for
    // this shot by hand: the automatic sequencer can afford to wait for a
    // landmark that lines up, but a button press that quietly does something
    // else is worse than a shot composed a little loosely.
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

    if (shot.anchor === 'landmark' && this.tripod !== null) {
      const st = this.tripod;
      // The landmark's own frame: −Z toward the aeroplane, so a shot can ask
      // to stand in front of the tower or behind it without knowing where
      // either of them is.
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
      //
      // Height alone was the first attempt and it is wrong for half of these
      // things. A mast is 400 m tall and a hand wide; a castle is 100 m tall
      // and two hundred across, and standing off by its height put the lens
      // 218 m from a courtyard 200 m wide — the frame was nothing but wall and
      // the aeroplane was behind it. Width counts for a little less than
      // height because a wide thing is usually seen at an angle.
      const bulk = Math.max(st.height, st.radius * 1.4, 12);
      // The climb is the exception: it is up the *thing*, so it goes on the
      // height even when the bulk is coming from the footprint.
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
    const fx = lf[0] * this.side * t.scale;
    // The along-track offset is *when*, not how far away — so the distance
    // knob is left off it deliberately. Scaling it would put the timing drift
    // straight back in through the tuning slider, which is the one thing this
    // is here to remove; how far off to the side the camera stands is what
    // that knob is actually for, and it still applies in full.
    const fz = shot.pass === undefined
      ? lf[2] * t.scale
      : -clamp(this.tas * this.duration * shot.pass, REACH_MIN, REACH_MAX);
    this._from
      .set(fx * c - fz * sn, shot.from[1] * t.scale + t.height,
        fx * sn + fz * c)
      // The ground track, not the whole attitude — the same frame the carried
      // shots use. A planted camera is a tripod: where you put it depends on
      // which way the aeroplane is *going*, not on how its nose happens to be
      // pointing at the instant of the cut. Applying the full quaternion lofted
      // every long offset the moment the jet pitched — six hundred metres ahead
      // became a hundred and forty-five metres up at a fourteen-degree climb,
      // and the ground plate left the ground on rotation.
      .applyQuaternion(yawOf(quat, this._q))
      .add(pos);
    // Backwards, the jib begins at the far end of its own travel.
    const boom = shot.anchorMove;
    if (this.reversed && boom !== undefined) {
      this._from.x += boom[0] * this.side;
      this._from.y += boom[1];
      this._from.z += boom[2];
    }
    this.anchor.copy(this._from);
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * The heading part of an attitude, as a quaternion, into `out`.
 *
 * Camera offsets are given in the aircraft's frame but are meant to be read
 * against its *track*: "off the right wing" and "six hundred ahead" describe
 * places on the ground, and neither should move because the nose came up.
 */
function yawOf(quat: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
  out.copy(quat);
  const yaw = Math.atan2(
    2 * (out.w * out.y + out.x * out.z),
    1 - 2 * (out.y * out.y + out.x * out.x),
  );
  return out.setFromAxisAngle(UP, yaw);
}

/**
 * How the operator has reshaped one shot.
 *
 * The first three say where the camera is. The last two say how it moves, and
 * they are deliberately *not* "speed": a shot is a move from `from` to `to`
 * across its duration, so speed is travel ÷ hold and offering all three would
 * give three sliders that silently fight each other. These two are independent
 * and each does one visible thing.
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
 *
 * Recalling one makes the library match it — the shot's own adjustment is
 * overwritten — because a slot is "put the camera back how I had it", not a
 * separate copy of the shot that could drift from the one in the list.
 */
export interface ShotSlot {
  shot: string;
  tweak: ShotTweak;
}

/**
 * Overall pace, multiplied onto every shot on top of its own adjustment.
 *
 * Most people want the outcome rather than the sliders, and the two numbers
 * that decide whether a sequence feels contemplative or urgent are the same two
 * for every shot in the library.
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
