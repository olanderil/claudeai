import { clamp } from '../util/math';

/**
 * How good the other side is. A level rescales every enemy pilot's skill
 * (aim, reactions, evasion, fire discipline), sizes their formations, sets
 * how hard their guns and the flak hit, and — for recruits — switches on a
 * few quiet aids. Score is weighted to match.
 */

export type LevelId = 'recruit' | 'pilot' | 'veteran' | 'ace';

export interface Level {
  readonly id: LevelId;
  readonly name: string;
  readonly note: string;
  /** Enemy pilot skill for the skill a sortie was tuned for (the Pilot level). */
  skill(base: number): number;
  /** Machines added to (or taken from) each enemy formation. */
  readonly flight: number;
  /** Multiplier on the damage the player's machine takes. */
  readonly hurt: number;
  /** Multiplier on the spread of flak and ground fire aimed at the player's side. */
  readonly flak: number;
  /** 0–1: how far the player's rounds are nudged onto a target already near the lead. */
  readonly aimAssist: number;
  /** The player's machine won't pull past the stall. */
  readonly stallGuard: boolean;
  /** The player's guns slow down when hot instead of jamming. */
  readonly noJams: boolean;
  /** Score multiplier. */
  readonly score: number;
  /** Quick Battle: an ace leads the enemy formations from this wave on. */
  readonly aceWave: number;
  /** Every enemy formation has a leader of nearly an ace's quality. */
  readonly leaders: boolean;
}

export const LEVELS: readonly Level[] = [
  {
    id: 'recruit', name: 'Recruit',
    note: 'Green enemy pilots and fewer of them. Your guns don’t jam, rounds find a target near the pip, and the machine won’t stall. Half score.',
    skill: (b) => clamp(b * 0.5, 0.06, 0.4),
    flight: -1, hurt: 0.55, flak: 1.8, aimAssist: 0.65, stallGuard: true, noJams: true, score: 0.5, aceWave: 99, leaders: false,
  },
  {
    id: 'pilot', name: 'Pilot',
    note: 'The squadron average: they shoot straight enough and break when you’re on their tail.',
    skill: (b) => b,
    flight: 0, hurt: 1, flak: 1, aimAssist: 0, stallGuard: false, noJams: false, score: 1, aceWave: 3, leaders: false,
  },
  {
    id: 'veteran', name: 'Veteran',
    note: 'Seasoned pilots in bigger formations. They check their tails, break into you and lead their shots. Score ×1.5.',
    skill: (b) => clamp(0.15 + b * 1.05, 0.35, 0.94),
    flight: 1, hurt: 1.25, flak: 0.75, aimAssist: 0, stallGuard: false, noJams: false, score: 1.5, aceWave: 2, leaders: false,
  },
  {
    id: 'ace', name: 'Ace',
    note: 'Every formation led by an ace, every pilot a marksman who never flies straight for long. Double score.',
    skill: (b) => clamp(0.5 + b * 0.6, 0.62, 0.99),
    flight: 1, hurt: 1.5, flak: 0.55, aimAssist: 0, stallGuard: false, noJams: false, score: 2, aceWave: 2, leaders: true,
  },
];

export const DEFAULT_LEVEL = LEVELS[1];

export function levelById(id: string | null | undefined): Level {
  return LEVELS.find((l) => l.id === id) ?? DEFAULT_LEVEL;
}
