// Builds a solid from a shape recipe (JSON) – what the AI answers when asked
// to make an object ("a candle", "a wheel with 6 spokes"). The recipe is
// data, never code: primitives, 2D outlines turned or pushed into 3D, copies
// around an axis, and add / subtract / intersect, with moves and turns.
// manifold-3d does the geometry, so the result is always closed (watertight).
//
// Units are mm, Z is up. Placement before any move:
//   box        – centred on the Z axis, standing on Z = 0
//   cylinder   – centred on the Z axis, standing on Z = 0 (r2 = top radius: cone)
//   sphere     – centred on the origin
//   torus      – centred on the origin, lying flat (ring around the Z axis)
//   revolve    – profile [[r, z], …] turned around the Z axis
//   extrude    – outline [[x, y], …] pushed up from Z = 0
// Any node can have translate [x, y, z], rotate [x, y, z] (degrees, applied
// before translate) and scale (number or [x, y, z]).

// The recipe language, as told to the AI (kept in server/ so the desktop
// app's server has it too).
export { RECIPE_HELP } from '../server/recipe-help.js';

const MAX_NODES = 2000;
const num = (v, name, { min = -1e5, max = 1e5, def } = {}) => {
  const x = v === undefined && def !== undefined ? def : Number(v);
  if (!Number.isFinite(x)) throw new Error(`${name} must be a number`);
  return Math.min(max, Math.max(min, x));
};
const vec = (v, n, name) => {
  if (!Array.isArray(v) || v.length !== n) throw new Error(`${name} must be a list of ${n} numbers`);
  return v.map((x, i) => num(x, `${name}[${i}]`));
};
const points2 = (pts, name) => {
  if (!Array.isArray(pts) || pts.length < 3) throw new Error(`${name} needs at least 3 points`);
  if (pts.length > 5000) throw new Error(`${name} has too many points`);
  return pts.map((p, i) => vec(p, 2, `${name}[${i}]`));
};

// wasm: the initialised manifold-3d module. Returns a Manifold.
export function buildShape(wasm, node, { segments = 64 } = {}) {
  const { Manifold, CrossSection } = wasm;
  let count = 0;
  const made = new Set(); // everything made along the way, freed at the end
  const keep = (m) => (made.add(m), m);

  const build = (n, path) => {
    if (++count > MAX_NODES) throw new Error('The recipe is too big.');
    if (!n || typeof n !== 'object' || Array.isArray(n)) throw new Error(`${path}: expected a shape`);
    const kinds = Object.keys(n).filter((k) => !['translate', 'rotate', 'scale', 'name', 'comment'].includes(k));
    if (kinds.length !== 1) throw new Error(`${path}: one shape per node (got ${kinds.join(', ') || 'none'})`);
    const kind = kinds[0];
    const a = n[kind];
    let m;
    switch (kind) {
      case 'box': {
        const s = Array.isArray(a?.size) ? vec(a.size, 3, `${path}.box.size`) : [1, 1, 1].map(() => num(a?.size, `${path}.box.size`));
        if (s.some((x) => x <= 0)) throw new Error(`${path}: box size must be positive`);
        m = keep(Manifold.cube(s, true)).translate([0, 0, s[2] / 2]);
        break;
      }
      case 'cylinder': {
        const r = num(a?.r, `${path}.cylinder.r`, { min: 0 }), h = num(a?.h, `${path}.cylinder.h`, { min: 1e-3 });
        const r2 = a?.r2 === undefined ? r : num(a.r2, `${path}.cylinder.r2`, { min: 0 });
        if (r <= 0 && r2 <= 0) throw new Error(`${path}: cylinder radius must be positive`);
        m = Manifold.cylinder(h, r, r2, segments);
        break;
      }
      case 'sphere':
        m = Manifold.sphere(num(a?.r, `${path}.sphere.r`, { min: 1e-3 }), segments);
        break;
      case 'torus': {
        const R = num(a?.R, `${path}.torus.R`, { min: 1e-3 }), r = num(a?.r, `${path}.torus.r`, { min: 1e-3 });
        if (r >= R) throw new Error(`${path}: torus tube radius r must be smaller than R`);
        const circle = keep(keep(CrossSection.circle(r, Math.max(16, segments / 2))).translate([R, 0]));
        m = circle.revolve(segments);
        break;
      }
      case 'revolve': {
        const pts = points2(a?.profile, `${path}.revolve.profile`).map(([r, z]) => [Math.max(0, r), z]);
        const cs = keep(CrossSection.ofPolygons([pts], 'Positive'));
        const cs2 = cs.area() < 0 ? keep(CrossSection.ofPolygons([pts.slice().reverse()], 'Positive')) : cs;
        if (Math.abs(cs2.area()) < 1e-9) throw new Error(`${path}: the revolve profile has no area`);
        m = cs2.revolve(segments, num(a.degrees, `${path}.revolve.degrees`, { min: 1, max: 360, def: 360 }));
        break;
      }
      case 'extrude': {
        const pts = points2(a?.outline, `${path}.extrude.outline`);
        let cs = keep(CrossSection.ofPolygons([pts], 'NonZero'));
        if (Math.abs(cs.area()) < 1e-9) throw new Error(`${path}: the extrude outline has no area`);
        const h = num(a.h, `${path}.extrude.h`, { min: 1e-3 });
        const twist = num(a.twist, `${path}.extrude.twist`, { def: 0 });
        const st = num(a.scaleTop, `${path}.extrude.scaleTop`, { min: 0, max: 100, def: 1 });
        m = cs.extrude(h, twist ? Math.max(8, Math.round(Math.abs(twist) / 5)) : 0, twist, [st, st]);
        break;
      }
      case 'union':
      case 'intersection':
      case 'difference': {
        if (!Array.isArray(a) || !a.length) throw new Error(`${path}: ${kind} needs a list of shapes`);
        const parts = a.map((c, i) => keep(build(c, `${path}.${kind}[${i}]`)));
        if (kind === 'union') m = Manifold.union(parts);
        else if (kind === 'intersection') m = Manifold.intersection(parts);
        else m = parts.length === 1 ? parts[0] : parts[0].subtract(keep(Manifold.union(parts.slice(1))));
        break;
      }
      case 'around': {
        const k = Math.round(num(a?.count, `${path}.around.count`, { min: 1, max: 360 }));
        const one = keep(build(a.shape, `${path}.around.shape`));
        const axis = { x: 0, y: 1, z: 2 }[a.axis || 'z'];
        if (axis === undefined) throw new Error(`${path}: axis must be x, y or z`);
        const copies = [];
        for (let i = 0; i < k; i++) {
          const r = [0, 0, 0];
          r[axis] = (360 * i) / k;
          copies.push(keep(one.rotate(r)));
        }
        m = Manifold.union(copies);
        break;
      }
      case 'row': {
        const k = Math.round(num(a?.count, `${path}.row.count`, { min: 1, max: 500 }));
        const step = vec(a.step, 3, `${path}.row.step`);
        const one = keep(build(a.shape, `${path}.row.shape`));
        const copies = [];
        for (let i = 0; i < k; i++) copies.push(keep(one.translate(step.map((s) => s * i))));
        m = Manifold.union(copies);
        break;
      }
      default:
        throw new Error(`${path}: unknown shape "${kind}"`);
    }
    keep(m);
    if (n.scale !== undefined) m = keep(m.scale(Array.isArray(n.scale) ? vec(n.scale, 3, `${path}.scale`) : num(n.scale, `${path}.scale`)));
    if (n.rotate !== undefined) m = keep(m.rotate(vec(n.rotate, 3, `${path}.rotate`)));
    if (n.translate !== undefined) m = keep(m.translate(vec(n.translate, 3, `${path}.translate`)));
    return m;
  };

  try {
    const result = build(node, 'shape');
    if (result.isEmpty()) throw new Error('The shape came out empty (everything was cut away?).');
    // Copy out so the rest can be freed.
    const out = Manifold.union([result]);
    return out;
  } finally {
    for (const m of made) m.delete?.();
  }
}

// Manifold → triangle soup (Float32Array of 9 floats per triangle), the
// format the editor loads.
export function manifoldToSoup(m) {
  const mesh = m.getMesh();
  const { vertProperties: P, triVerts: T, numProp } = mesh;
  const soup = new Float32Array(T.length * 3);
  for (let i = 0; i < T.length; i++) {
    const v = T[i] * numProp;
    soup[i * 3] = P[v];
    soup[i * 3 + 1] = P[v + 1];
    soup[i * 3 + 2] = P[v + 2];
  }
  return soup;
}
