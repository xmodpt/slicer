// Test model: a one-surface standing figure on a round base, hands in its pockets
// (arms fused to the hips) – like a 3D scan. Marching tetrahedra over an SDF.
import { EditableMesh } from '../src/mesh.js';
const len = (x, y, z) => Math.hypot(x, y, z);
function capsule(p, a, b, r) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
  return len(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t) - (typeof r === 'function' ? r(t) : r);
}
const smin = (a, b, k) => { if (!isFinite(a)) return b; const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k)); return b * (1 - h) + a * h - k * h * (1 - h); };
export function sdf([x, y, z], { base = true, pockets = true } = {}) {
  let d = Infinity;
  // legs, shoes
  for (const s of [-1, 1]) {
    d = Math.min(d, capsule([x, y, z], [s * 5.5, 0, 8], [s * 5.5, 0, 50], (t) => 3.6 + 1.2 * t));
    d = smin(d, capsule([x, y, z], [s * 5.5, -1, 6], [s * 5.5, -6, 5.5], 3.2), 2);
  }
  // torso
  const torso = capsule([x, y * 1.5, z], [0, 0, 52], [0, 0, 80], (t) => 10 + 1.5 * Math.sin(t * Math.PI));
  d = smin(d, torso, 3);
  // arms: shoulders to the pockets
  for (const s of [-1, 1]) {
    const hand = pockets ? [s * 10.5, -2, 50] : [s * 17, 0, 44];
    d = smin(d, capsule([x, y, z], [s * 14, 0, 79], [s * 16, -1, 62], 3.2), 1.5);
    d = smin(d, capsule([x, y, z], [s * 16, -1, 62], hand, 2.8), 1.5);
  }
  // collar, neck, head
  d = smin(d, capsule([x, y, z], [0, 0, 80], [0, 0, 84], 6.5), 1.5);
  d = Math.min(d, capsule([x, y, z], [0, 0, 82], [0, 0, 93], 4.2));
  d = smin(d, len(x, y * 1.1, (z - 101) * 0.9) - 7.5, 1.5);
  if (base) d = Math.min(d, Math.max(Math.hypot(x, y) - 20, Math.abs(z - 1.5) - 1.5));
  return d;
}
export function figure(opts = {}, h = 0.8) {
  const min = [-24, -22, -0.5], max = [24, 22, 112];
  const n = min.map((m, i) => Math.ceil((max[i] - m) / h) + 1);
  const val = new Float32Array(n[0] * n[1] * n[2]);
  const id = (i, j, k) => i + n[0] * (j + n[1] * k);
  const pt = (i, j, k) => [min[0] + i * h, min[1] + j * h, min[2] + k * h];
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const p = pt(i, j, k);
    val[id(i, j, k)] = (i === 0 || j === 0 || k === 0 || i === n[0] - 1 || j === n[1] - 1 || k === n[2] - 1) ? 1 : sdf(p, opts);
  }
  const pos = [], idx = [], edgeV = new Map();
  const vert = (a, b) => {
    const key = a < b ? a * 1e8 + b : b * 1e8 + a;
    let v = edgeV.get(key);
    if (v === undefined) {
      const ca = coords(a), cb = coords(b), va = val[a], vb = val[b], t = va / (va - vb);
      v = pos.length / 3; pos.push(...ca.map((c, q) => c + (cb[q] - c) * t)); edgeV.set(key, v);
    }
    return v;
  };
  const coords = (g) => { const i = g % n[0], j = Math.floor(g / n[0]) % n[1], k = Math.floor(g / (n[0] * n[1])); return pt(i, j, k); };
  const TETS = [[0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]];
  const OFF = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const tri = (a, b, c, g) => {
    // orient outward: normal along the gradient (towards positive)
    const A = pos.slice(a * 3, a * 3 + 3), B = pos.slice(b * 3, b * 3 + 3), C = pos.slice(c * 3, c * 3 + 3);
    const nrm = [(B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]), (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]), (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])];
    if (nrm[0] * g[0] + nrm[1] * g[1] + nrm[2] * g[2] < 0) idx.push(a, c, b); else idx.push(a, b, c);
  };
  for (let k = 0; k < n[2] - 1; k++) for (let j = 0; j < n[1] - 1; j++) for (let i = 0; i < n[0] - 1; i++) {
    const c = OFF.map(([a, b, e]) => id(i + a, j + b, k + e));
    for (const T of TETS) {
      const g = T.map((q) => c[q]);
      const inside = g.filter((q) => val[q] < 0), out = g.filter((q) => val[q] >= 0);
      if (!inside.length || !out.length) continue;
      const pi = inside.map(coords), po = out.map(coords);
      const ci = pi.reduce((s, p) => s.map((x, q) => x + p[q] / pi.length), [0, 0, 0]), co = po.reduce((s, p) => s.map((x, q) => x + p[q] / po.length), [0, 0, 0]);
      const grad = co.map((x, q) => x - ci[q]);
      if (inside.length === 1 || inside.length === 3) {
        const lone = inside.length === 1 ? inside[0] : out[0], rest = inside.length === 1 ? out : inside;
        tri(vert(lone, rest[0]), vert(lone, rest[1]), vert(lone, rest[2]), grad);
      } else {
        const [a, b] = inside, [p, q] = out;
        const v1 = vert(a, p), v2 = vert(a, q), v3 = vert(b, q), v4 = vert(b, p);
        tri(v1, v2, v3, grad); tri(v1, v3, v4, grad);
      }
    }
  }
  const m = new EditableMesh(new Float32Array(pos), new Uint32Array(idx));
  return m;
}
