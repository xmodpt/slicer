// Plane cut with glue connectors.
//
// The model is cut along a plane, both halves are closed with flat caps, and
// cylindrical pins are added: a pin stands on the cap of the lower half (the
// side the normal points away from) and a matching hole goes into the upper
// half. The hole is wider than the pin by `tolerance` (0.5 % by default) and a
// little deeper, so printed parts fit without force.

import { ShapeUtils, Vector2 } from 'three';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

// plane: { normal, offset } – the plane n·p = offset. Options:
//   pins: 'auto' | 0..4 per cut area, diameter / length in model units (0 = auto),
//   tolerance: extra hole diameter in percent, segments: pin roundness.
// Returns { pins: [{ diameter, length, holeDiameter }], skipped: [reason], areas }.
export function cutWithPins(mesh, plane, opts = {}) {
  const { pins = 'auto', diameter = 0, length = 0, tolerance = 0.5, segments = 32 } = opts;
  const n = norm(plane.normal);
  const c = -plane.offset;
  const before = mesh.snapshot();

  mesh.cutByPlane(n, c);
  const upper = mesh.facesInsidePlanes([{ normal: n, constant: c }]);
  let count = 0;
  for (const v of upper) count += v;
  if (!count || count === upper.length) {
    mesh.restore(before);
    throw new Error('The plane does not cut through the model – move it so it crosses the model.');
  }
  const { dup } = mesh.splitOff(upper, { close: false });

  // Plane frame: U x V = n; origin on the plane.
  const U = norm(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
  const V = cross(n, U);
  const O = [-c * n[0], -c * n[1], -c * n[2]];
  const { min, max } = mesh.bounds();
  const size = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const eps = size * 1e-5;

  const P = mesh.positions;
  const pos = (v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
  const onPlane = (v) => Math.abs(dot(n, pos(v)) + c) < eps;
  const to2 = (v) => {
    const p = sub(pos(v), O);
    return [dot(p, U), dot(p, V)];
  };

  // Openings on the lower side, along the plane (each also exists on the upper side via `dup`).
  const upperVerts = mesh.verticesOf(upper);
  const { loops } = mesh.boundaryLoops();
  const lower = loops.filter((l) => l.every((v) => onPlane(v) && !upperVerts[v] && dup[v] >= 0));
  const rings = lower.map((ids) => {
    const pts = ids.map(to2);
    return { ids, pts, area: polygonArea(pts) };
  });
  // Loop order follows the cap that closes the lower half (facing +n), so the
  // outlines of solid areas wind counter-clockwise and inner holes clockwise.
  const outers = rings.filter((r) => r.area > 0).map((r) => ({ ...r, holes: [] }));
  for (const r of rings.filter((r) => r.area < 0)) {
    const home = outers.filter((o) => pointInPolygon(r.pts[0], o.pts)).sort((a, b) => a.area - b.area)[0];
    if (home) home.holes.push(r);
  }

  const extra = []; // new vertex coordinates
  const tris = [];
  const base = mesh.vertexCount;
  const newVertex = (u, v, w) => {
    extra.push(O[0] + u * U[0] + v * V[0] + w * n[0], O[1] + u * U[1] + v * V[1] + w * n[1], O[2] + u * U[2] + v * V[2] + w * n[2]);
    return base + extra.length / 3 - 1;
  };
  const vpos = (id) => (id < base ? pos(id) : extra.slice((id - base) * 3, (id - base) * 3 + 3));
  // Adds a triangle wound so its normal points along `want`.
  const tri = (a, b, cc, want) => {
    const pa = vpos(a);
    const nrm = cross(sub(vpos(b), pa), sub(vpos(cc), pa));
    if (dot(nrm, want) < 0) tris.push(a, cc, b);
    else tris.push(a, b, cc);
  };
  const down = [-n[0], -n[1], -n[2]];

  const result = { pins: [], skipped: [], areas: outers.length };
  const tol = 1 + tolerance / 100;

  for (const area of outers) {
    const edges = [area, ...area.holes].flatMap((r) => r.pts.map((p, i) => [p, r.pts[(i + 1) % r.pts.length]]));
    const plan = planPins(area, edges, { pins, diameter, tolerance: tol });
    const placed = [];
    for (const pin of plan.pins) {
      // How deep can the hole go into the upper half without breaking through?
      const room = depthAvailable(mesh, upper, pin.center, pin.r * tol + plan.wall, { n, U, V, O });
      const want = length > 0 ? length : 1.5 * pin.r * 2;
      const clearance = Math.max(want * 0.01, pin.r * 0.05);
      const h = Math.min(want, (room - plan.wall - clearance) / tol);
      if (h < pin.r) {
        result.skipped.push('Not enough material above the cut for a pin there.');
        continue;
      }
      placed.push({ ...pin, h, depth: h * tol + clearance });
    }
    if (plan.note) result.skipped.push(plan.note);

    // Caps: the cut area with a round opening per pin – pin-sized on the lower
    // cap, hole-sized on the upper one.
    const ringOf = (center, r, w) => {
      const ids = [];
      for (let k = 0; k < segments; k++) {
        const a = (2 * Math.PI * k) / segments;
        ids.push(newVertex(center[0] + r * Math.cos(a), center[1] + r * Math.sin(a), w));
      }
      return ids;
    };
    for (const side of ['lower', 'upper']) {
      const idOf = (v) => (side === 'lower' ? v : dup[v]);
      const circles = placed.map((p) => (side === 'lower' ? p.r : p.r * tol));
      const circleIds = placed.map((p, i) => ringOf(p.center, circles[i], 0));
      const contour = area.pts.map(([x, y]) => new Vector2(x, y));
      const holes = [
        ...area.holes.map((h) => h.pts.map(([x, y]) => new Vector2(x, y))),
        ...placed.map((p, i) => circleIds[i].map((_, k) => {
          const a = (2 * Math.PI * k) / segments;
          return new Vector2(p.center[0] + circles[i] * Math.cos(a), p.center[1] + circles[i] * Math.sin(a));
        })),
      ];
      const ids = [...area.ids.map(idOf), ...area.holes.flatMap((h) => h.ids.map(idOf)), ...circleIds.flat()];
      for (const [a, b, cc] of ShapeUtils.triangulateShape(contour, holes)) {
        tri(ids[a], ids[b], ids[cc], side === 'lower' ? n : down);
      }
      placed.forEach((p, i) => (p[side + 'Ring'] = circleIds[i]));
    }

    for (const p of placed) {
      const radial = (k) => {
        const a = (2 * Math.PI * (k + 0.5)) / segments;
        return norm([U[0] * Math.cos(a) + V[0] * Math.sin(a), U[1] * Math.cos(a) + V[1] * Math.sin(a), U[2] * Math.cos(a) + V[2] * Math.sin(a)]);
      };
      // Pin on the lower half: straight wall, a small chamfer, flat top.
      const ch = Math.min(p.r * 0.25, p.h * 0.2);
      const r0 = p.lowerRing;
      const r1 = ringOf(p.center, p.r, p.h - ch);
      const r2 = ringOf(p.center, p.r - ch, p.h);
      const top = newVertex(p.center[0], p.center[1], p.h);
      for (let k = 0; k < segments; k++) {
        const k1 = (k + 1) % segments, out = radial(k);
        tri(r0[k], r0[k1], r1[k1], out);
        tri(r0[k], r1[k1], r1[k], out);
        const slope = norm([out[0] + n[0], out[1] + n[1], out[2] + n[2]]);
        tri(r1[k], r1[k1], r2[k1], slope);
        tri(r1[k], r2[k1], r2[k], slope);
        tri(r2[k], r2[k1], top, n);
      }
      // Hole in the upper half: wall facing the axis, flat bottom facing down.
      const rf = p.r * tol;
      const h0 = p.upperRing;
      const h1 = ringOf(p.center, rf, p.depth);
      const bottom = newVertex(p.center[0], p.center[1], p.depth);
      for (let k = 0; k < segments; k++) {
        const k1 = (k + 1) % segments, inward = radial(k).map((x) => -x);
        tri(h0[k], h0[k1], h1[k1], inward);
        tri(h0[k], h1[k1], h1[k], inward);
        tri(h1[k], h1[k1], bottom, down);
      }
      result.pins.push({ diameter: p.r * 2, length: p.h, holeDiameter: rf * 2, holeDepth: p.depth });
    }
  }

  const positions = new Float32Array(mesh.positions.length + extra.length);
  positions.set(mesh.positions);
  positions.set(extra, mesh.positions.length);
  const indices = new Uint32Array(mesh.indices.length + tris.length);
  indices.set(mesh.indices);
  indices.set(tris, mesh.indices.length);
  mesh._set(positions, indices);

  // Anything not closed above (e.g. odd cross-sections) is closed the plain way.
  const seam = new Uint8Array(mesh.vertexCount);
  dup.forEach((d, v) => d >= 0 && (seam[v] = seam[d] = 1));
  mesh.fillHoles({ onlyVertices: seam });
  return result;
}

// Chooses pin centres (in plane coordinates) for one cut area: the points
// with the most material around them, spread apart.
function planPins(area, edges, { pins, diameter, tolerance }) {
  const xs = area.pts.map((p) => p[0]), ys = area.pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const step = Math.max(x1 - x0, y1 - y0) / 60;
  const candidates = [];
  for (let x = x0 + step / 2; x < x1; x += step) {
    for (let y = y0 + step / 2; y < y1; y += step) {
      const q = [x, y];
      if (!pointInPolygon(q, area.pts) || area.holes.some((h) => pointInPolygon(q, h.pts))) continue;
      candidates.push({ q, d: distanceToEdges(q, edges) });
    }
  }
  if (!candidates.length) return { pins: [], wall: 0, note: 'A cut area is too thin for pins.' };
  const R = Math.max(...candidates.map((c) => c.d)); // largest circle that fits
  const r = diameter > 0 ? diameter / 2 : Math.min(5, Math.max(0.75, Math.floor(R * 0.55 * 4) / 4));
  const wall = Math.max(0.8, r * 0.3);
  const fits = candidates.filter((c) => c.d >= r * tolerance + wall);
  if (!fits.length) return { pins: [], wall, note: `A cut area is too thin for a Ø${(r * 2).toFixed(1)} pin.` };

  const long = Math.max(x1 - x0, y1 - y0);
  const want = pins === 'auto' ? (long > 12 * r ? 2 : 1) : Number(pins);
  const chosen = [];
  while (chosen.length < want) {
    let best = null, bestScore = -Infinity;
    for (const c of fits) {
      const spacing = chosen.length ? Math.min(...chosen.map((p) => Math.hypot(p.center[0] - c.q[0], p.center[1] - c.q[1]))) : Infinity;
      if (spacing < 2 * (r * tolerance + wall)) continue;
      const score = chosen.length ? Math.min(c.d, spacing / 2) + spacing * 1e-3 : c.d;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) break;
    chosen.push({ center: best.q, r });
  }
  const note = chosen.length < want ? `Only room for ${chosen.length} of ${want} pins in a cut area.` : null;
  return { pins: chosen, wall, note };
}

// Distance from the cut plane into the upper half, measured along the normal
// from the pin centre and around its rim; Infinity if nothing is hit.
function depthAvailable(mesh, upper, center, radius, { n, U, V, O }) {
  const samples = [center];
  for (let k = 0; k < 8; k++) {
    const a = (2 * Math.PI * k) / 8;
    samples.push([center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)]);
  }
  const P = mesh.positions, ind = mesh.indices;
  let best = Infinity;
  for (let t = 0; t < mesh.triangleCount; t++) {
    if (!upper[t]) continue;
    const q = [0, 1, 2].map((k) => {
      const v = ind[t * 3 + k] * 3;
      const p = [P[v] - O[0], P[v + 1] - O[1], P[v + 2] - O[2]];
      return [dot(p, U), dot(p, V), dot(p, n)];
    });
    if (Math.max(q[0][2], q[1][2], q[2][2]) <= 1e-9) continue; // on or below the plane
    const ux0 = Math.min(q[0][0], q[1][0], q[2][0]), ux1 = Math.max(q[0][0], q[1][0], q[2][0]);
    const vy0 = Math.min(q[0][1], q[1][1], q[2][1]), vy1 = Math.max(q[0][1], q[1][1], q[2][1]);
    if (ux1 < center[0] - radius || ux0 > center[0] + radius || vy1 < center[1] - radius || vy0 > center[1] + radius) continue;
    for (const s of samples) {
      // Vertical ray from (s, 0) upward: barycentric test in the plane, then height.
      const w = heightAt(s, q);
      if (w !== null && w > 1e-6 && w < best) best = w;
    }
  }
  return best;
}

function heightAt([x, y], [a, b, c]) {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(d) < 1e-12) return null;
  const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
  const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
  const l3 = 1 - l1 - l2;
  if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) return null;
  return l1 * a[2] + l2 * b[2] + l3 * c[2];
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

function pointInPolygon([x, y], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToEdges([x, y], edges) {
  let best = Infinity;
  for (const [[ax, ay], [bx, by]] of edges) {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
    if (d < best) best = d;
  }
  return best;
}
