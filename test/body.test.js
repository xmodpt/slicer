import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditableMesh } from '../src/mesh.js';
import { findBodyParts } from '../src/body.js';

// A simple standing figure: legs, torso, arms hanging beside it, neck and head.
function lathe(profile, seg, [ox, oy] = [0, 0]) {
  const pos = [], idx = [], ring = [];
  for (const [r, z] of profile) {
    if (r === 0) { ring.push([pos.length / 3]); pos.push(ox, oy, z); continue; }
    const ids = [];
    for (let i = 0; i < seg; i++) { const a = (2 * Math.PI * i) / seg; ids.push(pos.length / 3); pos.push(ox + r * Math.cos(a), oy + r * Math.sin(a), z); }
    ring.push(ids);
  }
  for (let j = 0; j + 1 < ring.length; j++) {
    const A = ring[j], B = ring[j + 1];
    for (let i = 0; i < seg; i++) { const i1 = (i + 1) % seg;
      if (A.length === 1) idx.push(A[0], B[i1], B[i]); else if (B.length === 1) idx.push(A[i], A[i1], B[0]); else idx.push(A[i], A[i1], B[i1], A[i], B[i1], B[i]); }
  }
  return { pos, idx };
}
function human() {
  const pieces = [];
  const prof = (fn, z0, z1, dz) => { const p = [[0, z0]]; for (let z = z0 + dz; z < z1; z += dz) p.push([fn(z), z]); p.push([0, z1]); return p; };
  // torso (with shoulders), neck + head
  pieces.push(lathe(prof((z) => 11 + 2 * Math.sin(((z - 45) / 40) * Math.PI), 44, 86, 1), 64));
  pieces.push(lathe(prof((z) => (z < 95 ? 4.5 + 0.02 * (z - 90) ** 2 : Math.max(1, 7.5 * Math.sqrt(Math.max(0, 1 - ((z - 104) / 10) ** 2)))), 84, 114, 0.75), 48));
  // legs
  for (const x of [-5.5, 5.5]) pieces.push(lathe(prof((z) => 4.5 - 0.02 * z, 0, 50, 1), 40, [x, 0]));
  // arms (hanging, from the shoulders down to the hands at z 40)
  for (const x of [-16.5, 16.5]) pieces.push(lathe(prof((z) => 3 + 0.3 * Math.sin(z / 6), 40, 84, 1), 32, [x, 0]));
  const pos = [], idx = [];
  for (const p of pieces) { const base = pos.length / 3; pos.push(...p.pos); idx.push(...p.idx.map((v) => v + base)); }
  return new EditableMesh(new Float32Array(pos), new Uint32Array(idx));
}

test('a standing figure is split into head, torso, two arms and two legs', () => {
  const m = human();
  const body = findBodyParts(m);
  assert.ok(body, 'recognised as a figure');
  const byName = Object.fromEntries(body.parts.map((p) => [p.name.replace(/ \(.*\)/, '') + (p.name.includes('left') ? ' L' : p.name.includes('right') ? ' R' : ''), m.boundsOfFaces(p.faces)]));
  assert.deepEqual(Object.keys(byName).sort(), ['Arm L', 'Arm R', 'Head', 'Leg L', 'Leg R', 'Torso']);
  assert.ok(byName.Head.min[2] > 88, 'head above the neck');
  assert.ok(byName['Leg L'].max[2] < 50 && byName['Leg L'].max[0] < 0, 'left leg');
  assert.ok(byName['Leg R'].min[0] > 0, 'right leg');
  assert.ok(byName['Arm L'].max[0] < -12 && byName['Arm R'].min[0] > 12, 'arms beside the torso');
  assert.ok(byName.Torso.min[2] > 40 && byName.Torso.max[2] < 98, 'torso between hips and neck');
  // Every triangle belongs to exactly one part.
  assert.equal(body.parts.reduce((n, p) => n + p.faces.length, 0), m.triangleCount);
  // Joints to cut along: neck, two shoulders, two hips.
  const names = body.joints.map((j) => j.name.split(' ')[0]);
  assert.deepEqual(names.sort(), ['Hip', 'Hip', 'Neck', 'Shoulder', 'Shoulder']);
  const neck = body.joints.find((j) => j.name.startsWith('Neck')).neck;
  assert.ok(Math.abs(neck.center[2] - 92) < 4 && neck.radius > 3.5 && neck.radius < 6, `neck at ${neck.center[2]} r ${neck.radius}`);
});

test('something that is not a figure is not split into body parts', () => {
  const pos = [], idx = [];
  // a plain box
  const p = [[0,0,0],[10,0,0],[10,10,0],[0,10,0],[0,0,10],[10,0,10],[10,10,10],[0,10,10]];
  for (const q of p) pos.push(...q);
  idx.push(0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 2,3,7, 2,7,6, 1,2,6, 1,6,5, 3,0,4, 3,4,7);
  assert.equal(findBodyParts(new EditableMesh(new Float32Array(pos), new Uint32Array(idx))), null);
});
