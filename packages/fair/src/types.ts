/**
 * Shared types for GFS/1.0.
 */

/** Hex string, lowercase, no 0x prefix. */
export type Hex = string;

/** The three inputs that fully determine a bet under the single-player profile. */
export interface SeedPair {
  /** 32 random bytes, hex encoded (64 chars). Revealed only on rotation. */
  serverSeed: Hex;
  /** Player-chosen UTF-8 string, 1 to 64 chars. */
  clientSeed: string;
  /** Bet counter, starts at 0 for every new seed pair. */
  nonce: number;
}

/** A published commitment: the SHA-256 of the server seed, known before any bet. */
export interface Commitment {
  commitment: Hex;
  /** Unix ms when the commitment was published. Operators should persist this. */
  publishedAt: number;
}

export type GameName =
  | 'dice'
  | 'limbo'
  | 'roulette'
  | 'wheel'
  | 'plinko'
  | 'mines'
  | 'keno'
  | 'blackjack'
  | 'hilo';

/** Game specific parameters carried in every record so the result can be reproduced. */
export interface GameParams {
  /** Declared house edge, 0 to 1. Never hidden inside a mapper. */
  houseEdge?: number;
  /** wheel: number of segments. */
  segments?: number;
  /** plinko: number of rows (8 to 16). */
  rows?: number;
  /** mines: number of mines on the 5x5 grid (1 to 24). */
  mines?: number;
  /** keno: numbers drawn, default 10. */
  draws?: number;
  /** blackjack / hilo: number of decks, default 1. */
  decks?: number;
}

/** The canonical verification record. Field order is irrelevant: records are canonicalised before hashing. */
export interface FairRecord {
  spec: 'GFS/1.0';
  profile: 'single-player';
  game: GameName;
  params: GameParams;
  /** Present only after rotation. Before that, verify against `commitment`. */
  serverSeed?: Hex;
  commitment: Hex;
  clientSeed: string;
  nonce: number;
  /** Highest cursor consumed for this bet. 0 for games needing at most 8 floats. */
  cursor: number;
  result: unknown;
  /** Unix ms. */
  at: number;
  /** Optional GFS/1.1 beacon fields. */
  beacon?: { source: 'drand' | 'evm'; ref: string; value: Hex };
  /** Optional operator signature over the canonical record (Ed25519, hex). */
  signature?: Hex;
  signer?: Hex;
}
