/**
 * Bottom tab bar with World / Style / Controls panels.
 *
 * Plain DOM rather than canvas: these are ordinary form controls and the
 * browser already does focus, hit-testing and accessibility for them properly.
 *
 * The one thing that needs care is the keyboard. Flight input is read from
 * `window`, and native controls also respond to arrows and space — so a key
 * pressed while a slider has focus would both nudge the slider and fly the
 * aircraft. Every key event inside the panel therefore stops propagating before
 * it reaches the window listener.
 */

export interface PanelOption {
  label: string;
  value: number;
}

export interface PanelApi {
  /** Start or stop the scenic autopilot. */
  toggleTour(): void;
  /** Whether the scenic flight is currently flying. */
  touring(): boolean;
  /** How fast the tour runs against the clock. */
  tourSpeedOptions: string[];
  getTourSpeed(): number;
  setTourSpeed(index: number): void;
  /** Reseed the current landscape, leaving a flight in progress airborne. */
  newWorld(): void;
  /** Reseed the current landscape and put the aircraft back on the runway. */
  newWorldTakeoff(): void;
  currentSeed(): number;

  timeOptions: string[];
  /** The clock, in hours, and the names of the speeds the day can run at. */
  driftOptions: string[];
  weatherOptions: string[];
  seasonOptions: string[];
  cameraOptions: string[];
  qualityOptions: string[];
  worldOptions: string[];

  getWorld(): number;
  setWorld(index: number): void;
  worldBlurb(): string;

  getQuality(): number;
  setQuality(index: number): void;

  getTime(): number;
  getClock(): number;
  setClock(hour: number): void;
  clockLabel(): string;
  getDrift(): number;
  setDrift(index: number): void;
  setTime(index: number): void;
  getWeather(): number;
  setWeather(index: number): void;
  getSeason(): number;
  setSeason(index: number): void;

  getCamera(): number;
  /** On-screen hints. */
  getTipsVisible(): boolean;
  setTipsVisible(on: boolean): void;
  /** Shallow depth of field on cinematic close-ups. */
  getDepthOfField(): boolean;
  setDepthOfField(on: boolean): void;
  setCamera(index: number): void;
  getFov(): number;
  setFov(deg: number): void;

  getMode(): 'manual' | 'cruise';
  setMode(mode: 'manual' | 'cruise'): void;
  getAssists(): boolean;
  setAssists(on: boolean): void;

  getCentreHud(): boolean;
  setCentreHud(on: boolean): void;
  showKeyControls(): void;

  getSensitivity(axis: 'pitch' | 'roll' | 'rudder'): number;
  setSensitivity(axis: 'pitch' | 'roll' | 'rudder', value: number): void;
  getMaxBank(): number;
  setMaxBank(deg: number): void;

  resetControls(): void;
}

type TabId = 'world' | 'style' | 'controls';

export class Panel {
  private readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly tabButtons = new Map<TabId, HTMLButtonElement>();
  private open: TabId | null = null;
  /** Re-render hooks so controls reflect changes made elsewhere (e.g. hotkeys). */
  private readonly refreshers: (() => void)[] = [];

  constructor(private readonly api: PanelApi) {
    this.root = document.createElement('div');
    this.root.id = 'panel-root';

    this.body = document.createElement('div');
    this.body.id = 'panel-body';
    this.body.hidden = true;
    this.root.appendChild(this.body);

    const tabs = document.createElement('nav');
    tabs.id = 'panel-tabs';
    for (const [id, label] of [
      ['world', 'World'],
      ['style', 'Style'],
      ['controls', 'Controls'],
    ] as [TabId, string][]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => this.toggle(id));
      tabs.appendChild(button);
      this.tabButtons.set(id, button);
    }

    // Help is a tab by appearance only: it opens the key list over the whole
    // screen rather than rendering into the panel body, so it never takes the
    // `active` state the other three share.
    const help = document.createElement('button');
    help.type = 'button';
    help.textContent = 'Help';
    help.addEventListener('click', () => this.api.showKeyControls());
    tabs.appendChild(help);

    this.root.appendChild(tabs);

    // Keep panel interaction out of the flight controls.
    for (const type of ['keydown', 'keyup'] as const) {
      this.root.addEventListener(type, (e) => e.stopPropagation());
    }

    // A click anywhere else puts the panel away.
    //
    // On `pointerdown` rather than `click`, so a drag that starts on the
    // landscape closes it as it begins instead of when the button comes back
    // up — by then the camera has already swung and the panel has spent the
    // whole gesture covering the thing being looked at. Anything inside the
    // panel is exempt, which includes the tab strip, so the tabs still toggle
    // themselves rather than being closed and reopened by the same press.
    document.addEventListener('pointerdown', (e) => {
      if (this.open === null) return;
      const target = e.target;
      if (target instanceof Node && this.root.contains(target)) return;
      this.close();
    });

    document.body.appendChild(this.root);
  }

  /** Pull fresh values into any open panel — hotkeys can change these too. */
  sync(): void {
    if (this.open) for (const refresh of this.refreshers) refresh();
  }

  /** Open or close the Style tab. Bound to SPACE. */
  toggleStyle(): void {
    this.toggle('style');
  }

  /** Shut whatever tab is open. Does nothing if none is. */
  close(): void {
    if (this.open !== null) this.toggle(this.open);
  }

  /** Whether a tab is showing — the idle-hide leaves the UI alone if so. */
  get isOpen(): boolean {
    return this.open !== null;
  }

  private toggle(id: TabId): void {
    this.open = this.open === id ? null : id;
    for (const [tab, button] of this.tabButtons) {
      button.classList.toggle('active', tab === this.open);
    }
    this.body.hidden = this.open === null;
    if (this.open) this.render(this.open);
  }

  private render(id: TabId): void {
    this.body.textContent = '';
    this.refreshers.length = 0;
    if (id === 'world') this.renderWorld();
    else if (id === 'style') this.renderStyle();
    else this.renderControls();
  }

  // ------------------------------------------------------------------- tabs

  private renderWorld(): void {
    const choose = this.group('Landscape');
    choose.appendChild(
      this.segmented(
        this.api.worldOptions,
        () => this.api.getWorld(),
        (i) => {
          this.api.setWorld(i);
          this.sync();
        },
      ),
    );
    const blurb = this.note('');
    const refreshBlurb = (): void => {
      blurb.textContent = this.api.worldBlurb();
    };
    refreshBlurb();
    this.refreshers.push(refreshBlurb);
    choose.appendChild(blurb);
    this.body.appendChild(choose);

    const tour = this.group('Scenic Flight');
    const tourButton = this.button(
      this.api.touring() ? 'End Scenic Flight' : 'Fly a Scenic Tour',
      () => {
        this.api.toggleTour();
        this.sync();
      },
    );
    tour.appendChild(tourButton);
    this.refreshers.push(() => {
      tourButton.textContent = this.api.touring() ? 'End Scenic Flight' : 'Fly a Scenic Tour';
    });
    tour.appendChild(this.note(
      'Cinematic tour over the landscape. Just enjoy the ride and tweak the visuals '
      + 'while you fly.',
    ));
    tour.appendChild(this.segmented(
      this.api.tourSpeedOptions,
      () => this.api.getTourSpeed(),
      (i) => this.api.setTourSpeed(i),
    ));

    this.body.appendChild(tour);

    const group = this.group('Terrain');
    const seed = this.readout('Seed', () => String(this.api.currentSeed()).padStart(6, '0'));
    group.appendChild(seed);
    // Side by side: the same regeneration, differing only in whether you keep
    // flying. Anyone already in the air almost always wants the first.
    const row = document.createElement('div');
    row.className = 'panel-buttons';
    row.appendChild(
      this.button('New World', () => {
        this.api.newWorld();
        this.sync();
      }),
    );
    row.appendChild(
      this.button('New World + Takeoff', () => {
        this.api.newWorldTakeoff();
        this.sync();
      }),
    );
    group.appendChild(row);
    group.appendChild(
      this.note('A fresh landscape from a new seed. In flight, New World keeps your '
        + 'altitude and speed; + Takeoff puts you back on the runway.'),
    );
    this.body.appendChild(group);
  }

  private renderStyle(): void {
    // Named columns rather than letting the grid place these, for the same
    // reason the controls tab names its own: Time of day is now four rows deep
    // and automatic placement pushed the lens and the quality settings
    // wherever it found room.
    const columns = [this.column(), this.column(), this.column()];

    const time = this.group('Time of day');
    time.appendChild(
      this.segmented(
        this.api.timeOptions,
        () => this.api.getTime(),
        (i) => this.api.setTime(i),
      ),
    );
    // The named hours above are places on this; this is everywhere else.
    time.appendChild(
      this.slider('Clock', 0, 24, 0.02,
        () => this.api.getClock(),
        (v) => this.api.setClock(v),
        () => this.api.clockLabel()),
    );
    time.appendChild(this.note('How fast the day runs while you fly'));
    time.appendChild(
      this.segmented(
        this.api.driftOptions,
        () => this.api.getDrift(),
        (i) => this.api.setDrift(i),
      ),
    );
    columns[0].appendChild(time);

    const weather = this.group('Weather');
    weather.appendChild(
      this.segmented(
        this.api.weatherOptions,
        () => this.api.getWeather(),
        (i) => this.api.setWeather(i),
      ),
    );
    columns[1].appendChild(weather);

    const season = this.group('Season');
    season.appendChild(
      this.segmented(
        this.api.seasonOptions,
        () => this.api.getSeason(),
        (i) => this.api.setSeason(i),
      ),
    );
    columns[2].appendChild(season);

    const lens = this.group('Cinematic lens');
    lens.appendChild(
      this.segmented(
        ['Deep focus', 'Shallow'],
        () => (this.api.getDepthOfField() ? 1 : 0),
        (i) => this.api.setDepthOfField(i === 1),
      ),
    );
    lens.appendChild(this.note(
      'Shallow throws the background out of focus on close and medium shots. '
      + 'Wides stay sharp always.',
    ));
    columns[1].appendChild(lens);

    const quality = this.group('Graphics quality');
    quality.appendChild(
      this.segmented(
        this.api.qualityOptions,
        () => this.api.getQuality(),
        (i) => this.api.setQuality(i),
      ),
    );
    quality.appendChild(
      this.note('Sets resolution, anti-aliasing, bloom, shadows and cloud density.'),
    );
    columns[2].appendChild(quality);

    for (const column of columns) this.body.appendChild(column);
  }

  /**
   * The controls tab, in three explicit columns.
   *
   * The other tabs let the grid place their groups, which is fine when the
   * groups are all about the same height. Here they are not — Sensitivity is
   * four sliders and a button, everything else is two or three rows — so
   * automatic placement left one column long and the others half empty, with
   * the small settings scattered. Naming the columns is the only way to say
   * which things sit together and to keep the three of them the same length.
   */
  private renderControls(): void {
    const columns = [this.column(), this.column(), this.column()];

    const mode = this.group('Flight mode');
    mode.appendChild(
      this.segmented(
        ['Manual', 'Cruise'],
        () => (this.api.getMode() === 'cruise' ? 1 : 0),
        (i) => this.api.setMode(i === 1 ? 'cruise' : 'manual'),
      ),
    );
    mode.appendChild(
      this.checkbox('Flight assists', () => this.api.getAssists(), (v) => this.api.setAssists(v)),
    );
    mode.appendChild(
      this.note('Cruise holds altitude and keeps the wings level between inputs.'),
    );
    columns[1].appendChild(mode);

    const display = this.group('Display');
    display.appendChild(
      this.checkbox('Centre HUD symbology', () => this.api.getCentreHud(),
        (v) => this.api.setCentreHud(v)),
    );
    display.appendChild(
      this.note('Centre symbology is the pitch ladder, waterline and flight-path marker.'),
    );
    columns[1].appendChild(display);

    const stick = this.group('Sensitivity');
    for (const axis of ['pitch', 'roll', 'rudder'] as const) {
      stick.appendChild(
        this.slider(
          axis[0].toUpperCase() + axis.slice(1),
          0.3,
          2,
          0.05,
          () => this.api.getSensitivity(axis),
          (v) => this.api.setSensitivity(axis, v),
          (v) => `${v.toFixed(2)}×`,
        ),
      );
    }
    stick.appendChild(
      this.slider(
        'Max bank',
        20,
        85,
        1,
        () => this.api.getMaxBank(),
        (v) => this.api.setMaxBank(v),
        (v) => `${Math.round(v)}°`,
      ),
    );
    stick.appendChild(this.note('Steeper bank turns tighter. Hold longer to bank further.'));
    stick.appendChild(this.button('Reset to defaults', () => {
      this.api.resetControls();
      this.render('controls');
    }));
    columns[2].appendChild(stick);

    const view = this.group('Camera');
    view.appendChild(
      this.segmented(
        this.api.cameraOptions,
        () => this.api.getCamera(),
        (i) => this.api.setCamera(i),
      ),
    );
    view.appendChild(
      this.slider(
        'Field of view',
        45,
        100,
        1,
        () => this.api.getFov(),
        (v) => this.api.setFov(v),
        (v) => `${Math.round(v)}°`,
      ),
    );
    columns[0].appendChild(view);

    // Rightmost, under the camera: it is a preference about the view rather
    // than about how the aeroplane flies.
    const hints = this.group('On-screen tips');
    hints.appendChild(
      this.segmented(
        ['Show', 'Hide'],
        () => (this.api.getTipsVisible() ? 0 : 1),
        (i) => this.api.setTipsVisible(i === 0),
      ),
    );
    hints.appendChild(this.note('The prompts over the bottom of the view. '
      + 'The HIDE button on a tip does the same thing.'));
    columns[0].appendChild(hints);

    for (const column of columns) this.body.appendChild(column);
  }

  /** One column of the controls tab. */
  private column(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'panel-column';
    return el;
  }

  // --------------------------------------------------------------- builders

  private group(title: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'panel-group';
    const h = document.createElement('h3');
    h.textContent = title;
    el.appendChild(h);
    return el;
  }

  private note(text: string): HTMLParagraphElement {
    const p = document.createElement('p');
    p.className = 'panel-note';
    p.textContent = text;
    return p;
  }

  private readout(label: string, value: () => string): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'panel-row';
    const name = document.createElement('span');
    name.textContent = label;
    const out = document.createElement('strong');
    row.append(name, out);
    const refresh = (): void => {
      out.textContent = value();
    };
    refresh();
    this.refreshers.push(refresh);
    return row;
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'panel-button';
    b.textContent = label;
    b.addEventListener('click', () => {
      onClick();
      b.blur(); // don't leave focus where the next keypress would re-trigger it
    });
    return b;
  }

  private segmented(
    labels: string[],
    get: () => number,
    set: (index: number) => void,
  ): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'panel-segmented';
    const buttons: HTMLButtonElement[] = [];

    labels.forEach((label, index) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => {
        set(index);
        refresh();
        b.blur();
      });
      wrap.appendChild(b);
      buttons.push(b);
    });

    const refresh = (): void => {
      const active = get();
      buttons.forEach((b, i) => b.classList.toggle('active', i === active));
    };
    refresh();
    this.refreshers.push(refresh);
    return wrap;
  }

  private slider(
    label: string,
    min: number,
    max: number,
    step: number,
    get: () => number,
    set: (value: number) => void,
    format: (value: number) => string,
  ): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'panel-slider';

    const name = document.createElement('span');
    name.textContent = label;
    const out = document.createElement('strong');

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);

    input.addEventListener('input', () => {
      const v = Number(input.value);
      set(v);
      out.textContent = format(v);
    });

    const head = document.createElement('div');
    head.className = 'panel-row';
    head.append(name, out);
    row.append(head, input);

    const refresh = (): void => {
      const v = get();
      // Not while it is being dragged. The clock slider is refreshed every
      // frame so it can follow a moving sun, and writing to a range input
      // under the pointer takes the drag away from whoever is doing it.
      if (document.activeElement !== input) input.value = String(v);
      out.textContent = format(v);
    };
    refresh();
    this.refreshers.push(refresh);
    return row;
  }

  private checkbox(
    label: string,
    get: () => boolean,
    set: (on: boolean) => void,
  ): HTMLLabelElement {
    const wrap = document.createElement('label');
    wrap.className = 'panel-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    const text = document.createElement('span');
    text.textContent = label;
    wrap.append(input, text);

    input.addEventListener('change', () => set(input.checked));
    const refresh = (): void => {
      input.checked = get();
    };
    refresh();
    this.refreshers.push(refresh);
    return wrap;
  }
}
