import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditableMesh } from '../src/mesh.js';
import { findNeckAt, findNecks, seamLoop, cutAlongLoop, neckFromPainting } from '../src/neck.js';
import { volume, consistentlyClosed } from './helpers.js';

// A closed surface of revolution around Z from a profile [[radius, z], …]
// (first and last radius 0), with `seg` steps around.
function lathe(profile, seg = 48) {
  const pos = [], idx = [];
  const ring = [];
  for (const [r, z] of profile) {
    if (r === 0) {
      ring.push([pos.length / 3]);
      pos.push(0, 0, z);
      continue;
    }
    const ids = [];
    for (let i = 0; i < seg; i++) {
      const a = (2 * Math.PI * i) / seg;
      ids.push(pos.length / 3);
      pos.push(r * Math.cos(a), r * Math.sin(a), z);
    }
    ring.push(ids);
  }
  for (let j = 0; j + 1 < ring.length; j++) {
    const A = ring[j], B = ring[j + 1];
    for (let i = 0; i < seg; i++) {
      const i1 = (i + 1) % seg;
      if (A.length === 1) idx.push(A[0], B[i1], B[i]);
      else if (B.length === 1) idx.push(A[i], A[i1], B[0]);
      else idx.push(A[i], A[i1], B[i1], A[i], B[i1], B[i]);
    }
  }
  return new EditableMesh(new Float32Array(pos), new Uint32Array(idx));
}

// Body (r 20, up to z 40), narrowing to a neck (r 6 at z 50), head (r 15 around z 65).
const figure = () => {
  const p = [[0, 0]];
  for (let z = 0; z <= 40; z += 4) p.push([20, z]);
  for (let z = 42; z <= 80; z += 2) {
    const neck = 6 + 14 * ((z - 50) / 10) ** 2; // narrowest at z 50
    const head = z >= 50 ? Math.sqrt(Math.max(0, 15 ** 2 - (z - 65) ** 2)) : 0;
    p.push([Math.max(0.5, z < 50 ? Math.min(20, neck) : Math.max(Math.min(neck, 20), head) || 0.5), z]);
  }
  p.push([0, 80]);
  return lathe(p);
};

const parts = (m) => m.parts().map((p) => m.extractFaceList(p.faces));

test('the neck is found from a click near it, and by searching the whole model', () => {
  const m = figure();
  assert.ok(consistentlyClosed(m), 'fixture is closed');
  const neck = findNeckAt(m, [6.5, 0, 52]);
  assert.ok(neck, 'found');
  assert.ok(Math.abs(Math.abs(neck.normal[2]) - 1) < 0.05, `axis ${neck.normal}`);
  assert.ok(Math.abs(neck.center[2] - 50) < 2.5, `height ${neck.center[2]}`);
  assert.ok(Math.abs(neck.radius - 6) < 1.5, `radius ${neck.radius}`);
  const all = findNecks(m);
  assert.ok(all.length >= 1);
  assert.ok(Math.abs(all[0].center[2] - 50) < 3, `auto neck at ${all[0].center[2]}`);
});

test('cutting along the neck gives two closed pieces with the same volume in total', () => {
  const m = figure();
  const before = volume(m);
  const neck = findNeckAt(m, [6.5, 0, 52]);
  const loop = seamLoop(m, neck, { follow: 0.6 });
  assert.ok(loop && loop.length >= 24, 'a loop around the neck');
  const r = cutAlongLoop(m, loop, neck);
  const ps = parts(m);
  assert.equal(ps.length, 2);
  for (const p of ps) assert.ok(consistentlyClosed(p), 'each piece is closed');
  assert.ok(Math.abs(volume(m) - before) < before * 1e-6, 'nothing lost');
  // The head is the piece split off (the smaller side), above the neck.
  const head = m.boundsOfFaces([...r.faces.keys()].filter((t) => r.faces[t]));
  assert.ok(head.min[2] > 40, `head starts at ${head.min[2]}`);
});

test('the cut line follows a crease near the neck', () => {
  // A collar: the radius jumps from 6 to 9 at z 46 – a sharp concave crease –
  // with the narrowest ring a bit higher at z 50.
  const p = [[0, 0]];
  for (let z = 0; z <= 40; z += 4) p.push([20, z]);
  p.push([9, 40], [9, 46], [6.2, 46]);
  for (let z = 47; z <= 54; z += 1) p.push([6 + 0.02 * (z - 50) ** 2, z]);
  for (let z = 56; z <= 78; z += 2) p.push([Math.max(1, Math.sqrt(Math.max(0, 15 ** 2 - (z - 66) ** 2))), z]);
  p.push([0, 80]);
  const m = lathe(p);
  const neck = findNeckAt(m, [6, 0, 50]);
  assert.ok(neck);
  const zOf = (loop) => loop.reduce((s, v) => s + m.positions[v * 3 + 2], 0) / loop.length;
  const flat = seamLoop(m, neck, { follow: 0 });
  const crease = seamLoop(m, neck, { follow: 1, width: 1.2 });
  const half = seamLoop(m, neck, { follow: 0.5, width: 1.2 });
  assert.ok(half);
  assert.ok(flat && crease);
  assert.ok(Math.abs(zOf(crease) - 46) < 0.5, `crease loop at z ${zOf(crease)}`);
  assert.ok(Math.abs(zOf(flat) - 46) > Math.abs(zOf(crease) - 46), 'following creases moves the line onto the crease');
  const before = volume(m);
  cutAlongLoop(m, crease, neck);
  const ps = parts(m);
  assert.equal(ps.length, 2);
  for (const piece of ps) assert.ok(consistentlyClosed(piece), 'each piece is closed');
  assert.ok(Math.abs(volume(m) - before) < before * 1e-6);
});

test('neck cut with a round or square pin: pin on one piece, matching hole in the other', () => {
  for (const shape of ['round', 'square']) {
    const m = figure();
    const before = volume(m);
    const neck = findNeckAt(m, [6.5, 0, 52]);
    const loop = seamLoop(m, neck, { follow: 0.6 });
    const r = cutAlongLoop(m, loop, neck, { shape, tolerance: 0.2, taper: 1 });
    assert.ok(r.connector, `${shape}: ${r.note}`);
    const c = r.connector;
    assert.ok(Math.abs(c.holeSize - c.size - 0.2) < 1e-9, 'hole 0.2 mm wider');
    assert.ok(c.holeDepth > c.length, 'hole deeper than the pin');
    const ps = parts(m);
    assert.equal(ps.length, 2, shape);
    for (const p of ps) assert.ok(consistentlyClosed(p), `${shape}: each piece is closed`);
    // The pin adds a little, the slightly bigger hole removes a little more.
    const pin = shape === 'square' ? c.size ** 2 * c.length * 0.99 : Math.PI * (c.size / 2) ** 2 * c.length * 0.99;
    assert.ok(volume(m) < before + 1e-6 && volume(m) > before - pin, `${shape}: volume ${volume(m)} vs ${before}`);
  }
});

test('a painted line around the neck is followed, even when tilted', () => {
  const m = figure();
  const P = m.positions;
  const height = (v) => 47 + 0.3 * P[v * 3]; // a tilted ring around the neck
  const painted = new Uint8Array(m.vertexCount);
  for (let v = 0; v < m.vertexCount; v++) if (Math.abs(P[v * 3 + 2] - height(v)) < 1.2 && Math.hypot(P[v * 3], P[v * 3 + 1]) < 12) painted[v] = 1;
  const neck = neckFromPainting(m, painted);
  assert.ok(neck && neck.coverage > 0.9);
  assert.ok(neck.normal[2] > 0.9 || neck.normal[2] < -0.9, 'roughly upright');
  const loop = seamLoop(m, neck, { follow: 0.3, painted, reach: neck.reach });
  assert.ok(loop);
  const off = loop.reduce((s, v) => s + Math.abs(P[v * 3 + 2] - height(v)), 0) / loop.length;
  assert.ok(off < 1.5, `loop is ${off.toFixed(2)} mm off the painted line on average`);
  cutAlongLoop(m, loop, neck);
  for (const p of parts(m)) assert.ok(consistentlyClosed(p));
});

test('a tilted collar: “snap to collar” follows it, and the cut with a square pin stays closed', () => {
  // Shoulders, a collar fold at z 40, neck, head – then the collar line is
  // tilted (5 mm down on one side, up on the other) like a real figure.
  const p = [[0, 0]];
  for (let z = 0; z <= 30; z += 2) p.push([22, z]);
  p.push([18, 34], [12, 38], [10, 39.5], [9.5, 40], [6.5, 40.2]);
  for (let z = 41; z <= 56; z += 1) p.push([6 + 0.012 * (z - 49) ** 2, z]);
  for (let z = 57; z <= 84; z += 1.5) p.push([Math.max(0.8, 11 * Math.sqrt(Math.max(0, 1 - ((z - 70) / 14) ** 2))), z]);
  p.push([0, 85]);
  const m = lathe(p, 72);
  const P = m.positions;
  const z0 = Float32Array.from({ length: m.vertexCount }, (_, v) => P[v * 3 + 2]);
  for (let v = 0; v < m.vertexCount; v++) {
    const w = z0[v] < 42 ? 1 : z0[v] > 50 ? 0 : (50 - z0[v]) / 8;
    P[v * 3 + 2] = z0[v] - 0.5 * P[v * 3] * w;
  }
  m._set(P, m.indices);
  const neck = findNeckAt(m, [6.2, 0, 46]);
  const onCrease = (loop) => loop.filter((v) => z0[v] >= 39.9 && z0[v] <= 40.3).length / loop.length;
  const loop = seamLoop(m, neck, { follow: 1, width: 3 });
  assert.ok(loop && onCrease(loop) > 0.8, `on the collar: ${loop && onCrease(loop)}`);
  const before = volume(m);
  const r = cutAlongLoop(m, loop, neck, { shape: 'square', taper: 1, tolerance: 0.2 });
  assert.ok(r.connector, r.note);
  const ps = parts(m);
  assert.equal(ps.length, 2);
  for (const piece of ps) assert.ok(consistentlyClosed(piece));
  assert.ok(volume(m) < before && volume(m) > before - r.connector.size ** 2 * r.connector.length);
});

test('the cut line passes through a clicked point and follows the crease it is on', () => {
  // A head–neck crease (z 58) and a collar crease (z 40) – both folds. Clicking
  // on the collar picks the collar.
  const p = [[0, 0]];
  for (let z = 0; z <= 30; z += 2) p.push([22, z]);
  p.push([18, 34], [12, 38], [10, 39.5], [9.5, 40], [6.5, 40.2]);
  for (let z = 41; z <= 57; z += 1) p.push([6 + 0.012 * (z - 49) ** 2, z]);
  p.push([9, 58]);
  for (let z = 59; z <= 84; z += 1.5) p.push([Math.max(0.8, 11 * Math.sqrt(Math.max(0, 1 - ((z - 70) / 13) ** 2))), z]);
  p.push([0, 85]);
  const m = lathe(p, 72);
  const P = m.positions;
  const neck = findNeckAt(m, [6.1, 0, 49]);
  let pick = -1;
  for (let v = 0; v < m.vertexCount; v++) if (Math.abs(P[v * 3 + 2] - 40.2) < 1e-3 && P[v * 3] > 6) pick = v;
  const loop = seamLoop(m, neck, { follow: 1, width: 3, through: pick });
  assert.ok(loop && loop.includes(pick));
  const z = loop.reduce((s, v) => s + P[v * 3 + 2], 0) / loop.length;
  assert.ok(Math.abs(z - 40.2) < 0.6, `line at z ${z}`);
});
