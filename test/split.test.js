import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EditableMesh } from '../src/mesh.js';
import { writeBinarySTL, parseSTL } from '../src/stl.js';
import { makeZip } from '../src/zip.js';
import { volume, consistentlyClosed } from './helpers.js';

// Closed L-shaped wall: a 10 x 1 leg along X and a 1 x 6 leg along Y, 3 high.
// Built as an extruded L polygon (wound counter-clockwise seen from above).
function lWall() {
  const outline = [[0, 0], [10, 0], [10, 1], [1, 1], [1, 6], [0, 6]];
  const h = 3, n = outline.length;
  const pos = [];
  for (const [x, y] of outline) pos.push(x, y, 0);
  for (const [x, y] of outline) pos.push(x, y, h);
  const ind = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    ind.push(i, j, n + j, i, n + j, n + i); // side walls
  }
  // Caps: the L split into two convex quads.
  const quads = [[0, 1, 2, 3], [0, 3, 4, 5]];
  for (const [a, b, c, d] of quads) {
    ind.push(n + a, n + b, n + c, n + a, n + c, n + d); // top
    ind.push(a, c, b, a, d, c); // bottom
  }
  return new EditableMesh(new Float32Array(pos), new Uint32Array(ind));
}

test('L wall fixture is closed', () => {
  const m = lWall();
  assert.ok(consistentlyClosed(m));
  assert.ok(Math.abs(volume(m) - (10 + 5) * 3) < 1e-6);
});

test('cutting by a plane keeps the mesh watertight', () => {
  const m = lWall();
  const before = m.triangleCount;
  const origin = m.cutByPlane([1, 0, 0], -4); // x = 4
  assert.equal(origin.length, m.triangleCount);
  assert.ok(m.triangleCount > before && Math.max(...origin) === before - 1);
  assert.ok(consistentlyClosed(m));
  assert.ok(Math.abs(volume(m) - 45) < 1e-5);
});

test('split the long leg off at the corner: two closed parts', () => {
  const m = lWall();
  const planes = [{ normal: [1, 0, 0], constant: -1 }]; // keep x >= 1
  for (const pl of planes) m.cutByPlane(pl.normal, pl.constant);
  const mask = m.facesInsidePlanes(planes);
  const res = m.splitOff(mask);
  assert.ok(res.detached > 0);
  assert.equal(res.closed, 2); // one cap on each side of the cut

  const { component, count } = m.connectedComponents();
  assert.equal(count, 2);
  const parts = [0, 1].map((c) => m.extractFaces(component.map((x) => (x === c ? 1 : 0))));
  for (const part of parts) {
    assert.ok(consistentlyClosed(part));
    assert.equal(part.stats().watertight, true);
  }
  const vols = parts.map(volume).sort((a, b) => a - b);
  assert.ok(Math.abs(vols[0] - 18) < 1e-5, `short leg ${vols[0]}`); // 1 x 6 x 3
  assert.ok(Math.abs(vols[1] - 27) < 1e-5, `long leg ${vols[1]}`); // 9 x 1 x 3
});

test('a box of four planes selects only what lies inside it', () => {
  const m = lWall();
  const planes = [
    { normal: [1, 0, 0], constant: -3 }, // x >= 3
    { normal: [-1, 0, 0], constant: 7 }, // x <= 7
    { normal: [0, 1, 0], constant: 1 }, // y >= -1
    { normal: [0, -1, 0], constant: 2 }, // y <= 2
  ];
  m.cutByPlanes(planes);
  m.splitOff(m.facesInsidePlanes(planes));
  const { component, count } = m.connectedComponents();
  assert.equal(count, 3); // left of the box, inside it, right of it
  for (let c = 0; c < count; c++) assert.ok(consistentlyClosed(m.extractFaces(component.map((x) => (x === c ? 1 : 0)))));
  assert.ok(Math.abs(volume(m) - 45) < 1e-5);
});

test('box planes that miss the region do not cut the rest of the model', () => {
  const m = lWall();
  // Box around the long leg's far end; its y-planes would also cross the short leg.
  const planes = [
    { normal: [1, 0, 0], constant: -5 }, // x >= 5
    { normal: [-1, 0, 0], constant: 20 }, // x <= 20
    { normal: [0, 1, 0], constant: 0.5 }, // y >= -0.5
    { normal: [0, -1, 0], constant: 3 }, // y <= 3
  ];
  m.cutByPlanes(planes);
  // Only the x = 5 plane crosses the mesh inside the box (x = 20 is past the end, y-planes miss it).
  const p = m.positions;
  for (let v = 0; v < m.vertexCount; v++) assert.ok(p[v * 3 + 1] !== 3 && p[v * 3 + 1] !== -0.5 || p[v * 3] < 1);
  assert.ok(consistentlyClosed(m));
});

test('zip archive of STL parts can be unpacked', () => {
  const m = lWall();
  const stl = new Uint8Array(writeBinarySTL(m.positions, m.indices));
  const zip = makeZip([{ name: 'a.stl', data: stl }, { name: 'b.stl', data: stl }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  fs.writeFileSync(path.join(dir, 'parts.zip'), zip);
  const out = execFileSync('python3', ['-c', `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(*z.namelist()); open(sys.argv[2],'wb').write(z.read('b.stl'))`, path.join(dir, 'parts.zip'), path.join(dir, 'b.stl')]).toString();
  assert.equal(out.trim(), 'a.stl b.stl');
  const back = EditableMesh.fromSoup(parseSTL(fs.readFileSync(path.join(dir, 'b.stl'))));
  assert.equal(back.triangleCount, m.triangleCount);
});
