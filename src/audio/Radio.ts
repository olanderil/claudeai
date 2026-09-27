/**
 * In-flight radio.
 *
 * The sim is otherwise silent, and a long scenic flight over a coastline wants
 * something behind it. Rather than ship audio inside the file — which would
 * cost megabytes, and one loop gets old in a minute — this tunes public
 * internet radio, and takes a file off the pilot's own disk if they would
 * rather have that.
 *
 * Two rules follow from the sim being a standalone file that must work offline:
 *
 *  - **Nothing is fetched until the flight starts.** The element is created with
 *    no source and `preload = 'none'`. The sim itself still loads and runs with
 *    no network at all; the radio reaches for one when the pilot clicks through
 *    the title screen, and never before — which is also the browser's rule,
 *    since audio cannot begin without a gesture to hang it on.
 *  - **No Web Audio graph.** Volume goes through `HTMLMediaElement.volume`,
 *    which needs no CORS headers from the station. Routing these streams
 *    through an AudioContext would need `crossOrigin` and would silently fail
 *    on every station that does not send the header.
 */

export interface Station {
  name: string;
  /** What it sounds like, in a few words — this is a station picker, not a URL list. */
  blurb: string;
  url: string;
}

/**
 * The nine channels that made the cut, from SomaFM — listener-supported, and it
 * publishes these direct stream links for exactly this kind of use.
 *
 * In deliberate order rather than alphabetical: Mission Control first, because
 * it is the one that comes on by itself, then out through space and ambient to
 * the two with a pulse to them.
 */
export const STATIONS: Station[] = [
  { name: 'Mission Control', blurb: 'NASA and explorers', url: 'https://ice5.somafm.com/missioncontrol-128-mp3' },
  { name: 'SF 10-33', blurb: 'Ambient over city radio', url: 'https://ice5.somafm.com/sf1033-128-mp3' },
  { name: 'Deep Space One', blurb: 'Deep space ambient', url: 'https://ice5.somafm.com/deepspaceone-128-mp3' },
  { name: 'Synphaera', blurb: 'Modern space ambient', url: 'https://ice5.somafm.com/synphaera-128-mp3' },
  { name: 'Drone Zone', blurb: 'Ambient textures', url: 'https://ice5.somafm.com/dronezone-128-mp3' },
  { name: 'Dark Zone', blurb: 'The darker ambient', url: 'https://ice5.somafm.com/darkzone-128-mp3' },
  { name: 'Salad Classic', blurb: 'Early Groove Salad', url: 'https://ice5.somafm.com/gsclassic-128-mp3' },
  { name: 'Secret Agent', blurb: 'Jet-set lounge', url: 'https://ice5.somafm.com/secretagent-128-mp3' },
  { name: 'Fluid', blurb: 'Instrumental hip hop', url: 'https://ice5.somafm.com/fluid-128-mp3' },
];

export type RadioState = 'stopped' | 'tuning' | 'playing' | 'error';

export class Radio {
  private readonly audio: HTMLAudioElement;
  private readonly listeners: (() => void)[] = [];
  /** Index into `STATIONS`, or -1 for the pilot's own file. */
  private index = 0;
  private state: RadioState = 'stopped';
  /** Object URL for an uploaded file — revoked when another is chosen. */
  private fileUrl: string | null = null;
  private fileName = '';

  constructor(volume = 0.5) {
    this.audio = new Audio();
    this.audio.preload = 'none';
    this.audio.volume = volume;
    this.audio.addEventListener('playing', () => this.settle('playing'));
    this.audio.addEventListener('waiting', () => this.settle('tuning'));
    this.audio.addEventListener('pause', () => this.settle('stopped'));
    // A dead stream, no route to it, or a file the browser cannot decode. All
    // the same to the pilot: it is not playing and the panel should say so.
    this.audio.addEventListener('error', () => this.settle('error'));
    this.audio.addEventListener('stalled', () => this.settle('error'));
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private settle(state: RadioState): void {
    if (this.state === state) return;
    this.state = state;
    for (const fn of this.listeners) fn();
  }

  get playing(): boolean {
    return this.state === 'playing' || this.state === 'tuning';
  }

  get status(): RadioState {
    return this.state;
  }

  get station(): number {
    return this.index;
  }

  /** What is tuned in, named for the panel. */
  get label(): string {
    if (this.index < 0) return this.fileName || 'Your file';
    return STATIONS[this.index]?.name ?? '';
  }

  get hasFile(): boolean {
    return this.fileUrl !== null;
  }

  get volume(): number {
    return this.audio.volume;
  }

  setVolume(value: number): void {
    this.audio.volume = Math.min(1, Math.max(0, value));
  }

  /** Take a local file. Not started here: choosing is not the same as playing. */
  useFile(file: File): void {
    if (this.fileUrl !== null) URL.revokeObjectURL(this.fileUrl);
    this.fileUrl = URL.createObjectURL(file);
    this.fileName = file.name;
    this.index = -1;
    // A file is one piece of music, not a stream — loop it rather than falling
    // silent four minutes into a twelve-minute tour.
    this.audio.loop = true;
    this.tune();
  }

  /** Tune a station by index, and start it. */
  select(index: number): void {
    if (index < 0 || index >= STATIONS.length) return;
    this.index = index;
    this.audio.loop = false;
    this.tune();
  }

  private tune(): void {
    const src = this.index < 0 ? this.fileUrl : STATIONS[this.index]?.url;
    if (src === null || src === undefined) return;
    this.audio.src = src;
    this.settle('tuning');
    // Autoplay policy allows this because every route here starts at a click.
    // The rejection still has to be caught: an unhandled one is a console error
    // for something the pilot can simply try again.
    this.audio.play().catch(() => this.settle('error'));
  }

  toggle(): void {
    if (this.playing) {
      this.audio.pause();
      // A live stream cannot be resumed where it stopped, so let it go entirely
      // rather than holding a socket open behind a paused button.
      this.audio.removeAttribute('src');
      this.audio.load();
      this.settle('stopped');
      return;
    }
    this.tune();
  }

  /** Silence it without touching what is tuned in — for a reset or a new world. */
  stop(): void {
    if (this.playing) this.toggle();
  }
}
