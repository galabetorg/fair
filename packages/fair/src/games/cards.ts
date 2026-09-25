import { floatsNeededForShuffle, shuffle } from './shuffle.js';

export const SUITS = ['C', 'D', 'H', 'S'] as const;
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'] as const;

/** Card index 0..51 to a label like "AS" or "TD". Index = suit * 13 + rank. */
export function cardLabel(index: number): string {
  const suit = SUITS[Math.floor(index / 13)];
  const rank = RANKS[index % 13];
  if (!suit || !rank) throw new Error('card index out of range');
  return `${rank}${suit}`;
}

/**
 * Deck order for blackjack and hilo. GFS 5.6: Fisher-Yates over 52 * decks cards, one fresh float per swap.
 * Returns card labels in dealing order.
 */
export function deck(floats: readonly number[], decks = 1): string[] {
  if (!Number.isInteger(decks) || decks < 1 || decks > 8) throw new Error('decks must be 1 to 8');
  const size = 52 * decks;
  return shuffle(floats, size).map((i) => cardLabel(i % 52));
}
export function deckFloats(decks = 1): number {
  return floatsNeededForShuffle(52 * decks);
}

/** Blackjack: the dealing order is the result. The game logic reads from it in order. */
export const blackjack = deck;
/** Hilo: same shuffled deck; the game reveals one card per round. */
export const hilo = deck;
