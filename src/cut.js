// Plane cut with glue connectors.
//
// The model is cut along a plane and both halves are closed with flat caps.
// Each separate cut area is analysed and gets connectors that fit it:
//   - pin & hole: a pin stands on the lower half's cap (the side the plane
//     normal points away from) and a matching hole goes into the upper half;
//   - dowel: holes in both halves plus a separate dowel part, printed lying
//     down (stronger than a pin printed upright);
//   - none, when the area is too thin – glue only.
// Holes are wider than their pins by `tolerance` (0.5 % by default) and a bit
// deeper, so printed parts fit together without force.

import { ShapeUtils, Vector2 } from 'three';
import { EditableMesh } from './mesh.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

// Options (shared by analyzeCut and cutWithPins):
//   type: 'auto' | 'pin' | 'dowel' | 'none'
//   pins: 'auto' | count per cut area
//   diameter, length: connector size in model units (0 = automatic);
//     length is how far a pin sticks out (a dowel is twice as long)
//   tolerance: how much wider holes are than pins, in percent
//   segments: roundness

// Looks at what a cut would produce, without changing the mesh.
export function analyzeCut(mesh, plane, opts = {}) {
  const work = new EditableMesh(mesh.positions, mesh.indices);
  const ctx = prepare(work, plane);
  return plan(work, ctx, opts);
}

// Cuts, closes both halves and adds the planned connectors. Returns the plan
// plus `pins` (one entry per connector) and `dowelFaces` – the range of
// triangles that are separate dowel parts.
export function cutWithPins(mesh, plane, opts = {}) {
  const ctx = prepare(mesh, plane);
  const result = plan(mesh, ctx, opts);
  build(mesh, ctx, result, opts);
  return result;
}

// ---------------------------------------------------------------------------

function prepare(mesh, plane) {
  const n = norm(plane.normal);
  const c = -plane.offset;
  const before = mesh.snapshot();
  // Inside-out models (triangles facing inwards) get caps and connectors wound
  // the same way, so the result stays consistent.
  const flip = signedVolume(mesh) < 0;

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
  const to2 = (v) => {
    const p = sub(pos(v), O);
    return [dot(p, U), dot(p, V)];
  };

  // Openings of the lower half along the plane (each also exists on the
  // upper half, through `dup`).
  const upperVerts = mesh.verticesOf(upper);
  const { loops } = mesh.boundaryLoops();
  const lower = loops.filter((l) => l.every((v) => Math.abs(dot(n, pos(v)) + c) < eps && !upperVerts[v] && dup[v] >= 0));
  const rings = lower.map((ids) => {
    const pts = ids.map(to2);
    return { ids, pts, area: Math.abs(polygonArea(pts)) };
  });
  // Outlines vs. inner openings by nesting (works whatever way the model's
  // triangles face): a ring inside an odd number of others is an opening.
  const depth = rings.map((r) => rings.filter((o) => o !== r && o.area > r.area && pointInPolygon(r.pts[0], o.pts)).length);
  const areas = rings.filter((_, i) => depth[i] % 2 === 0).map((r) => ({ ...r, holes: [] }));
  rings.forEach((r, i) => {
    if (depth[i] % 2 === 0) return;
    const home = areas.filter((o) => o.area > r.area && pointInPolygon(r.pts[0], o.pts)).sort((a, b) => a.area - b.area)[0];
    if (home) home.holes.push(r);
  });
  areas.sort((a, b) => b.area - a.area);

  return { n, c, U, V, O, upper, dup, areas, size, flip };
}

// Chooses connectors for each cut area.
function plan(mesh, ctx, opts) {
  const { type = 'auto', pins = 'auto', diameter = 0, length = 0, tolerance = 0.5 } = opts;
  const tol = 1 + tolerance / 100;
  const lowerMask = ctx.upper.map((v) => (v ? 0 : 1));
  const result = { areas: [], pins: [], notes: [], dowelFaces: null };

  ctx.areas.forEach((area, index) => {
    const xs = area.pts.map((p) => p[0]), ys = area.pts.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    const solidArea = area.area - area.holes.reduce((s, r) => s + r.area, 0);
    const info = { index, size: [w, h], area: solidArea, connectors: [], notes: [] };
    result.areas.push(info);
    area.plan = info;
    if (type === 'none' || pins === '0' || pins === 0) {
      info.notes.push('No connectors requested.');
      return;
    }

    const edges = [area, ...area.holes].flatMap((r) => r.pts.map((p, i) => [p, r.pts[(i + 1) % r.pts.length]]));
    const candidates = findCandidates(area, edges);
    const R = candidates.length ? Math.max(...candidates.map((q) => q.d)) : 0; // half the thickest spot
    info.thickness = 2 * R;
    const r = diameter > 0 ? diameter / 2 : Math.min(5, Math.max(0.75, Math.floor(R * 0.5 * 4) / 4));
    const wall = Math.max(0.6, r * 0.3);
    const need = r * tol + wall;
    const fits = candidates.filter((q) => q.d >= need);
    if (!fits.length) {
      info.notes.push(
        R < 0.75 * tol + 0.6
          ? `Too thin for connectors (thickest spot ${(2 * R).toFixed(1)} mm) – glue only.`
          : `A Ø${(2 * r).toFixed(1)} connector needs ${(2 * need).toFixed(1)} mm of solid material; the thickest spot is ${(2 * R).toFixed(1)} mm. Use a smaller Ø or Auto.`,
      );
      return;
    }

    const long = Math.max(w, h);
    const want = pins === 'auto' ? (long > 30 * r ? 3 : long > 12 * r ? 2 : 1) : Number(pins);
    const centers = choosePoints(fits, want, 2 * need);
    if (centers.length < want) info.notes.push(`Room for ${centers.length} of ${want} connectors.`);

    const L = length > 0 ? length : 3 * r; // pin length / depth per side for dowels
    const clearance = Math.max(L * 0.02, r * 0.1, 0.2);
    const up = depthAvailable(mesh, ctx.upper, centers, r * tol + wall, ctx, 1);
    const down = depthAvailable(mesh, lowerMask, centers, r * tol + wall, ctx, -1);

    centers.forEach((center, i) => {
      // Usable depth on each side (the hole must keep a wall at its bottom).
      const upRoom = (up[i] - wall - clearance) / tol;
      const downRoom = (down[i] - wall - clearance) / tol;
      const pinLen = Math.min(L, upRoom);
      const dowelLen = Math.min(L, upRoom, downRoom);
      let kind = null, h = 0;
      if (type === 'pin') [kind, h] = ['pin', pinLen];
      else if (type === 'dowel') [kind, h] = ['dowel', dowelLen];
      else if (pinLen >= Math.max(r * 1.5, 0.75 * L)) [kind, h] = ['pin', pinLen];
      else if (dowelLen >= r * 1.5) [kind, h] = ['dowel', dowelLen];
      else [kind, h] = ['pin', pinLen];
      if (h < r) {
        const thinSide = kind === 'dowel' && downRoom < upRoom ? 'lower' : 'upper';
        info.notes.push(`Not enough material in the ${thinSide} half for a connector there.`);
        if (kind === 'pin' && downRoom > upRoom + r) info.notes.push('Flip puts the pins on the other half – it has more room.');
        return;
      }
      const conn = {
        kind,
        center,
        center3: ctx.O.map((o, k) => o + center[0] * ctx.U[k] + center[1] * ctx.V[k]),
        r,
        h,
        holeR: r * tol,
        holeDepth: h * tol + clearance,
      };
      info.connectors.push(conn);
      result.pins.push({ kind, diameter: 2 * r, length: kind === 'dowel' ? 2 * h : h, holeDiameter: 2 * r * tol, holeDepth: conn.holeDepth });
    });
  });

  // Overall advice.
  const kinds = new Set(result.pins.map((p) => p.kind));
  if (!result.pins.length && type !== 'none') result.notes.push('No connectors fit this cut – try another position, a smaller Ø, or glue the halves.');
  if (kinds.has('pin')) result.notes.push('Print the half with pins standing on its base so the pins point up.');
  if (kinds.has('dowel')) result.notes.push('Dowels are separate parts: print them lying down for strength.');
  return result;
}

// Candidate connector centres with their distance to the outline: a coarse
// grid plus points on the middle line of thin walls (found by looking
// straight across from each edge), so narrow sections are not missed.
function findCandidates(area, edges) {
  const inside = (q) => pointInPolygon(q, area.pts) && !area.holes.some((h) => pointInPolygon(q, h.pts));
  const xs = area.pts.map((p) => p[0]), ys = area.pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const out = [];
  const add = (q) => {
    if (inside(q)) out.push({ q, d: distanceToEdges(q, edges) });
  };
  const step = Math.max(x1 - x0, y1 - y0) / 40;
  for (let x = x0 + step / 2; x < x1; x += step) for (let y = y0 + step / 2; y < y1; y += step) add([x, y]);

  const stride = Math.max(1, Math.floor(edges.length / 1500));
  for (let i = 0; i < edges.length; i += stride) {
    const [[ax, ay], [bx, by]] = edges[i];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-9) continue;
    const m = [(ax + bx) / 2, (ay + by) / 2];
    for (const sign of [1, -1]) {
      const dir = [(-(by - ay) / len) * sign, ((bx - ax) / len) * sign];
      const t = rayToEdges(m, dir, edges, i);
      if (t < Infinity) add([m[0] + (dir[0] * t) / 2, m[1] + (dir[1] * t) / 2]);
    }
  }
  return out;
}

// Greedy pick of up to `count` points: the thickest spot first, then points
// that are thick and far from the ones already chosen.
function choosePoints(fits, count, minSpacing) {
  const chosen = [];
  while (chosen.length < count) {
    let best = null, bestScore = -Infinity;
    for (const c of fits) {
      const spacing = chosen.length ? Math.min(...chosen.map((p) => Math.hypot(p[0] - c.q[0], p[1] - c.q[1]))) : Infinity;
      if (spacing < minSpacing) continue;
      const score = chosen.length ? Math.min(c.d * 4, spacing) : c.d;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) break;
    chosen.push(best.q);
  }
  return chosen;
}

// For each centre: free distance from the cut plane into the half selected
// by `mask`, going along +n (dir 1) or -n (dir -1), measured at the centre and
// around a circle of `radius`. Infinity when nothing is hit.
function depthAvailable(mesh, mask, centers, radius, { n, U, V, O }, dir) {
  const best = centers.map(() => Infinity);
  if (!centers.length) return best;
  const samples = centers.map((c) => {
    const s = [c];
    for (let k = 0; k < 8; k++) {
      const a = (2 * Math.PI * k) / 8;
      s.push([c[0] + radius * Math.cos(a), c[1] + radius * Math.sin(a)]);
    }
    return s;
  });
  const P = mesh.positions, ind = mesh.indices;
  for (let t = 0; t < mesh.triangleCount; t++) {
    if (!mask[t]) continue;
    const q = [0, 1, 2].map((k) => {
      const v = ind[t * 3 + k] * 3;
      const p = [P[v] - O[0], P[v + 1] - O[1], P[v + 2] - O[2]];
      return [dot(p, U), dot(p, V), dir * dot(p, n)];
    });
    if (Math.max(q[0][2], q[1][2], q[2][2]) <= 1e-9) continue;
    const ux0 = Math.min(q[0][0], q[1][0], q[2][0]), ux1 = Math.max(q[0][0], q[1][0], q[2][0]);
    const vy0 = Math.min(q[0][1], q[1][1], q[2][1]), vy1 = Math.max(q[0][1], q[1][1], q[2][1]);
    centers.forEach((c, i) => {
      if (ux1 < c[0] - radius || ux0 > c[0] + radius || vy1 < c[1] - radius || vy0 > c[1] + radius) return;
      for (const s of samples[i]) {
        const w = heightAt(s, q);
        if (w !== null && w > 1e-6 && w < best[i]) best[i] = w;
      }
    });
  }
  return best;
}

// ---------------------------------------------------------------------------

function build(mesh, ctx, result, { segments = 32 } = {}) {
  const { n, U, V, O, dup, flip } = ctx;
  const extra = [];
  const tris = [];
  const base = mesh.vertexCount;
  const P = mesh.positions;
  const pos = (v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
  const at = (u, v, w) => [O[0] + u * U[0] + v * V[0] + w * n[0], O[1] + u * U[1] + v * V[1] + w * n[1], O[2] + u * U[2] + v * V[2] + w * n[2]];
  const addVertex = (p) => {
    extra.push(p[0], p[1], p[2]);
    return base + extra.length / 3 - 1;
  };
  const newVertex = (u, v, w) => addVertex(at(u, v, w));
  const vpos = (id) => (id < base ? pos(id) : extra.slice((id - base) * 3, (id - base) * 3 + 3));
  // Adds a triangle wound so its normal points along `want`.
  const tri = (a, b, c, want) => {
    const pa = vpos(a);
    const nrm = cross(sub(vpos(b), pa), sub(vpos(c), pa));
    if (dot(nrm, want) * (flip ? -1 : 1) < 0) tris.push(a, c, b);
    else tris.push(a, b, c);
  };
  const down = [-n[0], -n[1], -n[2]];
  const radial = (k) => {
    const a = (2 * Math.PI * (k + 0.5)) / segments;
    return norm([0, 1, 2].map((i) => U[i] * Math.cos(a) + V[i] * Math.sin(a)));
  };
  const ringOf = (center, r, w) => {
    const ids = [];
    for (let k = 0; k < segments; k++) {
      const a = (2 * Math.PI * k) / segments;
      ids.push(newVertex(center[0] + r * Math.cos(a), center[1] + r * Math.sin(a), w));
    }
    return ids;
  };
  // A blind hole from the cap ring `top` (at w = 0) to depth `d` along `side`
  // (+1 into the upper half, -1 into the lower one).
  const hole = (conn, top, d, side) => {
    const bottom = ringOf(conn.center, conn.holeR, side * d);
    const centre = newVertex(conn.center[0], conn.center[1], side * d);
    const floorFacing = side > 0 ? down : n;
    for (let k = 0; k < segments; k++) {
      const k1 = (k + 1) % segments, inward = radial(k).map((x) => -x);
      tri(top[k], top[k1], bottom[k1], inward);
      tri(top[k], bottom[k1], bottom[k], inward);
      tri(bottom[k], bottom[k1], centre, floorFacing);
    }
  };

  for (const area of ctx.areas) {
    const conns = area.plan.connectors;
    // Caps: the cut area with a round opening per connector.
    for (const side of ['lower', 'upper']) {
      const idOf = (v) => (side === 'lower' ? v : dup[v]);
      const radii = conns.map((c) => (side === 'lower' && c.kind === 'pin' ? c.r : c.holeR));
      const circleIds = conns.map((c, i) => ringOf(c.center, radii[i], 0));
      const contour = area.pts.map(([x, y]) => new Vector2(x, y));
      const holes = [
        ...area.holes.map((h) => h.pts.map(([x, y]) => new Vector2(x, y))),
        ...conns.map((c, i) =>
          circleIds[i].map((_, k) => {
            const a = (2 * Math.PI * k) / segments;
            return new Vector2(c.center[0] + radii[i] * Math.cos(a), c.center[1] + radii[i] * Math.sin(a));
          }),
        ),
      ];
      const ids = [...area.ids.map(idOf), ...area.holes.flatMap((h) => h.ids.map(idOf)), ...circleIds.flat()];
      for (const [a, b, c] of ShapeUtils.triangulateShape(contour, holes)) tri(ids[a], ids[b], ids[c], side === 'lower' ? n : down);
      conns.forEach((c, i) => (c[side + 'Ring'] = circleIds[i]));
    }

    for (const c of conns) {
      hole(c, c.upperRing, c.holeDepth, 1);
      if (c.kind === 'dowel') {
        hole(c, c.lowerRing, c.holeDepth, -1);
        continue;
      }
      // Pin on the lower half: straight wall, small chamfer, flat top.
      const ch = Math.min(c.r * 0.25, c.h * 0.2);
      const r0 = c.lowerRing;
      const r1 = ringOf(c.center, c.r, c.h - ch);
      const r2 = ringOf(c.center, c.r - ch, c.h);
      const top = newVertex(c.center[0], c.center[1], c.h);
      for (let k = 0; k < segments; k++) {
        const k1 = (k + 1) % segments, out = radial(k);
        tri(r0[k], r0[k1], r1[k1], out);
        tri(r0[k], r1[k1], r1[k], out);
        const slope = norm([out[0] + n[0], out[1] + n[1], out[2] + n[2]]);
        tri(r1[k], r1[k1], r2[k1], slope);
        tri(r1[k], r2[k1], r2[k], slope);
        tri(r2[k], r2[k1], top, n);
      }
    }
  }

  // Dowels: separate chamfered cylinders lying on the plate beside the model.
  const dowels = ctx.areas.flatMap((a) => a.plan.connectors).filter((c) => c.kind === 'dowel');
  const dowelStart = (mesh.indices.length + tris.length) / 3;
  if (dowels.length) {
    const { min, max } = mesh.bounds();
    let y = min[1];
    for (const d of dowels) {
      const len = 2 * d.h;
      const ch = Math.min(d.r * 0.25, len * 0.1);
      const x0 = max[0] + 5 + d.r, z = d.r; // axis along X, resting on the plate
      const ring = (x, r) => {
        const ids = [];
        for (let k = 0; k < segments; k++) {
          const a = (2 * Math.PI * k) / segments;
          ids.push(addVertex([x, y + d.r + r * Math.cos(a), z + r * Math.sin(a)]));
        }
        return ids;
      };
      const rings = [ring(x0, d.r - ch), ring(x0 + ch, d.r), ring(x0 + len - ch, d.r), ring(x0 + len, d.r - ch)];
      const ends = [addVertex([x0, y + d.r, z]), addVertex([x0 + len, y + d.r, z])];
      for (let k = 0; k < segments; k++) {
        const k1 = (k + 1) % segments;
        const a = (2 * Math.PI * (k + 0.5)) / segments;
        const out = [0, Math.cos(a), Math.sin(a)];
        for (let s = 0; s < 3; s++) {
          const want = s === 0 ? [-1, out[1], out[2]] : s === 2 ? [1, out[1], out[2]] : out;
          tri(rings[s][k], rings[s][k1], rings[s + 1][k1], want);
          tri(rings[s][k], rings[s + 1][k1], rings[s + 1][k], want);
        }
        tri(rings[0][k], rings[0][k1], ends[0], [-1, 0, 0]);
        tri(rings[3][k], rings[3][k1], ends[1], [1, 0, 0]);
      }
      y += 2 * d.r + 3;
    }
    result.dowelFaces = [dowelStart, (mesh.indices.length + tris.length) / 3];
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
}

function signedVolume(mesh) {
  const p = mesh.positions, ind = mesh.indices;
  let v = 0;
  for (let t = 0; t < ind.length; t += 3) {
    const a = ind[t] * 3, b = ind[t + 1] * 3, c = ind[t + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v;
}

// ---------------------------------------------------------------------------
// 2D helpers

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

// Distance along a ray from `o` in direction `d` to the nearest other edge.
function rayToEdges(o, d, edges, skip) {
  let best = Infinity;
  edges.forEach(([[ax, ay], [bx, by]], i) => {
    if (i === skip) return;
    const ex = bx - ax, ey = by - ay;
    const den = d[0] * ey - d[1] * ex;
    if (Math.abs(den) < 1e-12) return;
    const wx = ax - o[0], wy = ay - o[1];
    const t = (wx * ey - wy * ex) / den;
    const s = (wx * d[1] - wy * d[0]) / den;
    if (t > 1e-9 && s >= -1e-9 && s <= 1 + 1e-9 && t < best) best = t;
  });
  return best;
}
