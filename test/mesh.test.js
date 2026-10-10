import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditableMesh } from '../src/mesh.js';
import { parseSTL, writeBinarySTL } from '../src/stl.js';
import { cube, sphere, volume, consistentlyClosed } from './helpers.js';

test('closed meshes report no holes', () => {
  const s = cube().stats();
  assert.equal(s.holes, 0);
  assert.equal(s.watertight, true);
  assert.equal(s.parts, 1);
  assert.equal(sphere().stats().watertight, true);
});

test('deleting a cube face leaves one square hole that fills back watertight', () => {
  const m = cube();
  const mask = new Uint8Array(m.triangleCount);
  mask[2] = mask[3] = 1; // top face
  assert.equal(m.deleteFaces(mask), 2);
  const { loops } = m.boundaryLoops();
  assert.equal(loops.length, 1);
  assert.equal(loops[0].length, 4);

  const res = m.fillHoles();
  assert.equal(res.filled, 1);
  assert.equal(m.triangleCount, 12);
  assert.ok(consistentlyClosed(m));
  assert.ok(Math.abs(volume(m) - 1) < 1e-6);
});

test('cutting the top off a sphere and closing it gives a flat, outward cap', () => {
  const m = sphere(16, 24);
  const before = volume(m);
  const p = m.positions;
  const mask = new Uint8Array(m.triangleCount);
  for (let t = 0; t < m.triangleCount; t++) {
    const zs = [0, 1, 2].map((k) => p[m.indices[t * 3 + k] * 3 + 2]);
    if (Math.min(...zs) > 0.5) mask[t] = 1;
  }
  m.deleteFaces(mask);
  assert.equal(m.stats().holes, 1);
  m.fillHoles();
  const s = m.stats();
  assert.equal(s.holes, 0);
  assert.equal(s.watertight, true);
  assert.ok(consistentlyClosed(m));
  const after = volume(m);
  assert.ok(after > 0 && after < before, `volume ${after} should be positive and below ${before}`);
});

test('multiple holes, and maxEdges limits which ones get closed', () => {
  const m = sphere(16, 24);
  const p = m.positions;
  const mask = new Uint8Array(m.triangleCount);
  for (let t = 0; t < m.triangleCount; t++) {
    const xs = [0, 1, 2].map((k) => p[m.indices[t * 3 + k] * 3]);
    const zs = [0, 1, 2].map((k) => p[m.indices[t * 3 + k] * 3 + 2]);
    if (Math.min(...xs) > 0.9) mask[t] = 1; // small hole on the side
    if (Math.max(...zs) < -0.3) mask[t] = 1; // big hole at the bottom
  }
  m.deleteFaces(mask);
  const { loops } = m.boundaryLoops();
  assert.equal(loops.length, 2);
  const small = Math.min(...loops.map((l) => l.length));
  const r = m.fillHoles({ maxEdges: small });
  assert.equal(r.filled, 1);
  assert.equal(r.skipped, 1);
  assert.equal(m.stats().holes, 1);
  m.fillHoles();
  assert.ok(consistentlyClosed(m));
});

test('non-planar holes still close consistently', () => {
  // Remove a diagonal band so the hole rim is a saddle-shaped curve.
  const m = sphere(20, 32);
  const p = m.positions;
  const mask = new Uint8Array(m.triangleCount);
  for (let t = 0; t < m.triangleCount; t++) {
    let x = 0, z = 0;
    for (let k = 0; k < 3; k++) { x += p[m.indices[t * 3 + k] * 3]; z += p[m.indices[t * 3 + k] * 3 + 2]; }
    if (x / 3 + z / 3 > 0.6) mask[t] = 1;
  }
  m.deleteFaces(mask);
  m.fillHoles();
  assert.ok(consistentlyClosed(m));
  assert.ok(volume(m) > 0);
});

test('connected parts and selection helpers', () => {
  const a = cube().toSoup();
  const b = cube().toSoup().map((v, i) => (i % 3 === 0 ? v + 3 : v));
  const soup = new Float32Array(a.length + b.length);
  soup.set(a); soup.set(b, a.length);
  const m = EditableMesh.fromSoup(soup);
  assert.equal(m.vertexCount, 16);
  assert.equal(m.stats().parts, 2);

  const mask = new Uint8Array(m.triangleCount);
  m.selectConnected([0], mask);
  assert.equal(mask.reduce((s, v) => s + v, 0), 12);

  const flat = new Uint8Array(m.triangleCount);
  m.selectSmoothRegion(0, 10, flat);
  assert.equal(flat.reduce((s, v) => s + v, 0), 2); // one square side

  m.growSelection(flat);
  assert.ok(flat.reduce((s, v) => s + v, 0) > 2);
  const one = new Uint8Array(m.triangleCount);
  one[0] = 1;
  m.shrinkSelection(one);
  assert.equal(one.reduce((s, v) => s + v, 0), 0);
});

test('STL binary round trip and ASCII parsing', () => {
  const m = sphere(8, 12);
  const buf = writeBinarySTL(m.positions, m.indices);
  const soup = parseSTL(buf);
  const back = EditableMesh.fromSoup(soup);
  assert.equal(back.triangleCount, m.triangleCount);
  assert.equal(back.vertexCount, m.vertexCount);
  assert.equal(back.stats().watertight, true);

  const ascii = `solid t
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 1 0
 endloop
endfacet
endsolid t`;
  const tri = parseSTL(new TextEncoder().encode(ascii).buffer);
  assert.deepEqual([...tri], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
});

test('placing on the plate puts the centre of mass at x=y=0 and the bottom at z=0', async () => {
  const m = cube();
  m.translate(10, -4, 7);
  m.placeOnPlate();
  const { center, minZ } = m.centerOfMass();
  assert.ok(Math.abs(center[0]) < 1e-6 && Math.abs(center[1]) < 1e-6);
  assert.ok(Math.abs(minZ) < 1e-6);
  assert.ok(Math.abs(center[2] - 0.5) < 1e-6);

  // An L shape: the centre of mass is not the bounding-box centre.
  const soup = new Float32Array([...cube().toSoup(), ...cube().toSoup().map((v, i) => (i % 3 === 0 ? v + 1 : v))]);
  const two = EditableMesh.fromSoup(soup); // 2x1x1 bar made of two cubes
  two.placeOnPlate();
  const c2 = two.centerOfMass().center;
  assert.ok(Math.abs(c2[0]) < 1e-6 && Math.abs(c2[1]) < 1e-6);

  // async welding gives the same mesh and reports progress
  const big = sphere(200, 260).toSoup();
  const progress = [];
  const a = await EditableMesh.fromSoupAsync(big, { onProgress: (f) => progress.push(f) });
  const b = EditableMesh.fromSoup(big);
  assert.equal(a.vertexCount, b.vertexCount);
  assert.deepEqual(a.indices, b.indices);
  assert.ok(progress.length > 0 && progress.every((f) => f > 0 && f < 1));
});

test('rotate and lay flat', () => {
  // Rotating a cube 90° about Z around its centre maps it onto itself.
  const m = cube();
  m.rotate([0, 0, 1], Math.PI / 2, [0.5, 0.5, 0.5]);
  const { min, max } = m.bounds();
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(min[k]) < 1e-6 && Math.abs(max[k] - 1) < 1e-6);
  }
  assert.ok(Math.abs(volume(m) - 1) < 1e-6);

  // A tilted 2x1x1 bar: laying it on its long side face ends with that face
  // on the plate and the bar 1 high.
  const soup = new Float32Array([...cube().toSoup(), ...cube().toSoup().map((v, i) => (i % 3 === 0 ? v + 1 : v))]);
  const bar = EditableMesh.fromSoup(soup);
  bar.rotate([1, 1, 0.3], 0.9, [1, 0.5, 0.5]);
  // Face 0 is on the original bottom (z = 0) side; its flat area covers both cubes' bottoms.
  const { normal, faces } = bar.flatAreaNormal(0);
  assert.equal(faces.reduce((a, b) => a + b, 0), 4);
  bar.layFlat(normal);
  const b = bar.bounds();
  assert.ok(Math.abs(b.min[2]) < 1e-5 && Math.abs(b.max[2] - 1) < 1e-5, `height ${b.max[2] - b.min[2]}`);
  // The chosen face is now the bottom: all its vertices at z = 0.
  for (let t = 0; t < bar.triangleCount; t++) {
    if (!faces[t]) continue;
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(bar.positions[bar.indices[t * 3 + k] * 3 + 2]) < 1e-5);
  }
  assert.ok(Math.abs(volume(bar) - 2) < 1e-5);

  // Laying an upward-facing face flat flips the model over.
  const up = cube();
  up.layFlat([0, 0, 1]);
  assert.ok(Math.abs(up.bounds().min[2]) < 1e-6 && Math.abs(volume(up) - 1) < 1e-6);
});

test('scale around a pivot', () => {
  const m = cube();
  m.scale(2, 3, 0.5, [0, 0, 0]);
  const b = m.bounds();
  assert.deepEqual(b.max.map((v) => +v.toFixed(6)), [2, 3, 0.5]);
  assert.ok(Math.abs(volume(m) - 3) < 1e-6);
  // Inch to mm
  const i = cube();
  i.scale(25.4, 25.4, 25.4, [0.5, 0.5, 0]);
  assert.ok(Math.abs(i.bounds().min[2]) < 1e-6, 'stays on the plate');
  assert.ok(Math.abs(volume(i) - 25.4 ** 3) < 1e-2);
});
