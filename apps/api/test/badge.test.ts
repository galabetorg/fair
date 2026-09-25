import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBadge } from '../src/badge/badge.render';

test('active badge is gold and names the spec', () => {
  const svg = renderBadge('active', 'GFS/1.0');
  assert.match(svg, /^<svg /);
  assert.ok(svg.includes('#F2B84B'));
  assert.ok(svg.includes('GFS/1.0 verified'));
  assert.ok(!svg.includes('gradient'));
});

test('revoked and unknown badges are grey and say so', () => {
  assert.ok(renderBadge('revoked').includes('revoked'));
  assert.ok(renderBadge('unknown').includes('not listed'));
  assert.ok(renderBadge('pending').includes('pending'));
});

test('notary flag appends to the value', () => {
  assert.ok(renderBadge('active', 'GFS/1.0', true).includes('+ notary'));
});
