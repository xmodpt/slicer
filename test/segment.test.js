import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditableMesh } from '../src/mesh.js';
import { segmentObjects } from '../src/segment.js';
import { cakeWithCandles } from '../src/samples.js';
import { sphere, consistentlyClosed } from './helpers.js';

test('cake sample is one fused, watertight part', () => {
  const m = EditableMesh.fromSoup(cakeWithCandles());
  const s = m.stats();
  assert.equal(s.parts, 1);
  assert.equal(s.watertight, true);
  assert.ok(consistentlyClosed(m));
});

test('candles fused to a cake are found as separate objects', () => {
  const m = EditableMesh.fromSoup(cakeWithCandles({ candles: 5 }));
  const seg = segmentObjects(m);
  assert.equal(seg.objects.length, 6, `found ${seg.objects.length} objects`);
  // The cake is the biggest; the five candles are identical in size.
  const candles = seg.objects.slice(1);
  for (const c of candles) assert.equal(c.triangles, candles[0].triangles);
  // Each candle: 4 walls of 10 voxels * 2 voxels wide * 2 tris + top 4 * 2 tris.
  assert.equal(candles[0].triangles, 4 * 10 * 2 * 2 + 8);

  // Every candle triangle sits above the cake top (z >= 8).
  const p = m.positions;
  for (const t of seg.facesOf(candles[0].id)) {
    for (let k = 0; k < 3; k++) assert.ok(p[m.indices[t * 3 + k] * 3 + 2] >= 8);
  }
});

test('deleting a candle and closing the hole', () => {
  const m = EditableMesh.fromSoup(cakeWithCandles({ candles: 3 }));
  const seg = segmentObjects(m);
  const mask = new Uint8Array(m.triangleCount);
  for (const t of seg.facesOf(seg.objects[1].id)) mask[t] = 1;
  m.deleteFaces(mask);
  assert.equal(m.stats().holes, 1);
  m.fillHoles();
  assert.ok(consistentlyClosed(m));
  assert.equal(segmentObjects(m).objects.length, 3);
});

test('smooth convex shapes stay a single object', () => {
  assert.equal(segmentObjects(sphere(24, 32)).objects.length, 1);
});

test('separate shells are separate objects', () => {
  const a = sphere(12, 16).toSoup();
  const b = a.map((v, i) => (i % 3 === 0 ? v + 5 : v));
  const soup = new Float32Array(a.length * 2);
  soup.set(a); soup.set(b, a.length);
  const seg = segmentObjects(EditableMesh.fromSoup(soup));
  assert.equal(seg.objects.length, 2);
  assert.ok(Math.abs(seg.objects[0].share - 0.5) < 1e-6);
});
