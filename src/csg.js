// Solid operations with manifold-3d: join / cut / overlap models, a base
// under a model, raised or engraved text and logos, hollowing with drain
// holes. Every function takes the initialised manifold module (`wasm`) and
// plain meshes ({ positions, indices }); results are plain meshes, always
// closed. Inputs must be closed (watertight) – close holes first.

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export class NotSolidError extends Error {}

// Plain mesh → Manifold (the caller deletes it).
export function toSolid(wasm, { positions, indices }, what = 'The model') {
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(positions), triVerts: Uint32Array.from(indices) });
  mesh.merge();
  const fail = (why) => new NotSolidError(`${what} isn't a closed solid (${why}) – close its holes and repair it first (Fix model, Tools ▾ → Repair).`);
  let m;
  try {
    m = new wasm.Manifold(mesh);
  } catch (err) {
    throw fail(err.message || 'not manifold');
  }
  const status = m.status();
  if (status !== 'NoError') {
    m.delete();
    throw fail(status);
  }
  return m;
}

export function fromSolid(m) {
  const mesh = m.getMesh();
  const { vertProperties: P, triVerts, numProp } = mesh;
  const positions = new Float32Array((P.length / numProp) * 3);
  for (let v = 0, n = P.length / numProp; v < n; v++) {
    positions[v * 3] = P[v * numProp];
    positions[v * 3 + 1] = P[v * numProp + 1];
    positions[v * 3 + 2] = P[v * numProp + 2];
  }
  return { positions, indices: Uint32Array.from(triVerts) };
}

// Runs fn with a list that collects Manifolds to free afterwards.
function scoped(fn) {
  const made = [];
  const keep = (m) => (made.push(m), m);
  try {
    return fn(keep);
  } finally {
    for (const m of made) m.delete?.();
  }
}

// ---------------------------------------------------------------------------
// Combine: 'join' (union), 'cut' (the first minus the others), 'overlap'.

export function combine(wasm, meshes, op = 'join') {
  return scoped((keep) => {
    const solids = meshes.map((m, i) => keep(toSolid(wasm, m, `Model ${i + 1}`)));
    let r;
    if (op === 'join') r = keep(wasm.Manifold.union(solids));
    else if (op === 'overlap') r = keep(wasm.Manifold.intersection(solids));
    else r = keep(solids[0].subtract(keep(wasm.Manifold.union(solids.slice(1)))));
    if (r.isEmpty()) throw new Error(op === 'overlap' ? "The models don't overlap." : 'Nothing is left.');
    return fromSolid(r);
  });
}

// ---------------------------------------------------------------------------
// Base: a plinth under the model's footprint. shape: 'round' | 'oval' |
// 'square'; margin around the model, height, a bevel on the top edge. The
// model is set onto it (sunk `overlap` mm into it) and, with join, merged.
// Returns { mesh } (joined) or { model, base } (separate meshes).

export function addBase(wasm, model, { shape = 'round', margin = 4, height = 3, bevel = 0.8, join = true, overlap = 0.4 } = {}) {
  const P = model.positions;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], P[i + k])), (max[k] = Math.max(max[k], P[i + k]));
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2;
  const w = max[0] - min[0] + 2 * margin, d = max[1] - min[1] + 2 * margin;
  return scoped((keep) => {
    const { CrossSection, Manifold } = wasm;
    let outline;
    if (shape === 'square') outline = keep(CrossSection.square([w, d], true));
    else if (shape === 'oval') outline = keep(keep(CrossSection.circle(0.5, 96)).scale([w, d]));
    else {
      // round: a circle around the whole footprint
      let r = 0;
      for (let i = 0; i < P.length; i += 3) r = Math.max(r, Math.hypot(P[i] - cx, P[i + 1] - cy));
      outline = keep(CrossSection.circle(r + margin, 128));
    }
    const b = Math.min(bevel, height * 0.45);
    // Straight part, then a bevelled top (scaled-down extrusion).
    const body = keep(outline.extrude(height - b));
    const size = shape === 'round' ? [w, w] : [w, d];
    const sTop = [Math.max(0.5, 1 - (2 * b) / size[0]), Math.max(0.5, 1 - (2 * b) / size[1])];
    const top = keep(keep(outline.extrude(b, 0, 0, sTop)).translate([0, 0, height - b]));
    const base = keep(keep(Manifold.union([body, top])).translate([cx, cy, min[2]]));
    // The model goes on top, sunk a little so they join.
    const lift = height - overlap;
    const moved = { positions: P.map((v, i) => (i % 3 === 2 ? v + lift : v)), indices: model.indices };
    if (!join) return { model: moved, base: fromSolid(base) };
    const solid = keep(toSolid(wasm, moved));
    return { mesh: fromSolid(keep(Manifold.union([solid, base]))) };
  });
}

// ---------------------------------------------------------------------------
// Text and logos: 2D outlines (from a font or an SVG) pushed up into a solid
// and set onto the surface at a point, then added (raised) or cut (engraved).

// Outlines as polygons [[x, y], …] (outer edges and holes; even-odd fill),
// centred on the origin, `size` mm tall (text) or wide (logo).
export function textOutlines(font, text, size) {
  const shapes = font.generateShapes(text, 100);
  return normalise(shapesToPolygons(shapes), size, 'height');
}

export function svgOutlines(SVGLoader, svgText, width) {
  const data = new SVGLoader().parse(svgText);
  const shapes = [];
  for (const path of data.paths) shapes.push(...SVGLoader.createShapes(path));
  // SVG's y points down.
  const polys = shapesToPolygons(shapes).map((p) => p.map(([x, y]) => [x, -y]));
  return normalise(polys, width, 'width');
}

function shapesToPolygons(shapes) {
  const polys = [];
  for (const s of shapes) {
    const { shape, holes } = s.extractPoints(8);
    if (shape.length >= 3) polys.push(shape.map((p) => [p.x, p.y]));
    for (const h of holes) if (h.length >= 3) polys.push(h.map((p) => [p.x, p.y]));
  }
  return polys;
}

function normalise(polys, size, by) {
  if (!polys.length) throw new Error('Nothing to draw.');
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  const k = size / Math.max(1e-9, by === 'width' ? x1 - x0 : y1 - y0);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return polys.map((p) => p.map(([x, y]) => [(x - cx) * k, (y - cy) * k]));
}

// Adds (mode 'raise') or cuts ('engrave') the outlines into the model at
// `point` on a face with normal `normal`, `depth` mm high/deep, turned by
// `angle` degrees about the normal. Text reads upright (its up follows the
// world's Z, or Y on a level surface).
export function stamp(wasm, model, polys, { point, normal, depth = 1, mode = 'raise', angle = 0 }) {
  const n = new THREE.Vector3(...normal).normalize();
  let up = new THREE.Vector3(0, 0, 1);
  if (Math.abs(n.dot(up)) > 0.9) up = new THREE.Vector3(0, 1, 0);
  up.sub(n.clone().multiplyScalar(up.dot(n))).normalize();
  let right = new THREE.Vector3().crossVectors(up, n).normalize();
  if (angle) {
    const q = new THREE.Quaternion().setFromAxisAngle(n, (angle * Math.PI) / 180);
    up.applyQuaternion(q);
    right.applyQuaternion(q);
  }
  // Reaches into the surface too, so it joins (or cuts) even where the
  // surface curves away under the letters.
  let span = 0;
  for (const p of polys) for (const [x, y] of p) span = Math.max(span, Math.hypot(x, y));
  const sink = Math.min(span * 0.6, Math.max(depth, span * 0.25));
  return scoped((keep) => {
    const cs = keep(wasm.CrossSection.ofPolygons(polys, 'EvenOdd'));
    if (Math.abs(cs.area()) < 1e-9) throw new Error('The text or logo has no area.');
    const z0 = mode === 'raise' ? -sink : -depth;
    const z1 = mode === 'raise' ? depth : sink;
    const slab = keep(keep(cs.extrude(z1 - z0)).translate([0, 0, z0]));
    const p = new THREE.Vector3(...point);
    const mat = [right.x, right.y, right.z, 0, up.x, up.y, up.z, 0, n.x, n.y, n.z, 0, p.x, p.y, p.z, 1];
    const placed = keep(slab.transform(mat));
    const solid = keep(toSolid(wasm, model));
    const r = keep(mode === 'raise' ? wasm.Manifold.union([solid, placed]) : solid.subtract(placed));
    return fromSolid(r);
  });
}

// ---------------------------------------------------------------------------
// Hollowing: the model becomes a shell `wall` mm thick. The inside surface is
// built from the model's distance field (manifold's levelSet), so it follows
// the outside at an even distance and never pokes through it.

export function hollow(wasm, model, { wall = 2, detail = 0 } = {}) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(model.positions), 3));
  geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(model.indices), 1));
  const bvh = new MeshBVH(geo);
  const box = new THREE.Box3().setFromBufferAttribute(geo.attributes.position);
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  if (Math.min(size.x, size.y, size.z) < wall * 2.2) throw new Error(`The model is too thin to hollow with ${wall} mm walls.`);
  // Grid: fine enough for the wall, at most ~110 cells along the longest side.
  const edge = detail || Math.max(wall / 2, longest / 110, 0.25);
  const q = new THREE.Vector3(), target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0.5773, 0.5774, 0.5775).normalize());
  const sdf = ([x, y, z]) => {
    q.set(x, y, z);
    const hit = bvh.closestPointToPoint(q, target, 0, wall * 4);
    const d = hit ? hit.distance : wall * 4;
    // Deep inside or far outside: the sign is all that matters there.
    ray.origin.copy(q);
    const n = bvh.raycast(ray, THREE.DoubleSide).length;
    return n % 2 === 1 ? d : -d;
  };
  const bounds = { min: [box.min.x - edge, box.min.y - edge, box.min.z - edge], max: [box.max.x + edge, box.max.y + edge, box.max.z + edge] };
  return scoped((keep) => {
    const inner = keep(wasm.Manifold.levelSet(sdf, bounds, edge, wall));
    const solid = keep(toSolid(wasm, model));
    if (inner.isEmpty()) throw new Error(`Nothing would be left inside with ${wall} mm walls – it's already that thin.`);
    const shell = keep(solid.subtract(inner));
    geo.dispose();
    return { mesh: fromSolid(shell), innerVolume: inner.volume() };
  });
}

// Drain holes: cylinders through the wall at points on the surface, along
// the surface normal, `diameter` wide, reaching `depth` mm in.
export function drillHoles(wasm, model, holes, { diameter = 3, depth = 6 } = {}) {
  return scoped((keep) => {
    const solid = keep(toSolid(wasm, model));
    const cutters = holes.map(({ point, normal }) => {
      const n = new THREE.Vector3(...normal).normalize();
      const x = Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1).cross(n).normalize() : new THREE.Vector3(1, 0, 0).cross(n).normalize();
      const y = new THREE.Vector3().crossVectors(n, x);
      const out = 1; // starts 1 mm outside the surface
      const c = keep(wasm.Manifold.cylinder(depth + out, diameter / 2, diameter / 2, 32));
      const p = new THREE.Vector3(...point).addScaledVector(n, out);
      // Cylinder along -n from just outside the surface.
      return keep(c.transform([x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, -n.x, -n.y, -n.z, 0, p.x, p.y, p.z, 1]));
    });
    return fromSolid(keep(solid.subtract(keep(wasm.Manifold.union(cutters)))));
  });
}
