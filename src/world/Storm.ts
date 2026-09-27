/**
 * Lightning and thunder for the storm preset.
 *
 * The flash and the clap are deliberately decoupled: light arrives instantly and
 * sound takes about three seconds per kilometre, so the delay between them is
 * what makes a strike read as near or distant rather than as one event.
 *
 * Audio is created lazily on the first strike, because browsers only allow an
 * AudioContext to start after a user gesture — by which point the player has
 * clicked to begin.
 */
export class Storm {
  /** Current flash brightness, 0..1, added to the frame by PostFX. */
  flash = 0;

  private timeToStrike = 4;
  private audio: AudioContext | null = null;
  private pendingThunder: number[] = [];

  /** Advance the storm. `intensity` is 0 for calm, 1 for a full storm. */
  update(dt: number, intensity: number): void {
    // Flashes decay fast; the double-blink of a real strike comes from
    // scheduling two close together.
    this.flash = Math.max(0, this.flash - dt * 6);

    for (let i = this.pendingThunder.length - 1; i >= 0; i--) {
      this.pendingThunder[i] -= dt;
      if (this.pendingThunder[i] <= 0) {
        this.pendingThunder.splice(i, 1);
        this.playThunder();
      }
    }

    if (intensity <= 0) {
      this.timeToStrike = 4;
      return;
    }

    this.timeToStrike -= dt * intensity;
    if (this.timeToStrike > 0) return;

    // Next strike somewhere between a few seconds and half a minute.
    this.timeToStrike = 3 + Math.random() * 18;

    const near = Math.random();
    this.flash = 0.25 + near * 0.55;
    // Distance drives both how bright it is and how long the thunder takes.
    this.pendingThunder.push(0.4 + (1 - near) * 6);
  }

  private playThunder(): void {
    try {
      this.audio ??= new AudioContext();
      const ctx = this.audio;
      if (ctx.state === 'suspended') void ctx.resume();

      // A rumble is filtered noise with a slow decay — cheaper and more
      // convincing here than trying to synthesise a crack.
      const seconds = 2.5;
      const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        const t = i / data.length;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.2);
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;

      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 320;

      const gain = ctx.createGain();
      gain.gain.value = 0.35;

      source.connect(lowpass).connect(gain).connect(ctx.destination);
      source.start();
    } catch {
      // Audio is a nicety; a blocked context must never break the storm visuals.
    }
  }
}
