// Neck cuts: find where a shape narrows (a head on its neck, an arm at the
// shoulder…) and separate it along a line that runs around the narrow part,
// following the surface's creases instead of a flat plane through the whole
// model. Both pieces are closed with the same surface, so they fit back
// together seamlessly.
//
//   findNeckAt(mesh, point)  – the narrowest ring around the shape near a
//                              point (e.g. a click on the neck)
//   findNecks(mesh)          – necks anywhere on the model
//   seamLoop(mesh, neck)     – the cut line: a closed loop of mesh edges
//                              around the neck
//   cutAlongLoop(mesh, loop) – separates the two sides and closes both

import { ShapeUtils, Vector2 } from 'three';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const vert = (P, v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
const frame = (n) => {
  const U = norm(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
  return [U, cross(n, U)];
};

// Evenly spread directions over a half sphere (a plane and its flip are the same).
function directions(count) {
  const out = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const z = 1 - i / count; // 1 … 0
    const r = Math.sqrt(1 - z * z);
    out.push([Math.cos(golden * i) * r, Math.sin(golden * i) * r, z]);
  }
  return out;
}

// Directions within `angle` of n.
function around(n, angle, count = 8) {
  const [U, V] = frame(n);
  const out = [n];
  for (let i = 0; i < count; i++) {
    const a = (2 * Math.PI * i) / count;
    const s = Math.sin(angle);
    out.push(norm([0, 1, 2].map((k) => n[k] * Math.cos(angle) + s * (U[k] * Math.cos(a) + V[k] * Math.sin(a)))));
  }
  return out;
}

// Triangles with a corner within R of the point.
function trianglesNear(mesh, point, R) {
  const P = mesh.positions, I = mesh.indices;
  const near = new Uint8Array(mesh.vertexCount);
  const R2 = R * R;
  for (let v = 0; v < mesh.vertexCount; v++) {
    const dx = P[v * 3] - point[0], dy = P[v * 3 + 1] - point[1], dz = P[v * 3 + 2] - point[2];
    if (dx * dx + dy * dy + dz * dz <= R2) near[v] = 1;
  }
  const out = [];
  for (let t = 0; t < mesh.triangleCount; t++) if (near[I[t * 3]] || near[I[t * 3 + 1]] || near[I[t * 3 + 2]]) out.push(t);
  return out;
}

// Cross-section of the given triangles with the plane n·p = d, as polylines
// ({ pts, closed }). Points are matched by the mesh edge they lie on, so the
// pieces join exactly.
function slice(mesh, tris, n, d, eps) {
  const P = mesh.positions, I = mesh.indices, nv = mesh.vertexCount;
  const at = new Map(); // edge key -> point
  const ends = new Map(); // edge key -> [segment ids]
  const segs = [];
  const dist = (v) => {
    const s = n[0] * P[v * 3] + n[1] * P[v * 3 + 1] + n[2] * P[v * 3 + 2] - d;
    return Math.abs(s) < eps ? eps : s; // nothing exactly on the plane
  };
  for (const t of tris) {
    const vs = [I[t * 3], I[t * 3 + 1], I[t * 3 + 2]];
    const ds = vs.map(dist);
    const keys = [];
    for (let k = 0; k < 3; k++) {
      const a = vs[k], b = vs[(k + 1) % 3], da = ds[k], db = ds[(k + 1) % 3];
      if (da > 0 === db > 0) continue;
      const key = a < b ? a * nv + b : b * nv + a;
      if (!at.has(key)) {
        const s = da / (da - db);
        at.set(key, [0, 1, 2].map((i) => P[a * 3 + i] + (P[b * 3 + i] - P[a * 3 + i]) * s));
      }
      keys.push(key);
    }
    if (keys.length !== 2) continue;
    const id = segs.length;
    segs.push(keys);
    for (const key of keys) {
      if (!ends.has(key)) ends.set(key, []);
      ends.get(key).push(id);
    }
  }
  const used = new Uint8Array(segs.length);
  const out = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const [first, second] = segs[s];
    const keys = [first, second];
    let cur = second, closed = false;
    for (;;) {
      const nextSeg = (ends.get(cur) || []).find((x) => !used[x]);
      if (nextSeg === undefined) break;
      used[nextSeg] = 1;
      const [a, b] = segs[nextSeg];
      cur = a === cur ? b : a;
      if (cur === first) {
        closed = true;
        break;
      }
      keys.push(cur);
    }
    out.push({ pts: keys.map((k) => at.get(k)), closed });
  }
  return out;
}

function perimeter(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    p += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }
  return p;
}

function centroid(pts) {
  const c = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) c[k] += p[k] / pts.length;
  return c;
}

function distToPolyline(q, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const ab = sub(b, a);
    const t = Math.max(0, Math.min(1, dot(sub(q, a), ab) / (dot(ab, ab) || 1)));
    best = Math.min(best, Math.hypot(...sub(q, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t])));
  }
  return best;
}

// The closed ring (cross-section loop) through the plane n·p = d that is
// nearest to `near`, or null.
function ringAt(mesh, tris, n, d, near, maxDist, eps) {
  let best = null, bestDist = maxDist;
  for (const loop of slice(mesh, tris, n, d, eps)) {
    if (!loop.closed || loop.pts.length < 3) continue;
    const dd = distToPolyline(near, loop.pts);
    if (dd < bestDist) {
      bestDist = dd;
      best = loop.pts;
    }
  }
  return best;
}

function surfaceNormalNear(mesh, tris, point) {
  const P = mesh.positions, I = mesh.indices, normals = mesh.faceNormals();
  let best = -1, bestD = Infinity;
  for (const t of tris) {
    let d = 0;
    for (let k = 0; k < 3; k++) {
      const v = I[t * 3 + k] * 3;
      d += Math.hypot(P[v] - point[0], P[v + 1] - point[1], P[v + 2] - point[2]);
    }
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best < 0 ? null : [normals[best * 3], normals[best * 3 + 1], normals[best * 3 + 2]];
}

function modelSize(mesh) {
  const { min, max } = mesh.bounds();
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
}

// The narrowest ring around the shape near `point` (a point on the surface).
// Returns { normal, offset, center, perimeter, radius, ring } or null.
export function findNeckAt(mesh, point, { dirCount = 90, radii = [0.04, 0.08, 0.15, 0.25] } = {}) {
  const size = modelSize(mesh);
  const eps = size * 1e-7;
  for (const f of radii) {
    const R = size * f;
    const tris = trianglesNear(mesh, point, R * 1.6);
    if (tris.length > 400000) break;
    // The surface's direction at the point: a ring around the shape cuts
    // across the surface there (a plane lying almost flat against it would
    // only shave off a tiny cap).
    const surf = surfaceNormalNear(mesh, tris, point);
    // 1. The tightest ring through the point.
    let best = null;
    for (const n of directions(dirCount)) {
      if (surf && Math.abs(dot(n, surf)) > 0.5) continue;
      const ring = ringAt(mesh, tris, n, dot(n, point), point, R * 0.05, eps);
      if (!ring) continue;
      const c = centroid(ring);
      if (ring.some((p) => Math.hypot(...sub(p, point)) > R * 1.5)) continue;
      const per = perimeter(ring);
      if (!best || per < best.perimeter) best = { normal: n, offset: dot(n, point), center: c, perimeter: per, ring };
    }
    if (!best) continue;
    // 2. Slide along the ring's axis (and tilt a little) to the narrowest spot.
    const r0 = best.perimeter / (2 * Math.PI);
    for (let pass = 0; pass < 2; pass++) {
      const start = best;
      const candidates = pass === 0 ? [start.normal] : around(start.normal, 0.12, 8);
      for (const n of candidates) {
        for (let k = -8; k <= 8; k++) {
          const d = dot(n, start.center) + k * r0 * 0.25;
          const centre = start.center.map((x, i) => x + n[i] * (d - dot(n, start.center)));
          const ring = ringAt(mesh, tris, n, d, centre, r0 * 1.5, eps);
          if (!ring) continue;
          const c = centroid(ring);
          // Stay on the same limb: the ring's centre close to the axis.
          const off = sub(c, centre);
          if (Math.hypot(...sub(off, n.map((x) => x * dot(off, n)))) > r0 * 0.8) continue;
          const per = perimeter(ring);
          if (per < best.perimeter) best = { normal: n, offset: d, center: c, perimeter: per, ring };
        }
      }
    }
    best.radius = best.perimeter / (2 * Math.PI);
    best.tris = tris;
    return best;
  }
  return null;
}

// How much narrower the neck is than the shape on either side (1 = not at all).
function neckiness(mesh, neck, eps) {
  const r = neck.radius;
  const tris = trianglesNear(mesh, neck.center, r * 10);
  let ratio = Infinity;
  for (const side of [-1, 1]) {
    const d = neck.offset + side * r * 1.5;
    const centre = neck.center.map((x, i) => x + neck.normal[i] * side * r * 1.5);
    const ring = ringAt(mesh, tris, neck.normal, d, centre, r * 8, eps);
    // Nothing there: the end of the shape (a fingertip) – not a neck.
    if (!ring) return 1;
    ratio = Math.min(ratio, perimeter(ring) / neck.perimeter);
  }
  return ratio;
}

// Necks anywhere on the model: the model is sliced in many parallel planes
// from several directions; the rings are followed from slice to slice like
// tubes, and where a tube gets clearly narrower than on both sides there is a
// neck. Each one is then refined like a click there. Sorted best first.
export function findNecks(mesh, { slices = 48, minRatio = 1.15, maxTriangles = 3e6 } = {}) {
  const P = mesh.positions, I = mesh.indices, T = mesh.triangleCount;
  if (!T) return [];
  const size = modelSize(mesh);
  const eps = size * 1e-7;
  const s3 = Math.SQRT1_2, c3 = 1 / Math.sqrt(3);
  let dirs = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [s3, s3, 0], [s3, -s3, 0], [s3, 0, s3], [s3, 0, -s3], [0, s3, s3], [0, s3, -s3], [c3, c3, c3], [c3, c3, -c3], [c3, -c3, c3], [-c3, c3, c3]];
  if (T * dirs.length * slices > maxTriangles * 40) dirs = dirs.slice(0, 7); // big models: fewer directions
  const lo = new Float32Array(T), hi = new Float32Array(T);
  const candidates = [];
  for (const n of dirs) {
    let mn = Infinity, mx = -Infinity;
    for (let t = 0; t < T; t++) {
      let a = Infinity, b = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = I[t * 3 + k] * 3;
        const d = n[0] * P[v] + n[1] * P[v + 1] + n[2] * P[v + 2];
        if (d < a) a = d;
        if (d > b) b = d;
      }
      lo[t] = a;
      hi[t] = b;
      if (a < mn) mn = a;
      if (b > mx) mx = b;
    }
    const step = (mx - mn) / (slices + 1);
    const tubes = []; // { rings: [{ c, per, d }], last }
    let open = [];
    for (let k = 1; k <= slices; k++) {
      const d = mn + k * step;
      const tris = [];
      for (let t = 0; t < T; t++) if (lo[t] < d && hi[t] > d) tris.push(t);
      const rings = slice(mesh, tris, n, d, eps)
        .filter((l) => l.closed && l.pts.length >= 3)
        .map((l) => ({ c: centroid(l.pts), per: perimeter(l.pts), d, pt: l.pts[0] }));
      const next = [];
      for (const ring of rings) {
        const r = ring.per / (2 * Math.PI);
        // Continue the tube whose last ring is closest.
        let best = null, bestDist = r + step * 2;
        for (const tube of open) {
          const dist = Math.hypot(...sub(tube.rings[tube.rings.length - 1].c, ring.c));
          if (dist < bestDist) {
            bestDist = dist;
            best = tube;
          }
        }
        if (best && !next.includes(best)) {
          best.rings.push(ring);
          next.push(best);
        } else {
          const tube = { rings: [ring] };
          tubes.push(tube);
          next.push(tube);
        }
      }
      open = next;
    }
    // Narrow spots: a ring smaller than the biggest ones on both sides nearby.
    for (const tube of tubes) {
      const R = tube.rings;
      for (let i = 1; i + 1 < R.length; i++) {
        const per = R[i].per;
        if (per > R[i - 1].per || per > R[i + 1].per) continue;
        const reach = Math.max(2, Math.round((per / (2 * Math.PI) / step) * 2));
        let left = 0, right = 0;
        for (let j = Math.max(0, i - reach); j < i; j++) left = Math.max(left, R[j].per);
        for (let j = i + 1; j <= Math.min(R.length - 1, i + reach); j++) right = Math.max(right, R[j].per);
        const ratio = Math.min(left, right) / per;
        if (ratio >= minRatio) candidates.push({ ...R[i], ratio });
      }
    }
  }
  // Refine each like a click on the ring, best first; drop duplicates.
  candidates.sort((a, b) => b.ratio - a.ratio);
  const found = [];
  for (const cand of candidates.slice(0, 40)) {
    if (found.some((f) => Math.hypot(...sub(f.center, cand.c)) < f.radius * 1.5)) continue;
    const neck = findNeckAt(mesh, cand.pt, { dirCount: 60 });
    if (!neck) continue;
    const ratio = neckiness(mesh, neck, eps);
    if (ratio < minRatio) continue;
    neck.ratio = ratio;
    if (found.some((f) => Math.hypot(...sub(f.center, neck.center)) < Math.max(f.radius, neck.radius) * 1.5)) continue;
    found.push(neck);
    if (found.length >= 8) break;
  }
  return found.sort((a, b) => b.ratio - a.ratio);
}

// --------------------------------------------------------------------------
// The cut line

// Binary heap for Dijkstra.
class Heap {
  constructor() {
    this.k = [];
    this.v = [];
  }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const topK = k[0], topV = v[0];
    const lastK = k.pop(), lastV = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[c] >= lastK) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return [topK, topV];
  }
  get size() {
    return this.k.length;
  }
}

// A closed loop of mesh edges once around the neck. `follow` (0…1) is how
// strongly it follows creases (folds in the surface, like where a head meets
// the neck) rather than staying close to the narrowest flat ring.
// Returns a list of vertex ids (closed: the last connects to the first).
export function seamLoop(mesh, neck, { follow = 0.6, width = 0.9 } = {}) {
  const P = mesh.positions, I = mesh.indices;
  const n = neck.normal, d = neck.offset, c = neck.center, r = neck.radius;
  const [U, V] = frame(n);
  const W = r * width; // how far the line may stray along the neck
  const nv = mesh.vertexCount;
  // Vertices in the band around the neck.
  const band = new Int32Array(nv).fill(-1);
  const ids = [];
  const theta = [];
  const along = [];
  const tris = trianglesNear(mesh, c, Math.hypot(W, r * 2.5) * 1.2);
  const consider = new Set();
  for (const t of tris) for (let k = 0; k < 3; k++) consider.add(I[t * 3 + k]);
  for (const v of consider) {
    const p = sub(vert(P, v), c);
    const h = dot(p, n);
    if (Math.abs(h) > W) continue;
    const u = dot(p, U), w = dot(p, V);
    if (Math.hypot(u, w) > r * 2.5) continue; // another limb crossing the band
    band[v] = ids.length;
    ids.push(v);
    theta.push(Math.atan2(w, u));
    along.push(h);
  }
  if (ids.length < 3) return null;

  // Edges in the band with their cost: length, kept near the ring, cheaper
  // along concave creases and dearer over convex ridges.
  const { heEdge, offsets, edgeHalfEdges } = mesh.topology();
  const normals = mesh.faceNormals();
  const centre = (t) => [0, 1, 2].map((k) => (P[I[t * 3] * 3 + k] + P[I[t * 3 + 1] * 3 + k] + P[I[t * 3 + 2] * 3 + k]) / 3);
  const adj = ids.map(() => []);
  const seen = new Set();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const a = I[t * 3 + k], b = I[t * 3 + ((k + 1) % 3)];
      const ia = band[a], ib = band[b];
      if (ia < 0 || ib < 0) continue;
      const e = heEdge[t * 3 + k];
      if (seen.has(e)) continue;
      seen.add(e);
      const pa = vert(P, a), pb = vert(P, b);
      const len = Math.hypot(...sub(pa, pb));
      const mid = (along[ia] + along[ib]) / 2;
      let factor = 1 + 3 * (mid / W) ** 2;
      if (follow > 0 && offsets[e + 1] - offsets[e] === 2) {
        const f1 = (edgeHalfEdges[offsets[e]] / 3) | 0, f2 = (edgeHalfEdges[offsets[e] + 1] / 3) | 0;
        const n1 = [normals[f1 * 3], normals[f1 * 3 + 1], normals[f1 * 3 + 2]];
        const n2 = [normals[f2 * 3], normals[f2 * 3 + 1], normals[f2 * 3 + 2]];
        const angle = Math.acos(Math.max(-1, Math.min(1, dot(n1, n2))));
        const concave = dot(n1, sub(centre(f2), centre(f1))) > 0 ? 1 : -1;
        factor *= Math.max(0.08, Math.min(6, Math.exp(-follow * 4 * concave * angle)));
      }
      const cost = len * factor;
      adj[ia].push(ib, cost);
      adj[ib].push(ia, cost);
    }
  }

  // Shortest path from a vertex back to itself going once around the axis:
  // Dijkstra over (vertex, turns) where crossing the angle ±π counts a turn.
  const TURNS = 4; // -1 … 2
  const run = (s) => {
    const N = ids.length * TURNS;
    const dist = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const startState = s * TURNS + 1;
    dist[startState] = 0;
    const heap = new Heap();
    heap.push(0, startState);
    const goal = s * TURNS + 2;
    while (heap.size) {
      const [du, u] = heap.pop();
      if (du > dist[u]) continue;
      if (u === goal) break;
      const v = (u / TURNS) | 0, k = (u % TURNS) - 1;
      const list = adj[v];
      for (let i = 0; i < list.length; i += 2) {
        const w = list[i];
        let dt = theta[w] - theta[v];
        let turn = 0;
        if (dt > Math.PI) turn = -1; // went the short way across −π
        else if (dt < -Math.PI) turn = 1;
        const k2 = k + turn;
        if (k2 < -1 || k2 > 2) continue;
        const state = w * TURNS + k2 + 1;
        const nd = du + list[i + 1];
        if (nd < dist[state]) {
          dist[state] = nd;
          prev[state] = u;
          heap.push(nd, state);
        }
      }
    }
    if (dist[goal] === Infinity) return null;
    const path = [];
    for (let st = goal; st !== startState; st = prev[st]) path.push(ids[(st / TURNS) | 0]);
    path.reverse();
    return { cost: dist[goal], path };
  };

  // Start from a few points around the ring; keep the cheapest loop.
  const starts = [];
  for (let s = 0; s < 6; s++) {
    const want = -Math.PI + ((s + 0.5) * 2 * Math.PI) / 6;
    let best = -1, bestScore = Infinity;
    ids.forEach((_, i) => {
      let da = Math.abs(theta[i] - want);
      da = Math.min(da, 2 * Math.PI - da);
      const score = da * r + Math.abs(along[i]);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best >= 0 && !starts.includes(best)) starts.push(best);
  }
  let best = null;
  for (const s of starts) {
    const res = run(s);
    if (res && (!best || res.cost < best.cost)) best = res;
  }
  if (!best) return null;
  // A clean loop visits each vertex once: cut out small detours (pieces that
  // come back to a vertex without going round the neck).
  const angleOf = new Map(ids.map((v, i) => [v, theta[i]]));
  const turnOf = (list) => {
    let sum = 0;
    for (let i = 0; i < list.length; i++) {
      let dt = angleOf.get(list[(i + 1) % list.length]) - angleOf.get(list[i]);
      if (dt > Math.PI) dt -= 2 * Math.PI;
      if (dt < -Math.PI) dt += 2 * Math.PI;
      sum += dt;
    }
    return Math.round(sum / (2 * Math.PI));
  };
  let path = best.path;
  for (let guard = 0; guard < 1000; guard++) {
    const at = new Map();
    let cut = null;
    for (let i = 0; i < path.length && !cut; i++) {
      if (at.has(path[i])) cut = [at.get(path[i]), i];
      else at.set(path[i], i);
    }
    if (!cut) break;
    const [i, j] = cut;
    const inner = path.slice(i, j);
    path = turnOf(inner) !== 0 ? inner : [...path.slice(0, i), ...path.slice(j)];
  }
  return path.length >= 3 && turnOf(path) !== 0 ? path : null;
}

// --------------------------------------------------------------------------
// The cut

// Separates the mesh along a closed loop of edges and closes both sides with
// the same (mirrored) surface. The smaller side is the one split off.
// Returns { faces: mask of the split-off side after the cut, capTriangles }.
export function cutAlongLoop(mesh, loop, neck) {
  if (!loop || loop.length < 3) throw new Error('No cut line around the neck.');
  const I = mesh.indices, P = mesh.positions;
  const { heEdge, offsets, edgeHalfEdges } = mesh.topology();
  const nv = mesh.vertexCount;
  const key = (a, b) => (a < b ? a * nv + b : b * nv + a);
  const loopEdges = new Set();
  for (let i = 0; i < loop.length; i++) loopEdges.add(key(loop[i], loop[(i + 1) % loop.length]));

  // The two sides: flood fill across every edge except the cut line.
  const flood = (seed) => {
    const mask = new Uint8Array(mesh.triangleCount);
    const stack = [seed];
    mask[seed] = 1;
    let count = 0;
    while (stack.length) {
      const t = stack.pop();
      count++;
      for (let k = 0; k < 3; k++) {
        const a = I[t * 3 + k], b = I[t * 3 + ((k + 1) % 3)];
        if (loopEdges.has(key(a, b))) continue;
        const e = heEdge[t * 3 + k];
        for (let i = offsets[e]; i < offsets[e + 1]; i++) {
          const o = (edgeHalfEdges[i] / 3) | 0;
          if (!mask[o]) {
            mask[o] = 1;
            stack.push(o);
          }
        }
      }
    }
    return { mask, count };
  };
  // The faces on either side of the first loop edge.
  const a0 = loop[0], b0 = loop[1];
  let faceAB = -1, faceBA = -1; // with a0→b0 / b0→a0 in their winding
  for (let h = 0; h < I.length; h++) {
    const a = I[h], b = I[h - (h % 3) + ((h % 3) + 1) % 3];
    if (a === a0 && b === b0) faceAB = (h / 3) | 0;
    if (a === b0 && b === a0) faceBA = (h / 3) | 0;
  }
  if (faceAB < 0 || faceBA < 0) throw new Error('The cut line runs along an open edge – close the holes first.');
  const sideA = flood(faceAB);
  if (sideA.mask[faceBA]) throw new Error('The cut line does not go all the way round – try another spot.');
  const sideB = flood(faceBA);
  // Split off the smaller side.
  const [cutSide, otherFace] = sideA.count <= sideB.count ? [sideA, faceBA] : [sideB, faceAB];
  const mask = cutSide.mask;

  // The cap: the loop triangulated once, projected onto the neck plane. On the
  // side that keeps its vertices the cap runs against that side's edges.
  const n = neck?.normal || [0, 0, 1];
  const [U, V] = frame(n);
  const restHasAB = otherFace === faceAB; // the rest uses a0→b0, so its cap goes b0→a0
  const order = restHasAB ? [...loop].reverse() : [...loop];
  const pts2 = order.map((v) => {
    const p = vert(P, v);
    return new Vector2(dot(p, U), dot(p, V));
  });
  let area = 0;
  for (let i = 0; i < pts2.length; i++) {
    const p = pts2[i], q = pts2[(i + 1) % pts2.length];
    area += p.x * q.y - q.x * p.y;
  }
  const tris = ShapeUtils.triangulateShape(pts2, []).map(([i, j, k]) => {
    const s = (pts2[j].x - pts2[i].x) * (pts2[k].y - pts2[i].y) - (pts2[k].x - pts2[i].x) * (pts2[j].y - pts2[i].y);
    return s * area >= 0 ? [order[i], order[j], order[k]] : [order[i], order[k], order[j]];
  });
  if (!tris.length) throw new Error('Could not close the cut.');

  // Detach the smaller side (its loop vertices get copies), then add the caps.
  const { dup } = mesh.splitOff(mask, { close: false });
  const capIdx = [];
  for (const [i, j, k] of tris) capIdx.push(i, j, k); // rest side
  for (const [i, j, k] of tris) capIdx.push(dup[i], dup[k], dup[j]); // split-off side, mirrored
  const indices = new Uint32Array(mesh.indices.length + capIdx.length);
  indices.set(mesh.indices);
  indices.set(capIdx, mesh.indices.length);
  const before = mesh.triangleCount;
  mesh._set(mesh.positions, indices);
  // Faces of the split-off side (its old faces keep their numbers; the second
  // half of the caps belongs to it).
  const faces = new Uint8Array(mesh.triangleCount);
  faces.set(mask);
  for (let t = before + tris.length; t < mesh.triangleCount; t++) faces[t] = 1;
  return { faces, capTriangles: tris.length };
}
