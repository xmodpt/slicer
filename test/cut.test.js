import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditableMesh } from '../src/mesh.js';
import { cutWithPins } from '../src/cut.js';
import { volume, consistentlyClosed } from './helpers.js';

const box = (x0, y0, z0, x1, y1, z1) => {
  const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7];
  return f.flatMap((i) => p[i]);
};
const mesh = (...boxes) => EditableMesh.fromSoup(new Float32Array(boxes.flat()));
const parts = (m) => {
  const { component, count } = m.connectedComponents();
  return [...Array(count).keys()].map((c) => m.extractFaces(component.map((x) => (x === c ? 1 : 0))));
};

test('cut a block in half: two closed halves, pin on the lower, hole in the upper', () => {
  const m = mesh(box(0, 0, 0, 20, 20, 40));
  const r = cutWithPins(m, { normal: [0, 0, 1], offset: 20 }, { pins: 1, diameter: 5, length: 8 });
  assert.equal(r.pins.length, 1);
  const pin = r.pins[0];
  assert.ok(Math.abs(pin.diameter - 5) < 1e-9 && Math.abs(pin.length - 8) < 1e-9);
  assert.ok(Math.abs(pin.holeDiameter - 5 * 1.005) < 1e-9, 'hole is 0.5 % wider');
  assert.ok(pin.holeDepth > pin.length);

  const ps = parts(m);
  assert.equal(ps.length, 2);
  for (const p of ps) {
    assert.ok(consistentlyClosed(p), 'each half is closed');
    assert.equal(p.stats().watertight, true);
  }
  const [low, high] = ps.sort((a, b) => a.bounds().min[2] - b.bounds().min[2]);
  // Lower half sticks up by the pin length; its volume is the half plus the pin.
  assert.ok(Math.abs(low.bounds().max[2] - 28) < 1e-4);
  const pinVol = volume(low) - 8000, holeVol = 8000 - volume(high);
  assert.ok(pinVol > 0.95 * Math.PI * 2.5 ** 2 * 8 * 0.9 && pinVol < Math.PI * 2.5 ** 2 * 8, `pin volume ${pinVol}`);
  assert.ok(holeVol > pinVol, 'hole is bigger than the pin');
});

test('two separate pieces crossing the plane each get their own pin', () => {
  const m = mesh(box(0, 0, 0, 15, 15, 30), box(40, 0, 0, 55, 15, 30));
  const r = cutWithPins(m, { normal: [0, 0, 1], offset: 10 }, { pins: 'auto' });
  assert.equal(r.areas, 2);
  assert.equal(r.pins.length, 2);
  const ps = parts(m);
  assert.equal(ps.length, 4);
  for (const p of ps) assert.ok(consistentlyClosed(p));
});

test('a hollow tube cut keeps its inner opening and still gets pins', () => {
  // Square tube: outer 30x30, inner 20x20 (walls 5 thick), 30 high.
  const tube = [];
  const ring = (z) => [[0, 0, z], [30, 0, z], [30, 30, z], [0, 30, z], [5, 5, z], [25, 5, z], [25, 25, z], [5, 25, z]];
  const lo = ring(0), hi = ring(30), P = [...lo, ...hi];
  const q = (a, b, c, d) => tube.push(...[a, b, c, a, c, d].flatMap((i) => P[i]));
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    q(i, j, 8 + j, 8 + i); // outer wall
    q(4 + j, 4 + i, 12 + i, 12 + j); // inner wall
    q(8 + i, 8 + j, 12 + j, 12 + i); // top ring
    q(i, 4 + i, 4 + j, j); // bottom ring
  }
  const t = EditableMesh.fromSoup(new Float32Array(tube));
  assert.ok(consistentlyClosed(t), 'fixture is closed');
  const before = volume(t);
  const r = cutWithPins(t, { normal: [0, 0, 1], offset: 15 }, { pins: 2, diameter: 2, length: 4 });
  assert.equal(r.pins.length, 2);
  for (const p of parts(t)) assert.ok(consistentlyClosed(p));
  // Cut faces are rings: the tube stays hollow, total volume ≈ before (pins vs holes).
  assert.ok(Math.abs(volume(t) - before) < 2, `volume ${volume(t)} vs ${before}`);
});

test('pins are shortened when the upper part is too thin for the hole', () => {
  const m = mesh(box(0, 0, 0, 30, 30, 26));
  const r = cutWithPins(m, { normal: [0, 0, 1], offset: 20 }, { pins: 1, diameter: 6, length: 20 });
  assert.equal(r.pins.length, 1);
  assert.ok(r.pins[0].holeDepth < 6, `hole depth ${r.pins[0].holeDepth} must leave a wall in a 6-high part`);
  for (const p of parts(m)) assert.ok(consistentlyClosed(p));
});

test('a plane that misses the model is rejected and leaves it unchanged', () => {
  const m = mesh(box(0, 0, 0, 10, 10, 10));
  const tris = m.triangleCount;
  assert.throws(() => cutWithPins(m, { normal: [0, 0, 1], offset: 50 }), /does not cut/);
  assert.equal(m.triangleCount, tris);
});

test('a tilted plane cut gives two closed halves with a pin', () => {
  const m = mesh(box(0, 0, 0, 30, 30, 40));
  const n = [0.3, -0.2, 1];
  const l = Math.hypot(...n);
  const normal = n.map((x) => x / l);
  const centre = [15, 15, 20];
  const offset = normal[0] * centre[0] + normal[1] * centre[1] + normal[2] * centre[2];
  const r = cutWithPins(m, { normal, offset }, { pins: 1, diameter: 4, length: 6 });
  assert.equal(r.pins.length, 1);
  const ps = parts(m);
  assert.equal(ps.length, 2);
  for (const p of ps) assert.ok(consistentlyClosed(p));
  assert.ok(Math.abs(volume(m) - 36000) < 15, `volume ${volume(m)}`); // pin ≈ hole
});
