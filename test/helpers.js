import { EditableMesh } from '../src/mesh.js';

// Unit cube, outward-facing triangles.
export function cube() {
  const positions = new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,1,0, 0,0,1, 1,0,1, 1,1,1, 0,1,1]);
  const indices = new Uint32Array([
    0,2,1, 0,3,2, // bottom (z=0)
    4,5,6, 4,6,7, // top
    0,1,5, 0,5,4, // y=0
    2,3,7, 2,7,6, // y=1
    1,2,6, 1,6,5, // x=1
    3,0,4, 3,4,7, // x=0
  ]);
  return new EditableMesh(positions, indices);
}

// UV sphere, outward-facing triangles.
export function sphere(rings = 16, segments = 24, r = 1) {
  const pos = [0, 0, r];
  for (let i = 1; i < rings; i++) {
    const th = (Math.PI * i) / rings;
    for (let j = 0; j < segments; j++) {
      const ph = (2 * Math.PI * j) / segments;
      pos.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th));
    }
  }
  pos.push(0, 0, -r);
  const bottom = pos.length / 3 - 1;
  const ring = (i, j) => 1 + (i - 1) * segments + (j % segments);
  const ind = [];
  for (let j = 0; j < segments; j++) ind.push(0, ring(1, j), ring(1, j + 1));
  for (let i = 1; i < rings - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = ring(i, j), b = ring(i, j + 1), c = ring(i + 1, j), d = ring(i + 1, j + 1);
      ind.push(a, c, d, a, d, b);
    }
  }
  for (let j = 0; j < segments; j++) ind.push(bottom, ring(rings - 1, j + 1), ring(rings - 1, j));
  return new EditableMesh(new Float32Array(pos), new Uint32Array(ind));
}

// Signed volume (positive for outward-facing closed meshes).
export function volume(mesh) {
  const p = mesh.positions, ind = mesh.indices;
  let v = 0;
  for (let t = 0; t < ind.length; t += 3) {
    const a = ind[t] * 3, b = ind[t + 1] * 3, c = ind[t + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
       - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
       + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

// True when every edge is used exactly twice, in opposite directions.
export function consistentlyClosed(mesh) {
  const dir = new Map();
  const ind = mesh.indices;
  for (let t = 0; t < ind.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const key = ind[t + k] + '>' + ind[t + ((k + 1) % 3)];
      if (dir.has(key)) return false;
      dir.set(key, 1);
    }
  }
  for (const key of dir.keys()) {
    const [a, b] = key.split('>');
    if (!dir.has(b + '>' + a)) return false;
  }
  return true;
}
