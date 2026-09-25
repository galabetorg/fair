/** Dice roll 0.00 to 100.00 from one float. GFS 5.1: floor(float * 10001) / 100. */
export function dice(f: number): number {
  return Math.floor(f * 10001) / 100;
}
export const DICE_FLOATS = 1;
