import { test } from 'node:test';
import assert from 'node:assert/strict';
import { figure } from './figure.js';
import { findBodyParts } from '../src/body.js';
import { kitCuts, kitPreview, splitFigure } from '../src/kit.js';

test('a figure on a base, hands in its pockets: the base is found, the torso keeps its arms', () => {
  const m = figure({}, 1);
  const body = findBodyParts(m);
  assert.ok(body?.base, 'base found');
  assert.ok(body.base.z > 2.5 && body.base.z < 4.5, `base top at ${body.base.z}`);
  const cuts = kitCuts(body);
  assert.deepEqual(cuts.map((c) => c.key), ['base', 'legs', 'legs', 'head']);
  const preview = kitPreview(body, cuts).map((p) => p.name.split(' ')[0]);
  assert.deepEqual(preview.sort(), ['Base', 'Head', 'Leg', 'Leg', 'Torso']);

  const r = splitFigure(m, cuts, { connector: { shape: 'round', size: 0, length: 0, taper: 1, tolerance: 0.2 } });
  assert.deepEqual(r.notes, []);
  const stats = m.stats();
  assert.ok(stats.watertight, 'every piece closed');
  assert.equal(stats.parts, 5);
  const byName = {};
  for (const part of m.parts()) byName[r.names[r.labels[part.faces[0]]].split(' ')[0] + (byName.Leg && r.names[r.labels[part.faces[0]]].startsWith('Leg') ? '2' : '')] = m.boundsOfFaces(part.faces);
  assert.deepEqual(Object.keys(byName).sort(), ['Base', 'Head', 'Leg', 'Leg2', 'Torso']);
  assert.ok(byName.Head.min[2] > 85, 'head above the neck');
  assert.ok(byName.Base.max[2] < 10, 'base at the bottom (with its pins)');
  assert.ok(byName.Torso.max[0] - byName.Torso.min[0] > 30, 'arms still on the torso');
});

test('no base: nothing to cut flat, a figure without one is still split', () => {
  const m = figure({ base: false }, 1);
  const body = findBodyParts(m);
  assert.ok(body && !body.base);
  assert.deepEqual(kitCuts(body).map((c) => c.key), ['legs', 'legs', 'head']);
});
