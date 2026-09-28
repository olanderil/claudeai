import * as THREE from 'three';
import { Engine } from './core/Engine';
import { Input } from './core/Input';
import { Loop } from './core/Loop';
import {
  World, TIME_PRESETS, WEATHER_PRESETS, SEASON_PRESETS, WORLD_PRESETS, DRIFT_RATES,
} from './world/World';
import { terrainHeight, groundHeight, activeWorld, SEA_LEVEL } from './world/Terrain';
import { CameraRig, CAMERA_MODES, type FreeView } from './camera/CameraRig';
import { structures, structureHeight, structureRadius } from './world/Structures';
import {
  shotCatalogue, DIRECTOR_STYLES, LANDMARK_TRIPOD,
  type ShotInfo, type ShotSlot, type Scale, type LandmarkTarget,
} from './camera/Cinematic';
import { CombatHUD, type HudMessage } from './ui/CombatHUD';
import { Menus } from './ui/Menus';
import { Panel } from './ui/Panel';
import { Tips } from './ui/Tips';
import { Radio, STATIONS } from './audio/Radio';
import { Sfx } from './audio/Sfx';
import { settlements } from './world/Settlements';
import { clamp } from './util/math';
import { QUALITY_PRESETS, DEFAULT_QUALITY } from './render/Quality';
import { Game, DEFAULT_PILOT } from './game/Game';
import { MISSIONS, type MissionInfo } from './game/Campaign';
import type { PlaneVisual } from './combat/PlaneVisual';
import { warmGroundModels } from './combat/GroundModels';
import { LEVELS } from './combat/Levels';

/** Physics rate. Fixed and high enough that the aero integration stays stable. */
const PHYSICS_HZ = 120;
/** How far the director will look for something to frame the aircraft against. */
const LANDMARK_RANGE = 9000;
/**
 * How far off a landmark can be and still be offered to the camera, metres.
 *
 * A church tower or a fort you are meant to stand a tripod at does not read
 * from further out, and offering one from that far only means the director
 * keeps choosing shots whose subject never arrives.
 */
const STRUCTURE_RANGE = 5000;
/** Frame rate and bitrate for a recording of the flight. */
const RECORD_FPS = 60;
const RECORD_BITRATE = 12_000_000;
/**
 * Recording formats, best first.
 *
 * H.264 in MP4 leads because it is the one that opens *anywhere* — QuickTime,
 * Photos, iMovie, Premiere, Windows, a phone — with no codec pack and no VLC.
 * WebM is a perfectly good file and is the wrong thing to hand someone who
 * wants to watch their flight or cut it into something.
 *
 * H.265 sits second: better compression, but playback is patchier (Windows
 * wants the HEVC extension), so it is a fallback rather than the default. Note
 * the fully-qualified codec string — Chrome rejects a bare `hvc1` and accepts
 * `hvc1.1.6.L93.B0`, which is the sort of thing that looks like "HEVC is not
 * supported" if you test it the obvious way.
 *
 * WebM last, for browsers whose MediaRecorder cannot write MP4 at all.
 */
const RECORD_FORMATS = [
  { mime: 'video/mp4;codecs=avc1.640028', extension: 'mp4', label: 'MP4 · H.264' },
  { mime: 'video/mp4;codecs=avc1.42E01E', extension: 'mp4', label: 'MP4 · H.264' },
  { mime: 'video/mp4;codecs=hvc1.1.6.L93.B0', extension: 'mp4', label: 'MP4 · H.265' },
  { mime: 'video/mp4', extension: 'mp4', label: 'MP4' },
  { mime: 'video/webm;codecs=vp9', extension: 'webm', label: 'WebM · VP9' },
  { mime: 'video/webm', extension: 'webm', label: 'WebM' },
];

function boot(): void {
  const sceneCanvas = document.getElementById('scene') as HTMLCanvasElement;
  const hudCanvas = document.getElementById('hud') as HTMLCanvasElement;
  const overlay = document.getElementById('overlay') as HTMLDivElement;
  // Tells the stylesheet the script is running, so the help panel can be held
  // back until it is asked for. Without it the panel is the no-script fallback.
  overlay.classList.add('scripted');

  const shotLabel = document.getElementById('shot') as HTMLDivElement;

  /**
   * Capture: a still, or a recording of the flight.
   *
   * Both take the **scene canvas alone**. That is the whole trick and it is
   * free: the HUD is a second canvas and the tips, the panel and the shot label
   * are DOM, so a capture of `#scene` contains the 3D and nothing else. Trying
   * to hide the interface for the duration and put it back afterwards — the
   * obvious approach — would flash the UI on every screenshot and leave the
   * pilot flying blind through a recording.
   */
  /** Set from the dev hook to force an aperture; normally the shot decides. */
  let dofOverride: number | null = null;
  let depthOfField = true;
  let wasAirborne = false;
  /** The filmed machine's guns were firing last frame, for cutting on the burst. */
  let wasFiring = false;
  const sunDirection = new THREE.Vector3(0.4, 0.5, 0.3);
  const landmarkPoint = new THREE.Vector3();

  /**
   * Remember the free camera's saved views between sessions.
   *
   * `localStorage` and nothing else: the build is one file opened from disk, so
   * there is nowhere else to put this, and a failure to read or write it must
   * never stop the sim starting.
   */
  const VIEWS_KEY = 'horizon-1917.free-views';

  function saveFreeViews(): void {
    try {
      window.localStorage.setItem(VIEWS_KEY, JSON.stringify(rig.savedViews));
    } catch {
      // Private browsing, a full quota, a file:// policy — none of it matters
      // enough to interrupt a flight over.
    }
  }

  const TWEAKS_KEY = 'horizon-1917.shot-tweaks';

  /**
   * Throw away the shot adjustments an earlier session left behind.
   *
   * The library used to be saved and restored wholesale, so a drag made once
   * followed the shot for ever: months later the cinematic camera was still
   * playing somebody's half-finished experiment, and there was no way back to
   * the shots as written short of resetting every one of them by hand. The
   * slots are where a customised shot is supposed to live — they carry their
   * own copy of the adjustment, so nothing is lost by starting clean.
   *
   * The key is removed rather than ignored, so a session that has run this
   * leaves nothing for a future version to trip over.
   */
  function clearStoredShotTweaks(): void {
    try {
      window.localStorage.removeItem(TWEAKS_KEY);
    } catch {
      // Private-mode storage. Nothing was loaded either way.
    }
  }

  // The saved shots and the chosen pace travel together: they are both "how I
  // like the director", and one key keeps them from disagreeing.
  const DIRECTOR_KEY = 'horizon-1917.director';

  function saveDirector(): void {
    try {
      // What survives a session: the saved shots, the order they play in, the
      // orbit camera's own framing, and whether a held shot loops. Not the
      // pace, and not the adjustments made to the library's shots — those start
      // where they were written, every time.
      window.localStorage.setItem(DIRECTOR_KEY, JSON.stringify({
        loop: rig.shotLoops, slots: rig.shotSlots, reel: rig.reelOrder,
        orbit: rig.orbit,
      }));
    } catch {
      // Same reasoning as the saved views: never worth interrupting a flight.
    }
  }

  function loadDirector(): void {
    try {
      const raw = window.localStorage.getItem(DIRECTOR_KEY);
      if (raw === null) return;
      const parsed = JSON.parse(raw) as {
        loop?: unknown; slots?: unknown; reel?: unknown; orbit?: unknown;
      };
      // The pace is deliberately not restored, and no longer written. It is the
      // other half of "my shots are not how they were shipped": Kinetic set once
      // in the director came back in the cinematic view every session
      // afterwards, and every shot in the library played to it. It costs one
      // click to set and a session to notice, so it starts at Standard.
      if (typeof parsed.loop === 'boolean') rig.setShotLooping(parsed.loop);
      if (Array.isArray(parsed.slots)) rig.loadShotSlots(parsed.slots as (ShotSlot | null)[]);
      if (Array.isArray(parsed.reel)) rig.setReelOrder(parsed.reel as number[]);
      // Every field optional and every value clamped inside `setOrbit`: a file
      // written before the orbit was adjustable simply has none of them.
      const orbit = parsed.orbit as Record<string, unknown> | undefined;
      if (orbit !== null && typeof orbit === 'object') {
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
        rig.setOrbit({
          distance: num(orbit.distance), height: num(orbit.height),
          rate: num(orbit.rate), direction: num(orbit.direction),
        });
      }
    } catch {
      // Corrupt: the shots as written and nine empty slots are a fine start.
    }
  }

  function loadFreeViews(): void {
    try {
      const raw = window.localStorage.getItem(VIEWS_KEY);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) rig.loadFreeViews(parsed as FreeView[]);
    } catch {
      // Corrupt or unreadable: the four defaults are perfectly good.
    }
  }

  /**
   * The nearest thing worth framing the aircraft against, or null.
   *
   * Cities first — a skyline behind a jet is the shot — then the villages,
   * which at least give the eye something to read scale from.
   */
  function nearestLandmark(from: THREE.Vector3): THREE.Vector3 | null {
    let best: { x: number; z: number } | null = null;
    let bestD = LANDMARK_RANGE;
      for (const v of settlements()) {
      const d = Math.hypot(v.x - from.x, v.z - from.z);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best === null ? null : landmarkPoint.set(best.x, 0, best.z);
  }

  /**
   * The nearest landmark *structure*, with enough about it to stand a camera on.
   *
   * Kept apart from `nearestLandmark` on purpose. That one answers "what is
   * worth putting behind the aeroplane", and a city skyline is the best answer
   * there is to that. This one answers a different question — "is there
   * something out there a camera operator could have climbed" — and a city is
   * no use for it at all. Merging them would make each shot take whichever
   * happened to be closer, which is how you get a tripod planted in a suburb.
   */
  function nearestStructure(from: THREE.Vector3): LandmarkTarget | null {
    let best: LandmarkTarget | null = null;
    let bestD = STRUCTURE_RANGE;
    for (const st of structures()) {
      const d = Math.hypot(st.x - from.x, st.z - from.z);
      if (d >= bestD) continue;
      bestD = d;
      best = { x: st.x, y: st.y, z: st.z, height: structureHeight(st),
        radius: structureRadius(st), kind: st.kind };
    }
    return best;
  }
  let pendingShot = false;
  let recorder: MediaRecorder | null = null;
  let recordedChunks: Blob[] = [];
  let recordFormat = RECORD_FORMATS[RECORD_FORMATS.length - 1];

  /** Offer a captured file to the browser's downloads. */
  function saveCapture(blob: Blob, extension: string): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `horizon-1917-${activeWorld().name.toLowerCase().replace(/ /g, '-')}-${stamp}`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}.${extension}`;
    link.click();
    // Freeing it immediately cancels the download in some browsers; a turn of
    // the event loop is enough.
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // --- Radio -----------------------------------------------------------------
  //
  // The one part of the sim that reaches the network, and only when asked: the
  // panel is built from the station table but nothing is fetched until a
  // station is clicked.
  const RADIO_KEY = 'horizon-1917.radio';
  const savedRadio = ((): { station?: number; volume?: number; playing?: boolean } => {
    try {
      return JSON.parse(window.localStorage.getItem(RADIO_KEY) ?? '{}') as
        { station?: number; volume?: number; playing?: boolean };
    } catch {
      return {};
    }
  })();
  const radio = new Radio(typeof savedRadio.volume === 'number' ? savedRadio.volume : 0.5);
  const radioButton = document.getElementById('radio') as HTMLButtonElement;
  const radioPanel = document.getElementById('radio-panel') as HTMLDivElement;
  const radioStatus = document.getElementById('radio-status') as HTMLElement;
  const radioStations = document.getElementById('radio-stations') as HTMLDivElement;
  const radioVolume = document.getElementById('radio-volume') as HTMLInputElement;
  const radioVolumeValue = document.getElementById('radio-volume-value') as HTMLElement;
  const radioRows: HTMLButtonElement[] = [];

  for (const [index, station] of STATIONS.entries()) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'radio-station';
    const name = document.createElement('span');
    name.textContent = station.name;
    const blurb = document.createElement('span');
    blurb.className = 'blurb';
    blurb.textContent = station.blurb;
    row.append(name, blurb);
    row.addEventListener('click', () => {
      row.blur();
      // Clicking what is already playing stops it — the row is the transport.
      if (radio.station === index && radio.playing) radio.toggle();
      else radio.select(index);
      // `toggle` and `select` both settle asynchronously; save on the next turn
      // so `playing` records where it ended up rather than where it started.
      window.setTimeout(saveRadio, 0);
    });
    radioRows.push(row);
    radioStations.append(row);
  }

  function saveRadio(): void {
    try {
      window.localStorage.setItem(RADIO_KEY, JSON.stringify(
        { station: radio.station, volume: radio.volume, playing: radio.playing }));
    } catch {
      // Same as every other setting: not worth interrupting a flight over.
    }
  }

  function syncRadio(): void {
    const state = radio.status;
    radioStatus.textContent = state === 'playing' ? radio.label
      : state === 'tuning' ? 'Tuning…'
        : state === 'error' ? 'No signal' : 'Off';
    radioStatus.classList.toggle('on', state === 'playing' || state === 'tuning');
    radioStatus.classList.toggle('bad', state === 'error');
    radioButton.classList.toggle('on', radio.playing);
    radioRows.forEach((row, i) => {
      row.classList.toggle('current', radio.station === i && radio.playing);
    });
    radioVolume.value = String(radio.volume);
    radioVolumeValue.textContent = `${Math.round(radio.volume * 100)}%`;
  }
  radio.onChange(syncRadio);

  radioButton?.addEventListener('click', () => {
    radioButton.blur();
    radioPanel.hidden = !radioPanel.hidden;
    radioButton.setAttribute('aria-expanded', String(!radioPanel.hidden));
    if (!radioPanel.hidden) syncRadio();
  });
  radioVolume?.addEventListener('input', () => {
    radio.setVolume(Number(radioVolume.value));
    radioVolumeValue.textContent = `${Math.round(radio.volume * 100)}%`;
    saveRadio();
  });
  (document.getElementById('radio-file') as HTMLInputElement)?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file !== undefined) radio.useFile(file);
  });
  window.addEventListener('pointerdown', (e) => {
    if (radioPanel.hidden) return;
    const target = e.target as Node;
    if (radioPanel.contains(target) || radioButton.contains(target)) return;
    radioPanel.hidden = true;
    radioButton.setAttribute('aria-expanded', 'false');
  });
  syncRadio();

  const screenshotButton = document.getElementById('screenshot') as HTMLButtonElement;
  screenshotButton?.addEventListener('click', () => {
    pendingShot = true;
    screenshotButton.blur();
  });

  const recordButton = document.getElementById('record') as HTMLButtonElement;
  recordButton?.addEventListener('click', () => {
    recordButton.blur();
    if (recorder !== null) {
      recorder.stop();
      return;
    }
    // `captureStream` on the scene canvas gives exactly what is drawn there,
    // which is why nothing has to be hidden.
    const stream = sceneCanvas.captureStream?.(RECORD_FPS);
    if (stream === undefined || typeof MediaRecorder === 'undefined') {
      notify('RECORDING UNAVAILABLE', 'this browser has no MediaRecorder', 3.5);
      return;
    }
    const type = RECORD_FORMATS.find((f) => MediaRecorder.isTypeSupported(f.mime));
    recordedChunks = [];
    recorder = new MediaRecorder(stream, type === undefined
      ? undefined
      : { mimeType: type.mime, videoBitsPerSecond: RECORD_BITRATE });
    recordFormat = type ?? { mime: 'video/webm', extension: 'webm', label: 'WebM' };
    recorder.ondataavailable = (e): void => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };
    recorder.onstop = (): void => {
      saveCapture(new Blob(recordedChunks, { type: recordFormat.mime }), recordFormat.extension);
      recordedChunks = [];
      recorder = null;
      recordButton.classList.remove('recording');
      notify('RECORDING SAVED', recordFormat.label, 2.5);
    };
    recorder.start(1000);
    recordButton.classList.add('recording');
    notify('RECORDING', `${recordFormat.label} — click again to stop`, 2.5);
  });

  // Fullscreen. The class on the body is what flips the icon —
  // `fullscreenchange` rather than the click, so leaving with Escape or F11
  // keeps the icon honest.
  const fullscreenButton = document.getElementById('fullscreen') as HTMLButtonElement;
  fullscreenButton?.addEventListener('click', () => {
    // Both calls return promises that reject if the browser declines — Safari
    // in particular — and an unhandled rejection in a click handler is a
    // console error for something the user simply cannot have.
    const request = document.fullscreenElement === null
      ? document.documentElement.requestFullscreen?.()
      : document.exitFullscreen?.();
    request?.catch(() => undefined);
    fullscreenButton.blur(); // or the next Space would press it again
  });
  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('fullscreen', document.fullscreenElement !== null);
  });

  const engine = new Engine(sceneCanvas);
  const world = new World(engine);
  // The rig samples the ground so the cinematic camera cannot end up inside a hill.
  // The camera's floor is the ground *or the water*, whichever is higher: a
  // camera clamped to the sea bed with its lens pointed up sees nothing but
  // the underside of the ocean plane.
  const cameraFloor = (x: number, z: number): number =>
    Math.max(groundHeight(x, z), SEA_LEVEL);
  const rig = new CameraRig(engine.camera, cameraFloor);

  // --- The director bar ------------------------------------------------------
  //
  // Every control here goes through the same call its keyboard shortcut does,
  // so a click and a key press cannot drift apart. `blur` on each, or the next
  // Space would press whichever button was clicked last instead of opening the
  // Style panel.
  const directorBar = document.getElementById('director-bar') as HTMLDivElement;
  const shotNameButton = document.getElementById('shot-name') as HTMLButtonElement;
  const shotNameText = document.getElementById('shot-name-text') as HTMLSpanElement;
  const shotMenu = document.getElementById('shot-menu') as HTMLDivElement;
  const pinButton = document.getElementById('shot-pin') as HTMLButtonElement;
  const pinLabel = document.getElementById('shot-pin-label') as HTMLSpanElement;
  const helpButton = document.getElementById('shot-help') as HTMLButtonElement;
  const shotKeys = document.getElementById('shot-keys') as HTMLDivElement;
  const shapeButton = document.getElementById('shot-shape-open') as HTMLButtonElement;
  const shotShape = document.getElementById('shot-shape') as HTMLDivElement;
  const styleRow = document.getElementById('shot-styles') as HTMLDivElement;
  const holdSlider = document.getElementById('shot-hold') as HTMLInputElement;
  const travelSlider = document.getElementById('shot-travel') as HTMLInputElement;
  const holdValue = document.getElementById('shot-hold-value') as HTMLElement;
  const travelValue = document.getElementById('shot-travel-value') as HTMLElement;
  const loopButton = document.getElementById('shot-loop') as HTMLButtonElement;
  const reverseButton = document.getElementById('shot-reverse') as HTMLButtonElement;
  const shapeScope = document.getElementById('shot-scope') as HTMLElement;
  const paceStyleRow = document.getElementById('pace-styles') as HTMLDivElement;
  const tourSpeedRow = document.getElementById('tour-speeds') as HTMLDivElement;
  const freeSlotRow = document.getElementById('free-slots') as HTMLDivElement;
  const freeStore = document.getElementById('free-store') as HTMLButtonElement;
  const freeReframe = document.getElementById('free-reframe') as HTMLButtonElement;
  const freeLock = document.getElementById('free-lock') as HTMLButtonElement;
  const freeLockLabel = document.getElementById('free-lock-label') as HTMLElement;
  const orbitDirection = document.getElementById('orbit-direction') as HTMLButtonElement;
  const orbitDirectionLabel = document.getElementById('orbit-direction-label') as HTMLElement;
  const orbitDistance = document.getElementById('orbit-distance') as HTMLInputElement;
  const orbitHeight = document.getElementById('orbit-height') as HTMLInputElement;
  const orbitRate = document.getElementById('orbit-rate') as HTMLInputElement;
  const orbitDistanceValue = document.getElementById('orbit-distance-value') as HTMLElement;
  const orbitHeightValue = document.getElementById('orbit-height-value') as HTMLElement;
  const orbitRateValue = document.getElementById('orbit-rate-value') as HTMLElement;
  const notice = document.getElementById('notice') as HTMLDivElement;
  const noticeText = document.getElementById('notice-text') as HTMLElement;
  const noticeSub = document.getElementById('notice-sub') as HTMLElement;
  const paceHold = document.getElementById('pace-hold') as HTMLInputElement;
  const paceTravel = document.getElementById('pace-travel') as HTMLInputElement;
  const paceHoldValue = document.getElementById('pace-hold-value') as HTMLElement;
  const paceTravelValue = document.getElementById('pace-travel-value') as HTMLElement;
  const slotRow = document.getElementById('shot-slots') as HTMLDivElement;
  const storeButton = document.getElementById('shot-store') as HTMLButtonElement;
  const reelStrip = document.getElementById('reel-strip') as HTMLDivElement;
  const reelPlay = document.getElementById('reel-play') as HTMLButtonElement;
  const reelNote = document.getElementById('reel-note') as HTMLElement;
  const slotsBlock = document.getElementById('shot-slots-block') as HTMLDivElement;
  const slotButtons: HTMLButtonElement[] = [];
  /**
   * When a dragged orbit setting should be written out, or 0 for nothing
   * pending. A drag arrives as one small change per frame; saving each would be
   * hundreds of writes for one gesture.
   */
  let orbitSaveDue = 0;
  const ORBIT_SAVE_DELAY_MS = 600;

  /** The slot Save will write to, or -1 when none has been picked. */
  let picked = -1;
  /**
   * The slot whose contents are actually on screen, or -1.
   *
   * Not "every slot holding a shot of this name", which is what the highlight
   * used to mean: the sliders pin the shot while they are open, so saving three
   * times in a row stores the same setup three times, and all three lit up at
   * once. Three glowing buttons read as three selected slots — and as one save
   * having gone into all of them.
   */
  let activeSlot = -1;
  /** True while a reel chip is being dragged, so the strip is not rebuilt. */
  let draggingChip = false;
  const shotTransport = document.getElementById('shot-transport') as HTMLDivElement;
  const slotChips = new Map<string, HTMLSpanElement>();
  const menuEntries = new Map<string, HTMLButtonElement>();

  for (const [id, direction] of [['shot-prev', -1], ['shot-next', 1]] as const) {
    const button = document.getElementById(id) as HTMLButtonElement;
    button?.addEventListener('click', () => {
      button.blur();
      rig.stepShot(direction);
    });
  }
  pinButton?.addEventListener('click', () => {
    pinButton.blur();
    notify(rig.pinShot() ? 'SHOT PINNED' : 'DIRECTOR RUNNING', undefined, 2);
  });

  /**
   * What to say about a shot in one word.
   *
   * All of it is derived from the shot's own numbers, so the label cannot come
   * to disagree with what the shot does. Where a shot is more than one of
   * these, the rarer, more distinctive fact wins: "backlit" tells you more than
   * "pull out" does.
   */
  const shotMark = (s: ShotInfo): string =>
    s.framing === 'sun' ? 'backlit'
      : s.framing === 'landmark' ? 'landmark'
        : s.locked ? 'planted'
          : s.move === 'in' ? 'push in'
            : s.move === 'out' ? 'pull out'
              : 'hold';

  // Grouped by scale: it is what the director itself sequences by, and it is
  // the one grouping that answers the question someone opening this list is
  // actually asking — how close do you want to be?
  const SCALE_GROUPS: [Scale, string][] = [
    ['wide', 'Wide · the landscape'],
    ['medium', 'Medium · the aircraft'],
    ['close', 'Close · the detail'],
  ];

  // Built from the library rather than written out in the markup, so a shot
  // added to `Cinematic.ts` turns up here without anyone maintaining a list.
  for (const [scale, title] of SCALE_GROUPS) {
    const group = document.createElement('div');
    group.className = 'menu-group';
    const heading = document.createElement('h4');
    heading.textContent = title;
    group.append(heading);
    for (const shot of shotCatalogue().filter((s) => s.scale === scale)) {
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.className = 'menu-shot';
      const name = document.createElement('span');
      name.textContent = shot.name;
      const mark = document.createElement('span');
      mark.className = 'menu-mark';
      mark.textContent = shotMark(shot);
      // The slot chip is written by `markSlots` and stays empty until the shot
      // is saved to one, so the list doubles as the map of what 1-9 will do.
      const chip = document.createElement('span');
      chip.className = 'menu-slot';
      chip.hidden = true;
      slotChips.set(shot.name, chip);
      entry.append(name, chip, mark);
      entry.addEventListener('click', () => {
        entry.blur();
        // The landmark tripod is the one entry that can decline: it needs
        // something in the world to stand on. Leaving the list open says so
        // more clearly than closing it over a camera that did not move.
        if (!rig.forceShot(shot.name)) return;
        showShotMenu(false);
      });
      menuEntries.set(shot.name, entry);
      group.append(entry);
    }
    shotMenu.append(group);
  }

  // --- The cinematic bar's inline pace ---------------------------------------
  //
  // The same three controls as the director's panel, laid along the bar. They
  // are separate elements rather than the panel's moved about: two small sets
  // kept in step by one sync is less to go wrong than one set relocated
  // whenever the camera changes.
  for (const [index, style] of DIRECTOR_STYLES.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = style.name;
    button.addEventListener('click', () => {
      button.blur();
      rig.setDirectorStyle(index);
      saveDirector();
      syncPace();
    });
    paceStyleRow.append(button);
  }
  paceHold?.addEventListener('input', () => {
    rig.setDirectorPace(Number(paceHold.value), rig.directorPace.travel);
    saveDirector();
    syncPace();
  });
  paceTravel?.addEventListener('input', () => {
    rig.setDirectorPace(rig.directorPace.hold, Number(paceTravel.value));
    saveDirector();
    syncPace();
  });

  /** What the bar last showed, so the DOM is only touched when it changes. */
  let paceShown = '';

  function syncPace(): void {
    const { hold, travel } = rig.directorPace;
    const seconds = rig.shotSeconds;
    const active = rig.directorStyle;
    const key = `${hold}|${travel}|${seconds.toFixed(1)}|${active}`;
    if (key === paceShown) return;
    paceShown = key;
    paceHold.value = String(hold);
    paceTravel.value = String(travel);
    paceHoldValue.textContent = `${hold.toFixed(2)}× · ${seconds.toFixed(1)} s`;
    paceTravelValue.textContent = travel < 0.02 ? 'still' : `${travel.toFixed(2)}×`;
    paceStyleRow.childNodes.forEach((node, i) => {
      (node as HTMLButtonElement).classList.toggle('active', i === active);
    });
  }

  // --- Pace and travel -------------------------------------------------------
  //
  // Two sliders rather than three, and deliberately not "speed": a shot is a
  // move across a duration, so speed is travel ÷ hold, and offering all three
  // would give three controls that silently move each other.
  for (const [index, style] of DIRECTOR_STYLES.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = style.name;
    button.addEventListener('click', () => {
      button.blur();
      rig.setDirectorStyle(index);
      saveDirector();
      syncShape();
    });
    styleRow.append(button);
  }
  // In the director the sliders belong to the shot that is playing, which is
  // held still while you work on it. The cinematic camera has no such thing —
  // it cuts on its own and is meant to — so there the same two sliders drive
  // the pace itself and apply to every shot.
  const perShot = (): boolean => rig.mode === 'director';
  holdSlider?.addEventListener('input', () => {
    const value = Number(holdSlider.value);
    if (perShot()) {
      rig.setShotHold(value);
    } else {
      rig.setDirectorPace(value, rig.directorPace.travel);
      saveDirector();
    }
    syncShape();
  });
  travelSlider?.addEventListener('input', () => {
    const value = Number(travelSlider.value);
    if (perShot()) {
      rig.setShotTravel(value);
    } else {
      rig.setDirectorPace(rig.directorPace.hold, value);
      saveDirector();
    }
    syncShape();
  });
  document.getElementById('shot-reset')?.addEventListener('click', (e) => {
    (e.currentTarget as HTMLButtonElement).blur();
    rig.resetShot();
    syncShape();
  });
  document.getElementById('shot-replay')?.addEventListener('click', (e) => {
    (e.currentTarget as HTMLButtonElement).blur();
    rig.replayShot();
  });
  loopButton?.addEventListener('click', () => {
    loopButton.blur();
    rig.setShotLooping(!rig.shotLoops);
    saveDirector();
    syncShape();
  });
  reverseButton?.addEventListener('click', () => {
    reverseButton.blur();
    rig.setShotReversed(!rig.shotReversed);
    // Take effect on what is on screen rather than at the next cut: the point
    // of the switch is to see the shot the other way round.
    rig.replayShot();
    saveDirector();
    syncShape();
  });

  // --- Saved shots, and the reel made of them --------------------------------
  //
  // Nine slots. Clicking one recalls it; clicking an *empty* one saves into it,
  // because there is nothing else it could sensibly do; and Save arms an
  // overwrite so a filled slot can be replaced without reaching for the
  // keyboard. Shift+number does the same thing directly, as it always has.
  for (let index = 0; index < 9; index++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'slot-button';
    button.textContent = String(index + 1);
    button.addEventListener('click', () => {
      button.blur();
      // Picking a slot is one thing and writing to it is another: a click
      // chooses the slot Save will write to, and recalls it if there is
      // something in it. The pick survives everything you do afterwards, which
      // is the point — frame the shot, then press Save.
      picked = index;
      const recalled = rig.recallShotSlot(index);
      activeSlot = recalled === null ? -1 : index;
      if (recalled !== null) notify(`SHOT ${index + 1}`, recalled.shot, 1.6);
      saveDirector();
      markSlots();
      syncShape();
    });
    slotButtons.push(button);
    slotRow.append(button);
  }

  storeButton?.addEventListener('click', () => {
    storeButton.blur();
    if (picked < 0) return;
    rig.storeShotSlot(picked);
    activeSlot = picked;
    notify(`SHOT ${picked + 1} SAVED`, rig.shotName ?? undefined, 2);
    saveDirector();
    markSlots();
    syncShape();
  });

  reelPlay?.addEventListener('click', () => {
    reelPlay.blur();
    if (rig.reelPlaying) {
      rig.stopReel();
      notify('REEL STOPPED', 'the director has the camera again', 2);
    } else {
      const count = rig.playReel();
      if (count === 0) notify('REEL EMPTY', 'save a shot to a number first', 2.5);
      else notify('REEL', `${count} setups in order`, 2);
    }
    syncShape();
  });

  /**
   * The running order, as draggable chips.
   *
   * Rebuilt from the order rather than mutated in place: nine chips is nothing
   * to rebuild, and a drag that reorders an array and then re-renders cannot
   * get the two out of step.
   */
  function renderReel(): void {
    // Rebuilding mid-drag would throw away the preview the drag is producing.
    if (draggingChip) return;
    reelStrip.textContent = '';
    const order = rig.reelOrder;
    if (order.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'menu-mark';
      empty.textContent = 'nothing saved yet';
      reelStrip.append(empty);
      return;
    }
    const playingAt = rig.reelPlaying ? rig.reelPosition.split('/')[0] : '';
    order.forEach((slot, position) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'reel-chip';
      chip.textContent = String(slot + 1);
      chip.title = `${rig.shotSlots[slot]?.shot ?? ''} — drag to reorder, click to drop`;
      if (String(position + 1) === playingAt) chip.classList.add('playing');
      chip.addEventListener('click', (e) => {
        // A click that followed a drag is the end of the drag, not a click.
        if (chip.dataset.dragged === '1') { delete chip.dataset.dragged; return; }
        (e.currentTarget as HTMLButtonElement).blur();
        rig.setReelOrder(order.filter((_, i) => i !== position));
        saveDirector();
        syncShape();
      });
      chip.addEventListener('pointerdown', (e) => startChipDrag(e, chip, position));
      reelStrip.append(chip);
    });
  }

  /**
   * Drag a chip along the strip.
   *
   * The order is rearranged *as you drag* — the chip is moved in the DOM and
   * the working order with it — so what you see while the pointer is down is
   * the order you will get when you let go. Deciding the drop silently and
   * applying it afterwards made you drag, release, look, and try again.
   */
  function startChipDrag(e: PointerEvent, chip: HTMLButtonElement, from: number): void {
    e.preventDefault();
    const order = [...rig.reelOrder];
    let at = from;
    draggingChip = true;
    chip.classList.add('dragging');

    const move = (ev: PointerEvent): void => {
      const chips = [...reelStrip.children] as HTMLElement[];
      const over = chips.findIndex((c) => {
        const b = c.getBoundingClientRect();
        return ev.clientX >= b.left && ev.clientX <= b.right;
      });
      if (over < 0 || over === at) return;
      // Move the node and the order together, so the preview and the result
      // cannot disagree.
      const [moved] = order.splice(at, 1);
      order.splice(over, 0, moved);
      const before = chips[over > at ? over + 1 : over] ?? null;
      reelStrip.insertBefore(chip, before);
      at = over;
      chip.dataset.dragged = '1';
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      chip.classList.remove('dragging');
      draggingChip = false;
      if (at !== from) {
        rig.setReelOrder(order);
        saveDirector();
      }
      syncShape();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Put the sliders where the thing they are pointed at actually is. */
  function syncShape(): void {
    const shot = perShot();
    const t = shot ? rig.shotTweak : rig.directorPace;
    holdSlider.value = String(t.hold);
    travelSlider.value = String(t.travel);
    holdValue.textContent = `${t.hold.toFixed(2)}× · ${rig.shotSeconds.toFixed(1)} s`;
    travelValue.textContent = t.travel < 0.02 ? 'still' : `${t.travel.toFixed(2)}×`;
    shapeScope.textContent = shot ? 'This shot' : 'All shots';
    // Replay, loop and reset act on one shot, and the cinematic camera does not
    // stay on one long enough for any of them to mean anything. Nor do the
    // slots and the reel: they are the director's, on its number keys.
    shotTransport.hidden = !shot;
    slotsBlock.hidden = !shot;
    if (shot) {
      const playing = rig.reelPlaying;
      reelPlay.textContent = playing ? 'Stop' : 'Play';
      reelPlay.setAttribute('aria-pressed', String(playing));
      const filled = rig.filledSlots;
      slotButtons.forEach((b, i) => {
        b.classList.toggle('filled', filled[i]);
        b.classList.toggle('picked', i === picked);
        // At most one, ever: the slot that was actually recalled or written,
        // and only while what it holds is still what is on screen.
        b.classList.toggle('current', !playing && i === activeSlot && filled[i]
          && rig.shotSlots[i]?.shot === rig.shotName);
      });
      storeButton.disabled = picked < 0;
      storeButton.title = picked < 0
        ? 'Pick a slot below first, then save into it'
        : `Save the running shot into slot ${picked + 1}`;
      renderReel();
      reelNote.textContent = playing
        ? `Playing ${rig.reelPosition} — the director has the camera back when you stop.`
        : picked < 0
          ? 'Pick a number, then Save. Shift+number saves straight away.'
          : `Save writes into ${picked + 1}. Drag the chips to reorder, click one to drop it.`;
    }
    loopButton.setAttribute('aria-pressed', String(rig.shotLoops));
    reverseButton.setAttribute('aria-pressed', String(rig.shotReversed));
    const active = rig.directorStyle;
    styleRow.childNodes.forEach((node, i) => {
      (node as HTMLButtonElement).classList.toggle('active', i === active);
    });
  }

  /** Show which shots are on which number key. */
  function markSlots(): void {
    // Filling a slot or dropping a chip can add a row, and the list above has
    // to move with it.
    if (!shotShape.hidden) requestAnimationFrame(liftShotMenu);
    for (const chip of slotChips.values()) {
      chip.hidden = true;
      chip.textContent = '';
    }
    rig.shotSlots.forEach((slot, i) => {
      if (slot === null) return;
      const chip = slotChips.get(slot.shot);
      // A shot can be in more than one slot; the lowest number is the one to
      // show, because it is the one someone will reach for.
      if (chip === undefined || !chip.hidden) return;
      chip.textContent = String(i + 1);
      chip.hidden = false;
    });
  }

  /**
   * Three popovers hang off this bar, and which of them may share the screen is
   * a question of where they sit.
   *
   * The key list and the shot editor both hang off the bar's right edge, in the
   * same slot, so those two exclude each other. The shot list is centred and
   * stacks *above* the editor — picking a shot and then tuning it is one job,
   * and closing the editor to choose what to edit meant reopening it every
   * time, and losing the pin with it.
   */
  function showShotMenu(open: boolean): void {
    shotMenu.hidden = !open;
    shotNameButton.setAttribute('aria-expanded', String(open));
    if (open) {
      showShotKeys(false);
      // Checked as the list opens rather than every frame: whether there is a
      // landmark within reach changes on the scale of a minute's flying, and
      // the only moment the answer is looked at is now.
      const tripod = menuEntries.get(LANDMARK_TRIPOD);
      if (tripod !== undefined) {
        const ready = rig.landmarkTripodReady();
        tripod.disabled = !ready;
        tripod.title = ready ? '' : 'No landmark within reach';
      }
    }
    liftShotMenu();
  }
  function showShotKeys(open: boolean): void {
    shotKeys.hidden = !open;
    helpButton.setAttribute('aria-expanded', String(open));
    if (open) {
      showShotMenu(false);
      showShotShape(false);
    }
  }

  /**
   * Tell the stylesheet how tall the editor is, so the list can clear it.
   *
   * Measured rather than assumed: the panel is three columns on a desktop and
   * one on a phone, and the reel grows a row as slots are filled, so its height
   * is not a number that can be written down.
   */
  function liftShotMenu(): void {
    const style = document.documentElement.style;
    if (shotShape.hidden) {
      style.removeProperty('--shot-menu-bottom');
      return;
    }
    // Where the editor's top edge actually is, plus a gap. Derived from the
    // rectangle rather than from a height added to a constant: the two panels
    // are anchored to different things, so their offsets do not share an origin.
    const top = shotShape.getBoundingClientRect().top;
    style.setProperty('--shot-menu-bottom', `${Math.round(window.innerHeight - top + 10)}px`);
  }
  function showShotShape(open: boolean): void {
    shotShape.hidden = !open;
    shapeButton.setAttribute('aria-expanded', String(open));
    if (open) {
      // In the director, opening these holds the shot. The sliders belong to
      // whatever is playing, and measured with the sequence running they were
      // unusable: it cuts every few seconds, so an adjustment landed on the
      // shot you *were* watching and the sliders sprang back to the new one.
      // The cinematic camera is not pinned — there the sliders are the pace and
      // apply to everything, so there is nothing to hold still.
      if (rig.mode === 'director') rig.setShotPinned(true);
      syncShape();
      showShotKeys(false);
    }
    // After `hidden` is set and the panel has been laid out, so the height is
    // the one the list has to clear.
    liftShotMenu();
  }
  // The editor refolds from three columns to one as the window narrows, so its
  // height — and the room the list has above it — is a function of the viewport.
  window.addEventListener('resize', liftShotMenu);

  shapeButton?.addEventListener('click', () => {
    shapeButton.blur();
    showShotShape(shotShape.hidden);
  });
  shotNameButton?.addEventListener('click', () => {
    shotNameButton.blur();
    showShotMenu(shotMenu.hidden);
  });
  helpButton?.addEventListener('click', () => {
    helpButton.blur();
    showShotKeys(shotKeys.hidden);
  });
  // Anywhere else dismisses it. `pointerdown` rather than `click`, so it closes
  // on the way down and the same gesture can go straight back to flying. The
  // whole bar is exempt, not just the name: stepping with the arrows while the
  // list is open is worth watching, since the highlight moves with the cut.
  window.addEventListener('pointerdown', (e) => {
    if (shotMenu.hidden && shotKeys.hidden && shotShape.hidden) return;
    const target = e.target as Node;
    if (shotMenu.contains(target) || directorBar.contains(target)) return;
    showShotMenu(false);
    showShotKeys(false);
    showShotShape(false);
  });

  const hud = new CombatHUD(hudCanvas);
  const input = new Input(sceneCanvas);
  const sfx = new Sfx();
  const SFX_KEY = 'horizon-1917.sfx';
  try {
    const v = Number(window.localStorage.getItem(SFX_KEY));
    if (window.localStorage.getItem(SFX_KEY) !== null && Number.isFinite(v)) sfx.setVolume(v);
  } catch {
    // No storage: the default volume stands.
  }

  // --- Watch: the AI flies your machine and the director films it ----------
  //
  // The jet's scenic flight became this. The speeds are the tour's speeds,
  // pulled down at the low end so a dogfight can be watched in slow motion.
  const TOUR_SPEEDS = [0.25, 0.5, 1, 1.5, 2];
  let tourSpeedIndex = 2;
  function applyTourSpeed(): void {
    loop.timeScale = game.autopilot ? TOUR_SPEEDS[tourSpeedIndex] : 1;
  }

  const tips = new Tips(() => {
    tipsVisible = false;
    tips.clear();
    notify('TIPS OFF', 'the Controls tab brings them back', 3);
    panel.sync();
  });
  let tipsVisible = true;

  let paused = false;
  /** The title sequence and the main menu: the attract dogfight plays behind them. */
  let introRunning = true;
  let showMap = true;
  // `?quality=low|medium|high|ultra` (or 0–3) picks the preset up front — for
  // slow machines, and so a first frame never has to be drawn at the wrong one.
  let qualityIndex = DEFAULT_QUALITY;
  {
    const q = new URLSearchParams(window.location.search).get('quality');
    if (q !== null) {
      const byName = QUALITY_PRESETS.findIndex((p) => p.name.toLowerCase() === q.toLowerCase());
      const n = byName >= 0 ? byName : Number(q);
      if (Number.isInteger(n) && n >= 0 && n < QUALITY_PRESETS.length) qualityIndex = n;
    }
  }
  function applyQuality(): void {
    const preset = QUALITY_PRESETS[qualityIndex];
    engine.applyQuality(preset);
    world.applyQuality(preset);
  }
  applyQuality();

  let message: HudMessage | null = null;
  let messageTimer = 0;
  let cameraMode = 'CHASE';
  let subject: PlaneVisual | null = null;
  const subjectPos = new THREE.Vector3();
  const listenerVel = new THREE.Vector3();
  const lastCamPos = new THREE.Vector3();

  const game = new Game({
    notify: (t, s, sec) => notify(t, s, sec),
    cue: (k) => sfx.ui(k),
    // The rig decides where a kill cam may play (cinematic and director, not
    // the views the player flies by).
    killCam: (s) => rig.requestKillCam({ position: s.position, velocity: s.velocity }, 3.2),
    subjectChanged: (v) => {
      if (subject && subject !== v) subject.setCockpitVisible(false);
      subject = v;
      rig.snap();
    },
    hurt: () => {
      hud.onHurt(0.3);
      rig.addShake(0.35);
      rig.requestShot('hit');
    },
    flakNear: (d) => {
      rig.addShake(clamp(0.6 - d / 200, 0.1, 0.6));
      if (d < 120) rig.requestShot('flak');
    },
    hitConfirm: () => {
      hud.onHit();
      // Hits going home: a reaction shot of the machine taking them.
      rig.requestShot('struck');
    },
    report: (r) => {
      showMenusCursor();
      menus.showReport(r, game.mission);
    },
  }, sfx);
  engine.scene.add(game.battle.group);

  // --- Tips -----------------------------------------------------------------
  const CAMERA_TIP_MS = 30_000;
  const CAMERA_TIPS: Partial<Record<typeof rig.mode, string>> = {
    cinematic: 'Automatic cinematic director — set the pace and enjoy the fight.',
    director: 'Pick shots, adjust them, and build your own sequence.',
    orbit: 'Set orbit direction, height and speed.',
    target: 'Target view — the camera keeps your enemy in frame past your tail. T switches target.',
  };
  let cameraTipUntil = 0;
  let lastCameraMode = rig.mode;
  let lastShapeMode = rig.mode;
  let lastReelPosition = '';
  const TIP_SHOW_MS = 9000;
  const TIP_REST_MS = 22000;
  let tipLine: string | null = null;
  let tipShownAt = 0;
  let tipHiddenAt = 0;
  const tipsSaid = new Set<string>();
  interface Candidate {
    text: string;
    once?: boolean;
  }

  /** One quiet line at a time, and only the one that helps right now. */
  function updateTips(): void {
    const p = game.player;
    const lines: (Candidate | null)[] = [];
    lines.push(rig.mode === 'free'
      ? { text: 'Drag to orbit · wheel to zoom · shift-drag to reframe · '
          + '1-9 saved views, shift+number to save · X plants the camera ahead of you' }
      : performance.now() < cameraTipUntil && CAMERA_TIPS[rig.mode] !== undefined
        ? { text: CAMERA_TIPS[rig.mode] as string }
        : null);
    if (game.autopilot) {
      lines.push({ text: `WATCHING · the autopilot is fighting · any stick input takes over`
        + (TOUR_SPEEDS[tourSpeedIndex] === 1 ? '' : ` · ${TOUR_SPEEDS[tourSpeedIndex]}×`) });
    } else if (p && p.alive) {
      lines.push({ text: 'Fire with SPACE in short bursts — hot guns jam', once: true });
      lines.push(game.target ? { text: 'T switches target · C then the target view keeps it in sight', once: true } : null);
      lines.push(p.gun.ammo < 200 || p.hp < p.maxHp * 0.4
        ? { text: 'Land at your aerodrome and stop to refit — ground crew rearm and repair' } : null);
      lines.push(p.bombs > 0 && game.mission?.id === 'strafe' ? { text: 'B drops a bomb — release just before the target passes under the nose', once: true } : null);
    }
    const wanted = tipsVisible
      ? lines.find((line): line is Candidate => line !== null && !tipsSaid.has(line.text)) ?? null
      : null;
    const now = performance.now();
    if (tipLine !== null) {
      const read = now - tipShownAt >= TIP_SHOW_MS;
      if (read || wanted === null || wanted.text !== tipLine) {
        if (read) {
          const said = lines.find((l) => l?.text === tipLine);
          if (said?.once === true) tipsSaid.add(said.text);
        }
        tipLine = null;
        tipHiddenAt = now;
      }
    } else if (wanted !== null && now - tipHiddenAt >= TIP_REST_MS) {
      tipLine = wanted.text;
      tipShownAt = now;
    }
    tips.set('tip', tipLine);
  }

  function syncNotice(): void {
    const text = message === null ? '' : message.text;
    if (noticeText.textContent !== text) {
      noticeText.textContent = text;
      noticeSub.textContent = message?.sub ?? '';
      notice.dataset.empty = text === '' ? '1' : '0';
    } else if (noticeSub.textContent !== (message?.sub ?? '')) {
      noticeSub.textContent = message?.sub ?? '';
    }
  }

  function notify(text: string, sub?: string, seconds = 2.5): void {
    message = { text: text.toUpperCase(), sub, tone: 'info' };
    messageTimer = seconds;
  }

  function announceCamera(): void {
    if (rig.mode === 'free') notify('FREE CAMERA', undefined, 4);
    else if (rig.mode === 'director') notify('DIRECTOR', undefined, 4);
    else if (rig.mode === 'cinematic') notify('CINEMATIC', undefined, 4);
    else if (rig.mode === 'orbit') notify('ORBIT', undefined, 4);
    else notify(`VIEW  ${cameraMode}`, undefined, 1.6);
  }

  // --- Worlds and sorties ----------------------------------------------------

  function presetIndex(list: readonly { readonly name: string }[], name: string, fallback = 0): number {
    const i = list.findIndex((p) => p.name === name);
    return i >= 0 ? i : fallback;
  }

  /** Regenerate the front and start whatever was running again on it. */
  function newWorld(opts: { landscape?: number | 'random'; reseed?: boolean } = {}): void {
    const index = opts.landscape === 'random'
      ? Math.floor(Math.random() * WORLD_PRESETS.length)
      : opts.landscape;
    const preset = index === undefined ? WORLD_PRESETS[world.worldIndexValue] : world.setWorld(index);
    const seed = opts.reseed ? world.regenerate() : world.seed;
    world.prime(new THREE.Vector3(0, 0, 0));
    if (game.state === 'attract') game.startAttract();
    else if (game.mission) startMission(game.mission, false);
    else if (game.kind === 'scramble') startScramble(false);
    else if (game.mode) startQuickBattle(false);
    world.prime(game.player?.position ?? new THREE.Vector3(0, 0, -2000));
    notify(`FRONT  ${preset.name}`, `SEED ${String(seed).padStart(6, '0')}`);
  }

  /** Common to every way into the air. */
  function enterFlight(): void {
    // Whatever way in, the titles are over.
    endTitles();
    introRunning = false;
    paused = false;
    menus.hide();
    sfx.init();
    sfx.resume();
    overlay.classList.remove('choose');
    overlay.classList.add('hidden');
    document.body.classList.remove('titles');
    document.body.classList.add('started');
    startRadio();
    loop.start();
    input.endFrame();
    tips.clear();
    applyTourSpeed();
    panel.sync();
  }

  function startQuickBattle(fresh = true): void {
    // Quick battle flies over whatever front, hour and weather are set in the
    // World and Style tabs — the menu's dogfight is a preview of exactly that.
    if (fresh) world.prime(new THREE.Vector3(0, 0, 0));
    game.setAutopilot(false);
    game.startQuickBattle(menus.team, menus.aircraft);
    if (rig.mode === 'cinematic' || rig.mode === 'director') rig.setMode('chase');
    cameraMode = rig.mode.toUpperCase();
    world.prime(game.player?.position ?? new THREE.Vector3());
    enterFlight();
  }

  /** Scramble: over the front, hour and weather that are set, from the grass. */
  function startScramble(fresh = true): void {
    if (fresh) world.prime(new THREE.Vector3(0, 0, 0));
    game.setAutopilot(false);
    game.startScramble(menus.team, menus.aircraft);
    if (rig.mode === 'cinematic' || rig.mode === 'director') rig.setMode('chase');
    cameraMode = rig.mode.toUpperCase();
    world.prime(game.player?.position ?? new THREE.Vector3());
    enterFlight();
  }

  function startMission(m: MissionInfo, fresh = true): void {
    if (fresh) {
      world.setWorld(presetIndex(WORLD_PRESETS, m.world));
      world.regenerate(m.seed);
      world.setTimeOfDay(presetIndex(TIME_PRESETS, m.time, 1));
      world.setWeather(presetIndex(WEATHER_PRESETS, m.weather, 0));
      if (m.season) world.setSeason(presetIndex(SEASON_PRESETS, m.season, 1));
      world.prime(new THREE.Vector3(0, 0, 0));
    }
    game.setAutopilot(false);
    game.startMission(m, menus.team, menus.aircraft);
    if (rig.mode === 'cinematic' || rig.mode === 'director') rig.setMode('chase');
    cameraMode = rig.mode.toUpperCase();
    world.prime(game.player?.position ?? new THREE.Vector3());
    enterFlight();
  }

  /** Watch from the main menu: a quick battle flown by the autopilot. */
  function startWatch(): void {
    world.prime(new THREE.Vector3(0, 0, 0));
    game.startQuickBattle(menus.team, menus.aircraft);
    game.setAutopilot(true);
    rig.setDirectorStyle(1);
    rig.setMode('cinematic');
    cameraMode = 'CINEMATIC';
    world.prime(game.player?.position ?? new THREE.Vector3());
    enterFlight();
    notify('WATCHING', 'any stick input takes the controls', 3.5);
  }

  function toggleTour(): void {
    if (game.state !== 'playing') return;
    if (game.autopilot) {
      game.setAutopilot(false);
      applyTourSpeed();
      tips.clear();
      if (rig.mode === 'cinematic') rig.setMode('chase');
      cameraMode = rig.mode.toUpperCase();
      notify('YOU HAVE CONTROL', undefined, 2.2);
      panel.sync();
      return;
    }
    game.setAutopilot(true);
    rig.setDirectorStyle(1);
    rig.setMode('cinematic');
    cameraMode = 'CINEMATIC';
    applyTourSpeed();
    notify('WATCHING', 'the autopilot is fighting', 3);
    panel.sync();
  }

  function quitToMenu(): void {
    paused = false;
    menus.hide();
    game.startAttract();
    rig.setMode('cinematic');
    applyTourSpeed();
    introRunning = true;
    overlay.classList.remove('hidden', 'full', 'ready');
    overlay.classList.add('choose');
    document.body.classList.remove('started');
    hud.clear();
    panel.sync();
  }

  function restart(): void {
    if (game.mission) startMission(game.mission, false);
    else if (game.kind === 'scramble') startScramble(false);
    else startQuickBattle(false);
  }

  function pause(on: boolean): void {
    if (game.state === 'attract' || introRunning) return;
    paused = on;
    if (on) {
      sfx.suspend();
      input.releaseMouseControl();
      showMenusCursor();
      menus.showPause(game.mission !== null);
    } else {
      sfx.resume();
      menus.hide();
    }
  }

  function showMenusCursor(): void {
    input.releaseMouseControl();
    game.mouseFire = false;
  }

  const menus = new Menus({
    quickBattle: () => startQuickBattle(),
    scramble: () => startScramble(),
    watch: () => startWatch(),
    fly: (m) => startMission(m),
    resume: () => pause(false),
    restart: () => restart(),
    quit: () => quitToMenu(),
    help: () => {
      menus.hide();
      showHelp();
    },
    select: () => {
      sfx.init();
      sfx.ui('select');
    },
    level: (l) => {
      game.setLevel(l);
      panel.sync();
    },
  });
  game.setLevel(menus.level);

  // The menu icon in the corner tools: the in-flight menu, with the main menu
  // one click further — a single click never throws a sortie away.
  const menuButton = document.getElementById('menu-button') as HTMLButtonElement | null;
  menuButton?.addEventListener('click', (e) => {
    e.stopPropagation();
    menuButton.blur();
    sfx.ui('select');
    if (game.state === 'playing') pause(!paused);
    else if (game.state === 'over') quitToMenu();
  });

  // Fire with the left mouse button — except where dragging moves the camera.
  sceneCanvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || game.state !== 'playing' || paused) return;
    if (input.usingMouse || (rig.mode !== 'free' && rig.mode !== 'director' && rig.mode !== 'orbit')) {
      game.mouseFire = true;
    }
  });
  window.addEventListener('pointerup', (e) => {
    if (e.button === 0) game.mouseFire = false;
  });
  window.addEventListener('blur', () => {
    game.mouseFire = false;
    if (game.state === 'playing' && !paused && !game.autopilot) pause(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.state === 'playing' && !paused && !game.autopilot) pause(true);
  });

  // Gamepad buttons the stick input doesn't cover: triggers fire and bomb,
  // face buttons for camera and target, Start pauses.
  const padPrev: boolean[] = [];
  function readPad(): void {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let fire = false;
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const pressed = (i: number): boolean => (gp.buttons[i]?.value ?? 0) > 0.35 || (gp.buttons[i]?.pressed ?? false);
      const edge = (i: number): boolean => {
        const now = pressed(i);
        const was = padPrev[i] ?? false;
        padPrev[i] = now;
        return now && !was;
      };
      fire = pressed(7);
      if (edge(6)) game.dropBomb();
      if (edge(3)) {
        cameraMode = rig.cycle().toUpperCase();
        announceCamera();
      }
      if (edge(2)) game.cycleTarget();
      if (edge(9)) pause(!paused);
      break;
    }
    game.padFire = fire;
  }

  function fixedUpdate(dt: number): void {
    if (paused) return;
    input.update();
    let stick: Input | null = introRunning || game.state !== 'playing' ? null : input;
    if (stick && game.autopilot) {
      if (Math.abs(input.pitch) > 0.15 || Math.abs(input.roll) > 0.15
        || Math.abs(input.yaw) > 0.15 || Math.abs(input.throttleAxis) > 0.15) {
        toggleTour();
      } else {
        stick = null;
      }
    }
    game.fixedUpdate(dt, stick);
  }

  const lighting = {
    sun: new THREE.Color(),
    sky: new THREE.Color(),
    sunDir: new THREE.Vector3(),
    fogColor: new THREE.Color(),
    fogDensity: 1.85e-5,
  };
  function updateLighting(): void {
    const sunLight = world.sunLight;
    lighting.sun.copy(sunLight.color).multiplyScalar(sunLight.intensity * 0.55);
    lighting.sunDir.copy(world.sun).normalize();
    const fog = engine.scene.fog as THREE.FogExp2 | null;
    if (fog) {
      lighting.fogColor.copy(fog.color);
      lighting.fogDensity = fog.density;
      // Sky fill: the horizon colour, a touch brighter, is what lights smoke from the side.
      lighting.sky.copy(fog.color).multiplyScalar(0.55 + 0.35 * Math.max(0, lighting.sunDir.y));
    }
    game.battle.fx.setLighting(lighting);
    // Searchlights come on as the sun goes down.
    game.battle.night = clamp((0.12 - lighting.sunDir.y) / 0.16, 0, 1);
  }

  /** Dev: step the game without drawing, for headless tests on slow GL. */
  let skipDraw = false;
  function render(alpha: number, frameDt: number): void {
    const dt = paused ? 0 : frameDt;
    let settingsChanged = false;
    const menuUp = !overlay.classList.contains('hidden') || menus.isOpen;
    if (menuUp && !paused) input.endFrame();
    readPad();
    if (input.wasPressed('KeyC')) {
      cameraMode = rig.cycle().toUpperCase();
      announceCamera();
      settingsChanged = true;
    }
    if (input.wasPressed('KeyT')) game.cycleTarget();
    if (input.wasPressed('KeyB')) game.dropBomb();
    if (input.wasPressed('KeyY')) {
      notify(`TIME  ${world.cycleTimeOfDay(1)}`);
      settingsChanged = true;
    }
    if (input.wasPressed('KeyR')) {
      notify(`WEATHER  ${world.cycleWeather(1)}`);
      settingsChanged = true;
    }
    if (input.wasPressed('Tab')) {
      showMap = !showMap;
      notify(showMap ? 'MAP ON' : 'MAP OFF', undefined, 1.2);
      settingsChanged = true;
    }

    const gesture = input.takeCameraGesture();
    if (rig.mode === 'director') {
      if (gesture.dx !== 0 || gesture.dy !== 0 || gesture.wheel !== 0) {
        rig.adjustShot(gesture.dx, gesture.dy, gesture.wheel);
      }
      if (input.wasPressed('Comma') || input.wasPressed('BracketLeft')) rig.stepShot(-1);
      if (input.wasPressed('Period') || input.wasPressed('BracketRight')) rig.stepShot(1);
      if (input.wasPressed('KeyX')) {
        notify(rig.pinShot() ? 'SHOT PINNED' : 'DIRECTOR RUNNING', undefined, 2);
      }
      if (input.wasPressed('KeyZ')) {
        rig.resetShot();
        notify('SHOT RESET', undefined, 1.6);
      }
      const savingShot = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
      for (let slot = 0; slot < 9; slot++) {
        if (!input.wasPressed(`Digit${slot + 1}`)) continue;
        picked = slot;
        if (savingShot) {
          rig.storeShotSlot(slot);
          activeSlot = slot;
          notify(`SHOT ${slot + 1} SAVED`, rig.shotName ?? undefined, 2.2);
        } else {
          const recalled = rig.recallShotSlot(slot);
          activeSlot = recalled === null ? -1 : slot;
          if (recalled === null) notify(`SHOT ${slot + 1} EMPTY`, 'shift+number saves one', 2);
          else notify(`SHOT ${slot + 1}`, recalled.shot, 1.6);
        }
        saveDirector();
        markSlots();
        if (!shotShape.hidden) syncShape();
      }
    }
    if (rig.mode === 'orbit' && rig.moveOrbitCamera(gesture.dy, gesture.wheel)) {
      syncOrbit();
      orbitSaveDue = performance.now() + ORBIT_SAVE_DELAY_MS;
    }
    if (orbitSaveDue !== 0 && performance.now() >= orbitSaveDue) {
      orbitSaveDue = 0;
      saveDirector();
    }
    if (rig.mode === 'free') {
      rig.moveFreeCamera(gesture.dx, gesture.dy, gesture.wheel, gesture.pan);
      const saving = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
      for (let slot = 0; slot < rig.freeViewCount; slot++) {
        if (!input.wasPressed(`Digit${slot + 1}`)) continue;
        pickedView = slot;
        if (saving) {
          rig.storeFreeView(slot);
          saveFreeViews();
          notify(`VIEW ${slot + 1} SAVED`, 'press the number to come back to it', 2.2);
        } else {
          rig.recallFreeView(slot);
          notify(`VIEW ${slot + 1}`, undefined, 1.2);
        }
        syncFree();
      }
      if (input.wasPressed('KeyX')) {
        announceFreeLock(rig.toggleFreeLock());
        syncFree();
      }
    }
    // Number keys set the throttle wherever they aren't already camera slots.
    if (rig.mode !== 'director' && rig.mode !== 'free' && game.state === 'playing') {
      for (let d = 0; d <= 9; d++) {
        if (input.wasPressed(`Digit${d}`)) game.setThrottle(d === 0 ? 1 : d / 10);
      }
    }
    if (input.wasPressed('KeyF')) toggleTour();
    if (input.wasPressed('KeyN') && (game.state === 'attract' || !game.mission)) {
      newWorld({ landscape: 'random', reseed: true });
      settingsChanged = true;
    }
    if (settingsChanged) panel.sync();
    if (input.wasPressed('KeyO')) panel.toggleStyle();
    if (input.wasPressed('KeyP')) pause(!paused);
    if (input.wasPressed('KeyH')) toggleHelp();
    if (input.wasPressed('KeyM')) {
      if (input.usingMouse) input.releaseMouseControl();
      else if (game.state === 'playing') input.requestMouseControl();
    }
    if (input.wasPressed('Escape')) {
      if (!shotMenu.hidden) showShotMenu(false);
      else if (!shotKeys.hidden) showShotKeys(false);
      else if (!shotShape.hidden) showShotShape(false);
      else if (menus.openScreen === 'pause') pause(false);
      else if (menus.isOpen && menus.openScreen !== 'report') menus.hide();
      else if (game.state === 'playing') pause(!paused);
    }

    if (messageTimer > 0) {
      messageTimer -= frameDt;
      if (messageTimer <= 0) message = null;
    }

    // The game, then the pictures.
    if (!paused) game.frame(dt);
    const battle = game.battle;
    battle.ear.copy(engine.camera.position);
    battle.render(alpha, dt, engine.camera);
    const subj = game.subject;
    if (subj !== subject) {
      if (subject) subject.setCockpitVisible(false);
      subject = subj;
      rig.snap();
    }
    const focus = subject ? subject.root.position : subjectPos.set(0, 600, -2000);
    subjectPos.copy(focus);
    world.update(dt, subjectPos);
    updateLighting();
    if (world.driftIndexValue > 0 && panel.isOpen) panel.sync();

    // Camera: what's being fought, who's behind, and whose seat we're in. The
    // story is the filmed machine's own — in the title fight and while
    // watching, whoever its pilot has actually picked to fight.
    const subjectPlane = game.state === 'attract' ? null : game.player;
    const filmed = game.subjectPlane;
    const target = game.storyTarget;
    const threat = game.threat(filmed);
    rig.setCombatContext({
      target: target && target.alive
        ? { position: target.position, velocity: target.velocity, cameraScale: battle.visualOf(target)?.cameraScale }
        : null,
      threat: threat ? { position: threat.position } : null,
    });
    const firing = Boolean(filmed?.alive && filmed.input.fire && filmed.gun.jam <= 0 && filmed.gun.ammo > 0);
    rig.setGunfire(Boolean(subjectPlane && firing));
    // Cut on action: the moment the guns open up on a target in range.
    if (firing && !wasFiring && target && filmed && target.position.distanceTo(filmed.position) < 450) {
      rig.requestShot('firing');
    }
    wasFiring = firing;
    // V: padlock the target from the cockpit — the rig handles the look over
    // the shoulder when it's dead astern.
    rig.setCockpitPadlock(rig.mode === 'cockpit' && input.isDown('KeyV'));
    const engineSource = subjectPlane ?? game.battle.planes.find((p) => battle.visualOf(p) === subject) ?? null;
    if (engineSource) rig.setEngine(engineSource.rpm * Math.max(0.3, engineSource.throttle), engineSource.type.engine === 'rotary');
    const telemetrySource = game.state === 'attract'
      ? game.battle.planes.find((p) => battle.visualOf(p) === subject) ?? null
      : game.player;
    if (subject && telemetrySource) {
      rig.setDirectorContext(sunDirection.copy(world.sun).normalize(), nearestLandmark(subjectPos),
        nearestStructure(subjectPos), telemetrySource.telemetry.agl);
      rig.update(dt, subject, telemetrySource.telemetry);
    }
    // The game clock: the watch speed, and the director's slow motion on a kill.
    loop.timeScale = (game.autopilot ? TOUR_SPEEDS[tourSpeedIndex] : 1) * (paused ? 1 : rig.timeWarp);
    const airborne = telemetrySource ? !telemetrySource.telemetry.onGround : true;
    if (airborne !== wasAirborne) {
      rig.requestShot(airborne ? 'takeoff' : 'landing');
      wasAirborne = airborne;
    }

    // Sound follows the camera, and its doppler wants the camera's own
    // velocity — which in the free and cinematic views is not the aircraft's.
    if (frameDt > 0) listenerVel.subVectors(engine.camera.position, lastCamPos).divideScalar(frameDt);
    if (listenerVel.lengthSq() > 200 * 200) listenerVel.set(0, 0, 0); // a cut, not a move
    lastCamPos.copy(engine.camera.position);
    sfx.setListener(engine.camera.position, engine.camera.quaternion, listenerVel, rig.mode === 'cockpit');
    sfx.update(frameDt);

    const lens = rig.lens;
    const dist = engine.camera.position.distanceTo(rig.focusPoint);
    engine.setFocus(dist * lens.focusScale, dofOverride ?? lens.aperture);
    if (!skipDraw) engine.render(frameDt);

    if (pendingShot) {
      pendingShot = false;
      sceneCanvas.toBlob((blob) => {
        if (blob !== null) saveCapture(blob, 'png');
      }, 'image/png');
      notify('SCREENSHOT SAVED', undefined, 2);
    }

    const cinematic = rig.mode === 'cinematic';
    // The symbology belongs to a pilot. Watching, or on the title screen, there is none.
    const bareView = cinematic || game.autopilot || introRunning || game.state !== 'playing';
    hudCanvas.style.display = bareView ? 'none' : '';
    document.body.classList.toggle('no-hud', bareView);
    document.body.classList.toggle('cinematic', cinematic);
    if (cinematic && !introRunning) syncPace();
    document.body.classList.toggle('touring', game.autopilot && !introRunning);
    if (game.autopilot) syncTourSpeed();
    document.body.classList.toggle('orbit', rig.mode === 'orbit' && !introRunning);
    document.body.classList.toggle('free', rig.mode === 'free' && !introRunning);
    const directing = rig.mode === 'director' && !introRunning;
    const shaping = directing || (cinematic && !introRunning);
    document.body.classList.toggle('director', directing);
    if (rig.mode !== lastCameraMode) {
      lastCameraMode = rig.mode;
      if (CAMERA_TIPS[rig.mode] !== undefined) {
        cameraTipUntil = performance.now() + CAMERA_TIP_MS;
        tipHiddenAt = performance.now() - TIP_REST_MS;
        tipLine = null;
      }
      if (rig.mode === 'orbit') syncOrbit();
      if (rig.mode === 'free') syncFree();
    }
    if (!directing) {
      if (!shotMenu.hidden) showShotMenu(false);
      if (!shotKeys.hidden) showShotKeys(false);
    }
    if (!shaping && !shotShape.hidden) showShotShape(false);
    if (!shotShape.hidden && rig.mode !== lastShapeMode) {
      lastShapeMode = rig.mode;
      syncShape();
    }
    const reelAt = rig.reelPlaying ? rig.reelPosition : '';
    if (!shotShape.hidden && reelAt !== lastReelPosition) {
      lastReelPosition = reelAt;
      syncShape();
    }
    const shot = rig.shotName;
    if (shot !== null && shotLabel.textContent !== shot) shotLabel.textContent = shot;
    if (shot !== null && shotNameText.textContent !== shot) {
      shotNameText.textContent = shot;
      for (const [name, entry] of menuEntries) entry.classList.toggle('current', name === shot);
      if (!shotShape.hidden) syncShape();
    }
    const pinned = directing && rig.shotPinned;
    const reel = directing && rig.reelPlaying ? `Reel ${rig.reelPosition}` : '';
    const wanted = reel !== '' ? reel : pinned ? 'Pinned' : 'Auto';
    if (pinLabel.textContent !== wanted) {
      pinLabel.textContent = wanted;
      pinButton.setAttribute('aria-pressed', String(pinned || reel !== ''));
    }
    shotLabel.style.display = introRunning ? 'none' : '';

    if (!bareView) {
      const m = game.mode;
      hud.draw({
        battle,
        player: game.player,
        camera: engine.camera,
        target: game.target,
        targetLocked: game.targetLocked,
        title: m?.title ?? '',
        score: m?.score ?? 0,
        lives: m?.lives ?? 0,
        objectives: m?.objectives ?? [],
        mouseStick: input.usingMouse ? { active: true, x: input.roll, y: input.pitch } : null,
        cockpit: rig.mode === 'cockpit',
        showMap,
        time: performance.now() / 1000,
      }, frameDt);
    }
    syncNotice();
    if (!introRunning) updateTips();
    input.endFrame();
  }

  const sensitivityKey = (axis: 'pitch' | 'roll' | 'rudder'): 'pitchSensitivity' | 'rollSensitivity' | 'rudderSensitivity' =>
    `${axis}Sensitivity` as const;

  const panel = new Panel({
    toggleTour,
    touring: () => game.autopilot,
    getTipsVisible: () => tipsVisible,
    setTipsVisible: (on: boolean) => {
      tipsVisible = on;
      if (!on) tips.clear();
    },
    getDepthOfField: () => depthOfField,
    setDepthOfField: (on: boolean) => {
      depthOfField = on;
      engine.configurePostFX({ depthOfField: on });
    },
    tourSpeedOptions: TOUR_SPEEDS.map((v) => `${v}×`),
    getTourSpeed: () => tourSpeedIndex,
    setTourSpeed: (i: number) => {
      tourSpeedIndex = clamp(Math.round(i), 0, TOUR_SPEEDS.length - 1);
      applyTourSpeed();
    },
    getSlowKills: () => rig.slowKills,
    setSlowKills: (on) => rig.setSlowKills(on),
    newWorld: () => newWorld({ reseed: true }),
    newWorldTakeoff: () => newWorld({ reseed: true }),
    currentSeed: () => world.seed,
    timeOptions: TIME_PRESETS.map((p) => p.name),
    weatherOptions: WEATHER_PRESETS.map((p) => p.name),
    seasonOptions: SEASON_PRESETS.map((p) => p.name),
    cameraOptions: CAMERA_MODES.map((m) => m.toUpperCase()),
    qualityOptions: QUALITY_PRESETS.map((q) => q.name),
    worldOptions: WORLD_PRESETS.map((w) => w.name),
    getWorld: () => world.worldIndexValue,
    setWorld: (i) => newWorld({ landscape: i }),
    worldBlurb: () => world.worldBlurb,
    getQuality: () => qualityIndex,
    setQuality: (i) => {
      qualityIndex = clamp(Math.round(i), 0, QUALITY_PRESETS.length - 1);
      applyQuality();
    },
    driftOptions: DRIFT_RATES.map((r) => r.name),
    getClock: () => world.clockHours,
    setClock: (h) => world.setClock(h),
    clockLabel: () => world.clockLabel,
    getDrift: () => world.driftIndexValue,
    setDrift: (i) => world.setDrift(i),
    getTime: () => world.timeIndexValue,
    setTime: (i) => world.setTimeOfDay(i),
    getWeather: () => world.weatherIndexValue,
    setWeather: (i) => world.setWeather(i),
    getSeason: () => world.seasonIndexValue,
    setSeason: (i) => world.setSeason(i),
    getCamera: () => CAMERA_MODES.indexOf(rig.mode),
    setCamera: (i) => {
      rig.setMode(CAMERA_MODES[i]);
      cameraMode = rig.mode.toUpperCase();
      announceCamera();
    },
    getFov: () => rig.fieldOfView,
    setFov: (deg) => rig.setFieldOfView(deg),
    getInvert: () => game.pilot.invertPitch,
    setInvert: (on) => {
      game.pilot.invertPitch = on;
    },
    getAutoRudder: () => game.pilot.autoRudder,
    setAutoRudder: (on) => {
      game.pilot.autoRudder = on;
    },
    getMap: () => showMap,
    setMap: (on) => {
      showMap = on;
    },
    levelOptions: LEVELS.map((l) => l.name),
    getLevel: () => LEVELS.indexOf(game.level),
    setLevel: (i) => {
      const l = LEVELS[i] ?? LEVELS[1];
      game.setLevel(l);
      menus.setLevel(l);
      if (game.state === 'playing') notify(`${l.name} opponents`, 'from the next formation', 2);
    },
    levelNote: () => game.level.note,
    showKeyControls: () => showHelp(),
    getSensitivity: (axis) => game.pilot[sensitivityKey(axis)],
    setSensitivity: (axis, value) => {
      game.pilot[sensitivityKey(axis)] = value;
    },
    resetControls: () => {
      Object.assign(game.pilot, DEFAULT_PILOT);
      rig.setFieldOfView(60);
    },
  });


  // --------------------------------------------------- idle, in fullscreen
  //
  // Fullscreen is someone saying they want the picture, not the instrument
  // panel, so after a few seconds of stillness everything drawn over the
  // landscape steps back: the tabs, the mode bar, the corner icons and the
  // shot name. Any input at all brings them straight back.
  //
  // Only in fullscreen — in a window the chrome is the way you drive the
  // thing — and never while a tab is open, because reading a panel of
  // settings is not the same as doing nothing.
  //
  // Flying, the same chrome also steps aside after a short while — but there
  // only the pointer wakes it, because a pilot is on the keys the whole time
  // and the tabs are wanted when the mouse goes looking for them.
  {
    const IDLE_AFTER = 5000;
    const FLYING_IDLE_AFTER = 2500;
    let lastInput = performance.now();
    let lastPointer = performance.now();
    const wake = (): void => {
      lastInput = performance.now();
      document.body.classList.remove('idle');
    };
    const wakePointer = (): void => {
      lastPointer = performance.now();
      wake();
    };
    // Passive: none of these are cancelled, and saying so keeps the listeners
    // off the critical path of a drag over the canvas.
    for (const type of ['pointermove', 'pointerdown', 'wheel', 'touchstart'] as const) {
      window.addEventListener(type, wakePointer, { passive: true });
    }
    window.addEventListener('keydown', wake, { passive: true });
    document.addEventListener('fullscreenchange', wake);
    window.setInterval(() => {
      const now = performance.now();
      const flying = game.state === 'playing' && !paused && !menus.isOpen && !input.usingMouse;
      document.body.classList.toggle('flying', flying);
      document.body.classList.toggle('idle', !panel.isOpen && (
        (document.fullscreenElement !== null && now - lastInput >= IDLE_AFTER)
        || (flying && now - lastPointer >= FLYING_IDLE_AFTER)));
    }, 250);
  }

  const loop = new Loop(1 / PHYSICS_HZ, fixedUpdate, render);
  loadFreeViews();
  clearStoredShotTweaks();
  // The scenic flight's rate, on the bar as well as in the World panel. One
  // setter for both, so they cannot disagree about what is selected.
  for (const [index, speed] of TOUR_SPEEDS.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${speed}×`;
    button.addEventListener('click', () => {
      button.blur();
      tourSpeedIndex = index;
      applyTourSpeed();
      panel.sync();
      syncTourSpeed();
    });
    tourSpeedRow.append(button);
  }

  let tourSpeedShown = -1;

  function syncTourSpeed(): void {
    if (tourSpeedShown === tourSpeedIndex) return;
    tourSpeedShown = tourSpeedIndex;
    tourSpeedRow.childNodes.forEach((node, i) => {
      (node as HTMLButtonElement).classList.toggle('active', i === tourSpeedIndex);
    });
  }
  syncTourSpeed();

  /**
   * The orbit bar.
   *
   * Written straight through to the rig on `input` rather than on `change`, so
   * the ring reshapes under the slider as it is dragged — the only way to judge
   * a framing is to see it. The write to disk is on `change`, at the end of the
   * gesture, so a single drag is one save and not two hundred.
   */
  function syncOrbit(): void {
    const { distance, height, rate, direction } = rig.orbit;
    orbitDistance.value = String(distance);
    orbitHeight.value = String(height);
    orbitRate.value = String(rate);
    orbitDistanceValue.textContent = `${Math.round(distance)} m`;
    // Signed, because below the aircraft is a real and useful place to be.
    orbitHeightValue.textContent = `${height > 0 ? '+' : ''}${Math.round(height)} m`;
    // "Held" rather than "0.0 rpm": at zero the camera stops on the bearing it
    // reached, which is a fixed side-on view and worth naming as one.
    orbitRateValue.textContent = rate === 0 ? 'held' : `${rate.toFixed(1)} rpm`;
    const cw = direction > 0;
    orbitDirection.classList.toggle('ccw', !cw);
    orbitDirectionLabel.textContent = cw ? 'CW' : 'CCW';
    orbitDirection.title = cw ? 'Circling clockwise from above' : 'Circling anticlockwise';
  }

  orbitDirection.addEventListener('click', () => {
    orbitDirection.blur();
    rig.setOrbit({ direction: -rig.orbit.direction });
    syncOrbit();
    saveDirector();
  });
  for (const [input, key] of [[orbitDistance, 'distance'], [orbitHeight, 'height'],
    [orbitRate, 'rate']] as const) {
    input.addEventListener('input', () => {
      rig.setOrbit({ [key]: Number(input.value) });
      syncOrbit();
    });
    input.addEventListener('change', saveDirector);
  }

  /**
   * The free camera's bar: nine views, a save, and the two toggles.
   *
   * `pickedView` is the slot Save writes to, exactly as in the director's
   * panel — click a slot, then Save — so the same gesture works in both places.
   * A recall also picks the slot it came from, which is almost always the one
   * you want to write back to after nudging the framing.
   */
  let pickedView = -1;
  const freeSlotButtons: HTMLButtonElement[] = [];
  for (let i = 0; i < rig.freeViewCount; i++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'slot-button filled';
    button.textContent = String(i + 1);
    button.title = `View ${i + 1}`;
    button.addEventListener('click', () => {
      button.blur();
      pickedView = i;
      rig.recallFreeView(i);
      notify(`VIEW ${i + 1}`, undefined, 1.2);
      syncFree();
    });
    freeSlotButtons.push(button);
    freeSlotRow.append(button);
  }

  function syncFree(): void {
    freeSlotButtons.forEach((b, i) => b.classList.toggle('picked', i === pickedView));
    freeStore.disabled = pickedView < 0;
    freeStore.title = pickedView < 0
      ? 'Pick a view first, then save the current framing into it'
      : `Write the current framing into view ${pickedView + 1}`;
    const world = rig.freeCameraLocked;
    freeLock.classList.toggle('world', world);
    freeLockLabel.textContent = world ? 'World' : 'Aircraft';
    // Named for what the camera is fixed to, and said in full, because the
    // two are only a word apart on the button.
    freeLock.title = world
      ? 'World: the camera stands in your path — you fly at it, whip past, and away, then it '
        + 'takes fresh station ahead of you. Drag to move round the pass and the wheel to set '
        + 'how close it goes by, both without restarting it. Saved with the view.'
      : 'Aircraft: the camera travels with the aircraft and holds it at the same distance. '
        + 'Saved with the view.';
    freeReframe.setAttribute('aria-pressed', String(rig.freeReframing));
  }

  freeStore.addEventListener('click', () => {
    freeStore.blur();
    if (pickedView < 0) return;
    rig.storeFreeView(pickedView);
    saveFreeViews();
    notify(`VIEW ${pickedView + 1} SAVED`, undefined, 2);
    syncFree();
  });
  freeReframe.addEventListener('click', () => {
    freeReframe.blur();
    rig.setFreeReframe(!rig.freeReframing);
    notify(rig.freeReframing ? 'REFRAME' : 'ORBIT',
      rig.freeReframing ? 'drag moves what the camera looks at' : 'drag swings the camera round',
      1.8);
    syncFree();
  });
  freeLock.addEventListener('click', () => {
    freeLock.blur();
    announceFreeLock(rig.toggleFreeLock());
    syncFree();
  });

  /** The one place that says what the lock means, so the two routes agree. */
  function announceFreeLock(world: boolean): void {
    notify(world ? 'CAMERA  IN THE WORLD' : 'CAMERA  ON THE AIRCRAFT',
      world ? 'planted ahead of you — fly at it, past it, and away'
        : 'it travels with you, holding the same distance',
      2.6);
  }

  loadDirector();
  syncOrbit();
  markSlots();
  syncShape();

  // The title screen: a dogfight near the home field, filmed by the director.
  world.setTimeOfDay(Math.max(0, TIME_PRESETS.findIndex((p) => p.name === 'GOLDEN')));
  world.prime(new THREE.Vector3(0, 0, -2000));
  game.startAttract();
  rig.setMode('cinematic');

  // Dev-only handle for driving the game from the console during development.
  // Stripped from the production bundle by the `import.meta.env.DEV` guard.
  if (import.meta.env.DEV) {
    Object.assign(window, {
      sim: {
        game, battle: game.battle, rig, world, engine, input, loop, hud, tips, panel, menus, sfx,
        terrainHeight, groundHeight, settlements, structures, toggleTour,
        startQuickBattle, startScramble, startMission, startWatch, quitToMenu, pause,
        get paused() { return paused; },
        missions: MISSIONS,
        /** Run the game for `seconds` of game time without drawing. */
        advance: (seconds: number, frame = 1 / 30): number => {
          const t0 = performance.now();
          skipDraw = true;
          const steps = Math.round(frame * PHYSICS_HZ);
          for (let t = 0; t < seconds; t += frame) {
            for (let i = 0; i < steps; i++) fixedUpdate(1 / PHYSICS_HZ);
            render(1, frame);
          }
          skipDraw = false;
          return performance.now() - t0;
        },
        setDof: (a: number | null) => { dofOverride = a; },
        setDepthDebug: (on: boolean) => engine.setDepthDebug(on),
        setTourSpeed: (i: number) => { tourSpeedIndex = i; applyTourSpeed(); },
        THREE,
      },
    });
  }

  // The attract dogfight plays behind the title screen, so the loop runs from
  // the start rather than waiting for the click.
  loop.start();
  // Build every ground model once while the titles play, so the first sortie
  // doesn't stall painting hangar canvas and balloon envelopes.
  window.setTimeout(() => warmGroundModels(), 2500);

  // --- Title sequence ------------------------------------------------------
  //
  // Five fading beats, then the main menu. The beats are pure CSS so they run
  // on the compositor while the world builds behind them; this only decides
  // when they are over. A wall-clock timeout backs up the last beat's own
  // `animationend`, which is the real signal.
  const TITLES_TIMEOUT_MS = 18000;
  let titlesDone = false;
  let titleTimer = 0;

  /** End the opening titles and show the main menu. */
  const endTitles = (): void => {
    if (titlesDone) return;
    titlesDone = true;
    window.clearTimeout(titleTimer);
    overlay.classList.remove('intro');
    overlay.classList.add('choose');
  };

  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (titlesDone) return; // clicked through before the scene came up
    overlay.classList.add('intro');
    document.body.classList.add('titles');
    overlay.querySelector('.beat:last-of-type')
      ?.addEventListener('animationend', endTitles, { once: true });
    titleTimer = window.setTimeout(endTitles, TITLES_TIMEOUT_MS);
  }));

  /** The key list, over whatever is going on. */
  const showHelp = (): void => {
    overlay.classList.remove('choose');
    overlay.classList.add('full', 'ready');
    overlay.classList.remove('hidden');
    if (game.state === 'playing') {
      paused = true;
      sfx.suspend();
    }
  };

  const toggleHelp = (): void => {
    if (overlay.classList.contains('hidden')) showHelp();
    else start();
  };

  const startRadio = (): void => {
    if (radio.status !== 'stopped' || savedRadio.playing === false) return;
    radio.select(typeof savedRadio.station === 'number' ? savedRadio.station : 0);
    saveRadio();
  };

  /**
   * A click on the overlay: skips the titles, or closes the help. On the
   * main menu clicks go to the buttons, not here.
   */
  const start = (): void => {
    if (!titlesDone) {
      endTitles();
      return;
    }
    if (overlay.classList.contains('choose')) return;
    overlay.classList.remove('full', 'ready');
    if (introRunning) {
      // Help asked for from the menu: back to the menu.
      overlay.classList.add('choose');
      return;
    }
    overlay.classList.add('hidden');
    paused = false;
    sfx.resume();
    input.endFrame();
  };

  overlay.querySelector('.t-credit')?.addEventListener('click', (e) => e.stopPropagation());
  overlay.addEventListener('click', start);
  window.addEventListener('keydown', (e) => {
    if (overlay.classList.contains('hidden')) return;
    if (overlay.classList.contains('choose')) {
      if (menus.isOpen || document.activeElement instanceof HTMLButtonElement) return;
      if (e.code === 'Enter') document.getElementById('choose-battle')?.click();
      return;
    }
    if (e.code === 'Enter' || e.code === 'Space') start();
  });
  // Any first gesture wakes the audio context (browsers insist on one).
  window.addEventListener('pointerdown', () => sfx.init(), { once: true });
  window.addEventListener('keydown', () => sfx.init(), { once: true });
  window.addEventListener('beforeunload', () => {
    try {
      window.localStorage.setItem(SFX_KEY, String(sfx.volume));
    } catch {
      // Nothing to keep it in.
    }
  });
}

/** Surface init failures visibly instead of leaving a blank screen. */
function reportFailure(err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const message = `Failed to start:\n${detail}`;
  console.error(err);

  const box = document.getElementById('error');
  if (box) {
    // The error box lives inside the help panel, which the opening titles keep
    // hidden for their first thirteen seconds. A failure has to cut them short
    // or it reports into an invisible element.
    const overlay = document.getElementById('overlay');
    overlay?.classList.remove('hidden', 'intro');
    overlay?.classList.add('ready');
    document.body?.classList.remove('titles');
    box.style.display = 'block';
    box.textContent = message;
    return;
  }
  // The overlay markup isn't available — make sure the failure is still seen.
  const pre = document.createElement('pre');
  pre.style.cssText =
    'position:fixed;inset:0;z-index:9;margin:0;padding:24px;overflow:auto;' +
    'background:#0a0d12;color:#ffb4b4;white-space:pre-wrap;font:12px ui-monospace,monospace';
  pre.textContent = message;
  document.body?.appendChild(pre);
}

function start(): void {
  try {
    boot();
  } catch (err) {
    reportFailure(err);
  }
}

// The production build is a classic script, which Vite injects into <head> — so
// at execution time the canvases don't exist yet and every getElementById would
// return null. Waiting for the DOM makes the dev and single-file builds behave
// identically instead of failing silently in one of them.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
