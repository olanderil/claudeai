/**
 * The parts of an input device the control laws actually read. Declared
 * structurally so a neutral stick — the attract-mode flight, a test harness —
 * can be handed in without standing up a whole `Input`.
 */
export interface StickInput {
  pitch: number;
  roll: number;
  yaw: number;
  throttleAxis: number;
  brake: boolean;
}
import type { ControlInputs, Telemetry, AircraftConfig } from './FlightModel';
import { DEG, clamp, lerp, moveTowards, smoothstep } from '../util/math';

export type FlightMode = 'manual' | 'cruise';

/** Pilot-adjustable handling, bound to the Controls tab. */
export interface ControlSettings {
  pitchSensitivity: number;
  rollSensitivity: number;
  rudderSensitivity: number;
  /** Bank angle commanded at full roll deflection, degrees. */
  maxBankDeg: number;
  assists: boolean;
  mode: FlightMode;
}

export const DEFAULT_SETTINGS: ControlSettings = {
  pitchSensitivity: 1,
  rollSensitivity: 1,
  rudderSensitivity: 1,
  maxBankDeg: 75,
  assists: true,
  mode: 'manual',
};

/**
 * Turns raw input into control-surface deflections.
 *
 * With assists on the pitch axis is a **load-factor command system**: the stick
 * asks for a g loading and one damped loop drives the elevator to achieve it.
 * That single loop replaces what used to be four separate pieces — turn sustain,
 * auto-trim, an alpha limiter and a G limiter — each clamping or gating the same
 * elevator signal. Layering them meant they fought each other, and any limiter
 * built as an on/off gate (`elevator *= 1 - …`) switches in and out against the
 * surface slew rate and buzzes the nose up and down. Expressing the limits as
 * bounds on the *command* instead of gates on the *output* removes that whole
 * class of oscillation.
 *
 * Useful properties that fall out of the load-factor formulation:
 *   - Neutral stick commands 1 g, which holds the current flight path — so the
 *     aircraft keeps a climb or a descent hands-off, with no trim integrator.
 *   - A banked turn needs 1/cos(bank) g, so adding that to the command sustains
 *     turns automatically instead of needing a separate loop.
 *   - Structural and alpha limits are just clamps on the commanded g.
 *
 * Roll input commands a bank angle rather than a roll rate, ramping while held,
 * so holding longer banks further and turns harder.
 *
 * The assists only ever move the stick — they never bypass the flight model.
 */
export class Controls implements ControlInputs {
  elevator = 0;
  /** 0 on the runway, 1 once clear of the takeoff. See `update`. */
  private takeoffGate = 0;
  aileron = 0;
  rudder = 0;
  throttle = 0;
  brake = false;
  gearExtension = 1;

  readonly settings: ControlSettings = { ...DEFAULT_SETTINGS };
  gearDown = true;

  /** Bank angle the pilot is currently asking for, radians. */
  private commandedBank = 0;
  /** Integral term of the load-factor loop. */
  private pitchIntegral = 0;
  /** Latched while unloading out of an alpha excursion. */
  private alphaRecovering = false;
  /** Rate-limited load-factor command actually fed to the loop. */
  private loadCommand = 1;
  /** Altitude captured for cruise mode to hold, metres. */
  private holdAltitude = 0;

  constructor(private readonly config: AircraftConfig) {}

  get assists(): boolean {
    return this.settings.assists;
  }
  set assists(v: boolean) {
    this.settings.assists = v;
  }

  get mode(): FlightMode {
    return this.settings.mode;
  }

  /** Switch flight mode, capturing the current altitude when engaging cruise. */
  setMode(mode: FlightMode, telemetry: Telemetry): void {
    this.settings.mode = mode;
    if (mode === 'cruise') {
      this.settings.assists = true;
      this.holdAltitude = telemetry.altitude;
    }
  }

  update(dt: number, input: StickInput, t: Telemetry): void {
    const s = this.settings;

    this.throttle = clamp(this.throttle + input.throttleAxis * THROTTLE_RATE * dt, 0, 1);
    this.brake = input.brake;

    const commanded = this.gearDown || t.onGround ? 1 : 0;
    this.gearExtension = moveTowards(this.gearExtension, commanded, GEAR_RATE * dt);

    // How far through the takeoff the aircraft is: 0 on the runway, 1 once it
    // is properly airborne. Keyed to height gained and *monotonic* — it only
    // re-arms by touching down again — so flying low over terrain later, where
    // full authority is exactly what you want, is unaffected.
    this.takeoffGate = t.onGround
      ? 0
      : Math.max(this.takeoffGate, smoothstep(GATE_AGL_LO, GATE_AGL_HI, t.agl));

    const pitchInput = clamp(input.pitch * s.pitchSensitivity, -1, 1);
    // Rotation, not a snap. On the runway the assists are off and the stick
    // drives the stabilators raw, so holding it back put them at 100% of travel
    // — the tailplanes visibly flapping — and the aircraft left the ground at
    // 84°/s, reaching 38° nose-up three seconds later.
    // The damper is what actually makes it a rotation: stick against pitch rate
    // settles at a rate rather than winding the nose up as fast as the surface
    // can drive it. Cutting authority alone did not do it — the aircraft still
    // rotated at 22°/s and was pulling 3.5 g before the wheels left.
    let elevatorTarget = pitchInput * lerp(GROUND_AUTHORITY, 1, this.takeoffGate)
      - t.pitchRate * lerp(GROUND_PITCH_DAMP, 0, this.takeoffGate);
    let aileronTarget = clamp(input.roll * s.rollSensitivity, -1, 1);
    let rudderTarget = clamp(input.yaw * s.rudderSensitivity, -1, 1);

    if (s.assists && !t.onGround) {
      // Elevator effectiveness rises with dynamic pressure, so gains tuned at
      // cruise become effectively high-gain at speed. Scheduling on a
      // reference-to-actual pressure ratio keeps the loop's authority — and so
      // its stability margin — roughly constant across the envelope.
      const qScale = clamp((GAIN_REF_IAS / Math.max(t.ias, 60)) ** 2, 0.15, 1.4);

      // --- Bank command ------------------------------------------------------
      const maxBank = s.maxBankDeg * DEG;
      const desiredBank = -input.roll * s.rollSensitivity * maxBank;
      this.commandedBank = moveTowards(
        this.commandedBank,
        clamp(desiredBank, -maxBank, maxBank),
        BANK_RATE * dt,
      );
      aileronTarget = clamp(
        (t.bank - this.commandedBank) * BANK_P - t.rollRate * BANK_D,
        -0.95,
        0.95,
      );

      // --- Commanded load factor --------------------------------------------
      // Level flight in a bank already costs 1/cos(bank) g, so folding that in
      // sustains the turn without a dedicated loop.
      const cosBank = Math.max(0.15, Math.abs(Math.cos(t.bank)));
      let loadCommand = 1 / cosBank;

      loadCommand +=
        pitchInput >= 0 ? pitchInput * (N_MAX - 1) : pitchInput * (1 - N_MIN);

      if (s.mode === 'cruise') {
        if (Math.abs(pitchInput) < 0.05) {
          const altError = this.holdAltitude - t.altitude;
          loadCommand += clamp(altError * ALT_P - t.verticalSpeed * ALT_D, -0.6, 0.6);
        } else {
          this.holdAltitude = t.altitude;
        }
      }

      // Angle-of-attack protection, as a limit on the command rather than a gate
      // on the output: the extra g above 1 is faded out as alpha approaches the
      // stall, so the aircraft runs up against the limit smoothly.
      const aoaLimit = this.config.alphaStall * 0.9;
      const alphaHeadroom = 1 - smoothstep(aoaLimit * 0.75, aoaLimit, t.alpha);
      if (loadCommand > 1) loadCommand = 1 + (loadCommand - 1) * alphaHeadroom;

      // Past the limit, command *less* than 1 g. Holding 1 g needs more and more
      // alpha as the aircraft slows, so merely capping the extra g still lets it
      // mush deeper into the stall; unloading is what brings alpha back.
      //
      // Latched with hysteresis rather than triggered on a bare threshold: an
      // ordinary threshold releases the moment alpha dips back across it, which
      // chatters the command. This unloads decisively and holds until alpha has
      // genuinely recovered.
      if (t.alpha > aoaLimit) this.alphaRecovering = true;
      else if (t.alpha < aoaLimit * 0.72) this.alphaRecovering = false;
      if (this.alphaRecovering) loadCommand = Math.min(loadCommand, 0.55);

      // The g available climbs back to the full envelope as the aircraft gets
      // off the deck. Without this the load loop switched in at the instant of
      // unstick commanding the full 7 g, which is what put the nose 38° up
      // before the gear was even retracted. The limit is gone by 140 ft, so
      // nothing about the climb after that changes.
      loadCommand = Math.min(loadCommand, lerp(N_ROTATE, N_MAX, this.takeoffGate));
      loadCommand = clamp(loadCommand, N_MIN, N_MAX);

      // Limit how fast the commanded g may change. Real aircraft have a g-onset
      // limit anyway, and here it also means the alpha protection engaging or
      // releasing eases the command across rather than snapping it, which is
      // what turned that transition into a porpoise.
      this.loadCommand = moveTowards(this.loadCommand, loadCommand, LOAD_ONSET_RATE * dt);

      // --- Load-factor loop --------------------------------------------------
      const loadError = this.loadCommand - t.loadFactor;
      this.pitchIntegral = clamp(
        this.pitchIntegral + loadError * PITCH_I * qScale * dt,
        -0.7,
        0.9,
      );
      // The rate term is a pitch damper and is always active — it is what stops
      // the loop chasing its own lag into an oscillation.
      elevatorTarget = clamp(
        loadError * PITCH_P * qScale + this.pitchIntegral - t.pitchRate * PITCH_D * qScale,
        -1,
        1,
      );

      // --- Turn coordination -------------------------------------------------
      // Rudder carries the same sign as beta: positive beta (relative wind from
      // the right) needs nose-right rudder to swing the nose onto the velocity
      // vector, matching the natural weathervane term. No yaw-rate damping —
      // unwashed rate feedback fights a steady turn and settles into exactly the
      // standing sideslip it is meant to remove.
      if (Math.abs(input.yaw) < 0.05) {
        rudderTarget = clamp(t.beta * 2.5, -0.6, 0.6);
      }
    } else {
      this.commandedBank = 0;
      this.pitchIntegral = 0;
      this.alphaRecovering = false;
      // Hand the loop over already matched to what the aircraft is doing.
      // Parking this at 1 g meant that at the instant of unstick — where the
      // rotation has the aircraft pulling 3.5 g — the loop woke up with an
      // error of −2.3 g and shoved the nose down to −1.4 g before recovering.
      // The nose went 16° up, back through 1°, and up again: a porpoise, and
      // the stabilators swinging through their full travel to drive it.
      this.loadCommand = clamp(t.loadFactor, 1, N_MAX);
    }

    // Surfaces have a finite slew rate; this is what stops binary keys feeling twitchy.
    // The tailplanes are slower still through the rotation — a full-travel slam
    // during takeoff is the single most bird-like thing the model does.
    const elevatorRate = SURFACE_RATE * lerp(TAKEOFF_SURFACE_RATE, 1, this.takeoffGate);
    this.elevator = moveTowards(this.elevator, elevatorTarget, elevatorRate * dt);
    this.aileron = moveTowards(this.aileron, aileronTarget, SURFACE_RATE * dt);
    this.rudder = moveTowards(this.rudder, rudderTarget, SURFACE_RATE * dt);
  }

  /** Bank the pilot is currently commanding, degrees — shown on the HUD. */
  get commandedBankDeg(): number {
    return -this.commandedBank / DEG;
  }

  reset(): void {
    this.elevator = 0;
    this.aileron = 0;
    this.rudder = 0;
    this.throttle = 0;
    this.commandedBank = 0;
    this.pitchIntegral = 0;
    this.alphaRecovering = false;
    this.gearDown = true;
    this.gearExtension = 1;
  }
}

/** Full surface travel in ~0.4 s. */
const SURFACE_RATE = 2.5;
/** Share of the normal slew rate the tailplanes get through the rotation. */
const TAKEOFF_SURFACE_RATE = 0.35;
/** Share of stick authority on the runway, where the assists cannot help. */
const GROUND_AUTHORITY = 0.34;
/** Pitch-rate damping through the rotation, per radian/second. */
const GROUND_PITCH_DAMP = 1.2;
/** Load factor the aircraft may command at the moment it unsticks. */
const N_ROTATE = 1.45;
/** Height band over which full pitch authority is handed back, metres AGL. */
const GATE_AGL_LO = 10;
const GATE_AGL_HI = 170;
/** Idle to full throttle in ~2.5 s. */
const THROTTLE_RATE = 0.4;
/** Full gear travel in ~4 s. */
const GEAR_RATE = 0.25;
/** How fast the commanded bank ramps while the key is held, rad/s. */
const BANK_RATE = 1.1;
const BANK_P = 1.6;
const BANK_D = 1.1;
/** Load factor commanded at full aft and full forward stick. */
const N_MAX = 7.0;
const N_MIN = -2.0;
/** Load-factor loop: proportional, integral, and the pitch damper. */
const PITCH_P = 0.16;
const PITCH_I = 0.5;
const PITCH_D = 0.55;
/** Indicated airspeed the feedback gains are tuned at, m/s. */
const GAIN_REF_IAS = 165;
/** Maximum rate of change of the commanded load factor, g per second. */
const LOAD_ONSET_RATE = 5;
/** Cruise altitude hold, expressed as a g increment. */
const ALT_P = 0.0035;
const ALT_D = 0.09;
