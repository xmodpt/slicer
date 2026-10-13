// Checks for printing: volume and resin, overhangs (and the turn that needs
// the fewest supports), wall thickness.

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

// Volume (mm³, closed meshes), surface area (mm²) and size of the whole mesh
// or of the faces in `faces` (a list of triangle indices).
export function modelInfo(mesh, faces = null) {
  const P = mesh.positions, I = mesh.indices;
  let vol = 0, area = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const each = (t) => {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ax = P[a], ay = P[a + 1], az = P[a + 2], bx = P[b], by = P[b + 1], bz = P[b + 2], cx = P[c], cy = P[c + 1], cz = P[c + 2];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) {
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    }
  };
  if (faces) for (const t of faces) each(t);
  else for (let t = 0; t < mesh.triangleCount; t++) each(t);
  return { volume: Math.abs(vol), area, size: max.map((v, i) => (isFinite(v) ? v - min[i] : 0)), min, max };
}

// Resin use: ml (= cm³), weight in g and cost, from the volume in mm³.
// density g/ml (most standard resins 1.05–1.25), price per kg or per litre.
export function resinUse(volumeMM3, { density = 1.1, pricePerKg = 30 } = {}) {
  const ml = volumeMM3 / 1000;
  const grams = ml * density;
  return { ml, grams, cost: (grams / 1000) * pricePerKg };
}

// Per face: does it face down more steeply than `angle` (degrees from the
// plate)? Faces lying on the plate (within `onPlate` mm of the lowest point)
// don't need support. Returns { mask: Uint8Array, area }.
export function overhangs(mesh, { angle = 45, onPlate = 0.3 } = {}) {
  const P = mesh.positions, I = mesh.indices, T = mesh.triangleCount;
  const limit = -Math.sin((angle * Math.PI) / 180); // normal.z below this → overhang
  let minZ = Infinity;
  for (let i = 2; i < P.length; i += 3) if (P[i] < minZ) minZ = P[i];
  const mask = new Uint8Array(T);
  let area = 0;
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 0) || nz / l >= limit) continue;
    if (Math.max(P[a + 2], P[b + 2], P[c + 2]) <= minZ + onPlate) continue;
    mask[t] = 1;
    area += l / 2;
  }
  return { mask, area };
}

// The turn that leaves the least overhanging area (and, among nearly equal
// ones, the lowest height). Tries ~240 directions as "down". Returns
// { down: [x, y, z] (the model direction that should point down), area,
// height, before: { area, height } }.
export function bestOrientation(mesh, { angle = 45, samples = 240, maxFaces = 150000 } = {}) {
  const P = mesh.positions, I = mesh.indices, T = mesh.triangleCount;
  const step = Math.max(1, Math.floor(T / maxFaces));
  // Face normals (×2 area) and centroids, sampled.
  const n = [], c = [];
  for (let t = 0; t < T; t += step) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, d = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[d] - P[a], vy = P[d + 1] - P[a + 1], vz = P[d + 2] - P[a + 2];
    n.push(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    c.push((P[a] + P[b] + P[d]) / 3, (P[a + 1] + P[b + 1] + P[d + 1]) / 3, (P[a + 2] + P[b + 2] + P[d + 2]) / 3);
  }
  const vstep = Math.max(1, Math.floor(P.length / 3 / 50000));
  const limit = Math.sin((angle * Math.PI) / 180);
  const score = (d) => {
    // "Down" is d: a face overhangs when its normal points along d steeply.
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < P.length; i += 3 * vstep) {
      const h = -(P[i] * d[0] + P[i + 1] * d[1] + P[i + 2] * d[2]);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    let area = 0;
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
      if (!(l > 0)) continue;
      if ((n[i] * d[0] + n[i + 1] * d[1] + n[i + 2] * d[2]) / l <= limit) continue;
      const h = -(c[i] * d[0] + c[i + 1] * d[1] + c[i + 2] * d[2]);
      if (h <= lo + 0.3) continue; // on the plate
      area += l / 2;
    }
    return { area: area * step, height: hi - lo };
  };
  const dirs = [];
  // Even spread (Fibonacci sphere) plus the six axes.
  for (let i = 0; i < samples; i++) {
    const z = 1 - (2 * (i + 0.5)) / samples, r = Math.sqrt(1 - z * z), phi = i * 2.399963229728653;
    dirs.push([r * Math.cos(phi), r * Math.sin(phi), z]);
  }
  dirs.push([0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]);
  const before = score([0, 0, -1]);
  let best = null;
  for (const d of dirs) {
    const s = score(d);
    // Fewer overhangs wins; the height only breaks near-ties (within 3 %).
    if (!best || s.area < best.area * 0.97 - 1e-9 || (s.area <= best.area * 1.03 && s.height < best.height)) best = { down: d, ...s };
  }
  return { ...best, before };
}

// Wall thickness per face: from the face's centre straight into the model
// (against its normal) to the first surface on the other side, in mm.
// Infinity where the ray finds nothing (an open or inside-out spot).
export function wallThickness(mesh) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  // A copy: building the BVH reorders the index buffer it is given.
  geo.setIndex(new THREE.BufferAttribute(mesh.indices.slice(), 1));
  const bvh = new MeshBVH(geo);
  const P = mesh.positions, I = mesh.indices, T = mesh.triangleCount;
  const out = new Float32Array(T);
  const ray = new THREE.Ray();
  const o = new THREE.Vector3(), dir = new THREE.Vector3();
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    dir.set(-(uy * vz - uz * vy), -(uz * vx - ux * vz), -(ux * vy - uy * vx));
    const l = dir.length();
    if (!(l > 0)) {
      out[t] = Infinity;
      continue;
    }
    dir.divideScalar(l);
    o.set((P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3).addScaledVector(dir, 1e-4);
    ray.set(o, dir);
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
    out[t] = hit ? hit.distance + 1e-4 : Infinity;
  }
  geo.dispose();
  return out;
}
