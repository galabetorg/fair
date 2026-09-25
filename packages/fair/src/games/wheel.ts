/** Segment index 0 to segments-1 from one float. GFS 5.8: floor(float * segments). */
export function wheel(f: number, segments: number): number {
  if (!Number.isInteger(segments) || segments < 2) throw new Error('segments must be an integer >= 2');
  return Math.floor(f * segments);
}
export const WHEEL_FLOATS = 1;
