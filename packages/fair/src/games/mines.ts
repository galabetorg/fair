import { floatsNeededForShuffle, shuffle } from './shuffle.js';

export const MINES_GRID = 25;

/** Mine positions on a 5x5 grid. GFS 5.4: Fisher-Yates over 25 tiles, first `mines` entries are mines. */
export function mines(floats: readonly number[], count: number): number[] {
  if (!Number.isInteger(count) || count < 1 || count > 24) throw new Error('mines must be 1 to 24');
  return shuffle(floats, MINES_GRID).slice(0, count).sort((a, b) => a - b);
}
export function minesFloats(): number {
  return floatsNeededForShuffle(MINES_GRID);
}
