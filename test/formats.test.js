import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { parseOBJ, writeOBJ, read3MF, write3MF, readZip } from '../src/formats.js';
import { EditableMesh } from '../src/mesh.js';

const cube = () => {
  const p = [[0,0,0],[10,0,0],[10,10,0],[0,10,0],[0,0,10],[10,0,10],[10,10,10],[0,10,10]];
  const idx = [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 2,3,7, 2,7,6, 1,2,6, 1,6,5, 3,0,4, 3,4,7];
  return new EditableMesh(new Float32Array(p.flat()), new Uint32Array(idx));
};

test('OBJ: quads and negative indices read, objects kept apart, round trip', () => {
  const models = parseOBJ('# test\no Box\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\no Tri\nv 0 0 1\nv 1 0 1\nv 0 1 1\nf -3/1/1 -2/2/2 -1/3/3\n');
  assert.deepEqual(models.map((m) => [m.name, m.soup.length / 9]), [['Box', 2], ['Tri', 1]]);
  const c = cube();
  const back = parseOBJ(writeOBJ([{ name: 'Cube A', positions: c.positions, indices: c.indices }]));
  const m = EditableMesh.fromSoup(back[0].soup);
  assert.equal(back[0].name, 'Cube_A');
  assert.ok(m.stats().watertight);
  assert.equal(m.triangleCount, 12);
});

test('3MF: written file reads back with names, stored and deflated zips', async () => {
  const c = cube();
  const bytes = write3MF([{ name: 'One', positions: c.positions, indices: c.indices }, { name: 'Two & co', positions: c.positions.map((v) => v + 20), indices: c.indices }]);
  const models = await read3MF(bytes.buffer);
  assert.deepEqual(models.map((m) => m.name), ['One', 'Two & co']);
  assert.equal(models[1].soup.length / 9, 12);
  assert.ok(Math.min(...models[1].soup) >= 20);
  // A deflated 3MF (as slicers write them), with a component and transforms.
  const xml = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>
    <object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>
    <object id="2" name="Assembly" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></components></object>
    </resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 7"/></build></model>`;
  const enc = new TextEncoder();
  const deflated = deflateRawSync(enc.encode(xml));
  // Hand-made zip with one deflated entry.
  const name = enc.encode('3D/3dmodel.model');
  const local = new Uint8Array(30 + name.length + deflated.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, 8, true); lv.setUint32(18, deflated.length, true); lv.setUint32(22, xml.length, true); lv.setUint16(26, name.length, true);
  local.set(name, 30); local.set(deflated, 30 + name.length);
  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 8, true); cv.setUint32(20, deflated.length, true); cv.setUint32(24, xml.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, 0, true);
  central.set(name, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true); ev.setUint32(12, central.length, true); ev.setUint32(16, local.length, true);
  const zip = new Uint8Array([...local, ...central, ...end]);
  assert.deepEqual((await readZip(zip.buffer)).names, ['3D/3dmodel.model']);
  const [m] = await read3MF(zip.buffer);
  assert.equal(m.name, 'Assembly');
  assert.deepEqual([...m.soup], [5, 0, 7, 6, 0, 7, 5, 1, 7]);
});
