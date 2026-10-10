import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditableMesh } from '../src/mesh.js';
import { cutWithPins, analyzeCut } from '../src/cut.js';
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
  assert.equal(r.areas.length, 2);
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

test('thin walls still get connectors', () => {
  for (const t of [4, 3]) {
    const m = mesh(box(0, 0, 0, 100, t, 40));
    const r = cutWithPins(m, { normal: [0, 0, 1], offset: 20 }, {});
    assert.ok(r.pins.length >= 2, `${t} mm wall: ${r.pins.length} connectors – ${r.areas[0].notes.join(' ')}`);
    assert.ok(r.pins[0].diameter <= t - 1.2, 'leaves walls around the hole');
    for (const p of parts(m).filter((p) => p.triangleCount > 40)) assert.ok(consistentlyClosed(p));
  }
});

test('inside-out models are cut and get connectors too', () => {
  const soup = box(0, 0, 0, 30, 30, 40);
  for (let i = 0; i < soup.length; i += 9) for (let k = 0; k < 3; k++) [soup[i + 3 + k], soup[i + 6 + k]] = [soup[i + 6 + k], soup[i + 3 + k]];
  const m = mesh(soup);
  const r = cutWithPins(m, { normal: [0, 0, 1], offset: 20 }, {});
  assert.equal(r.pins.length, 1);
  for (const p of parts(m)) assert.ok(consistentlyClosed(p), 'consistent with the rest of the model');
  assert.ok(volume(m) < 0, 'still inside-out, as it came');
});

test('dowels: holes on both halves plus a separate dowel part', () => {
  const m = mesh(box(0, 0, 0, 30, 30, 40));
  const r = cutWithPins(m, { normal: [0, 0, 1], offset: 20 }, { type: 'dowel', pins: 2, diameter: 5, length: 6 });
  assert.equal(r.pins.length, 2);
  assert.ok(r.pins.every((p) => p.kind === 'dowel' && Math.abs(p.length - 12) < 1e-9));
  const ps = parts(m);
  assert.equal(ps.length, 4); // two halves + two dowels
  for (const p of ps) assert.ok(consistentlyClosed(p));
  // Both halves lost the hole volume; the dowels are separate.
  const [d1, d2] = r.dowelFaces;
  assert.equal(d2 - d1, 2 * 32 * 8);
  const halves = ps.filter((p) => p.bounds().max[0] <= 30 + 1e-6);
  assert.equal(halves.length, 2);
  for (const h of halves) assert.ok(volume(h) < 18000);
});

test('dowels lie on the plate right beside the model', () => {
  const m = mesh(box(0, 0, 5, 30, 30, 45)); // model bottom at z = 5
  const r = cutWithPins(m, { normal: [0, 0, 1], offset: 25 }, { type: 'dowel', pins: 2, diameter: 5, length: 6 });
  const dowels = parts(m).filter((p) => p.bounds().min[0] > 30);
  assert.equal(dowels.length, r.pins.length);
  for (const d of dowels) {
    const b = d.bounds();
    assert.ok(Math.abs(b.min[2] - 5) < 1e-4, 'resting on the plate');
    assert.ok(b.min[0] < 30 + 10, 'near the model');
    assert.ok(b.min[1] >= -1e-6 && b.max[1] <= 30 + 1e-6, 'within the model depth');
  }
});

test('analyzeCut reports the plan without changing the mesh', () => {
  const m = mesh(box(0, 0, 0, 100, 4, 40), box(0, 20, 0, 1, 21, 40));
  const tris = m.triangleCount;
  const a = analyzeCut(m, { normal: [0, 0, 1], offset: 20 }, {});
  assert.equal(m.triangleCount, tris);
  assert.equal(a.areas.length, 2);
  assert.ok(a.areas[0].connectors.length >= 2);
  assert.equal(a.areas[1].connectors.length, 0);
  assert.match(a.areas[1].notes.join(' '), /Too thin/);
});

test('messy models: double faces, inner faces and overlapping pieces still get connectors', () => {
  const wall = box(0, 0, 0, 80, 10, 40);
  // a duplicated side face (non-manifold edges)
  let m = mesh([...wall, ...wall.slice(36, 54)]);
  let r = cutWithPins(m, { normal: [0, 0, 1], offset: 20 }, { type: 'pin' });
  assert.ok(r.pins.length >= 2, 'double face');
  // an inner face splitting the wall
  m = mesh([...wall, 40, 0, 0, 40, 10, 0, 40, 10, 40, 40, 0, 0, 40, 10, 40, 40, 0, 40]);
  r = analyzeCut(m, { normal: [0, 0, 1], offset: 20 }, {});
  assert.ok(r.pins.length >= 2, 'inner face');
  assert.ok(!r.notes.some((n) => /gap/.test(n)), 'inner faces are not gaps');
  // a brick overlapping the wall: no connector inside the overlap
  m = mesh([...wall, ...box(30, -2, 10, 50, 4, 30)]);
  r = analyzeCut(m, { normal: [0, 0, 1], offset: 20 }, {});
  for (const a of r.areas) {
    for (const c of a.connectors) {
      const [x, y] = [c.center3[0], c.center3[1]];
      const inWall = x > 0 && x < 80 && y > 0 && y < 10, inBrick = x > 30 && x < 50 && y > -2 && y < 4;
      assert.ok(!(inWall && inBrick), `connector at ${x.toFixed(1)},${y.toFixed(1)} is in the overlap`);
    }
  }
});

test('manual connectors: placed where asked, each checked', () => {
  const m = mesh(box(0, 0, 0, 60, 20, 40));
  const plane = { normal: [0, 0, 1], offset: 20 };
  const opts = { manual: [[15, 10, 20], [45, 10, 20], [59.5, 10, 20], [200, 10, 20], [16, 10, 20]] };
  const a = analyzeCut(m, plane, opts);
  const [good1, good2, edge, outside, crowded] = a.manual;
  assert.ok(good1.ok && good2.ok, good1.reason + ' / ' + good2.reason);
  assert.ok(!edge.ok && /edge/.test(edge.reason));
  assert.ok(!outside.ok && /cut face/.test(outside.reason));
  assert.ok(!crowded.ok && /another connector/.test(crowded.reason));
  assert.equal(a.pins.length, 2);
  const r = cutWithPins(m, plane, opts);
  assert.equal(r.pins.length, 2);
  // The pins stand where they were placed.
  const c = r.areas[0].connectors.map((k) => k.center3.map((x) => +x.toFixed(6)));
  assert.deepEqual(c.sort((p, q) => p[0] - q[0]), [[15, 10, 20], [45, 10, 20]]);
  for (const p of parts(m)) assert.ok(consistentlyClosed(p));
});
