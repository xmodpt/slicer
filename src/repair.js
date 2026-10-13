// Mesh repair: faces turned the wrong way, duplicate and zero-size
// triangles, and spots where the surface passes through itself. Also the
// small edits Mirror and Smooth.

import * as THREE from 'three';
import { MeshBVH, ExtendedTriangle } from 'three-mesh-bvh';

const key3 = (a, b, c) => {
  const s = [a, b, c].sort((x, y) => x - y);
  return s[0] + ',' + s[1] + ',' + s[2];
};

// What's wrong (doesn't change the mesh).
export function diagnose(mesh, { intersections = true } = {}) {
  const { degenerate, duplicate, sheet } = badFaces(mesh);
  const flipped = orientationFixes(mesh).count;
  const crossing = intersections ? selfIntersections(mesh) : null;
  return { degenerate: degenerate.length, duplicate: duplicate.length, sheet: sheet.length, flipped, crossing };
}

// Zero-area triangles, exact duplicates (same corners, same way round – one
// is kept) and back-to-back pairs (same corners, opposite ways: a sheet of
// no thickness – both go).
function badFaces(mesh) {
  const P = mesh.positions, I = mesh.indices, T = mesh.triangleCount;
  const degenerate = [], duplicate = [], sheet = [];
  const seen = new Map();
  for (let t = 0; t < T; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const scale = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz)) ** 2;
    if (a === b || b === c || a === c || !(area2 > scale * 1e-10)) {
      degenerate.push(t);
      continue;
    }
    const k = key3(a, b, c);
    const prev = seen.get(k);
    if (prev === undefined) {
      seen.set(k, t);
      continue;
    }
    // Same way round when the cyclic order matches.
    const pa = I[prev * 3], pb = I[prev * 3 + 1], pc = I[prev * 3 + 2];
    const same = (a === pa && b === pb) || (a === pb && b === pc) || (a === pc && b === pa);
    if (same) duplicate.push(t);
    else {
      sheet.push(t, prev);
      seen.delete(k);
    }
  }
  return { degenerate, duplicate, sheet };
}

// Faces whose winding disagrees with their neighbours: walks each connected
// piece across manifold edges (a neighbour must run along the shared edge the
// other way), then turns the whole piece outward if its volume is negative.
// Returns { flip: Uint8Array, count }.
function orientationFixes(mesh) {
  const I = mesh.indices, T = mesh.triangleCount, P = mesh.positions;
  const edgeFaces = new Map();
  const ek = (a, b) => (a < b ? a + '_' + b : b + '_' + a);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const a = I[t * 3 + k], b = I[t * 3 + ((k + 1) % 3)];
      const key = ek(a, b);
      const list = edgeFaces.get(key);
      if (list) list.push(t);
      else edgeFaces.set(key, [t]);
    }
  }
  const flip = new Uint8Array(T);
  const seen = new Uint8Array(T);
  // Does face t (with its current flip) run a→b?
  const runs = (t, a, b) => {
    for (let k = 0; k < 3; k++) {
      const x = I[t * 3 + k], y = I[t * 3 + ((k + 1) % 3)];
      if (x === a && y === b) return !flip[t];
      if (x === b && y === a) return !!flip[t];
    }
    return false;
  };
  let count = 0;
  for (let s = 0; s < T; s++) {
    if (seen[s]) continue;
    const comp = [s];
    seen[s] = 1;
    for (let q = 0; q < comp.length; q++) {
      const t = comp[q];
      for (let k = 0; k < 3; k++) {
        const a = I[t * 3 + k], b = I[t * 3 + ((k + 1) % 3)];
        const list = edgeFaces.get(ek(a, b));
        if (!list || list.length !== 2) continue; // open or non-manifold edge
        const o = list[0] === t ? list[1] : list[0];
        if (seen[o]) continue;
        seen[o] = 1;
        // t runs a→b (taking its flip into account); o must run b→a.
        const tRuns = runs(t, a, b);
        const oRuns = runs(o, a, b);
        if (tRuns === oRuns) flip[o] = 1;
        comp.push(o);
      }
    }
    // Outward: a closed piece should have a positive volume.
    let vol = 0;
    for (const t of comp) {
      let a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
      if (flip[t]) [b, c] = [c, b];
      vol += P[a * 3] * (P[b * 3 + 1] * P[c * 3 + 2] - P[b * 3 + 2] * P[c * 3 + 1]) - P[a * 3 + 1] * (P[b * 3] * P[c * 3 + 2] - P[b * 3 + 2] * P[c * 3]) + P[a * 3 + 2] * (P[b * 3] * P[c * 3 + 1] - P[b * 3 + 1] * P[c * 3]);
    }
    if (vol < 0) for (const t of comp) flip[t] ^= 1;
    for (const t of comp) count += flip[t];
  }
  return { flip, count };
}

// Faces that cross another face (not counting faces that share a corner).
// Returns the list of such faces (sorted).
export function selfIntersections(mesh, { limit = 200000 } = {}) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geo.setIndex(new THREE.BufferAttribute(mesh.indices.slice(), 1)); // the BVH reorders its copy
  const bvh = new MeshBVH(geo, { indirect: true });
  const P = mesh.positions, I = mesh.indices, T = mesh.triangleCount;
  const tri = new ExtendedTriangle(), other = new ExtendedTriangle();
  const box = new THREE.Box3();
  const v = (i) => new THREE.Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
  const hit = new Uint8Array(T);
  let found = 0;
  for (let t = 0; t < T && found < limit; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    tri.set(v(a), v(b), v(c));
    tri.needsUpdate = true;
    box.setFromPoints([tri.a, tri.b, tri.c]);
    bvh.shapecast({
      intersectsBounds: (bounds) => bounds.intersectsBox(box),
      intersectsTriangle: (o, i) => {
        // `i` indexes the BVH's own (reordered) copy; read the corners from it.
        const ia = geo.index.array;
        const oa = ia[i * 3], ob = ia[i * 3 + 1], oc = ia[i * 3 + 2];
        if (oa === a || oa === b || oa === c || ob === a || ob === b || ob === c || oc === a || oc === b || oc === c) return false;
        other.copy(o);
        other.needsUpdate = true;
        if (tri.intersectsTriangle(other)) {
          if (!hit[t]) (hit[t] = 1), found++;
          return true; // one is enough for this face
        }
        return false;
      },
    });
  }
  geo.dispose();
  const out = [];
  hit.forEach((h, t) => h && out.push(t));
  return out;
}

// Removes zero-size, duplicate and back-to-back triangles and turns faces
// the right way. Returns what it did.
export function repair(mesh) {
  const { degenerate, duplicate, sheet } = badFaces(mesh);
  const drop = new Uint8Array(mesh.triangleCount);
  for (const t of [...degenerate, ...duplicate, ...sheet]) drop[t] = 1;
  if (degenerate.length || duplicate.length || sheet.length) mesh.deleteFaces(drop);
  const { flip, count } = orientationFixes(mesh);
  if (count) {
    const I = mesh.indices.slice();
    for (let t = 0; t < mesh.triangleCount; t++) if (flip[t]) [I[t * 3 + 1], I[t * 3 + 2]] = [I[t * 3 + 2], I[t * 3 + 1]];
    mesh._set(mesh.positions, I);
  }
  return { degenerate: degenerate.length, duplicate: duplicate.length, sheet: sheet.length, flipped: count };
}

// Mirror the vertices of `vertexMask` (or all) across the plane through
// `pivot` with normal along `axis` (0 x, 1 y, 2 z); the faces using them are
// turned round so they still face outward.
export function mirror(mesh, axis, pivot, vertexMask = null, faceMask = null) {
  const P = mesh.positions.slice();
  for (let v = 0; v < P.length / 3; v++) if (!vertexMask || vertexMask[v]) P[v * 3 + axis] = 2 * pivot[axis] - P[v * 3 + axis];
  const I = mesh.indices.slice();
  for (let t = 0; t < I.length / 3; t++) if (!faceMask || faceMask[t]) [I[t * 3 + 1], I[t * 3 + 2]] = [I[t * 3 + 2], I[t * 3 + 1]];
  mesh._set(P, I);
}

// Taubin smoothing (no shrinking): the vertices of the faces in `faceMask`
// (or all) move towards their neighbours' average and back a little, `passes`
// times. Vertices on the edge of the area (shared with faces outside it) and
// on open edges stay put, so the smoothed part joins the rest.
export function smooth(mesh, { passes = 5, strength = 0.5, faceMask = null } = {}) {
  const P = mesh.positions, I = mesh.indices, T = mesh.triangleCount, V = P.length / 3;
  const inside = new Uint8Array(V), fixed = new Uint8Array(V);
  for (let t = 0; t < T; t++) {
    const on = !faceMask || faceMask[t];
    for (let k = 0; k < 3; k++) {
      const v = I[t * 3 + k];
      if (on) inside[v] = 1;
      else fixed[v] = 1;
    }
  }
  for (const [a, b] of mesh.boundaryEdges()) fixed[a] = fixed[b] = 1;
  // Neighbours (CSR).
  const deg = new Uint32Array(V + 1);
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) deg[I[t * 3 + k] + 1] += 2;
  for (let v = 0; v < V; v++) deg[v + 1] += deg[v];
  const nb = new Uint32Array(deg[V]);
  const fill = deg.slice(0, V);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const v = I[t * 3 + k];
      nb[fill[v]++] = I[t * 3 + ((k + 1) % 3)];
      nb[fill[v]++] = I[t * 3 + ((k + 2) % 3)];
    }
  }
  const out = P.slice();
  const tmp = new Float32Array(P.length);
  const step = (src, dst, f) => {
    for (let v = 0; v < V; v++) {
      const i = v * 3;
      if (!inside[v] || fixed[v] || deg[v + 1] === deg[v]) {
        dst[i] = src[i];
        dst[i + 1] = src[i + 1];
        dst[i + 2] = src[i + 2];
        continue;
      }
      let x = 0, y = 0, z = 0;
      const n = deg[v + 1] - deg[v];
      for (let j = deg[v]; j < deg[v + 1]; j++) {
        const u = nb[j] * 3;
        x += src[u];
        y += src[u + 1];
        z += src[u + 2];
      }
      dst[i] = src[i] + f * (x / n - src[i]);
      dst[i + 1] = src[i + 1] + f * (y / n - src[i + 1]);
      dst[i + 2] = src[i + 2] + f * (z / n - src[i + 2]);
    }
  };
  const lambda = Math.min(0.9, Math.max(0.05, strength)), mu = -lambda / (1 - 0.1 * lambda);
  for (let p = 0; p < passes; p++) {
    step(out, tmp, lambda);
    step(tmp, out, mu);
  }
  mesh._set(out, mesh.indices);
}
