// Floating parts: pieces that neither rest on the plate (the lowest point of
// the model) nor touch – directly or through other pieces – one that does.
// They would print in mid-air.
//
// Touching is judged on the surfaces themselves: every part's surface is
// sampled into a grid of small cells, and two parts touch when they share a
// cell. (Bounding boxes are not enough – a small piece floating next to a
// tilted wall sits inside the wall's box.) A piece enclosed by another part
// is inside the solid, not floating.

export function findFloatingParts(mesh, parts, { cells = 400 } = {}) {
  if (parts.length < 2) return [];
  const P = mesh.positions, I = mesh.indices;
  const { min, max } = mesh.bounds();
  const size = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const c = size / cells; // cell size: also the "touching" distance
  const floor = min[2] + Math.max(c, size * 1e-3);
  const K = Math.ceil(size / c) + 3;
  const cellOf = (x, y, z) => {
    const ix = Math.floor((x - min[0]) / c) + 1, iy = Math.floor((y - min[1]) / c) + 1, iz = Math.floor((z - min[2]) / c) + 1;
    return ix + K * (iy + K * iz);
  };

  // Union-find over parts.
  const parent = new Int32Array(parts.length).map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };

  const owner = new Map(); // cell -> part
  const mark = (x, y, z, p) => {
    const key = cellOf(x, y, z);
    const o = owner.get(key);
    if (o === undefined) owner.set(key, p);
    else if (o !== p) union(o, p);
  };
  const supported = new Uint8Array(parts.length);
  const half = c / 2;
  parts.forEach((part, p) => {
    for (const t of part.faces) {
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, d = I[t * 3 + 2] * 3;
      const ax = P[a], ay = P[a + 1], az = P[a + 2];
      const ux = P[b] - ax, uy = P[b + 1] - ay, uz = P[b + 2] - az;
      const vx = P[d] - ax, vy = P[d + 1] - ay, vz = P[d + 2] - az;
      if (az <= floor || P[b + 2] <= floor || P[d + 2] <= floor) supported[p] = 1;
      // Sample the triangle about every half cell.
      const n = Math.min(200, Math.ceil(Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(ux - vx, uy - vy, uz - vz)) / half));
      for (let i = 0; i <= n; i++) {
        for (let j = 0; i + j <= n; j++) {
          const s = n ? i / n : 0, r = n ? j / n : 0;
          mark(ax + s * ux + r * vx, ay + s * uy + r * vy, az + s * uz + r * vz, p);
        }
      }
    }
  });

  const groundRoots = new Set();
  parts.forEach((_, p) => supported[p] && groundRoots.add(find(p)));
  const candidates = parts.map((_, p) => p).filter((p) => !groundRoots.has(find(p)));
  if (!candidates.length) return [];

  // Pieces enclosed by another part are inside the solid – not floating.
  const boxes = parts.map((part) => mesh.boundsOfFaces(part.faces));
  return candidates
    .filter((p) => {
      const v = I[parts[p].faces[0] * 3] * 3;
      const q = [P[v], P[v + 1], P[v + 2]];
      return !parts.some((other, o) => o !== p && !candidates.includes(o) && inBox(q, boxes[o]) && insidePart(mesh, other, q));
    })
    .map((p) => parts[p]);
}

const inBox = (q, b) => q.every((x, k) => x >= b.min[k] && x <= b.max[k]);

// Ray parity along +X (slightly skewed to avoid hitting edges exactly).
function insidePart(mesh, part, q) {
  const P = mesh.positions, I = mesh.indices;
  const d = [1, 1e-4, 2e-4];
  let hits = 0;
  for (const t of part.faces) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
    if (Math.abs(det) < 1e-12) continue;
    const s = [q[0] - P[a], q[1] - P[a + 1], q[2] - P[a + 2]];
    const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
    if (u < 0 || u > 1) continue;
    const w = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (d[0] * w[0] + d[1] * w[1] + d[2] * w[2]) / det;
    if (v < 0 || u + v > 1) continue;
    if ((e2[0] * w[0] + e2[1] * w[1] + e2[2] * w[2]) / det > 0) hits++;
  }
  return hits % 2 === 1;
}
