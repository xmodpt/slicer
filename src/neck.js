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

// The surface's average direction around a point (area-weighted over a
// patch, so bumps on scanned models don't throw it off).
function surfaceNormalNear(mesh, tris, point, radius) {
  const P = mesh.positions, I = mesh.indices;
  const sum = [0, 0, 0];
  for (const t of tris) {
    const a = vert(P, I[t * 3]), b = vert(P, I[t * 3 + 1]), c = vert(P, I[t * 3 + 2]);
    const m = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3);
    if (Math.hypot(...sub(m, point)) > radius) continue;
    const nr = cross(sub(b, a), sub(c, a)); // length = 2 × area
    for (let k = 0; k < 3; k++) sum[k] += nr[k];
  }
  const l = Math.hypot(...sum);
  return l > 0 ? sum.map((x) => x / l) : null;
}

function pointInPolygon2([x, y], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonArea2(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
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
    const surf = surfaceNormalNear(mesh, tris, point, R * 0.3);
    // 1. The tightest ring through the point.
    let best = null;
    for (const n of directions(dirCount)) {
      if (surf && Math.abs(dot(n, surf)) > 0.5) continue;
      const ring = ringAt(mesh, tris, n, dot(n, point), point, R * 0.05, eps);
      if (!ring) continue;
      const c = centroid(ring);
      if (ring.some((p) => Math.hypot(...sub(p, point)) > R * 1.5)) continue;
      const per = perimeter(ring);
      if (per < R * 0.6) continue; // a ring around a bump, not around the shape
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
          if (per < Math.max(R * 0.6, start.perimeter * 0.35)) continue; // a bump, not the shape
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
    // Compare with the shape a little and a bit further away on this side.
    let best = 0;
    for (const k of [1.5, 2.5]) {
      const d = neck.offset + side * r * k;
      const centre = neck.center.map((x, i) => x + neck.normal[i] * side * r * k);
      const ring = ringAt(mesh, tris, neck.normal, d, centre, r * 8, eps);
      if (ring) best = Math.max(best, perimeter(ring) / neck.perimeter);
    }
    // Nothing there: the end of the shape (a fingertip) – not a neck.
    if (!best) return 1;
    ratio = Math.min(ratio, best);
  }
  return ratio;
}

// The head's neck on an upright figure: from the top of the model (the head)
// down, slice by slice, following the same shape: the rings grow through the
// head, shrink to the neck, and grow again at the shoulders. The narrowest ring
// between is the neck. Returns a neck (refined like a click there) or null.
export function findHeadNeck(mesh) {
  const P = mesh.positions, I = mesh.indices, T = mesh.triangleCount;
  if (!T) return null;
  const { min, max } = mesh.bounds();
  const height = max[2] - min[2];
  if (!(height > 0)) return null;
  const eps = modelSize(mesh) * 1e-7;
  const up = [0, 0, 1];
  const zlo = new Float32Array(T), zhi = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    const a = P[I[t * 3] * 3 + 2], b = P[I[t * 3 + 1] * 3 + 2], c = P[I[t * 3 + 2] * 3 + 2];
    zlo[t] = Math.min(a, b, c);
    zhi[t] = Math.max(a, b, c);
  }
  // The topmost point: where the head is.
  let top = 0;
  for (let v = 1; v < mesh.vertexCount; v++) if (P[v * 3 + 2] > P[top * 3 + 2]) top = v;
  let prev = [P[top * 3], P[top * 3 + 1]];
  let prevR = Infinity;
  const step = height / 240;
  const rings = [];
  for (let k = 2; k * step < height * 0.6; k++) {
    const z = max[2] - k * step;
    // Triangles touching the height (a slice exactly at a row of points must
    // still see the triangles around it).
    const tris = [];
    for (let t = 0; t < T; t++) if (zlo[t] <= z + eps && zhi[t] >= z - eps) tris.push(t);
    // The ring around the shape we follow: the biggest one around the last
    // centre (inner surfaces and overlapping pieces lie inside it), else the
    // nearest.
    let best = null, bestD = Infinity, bestArea = -1;
    for (const loop of slice(mesh, tris, up, z, eps)) {
      if (!loop.closed || loop.pts.length < 3) continue;
      const c = centroid(loop.pts);
      const d = Math.hypot(c[0] - prev[0], c[1] - prev[1]);
      const around = pointInPolygon2(prev, loop.pts);
      const area = Math.abs(polygonArea2(loop.pts));
      const better = around ? bestArea < 0 || area > bestArea : bestArea < 0 && d < bestD;
      if (better) {
        if (around) bestArea = area;
        bestD = d;
        best = { c, per: perimeter(loop.pts), pt: loop.pts[0], z };
      }
    }
    if (best && bestArea >= 0) bestD = 0;
    // Lost the shape (or jumped to another one): stop.
    if (!best || (Number.isFinite(prevR) && bestD > Math.max(prevR, best.per / (2 * Math.PI)) * 1.5)) break;
    rings.push(best);
    prev = [best.c[0], best.c[1]];
    prevR = best.per / (2 * Math.PI);
  }
  if (rings.length < 6) return null;
  // Smooth the perimeters a little (scans are bumpy), then find the first
  // clear narrowing after the head's widest point.
  const per = rings.map((_, i) => {
    let s2 = 0, n2 = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(rings.length - 1, i + 2); j++) (s2 += rings[j].per), n2++;
    return s2 / n2;
  });
  let widest = 0, pick = -1;
  for (let i = 1; i < per.length - 1; i++) {
    widest = Math.max(widest, per[i - 1]);
    if (per[i] > per[i - 1] || per[i] > per[i + 1]) continue;
    if (widest < per[i] * 1.12) continue;
    // …and the shape widens again below (shoulders).
    let below = 0;
    for (let j = i + 1; j < per.length; j++) below = Math.max(below, per[j]);
    if (below < per[i] * 1.12) continue;
    pick = i;
    break;
  }
  if (pick < 0) return null;
  const ring = rings[pick];
  const neck = findNeckAt(mesh, ring.pt) || null;
  const ringR = ring.per / (2 * Math.PI);
  // Use the refined ring only if it is the same neck: about as big, around the
  // same middle, and roughly upright.
  const close =
    neck &&
    Math.hypot(neck.center[0] - ring.c[0], neck.center[1] - ring.c[1]) < ringR &&
    Math.abs(neck.center[2] - ring.z) < ringR * 2.5 &&
    neck.radius > ringR * 0.6 &&
    neck.radius < ringR * 1.6 &&
    Math.abs(neck.normal[2]) > 0.6;
  const result = close
    ? neck
    : { normal: up, offset: ring.z, center: ring.c, perimeter: ring.per, radius: ring.per / (2 * Math.PI) };
  result.head = true;
  result.ratio = Math.min(widest, Math.max(...per.slice(pick + 1))) / per[pick];
  return result;
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
      for (let t = 0; t < T; t++) if (lo[t] <= d + eps && hi[t] >= d - eps) tris.push(t);
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
  // Refine each like a click on the ring, best first; drop duplicates. The
  // head's neck (from the top down) comes first.
  candidates.sort((a, b) => b.ratio - a.ratio);
  const found = [];
  const head = findHeadNeck(mesh);
  if (head) found.push(head);
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
  return found.sort((a, b) => (b.head ? 1 : 0) - (a.head ? 1 : 0) || b.ratio - a.ratio);
}

// Which way along the neck's axis the body is (the bigger side): +1 or −1,
// 0 when unclear.
export function bodySide(mesh, neck) {
  const r = neck.radius;
  const tris = trianglesNear(mesh, neck.center, r * 10);
  const eps = modelSize(mesh) * 1e-7;
  const size = (sideSign) => {
    let best = 0;
    for (const k of [2, 3, 4]) {
      const centre = neck.center.map((x, i) => x + neck.normal[i] * sideSign * r * k);
      const ring = ringAt(mesh, tris, neck.normal, neck.offset + sideSign * r * k, centre, r * 8, eps);
      if (ring) best = Math.max(best, perimeter(ring));
    }
    return best;
  };
  const up = size(1), down = size(-1);
  return up > down * 1.05 ? 1 : down > up * 1.05 ? -1 : 0;
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
//   painted: per-vertex mask of a line painted by the user – the cut follows it
//   reach: how far the line may stray along the neck, in mm (instead of width)
//   through: a vertex the line must pass through (e.g. where the user clicked)
//   collar: look for the joint between the neck and clothes – far towards the
//     body, hardly towards the head, on the neck's own surface
export function seamLoop(mesh, neck, { follow = 0.6, width = 0.9, painted = null, reach = 0, through = -1, collar = false } = {}) {
  const P = mesh.positions, I = mesh.indices;
  const n = neck.normal, c = neck.center, r = neck.radius;
  const [U, V] = frame(n);
  let W = reach > 0 ? reach : r * width; // how far the line may stray along the neck
  let lo = -W, hi = W; // the band along the axis
  const side = collar ? bodySide(mesh, neck) : 0; // +1 / −1: the body is that way along n
  if (collar) {
    W = r * 4.5;
    [lo, hi] = side > 0 ? [-r * 0.5, W] : side < 0 ? [-W, r * 0.5] : [-W, W];
  }
  const spread = Math.max(r * 2.5, neck.spread || 0); // how far from the axis
  const nv = mesh.vertexCount;
  // Vertices in the band around the neck.
  const band = new Int32Array(nv).fill(-1);
  const ids = [];
  const theta = [];
  const along = [];
  const tris = trianglesNear(mesh, c, Math.hypot(Math.max(-lo, hi), spread) * 1.2);
  const consider = new Set();
  for (const t of tris) for (let k = 0; k < 3; k++) consider.add(I[t * 3 + k]);
  for (const v of consider) {
    const p = sub(vert(P, v), c);
    const h = dot(p, n);
    if (h < lo || h > hi) continue;
    const u = dot(p, U), w = dot(p, V);
    if (Math.hypot(u, w) > spread) continue; // another limb crossing the band
    band[v] = ids.length;
    ids.push(v);
    theta.push(Math.atan2(w, u));
    along.push(h);
  }
  if (ids.length < 3) return null;

  // Edges in the band, with how concave the surface is along each: positive
  // in folds and creases, negative over ridges.
  const { heEdge, offsets, edgeHalfEdges } = mesh.topology();
  const normals = mesh.faceNormals();
  const centre = (t) => [0, 1, 2].map((k) => (P[I[t * 3] * 3 + k] + P[I[t * 3 + 1] * 3 + k] + P[I[t * 3 + 2] * 3 + k]) / 3);
  const edges = []; // [ia, ib, length, signed angle]
  const seen = new Set();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const a = I[t * 3 + k], b = I[t * 3 + ((k + 1) % 3)];
      const ia = band[a], ib = band[b];
      if (ia < 0 || ib < 0) continue;
      const e = heEdge[t * 3 + k];
      if (seen.has(e)) continue;
      seen.add(e);
      let angle = 0;
      if (offsets[e + 1] - offsets[e] === 2) {
        const f1 = (edgeHalfEdges[offsets[e]] / 3) | 0, f2 = (edgeHalfEdges[offsets[e] + 1] / 3) | 0;
        const n1 = [normals[f1 * 3], normals[f1 * 3 + 1], normals[f1 * 3 + 2]];
        const n2 = [normals[f2 * 3], normals[f2 * 3 + 1], normals[f2 * 3 + 2]];
        angle = Math.acos(Math.max(-1, Math.min(1, dot(n1, n2)))) * (dot(n1, sub(centre(f2), centre(f1))) > 0 ? 1 : -1);
      }
      edges.push([ia, ib, Math.hypot(...sub(vert(P, a), vert(P, b))), angle]);
    }
  }
  // Creases measured at a scale of a few millimetres, not edge by edge – on a
  // bumpy scan every small dent is a "crease": how far the surface around a
  // point bends inwards (a valley, like the edge of a collar pressing on the
  // neck) or outwards (a ridge), from smoothed positions and normals.
  const nb = ids.map(() => []);
  let edgeSum = 0;
  for (const [ia, ib, len] of edges) {
    nb[ia].push(ib);
    nb[ib].push(ia);
    edgeSum += len;
  }
  const avgEdge = edgeSum / (edges.length || 1);
  const scale = r * 0.35;
  const rounds = Math.max(2, Math.min(80, Math.round((scale / (avgEdge || scale)) ** 2)));
  let pos = ids.map((v) => vert(P, v));
  let nor = ids.map(() => [0, 0, 0]);
  for (const t of tris) {
    const nrm = [normals[t * 3], normals[t * 3 + 1], normals[t * 3 + 2]];
    for (let k = 0; k < 3; k++) {
      const i = band[I[t * 3 + k]];
      if (i >= 0) for (let a = 0; a < 3; a++) nor[i][a] += nrm[a];
    }
  }
  nor = nor.map(norm);
  const origin = pos;
  for (let round = 0; round < rounds; round++) {
    const p2 = pos.map((p, i) => {
      const out = [...p];
      for (const j of nb[i]) for (let a = 0; a < 3; a++) out[a] += pos[j][a];
      return out.map((x) => x / (nb[i].length + 1));
    });
    const n2 = nor.map((p, i) => {
      const out = [...p];
      for (const j of nb[i]) for (let a = 0; a < 3; a++) out[a] += nor[j][a];
      return norm(out);
    });
    pos = p2;
    nor = n2;
  }
  let bend = origin.map((p, i) => dot(sub(pos[i], p), nor[i]));
  const sorted = bend.map(Math.abs).sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length * 0.95)] || 1;
  bend = bend.map((x) => x / typical); // about −1 … 1; positive in valleys

  // Cost: length, kept near the ring, cheaper along valleys (and along a
  // painted line), dearer over ridges.
  const adj = ids.map(() => []);
  for (const [ia, ib, len, rawAngle] of edges) {
    const mid = (along[ia] + along[ib]) / 2;
    let factor = collar ? 1 + 0.15 * (mid / r) ** 2 : 1 + 3 * (mid / W) ** 2;
    if (collar) {
      // Stay on the neck's own surface, not the outside of the collar.
      const pm = sub([0, 1, 2].map((k) => (origin[ia][k] + origin[ib][k]) / 2), c);
      const rad = Math.hypot(dot(pm, U), dot(pm, V));
      factor *= 1 + 6 * Math.max(0, rad / r - 1.25) ** 2;
    }
    if (follow > 0) {
      const valley = (bend[ia] + bend[ib]) / 2 + 0.6 * rawAngle;
      factor *= Math.max(0.03, Math.min(8, Math.exp(-follow * 3 * valley)));
    }
    if (painted) {
      const pa = painted[ids[ia]], pb = painted[ids[ib]];
      factor *= pa && pb ? 0.02 : pa || pb ? 0.2 : 1;
    }
    const cost = len * factor;
    adj[ia].push(ib, cost);
    adj[ib].push(ia, cost);
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

  // Start from a few points around the ring (on the painted line, if any);
  // keep the cheapest loop.
  const starts = [];
  if (through >= 0 && band[through] >= 0) starts.push(band[through]);
  else if (painted) {
    const onLine = ids.map((v, i) => i).filter((i) => painted[ids[i]]);
    for (let s = 0; s < 6 && onLine.length; s++) {
      const want = -Math.PI + ((s + 0.5) * 2 * Math.PI) / 6;
      let best = -1, bestScore = Infinity;
      for (const i of onLine) {
        let da = Math.abs(theta[i] - want);
        da = Math.min(da, 2 * Math.PI - da);
        if (da < bestScore) {
          bestScore = da;
          best = i;
        }
      }
      if (best >= 0 && !starts.includes(best)) starts.push(best);
    }
  }
  for (let s = 0; s < 6 && !painted && !starts.length; s++) {
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
  // A real ring around the neck, not a tiny loop around a point.
  if (path.length < 6 || perimeter(path.map((v) => vert(P, v))) < r * 2) return null;
  return turnOf(path) !== 0 ? path : null;
}

// A "neck" fitted to a line painted around the shape: its centre, the
// direction it goes around, and how far it strays – for seamLoop(…, { painted }).
export function neckFromPainting(mesh, painted) {
  const P = mesh.positions;
  const pts = [];
  for (let v = 0; v < mesh.vertexCount; v++) if (painted[v]) pts.push(vert(P, v));
  if (pts.length < 6) return null;
  const c0 = centroid(pts);
  // The painted ring's plane: the direction of least spread.
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) {
    const q = sub(p, c0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += q[i] * q[j];
  }
  const n = smallestEigenvector(C);
  const [U, V] = frame(n);
  // Its centre: a circle fitted through the painted points (a stroke on one
  // side only still gives the right middle).
  const uv = pts.map((p) => [dot(sub(p, c0), U), dot(sub(p, c0), V)]);
  const fit = fitCircle(uv);
  const angleOf = ([u, v]) => Math.atan2(v - (fit?.cy ?? 0), u - (fit?.cx ?? 0));
  const angles = uv.map(angleOf).sort((a, b) => a - b);
  let gap = 2 * Math.PI - (angles[angles.length - 1] - angles[0]);
  for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i] - angles[i - 1]);
  const coverage = 1 - gap / (2 * Math.PI);
  if (fit && coverage >= 0.6) {
    const c = [0, 1, 2].map((k) => c0[k] + U[k] * fit.cx + V[k] * fit.cy);
    let spread = 0, reach = 0;
    for (const p of pts) {
      const q = sub(p, c);
      spread = Math.max(spread, Math.hypot(dot(q, U), dot(q, V)));
      reach = Math.max(reach, Math.abs(dot(q, n)));
    }
    const r = fit.r;
    return { normal: n, offset: dot(n, c), center: c, radius: r, perimeter: 2 * Math.PI * r, spread: Math.max(spread, r) * 1.3, reach: reach + r * 0.6, coverage };
  }
  // A short stroke: find the neck there (like a click) for the centre and
  // direction; the painting then steers the line.
  let seed = pts[0], best = Infinity;
  for (const p of pts) {
    const d = Math.hypot(...sub(p, c0));
    if (d < best) {
      best = d;
      seed = p;
    }
  }
  const base = findNeckAt(mesh, seed);
  if (!base) return null;
  let far = 0, wide = 0;
  const [U2, V2] = frame(base.normal);
  for (const p of pts) {
    const q = sub(p, base.center);
    far = Math.max(far, Math.abs(dot(q, base.normal)));
    wide = Math.max(wide, Math.hypot(dot(q, U2), dot(q, V2)));
  }
  return { ...base, spread: Math.max(base.radius * 2.5, wide * 1.3), reach: Math.max(base.radius * 3, far + base.radius * 0.5), coverage };
}

// Least-squares circle through 2D points: { cx, cy, r } or null.
function fitCircle(pts) {
  // u² + v² + D u + E v + F = 0
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (const [u, v] of pts) {
    const row = [u, v, 1], rhs = -(u * u + v * v);
    for (let i = 0; i < 3; i++) {
      b[i] += row[i] * rhs;
      for (let j = 0; j < 3; j++) A[i][j] += row[i] * row[j];
    }
  }
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(A);
  if (Math.abs(d) < 1e-12) return null;
  const solve = (k) => det(A.map((row, i) => row.map((x, j) => (j === k ? b[i] : x)))) / d;
  const D = solve(0), E = solve(1), F = solve(2);
  const cx = -D / 2, cy = -E / 2;
  const r2 = cx * cx + cy * cy - F;
  return r2 > 0 ? { cx, cy, r: Math.sqrt(r2) } : null;
}

// Eigenvector of the smallest eigenvalue of a symmetric 3×3 matrix (Jacobi).
function smallestEigenvector(M) {
  const a = M.map((row) => [...row]);
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = cs * akp - sn * akq;
          a[k][q] = sn * akp + cs * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = cs * apk - sn * aqk;
          a[q][k] = sn * apk + cs * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = cs * vkp - sn * vkq;
          v[k][q] = sn * vkp + cs * vkq;
        }
      }
    }
  }
  let m = 0;
  for (let i = 1; i < 3; i++) if (a[i][i] < a[m][m]) m = i;
  return norm([v[0][m], v[1][m], v[2][m]]);
}

// --------------------------------------------------------------------------
// A clean line

// The cut line made smooth: its height along the neck as a function of the
// angle around it, kept to a few gentle waves (smooth 0 … 1), as a field
// f(p) = height(p) − H(angle(p)) whose zero is the smooth line. Returns
// { field, pts, tris } (pts: the smooth line, for the preview) or null.
export function smoothLine(mesh, neck, path, { smooth = 0.6 } = {}) {
  const P = mesh.positions;
  const n = neck.normal, c = neck.center, r = neck.radius;
  const [U, V] = frame(n);
  const BINS = 96;
  const sum = new Float64Array(BINS), cnt = new Float64Array(BINS);
  let spread = 0, reach = 0;
  for (const v of path) {
    const q = sub(vert(P, v), c);
    const a = Math.atan2(dot(q, V), dot(q, U));
    const b = Math.min(BINS - 1, Math.floor(((a + Math.PI) / (2 * Math.PI)) * BINS));
    sum[b] += dot(q, n);
    cnt[b]++;
    spread = Math.max(spread, Math.hypot(dot(q, U), dot(q, V)));
    reach = Math.max(reach, Math.abs(dot(q, n)));
  }
  // Heights per angle; empty bins filled from their neighbours.
  const h = new Float64Array(BINS).fill(NaN);
  for (let b = 0; b < BINS; b++) if (cnt[b]) h[b] = sum[b] / cnt[b];
  const known = [...h.keys()].filter((b) => !Number.isNaN(h[b]));
  if (known.length < 3) return null;
  for (let b = 0; b < BINS; b++) {
    if (!Number.isNaN(h[b])) continue;
    let before = known[known.length - 1] - BINS, after = known[0] + BINS;
    for (const k of known) {
      if (k < b && k > before) before = k;
      if (k > b && k < after) after = k;
    }
    const hb = h[(before + BINS) % BINS], ha = h[after % BINS];
    h[b] = hb + ((ha - hb) * (b - before)) / (after - before);
  }
  // Keep the first few waves round (fewer = smoother).
  const K = Math.max(1, Math.round(1 + (1 - smooth) * 11));
  const a0 = h.reduce((s2, x) => s2 + x, 0) / BINS;
  const coef = [];
  for (let k = 1; k <= K; k++) {
    let ca = 0, sa = 0;
    for (let b = 0; b < BINS; b++) {
      const t = -Math.PI + ((b + 0.5) * 2 * Math.PI) / BINS;
      ca += h[b] * Math.cos(k * t);
      sa += h[b] * Math.sin(k * t);
    }
    coef.push([(2 * ca) / BINS, (2 * sa) / BINS]);
  }
  const H = (t) => coef.reduce((s2, [ca, sa], i) => s2 + ca * Math.cos((i + 1) * t) + sa * Math.sin((i + 1) * t), a0);
  const field = (p) => {
    const q = sub(p, c);
    return dot(q, n) - H(Math.atan2(dot(q, V), dot(q, U)));
  };
  // Only near the neck (not other parts the field's surface would cross).
  const limit = Math.max(spread * 1.25, r * 1.5);
  const tris = trianglesNear(mesh, c, Math.hypot(limit, reach + r * 2) * 1.2).filter((t) => {
    for (let k = 0; k < 3; k++) {
      const q = sub(vert(P, mesh.indices[t * 3 + k]), c);
      if (Math.hypot(dot(q, U), dot(q, V)) > limit) return false;
    }
    return true;
  });
  // The smooth line on the surface: the field's zero, nearest the original.
  const eps = modelSize(mesh) * 1e-7;
  const target = path.map((v) => vert(P, v));
  let best = null, bestScore = Infinity;
  for (const loop of sliceField(mesh, tris, field, eps)) {
    if (!loop.closed || loop.pts.length < 6) continue;
    let score = 0;
    for (let i = 0; i < target.length; i += Math.max(1, Math.floor(target.length / 40))) score += distToPolyline(target[i], loop.pts);
    if (score < bestScore) {
      bestScore = score;
      best = loop.pts;
    }
  }
  if (!best) return null;
  return { field, pts: best, tris };
}

// Like slice() but for any field f(point): its zero inside the triangles.
function sliceField(mesh, tris, f, eps) {
  const P = mesh.positions, I = mesh.indices, nv = mesh.vertexCount;
  const val = new Map();
  const value = (v) => {
    let x = val.get(v);
    if (x === undefined) {
      x = f(vert(P, v));
      if (Math.abs(x) < eps) x = eps;
      val.set(v, x);
    }
    return x;
  };
  const at = new Map(), ends = new Map(), segs = [];
  for (const t of tris) {
    const vs = [I[t * 3], I[t * 3 + 1], I[t * 3 + 2]];
    const ds = vs.map(value);
    const keys = [];
    for (let k = 0; k < 3; k++) {
      const a = vs[k], b = vs[(k + 1) % 3], da = ds[k], db = ds[(k + 1) % 3];
      if (da > 0 === db > 0) continue;
      const key = a < b ? a * nv + b : b * nv + a;
      if (!at.has(key)) {
        const s2 = da / (da - db);
        at.set(key, [0, 1, 2].map((i) => P[a * 3 + i] + (P[b * 3 + i] - P[a * 3 + i]) * s2));
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
  for (let s2 = 0; s2 < segs.length; s2++) {
    if (used[s2]) continue;
    used[s2] = 1;
    const [first, second] = segs[s2];
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
    out.push({ pts: keys.map((k) => at.get(k)), keys, closed });
  }
  return out;
}

// Cuts the triangles along a smooth line (from smoothLine) so it becomes a
// loop of mesh edges, and returns that loop (vertex ids) for cutAlongLoop.
export function splitAlongLine(mesh, line) {
  const P = mesh.positions, I = mesh.indices, nv = mesh.vertexCount;
  const eps = modelSize(mesh) * 1e-7;
  const val = new Map();
  const value = (v) => {
    let x = val.get(v);
    if (x === undefined) {
      x = line.field(vert(P, v));
      if (Math.abs(x) < eps) x = eps;
      val.set(v, x);
    }
    return x;
  };
  const positions = Array.from(P);
  const newVert = new Map(); // edge key -> vertex id
  const edgeVert = (a, b) => {
    const key = a < b ? a * nv + b : b * nv + a;
    let id = newVert.get(key);
    if (id === undefined) {
      const da = value(a), db = value(b);
      const s2 = da / (da - db);
      id = positions.length / 3;
      for (let i = 0; i < 3; i++) positions.push(P[a * 3 + i] + (P[b * 3 + i] - P[a * 3 + i]) * s2);
      newVert.set(key, id);
    }
    return id;
  };
  const inRegion = new Uint8Array(mesh.triangleCount);
  for (const t of line.tris) inRegion[t] = 1;
  const out = [];
  const segs = []; // [p, q] new-vertex pairs: the line's edges
  for (let t = 0; t < mesh.triangleCount; t++) {
    const tv = [I[t * 3], I[t * 3 + 1], I[t * 3 + 2]];
    if (!inRegion[t]) {
      out.push(...tv);
      continue;
    }
    const pos = tv.map((v) => value(v) > 0);
    if (pos[0] === pos[1] && pos[1] === pos[2]) {
      out.push(...tv);
      continue;
    }
    // The corner alone on its side first, keeping the winding.
    const lone = pos[0] !== pos[1] && pos[0] !== pos[2] ? 0 : pos[1] !== pos[0] && pos[1] !== pos[2] ? 1 : 2;
    const a = tv[lone], b = tv[(lone + 1) % 3], c = tv[(lone + 2) % 3];
    const p = edgeVert(a, b), q = edgeVert(c, a);
    out.push(a, p, q, p, b, c, p, c, q);
    segs.push([p, q]);
  }
  mesh._set(new Float32Array(positions), new Uint32Array(out));
  // Chain the line's edges into loops; take the one nearest the preview.
  const next = new Map();
  for (const [p, q] of segs) {
    if (!next.has(p)) next.set(p, []);
    if (!next.has(q)) next.set(q, []);
    next.get(p).push(q);
    next.get(q).push(p);
  }
  const seen = new Set();
  let best = null, bestScore = Infinity;
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [start];
    seen.add(start);
    let prev = -1, cur = start, closed = false;
    for (;;) {
      const nb = (next.get(cur) || []).filter((x) => x !== prev);
      const nxt = nb.find((x) => !seen.has(x));
      if (nxt === undefined) {
        closed = nb.includes(start) && loop.length > 2;
        break;
      }
      seen.add(nxt);
      loop.push(nxt);
      prev = cur;
      cur = nxt;
    }
    if (!closed) continue;
    const pts = loop.map((v) => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]]);
    let score = 0;
    for (let i = 0; i < line.pts.length; i += Math.max(1, Math.floor(line.pts.length / 40))) score += distToPolyline(line.pts[i], pts);
    if (score < bestScore) {
      bestScore = score;
      best = loop;
    }
  }
  if (!best) throw new Error('Could not cut along the smooth line – lower “Smoothness” and try again.');
  return best;
}

// --------------------------------------------------------------------------
// The cut

// Separates the mesh along a closed loop of edges and closes both sides with
// the same (mirrored) surface. The smaller side is the one split off.
// Returns { faces: mask of the split-off side after the cut, capTriangles }.
export function cutAlongLoop(mesh, loop, neck, connector = null) {
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
      // Surface area, not triangle count: a detailed head can have more
      // triangles than a plain body.
      const a = vert(P, I[t * 3]), b = vert(P, I[t * 3 + 1]), c = vert(P, I[t * 3 + 2]);
      count += Math.hypot(...cross(sub(b, a), sub(c, a)));
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
  // Split off the smaller side (by surface area).
  const [cutSide, otherFace] = sideA.count <= sideB.count ? [sideA, faceBA] : [sideB, faceAB];
  const mask = cutSide.mask;

  // The cap: the loop triangulated in the neck plane (lifted back onto the
  // loop's own points), the same surface for both pieces. On the side that
  // keeps its vertices the cap runs against that side's edges.
  const n = neck?.normal || [0, 0, 1];
  const [U, V] = frame(n);
  const restHasAB = otherFace === faceAB; // the rest uses a0→b0, so its cap goes b0→a0
  const order = restHasAB ? [...loop].reverse() : [...loop];
  const loop3 = order.map((v) => vert(P, v));
  const loop2 = loop3.map((p) => new Vector2(dot(p, U), dot(p, V)));
  let area = 0;
  for (let i = 0; i < loop2.length; i++) {
    const p = loop2[i], q = loop2[(i + 1) % loop2.length];
    area += p.x * q.y - q.x * p.y;
  }
  // Which way the split-off piece lies, and whether the model's triangles face
  // outwards (o = 1) or inwards (o = −1, an inside-out model).
  const meanOf = (pick) => {
    const m = [0, 0, 0];
    let k = 0;
    for (let t = 0; t < mask.length; t++) {
      if (!pick(mask[t])) continue;
      for (let c = 0; c < 3; c++) for (let a = 0; a < 3; a++) m[a] += P[I[t * 3 + c] * 3 + a];
      k += 3;
    }
    return m.map((x) => x / (k || 1));
  };
  const towards = Math.sign(dot(sub(meanOf((v) => v), meanOf((v) => !v)), n)) || 1;
  const dir = n.map((x) => x * towards); // from the rest into the split-off piece
  const restCapUp = Math.sign(area) || 1; // the rest's cap faces +n (1) or −n (−1)
  const o = restCapUp === towards ? 1 : -1;

  // The connector: a pin on the rest, a hole in the split-off piece.
  const conn = planConnector(mesh, connector, { loop2, loop3, n, dir, U, V, mask });

  // Detach the smaller side (its loop vertices get copies).
  const { dup } = mesh.splitOff(mask, { close: false });
  const positions = Array.from(mesh.positions);
  const addVert = (p) => {
    positions.push(p[0], p[1], p[2]);
    return positions.length / 3 - 1;
  };
  const at = (u, v, h) => [0, 1, 2].map((k) => U[k] * u + V[k] * v + n[k] * h);
  const rest = [], piece = [];
  const tri = (list, a, b, c, want) => {
    const pa = positions.slice(a * 3, a * 3 + 3), pb = positions.slice(b * 3, b * 3 + 3), pc = positions.slice(c * 3, c * 3 + 3);
    const nr = cross(sub(pb, pa), sub(pc, pa));
    if (dot(nr, want) * o < 0) list.push(a, c, b);
    else list.push(a, b, c);
  };

  // Caps (with the pin's / hole's outline cut out when there is one).
  const capUp = n.map((x) => x * restCapUp * o); // outward normal of the rest's cap
  const capDown = capUp.map((x) => -x);
  // Seen along the axis the line usually goes round without turning back
  // (it may step straight up or down a fold): then the cap is a fan from the
  // middle, or a strip zipped to the pin's / hole's ring, in angular order –
  // always closed, whatever the steps. Otherwise: a flat triangulation,
  // checked to cover every edge.
  const mid = conn.ok ? conn.c2 : poleOf(loop2);
  const angles = loop2.map((p) => Math.atan2(p.y - mid[1], p.x - mid[0]));
  const dirSign = Math.sign(area) || 1;
  const unwrapped = [0];
  let monotone = true;
  for (let i = 1; i <= angles.length; i++) {
    let d = angles[i % angles.length] - angles[i - 1];
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    if (d * dirSign < -1e-9) monotone = false;
    unwrapped.push(unwrapped[i - 1] + d * dirSign);
  }
  if (Math.abs(unwrapped[angles.length] - 2 * Math.PI) > 1e-3) monotone = false;
  // Emit a triangle wound like the loop (or mirrored for the other piece).
  const put = (list, mirrored, a, b, c) => (mirrored ? list.push(a, c, b) : list.push(a, b, c));
  const cap = (list, ids, hole, mirrored, want) => {
    if (monotone) {
      if (!hole) {
        const centre = addVert(at(mid[0], mid[1], loop3.reduce((s, p) => s + dot(p, n), 0) / loop3.length));
        for (let i = 0; i < ids.length; i++) put(list, mirrored, centre, ids[i], ids[(i + 1) % ids.length]);
        return;
      }
      // The ring in the loop's direction, starting where the loop starts.
      const rel = (u, v) => {
        let a = (Math.atan2(v - mid[1], u - mid[0]) - angles[0]) * dirSign;
        a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        return a;
      };
      let inner = hole.map(([u, v], k) => ({ id: hole.ids[k], a: rel(u, v) }));
      if (dirSign < 0) inner.reverse();
      const start = inner.reduce((best, x, k) => (x.a < inner[best].a ? k : best), 0);
      inner = [...inner.slice(start), ...inner.slice(0, start)];
      const n1 = ids.length, m1 = inner.length;
      let i = 0, j = 0;
      while (i < n1 || j < m1) {
        const nextOuter = unwrapped[i + 1];
        const nextInner = j + 1 < m1 ? inner[j + 1].a : 2 * Math.PI + inner[0].a;
        const o0 = ids[i % n1], o1 = ids[(i + 1) % n1], i0 = inner[j % m1].id, i1 = inner[(j + 1) % m1].id;
        if (j >= m1 || (i < n1 && nextOuter <= nextInner)) {
          put(list, mirrored, o0, o1, i0);
          i++;
        } else {
          put(list, mirrored, i1, i0, o0);
          j++;
        }
      }
      return;
    }
    const holes = hole ? [hole.map(([u, v]) => new Vector2(u, v))] : [];
    const all = [...ids, ...(hole ? hole.ids : [])];
    const faces = ShapeUtils.triangulateShape(loop2.map((p) => p.clone()), holes);
    const expected = ids.length + (hole ? hole.length + 2 : 0) - 2;
    if (faces.length !== expected) throw new Error('Could not close the cut along this line – try other settings (less “Follow creases”) or paint the line.');
    for (const [a, b, c] of faces) tri(list, all[a], all[b], all[c], want);
  };
  const ring = (outline, h) => {
    const ids = outline.map(([u, v]) => addVert(at(u, v, h)));
    return Object.assign(outline.map((x) => x), { ids });
  };
  let pinBase = null, holeTop = null;
  if (conn.ok) {
    pinBase = ring(conn.outline(conn.half), conn.h0);
    holeTop = ring(conn.outline(conn.half + conn.gap), conn.h0);
  }
  // The loop's own winding (order) is the rest's; the piece's cap is mirrored.
  const windsUp = restCapUp > 0 === dirSign > 0;
  cap(rest, order, pinBase, !windsUp, capUp);
  cap(piece, order.map((v) => dup[v]), holeTop, windsUp, capDown);

  if (conn.ok) {
    const { h0, len, depth } = conn;
    const sideOf = (outline, k) => {
      const [u1, v1] = outline[k], [u2, v2] = outline[(k + 1) % outline.length];
      return at((u1 + u2) / 2 - conn.c2[0], (v1 + v2) / 2 - conn.c2[1], 0);
    };
    // Pin: tapered walls, flat tip.
    const tip = ring(conn.outline(conn.half * (1 - conn.taper)), h0 + towards * len);
    const tipCentre = addVert(at(conn.c2[0], conn.c2[1], h0 + towards * len));
    for (let k = 0; k < pinBase.length; k++) {
      const k1 = (k + 1) % pinBase.length, out = sideOf(pinBase, k);
      tri(rest, pinBase.ids[k], pinBase.ids[k1], tip.ids[k1], out);
      tri(rest, pinBase.ids[k], tip.ids[k1], tip.ids[k], out);
      tri(rest, tip.ids[k], tip.ids[k1], tipCentre, dir);
    }
    // Hole: straight walls, flat bottom.
    const bottom = ring(conn.outline(conn.half + conn.gap), h0 + towards * depth);
    const bottomCentre = addVert(at(conn.c2[0], conn.c2[1], h0 + towards * depth));
    const back = dir.map((x) => -x);
    for (let k = 0; k < holeTop.length; k++) {
      const k1 = (k + 1) % holeTop.length, inward = sideOf(holeTop, k).map((x) => -x);
      tri(piece, holeTop.ids[k], holeTop.ids[k1], bottom.ids[k1], inward);
      tri(piece, holeTop.ids[k], bottom.ids[k1], bottom.ids[k], inward);
      tri(piece, bottom.ids[k], bottom.ids[k1], bottomCentre, back);
    }
  }

  const before = mesh.triangleCount;
  const indices = new Uint32Array(mesh.indices.length + rest.length + piece.length);
  indices.set(mesh.indices);
  indices.set(rest, mesh.indices.length);
  indices.set(piece, mesh.indices.length + rest.length);
  mesh._set(new Float32Array(positions), indices);
  // Faces of the split-off piece: its old faces keep their numbers, and the
  // last added triangles are its cap and hole.
  const faces = new Uint8Array(mesh.triangleCount);
  faces.set(mask);
  for (let t = before + rest.length / 3; t < mesh.triangleCount; t++) faces[t] = 1;
  return { faces, connector: conn.ok ? conn.summary : null, note: conn.note || '' };
}

// The point inside a polygon ([Vector2]) farthest from its edges (roughly).
function poleOf(pts2) {
  const pts = pts2.map((p) => [p.x, p.y]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  let best = null, bestD = -1;
  for (let i = 0; i <= 30; i++) {
    for (let j = 0; j <= 30; j++) {
      const q = [Math.min(...xs) + ((Math.max(...xs) - Math.min(...xs)) * i) / 30, Math.min(...ys) + ((Math.max(...ys) - Math.min(...ys)) * j) / 30];
      let inside = false;
      for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
        const [xi, yi] = pts[a], [xj, yj] = pts[b];
        if (yi > q[1] !== yj > q[1] && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (!inside) continue;
      let d = Infinity;
      for (let a = 0; a < pts.length; a++) {
        const [ax, ay] = pts[a], [bx, by] = pts[(a + 1) % pts.length];
        const dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((q[0] - ax) * dx + (q[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
        d = Math.min(d, Math.hypot(ax + t * dx - q[0], ay + t * dy - q[1]));
      }
      if (d > bestD) {
        bestD = d;
        best = q;
      }
    }
  }
  return best || [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}

// Plans the pin for a neck cut: where (the middle of the cut), how big (fits
// in the cut with a wall around the hole), how long (the hole must not break
// through the split-off piece). Options: { shape: 'round' | 'square' | 'none',
// size, length (0 = automatic), tolerance (mm, hole wider than the pin),
// taper (% narrower at the tip) }.
function planConnector(mesh, opts, { loop2, loop3, n, dir, U, V, mask }) {
  const shape = opts?.shape || 'none';
  if (shape === 'none') return { ok: false };
  const gap = Math.max(0, opts.tolerance ?? 0.2) / 2;
  const taper = Math.max(0, Math.min(30, opts.taper ?? 1)) / 100;
  const pts = loop2.map((p) => [p.x, p.y]);
  const edges = pts.map((p, i) => [p, pts[(i + 1) % pts.length]]);
  const distEdges = (q) => {
    let best = Infinity;
    for (const [[ax, ay], [bx, by]] of edges) {
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((q[0] - ax) * dx + (q[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(ax + t * dx - q[0], ay + t * dy - q[1]));
    }
    return best;
  };
  const inside = ([x, y]) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  // The middle: the point inside the cut farthest from its edge.
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  let c2 = null, rho = 0;
  for (let i = 0; i <= 30; i++) {
    for (let j = 0; j <= 30; j++) {
      const q = [Math.min(...xs) + ((Math.max(...xs) - Math.min(...xs)) * i) / 30, Math.min(...ys) + ((Math.max(...ys) - Math.min(...ys)) * j) / 30];
      if (!inside(q)) continue;
      const d = distEdges(q);
      if (d > rho) {
        rho = d;
        c2 = q;
      }
    }
  }
  if (!c2) return { ok: false, note: 'No room for a pin in this cut – glue only.' };
  const half = opts.size > 0 ? opts.size / 2 : Math.max(0.75, Math.round(rho * 0.35 * 4) / 4);
  const wall = Math.max(0.8, half * 0.3);
  // A square's corner reaches √2 × half from the middle.
  const reachOut = (shape === 'square' ? Math.SQRT2 : 1) * (half + gap);
  if (reachOut + wall > rho) return { ok: false, note: `A ${shape} pin of ${(2 * half).toFixed(1)} mm doesn't fit this cut (${(2 * rho).toFixed(1)} mm across) – use a smaller size.` };
  // The cut's height there: the loop's average along the axis.
  const h0 = loop3.reduce((s, p) => s + dot(p, n), 0) / loop3.length;
  const centre = [0, 1, 2].map((k) => U[k] * c2[0] + V[k] * c2[1] + n[k] * h0);
  // How deep the split-off piece is behind the cut there.
  const depthBehind = rayDepth(mesh, mask, centre, dir);
  const clearance = 0.3;
  let len = opts.length > 0 ? opts.length : half * 3;
  len = Math.min(len, depthBehind - wall - clearance);
  if (!(len >= half)) return { ok: false, note: 'The piece is too thin behind the cut for a pin – glue only.' };
  const outline = (h) =>
    shape === 'square'
      ? [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([a, b]) => [c2[0] + a * h, c2[1] + b * h])
      : Array.from({ length: 32 }, (_, k) => [c2[0] + h * Math.cos((2 * Math.PI * k) / 32), c2[1] + h * Math.sin((2 * Math.PI * k) / 32)]);
  return {
    ok: true,
    c2,
    h0,
    half,
    gap,
    taper,
    len,
    depth: len + clearance,
    outline,
    summary: { shape, size: 2 * half, length: len, holeSize: 2 * (half + gap), holeDepth: len + clearance, taper: taper * 100 },
  };
}

// Distance from `from` along `dir` to the far side of the masked triangles.
function rayDepth(mesh, mask, from, dir) {
  const P = mesh.positions, I = mesh.indices;
  let best = Infinity;
  for (let t = 0; t < mask.length; t++) {
    if (!mask[t]) continue;
    const a = vert(P, I[t * 3]), b = vert(P, I[t * 3 + 1]), c = vert(P, I[t * 3 + 2]);
    const e1 = sub(b, a), e2 = sub(c, a);
    const h = cross(dir, e2);
    const det = dot(e1, h);
    if (Math.abs(det) < 1e-12) continue;
    const s = sub(from, a);
    const u = dot(s, h) / det;
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1);
    const v = dot(dir, q) / det;
    if (v < 0 || u + v > 1) continue;
    const dist = dot(e2, q) / det;
    if (dist > 1e-6 && dist < best) best = dist;
  }
  return best;
}
