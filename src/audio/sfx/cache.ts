/**
 * AudioBuffers for the bank, rendered lazily per context.
 *
 * Rendering the whole bank takes a few hundred milliseconds of JavaScript, so
 * it is never done in one go on a live context: `step()` renders one variant
 * at a time from idle callbacks, in the order the game is likely to need them.
 * Anything asked for before its turn is rendered on the spot (one variant only,
 * so the hitch is a single variant's worth).
 */

import { BANK, PREWARM_ORDER, entryRate, type ClipName } from './bank';

export class ClipCache {
  private readonly map = new Map<ClipName, (AudioBuffer | null)[]>();
  private warmIndex = 0;
  private warmVariant = 0;

  constructor(private readonly ctx: BaseAudioContext) {}

  private slots(name: ClipName): (AudioBuffer | null)[] {
    let s = this.map.get(name);
    if (!s) {
      s = new Array<AudioBuffer | null>(BANK[name].n).fill(null);
      this.map.set(name, s);
    }
    return s;
  }

  private render(name: ClipName, i: number): AudioBuffer | null {
    const s = this.slots(name);
    const have = s[i];
    if (have) return have;
    const e = BANK[name];
    try {
      const clip = e.make(entryRate(e, this.ctx.sampleRate), i);
      const buf = this.ctx.createBuffer(clip.ch.length, clip.ch[0].length, clip.sr);
      for (let c = 0; c < clip.ch.length; c++) buf.getChannelData(c).set(clip.ch[c]);
      s[i] = buf;
      return buf;
    } catch {
      return null;
    }
  }

  /** A random ready variant; renders one on the spot if none is ready yet. */
  pick(name: ClipName): AudioBuffer | null {
    const s = this.slots(name);
    let ready = 0;
    for (const b of s) if (b) ready++;
    if (ready === 0) return this.render(name, Math.floor(Math.random() * s.length));
    let k = Math.floor(Math.random() * ready);
    for (const b of s) {
      if (b && k-- === 0) return b;
    }
    return null;
  }

  /** A specific variant (engine loops, noise beds, the IR). */
  get(name: ClipName, i = 0): AudioBuffer | null {
    return this.render(name, i);
  }

  has(name: ClipName, i = 0): boolean {
    return !!this.map.get(name)?.[i];
  }

  /** Render the next missing variant. False when the bank is complete. */
  step(): boolean {
    while (this.warmIndex < PREWARM_ORDER.length) {
      const name = PREWARM_ORDER[this.warmIndex];
      const n = BANK[name].n;
      if (this.warmVariant >= n) {
        this.warmIndex++;
        this.warmVariant = 0;
        continue;
      }
      const i = this.warmVariant++;
      if (this.has(name, i)) continue;
      this.render(name, i);
      return true;
    }
    return false;
  }

  get complete(): boolean {
    return this.warmIndex >= PREWARM_ORDER.length;
  }

  /** Render everything now (offline rendering / tests). */
  all(): void {
    while (this.step()) { /* keep going */ }
  }
}
