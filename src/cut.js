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
//   manual: connector positions picked by the user (3D points on the plane)
//     instead of automatic ones; each gets a verdict in result.manual

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
  // Inside-out models (triangles facing inwards) get caps and connectors wound
  // the same way, so the result stays consistent.
  const flip = signedVolume(mesh) < 0;
  const before = mesh.snapshot();

  mesh.cutByPlane(n, c);
  const { min: bmin, max: bmax } = mesh.bounds();
  const onPlane = Math.hypot(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]) * 1.5e-6; // matches cutByPlane's snapping
  // After the cut every triangle lies on one side: decide by its corners
  // (thin slivers along the plane must not end up on the wrong side).
  // Triangles lying in the plane go with the solid behind them.
  const upper = new Uint8Array(mesh.triangleCount);
  {
    const P = mesh.positions, ind = mesh.indices, normals = mesh.faceNormals();
    for (let t = 0; t < upper.length; t++) {
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = ind[t * 3 + k] * 3;
        const d = n[0] * P[v] + n[1] * P[v + 1] + n[2] * P[v + 2] + c;
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
      if (hi > onPlane) upper[t] = 1;
      else if (lo < -onPlane) upper[t] = 0;
      else upper[t] = n[0] * normals[t * 3] + n[1] * normals[t * 3 + 1] + n[2] * normals[t * 3 + 2] < 0 ? 1 : 0;
    }
  }
  let count = 0;
  for (const v of upper) count += v;
  if (!count || count === upper.length) {
    mesh.restore(before);
    throw new Error('The plane does not cut through the model – move it so it crosses the model.');
  }

  // Plane frame: U x V = n; origin on the plane.
  const U = norm(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
  const V = cross(n, U);
  const O = [-c * n[0], -c * n[1], -c * n[2]];
  const { min, max } = mesh.bounds();
  const size = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const eps = size * 1e-5; // general size tolerance

  // The cut outline, read from the slice itself rather than from how the
  // mesh's triangles are connected – so models with double faces, gaps or
  // overlapping pieces still give proper outlines. Every edge of the lower
  // half lying on the plane (with the rest of its triangle below) is part of
  // the outline; edges found in both directions cancel out (double faces).
  const P = mesh.positions, ind = mesh.indices;
  const dist = (v) => n[0] * P[v * 3] + n[1] * P[v * 3 + 1] + n[2] * P[v * 3 + 2] + c;
  // Points are matched by exact position: the cut edges share their end
  // points exactly, while different points can be very close on dense models.
  const key = (v) => P[v * 3] + ',' + P[v * 3 + 1] + ',' + P[v * 3 + 2];
  const point = new Map(); // key -> { uv, p3 }
  const edges = new Map(); // "a>b" -> [a, b]
  for (let t = 0; t < mesh.triangleCount; t++) {
    if (upper[t]) continue;
    const tv = [ind[t * 3], ind[t * 3 + 1], ind[t * 3 + 2]];
    const d = tv.map(dist);
    for (let k = 0; k < 3; k++) {
      const i = k, j = (k + 1) % 3, o = (k + 2) % 3;
      if (Math.abs(d[i]) > onPlane || Math.abs(d[j]) > onPlane || d[o] > -onPlane) continue;
      const a = key(tv[i]), b = key(tv[j]);
      if (a === b) continue;
      for (const [kk, v] of [[a, tv[i]], [b, tv[j]]]) {
        if (point.has(kk)) continue;
        const p3 = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
        const rel = sub(p3, O);
        point.set(kk, { uv: [dot(rel, U), dot(rel, V)], p3 });
      }
      // The cap runs against the triangle's edge. The same edge from a face
      // turned the other way (a double-sided sheet, an inner face) cancels it;
      // the same edge twice (a duplicated face) counts once.
      if (edges.has(a + '>' + b)) edges.delete(a + '>' + b);
      else edges.set(b + '>' + a, [b, a]);
    }
  }
  const { loops, openChains } = chainLoops([...edges.values()], point, size);
  const rings = loops
    .map((keys) => {
      const pts = keys.map((k) => point.get(k).uv);
      return { pts, p3: keys.map((k) => point.get(k).p3), area: Math.abs(polygonArea(pts)) };
    })
    .filter((r) => r.area > (eps * 100) ** 2);
  // Outlines vs. inner openings by nesting: a ring inside an odd number of
  // others is an opening.
  const depth = rings.map((r) => rings.filter((o) => o !== r && o.area > r.area && pointInPolygon(r.pts[0], o.pts)).length);
  const areas = rings.filter((_, i) => depth[i] % 2 === 0).map((r) => ({ ...r, holes: [] }));
  rings.forEach((r, i) => {
    if (depth[i] % 2 === 0) return;
    const home = areas.filter((o) => o.area > r.area && pointInPolygon(r.pts[0], o.pts)).sort((a, b) => a.area - b.area)[0];
    if (home) home.holes.push(r);
  });
  areas.sort((a, b) => b.area - a.area);
  // Loose ends inside a cut area are inner faces of the model, not gaps.
  const open = openChains.filter((keys) => {
    const a = point.get(keys[0]).uv, b = point.get(keys[1] || keys[0]).uv;
    return !areas.some((ar) => inArea([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], ar));
  }).length;

  return { n, c, U, V, O, upper, areas, size, eps, flip, open };
}

// Joins outline edges [from, to] (point keys) into closed loops. At a point
// with several ways on, the sharpest right turn keeps loops small and simple.
// Ends that don't meet are joined when close, otherwise counted as `open`.
function chainLoops(list, point, size) {
  const out = new Map();
  for (const e of list) {
    if (!out.has(e[0])) out.set(e[0], []);
    out.get(e[0]).push(e);
  }
  const used = new Set();
  const loops = [];
  const openChains = [];
  const angle = (a, b) => {
    const pa = point.get(a).uv, pb = point.get(b).uv;
    return Math.atan2(pb[1] - pa[1], pb[0] - pa[0]);
  };
  for (const first of list) {
    if (used.has(first)) continue;
    used.add(first);
    const keys = [first[0]];
    let cur = first;
    for (let guard = 0; guard < list.length + 1; guard++) {
      if (cur[1] === keys[0]) break;
      keys.push(cur[1]);
      const options = (out.get(cur[1]) || []).filter((e) => !used.has(e));
      if (!options.length) {
        cur = null;
        break;
      }
      const inAngle = angle(cur[0], cur[1]);
      const turn = (e) => {
        let t = angle(e[0], e[1]) - inAngle;
        while (t <= -Math.PI) t += 2 * Math.PI;
        while (t > Math.PI) t -= 2 * Math.PI;
        return t;
      };
      cur = options.sort((a, b) => turn(a) - turn(b))[0];
      used.add(cur);
    }
    if (cur === null) {
      // Not closed: join the ends if they are close (a small gap in the model).
      const a = point.get(keys[0]).uv, b = point.get(keys[keys.length - 1]).uv;
      if (keys.length > 2 && Math.hypot(a[0] - b[0], a[1] - b[1]) < size * 0.01) loops.push(keys);
      else openChains.push(keys);
      continue;
    }
    if (keys.length > 2) loops.push(keys);
  }
  return { loops, openChains };
}

// Chooses connectors for each cut area.
function plan(mesh, ctx, opts) {
  const { type = 'auto', pins = 'auto', diameter = 0, length = 0, tolerance = 0.5 } = opts;
  const tol = 1 + tolerance / 100;
  const lowerMask = ctx.upper.map((v) => (v ? 0 : 1));
  const result = { areas: [], pins: [], notes: [], dowelFaces: null };
  // Manually placed connectors, in plane coordinates, each with a verdict.
  const manual = opts.manual
    ? opts.manual.map((p) => {
        const rel = sub(p, ctx.O);
        return { point: p, uv: [dot(rel, ctx.U), dot(rel, ctx.V)], ok: false, reason: 'Not on the cut face – place it inside the cut area.' };
      })
    : null;
  if (manual) result.manual = manual;
  // The cut outlines (3D loops), to draw on the plane.
  result.outlines = ctx.areas.flatMap((a) => [a.p3, ...a.holes.map((h) => h.p3)]);

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
    // Spots where another piece overlaps this one: a hole there would be
    // blocked by the other piece, so no connectors.
    const others = ctx.areas.filter((o) => o !== area);
    const candidates = findCandidates(area, edges).filter((q) => !others.some((o) => inArea(q.q, o)));
    const R = candidates.length ? Math.max(...candidates.map((q) => q.d)) : 0; // half the thickest spot
    info.thickness = 2 * R;
    const long = Math.max(w, h);
    // Automatic size: half the thickness, but in proportion to the area –
    // Ø10 mm at most on ordinary prints, growing with big models (about 6 %
    // of the area's length) – rounded to a tidy size.
    const autoR = Math.max(0.75, Math.min(R * 0.5, Math.max(5, long * 0.03)));
    const r = diameter > 0 ? diameter / 2 : autoR > 10 ? Math.floor(autoR) : Math.floor(autoR * 4) / 4;
    const wall = Math.max(0.6, r * 0.3);
    const need = r * tol + wall;
    const fits = candidates.filter((q) => q.d >= need);
    let centers, picked = [];
    if (manual) {
      // The user's spots on this area: each must keep a wall around its hole
      // and stay clear of the other connectors.
      centers = [];
      for (const m of manual) {
        if (m.area !== undefined || !inArea(m.uv, area)) continue;
        m.area = index;
        m.size = { r, h: 2 * r };
        const d = distanceToEdges(m.uv, edges);
        if (others.some((o) => inArea(m.uv, o))) m.reason = 'Another piece of the model overlaps here – the hole would be blocked.';
        else if (d < need)
          m.reason = `Too close to the edge: ${Math.max(0, d - r * tol).toFixed(1)} mm of wall left, ${wall.toFixed(1)} mm needed – move it inwards or use a smaller Ø.`;
        else if (centers.some((c) => Math.hypot(c[0] - m.uv[0], c[1] - m.uv[1]) < 2 * need)) m.reason = 'Too close to another connector – space them further apart.';
        else {
          centers.push(m.uv);
          picked.push(m);
        }
      }
      if (!manual.some((m) => m.area === index)) info.notes.push('No connector placed on this area.');
    } else if (!fits.length) {
      info.notes.push(
        R < 0.75 * tol + 0.6
          ? `Too thin for connectors (thickest spot ${(2 * R).toFixed(1)} mm) – glue only.`
          : `A Ø${(2 * r).toFixed(1)} connector needs ${(2 * need).toFixed(1)} mm of solid material; the thickest spot is ${(2 * R).toFixed(1)} mm. Use a smaller Ø or Auto.`,
      );
      return;
    }

    if (!manual) {
      // Automatic count: about one connector per (10 Ø/2)² of solid area –
      // long strips get several along their length, big faces a spread of
      // them – but no more than 8.
      const byArea = solidArea / (10 * r) ** 2;
      const want = pins === 'auto' ? Math.max(1, Math.min(8, Math.round(Math.max(byArea, long > 12 * r ? 2 : 1, long > 30 * r ? 3 : 1)))) : Number(pins);
      centers = choosePoints(fits, want, 2 * need);
      if (centers.length < want) info.notes.push(`Room for ${centers.length} of ${want} connectors.`);
    }

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
        const msg = `Not enough material in the ${thinSide} half for a connector there.`;
        const flipHint = kind === 'pin' && downRoom > upRoom + r ? 'Flip puts the pins on the other half – it has more room.' : '';
        if (picked[i]) picked[i].reason = `${msg} ${flipHint}`.trim();
        else {
          info.notes.push(msg);
          if (flipHint) info.notes.push(flipHint);
        }
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
      if (picked[i]) Object.assign(picked[i], { ok: true, reason: `Fits – ${kind} Ø${(2 * r).toFixed(1)} × ${(kind === 'dowel' ? 2 * h : h).toFixed(1)} mm.` });
      result.pins.push({ kind, diameter: 2 * r, length: kind === 'dowel' ? 2 * h : h, holeDiameter: 2 * r * tol, holeDepth: conn.holeDepth });
    });
  });

  if (manual && (type === 'none' || pins === '0' || pins === 0)) for (const m of manual) m.reason = 'Connector type is “None” – choose Pin or Dowels.';
  if (manual && opts.manual.length === 0) result.notes.push('Click on the cut face to place connectors.');
  // Overall advice.
  if (ctx.open) result.notes.push(`The model has ${ctx.open} gap(s) along the cut that could not be closed – those spots stay open (try Close holes after cutting).`);
  const kinds = new Set(result.pins.map((p) => p.kind));
  if (!result.pins.length && type !== 'none') result.notes.push('No connectors fit this cut – try another position, a smaller Ø, or glue the halves.');
  if (kinds.has('pin')) result.notes.push('Print the half with pins standing on its base so the pins point up.');
  if (kinds.has('dowel')) result.notes.push('The dowels lie on the plate beside the model as one group (“Dowels”) – print them lying down for strength.');
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
  const { n, U, V, O, flip, upper } = ctx;
  // Triangles are collected per piece and joined into meshes by position at
  // the end, so the caps attach to the cut edges whatever the model's
  // original connections were.
  const soups = { lower: [], upper: [], dowel: [] };
  const P = mesh.positions, ind = mesh.indices;
  for (let t = 0; t < mesh.triangleCount; t++) {
    const s = soups[upper[t] ? 'upper' : 'lower'];
    for (let k = 0; k < 3; k++) {
      const v = ind[t * 3 + k] * 3;
      s.push(P[v], P[v + 1], P[v + 2]);
    }
  }
  const at = (u, v, w) => [0, 1, 2].map((i) => O[i] + u * U[i] + v * V[i] + w * n[i]);
  // Adds a triangle (3D points) wound so its normal points along `want`.
  const tri = (soup, a, b, c, want) => {
    const nrm = cross(sub(b, a), sub(c, a));
    if (dot(nrm, want) * (flip ? -1 : 1) < 0) soup.push(...a, ...c, ...b);
    else soup.push(...a, ...b, ...c);
  };
  const down = [-n[0], -n[1], -n[2]];
  const radial = (k) => {
    const a = (2 * Math.PI * (k + 0.5)) / segments;
    return norm([0, 1, 2].map((i) => U[i] * Math.cos(a) + V[i] * Math.sin(a)));
  };
  const circle = (center, r) => {
    const uv = [];
    for (let k = 0; k < segments; k++) {
      const a = (2 * Math.PI * k) / segments;
      uv.push([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]);
    }
    return uv;
  };
  const ringAt = (center, r, w) => circle(center, r).map(([u, v]) => at(u, v, w));
  // A blind hole from the cap ring `top` (w = 0) to depth `d` along `side`
  // (+1 into the upper half, -1 into the lower one).
  const hole = (soup, conn, top, d, side) => {
    const bottom = ringAt(conn.center, conn.holeR, side * d);
    const centre = at(conn.center[0], conn.center[1], side * d);
    const floorFacing = side > 0 ? down : n;
    for (let k = 0; k < segments; k++) {
      const k1 = (k + 1) % segments, inward = radial(k).map((x) => -x);
      tri(soup, top[k], top[k1], bottom[k1], inward);
      tri(soup, top[k], bottom[k1], bottom[k], inward);
      tri(soup, bottom[k], bottom[k1], centre, floorFacing);
    }
  };

  for (const area of ctx.areas) {
    const conns = area.plan.connectors;
    for (const side of ['lower', 'upper']) {
      const radii = conns.map((c) => (side === 'lower' && c.kind === 'pin' ? c.r : c.holeR));
      const circles = conns.map((c, i) => circle(c.center, radii[i]));
      const rings3 = circles.map((uvs) => uvs.map(([u, v]) => at(u, v, 0)));
      const contour = area.pts.map(([x, y]) => new Vector2(x, y));
      const holes = [...area.holes.map((h) => h.pts.map(([x, y]) => new Vector2(x, y))), ...circles.map((uvs) => uvs.map(([x, y]) => new Vector2(x, y)))];
      const pts3 = [...area.p3, ...area.holes.flatMap((h) => h.p3), ...rings3.flat()];
      for (const [a, b, c] of ShapeUtils.triangulateShape(contour, holes)) tri(soups[side], pts3[a], pts3[b], pts3[c], side === 'lower' ? n : down);
      conns.forEach((c, i) => (c[side + 'Ring'] = rings3[i]));
    }

    for (const c of conns) {
      hole(soups.upper, c, c.upperRing, c.holeDepth, 1);
      if (c.kind === 'dowel') {
        hole(soups.lower, c, c.lowerRing, c.holeDepth, -1);
        continue;
      }
      // Pin on the lower half: straight wall, small chamfer, flat top.
      const ch = Math.min(c.r * 0.25, c.h * 0.2);
      const r0 = c.lowerRing;
      const r1 = ringAt(c.center, c.r, c.h - ch);
      const r2 = ringAt(c.center, c.r - ch, c.h);
      const top = at(c.center[0], c.center[1], c.h);
      for (let k = 0; k < segments; k++) {
        const k1 = (k + 1) % segments, out = radial(k);
        tri(soups.lower, r0[k], r0[k1], r1[k1], out);
        tri(soups.lower, r0[k], r1[k1], r1[k], out);
        const slope = norm([out[0] + n[0], out[1] + n[1], out[2] + n[2]]);
        tri(soups.lower, r1[k], r1[k1], r2[k1], slope);
        tri(soups.lower, r1[k], r2[k1], r2[k], slope);
        tri(soups.lower, r2[k], r2[k1], top, n);
      }
    }
  }

  // Dowels: separate chamfered cylinders lying on the plate beside the model.
  const dowels = ctx.areas.flatMap((a) => a.plan.connectors).filter((c) => c.kind === 'dowel');
  if (dowels.length) {
    // On the plate (the model's bottom) right beside the model, in rows along
    // Y that start at the model's front; a new column when a row would run
    // past the model's back.
    const { min, max } = mesh.bounds();
    const gap = 3;
    let x = max[0] + 5, y = min[1], colWidth = 0;
    for (const d of dowels) {
      const len = 2 * d.h;
      const ch = Math.min(d.r * 0.25, len * 0.1);
      if (y > min[1] && y + 2 * d.r > Math.max(max[1], min[1] + 4 * d.r + gap)) {
        x += colWidth + gap;
        y = min[1];
        colWidth = 0;
      }
      colWidth = Math.max(colWidth, len);
      const x0 = x, z = min[2] + d.r; // axis along X, resting on the plate
      const ring = (x, r) => {
        const pts = [];
        for (let k = 0; k < segments; k++) {
          const a = (2 * Math.PI * k) / segments;
          pts.push([x, y + d.r + r * Math.cos(a), z + r * Math.sin(a)]);
        }
        return pts;
      };
      const rings = [ring(x0, d.r - ch), ring(x0 + ch, d.r), ring(x0 + len - ch, d.r), ring(x0 + len, d.r - ch)];
      const ends = [[x0, y + d.r, z], [x0 + len, y + d.r, z]];
      for (let k = 0; k < segments; k++) {
        const k1 = (k + 1) % segments;
        const a = (2 * Math.PI * (k + 0.5)) / segments;
        const out = [0, Math.cos(a), Math.sin(a)];
        for (let s = 0; s < 3; s++) {
          const want = s === 0 ? [-1, out[1], out[2]] : s === 2 ? [1, out[1], out[2]] : out;
          tri(soups.dowel, rings[s][k], rings[s][k1], rings[s + 1][k1], want);
          tri(soups.dowel, rings[s][k], rings[s + 1][k1], rings[s + 1][k], want);
        }
        tri(soups.dowel, rings[0][k], rings[0][k1], ends[0], [-1, 0, 0]);
        tri(soups.dowel, rings[3][k], rings[3][k1], ends[1], [1, 0, 0]);
      }
      y += 2 * d.r + gap;
    }
  }

  // Join each piece's triangles by position (caps meet the cut edges exactly,
  // the halves stay separate), then put them together.
  const pieces = ['lower', 'upper', 'dowel'].map((k) => (soups[k].length ? EditableMesh.fromSoup(new Float32Array(soups[k]), { tolerance: ctx.size * 1e-9 }) : null));
  let vTotal = 0, iTotal = 0;
  for (const m of pieces) if (m) (vTotal += m.positions.length), (iTotal += m.indices.length);
  const positions = new Float32Array(vTotal);
  const indices = new Uint32Array(iTotal);
  let vo = 0, io = 0;
  pieces.forEach((m, i) => {
    if (!m) return;
    if (i === 2) result.dowelFaces = [io / 3, (io + m.indices.length) / 3];
    positions.set(m.positions, vo);
    for (let k = 0; k < m.indices.length; k++) indices[io + k] = m.indices[k] + vo / 3;
    vo += m.positions.length;
    io += m.indices.length;
  });
  mesh._set(positions, indices);
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

function inArea(q, area) {
  return pointInPolygon(q, area.pts) && !area.holes.some((h) => pointInPolygon(q, h.pts));
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
