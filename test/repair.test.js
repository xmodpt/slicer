import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, repair, selfIntersections, mirror, smooth } from '../src/repair.js';
import { EditableMesh } from '../src/mesh.js';

const BOX = [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 2,3,7, 2,7,6, 1,2,6, 1,6,5, 3,0,4, 3,4,7];
const boxPts = (x0, y0, z0, x1, y1, z1) => [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
const mesh = (pts, idx) => new EditableMesh(new Float32Array(pts.flat()), new Uint32Array(idx));

test('a clean box needs nothing', () => {
  const d = diagnose(mesh(boxPts(0, 0, 0, 1, 1, 1), BOX));
  assert.deepEqual(d, { degenerate: 0, duplicate: 0, sheet: 0, flipped: 0, crossing: [] });
});

test('flipped faces, an inside-out box, duplicates and zero-size faces are repaired', () => {
  const idx = BOX.slice();
  [idx[3], idx[4]] = [idx[4], idx[3]]; // one face the wrong way
  idx.push(0, 2, 1); // duplicate
  idx.push(0, 1, 1); // zero-size (repeated corner)
  const m = mesh(boxPts(0, 0, 0, 1, 1, 1), idx);
  const d = diagnose(m);
  assert.equal(d.flipped, 1);
  assert.equal(d.duplicate, 1);
  assert.equal(d.degenerate, 1);
  const r = repair(m);
  assert.deepEqual(r, { degenerate: 1, duplicate: 1, sheet: 0, flipped: 1 });
  assert.equal(m.triangleCount, 12);
  assert.ok(m.stats().watertight);
  assert.equal(diagnose(m).flipped, 0);
  // Whole box inside out: turned outward.
  const inv = mesh(boxPts(0, 0, 0, 1, 1, 1), BOX.map((v, i) => (i % 3 === 1 ? BOX[i + 1] : i % 3 === 2 ? BOX[i - 1] : v)));
  assert.equal(diagnose(inv).flipped, 12);
  repair(inv);
  assert.equal(diagnose(inv).flipped, 0);
});

test('two boxes passing through each other are found', () => {
  const pts = [...boxPts(0, 0, 0, 2, 2, 2), ...boxPts(1, 1, 1, 3, 3, 3)];
  const idx = [...BOX, ...BOX.map((v) => v + 8)];
  const hits = selfIntersections(mesh(pts, idx));
  assert.ok(hits.length > 0);
  const apart = [...boxPts(0, 0, 0, 1, 1, 1), ...boxPts(2, 2, 2, 3, 3, 3)];
  assert.equal(selfIntersections(mesh(apart, idx)).length, 0);
});

test('mirror keeps the box closed and facing out; smooth rounds without shrinking much', () => {
  const m = mesh(boxPts(1, 0, 0, 3, 1, 1), BOX);
  mirror(m, 0, [0, 0, 0]);
  assert.equal(diagnose(m).flipped, 0);
  assert.ok(m.bounds().max[0] <= -1 + 1e-6);
  const before = m.bounds();
  smooth(m, { passes: 3 });
  const after = m.bounds();
  assert.ok(m.stats().watertight);
  assert.ok(after.max[0] - after.min[0] > (before.max[0] - before.min[0]) * 0.6);
});
