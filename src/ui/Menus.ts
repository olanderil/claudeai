import { FIGHTERS, TYPES, type AirframeId, type Team } from '../combat/Types';
import { LEVELS, levelById, type Level } from '../combat/Levels';
import { MISSIONS, type MissionInfo } from '../game/Campaign';
import type { Report } from '../game/Mode';

/**
 * The screens around the flying: side and machine on the main menu, the
 * campaign list, a mission's briefing, the pause card and the combat report.
 * All DOM, all in the same card, so they read as one interface with the
 * panels and bars the flight sim already had.
 */

export interface MenuActions {
  quickBattle(): void;
  scramble(): void;
  watch(): void;
  fly(mission: MissionInfo): void;
  resume(): void;
  restart(): void;
  quit(): void;
  help(): void;
  select(): void;
  /** The opponents' level was picked. */
  level(level: Level): void;
}

const SIDES: { team: Team; label: string; note: string }[] = [
  { team: 'allied', label: 'Royal Flying Corps', note: 'Roundels and khaki doped linen. Vickers guns, Le Rhône and Hispano engines.' },
  { team: 'central', label: 'Luftstreitkräfte', note: 'Iron crosses and lozenge fabric. Spandau guns, Oberursel and Mercedes engines.' },
];

const PLANE_NOTES: Partial<Record<AirframeId, string>> = {
  camel: 'Twitchy and deadly. The rotary drags the nose right — turns right fast, left slow.',
  spad: 'Fast, strong, dives like a stone. Fight it in the vertical, not the turn.',
  dr1: 'The triplane climbs like a lift and turns inside anything. Slow on the straight.',
  albatros: 'Sleek and steady, a good gun platform. Don’t dive it too hard.',
};

const STORE = 'horizon-1917.progress';
const PICK = 'horizon-1917.pick';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class Menus {
  team: Team = 'allied';
  aircraft: AirframeId = 'camel';
  level: Level = levelById(null);
  /** Redraws the main-menu pickers. */
  private renderPickers: () => void = () => {};
  private readonly root = document.getElementById('screens') as HTMLDivElement;
  private readonly screens = new Map<string, HTMLDivElement>();
  private current: string | null = null;
  private done: Set<string>;

  constructor(private readonly actions: MenuActions) {
    this.done = new Set(this.load<string[]>(STORE, []));
    const pick = this.load<{ team?: Team; aircraft?: AirframeId; level?: string }>(PICK, {});
    if (pick.team === 'allied' || pick.team === 'central') this.team = pick.team;
    if (pick.aircraft && FIGHTERS[this.team].includes(pick.aircraft)) this.aircraft = pick.aircraft;
    else this.aircraft = FIGHTERS[this.team][0];
    this.level = levelById(pick.level);
    this.buildPickers();
  }

  private savePick(): void {
    this.save(PICK, { team: this.team, aircraft: this.aircraft, level: this.level.id });
  }

  /** Set the level from elsewhere (the Controls tab). */
  setLevel(level: Level): void {
    if (level === this.level) return;
    this.level = level;
    this.savePick();
    this.renderPickers();
  }

  private load<T>(key: string, fallback: T): T {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  }

  private save(key: string, value: unknown): void {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage may be unavailable (private mode, file://); progress just isn't kept.
    }
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  get openScreen(): string | null {
    return this.current;
  }

  /* ------------------------------------------------------------ pickers */

  private buildPickers(): void {
    const side = document.getElementById('pick-side');
    const plane = document.getElementById('pick-plane');
    const note = document.getElementById('pick-note');
    const level = document.getElementById('pick-level');
    const levelNote = document.getElementById('pick-level-note');
    if (!side || !plane || !note) return;
    const render = (): void => {
      side.textContent = '';
      for (const s of SIDES) {
        const b = el('button', undefined, s.label);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(s.team === this.team));
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          b.blur();
          if (this.team !== s.team) {
            this.team = s.team;
            this.aircraft = FIGHTERS[s.team][0];
            this.savePick();
            this.actions.select();
            render();
          }
        });
        side.append(b);
      }
      plane.textContent = '';
      for (const id of FIGHTERS[this.team]) {
        const b = el('button', undefined, TYPES[id].name);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(id === this.aircraft));
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          b.blur();
          this.aircraft = id;
          this.savePick();
          this.actions.select();
          render();
        });
        plane.append(b);
      }
      note.textContent = PLANE_NOTES[this.aircraft] ?? '';
      const help = document.getElementById('help-plane');
      if (help) help.textContent = TYPES[this.aircraft].name;
      if (level) {
        level.textContent = '';
        level.append(el('span', 'c-seg-label', 'Opponents'));
        for (const l of LEVELS) {
          const b = el('button', undefined, l.name);
          b.type = 'button';
          b.setAttribute('role', 'radio');
          b.setAttribute('aria-checked', String(l === this.level));
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            b.blur();
            if (l === this.level) return;
            this.level = l;
            this.savePick();
            this.actions.select();
            this.actions.level(l);
            render();
          });
          level.append(b);
        }
      }
      if (levelNote) levelNote.textContent = this.level.note;
    };
    this.renderPickers = render;
    render();
    for (const [id, fn] of [
      ['choose-battle', () => this.actions.quickBattle()],
      ['choose-scramble', () => this.actions.scramble()],
      ['choose-watch', () => this.actions.watch()],
      ['choose-campaign', () => this.showCampaign()],
    ] as const) {
      document.getElementById(id)?.addEventListener('click', (e) => {
        e.stopPropagation();
        (e.currentTarget as HTMLElement).blur();
        fn();
      });
    }
  }

  /* ------------------------------------------------------------ screens */

  private screen(id: string, build: (card: HTMLDivElement) => void, wide = false): void {
    let s = this.screens.get(id);
    if (!s) {
      s = el('div', 'screen') as HTMLDivElement;
      s.hidden = true;
      // Clicks on the dimmed backdrop mustn't fall through to the flight.
      s.addEventListener('pointerdown', (e) => e.stopPropagation());
      s.addEventListener('click', (e) => e.stopPropagation());
      this.root.append(s);
      this.screens.set(id, s);
    }
    s.textContent = '';
    const card = el('div', wide ? 'card wide' : 'card') as HTMLDivElement;
    build(card);
    s.append(card);
    this.open(id);
  }

  private open(id: string): void {
    for (const [key, s] of this.screens) {
      if (key === id) {
        s.hidden = false;
        requestAnimationFrame(() => s.classList.add('open'));
      } else {
        s.classList.remove('open');
        s.hidden = true;
      }
    }
    this.current = id;
    document.body.classList.add('screen-open');
    const first = this.screens.get(id)?.querySelector<HTMLElement>('.btn.primary, .mission, .btn');
    first?.focus({ preventScroll: true });
  }

  hide(): void {
    for (const s of this.screens.values()) {
      s.classList.remove('open');
      s.hidden = true;
    }
    this.current = null;
    document.body.classList.remove('screen-open');
  }

  private button(label: string, fn: () => void, cls = 'btn'): HTMLButtonElement {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      b.blur();
      this.actions.select();
      fn();
    });
    return b;
  }

  showCampaign(): void {
    this.screen('campaign', (card) => {
      card.append(el('div', 'eyebrow', this.team === 'allied' ? 'Royal Flying Corps · Orders' : 'Luftstreitkräfte · Befehle'));
      const h = el('h2');
      h.innerHTML = 'The <span class="accent">Campaign</span>';
      card.append(h);
      const list = el('div', 'missions');
      MISSIONS.forEach((m, i) => {
        const row = el('button', `mission${this.done.has(`${this.team}:${m.id}`) ? ' done' : ''}`);
        row.type = 'button';
        row.append(
          el('span', 'num', String(i + 1).padStart(2, '0')),
          el('span', 'name', m.name),
          el('span', 'mark', this.done.has(`${this.team}:${m.id}`) ? 'Flown' : ''),
          el('span', 'meta', `${m.place[this.team]} · ${m.date}`),
        );
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          this.actions.select();
          this.showBriefing(m);
        });
        list.append(row);
      });
      card.append(list);
      const actions = el('div', 'actions');
      actions.append(this.button('Back', () => this.hide(), 'btn quiet'));
      card.append(actions);
    }, true);
  }

  showBriefing(m: MissionInfo): void {
    this.screen('briefing', (card) => {
      card.append(el('div', 'eyebrow', `Mission ${MISSIONS.indexOf(m) + 1} · ${TYPES[this.aircraft].name} · ${this.level.name} opponents`));
      const h = el('h2');
      h.innerHTML = `<span class="accent">${m.name}</span>`;
      card.append(h, el('div', 'place', `${m.place[this.team]} · ${m.date} · ${m.time.toLowerCase()}`));
      card.append(el('p', 'body', m.briefing[this.team]));
      card.append(el('div', 'rule-line'));
      const actions = el('div', 'actions');
      actions.append(
        this.button('Take off', () => this.actions.fly(m), 'btn primary'),
        this.button('Back', () => this.showCampaign(), 'btn quiet'),
      );
      card.append(actions);
    });
  }

  showPause(inMission: boolean): void {
    this.screen('pause', (card) => {
      card.append(el('div', 'eyebrow', 'Paused'));
      const h = el('h2');
      h.innerHTML = 'Holding <span class="accent">pattern</span>';
      card.append(h);
      const actions = el('div', 'actions');
      actions.append(
        this.button('Resume', () => this.actions.resume(), 'btn primary'),
        this.button(inMission ? 'Restart mission' : 'Restart', () => this.actions.restart()),
        this.button('Controls', () => this.actions.help()),
        this.button('Main menu', () => this.actions.quit(), 'btn quiet'),
      );
      card.append(actions);
    });
  }

  showReport(r: Report, mission: MissionInfo | null): void {
    if (mission && r.outcome === 'victory') {
      this.done.add(`${this.team}:${mission.id}`);
      this.save(STORE, [...this.done]);
    }
    const next = mission && r.outcome === 'victory' ? MISSIONS[MISSIONS.indexOf(mission) + 1] ?? null : null;
    this.screen('report', (card) => {
      card.classList.add(`outcome-${r.outcome}`);
      card.append(el('div', 'eyebrow', r.outcome === 'victory' ? 'Mission accomplished' : r.outcome === 'defeat' ? 'Mission failed' : 'Combat report'));
      const h = el('h2');
      h.innerHTML = `<span class="accent">${r.title}</span>`;
      card.append(h, el('div', 'place', r.subtitle));
      const grid = el('div', 'report');
      for (const [k, v] of r.rows) grid.append(el('span', undefined, k), el('span', k === 'Score' ? 'total' : undefined, v));
      card.append(grid);
      const rem = el('p', 'remarks');
      rem.append(el('b', undefined, 'Remarks'), document.createTextNode(r.remarks));
      card.append(rem);
      const actions = el('div', 'actions');
      if (next) actions.append(this.button('Next mission', () => this.showBriefing(next), 'btn primary'));
      actions.append(
        this.button(r.outcome === 'defeat' ? 'Try again' : 'Fly again', () => this.actions.restart(), next ? 'btn' : 'btn primary'),
        this.button('Main menu', () => this.actions.quit(), 'btn quiet'),
      );
      card.append(actions);
    });
  }
}
