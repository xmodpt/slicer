import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'manifold-3d';
import { buildShape, manifoldToSoup } from '../src/shapegen.js';
import { EditableMesh } from '../src/mesh.js';
import { parseRecipe } from '../server/ai.js';

const wasm = await Module();
wasm.setup();

const solid = (recipe) => {
  const m = buildShape(wasm, recipe);
  const mesh = EditableMesh.fromSoup(manifoldToSoup(m));
  m.delete();
  return mesh;
};

test('a candle: turned body, wick, drip ring – one closed solid standing on the plate', () => {
  const mesh = solid({
    union: [
      { revolve: { profile: [[0, 0], [12, 0], [12, 1.5], [11, 2], [11, 90], [9, 92], [0, 92]] } },
      { torus: { R: 10.5, r: 1.2 }, translate: [0, 0, 88] },
      { cylinder: { r: 1, h: 10 }, translate: [0, 0, 91] },
    ],
  });
  const s = mesh.stats();
  assert.ok(s.watertight, 'closed');
  assert.equal(s.parts, 1);
  const b = mesh.bounds();
  assert.ok(Math.abs(b.min[2]) < 1e-3 && Math.abs(b.max[2] - 101) < 0.01 && Math.abs(b.max[0] - 12) < 0.05);
});

test('a wheel: rim, hub with a hole, spokes around – holes cut, all one piece', () => {
  const mesh = solid({
    difference: [
      {
        union: [
          { difference: [{ cylinder: { r: 25, h: 10 } }, { cylinder: { r: 20, h: 12 }, translate: [0, 0, -1] }] },
          { cylinder: { r: 6, h: 10 } },
          { around: { count: 6, shape: { box: { size: [16, 3, 6] }, translate: [13, 0, 2] } } },
        ],
      },
      { cylinder: { r: 2.5, h: 12 }, translate: [0, 0, -1] },
    ],
    rotate: [90, 0, 0],
    translate: [0, 0, 25],
  });
  const s = mesh.stats();
  assert.ok(s.watertight);
  assert.equal(s.parts, 1);
  const b = mesh.bounds();
  assert.ok(Math.abs(b.max[2] - 50) < 0.1 && Math.abs(b.min[2]) < 0.1, 'standing on its rim');
});

test('bad recipes give clear errors, not crashes', () => {
  assert.throws(() => buildShape(wasm, { teapot: {} }), /unknown shape "teapot"/);
  assert.throws(() => buildShape(wasm, { cylinder: { r: 'big', h: 3 } }), /must be a number/);
  assert.throws(() => buildShape(wasm, { box: { size: [1, 2] } }), /3 numbers/);
  assert.throws(() => buildShape(wasm, { difference: [{ box: { size: [2, 2, 2] } }, { box: { size: [5, 5, 5] }, translate: [0, 0, -1] }] }), /empty/);
});

test('the recipe is read from the AI answer, even inside text or a code block', () => {
  const r = parseRecipe('Here you go:\n```json\n{"name": "Candle", "description": "A candle", "recipe": {"cylinder": {"r": 10, "h": 80}}}\n```');
  assert.equal(r.name, 'Candle');
  assert.deepEqual(r.recipe, { cylinder: { r: 10, h: 80 } });
  assert.throws(() => parseRecipe('no idea'), /did not answer/);
});

test('recipes written the AI’s own way still build: type fields, OpenSCAD names, clockwise outlines, lists', () => {
  const variants = [
    { type: 'cylinder', radius: 10, height: 50 },
    { shape: 'cube', params: { width: 10, depth: 20, height: 5 }, position: { x: 1, y: 2, z: 0 } },
    [{ sphere: { radius: 5 } }, { cylinder: { d: 4, height: 10 } }],
    { recipe: { linear_extrude: { points: [[0, 0], [10, 0], [10, 10], [0, 10]], height: 3 } } },
    { revolve: { profile: [[0, 0], [0, 90], [11, 90], [12, 0]] } }, // clockwise
    { rotate_extrude: { points: [{ r: 12, z: 0 }, { r: 11, z: 90 }] } }, // open at the axis
    { operation: 'difference', children: [{ type: 'box', size: [20, 20, 10] }, { type: 'cylinder', r: 3, h: 30, translate: [0, 0, -5] }] },
    { difference: { base: { box: { size: 20 } }, subtract: [{ sphere: 6, translate: [0, 0, 20] }] } },
    { type: 'polar_array', count: 5, shape: { type: 'box', size: [10, 2, 2], translate: [8, 0, 0] } },
  ];
  for (const v of variants) {
    const mesh = solid(v);
    assert.ok(mesh.stats().watertight && mesh.triangleCount > 4, JSON.stringify(v));
  }
});

test('answers from thinking models: JSON in the reasoning field or after some text is found', async () => {
  const { replyText } = await import('../server/ai.js');
  const r = { choices: [{ message: { content: '', reasoning: 'Let me think {about it}. Final: {"name": "Tree", "description": "x", "recipe": {"cylinder": {"r": 5, "h": 50}}}' } }] };
  const parsed = parseRecipe(replyText(r));
  assert.equal(parsed.name, 'Tree');
  assert.throws(() => parseRecipe('I cannot do that.'), /It said: “I cannot do that.”/);
});

test('details hidden inside the body are reported; the example candle shows its drips', () => {
  const warnings = [];
  const hidden = { union: [{ cylinder: { r: 12, h: 90 } }, { around: { count: 6, shape: { cylinder: { r: 1, h: 10 }, translate: [9, 0, 70] } }, name: 'drips' }] };
  buildShape(wasm, hidden, { warnings }).delete();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].name, 'drips');
  const candle = { union: [
    { revolve: { profile: [[0, 0], [12, 0], [12, 88], [10.5, 91], [0, 90]] } },
    { torus: { R: 11.5, r: 2 }, translate: [0, 0, 88.5] },
    { around: { count: 6, shape: { union: [{ cylinder: { r: 2, h: 22 }, translate: [12.3, 0, 67] }, { sphere: { r: 2.4 }, translate: [12.3, 0, 67] }] } } },
    { around: { count: 6, shape: { union: [{ cylinder: { r: 1.6, h: 10 }, translate: [12.2, 0, 79] }, { sphere: { r: 1.9 }, translate: [12.2, 0, 79] }] } }, rotate: [0, 0, 30] },
    { cylinder: { r: 1, h: 9, r2: 0.6 }, translate: [0, 0, 89] },
  ] };
  const w2 = [];
  const mesh = EditableMesh.fromSoup(manifoldToSoup(buildShape(wasm, candle, { warnings: w2 })));
  assert.deepEqual(w2, []);
  assert.ok(mesh.stats().watertight && mesh.stats().parts === 1);
});

test('tubes between points and hulls: a tree from its example builds as one closed piece', () => {
  const tree = { union: [
    { tube: { from: [0, 0, 0], to: [0, 0, 80], r: 7, r2: 4.5 } },
    { tube: { from: [0, 0, 55], to: [28, 6, 95], r: 3.5, r2: 2 } },
    { tube: { from: [0, 0, 62], to: [-24, 14, 100], r: 3.5, r2: 2 } },
    { tube: { from: [0, 0, 70], to: [-8, -26, 104], r: 3, r2: 1.8 } },
    { tube: { from: [0, 0, 75], to: [12, 22, 110], r: 3, r2: 1.8 } },
    { tube: { from: [0, 0, 78], to: [0, 0, 118], r: 4.5, r2: 2.5 } },
    { sphere: { r: 26 }, translate: [0, 0, 118] },
    { sphere: { r: 20 }, translate: [26, 8, 104] },
    { sphere: { r: 19 }, translate: [-24, 14, 106] },
    { sphere: { r: 18 }, translate: [-8, -24, 108] },
    { sphere: { r: 18 }, translate: [12, 22, 114] },
    { sphere: { r: 16 }, translate: [0, 0, 138] },
    { cylinder: { r: 12, h: 3, r2: 7 } },
  ] };
  const mesh = solid(tree);
  assert.ok(mesh.stats().watertight);
  assert.equal(mesh.stats().parts, 1);
  const b = mesh.bounds();
  assert.ok(b.min[2] > -7.1 && b.max[2] > 150 && b.max[0] > 40, 'tall, with a wide crown');
  // A slanted tube really goes from its start to its end point.
  const t = solid({ tube: { from: [0, 0, 0], to: [30, 0, 40], r: 2, round: false } }).bounds();
  assert.ok(Math.abs(t.max[0] - 30) < 2.1 && Math.abs(t.max[2] - 40) < 2.1);
  // A hull of two spheres is one smooth blob.
  assert.ok(solid({ hull: [{ sphere: { r: 10 } }, { sphere: { r: 6 }, translate: [0, 0, 15] }] }).stats().watertight);
  assert.ok(solid({ type: 'branch', start: [0, 0, 0], end: [0, 10, 10], radius: 2 }).stats().watertight, 'alias');
});

test('the tree node grows a closed, one-piece tree of the asked height, flat on the plate', () => {
  const mesh = solid({ tree: { height: 80, levels: 3, roots: 4, leaves: 'none', seed: 2 } });
  const s = mesh.stats();
  assert.ok(s.watertight && s.parts === 1);
  const b = mesh.bounds();
  assert.ok(Math.abs(b.min[2]) < 1e-3 && b.max[2] > 70 && b.max[2] < 95, `height ${b.max[2]}`);
  // Same settings, same tree; another seed, another tree.
  const again = solid({ tree: { height: 80, levels: 3, roots: 4, leaves: 'none', seed: 2 } });
  assert.equal(again.triangleCount, mesh.triangleCount);
  const other = solid({ type: 'bonsai', height: 80, levels: 3, seed: 9, leaves: true });
  assert.ok(other.stats().watertight && other.stats().parts === 1);
});

test('tree branches get thinner at every step from the trunk to each tip, and stay printable', async () => {
  const { growTree } = await import('../src/tree.js');
  for (const seed of [1, 2, 3]) {
    const t = growTree({ seed, minTwig: 0.7 });
    for (const b of t.branches) {
      for (let i = 1; i < b.radii.length; i++) assert.ok(b.radii[i] < b.radii[i - 1], `seed ${seed}: step ${i} of a branch is not thinner`);
      assert.ok(b.radii.at(-1) <= 0.7 * 0.56, 'ends in a point');
    }
  }
});
