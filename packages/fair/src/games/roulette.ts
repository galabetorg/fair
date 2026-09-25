/** European roulette pocket 0 to 36 from one float. GFS 5.5: floor(float * 37). */
export function roulette(f: number): number {
  return Math.floor(f * 37);
}
export const ROULETTE_FLOATS = 1;
