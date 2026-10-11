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
