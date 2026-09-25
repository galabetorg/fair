/**
 * Limbo multiplier from one float. GFS 5.2.
 *   raw = 1e8 / (float * 1e8 + 1)
 *   result = floor(raw * (1 - houseEdge) * 100) / 100, minimum 1.00
 */
export function limbo(f: number, houseEdge = 0.01): number {
  const raw = 1e8 / (f * 1e8 + 1);
  const withEdge = Math.floor(raw * (1 - houseEdge) * 100) / 100;
  return Math.max(1, withEdge);
}
export const LIMBO_FLOATS = 1;
