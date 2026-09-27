/**
 * What an aircraft reports about its own flight, every physics tick.
 *
 * The cameras and the HUD read this rather than any particular flight model,
 * so the biplane model, a replay or anything else can drive them.
 */
export interface Telemetry {
  /** True airspeed, m/s. */
  tas: number;
  /** Indicated airspeed, m/s. */
  ias: number;
  mach: number;
  /** Height above sea level, m. */
  altitude: number;
  /** Height above the ground below, m. */
  agl: number;
  /** m/s, positive climbing. */
  verticalSpeed: number;
  /** Angle of attack and sideslip, radians. */
  alpha: number;
  beta: number;
  /** g along the lift axis. */
  loadFactor: number;
  /** Compass heading, degrees, 0 = north (-Z). */
  heading: number;
  /** Radians. */
  pitch: number;
  bank: number;
  /** rad/s, positive = roll right, nose up, nose right. */
  rollRate: number;
  pitchRate: number;
  yawRate: number;
  onGround: boolean;
  stalled: boolean;
  /** 1 with the wing well away from the stall, 0 at it. */
  stallMargin: number;
  /** Always 0 for piston engines; kept for cameras that still read it. */
  afterburner: number;
  thrust: number;
  lift: number;
  drag: number;
}
