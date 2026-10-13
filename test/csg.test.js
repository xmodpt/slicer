import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'manifold-3d';
import { Font } from 'three/examples/jsm/loaders/FontLoader.js';
import { combine, addBase, textOutlines, stamp, hollow, drillHoles, NotSolidError } from '../src/csg.js';
import { modelInfo } from '../src/analysis.js';
import { EditableMesh } from '../src/mesh.js';

const wasm = await Module();
wasm.setup();
const BOX = [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 2,3,7, 2,7,6, 1,2,6, 1,6,5, 3,0,4, 3,4,7];
const box = (x0, y0, z0, x1, y1, z1) => ({
  positions: new Float32Array([[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]].flat()),
  indices: new Uint32Array(BOX),
});
const closed = (m) => new EditableMesh(m.positions, m.indices).stats();
const vol = (m) => modelInfo(new EditableMesh(m.positions, m.indices)).volume;

test('combine: join, cut, overlap', () => {
  const a = box(0, 0, 0, 10, 10, 10), b = box(5, 0, 0, 15, 10, 10);
  assert.ok(Math.abs(vol(combine(wasm, [a, b], 'join')) - 1500) < 1e-3);
  assert.ok(Math.abs(vol(combine(wasm, [a, b], 'cut')) - 500) < 1e-3);
  assert.ok(Math.abs(vol(combine(wasm, [a, b], 'overlap')) - 500) < 1e-3);
  const open = { positions: a.positions, indices: a.indices.slice(3) };
  assert.throws(() => combine(wasm, [open, b]), NotSolidError);
});

test('base: under the model, joined into one closed piece; or separate', () => {
  const m = box(-5, -5, 0, 5, 5, 20);
  const { mesh } = addBase(wasm, m, { shape: 'round', margin: 3, height: 3 });
  const s = closed(mesh);
  assert.ok(s.watertight && s.parts === 1);
  const info = modelInfo(new EditableMesh(mesh.positions, mesh.indices));
  assert.ok(Math.abs(info.min[2]) < 1e-4 && Math.abs(info.max[2] - 22.6) < 1e-3, `z ${info.min[2]}..${info.max[2]}`);
  assert.ok(info.size[0] > 10 + 6);
  const sep = addBase(wasm, m, { shape: 'square', join: false });
  assert.ok(closed(sep.base).watertight);
});

test('text raised and engraved on a face, logo from SVG', () => {
  const font = new Font(JSON.parse(fs.readFileSync(new URL('../node_modules/three/examples/fonts/helvetiker_bold.typeface.json', import.meta.url))));
  const polys = textOutlines(font, 'AB8', 6);
  const m = box(-20, -5, 0, 20, 5, 20);
  const front = { point: [0, -5, 10], normal: [0, -1, 0], depth: 1 };
  const raised = stamp(wasm, m, polys, { ...front, mode: 'raise' });
  const cut = stamp(wasm, m, polys, { ...front, mode: 'engrave' });
  assert.ok(closed(raised).watertight && closed(cut).watertight);
  assert.ok(vol(raised) > 8000 && vol(cut) < 8000);
  const b = modelInfo(new EditableMesh(raised.positions, raised.indices));
  assert.ok(Math.abs(b.min[1] + 6) < 1e-3, 'letters stand 1 mm out of the front');
  // (SVG logos need the browser's DOMParser – checked in the app.)
});

test('hollow leaves an even shell; drain holes open it', () => {
  const m = box(0, 0, 0, 30, 30, 30);
  const { mesh } = hollow(wasm, m, { wall: 2 });
  const s = closed(mesh);
  assert.ok(s.watertight);
  assert.equal(s.parts, 2, 'outside + inside surface');
  const v = vol(mesh);
  // 30³ − 26³ = 9424 (the inner box's rounded edges add a little).
  assert.ok(v > 9000 && v < 11000, `shell volume ${v}`);
  const drilled = drillHoles(wasm, mesh, [{ point: [15, 15, 0], normal: [0, 0, -1] }], { diameter: 3, depth: 4 });
  const d = closed(drilled);
  assert.ok(d.watertight);
  assert.equal(d.parts, 1, 'the hole joins inside and outside');
  assert.throws(() => hollow(wasm, box(0, 0, 0, 3, 30, 30), { wall: 2 }), /too thin/);
});
