/**
 * Fisher-Yates over `size` items using one fresh float per swap. GFS 5, shared by mines, keno,
 * blackjack and hilo. Needs `size - 1` floats. No modulo: index = floor(float * (i + 1)).
 */
export function floatsNeededForShuffle(size: number): number {
  return Math.max(0, size - 1);
}

export function shuffle(floats: readonly number[], size: number): number[] {
  if (!Number.isInteger(size) || size < 1) throw new Error('size must be a positive integer');
  const needed = floatsNeededForShuffle(size);
  if (floats.length < needed) throw new Error(`shuffle of ${size} needs ${needed} floats, got ${floats.length}`);
  const items = Array.from({ length: size }, (_, i) => i);
  let f = 0;
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(floats[f++]! * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}
