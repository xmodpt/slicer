import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditableMesh } from '../src/mesh.js';
import { findFloatingParts } from '../src/floating.js';

const box = (x0, y0, z0, x1, y1, z1) => {
  const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7];
  return f.flatMap((i) => p[i]);
};
// A slab leaning at 45° around the Y axis, its lower edge on the plate.
const leaning = () => {
  const s = box(0, 0, 0, 10, 50, 100);
  for (let i = 0; i < s.length; i += 3) {
    const x = s[i], z = s[i + 2];
    s[i] = (x + z) * Math.SQRT1_2;
    s[i + 2] = (z - x) * Math.SQRT1_2 + 10 * Math.SQRT1_2;
  }
  return s;
};
const floatingOf = (...soups) => {
  const m = EditableMesh.fromSoup(new Float32Array(soups.flat()));
  return findFloatingParts(m, m.parts()).map((p) => m.boundsOfFaces(p.faces));
};

test('a piece floating inside a tilted wall\'s bounding box is found', () => {
  // The wall's box spans x 0..78, z 0..78; the small cube floats in it, away from the wall.
  const f = floatingOf(leaning(), box(60, 20, 10, 63, 23, 13));
  assert.equal(f.length, 1);
  assert.ok(Math.abs(f[0].min[0] - 60) < 1e-4);
});

test('pieces touching a supported part, or stacked, are not floating', () => {
  assert.equal(floatingOf(box(0, 0, 0, 20, 20, 20), box(5, 5, 20, 10, 10, 40)).length, 0, 'stacked');
  assert.equal(floatingOf(box(0, 0, 0, 20, 20, 20), box(20, 5, 10, 30, 10, 15)).length, 0, 'glued to the side');
  assert.equal(floatingOf(box(0, 0, 0, 20, 20, 20), box(18, 5, 10, 30, 10, 15)).length, 0, 'sunk into the side');
  assert.equal(floatingOf(box(0, 0, 0, 20, 20, 20), box(40, 0, 0, 50, 10, 10)).length, 0, 'beside it on the plate');
});

test('a piece enclosed in the solid is not floating; one hovering above is', () => {
  assert.equal(floatingOf(box(0, 0, 0, 20, 20, 20), box(5, 5, 5, 10, 10, 10)).length, 0, 'inside');
  assert.equal(floatingOf(box(0, 0, 0, 20, 20, 20), box(5, 5, 25, 10, 10, 30)).length, 1, 'above');
});
