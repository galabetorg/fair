import type { GameName, GameParams } from '../types.js';
import { DICE_FLOATS, dice } from './dice.js';
import { LIMBO_FLOATS, limbo } from './limbo.js';
import { ROULETTE_FLOATS, roulette } from './roulette.js';
import { WHEEL_FLOATS, wheel } from './wheel.js';
import { plinko, plinkoFloats } from './plinko.js';
import { mines, minesFloats } from './mines.js';
import { keno, kenoFloats } from './keno.js';
import { blackjack, deck, deckFloats, hilo, cardLabel } from './cards.js';
import { shuffle, floatsNeededForShuffle } from './shuffle.js';

export { dice, limbo, roulette, wheel, plinko, mines, keno, deck, blackjack, hilo, cardLabel, shuffle, floatsNeededForShuffle };

export interface GameDefinition {
  /** Floats the mapper consumes for the given params. */
  floats: (params: GameParams) => number;
  /** Pure mapper from floats to a result. */
  map: (floats: readonly number[], params: GameParams) => unknown;
}

/** Every v1.0 game, keyed by name. This table is what the verifier and the vectors iterate. */
export const GAMES: Record<GameName, GameDefinition> = {
  dice: { floats: () => DICE_FLOATS, map: (f) => dice(f[0]!) },
  limbo: { floats: () => LIMBO_FLOATS, map: (f, p) => limbo(f[0]!, p.houseEdge ?? 0.01) },
  roulette: { floats: () => ROULETTE_FLOATS, map: (f) => roulette(f[0]!) },
  wheel: { floats: () => WHEEL_FLOATS, map: (f, p) => wheel(f[0]!, p.segments ?? 10) },
  plinko: { floats: (p) => plinkoFloats(p.rows ?? 16), map: (f, p) => plinko(f, p.rows ?? 16) },
  mines: { floats: () => minesFloats(), map: (f, p) => mines(f, p.mines ?? 3) },
  keno: { floats: () => kenoFloats(), map: (f, p) => keno(f, p.draws ?? 10) },
  blackjack: { floats: (p) => deckFloats(p.decks ?? 1), map: (f, p) => blackjack(f, p.decks ?? 1) },
  hilo: { floats: (p) => deckFloats(p.decks ?? 1), map: (f, p) => hilo(f, p.decks ?? 1) },
};

export function isGameName(value: string): value is GameName {
  return Object.prototype.hasOwnProperty.call(GAMES, value);
}
