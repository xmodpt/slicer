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

// Finer pieces for the AI to sort into printable parts (head, hair, arm,
// shoe, table…): the crease objects above, with big smooth regions divided
// further into patches of roughly equal size whose borders prefer creases.
// Same result shape as segmentObjects.
export function segmentForKit(mesh, { target = 80, concaveAngle = 14 } = {}) {
  const base = segmentObjects(mesh, { concaveAngle, minAreaFraction: 0.5 / target });
  const T = mesh.triangleCount;
  const p = mesh.positions, ind = mesh.indices;
  const normals = mesh.faceNormals();
  const centre = new Float64Array(T * 3);
  const area = new Float64Array(T);
  let total = 0;
  for (let t = 0; t < T; t++) {
    const a = ind[t * 3] * 3, b = ind[t * 3 + 1] * 3, c = ind[t * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) centre[t * 3 + k] = (p[a + k] + p[b + k] + p[c + k]) / 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    area[t] = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    total += area[t];
  }
  // Distance across an edge between two triangles: their centres' distance,
  // longer across a fold, so patch borders settle in creases.
  const cost = (t, o) => {
    const d = Math.hypot(centre[t * 3] - centre[o * 3], centre[t * 3 + 1] - centre[o * 3 + 1], centre[t * 3 + 2] - centre[o * 3 + 2]);
    const dot = normals[t * 3] * normals[o * 3] + normals[t * 3 + 1] * normals[o * 3 + 1] + normals[t * 3 + 2] * normals[o * 3 + 2];
    return d * (1 + 6 * (1 - Math.max(-1, Math.min(1, dot))));
  };
  const label = new Int32Array(T).fill(-1);
  const dist = new Float64Array(T), owner = new Int32Array(T), inObj = new Uint8Array(T);
  let next = 0;
  const patchArea = total / target;
  for (const obj of base.objects) {
    const faces = base.facesOf(obj.id);
    const k = Math.max(1, Math.round((obj.share * total) / patchArea));
    if (k === 1) {
      for (const t of faces) label[t] = next;
      next++;
      continue;
    }
    // Farthest-point seeds: each new seed only claims the triangles closer to
    // it than to the earlier ones (Dijkstra from the new seed).
    for (const t of faces) {
      dist[t] = Infinity;
      inObj[t] = 1;
    }
    const claim = (seed, id) => {
      dist[seed] = 0;
      owner[seed] = id;
      const H = [[0, seed]];
      const push = (x) => {
        H.push(x);
        let i = H.length - 1;
        while (i > 0) {
          const j = (i - 1) >> 1;
          if (H[j][0] <= x[0]) break;
          H[i] = H[j];
          i = j;
        }
        H[i] = x;
      };
      const pop = () => {
        const top = H[0], last = H.pop();
        if (H.length) {
          let i = 0;
          for (;;) {
            let c = 2 * i + 1;
            if (c >= H.length) break;
            if (c + 1 < H.length && H[c + 1][0] < H[c][0]) c++;
            if (H[c][0] >= last[0]) break;
            H[i] = H[c];
            i = c;
          }
          H[i] = last;
        }
        return top;
      };
      while (H.length) {
        const [d, t] = pop();
        if (d > dist[t]) continue;
        mesh.forEachEdgeNeighbour(t, (o) => {
          if (!inObj[o]) return;
          const nd = d + cost(t, o);
          if (nd < dist[o]) {
            dist[o] = nd;
            owner[o] = id;
            push([nd, o]);
          }
        });
      }
    };
    claim(faces[0], 0);
    let seeds = 1;
    while (seeds < k) {
      let far = -1, best = 0;
      for (const t of faces) {
        if (dist[t] !== Infinity && dist[t] > best) {
          best = dist[t];
          far = t;
        }
      }
      if (far < 0) break;
      claim(far, seeds++);
    }
    for (const t of faces) inObj[t] = 0;
    for (const t of faces) label[t] = next + (dist[t] === Infinity ? 0 : owner[t]);
    next += seeds;
  }
  // Pack into the segmentObjects shape, biggest first.
  const sums = Array.from({ length: next }, () => ({ triangles: 0, area: 0 }));
  for (let t = 0; t < T; t++) {
    sums[label[t]].triangles++;
    sums[label[t]].area += area[t];
  }
  const order = sums.map((s, i) => i).filter((i) => sums[i].triangles).sort((a, b) => sums[b].area - sums[a].area);
  const newId = new Int32Array(next).fill(-1);
  order.forEach((old, i) => (newId[old] = i));
  const objectOf = new Int32Array(T);
  for (let t = 0; t < T; t++) objectOf[t] = newId[label[t]];
  const faceOffsets = new Uint32Array(order.length + 1);
  for (let t = 0; t < T; t++) faceOffsets[objectOf[t] + 1]++;
  for (let i = 0; i < order.length; i++) faceOffsets[i + 1] += faceOffsets[i];
  const fill = faceOffsets.slice(0, order.length);
  const facesArr = new Uint32Array(T);
  for (let t = 0; t < T; t++) facesArr[fill[objectOf[t]]++] = t;
  return {
    objectOf,
    objects: order.map((old, i) => ({ id: i, triangles: sums[old].triangles, area: sums[old].area, share: total ? sums[old].area / total : 0 })),
    facesOf: (id) => facesArr.subarray(faceOffsets[id], faceOffsets[id + 1]),
  };
}

// Tidies per-triangle part labels before the parts are separated, so every
// border is a clean line: lone triangles take their neighbours' part, and
// where a corner touches the same part twice (a pinch – the cut outline would
// pass the corner twice), all triangles around it go to the part most of them
// have. Changes `labels` in place; returns how many changed.
export function cleanLabels(mesh, labels, { passes = 12 } = {}) {
  const T = mesh.triangleCount, ind = mesh.indices;
  const { offsets, faces } = mesh.vertexFaces();
  let changed = 0;
  for (let pass = 0; pass < passes; pass++) {
    let n = 0;
    // 1. Lone triangles.
    for (let t = 0; t < T; t++) {
      const count = new Map();
      mesh.forEachEdgeNeighbour(t, (o) => count.set(labels[o], (count.get(labels[o]) || 0) + 1));
      let best = labels[t], bestN = count.get(labels[t]) || 0;
      for (const [l, c] of count) if (c > bestN) (best = l), (bestN = c);
      if (best !== labels[t] && bestN >= 2) {
        labels[t] = best;
        n++;
      }
    }
    // 2. Pinched corners.
    for (let v = 0; v < mesh.vertexCount; v++) {
      const fan = faces.subarray(offsets[v], offsets[v + 1]);
      if (fan.length < 2) continue;
      const first = labels[fan[0]];
      let mixed = false;
      for (const t of fan) if (labels[t] !== first) mixed = true;
      if (!mixed) continue;
      // Pieces of each label around the corner (faces sharing an edge at v).
      const parent = fan.map((_, i) => i);
      const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      const others = (t) => {
        const a = ind[t * 3], b = ind[t * 3 + 1], c = ind[t * 3 + 2];
        return [a, b, c].filter((x) => x !== v);
      };
      for (let i = 0; i < fan.length; i++) {
        for (let j = i + 1; j < fan.length; j++) {
          if (labels[fan[i]] !== labels[fan[j]]) continue;
          const oi = others(fan[i]), oj = others(fan[j]);
          if (oi.some((x) => oj.includes(x))) parent[find(i)] = find(j);
        }
      }
      const pieces = new Map();
      for (let i = 0; i < fan.length; i++) {
        const l = labels[fan[i]];
        if (!pieces.has(l)) pieces.set(l, new Set());
        pieces.get(l).add(find(i));
      }
      if ([...pieces.values()].every((s) => s.size === 1)) continue;
      const count = new Map();
      for (const t of fan) count.set(labels[t], (count.get(labels[t]) || 0) + 1);
      const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
      for (const t of fan) {
        if (labels[t] !== best) {
          labels[t] = best;
          n++;
        }
      }
    }
    changed += n;
    if (!n) break;
  }
  return changed;
}
