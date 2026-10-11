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
import { buildTree, TREE_DEFAULTS } from './tree.js';

export { RECIPE_HELP } from '../server/recipe-help.js';

const MAX_NODES = 2000;
const isObjLike = (v) => v && typeof v === 'object' && !Array.isArray(v);
// Tree settings from a recipe, in range.
function treeOptions(a) {
  const o = {};
  const n = (k, min, max) => {
    if (a[k] === undefined) return;
    const x = Number(a[k]);
    if (Number.isFinite(x)) o[k] = Math.min(max, Math.max(min, x));
  };
  n('height', 10, 2000); n('trunks', 1, 5); n('levels', 1, 7); n('branching', 0, 5); n('spread', 5, 90);
  n('gnarl', 0, 1.5); n('lean', -45, 45); n('thickness', 0.3, 3); n('roots', 0, 12); n('bark', 0, 1.5);
  n('leafSize', 0, 100); n('minTwig', 0.3, 5); n('seed', 0, 1e9);
  if (['none', 'clusters', 'crown'].includes(a.leaves)) o.leaves = a.leaves;
  if (['draft', 'normal', 'fine'].includes(a.detail)) o.detail = a.detail;
  else if (a.leaves === true) o.leaves = 'clusters';
  return { ...TREE_DEFAULTS, ...o };
}
const num = (v, name, { min = -1e5, max = 1e5, def } = {}) => {
  const x = v === undefined && def !== undefined ? def : Number(v);
  if (!Number.isFinite(x)) throw new Error(`${name} must be a number`);
  return Math.min(max, Math.max(min, x));
};
const vec = (v, n, name) => {
  if (!Array.isArray(v) || v.length !== n) throw new Error(`${name} must be a list of ${n} numbers`);
  return v.map((x, i) => num(x, `${name}[${i}]`));
};
const points2 = (pts, name, min = 3) => {
  if (!Array.isArray(pts) || pts.length < min) throw new Error(`${name} needs at least ${min} points`);
  if (pts.length > 5000) throw new Error(`${name} has too many points`);
  return pts.map((p, i) => vec(p, 2, `${name}[${i}]`));
};

// wasm: the initialised manifold-3d module. Returns a Manifold.
// warnings (optional array): filled with parts of unions that end up hidden
// inside the others – details the AI meant to show (drips, buttons…) but
// placed inside the body.
export function buildShape(wasm, node, { segments = 64, warnings = null } = {}) {
  node = normalizeRecipe(node);
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
        const pts = points2(a?.profile, `${path}.revolve.profile`, 2).map(([r, z]) => [Math.max(0, r), z]);
        // Either direction round; an outline that doesn't come back to the
        // axis is closed along it.
        if (pts[0][0] > 0) pts.unshift([0, pts[0][1]]);
        if (pts[pts.length - 1][0] > 0) pts.push([0, pts[pts.length - 1][1]]);
        const cs2 = keep(CrossSection.ofPolygons([pts], 'NonZero'));
        if (Math.abs(cs2.area()) < 1e-9) throw new Error(`${path}: the revolve profile has no area (points are [r, z] with r = distance from the axis)`);
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
      case 'tree': {
        // A whole tree from the tree generator (tree.js): trunk(s), forking
        // branches with bark, roots, leaves – far more natural than shapes.
        const t = buildTree(wasm, isObjLike(a) ? treeOptions(a) : {});
        m = t;
        break;
      }
      case 'tube': {
        // A rod from one point to another (branches, legs, handles, spokes):
        // no rotation sums for the AI. Rounded ends by default, so tubes
        // joined end to end make smooth bends.
        const from = vec(a?.from, 3, `${path}.tube.from`), to = vec(a?.to, 3, `${path}.tube.to`);
        const r = num(a.r, `${path}.tube.r`, { min: 1e-3 }), r2 = a.r2 === undefined ? r : num(a.r2, `${path}.tube.r2`, { min: 0 });
        const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
        const len = Math.hypot(...d);
        if (len < 1e-6) throw new Error(`${path}: tube from and to are the same point`);
        const z = d.map((x) => x / len);
        const helper = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        let x = [helper[1] * z[2] - helper[2] * z[1], helper[2] * z[0] - helper[0] * z[2], helper[0] * z[1] - helper[1] * z[0]];
        const xl = Math.hypot(...x);
        x = x.map((v) => v / xl);
        const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
        const mat = [...x, 0, ...y, 0, ...z, 0, ...from, 1];
        const seg = Math.max(12, Math.round(segments / 2));
        m = keep(Manifold.cylinder(len, r, r2, seg)).transform(mat);
        if (a.round !== false) {
          const caps = [keep(m), keep(Manifold.sphere(r, seg)).translate(from)];
          if (r2 > 0) caps.push(keep(Manifold.sphere(r2, seg)).translate(to));
          caps.forEach(keep);
          m = Manifold.union(caps);
        }
        break;
      }
      case 'hull': {
        // The smooth skin around several shapes (a leafy crown from a few
        // spheres, an apple, a rock, a rounded body).
        if (!Array.isArray(a) || !a.length) throw new Error(`${path}: hull needs a list of shapes`);
        const parts = a.map((c, i) => keep(build(c, `${path}.hull[${i}]`)));
        m = Manifold.hull(parts);
        break;
      }
      case 'union':
      case 'intersection':
      case 'difference': {
        if (!Array.isArray(a) || !a.length) throw new Error(`${path}: ${kind} needs a list of shapes`);
        const parts = a.map((c, i) => keep(build(c, `${path}.${kind}[${i}]`)));
        if (kind === 'union') {
          m = Manifold.union(parts);
          if (warnings && parts.length > 1 && parts.length <= 40) {
            parts.forEach((part, i) => {
              const vol = part.volume();
              if (!(vol > 0)) return;
              const others = keep(Manifold.union(parts.filter((_, j) => j !== i)));
              const shows = keep(part.subtract(others)).volume();
              if (shows < vol * 0.04) warnings.push({ path: `${path}.union[${i}]`, name: a[i]?.name || a[i]?.comment || Object.keys(normalizeRecipe(a[i]) || {}).find((k) => !['translate', 'rotate', 'scale'].includes(k)) });
            });
          }
        }
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

// ---------------------------------------------------------------------------
// AIs (free ones especially) write the recipe in their own ways: {"type":
// "cylinder", "radius": 5}, OpenSCAD names, lists instead of unions… Bring
// the common variants to the recipe's form before building.

const KIND_ALIASES = {
  box: 'box', cube: 'box', cuboid: 'box', block: 'box', rect: 'box',
  cylinder: 'cylinder', cyl: 'cylinder', cone: 'cylinder', tube: 'cylinder', disc: 'cylinder', disk: 'cylinder',
  sphere: 'sphere', ball: 'sphere',
  torus: 'torus', ring: 'torus', donut: 'torus',
  revolve: 'revolve', lathe: 'revolve', rotate_extrude: 'revolve', rotateextrude: 'revolve', turn: 'revolve',
  extrude: 'extrude', linear_extrude: 'extrude', linearextrude: 'extrude', prism: 'extrude',
  union: 'union', add: 'union', group: 'union', combine: 'union', merge: 'union',
  difference: 'difference', subtract: 'difference', minus: 'difference', cut: 'difference',
  intersection: 'intersection', intersect: 'intersection',
  around: 'around', circular: 'around', polar: 'around', polar_array: 'around', radial: 'around', circular_array: 'around',
  tree: 'tree', bush: 'tree', shrub: 'tree', bonsai: 'tree', plant: 'tree',
  tube: 'tube', rod: 'tube', branch: 'tube', limb: 'tube', capsule: 'tube', line: 'tube', segment: 'tube',
  hull: 'hull', convex_hull: 'hull', blob: 'hull', wrap: 'hull',
  row: 'row', linear: 'row', linear_array: 'row', array: 'row', repeat: 'row',
};
const TRANSFORMS = { translate: 'translate', position: 'translate', pos: 'translate', offset: 'translate', move: 'translate', at: 'translate', rotate: 'rotate', rotation: 'rotate', rot: 'rotate', scale: 'scale' };
const META = ['name', 'comment', 'label', 'color', 'colour', 'id', 'description'];
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const xyz = (v) => (isObj(v) && ('x' in v || 'y' in v || 'z' in v) ? [v.x || 0, v.y || 0, v.z || 0] : v);

export function normalizeRecipe(node, depth = 0) {
  if (depth > 60) return node;
  const down = (c) => normalizeRecipe(c, depth + 1);
  if (Array.isArray(node)) return node.length === 1 ? down(node[0]) : { union: node.map(down) };
  if (!isObj(node)) return node;
  // Wrapped: {"recipe": …}, {"shape": {…}}, {"root": …}
  for (const w of ['recipe', 'shape', 'root', 'model', 'object', 'geometry']) {
    if (Object.keys(node).length === 1 && (isObj(node[w]) || Array.isArray(node[w]))) return down(node[w]);
  }
  const out = {};
  let kind = null, params = {};
  // {"type": "cylinder", …params} / {"shape": "cylinder", "params": {…}}
  const typeKey = ['type', 'shape', 'op', 'operation', 'kind', 'primitive'].find((k) => typeof node[k] === 'string');
  if (typeKey) {
    kind = KIND_ALIASES[node[typeKey].toLowerCase().replace(/[\s-]/g, '_')] || node[typeKey];
    for (const [k, v] of Object.entries(node)) {
      if (k === typeKey) continue;
      if (TRANSFORMS[k]) out[TRANSFORMS[k]] = xyz(v);
      else if (!META.includes(k)) params[k] = v;
    }
    if (isObj(params.params)) params = { ...params, ...params.params };
    if (isObj(params.args)) params = { ...params, ...params.args };
  } else {
    for (const [k, v] of Object.entries(node)) {
      if (TRANSFORMS[k]) out[TRANSFORMS[k]] = xyz(v);
      else if (META.includes(k)) continue;
      else if (KIND_ALIASES[k.toLowerCase()]) {
        kind = KIND_ALIASES[k.toLowerCase()];
        params = v;
      } else if (!kind) {
        kind = k;
        params = v;
      }
    }
  }
  if (!kind) return node;
  out[kind] = fixParams(kind, params, down);
  const label = node.name ?? node.label ?? node.comment;
  if (typeof label === 'string') out.name = label;
  return out;
}

function fixParams(kind, p, down) {
  const pick = (o, ...keys) => {
    for (const k of keys) if (o[k] !== undefined) return o[k];
    return undefined;
  };
  if (['union', 'difference', 'intersection', 'hull'].includes(kind)) {
    const list = Array.isArray(p) ? p : isObj(p) ? pick(p, 'children', 'shapes', 'items', 'parts', 'nodes', 'of') : null;
    if (kind === 'difference' && isObj(p) && !list) {
      const base = pick(p, 'base', 'from', 'a', 'shape');
      const minus = pick(p, 'subtract', 'minus', 'cut', 'remove', 'holes', 'tools', 'b');
      if (base) return [down(base), ...(Array.isArray(minus) ? minus : minus ? [minus] : []).map(down)];
    }
    return Array.isArray(list) ? list.map(down) : p;
  }
  if (!isObj(p)) {
    if (kind === 'sphere' && typeof p === 'number') return { r: p };
    if (kind === 'box' && (typeof p === 'number' || Array.isArray(p))) return { size: p };
    return p;
  }
  const q = { ...p };
  const half = (v) => (v === undefined ? undefined : Number(v) / 2);
  switch (kind) {
    case 'box': {
      let size = xyz(pick(q, 'size', 'dimensions', 'dims', 'extents'));
      if (size === undefined) {
        const w = pick(q, 'x', 'width', 'w', 'length', 'l'), d = pick(q, 'y', 'depth', 'd'), h = pick(q, 'z', 'height', 'h');
        if (w !== undefined || d !== undefined || h !== undefined) size = [w ?? d ?? h, d ?? w ?? h, h ?? w ?? d];
      }
      return { size };
    }
    case 'cylinder': {
      const r = pick(q, 'r', 'radius', 'r1', 'radius1', 'bottomRadius', 'radiusBottom', 'r_bottom', 'rBottom') ?? half(pick(q, 'd', 'diameter', 'd1'));
      const r2 = pick(q, 'r2', 'radius2', 'topRadius', 'radiusTop', 'r_top', 'rTop') ?? half(pick(q, 'd2', 'topDiameter'));
      return { r, h: pick(q, 'h', 'height', 'length'), ...(r2 !== undefined ? { r2 } : {}) };
    }
    case 'sphere':
      return { r: pick(q, 'r', 'radius') ?? half(pick(q, 'd', 'diameter')) };
    case 'torus':
      return { R: pick(q, 'R', 'majorRadius', 'major_radius', 'radius', 'ringRadius'), r: pick(q, 'r', 'minorRadius', 'minor_radius', 'tube', 'tubeRadius', 'thickness') };
    case 'revolve':
      return { profile: xyList(pick(q, 'profile', 'points', 'outline', 'polygon', 'path')), ...(q.degrees !== undefined || q.angle !== undefined ? { degrees: pick(q, 'degrees', 'angle') } : {}) };
    case 'extrude':
      return {
        outline: xyList(pick(q, 'outline', 'points', 'polygon', 'profile', 'shape', 'path')),
        h: pick(q, 'h', 'height', 'depth', 'length'),
        ...(q.twist !== undefined ? { twist: q.twist } : {}),
        ...(pick(q, 'scaleTop', 'scale_top', 'topScale') !== undefined ? { scaleTop: pick(q, 'scaleTop', 'scale_top', 'topScale') } : {}),
      };
    case 'tube':
      return {
        from: xyz(pick(q, 'from', 'start', 'a', 'p1', 'base')),
        to: xyz(pick(q, 'to', 'end', 'b', 'p2', 'tip')),
        r: pick(q, 'r', 'radius', 'r1', 'radius1', 'startRadius') ?? half(pick(q, 'd', 'diameter')),
        ...(pick(q, 'r2', 'radius2', 'endRadius', 'tipRadius') !== undefined ? { r2: pick(q, 'r2', 'radius2', 'endRadius', 'tipRadius') } : {}),
        ...(q.round !== undefined ? { round: q.round } : {}),
      };
    case 'around':
      return { count: pick(q, 'count', 'n', 'number', 'copies', 'times'), shape: down(pick(q, 'shape', 'child', 'item', 'node', 'of', 'children')), ...(q.axis ? { axis: String(q.axis).toLowerCase() } : {}) };
    case 'row':
      return { count: pick(q, 'count', 'n', 'number', 'copies', 'times'), step: xyz(pick(q, 'step', 'spacing', 'offset', 'delta')), shape: down(pick(q, 'shape', 'child', 'item', 'node', 'of', 'children')) };
    default:
      return q;
  }
}

// [[x, y], …] from [{x, y}] or [{r, z}] too.
function xyList(v) {
  if (!Array.isArray(v)) return v;
  return v.map((p) => (isObj(p) ? ('r' in p ? [p.r, p.z ?? p.y ?? 0] : [p.x ?? 0, p.y ?? p.z ?? 0]) : p));
}
