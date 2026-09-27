import * as THREE from 'three';
import { clamp, damp, lerp } from '../util/math';
import { Cockpit } from './Cockpit';
import type { ControlInputs, Telemetry } from './FlightModel';

/**
 * Exhaust colour from cool to hot.
 *
 * A jet at low power burns close to blue and only goes yellow, then orange, as
 * the throttle comes up and the burner lights. Running the ramp this way round
 * does two jobs at once: it says how much power is on from across the sky, and
 * it lets the low-power plume be genuinely bright without reading as fire —
 * a pale blue glow at the nozzle is what idle looks like.
 *
 * Interpolated in RGB. Sweeping HSL hue from cyan to yellow takes the long way
 * round, through green, and a green exhaust is a coolant leak.
 */
const PLUME_RAMP: { at: number; r: number; g: number; b: number }[] = [
  { at: 0.00, r: 0.22, g: 0.62, b: 1.00 }, // idle: cold blue
  { at: 0.35, r: 0.42, g: 0.86, b: 1.00 }, // cyan
  { at: 0.65, r: 0.90, g: 0.94, b: 0.92 }, // the changeover, near white
  { at: 0.95, r: 1.00, g: 0.78, b: 0.30 }, // military: yellow
  { at: 1.25, r: 1.00, g: 0.47, b: 0.16 }, // burner lit: orange
  { at: 1.75, r: 1.00, g: 0.26, b: 0.11 }, // full burner: deep orange-red
];

function plumeColour(heat: number, into: THREE.Color): void {
  const last = PLUME_RAMP.length - 1;
  if (heat <= PLUME_RAMP[0].at) {
    into.setRGB(PLUME_RAMP[0].r, PLUME_RAMP[0].g, PLUME_RAMP[0].b);
    return;
  }
  for (let i = 1; i <= last; i++) {
    const b = PLUME_RAMP[i];
    if (heat > b.at && i !== last) continue;
    const a = PLUME_RAMP[i - 1];
    const t = clamp((heat - a.at) / (b.at - a.at), 0, 1);
    into.setRGB(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
    return;
  }
}

/**
 * Procedurally-built F/A-18-style airframe.
 *
 * Everything is generated in code (no external model), which keeps the build
 * self-contained. Control surfaces are separate meshes parented to hinge pivots
 * so they can be deflected with the actual control inputs, and the exhaust
 * plumes scale and flicker with afterburner level.
 */
export class Aircraft {
  readonly root = new THREE.Group();
  /**
   * Pilot eye point in body space, for the cockpit camera.
   *
   * Has to sit *inside* the canopy, which is less obvious than it sounds: the
   * old value put the eye 9 cm above the glass, so the pilot was flying along
   * on top of his own canopy looking down at it.
   */
  readonly eyePoint = new THREE.Vector3(0, 1.02, -3.75);
  readonly cockpit: Cockpit;
  /** Head and shoulders in the cockpit, hidden when you are the head. */
  private readonly pilot: THREE.Group;

  private readonly hinges: {
    leftStab: THREE.Group;
    rightStab: THREE.Group;
    leftAileron: THREE.Group;
    rightAileron: THREE.Group;
    leftRudder: THREE.Group;
    rightRudder: THREE.Group;
  };

  private readonly plumes: THREE.Mesh[] = [];
  private readonly burnerLight: THREE.PointLight;
  private flicker = 0;

  /** Gear pivots, with the axis and direction each one retracts along. */
  private readonly gearLegs: { pivot: THREE.Group; axis: 'x' | 'z'; retracted: number }[] = [];

  constructor(private readonly gearHeight = 2.4) {
    const skin = new THREE.MeshStandardMaterial({
      color: 0x8d949c,
      metalness: 0.62,
      roughness: 0.42,
      envMapIntensity: 1.1,
    });
    // Control surfaces are a shade darker than the skin so deflection reads at a
    // glance, but close enough that they don't look like detached panels.
    const darkSkin = new THREE.MeshStandardMaterial({
      color: 0x6b727a,
      metalness: 0.68,
      roughness: 0.4,
    });
    const hotMetal = new THREE.MeshStandardMaterial({
      color: 0x24262a,
      metalness: 1.0,
      roughness: 0.28,
    });
    // Transparent, and drawn without writing depth: from outside it reads as a
    // tinted bubble with the cockpit visible through it, and from inside the
    // front faces are culled so it never fogs the pilot's view.
    const glass = new THREE.MeshStandardMaterial({
      color: 0x35506d,
      metalness: 0.85,
      roughness: 0.10,
      envMapIntensity: 2.6,
      transparent: true,
      opacity: 0.44,
      depthWrite: false,
    });

    // --- Fuselage: a lathe profile, flattened into a fighter cross-section. ---
    const profile: [number, number][] = [
      [-9.2, 0.02], [-8.6, 0.18], [-7.8, 0.36], [-6.8, 0.55], [-5.4, 0.72],
      [-3.4, 0.86], [-1.4, 0.95], [0.6, 0.97], [2.6, 0.95], [4.6, 0.88],
      [6.2, 0.78], [7.4, 0.70], [8.0, 0.68],
    ];
    const fuselageGeo = new THREE.LatheGeometry(
      profile.map(([y, r]) => new THREE.Vector2(r, y)),
      36,
    );
    fuselageGeo.rotateX(Math.PI / 2); // lathe axis Y -> +Z, so the nose faces -Z
    fuselageGeo.scale(1.22, 0.82, 1); // wider than tall, like a real fighter section
    const fuselage = new THREE.Mesh(fuselageGeo, skin);
    this.root.add(fuselage);

    // --- Leading-edge extensions: the strakes that define the Hornet's nose. ---
    for (const side of [1, -1]) {
      const lex = new THREE.Mesh(panel({ span: 1.15, rootChord: 6.4, tipChord: 2.0, sweep: 2.6, thickness: 0.16, taper: 0.45 }), skin);
      lex.scale.x = side;
      lex.position.set(side * 0.95, 0.24, -2.2);
      this.root.add(lex);
    }

    // --- Main wings, with a hinged aileron on each trailing edge. ------------
    this.hinges = {} as typeof this.hinges;
    for (const side of [1, -1]) {
      const wing = new THREE.Mesh(
        panel({ span: 5.1, rootChord: 4.5, tipChord: 1.5, sweep: 2.0, thickness: 0.24, taper: 0.22 }),
        skin,
      );
      wing.scale.x = side;
      wing.position.set(side * 1.2, 0.05, 1.1);
      this.root.add(wing);

      const hinge = new THREE.Group();
      hinge.position.set(side * 4.2, 0.05, 2.55);
      const aileron = new THREE.Mesh(
        panel({ span: 2.0, rootChord: 1.15, tipChord: 0.75, sweep: 0.35, thickness: 0.11, taper: 0.5 }),
        darkSkin,
      );
      aileron.scale.x = side;
      aileron.position.z = 0.5;
      hinge.add(aileron);
      this.root.add(hinge);
      if (side === 1) this.hinges.rightAileron = hinge;
      else this.hinges.leftAileron = hinge;
    }

    // --- All-moving horizontal stabilators. ---------------------------------
    //
    // The hinge sits *inside* the fuselage skin. It used to be at x = 1.3, and
    // the body is only 0.94 wide there — so the root hung 30 cm clear of the
    // aircraft and the stabilator read as a loose slab flying in formation.
    // Mounting it inboard also fixes the span, which was 7.6 m against the real
    // aircraft's 6.6.
    for (const side of [1, -1]) {
      const hinge = new THREE.Group();
      hinge.position.set(side * STAB_ROOT_X, -0.06, 6.1);
      const stab = new THREE.Mesh(
        panel({ span: 2.5, rootChord: 2.6, tipChord: 0.95, sweep: 1.8, thickness: 0.13, taper: 0.3 }),
        skin,
      );
      stab.scale.x = side;
      hinge.add(stab);
      this.root.add(hinge);
      if (side === 1) this.hinges.rightStab = hinge;
      else this.hinges.leftStab = hinge;
    }

    // --- Canted twin tails, each with a full-height rudder. -----------------
    for (const side of [1, -1]) {
      // The fin group carries the outward cant and the rudder hangs inside it,
      // so the rudder inherits that cant instead of needing to be positioned in
      // airframe space to match a rotation it doesn't know about.
      //
      // The root is buried in the upper fuselage rather than floating beside it:
      // the skin at this station is 0.46 high at x = 0.86, and the old mount put
      // the root at y = 0.5 outboard of the section altogether.
      const finGroup = new THREE.Group();
      finGroup.position.set(side * FIN_ROOT_X, FIN_ROOT_Y, FIN_ROOT_Z);
      // Rotating about +Z by +θ carries a point that is straight up toward −X,
      // so `side * 0.35` leaned the right fin *inboard*: the pair met over the
      // spine in a Λ and the right rudder's tip measured out at x = 0.10, all
      // but on the centreline. The Hornet's fins splay outward into a V.
      finGroup.rotation.z = -side * 0.35; // ~20° out, as on the real aircraft

      const fin = new THREE.Mesh(
        panel({
          span: FIN.span, rootChord: FIN.rootChord, tipChord: FIN.tipChord,
          sweep: FIN.sweep, thickness: 0.11, taper: 0.4,
        }),
        skin,
      );
      // +90° about Z maps the span axis +X onto +Y, standing the panel upright.
      fin.geometry.rotateZ(Math.PI / 2);
      finGroup.add(fin);

      // The rudder is the whole trailing edge of the fin, hinged on its 70%
      // chord line — not a small tab near the tip. Its planform is *derived*
      // from the fin's, so the two cannot drift out of register: the old pair
      // were written as independent numbers and the rudder ended up buried
      // inside the fin at the root and poking out of it at the top.
      const r = rudderOf(FIN);
      const hinge = new THREE.Group();
      hinge.position.set(0, r.rootY, r.hingeZ);
      const rudder = new THREE.Mesh(
        panel({
          span: r.span, rootChord: r.rootChord, tipChord: r.tipChord,
          sweep: r.sweep, thickness: 0.085, taper: 0.55,
        }),
        darkSkin,
      );
      rudder.geometry.rotateZ(Math.PI / 2);
      rudder.position.z = r.rootChord / 2; // hinge on its leading edge
      hinge.add(rudder);
      finGroup.add(hinge);

      this.root.add(finGroup);
      if (side === 1) this.hinges.rightRudder = hinge;
      else this.hinges.leftRudder = hinge;
    }

    // --- Canopy. -------------------------------------------------------------
    const canopyGeo = new THREE.SphereGeometry(1, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.5);
    // The canopy has to sit *on* the fuselage, not inside it. At this station
    // the body is already 0.69 m tall, so a sill any lower buries the glass and
    // leaves the pilot's eye barely a hand's width above the nose — which is
    // exactly what the first version looked like from inside.
    canopyGeo.scale(0.60, 0.72, 2.15);
    const canopy = new THREE.Mesh(canopyGeo, glass);
    canopy.position.set(0, 0.60, -3.9);
    this.root.add(canopy);

    // --- Engine bays and nozzles. -------------------------------------------
    //
    // The nozzles used to be bare open-ended tubes, and an open tube's inner
    // wall faces away from a camera behind the aircraft — so it was culled, and
    // you looked straight through the engines at the sea. From astern the
    // aircraft appeared to be missing the underside of both engines. Each one
    // is now a bay, a nozzle with an inside, and a turbine face that stops the
    // view through it.
    const exhaust = new THREE.MeshStandardMaterial({
      color: 0x14161a,
      metalness: 0.9,
      roughness: 0.55,
      side: THREE.BackSide, // seen from behind: this is the inner wall
    });
    const turbine = new THREE.MeshStandardMaterial({
      color: 0x0b0c0e,
      metalness: 1.0,
      roughness: 0.4,
    });

    for (const side of [1, -1]) {
      // The bay: the engine body itself, filling the space between the wing
      // root and the nozzle that the lathe fuselage alone does not.
      const bayGeo = new THREE.CylinderGeometry(0.58, 0.54, 4.2, 18);
      bayGeo.rotateX(Math.PI / 2);
      const bay = new THREE.Mesh(bayGeo, skin);
      bay.position.set(side * 0.62, -0.04, 5.4);
      this.root.add(bay);

      const nozzleGeo = new THREE.CylinderGeometry(0.52, 0.42, 1.5, 20, 1, true);
      nozzleGeo.rotateX(Math.PI / 2);
      const nozzle = new THREE.Mesh(nozzleGeo, hotMetal);
      nozzle.position.set(side * 0.62, 0, 7.9);
      this.root.add(nozzle);

      // The same tube again, a shade smaller and inside out.
      const linerGeo = new THREE.CylinderGeometry(0.50, 0.40, 1.5, 20, 1, true);
      linerGeo.rotateX(Math.PI / 2);
      const liner = new THREE.Mesh(linerGeo, exhaust);
      liner.position.set(side * 0.62, 0, 7.88);
      this.root.add(liner);

      // The turbine face, closing the far end so there is no sky up the pipe.
      const face = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20), turbine);
      face.position.set(side * 0.62, 0, 7.16);
      this.root.add(face);

      // ConeGeometry puts its apex at +Y. Rotating +90° about X sends that apex
      // to +Z (aft), so the plume is widest at the nozzle and tapers to a point
      // behind the aircraft — the other way round reads as a solid cone.
      const plumeGeo = new THREE.ConeGeometry(0.46, 6.0, 18, 1, true);
      plumeGeo.rotateX(Math.PI / 2);
      plumeGeo.translate(0, 0, 3.0);
      const plume = new THREE.Mesh(
        plumeGeo,
        new THREE.MeshBasicMaterial({
          // Set every frame from the ramp; this is only what it looks like
          // before the first update.
          color: 0x6fb4ff,
          transparent: true,
          opacity: 0.0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      plume.position.set(side * 0.62, 0, 8.4);
      this.plumes.push(plume);
      this.root.add(plume);
    }

    this.burnerLight = new THREE.PointLight(0xff7a30, 0, 60, 2);
    this.burnerLight.position.set(0, 0, 9.5);
    this.root.add(this.burnerLight);

    this.buildLandingGear();

    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });

    // --- The pilot. ----------------------------------------------------------
    //
    // Helmet, visor and shoulders, sized against the eye point the cockpit
    // camera uses, so the head sits where the pilot's head actually is. Hidden
    // in the cockpit view for the obvious reason: nobody sees their own head.
    this.pilot = new THREE.Group();
    const flightSuit = new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.85 });
    const helmetSkin = new THREE.MeshStandardMaterial({ color: 0xd8dbe0, roughness: 0.45 });
    const visorGlass = new THREE.MeshStandardMaterial({
      color: 0x14181f,
      metalness: 0.95,
      roughness: 0.12,
      envMapIntensity: 1.6,
    });

    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.20, 20, 16), helmetSkin);
    helmet.position.set(0, this.eyePoint.y - 0.05, this.eyePoint.z - 0.02);
    this.pilot.add(helmet);

    // A band across the front of the helmet, not a second sphere: a visor is a
    // shell, and at this size a full sphere just makes the head look wet.
    const visorGeo = new THREE.SphereGeometry(0.206, 20, 12, Math.PI * 0.80, Math.PI * 1.40,
      Math.PI * 0.30, Math.PI * 0.30);
    const visor = new THREE.Mesh(visorGeo, visorGlass);
    visor.position.copy(helmet.position);
    this.pilot.add(visor);

    // Shoulders and chest, tapering down into the seat.
    const torsoGeo = new THREE.CylinderGeometry(0.24, 0.30, 0.50, 16);
    const torso = new THREE.Mesh(torsoGeo, flightSuit);
    torso.position.set(0, this.eyePoint.y - 0.40, this.eyePoint.z + 0.20);
    torso.rotation.x = -0.16; // leaning back, as the seat is
    this.pilot.add(torso);

    // Shoulders proud of the sill — without them the helmet reads as a ball
    // balanced on a stick rather than as somebody sitting in the aeroplane.
    for (const side of [1, -1]) {
      const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 12), flightSuit);
      shoulder.position.set(side * 0.215, this.eyePoint.y - 0.26, this.eyePoint.z + 0.16);
      this.pilot.add(shoulder);
    }

    // The seat's headrest, closing the gap behind the helmet.
    const headrest = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.30, 0.16), flightSuit);
    headrest.position.set(0, this.eyePoint.y - 0.06, this.eyePoint.z + 0.34);
    this.pilot.add(headrest);
    this.root.add(this.pilot);

    // Added after the shadow pass above, because the interior must not cast.
    this.cockpit = new Cockpit(this.eyePoint);
    this.root.add(this.cockpit.root);
    this.setCockpitVisible(false);
  }

  /**
   * Show or hide the interior. It is only ever seen from the eye point, and
   * leaving it on in the outside views puts a coaming through the fuselage.
   */
  setCockpitVisible(on: boolean): void {
    this.cockpit.root.visible = on;
    this.pilot.visible = !on;
  }

  /**
   * Tricycle gear. Each leg lives under a pivot at its attachment point so
   * retraction is a single rotation: nose gear forward, mains inboard.
   */
  private buildLandingGear(): void {
    const strutMat = new THREE.MeshStandardMaterial({
      color: 0xa6acb2, metalness: 0.9, roughness: 0.3,
    });
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.88 });

    const makeLeg = (pivotY: number, wheelRadius: number, wheelWidth: number): THREE.Group => {
      const leg = new THREE.Group();
      // Put the bottom of the tyre exactly on the ground plane the model uses.
      const wheelY = -(this.gearHeight - wheelRadius) - pivotY;
      const strutLength = Math.abs(wheelY);

      const strut = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.13, strutLength, 10),
        strutMat,
      );
      strut.position.y = wheelY / 2;
      leg.add(strut);

      const wheelGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 18);
      wheelGeo.rotateZ(Math.PI / 2); // axle across the airframe
      const wheel = new THREE.Mesh(wheelGeo, tyreMat);
      wheel.position.y = wheelY;
      leg.add(wheel);

      return leg;
    };

    // Nose gear, retracting forward.
    const nosePivot = new THREE.Group();
    nosePivot.position.set(0, -0.5, -5.0);
    nosePivot.add(makeLeg(-0.5, 0.32, 0.24));
    this.root.add(nosePivot);
    this.gearLegs.push({ pivot: nosePivot, axis: 'x', retracted: Math.PI / 2 });

    // Main gear, retracting inboard toward the fuselage.
    for (const side of [1, -1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 1.5, -0.45, 1.4);
      pivot.add(makeLeg(-0.45, 0.42, 0.3));
      this.root.add(pivot);
      this.gearLegs.push({ pivot, axis: 'z', retracted: -side * (Math.PI / 2) });
    }
  }

  /** 1 = down and locked, 0 = fully retracted. */
  private setGear(extension: number): void {
    for (const leg of this.gearLegs) {
      leg.pivot.rotation[leg.axis] = leg.retracted * (1 - extension);
      leg.pivot.visible = extension > 0.02;
    }
  }

  /** Deflect surfaces and drive the exhaust from the current control state. */
  update(dt: number, controls: ControlInputs, telemetry: Telemetry): void {
    this.setGear(controls.gearExtension);
    if (this.cockpit.root.visible) this.cockpit.update(dt, controls, telemetry);

    const MAX = 0.42; // ~24° of surface travel

    // Stabilators move together for pitch and differentially for roll assist.
    const pitchDeflect = -controls.elevator * MAX;
    const rollDiff = controls.aileron * 0.18;
    this.hinges.rightStab.rotation.x = pitchDeflect - rollDiff;
    this.hinges.leftStab.rotation.x = pitchDeflect + rollDiff;

    // Ailerons oppose each other: right stick drops the left aileron.
    this.hinges.rightAileron.rotation.x = controls.aileron * MAX;
    this.hinges.leftAileron.rotation.x = -controls.aileron * MAX;

    this.hinges.rightRudder.rotation.y = -controls.rudder * MAX;
    this.hinges.leftRudder.rotation.y = -controls.rudder * MAX;

    // Exhaust. An engine with power on it is burning fuel and shows it: there
    // is always a core once the throttle is off its stop, faint at idle and
    // growing with power, with the afterburner's long flickering plume on top.
    // Only a shut-down engine shows nothing at all. The *light* still keys off
    // the burner alone, so cruising does not wash the airframe in orange.
    this.flicker = damp(this.flicker, 0.75 + Math.random() * 0.5, 22, dt);
    const ab = telemetry.afterburner;
    const power = clamp(controls.throttle, 0, 1);
    // Bright enough to actually see. This used to peak at 0.064 opacity at full
    // military power, which additive blending over daylit terrain swallows
    // whole — the engines only appeared to be running once the afterburner lit,
    // and everything below that looked like a glider. The old figure was chosen
    // to keep it from reading as a spotlight; the answer to that is the colour
    // below, not making it invisible.
    const core = power <= 0.01 ? 0 : 0.11 + power * 0.28;
    // The burner adds far less than it used to relative to the core, because
    // the core is where the missing five-sixths of this went. What separates
    // afterburner from military here is length and colour — a plume three
    // times as long, in deep orange, with the burner light behind it — not
    // opacity, and pushing opacity too was blowing the whole tail out to white
    // in any close shot.
    const strength = core + ab * 0.14;
    // How hot the plume is being asked to look. Military power tops out around
    // 1, and the afterburner carries it past that into the reds.
    const heat = power + ab * 0.75;

    for (const plume of this.plumes) {
      const mat = plume.material as THREE.MeshBasicMaterial;
      mat.opacity = strength * this.flicker;
      plumeColour(heat, mat.color);
      const spread = 0.34 + power * 0.16 + ab * 0.45;
      plume.scale.set(spread, spread, 0.12 + power * 0.36 + ab * 0.8 * this.flicker);
    }
    this.burnerLight.intensity = ab * 800 * this.flicker;
  }

  /** Apply an interpolated pose from the fixed-step physics state. */
  setPose(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    this.root.position.copy(position);
    this.root.quaternion.copy(quaternion);
  }
}

/**
 * Where the tail surfaces attach.
 *
 * Every one of these is chosen against the fuselage lathe: the body is an
 * ellipse of semi-axes 1.22r by 0.82r at each station, and a root outside that
 * ellipse is a part floating in mid-air, which is exactly what the first version
 * looked like.
 */
const STAB_ROOT_X = 0.82;
const FIN_ROOT_X = 0.86;
const FIN_ROOT_Y = 0.28;
const FIN_ROOT_Z = 4.0;

/** Vertical fin planform. Low and long-chorded, like the real one. */
const FIN = { span: 2.05, rootChord: 3.0, tipChord: 1.4, sweep: 1.7 };
/** Fraction of the fin's chord ahead of the rudder hinge line. */
const RUDDER_HINGE = 0.70;

/**
 * Derive a rudder that occupies the fin's trailing edge exactly.
 *
 * `panel` centres each chord on its own origin, so the rudder's planform has to
 * be worked out from the fin's: the hinge line runs at a constant fraction of a
 * chord that is itself shrinking and sweeping aft, which makes the rudder's own
 * sweep different from the fin's.
 */
function rudderOf(fin: { span: number; rootChord: number; tipChord: number; sweep: number }) {
  // Stop just short of the root and the tip, as the real surface does.
  const t0 = 0.05;
  const t1 = 0.97;
  const chord = (t: number): number => fin.rootChord + t * (fin.tipChord - fin.rootChord);
  // Hinge line, measured aft from the chord centre.
  const hinge = (t: number): number => t * fin.sweep + chord(t) * (RUDDER_HINGE - 0.5);
  const behind = (t: number): number => (1 - RUDDER_HINGE) * chord(t);

  const rootChord = behind(t0);
  const tipChord = behind(t1);
  return {
    rootY: t0 * fin.span,
    hingeZ: hinge(t0),
    span: (t1 - t0) * fin.span,
    rootChord,
    tipChord,
    // Sweep of the rudder's own chord centres, relative to its root.
    sweep: hinge(t1) + tipChord / 2 - (hinge(t0) + rootChord / 2),
  };
}

/**
 * A swept, tapered lifting surface lying in the XZ plane (+X spanwise, +Z aft),
 * with rounded edges. Used for wings, strakes, stabilators, fins and rudders.
 */
function panel(opts: {
  span: number;
  rootChord: number;
  tipChord: number;
  sweep: number;
  thickness: number;
  /**
   * Thickness at the tip, as a fraction of the root's. A flying surface is not
   * a slab: its section thins as the chord shortens, and extruding one constant
   * depth across the whole planform is what made the wing read as a plank with
   * a sharpened edge rather than as a wing.
   */
  taper?: number;
}): THREE.ExtrudeGeometry {
  const { span, rootChord, tipChord, sweep, thickness } = opts;

  // Planform drawn in XY (y = aft), then rotated so the extrusion becomes thickness.
  const shape = new THREE.Shape();
  shape.moveTo(0, -rootChord / 2);
  shape.lineTo(span, -tipChord / 2 + sweep);
  shape.lineTo(span, tipChord / 2 + sweep);
  shape.lineTo(0, rootChord / 2);
  shape.closePath();

  const bevel = Math.min(thickness * 0.3, 0.05);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 1,
  });
  geo.translate(0, 0, -thickness / 2);
  // Extrusion axis Z becomes thickness, and the planform's Y becomes +Z (aft).
  //
  // The sign matters and was wrong: rotating by −π/2 sends planform +Y to *−Z*,
  // which swept every surface on the aircraft — wings, strakes, stabilators,
  // fins — forward instead of aft. It showed up as the ailerons floating in
  // clear air, because they sit where an aft-swept trailing edge would be and
  // the wing's trailing edge had raked the other way.
  geo.rotateX(Math.PI / 2);

  // Now thin it out toward the tip. After the rotation the thickness axis is Y
  // and the span is X, so this is one pass over the vertices. The curve is
  // deliberately not linear: real sections hold most of their depth over the
  // inboard half and lose it quickly outboard, which is what gives a wing its
  // drawn-out look from the side.
  const tipScale = opts.taper ?? 0.34;
  const position = geo.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const t = clamp(Math.abs(position.getX(i)) / Math.max(span, 0.001), 0, 1);
    position.setY(i, position.getY(i) * lerp(1, tipScale, Math.pow(t, 1.35)));
  }
  position.needsUpdate = true;
  geo.computeVertexNormals(); // the section changed; the old normals are a lie
  return geo;
}
