/**
 * Plinko path. GFS 5.3. One float per row; float < 0.5 is left (0), otherwise right (1).
 * Bucket index is the count of rights, 0 to rows.
 */
export interface PlinkoResult {
  path: (0 | 1)[];
  bucket: number;
}
export function plinko(floats: readonly number[], rows: number): PlinkoResult {
  if (!Number.isInteger(rows) || rows < 8 || rows > 16) throw new Error('rows must be 8 to 16');
  if (floats.length < rows) throw new Error(`plinko with ${rows} rows needs ${rows} floats`);
  const path: (0 | 1)[] = [];
  for (let i = 0; i < rows; i++) path.push(floats[i]! < 0.5 ? 0 : 1);
  return { path, bucket: path.reduce<number>((a, b) => a + b, 0) };
}
export function plinkoFloats(rows: number): number {
  return rows;
}
