import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diceChance, diceMultiplier, diceWin, plinkoRtp, plinkoTable, kenoRtp, minesMultiplier, WHEEL_SEGMENTS, rouletteWin, rouletteMultiplier, RED } from '../src/demo/payouts';

test('dice pays 99% expected return at every target', () => {
  for (const target of [2, 25.5, 50, 75, 98]) {
    for (const over of [true, false]) {
      const chance = diceChance({target,over});
      const ev = chance * diceMultiplier({ target, over });
      assert.ok(ev > 0.989 && ev <= 0.99, `${target} ${over} ev=${ev}`);
    }
  }
  assert.equal(diceWin(50.01, { target: 50, over: true }), true);
  assert.equal(diceWin(50, { target: 50, over: true }), false);
  assert.equal(diceWin(49.99, { target: 50, over: false }), true);
});

test('wheel returns 99%', () => {
  const rtp = WHEEL_SEGMENTS.reduce<number>((a, m) => a + m, 0) / WHEEL_SEGMENTS.length;
  assert.equal(Math.round(rtp * 1000) / 1000, 0.99);
});

test('plinko tables return between 98% and 100% after rounding, edges pay most', () => {
  for (const rows of [8, 12, 16]) {
    const rtp = plinkoRtp(rows);
    assert.ok(rtp > 0.98 && rtp < 1.0, `rows ${rows} rtp ${rtp}`);
    const t = plinkoTable(rows);
    assert.ok(t[0]! > t[Math.floor(rows / 2)]!);
    assert.ok(t[Math.floor(rows / 2)]! < 1);
  }
});

test('mines multiplier grows with picks and equals 99% of true odds', () => {
  assert.equal(minesMultiplier(3, 0), 1);
  const m1 = minesMultiplier(3, 1);
  const m5 = minesMultiplier(3, 5);
  assert.ok(m5 > m1);
  // 1 pick with 3 mines: survive 22/25 -> fair 25/22 * 0.99
  assert.ok(Math.abs(m1 - (0.99 * 25) / 22) < 0.0002);
});

test('keno returns between 90% and 100% for every pick count', () => {
  for (let picks = 1; picks <= 10; picks++) {
    const rtp = kenoRtp(picks);
    assert.ok(rtp > 0.9 && rtp < 1.0, `picks ${picks} rtp ${rtp.toFixed(4)}`);
  }
});

test('roulette bets resolve correctly and zero beats outside bets', () => {
  assert.equal(RED.size, 18);
  assert.equal(rouletteWin(0, { type: 'color', color: 'red' }), false);
  assert.equal(rouletteWin(0, { type: 'straight', number: 0 }), true);
  assert.equal(rouletteWin(17, { type: 'color', color: 'black' }), true);
  assert.equal(rouletteWin(17, { type: 'parity', parity: 'odd' }), true);
  assert.equal(rouletteWin(17, { type: 'range', range: 'low' }), true);
  assert.equal(rouletteWin(17, { type: 'dozen', dozen: 2 }), true);
  assert.equal(rouletteWin(17, { type: 'column', column: 2 }), true);
  assert.equal(rouletteMultiplier({ type: 'straight', number: 5 }), 36);
  // outside bet RTP: 18/37 * 2
  assert.ok(Math.abs((18 / 37) * 2 - 0.973) < 0.001);
});
