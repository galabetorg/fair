import { floatsNeededForShuffle, shuffle } from './shuffle.js';

export const KENO_POOL = 40;

/** Keno draw. GFS 5.7: Fisher-Yates over 40 numbers (1 to 40), first `draws` entries drawn. */
export function keno(floats: readonly number[], draws = 10): number[] {
  if (!Number.isInteger(draws) || draws < 1 || draws > KENO_POOL) throw new Error(`draws must be 1 to ${KENO_POOL}`);
  return shuffle(floats, KENO_POOL)
    .slice(0, draws)
    .map((i) => i + 1)
    .sort((a, b) => a - b);
}
export function kenoFloats(): number {
  return floatsNeededForShuffle(KENO_POOL);
}
