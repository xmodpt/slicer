// Splits a mesh into "objects" – e.g. the candles standing on a cake – even
// when everything is fused into one connected surface.
//
// Where two shapes join, the surface folds inwards (a concave crease, like the
// ring where a candle meets the cake top). Convex edges (a candle's top rim,
// the edge of the cake) stay inside one object. So: grow regions across every
// edge that is not a sharp concave crease, then fold tiny fragments into the
// neighbour they share the longest border with.

export function segmentObjects(mesh, { concaveAngle = 20, minAreaFraction = 0.002 } = {}) {
  const T = mesh.triangleCount;
  const p = mesh.positions;
  const ind = mesh.indices;
  const normals = mesh.faceNormals();
  const { offsets, edgeHalfEdges, edgeCount } = mesh.topology();
  const cosLimit = Math.cos((concaveAngle * Math.PI) / 180);

  const area = new Float64Array(T);
  let totalArea = 0;
  for (let t = 0; t < T; t++) {
    const a = ind[t * 3] * 3, b = ind[t * 3 + 1] * 3, c = ind[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    area[t] = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    totalArea += area[t];
  }

  const parent = new Int32Array(T);
  for (let t = 0; t < T; t++) parent[t] = t;
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  };

  // Manifold edges between two triangles, with their length, for the merge step.
  const pairs = [];
  for (let e = 0; e < edgeCount; e++) {
    if (offsets[e + 1] - offsets[e] !== 2) continue; // open or non-manifold edges split objects
    const h1 = edgeHalfEdges[offsets[e]], h2 = edgeHalfEdges[offsets[e] + 1];
    const t1 = (h1 / 3) | 0, t2 = (h2 / 3) | 0;
    const v0 = ind[h1], v1 = ind[h1 % 3 === 2 ? h1 - 2 : h1 + 1];
    const len = Math.hypot(p[v1 * 3] - p[v0 * 3], p[v1 * 3 + 1] - p[v0 * 3 + 1], p[v1 * 3 + 2] - p[v0 * 3 + 2]);
    pairs.push(t1, t2, len);
    if (!isConcaveCrease(t1, t2, h2, len)) union(t1, t2);
  }

  function isConcaveCrease(t1, t2, h2, len) {
    const dot = normals[t1 * 3] * normals[t2 * 3] + normals[t1 * 3 + 1] * normals[t2 * 3 + 1] + normals[t1 * 3 + 2] * normals[t2 * 3 + 2];
    if (dot >= cosLimit) return false; // too flat to be a crease
    // Concave when t2's far corner lies on the front side of t1.
    const opp = ind[t2 * 3 + ((h2 % 3) + 2) % 3] * 3;
    const a = ind[t1 * 3] * 3;
    const d = (p[opp] - p[a]) * normals[t1 * 3] + (p[opp + 1] - p[a + 1]) * normals[t1 * 3 + 1] + (p[opp + 2] - p[a + 2]) * normals[t1 * 3 + 2];
    return d > len * 1e-4;
  }

  // Merge fragments below the size limit into their best neighbour.
  const minArea = totalArea * minAreaFraction;
  for (let pass = 0; pass < 30; pass++) {
    const segArea = new Map();
    for (let t = 0; t < T; t++) {
      const r = find(t);
      segArea.set(r, (segArea.get(r) || 0) + area[t]);
    }
    const border = new Map(); // small segment -> Map(neighbour -> shared length)
    for (let i = 0; i < pairs.length; i += 3) {
      const a = find(pairs[i]), b = find(pairs[i + 1]);
      if (a === b) continue;
      for (const [s, n] of [[a, b], [b, a]]) {
        if (segArea.get(s) >= minArea) continue;
        let m = border.get(s);
        if (!m) border.set(s, (m = new Map()));
        m.set(n, (m.get(n) || 0) + pairs[i + 2]);
      }
    }
    if (!border.size) break;
    const order = [...border.keys()].sort((x, y) => segArea.get(x) - segArea.get(y));
    let merged = 0;
    for (const s of order) {
      let best = -1, bestLen = -1;
      for (const [n, len] of border.get(s)) if (len > bestLen) { bestLen = len; best = n; }
      if (find(s) !== find(best)) {
        union(best, s);
        merged++;
      }
    }
    if (!merged) break;
  }

  // Number the objects, largest first.
  const info = new Map();
  for (let t = 0; t < T; t++) {
    const r = find(t);
    let s = info.get(r);
    if (!s) info.set(r, (s = { root: r, triangles: 0, area: 0 }));
    s.triangles++;
    s.area += area[t];
  }
  const objects = [...info.values()].sort((a, b) => b.area - a.area);
  const idOfRoot = new Map(objects.map((o, i) => [o.root, i]));
  const objectOf = new Int32Array(T);
  for (let t = 0; t < T; t++) objectOf[t] = idOfRoot.get(find(t));

  // Face lists per object (CSR), for fast highlighting/selecting.
  const faceOffsets = new Uint32Array(objects.length + 1);
  for (let t = 0; t < T; t++) faceOffsets[objectOf[t] + 1]++;
  for (let i = 0; i < objects.length; i++) faceOffsets[i + 1] += faceOffsets[i];
  const fill = faceOffsets.slice(0, objects.length);
  const faces = new Uint32Array(T);
  for (let t = 0; t < T; t++) faces[fill[objectOf[t]]++] = t;

  return {
    objectOf,
    objects: objects.map((o, i) => ({
      id: i,
      triangles: o.triangles,
      area: o.area,
      share: totalArea ? o.area / totalArea : 0,
    })),
    facesOf: (id) => faces.subarray(faceOffsets[id], faceOffsets[id + 1]),
  };
}
