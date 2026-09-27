/**
 * Fixed-timestep simulation loop with a decoupled render.
 *
 * Physics runs at a constant rate (default 120 Hz) so aerodynamic integration is
 * stable and reproducible regardless of display refresh. The renderer is handed an
 * `alpha` in [0,1] to interpolate between the previous and current physics states,
 * which removes judder when the monitor rate isn't a multiple of the physics rate.
 */
export class Loop {
  private rafId = 0;
  private lastTime = 0;
  private accumulator = 0;
  private running = false;

  /**
   * How fast simulated time runs against real time.
   *
   * Applied by taking *more* fixed steps per frame, never bigger ones: the
   * aerodynamic integration is only stable because the step is 1/120 s, and
   * stretching it to 1/40 to go three times faster would change the flight
   * model's behaviour rather than the clock. Everything handed the render
   * callback stays on real time, so anything that should keep its own pace —
   * the cinematic camera's shots, most obviously — simply uses that instead.
   */
  timeScale = 1;

  /** Smoothed frames per second, for the HUD. */
  fps = 0;
  /** Smoothed time spent inside the frame callback (ms). */
  frameMs = 0;

  constructor(
    private readonly fixedStep: number,
    private readonly onFixedUpdate: (dt: number) => void,
    private readonly onRender: (alpha: number, dt: number) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    const started = now;
    let frameTime = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // A backgrounded tab or a hitch can produce a huge dt. Clamping prevents the
    // "spiral of death" where catching up costs more than the time we're catching up on.
    if (frameTime > 0.25) frameTime = 0.25;

    this.accumulator += frameTime * this.timeScale;

    // The cap rises with the scale, or running fast would look like running
    // behind and the loop would simply drop the extra time on the floor.
    const cap = MAX_STEPS_PER_FRAME * Math.ceil(this.timeScale);
    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < cap) {
      this.onFixedUpdate(this.fixedStep);
      this.accumulator -= this.fixedStep;
      steps++;
    }
    // If we hit the step cap we're running behind; drop the debt rather than
    // accumulating it forever.
    if (steps >= cap) this.accumulator = 0;

    this.onRender(this.accumulator / this.fixedStep, frameTime);

    const instantFps = frameTime > 0 ? 1 / frameTime : 0;
    this.fps = this.fps === 0 ? instantFps : this.fps + (instantFps - this.fps) * 0.08;
    const elapsed = performance.now() - started;
    this.frameMs = this.frameMs + (elapsed - this.frameMs) * 0.08;
  };
}

const MAX_STEPS_PER_FRAME = 8;
