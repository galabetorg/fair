import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  diceChance,
  diceMultiplier,
  chipPayout,
  chipReceipt,
  minesMultiplier,
  plinkoDistribution,
  plinkoRtp,
  kenoDistribution,
  kenoRtp,
  minesNextChance,
  rouletteCoverage,
  wheelGroups,
  publicRuleCatalog,
} from "../src/demo/rules";
import { describeHand, dealerTrace, rankChances } from "../src/demo/card-rules";
import {
  blackjackAnalysisBody,
  GamesController,
} from "../src/demo/games.controller";

test("Dice counts the 32-bit input intervals and excludes equality in both directions", () => {
  const size = 2 ** 32;
  const below = Math.ceil((5000 * size) / 10001);
  const above = size - Math.ceil((5001 * size) / 10001);
  assert.equal(diceChance({ target: 50, over: false }), below / size);
  assert.equal(diceChance({ target: 50, over: true }), above / size);
  assert.ok((below + above) / size < 1);
  assert.equal(diceChance({ target: 0, over: false }), 0);
  assert.equal(diceChance({ target: 100, over: true }), 0);
  assert.throws(() => diceChance({ target: NaN, over: true }));
});

test("Chip receipts distinguish returned stake, net change and integer rounding", () => {
  assert.deepEqual(
    [chipReceipt(100, 0.25, true).returned, chipReceipt(100, 0.25, true).net],
    [25, -75],
  );
  assert.equal(chipReceipt(1, 0.25, true).returned, 0);
  assert.equal(chipReceipt(100, 2, false).net, -100);
  assert.equal(chipReceipt(100, 1.98, true).net, 98);
  assert.throws(() => chipReceipt(1.5, 2, true));
  assert.throws(() => chipReceipt(1, Infinity, true));
});

test("Payouts use integer ten-thousandths, so stored multipliers such as 2.01 pay the full chip", () => {
  // Each pair: Math.floor(stake * multiplier) is one chip short of the exact product.
  assert.equal(Math.floor(100 * 2.01), 200);
  assert.equal(chipPayout(100, 2.01), 201);
  assert.equal(chipReceipt(100, 2.01, true).returned, 201);
  assert.equal(chipReceipt(100, 2.01, true).net, 101);
  assert.equal(chipPayout(100, 2.51), 251); // Plinko 8 rows, bucket 1
  assert.equal(chipPayout(30, 4.1), 123); // Keno 5 picks, 3 hits
  // Four-decimal multipliers (Dice, Mines).
  assert.equal(diceMultiplier({ target: 50, over: true }), 1.9801);
  assert.equal(chipPayout(100, 1.9801), 198);
  assert.equal(chipPayout(10_000, 1.9801), 19_801);
  assert.equal(diceMultiplier({ target: 2.07, over: true }), 1.011);
  assert.equal(Math.floor(1000 * 1.011), 1010);
  assert.equal(chipPayout(1000, 1.011), 1011);
  assert.equal(diceMultiplier({ target: 2.28, over: true }), 1.0131);
  assert.equal(chipPayout(10_000, 1.0131), 10_131);
  assert.equal(minesMultiplier(4, 20), 2504.7);
  assert.equal(chipPayout(100, minesMultiplier(4, 20)), 250_470);
  assert.equal(chipPayout(1250, minesMultiplier(1, 1)), 1289);
  // Still rounds down, and the largest Limbo win stays exact.
  assert.equal(chipPayout(1, 0.25), 0);
  assert.equal(chipPayout(3, 1.2), 3);
  assert.equal(chipPayout(100_000, 999_999.99), 99_999_999_000);
  assert.equal(chipPayout(100_000, 1_000_000), 100_000_000_000);
  assert.throws(() => chipPayout(100, 1.00005), /four decimals/);
  assert.throws(() => chipPayout(1.5, 2), /invalid/);
  assert.throws(() => chipPayout(1, NaN), /invalid/);
});

test("Chip game routes pay and report the exact integer payout", async () => {
  let result: unknown;
  const demo = {
    withSession: (_: string, action: () => unknown) => action(),
    load: async () => ({}),
    deriveRecord: async () => ({ record: { result } }),
  };
  const chips = {
    debit: async () => 0,
    credit: async (_: string, payout: number) => payout,
  };
  const controller = new GamesController(
    demo as any,
    chips as any,
    null as any,
    { demoBets: { inc() {} } } as any,
  );
  const id = randomUUID();
  result = 3;
  const limbo = await controller.limbo(id, { amount: 100, target: 2.01 });
  assert.deepEqual(
    [limbo.payout, limbo.chips, limbo.settlement.returned, limbo.settlement.net],
    [201, 201, 201, 101],
  );
  result = 99;
  const dice = await controller.dice(id, {
    amount: 1000,
    target: 2.07,
    over: true,
  });
  assert.deepEqual([dice.multiplier, dice.payout], [1.011, 1011]);
  const four = await controller.dice(id, {
    amount: 10_000,
    target: 2.28,
    over: true,
  });
  assert.deepEqual([four.multiplier, four.payout], [1.0131, 10_131]);
  result = { path: [], bucket: 1 };
  const plinko = await controller.plinko(id, { amount: 100, rows: 8 });
  assert.deepEqual([plinko.multiplier, plinko.payout], [2.51, 251]);
  result = [1, 2, 3, 10, 11, 12, 13, 14, 15, 16];
  const keno = await controller.keno(id, {
    amount: 30,
    picks: [1, 2, 3, 4, 5],
  });
  assert.deepEqual([keno.hits, keno.multiplier, keno.payout], [3, 4.1, 123]);
  result = 5;
  const wheel = await controller.wheel(id, { amount: 3 });
  assert.deepEqual([wheel.multiplier, wheel.payout], [2, 6]);
  result = 17;
  const roulette = await controller.roulette(id, {
    amount: 7,
    bet: { type: "dozen", dozen: 2 },
  });
  assert.equal(roulette.payout, 21);
  for (const r of [limbo, dice, four, plinko, keno, wheel, roulette])
    assert.equal(r.settlement.returned, r.payout);
});

test("Every supported Plinko distribution normalizes; its edges have one path each", () => {
  for (const rows of [8, 12, 16]) {
    const data = plinkoDistribution(rows);
    assert.equal(data.length, rows + 1);
    assert.equal(
      data.reduce((s, d) => s + d.probability, 0),
      1,
    );
    assert.equal(data[0]!.probability, 1 / 2 ** rows);
    assert.equal(data.at(-1)!.probability, data[0]!.probability);
    assert.ok(
      Math.abs(
        data.reduce((s, d) => s + d.probability * d.multiplier, 0) -
          plinkoRtp(rows),
      ) < 1e-12,
    );
  }
  assert.throws(() => plinkoDistribution(9));
});

test("Keno hit distributions normalize and agree with the configured table returns", () => {
  for (let picks = 1; picks <= 10; picks++) {
    const data = kenoDistribution(picks);
    assert.ok(
      Math.abs(data.reduce((s, d) => s + d.probability, 0) - 1) < 1e-12,
    );
    assert.equal(
      data.reduce((s, d) => s + d.probability * d.multiplier, 0),
      kenoRtp(picks),
    );
  }
  assert.equal(kenoDistribution(1)[1]!.probability, 0.25);
  assert.throws(() => kenoDistribution(0));
});

test("Mines exposes conditional counts and no next probability after the final safe tile", () => {
  assert.equal(minesNextChance(3, 0), 22 / 25);
  assert.equal(minesNextChance(3, 1), 21 / 24);
  assert.equal(minesNextChance(3, 22), null);
  assert.equal(minesNextChance(24, 1), null);
  assert.throws(() => minesNextChance(3, 23));
});

test("Roulette footprints include zero only for its single-pocket selection", () => {
  assert.deepEqual(rouletteCoverage({ type: "straight", number: 0 }), [0]);
  for (const bet of [
    { type: "color", color: "black" },
    { type: "parity", parity: "even" },
    { type: "range", range: "high" },
  ] as const) {
    const covered = rouletteCoverage(bet);
    assert.equal(covered.length, 18);
    assert.ok(!covered.includes(0));
  }
  assert.deepEqual(
    rouletteCoverage({ type: "dozen", dozen: 2 }),
    Array.from({ length: 12 }, (_, i) => i + 13),
  );
  assert.deepEqual(
    rouletteCoverage({ type: "column", column: 2 }),
    Array.from({ length: 12 }, (_, i) => 3 * i + 2),
  );
});

test("Wheel groups preserve all indices and the public catalog describes current capabilities", () => {
  const groups = wheelGroups();
  assert.equal(groups.length, 5);
  assert.deepEqual(groups.find((g) => g.value === 0)!.indices, [0, 4, 8]);
  assert.deepEqual(
    groups.flatMap((g) => g.indices).sort((a, b) => a - b),
    Array.from({ length: 10 }, (_, i) => i),
  );
  const catalog = publicRuleCatalog();
  assert.equal(catalog.blackjack.settlement, false);
  assert.equal(catalog.hilo.settlement, false);
  assert.equal(catalog.plinko.length, 3);
  assert.equal(catalog.keno.length, 10);
  assert.ok(!JSON.stringify(catalog).includes("serverSeed"));
});

test("Dealer analysis handles usable aces, soft-17 policy and exhausted explicit cards", () => {
  assert.deepEqual(describeHand(["AC", "AD", "9C"]), {
    total: 21,
    soft: true,
    bust: false,
    natural: false,
  });
  assert.deepEqual(describeHand(["AC", "AD", "KC"]), {
    total: 12,
    soft: false,
    bust: false,
    natural: false,
  });
  assert.equal(describeHand(["AC", "KC"]).natural, true);
  assert.equal(describeHand(["TC", "KD", "4C"]).bust, true);
  const s17 = dealerTrace(["AC", "6D"], ["4H", "KS"], false),
    h17 = dealerTrace(["AC", "6D"], ["4H", "KS"], true);
  assert.equal(s17.used, 0);
  assert.equal(s17.total, 17);
  assert.equal(h17.used, 1);
  assert.equal(h17.total, 21);
  assert.equal(h17.complete, true);
  assert.deepEqual(h17.cards, ["AC", "6D", "4H"]);
  assert.equal(dealerTrace(["AC", "6D"], [], true).complete, false);
  assert.equal(dealerTrace(["TC", "7D"], ["4H"], true).used, 0);
});

test("Hilo counts only public cards and handles ace and equal-rank boundaries", () => {
  const first = rankChances(["7C"]);
  assert.equal(first.equal, 3);
  assert.equal(first.total, 51);
  assert.equal(first.higher + first.lower + first.equal, 51);
  const ace = rankChances(["7C", "KC", "3S", "AC"]);
  assert.equal(ace.higher, 0);
  assert.equal(ace.equal, 3);
  assert.equal(ace.total, 48);
  assert.throws(() => rankChances(["7C", "7C"]));
  assert.throws(() => rankChances(["1C"]));
});

test("Public Blackjack API parses defaults and returns the documented trace", () => {
  const body = blackjackAnalysisBody.parse({
    hand: ["AC", "6D"],
    following: ["4H", "KS"],
    hitSoft17: true,
  });
  const controller = new GamesController(
    null as any,
    null as any,
    null as any,
    null as any,
  );
  const trace = controller.analyzeBlackjack(body);
  assert.equal(trace.rule, "H17");
  assert.equal(trace.used, 1);
  assert.equal(trace.total, 21);
  assert.equal(trace.mode, "public-input analysis");
  assert.ok(trace.ruleVersion);
  assert.equal(
    blackjackAnalysisBody.parse({ hand: ["TC", "7D"] }).hitSoft17,
    false,
  );
  assert.equal(
    blackjackAnalysisBody.safeParse({ hand: ["XX", "7D"] }).success,
    false,
  );
});
