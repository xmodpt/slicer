// Body parts of a standing figure (Z up): head, torso, arms, legs.
//
// The figure is sliced into many horizontal levels. Each slice cuts it into
// rings (the torso, an arm, a leg…); rings that overlap from one level to the
// next belong to the same "tube". From that:
//   head  – everything above the neck that connects to the top;
//   legs  – the tubes rising from the bottom until they join;
//   torso – from the neck down to where the legs join;
//   arms  – the other tubes beside the torso.
// Every triangle cut by a slice gets its ring's part; the triangles in between
// take the part of their nearest labelled neighbours. The joints (neck,
// shoulders, hips) are returned as rings to cut along (see neck.js).

import { findHeadNeck } from './neck.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function pointInPolygon([x, y], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Horizontal cross-section at height z: closed rings with their points (x, y),
// area, centre and the triangles they cut.
function sliceLevel(mesh, tris, z) {
  const P = mesh.positions, I = mesh.indices, nv = mesh.vertexCount;
  const at = new Map(), ends = new Map(), segs = [];
  const h = (v) => {
    const d = P[v * 3 + 2] - z;
    return Math.abs(d) < 1e-9 ? 1e-9 : d;
  };
  for (const t of tris) {
    const vs = [I[t * 3], I[t * 3 + 1], I[t * 3 + 2]];
    const ds = vs.map(h);
    const keys = [];
    for (let k = 0; k < 3; k++) {
      const a = vs[k], b = vs[(k + 1) % 3], da = ds[k], db = ds[(k + 1) % 3];
      if (da > 0 === db > 0) continue;
      const key = a < b ? a * nv + b : b * nv + a;
      if (!at.has(key)) {
        const s = da / (da - db);
        at.set(key, [P[a * 3] + (P[b * 3] - P[a * 3]) * s, P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * s]);
      }
      keys.push(key);
    }
    if (keys.length !== 2) continue;
    const id = segs.length;
    segs.push({ keys, t });
    for (const key of keys) {
      if (!ends.has(key)) ends.set(key, []);
      ends.get(key).push(id);
    }
  }
  const used = new Uint8Array(segs.length);
  const rings = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const [first, second] = segs[s].keys;
    const keys = [first, second];
    const ringTris = [segs[s].t];
    let cur = second, closed = false;
    for (;;) {
      const next = (ends.get(cur) || []).find((x) => !used[x]);
      if (next === undefined) break;
      used[next] = 1;
      ringTris.push(segs[next].t);
      const [a, b] = segs[next].keys;
      cur = a === cur ? b : a;
      if (cur === first) {
        closed = true;
        break;
      }
      keys.push(cur);
    }
    if (!closed || keys.length < 3) continue;
    const pts = keys.map((k) => at.get(k));
    let area = 0, cx = 0, cy = 0, per = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
      const cr = x0 * y1 - x1 * y0;
      area += cr;
      cx += (x0 + x1) * cr;
      cy += (y0 + y1) * cr;
      per += Math.hypot(x1 - x0, y1 - y0);
    }
    area /= 2;
    const c = Math.abs(area) > 1e-12 ? [cx / (6 * area), cy / (6 * area)] : pts.reduce((s2, p) => [s2[0] + p[0] / pts.length, s2[1] + p[1] / pts.length], [0, 0]);
    rings.push({ pts, area: Math.abs(area), c, per, z, tris: ringTris, part: -1 });
  }
  // Rings inside other rings (inner surfaces, overlapping pieces) belong to
  // the ring around them.
  rings.sort((a, b) => b.area - a.area);
  const out = [];
  for (const r of rings) {
    const host = out.find((o) => pointInPolygon(r.c, o.pts));
    if (host) host.tris.push(...r.tris);
    else out.push(r);
  }
  return out;
}

const PART_NAMES = ['Head', 'Torso', 'Arm', 'Arm', 'Leg', 'Leg', 'Base'];

function ringsBox(rings) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) for (const [x, y] of r.pts) (b[0] = Math.min(b[0], x)), (b[1] = Math.min(b[1], y)), (b[2] = Math.max(b[2], x)), (b[3] = Math.max(b[3], y));
  return (b[2] - b[0]) * (b[3] - b[1]);
}

// The level where a base ends: { k } (the first level above it) or null.
function findBase(L, levels) {
  const k0 = L.findIndex((l) => l.length);
  if (k0 < 0 || L[k0].length !== 1) return null;
  const area0 = L[k0][0].area, box0 = ringsBox(L[k0]);
  for (let k = k0 + 1; k < k0 + levels * 0.15 && k < levels; k++) {
    const area = L[k].reduce((s, r) => s + r.area, 0);
    if (area > area0 * 0.5) continue;
    // Above it: smaller than the base all round, and standing on it.
    if (!L[k].length || ringsBox(L[k]) > box0 * 0.6) return null;
    if (!L[k].every((r) => pointInPolygon(r.c, L[k0][0].pts))) return null;
    return { k };
  }
  return null;
}

// The ankle: the narrowest ring in the lower part of a leg, clearly narrower
// than the foot below it.
function ankleRing(rings) {
  // rings: top first
  const n = rings.length;
  if (n < 10) return null;
  let best = null;
  for (let i = Math.floor(n * 0.6); i < n - Math.max(2, Math.floor(n * 0.08)); i++) if (!best || rings[i].per < best.per) best = rings[i];
  if (!best) return null;
  const below = rings.filter((r) => r.k < best.k);
  const foot = Math.max(...below.map((r) => r.per));
  return best.per < foot * 0.8 ? best : null;
}

// Returns { parts: [{ name, faces }], objectOf, joints: [{ name, neck }] } or
// null when the model doesn't look like a standing figure.
export function findBodyParts(mesh, { levels = 160 } = {}) {
  const P = mesh.positions, I = mesh.indices, T = mesh.triangleCount;
  if (!T) return null;
  const { min, max } = mesh.bounds();
  const height = max[2] - min[2];
  if (!(height > 0)) return null;
  const step = height / levels;
  // Triangles by height band, so each slice only looks at the ones it can cut.
  const buckets = Array.from({ length: levels + 1 }, () => []);
  for (let t = 0; t < T; t++) {
    const a = P[I[t * 3] * 3 + 2], b = P[I[t * 3 + 1] * 3 + 2], c = P[I[t * 3 + 2] * 3 + 2];
    const lo = Math.max(0, Math.floor((Math.min(a, b, c) - min[2]) / step - 0.5));
    const hi = Math.min(levels, Math.ceil((Math.max(a, b, c) - min[2]) / step - 0.5));
    for (let k = lo; k <= hi; k++) buckets[k].push(t);
  }
  const L = [];
  for (let k = 0; k < levels; k++) L.push(sliceLevel(mesh, buckets[k], min[2] + (k + 0.5) * step));

  // Links between rings on neighbouring levels: they overlap.
  const overlaps = (a, b) => pointInPolygon(a.c, b.pts) || pointInPolygon(b.c, a.pts);
  for (let k = 0; k < levels; k++) {
    for (const r of L[k]) {
      r.up = k + 1 < levels ? L[k + 1].filter((o) => overlaps(r, o)) : [];
      r.down = k > 0 ? L[k - 1].filter((o) => overlaps(r, o)) : [];
      r.k = k;
    }
  }
  const HEAD = 0, TORSO = 1, ARM_A = 2, ARM_B = 3, LEG_A = 4, LEG_B = 5, BASE = 6, FOOT_A = 7, FOOT_B = 8;

  // A base (a plinth the figure stands on): one wide ring at the bottom whose
  // area drops sharply a little higher up, where the feet stand on it.
  const base = findBase(L, levels);
  if (base) for (let k = 0; k < base.k; k++) for (const r of L[k]) r.part = BASE;

  // Head: above the neck, connected to the top.
  const neck = findHeadNeck(mesh);
  if (!neck) return null;
  const neckK = Math.round((neck.center[2] - min[2]) / step - 0.5);
  const top = L[levels - 1][0] ? L[levels - 1] : L.slice().reverse().find((l) => l.length);
  const stack = [...(top || [])];
  while (stack.length) {
    const r = stack.pop();
    if (r.part >= 0 || r.k <= neckK) continue;
    r.part = HEAD;
    stack.push(...r.down, ...r.up);
  }

  // Torso: from the neck down, the biggest ring under the previous one.
  let cur = L[neckK]?.find((r) => pointInPolygon([neck.center[0], neck.center[1]], r.pts)) || L[neckK]?.[0];
  const torsoRings = [];
  while (cur) {
    cur.part = TORSO;
    torsoRings.push(cur);
    const below = cur.down.filter((r) => r.part < 0);
    if (!below.length) break;
    below.sort((a, b) => b.area - a.area);
    // The legs: the torso splits into two similar rings.
    if (below.length >= 2 && below[1].area > below[0].area * 0.35 && cur.k < neckK - 4) break;
    cur = below[0];
  }
  const crotchK = cur ? cur.k : 0;

  // Legs: the (up to two) biggest tubes from the crotch down to the floor.
  const legStarts = (cur?.down || []).filter((r) => r.part < 0).sort((a, b) => b.area - a.area).slice(0, 2);
  const legSide = legStarts.length === 2 ? (legStarts[0].c[0] <= legStarts[1].c[0] ? [LEG_A, LEG_B] : [LEG_B, LEG_A]) : [LEG_A];
  legStarts.forEach((start, i) => {
    let r = start;
    while (r && r.part < 0) {
      r.part = legSide[i];
      r = r.down.filter((o) => o.part < 0).sort((a, b) => b.area - a.area)[0];
    }
  });

  // Arms: the other tubes beside the torso (by side, as seen in the Front view).
  const torsoX = torsoRings.length ? torsoRings.reduce((s, r) => s + r.c[0], 0) / torsoRings.length : 0;
  const armRings = [];
  for (const level of L) for (const r of level) if (r.part < 0 && r.k > crotchK - levels * 0.35 && r.k < neckK) armRings.push(r);
  for (const r of armRings) r.part = r.c[0] < torsoX ? ARM_A : ARM_B;
  // Whatever is left (bits below the hands, a base…) goes with the torso.
  for (const level of L) for (const r of level) if (r.part < 0) r.part = TORSO;

  // Triangles: from the rings that cut them, then spread to the rest.
  const objectOf = new Int32Array(T).fill(-1);
  const queue = [];
  for (const level of L) {
    for (const r of level) {
      for (const t of r.tris) {
        if (objectOf[t] < 0) {
          objectOf[t] = r.part;
          queue.push(t);
        }
      }
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const t = queue[q];
    mesh.forEachEdgeNeighbour(t, (o) => {
      if (objectOf[o] < 0) {
        objectOf[o] = objectOf[t];
        queue.push(o);
      }
    });
  }
  for (let t = 0; t < T; t++) if (objectOf[t] < 0) objectOf[t] = TORSO;

  const faces = Array.from({ length: 7 }, () => []);
  for (let t = 0; t < T; t++) faces[objectOf[t]].push(t);
  const names = {
    [HEAD]: 'Head',
    [TORSO]: 'Torso',
    [ARM_A]: 'Arm (left in Front view)',
    [ARM_B]: 'Arm (right in Front view)',
    [LEG_A]: 'Leg (left in Front view)',
    [LEG_B]: 'Leg (right in Front view)',
    [BASE]: 'Base',
  };
  const parts = faces.map((f, i) => ({ id: i, name: names[i] || PART_NAMES[i], faces: f })).filter((p) => p.faces.length);
  if (parts.length < 3) return null;

  // Joints to cut along: the neck, and where each arm and leg starts (the ring
  // just off the torso), with the limb's direction.
  const joints = [{ name: 'Neck (head)', neck }];
  const limbJoint = (part, name, fromTop) => {
    const rings = [];
    for (const level of L) for (const r of level) if (r.part === part) rings.push(r);
    if (rings.length < 4) return;
    rings.sort((a, b) => b.k - a.k); // top first
    const at = fromTop === 'ankle' ? ankleRing(rings) : fromTop ? rings[Math.min(2, rings.length - 1)] : rings[rings.length - 1];
    if (!at) return;
    const further = fromTop ? rings[Math.min(rings.length - 1, 8)] : rings[0];
    const c3 = [at.c[0], at.c[1], at.z];
    const f3 = [further.c[0], further.c[1], further.z];
    const dir = fromTop === 'ankle' ? [0, 0, 1] : norm(sub(c3, f3).every((x) => Math.abs(x) < 1e-9) ? [0, 0, 1] : sub(c3, f3));
    const radius = at.per / (2 * Math.PI);
    joints.push({ name, part, neck: { normal: dir, offset: dir[0] * c3[0] + dir[1] * c3[1] + dir[2] * c3[2], center: c3, radius, perimeter: at.per } });
  };
  limbJoint(ARM_A, 'Shoulder – arm (left in Front view)', true);
  limbJoint(ARM_B, 'Shoulder – arm (right in Front view)', true);
  limbJoint(LEG_A, 'Hip – leg (left in Front view)', true);
  limbJoint(LEG_B, 'Hip – leg (right in Front view)', true);
  limbJoint(LEG_A, 'Ankle – foot (left in Front view)', 'ankle');
  limbJoint(LEG_B, 'Ankle – foot (right in Front view)', 'ankle');
  return { parts, objectOf, joints, base: base ? { z: min[2] + (base.k + 0.25) * step } : null };
}
