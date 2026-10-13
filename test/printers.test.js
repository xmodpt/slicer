import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRINTERS, fitCheck, validPrinter } from '../src/printers.js';

test('printer profiles are valid and unique', () => {
  assert.ok(PRINTERS.length >= 10);
  assert.ok(PRINTERS.every(validPrinter));
  assert.equal(new Set(PRINTERS.map((p) => p.id)).size, PRINTERS.length);
});

test('fit check: inside, too wide, too tall, below the plate', () => {
  const p = { id: 't', x: 100, y: 60, z: 150 };
  assert.deepEqual(fitCheck(p, { min: [-40, -20, 0], max: [40, 20, 100] }), { fits: true, over: [0, 0, 0] });
  const wide = fitCheck(p, { min: [-60, -10, 0], max: [55, 10, 100] });
  assert.equal(wide.fits, false);
  assert.equal(wide.over[0], 10);
  assert.equal(fitCheck(p, { min: [0, 0, 0], max: [10, 10, 160] }).over[2], 10);
  assert.equal(fitCheck(p, { min: [0, 0, -2], max: [10, 10, 10] }).over[2], 2);
});
