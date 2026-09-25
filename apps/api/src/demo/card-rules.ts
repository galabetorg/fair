/** Pure card analysis: consumes an explicit order and never creates randomness. */
export const CARD_RULE_VERSION = "galabet-cards/2026-09-20.1";
const RANKS = "23456789TJQKA";
export function rankOf(card: string) {
  if (!/^[2-9TJQKA][CDHS]$/.test(card))
    throw new RangeError("invalid card label");
  return RANKS.indexOf(card[0]!) + 2;
}
export function describeHand(cards: readonly string[]) {
  let total = 0,
    highAces = 0;
  for (const card of cards) {
    const rank = rankOf(card);
    total += rank === 14 ? 11 : Math.min(rank, 10);
    if (rank === 14) highAces++;
  }
  while (total > 21 && highAces > 0) {
    total -= 10;
    highAces--;
  }
  return {
    total,
    soft: highAces > 0,
    bust: total > 21,
    natural: cards.length === 2 && total === 21,
  };
}
export function dealerTrace(
  hand: readonly string[],
  following: readonly string[],
  hitSoft17 = false,
) {
  const cards = [...hand];
  const steps: {
    card: string;
    position: number;
    total: number;
    soft: boolean;
  }[] = [];
  let state = describeHand(cards),
    used = 0;
  while (
    !state.bust &&
    (state.total < 17 || (state.total === 17 && state.soft && hitSoft17))
  ) {
    const next = following[used];
    if (!next)
      return {
        cards,
        steps,
        ...state,
        complete: false,
        used,
        rule: hitSoft17 ? "H17" : "S17",
      };
    cards.push(next);
    state = describeHand(cards);
    steps.push({
      card: next,
      position: used,
      total: state.total,
      soft: state.soft,
    });
    used++;
  }
  return {
    cards,
    steps,
    ...state,
    complete: true,
    used,
    rule: hitSoft17 ? "H17" : "S17",
  };
}
export function rankChances(exposed: readonly string[]) {
  if (
    !exposed.length ||
    exposed.length > 52 ||
    new Set(exposed).size !== exposed.length
  )
    throw new RangeError("use distinct cards from one deck");
  const remaining = Array.from({ length: 13 }, () => 4);
  for (const card of exposed) {
    const i = rankOf(card) - 2;
    remaining[i] = remaining[i]! - 1;
  }
  const current = rankOf(exposed[exposed.length - 1]!);
  const higher = remaining.reduce(
    (n, count, i) => n + (i + 2 > current ? count : 0),
    0,
  );
  const lower = remaining.reduce(
    (n, count, i) => n + (i + 2 < current ? count : 0),
    0,
  );
  return {
    remaining,
    higher,
    lower,
    equal: remaining[current - 2]!,
    total: 52 - exposed.length,
    current,
  };
}
