import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelInfo, resinUse, overhangs, bestOrientation, wallThickness } from '../src/analysis.js';
import { EditableMesh } from '../src/mesh.js';

function box(x0, y0, z0, x1, y1, z1) {
  const p = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  const idx = [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 2,3,7, 2,7,6, 1,2,6, 1,6,5, 3,0,4, 3,4,7];
  return { p, idx };
}
const mesh = (...boxes) => {
  const pos = [], idx = [];
  for (const b of boxes) { const base = pos.length; pos.push(...b.p); idx.push(...b.idx.map((i) => i + base)); }
  return new EditableMesh(new Float32Array(pos.flat()), new Uint32Array(idx));
};

test('volume, area and resin', () => {
  const m = mesh(box(0, 0, 0, 10, 20, 30));
  const info = modelInfo(m);
  assert.ok(Math.abs(info.volume - 6000) < 1e-6);
  assert.ok(Math.abs(info.area - 2 * (200 + 300 + 600)) < 1e-6);
  const r = resinUse(info.volume, { density: 1.1, pricePerKg: 30 });
  assert.ok(Math.abs(r.ml - 6) < 1e-9 && Math.abs(r.grams - 6.6) < 1e-9 && Math.abs(r.cost - 0.198) < 1e-9);
});

test('overhangs: the underside of a T-shape needs support, the part on the plate does not', () => {
  // A post with a wide slab on top: the slab's underside overhangs.
  const m = mesh(box(4, 4, 0, 6, 6, 10), box(0, 0, 10, 10, 10, 12));
  const { area } = overhangs(m);
  assert.ok(Math.abs(area - (100 - 4)) < 1e-6 || Math.abs(area - 100) < 1e-6, `area ${area}`);
  // A better turn leaves (almost) nothing overhanging – the boxes overlap,
  // so the post's hidden top face may still count (4 mm²).
  const best = bestOrientation(m);
  assert.equal(best.before.area, 100);
  assert.ok(best.area <= 4 + 1e-6, `best area ${best.area}`);
});

test('wall thickness: the walls of a box are as thick as the box', () => {
  const m = mesh(box(0, 0, 0, 2, 20, 20));
  const th = wallThickness(m);
  const P = m.positions, I = m.indices;
  for (let t = 0; t < m.triangleCount; t++) {
    const xs = [0, 1, 2].map((k) => P[I[t * 3 + k] * 3]);
    if (xs.every((x) => x === 0) || xs.every((x) => x === 2)) assert.ok(Math.abs(th[t] - 2) < 1e-3, `side wall ${th[t]}`);
  }
});

test('wall thickness leaves the mesh untouched', () => {
  const m = mesh(box(0, 0, 0, 2, 20, 20), box(10, 0, 0, 13, 5, 5));
  const before = m.indices.slice();
  wallThickness(m);
  assert.deepEqual(m.indices, before);
});
