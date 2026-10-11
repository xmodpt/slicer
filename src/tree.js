// Tree generator: grows a printable tree – trunk(s) that fork into tapering,
// bending branches (thinner each level, as real trees do), flared roots on
// the ground, bark grooves, and optional leaf clusters on the twigs. Each
// branch is one swept tube with bark; manifold-3d joins them all into one
// closed solid, with a flat bottom for the print bed.
//
// Everything is in mm. The same settings and seed always give the same tree.

export const TREE_DEFAULTS = {
  height: 120, // mm, about – the crown may reach a bit higher or lower
  trunks: 1, // trunks from the ground (2–3 for a clump like a multi-stem tree)
  levels: 5, // how many times branches split
  branching: 2, // side branches per branch (besides the fork at its end)
  spread: 38, // degrees between a branch and its parent
  gnarl: 0.35, // 0 = straight, 1 = twisted and crooked
  lean: 0, // degrees the trunk leans
  thickness: 1, // ×: trunk thickness compared with a normal tree
  roots: 5, // roots spreading on the ground
  bark: 0.6, // 0 = smooth, 1 = deep grooves
  leaves: 'none', // 'none' | 'clusters' (leaf sprays on the twigs) | 'crown' (dense)
  leafSize: 0, // mm, 0 = automatic
  minTwig: 0.9, // mm, thinnest twig radius (printable)
  seed: 1,
};

function rng(seed) {
  let a = (Math.floor(seed) * 2654435761) >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const anyPerp = (d) => norm(cross(d, Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
// Rotate v around unit axis k by angle a (Rodrigues).
const rotate = (v, k, a) => {
  const c = Math.cos(a), s = Math.sin(a);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
};

// The tree's skeleton: branches as polylines with radii, plus twig tips.
export function growTree(options = {}) {
  const o = { ...TREE_DEFAULTS, ...options };
  const H = Math.max(10, +o.height || 120);
  const rand = rng(o.seed);
  const gnarl = Math.min(1.5, Math.max(0, +o.gnarl));
  const minR = Math.max(0.3, +o.minTwig || 0.9);
  const branches = [];
  const tips = [];
  const knots = [];
  const MAX = 4000;

  // A branch grows from p in direction d; then side branches and a fork.
  const grow = (p, d, length, r0, level, isTrunk) => {
    if (branches.length >= MAX) return;
    const r1 = Math.max(minR, r0 * (isTrunk ? 0.78 : 0.75));
    const step = Math.max(r0 * 1.1, length / 14, 0.8);
    const n = Math.max(2, Math.round(length / step));
    const pts = [[...p]], radii = [r0];
    let dir = d;
    let wander = anyPerp(d);
    for (let i = 1; i <= n; i++) {
      // Crooked growth: turn a little, mostly the same way for a while.
      wander = norm(add(mul(wander, 0.7), mul([rand() - 0.5, rand() - 0.5, rand() - 0.5], 1.2)));
      const turn = gnarl * (isTrunk ? 0.18 : 0.3);
      dir = norm(add(add(dir, mul(wander, turn)), [0, 0, isTrunk ? 0.12 : 0.07 - level * 0.012]));
      pts.push(add(pts[i - 1], mul(dir, length / n)));
      radii.push(r0 + (r1 - r0) * (i / n));
    }
    branches.push({ pts, radii, level });
    if (level >= o.levels || r1 <= minR * 1.05) {
      // Twigs end in a point, not a stub.
      radii[n] = Math.max(minR * 0.6, r1 * 0.6);
      tips.push({ p: pts[n], d: dir, level, pts, r: radii });
      return;
    }
    // Side branches along the upper part, spiralling round (golden angle).
    const k = Math.max(0, Math.round(o.branching + (rand() - 0.5)));
    let az = rand() * Math.PI * 2;
    for (let j = 0; j < k; j++) {
      const t = (isTrunk ? 0.55 : 0.35) + (isTrunk ? 0.4 : 0.55) * ((j + rand() * 0.8) / Math.max(1, k));
      const i = Math.min(n - 1, Math.max(1, Math.round(t * n)));
      const at = pts[i];
      const pd = norm(sub(pts[i + 1], pts[i - 1]));
      az += 2.39996 + (rand() - 0.5) * 0.6;
      const side = rotate(anyPerp(pd), pd, az);
      const ang = ((o.spread * (0.8 + rand() * 0.5)) * Math.PI) / 180;
      const cd = norm(add(mul(pd, Math.cos(ang)), mul(side, Math.sin(ang))));
      const cr = Math.max(minR, radii[i] * (0.55 + rand() * 0.15));
      grow(at, cd, length * (0.55 + rand() * 0.2) * (1 - t * 0.35), cr, level + 1, false);
    }
    // The fork at the end: two (sometimes three) branches carry on, from a
    // smooth swelling (no steps where they meet).
    knots.push({ p: pts[n], r: r1 * 1.05 });
    const forks = rand() < 0.25 ? 3 : 2;
    const fd = dir;
    const base = anyPerp(fd);
    const az0 = rand() * Math.PI * 2;
    for (let j = 0; j < forks; j++) {
      const side = rotate(base, fd, az0 + (j * Math.PI * 2) / forks + (rand() - 0.5) * 0.5);
      const ang = ((o.spread * (0.45 + rand() * 0.45)) * Math.PI) / 180;
      const cd = norm(add(mul(fd, Math.cos(ang)), mul(side, Math.sin(ang))));
      // Da Vinci: the children's cross-sections add up to the parent's.
      const cr = Math.max(minR, r1 * (j === 0 ? 0.95 : forks === 2 ? 0.8 : 0.7) * (0.92 + rand() * 0.12));
      grow(pts[n], cd, length * (0.68 + rand() * 0.18), cr, level + 1, false);
    }
  };

  const trunks = Math.max(1, Math.min(5, Math.round(o.trunks)));
  const trunkR = H * 0.045 * Math.max(0.3, +o.thickness || 1) / Math.sqrt(trunks);
  // The trunk takes ~40 % of the height; the levels above add the rest.
  let sum = 0;
  for (let l = 0, f = 1; l <= o.levels; l++, f *= 0.78) sum += f * (l === 0 ? 1 : 0.75);
  const trunkLen = (H * 0.92) / sum;
  const lean = ((+o.lean || 0) * Math.PI) / 180;
  const leanAz = rand() * Math.PI * 2;
  for (let t = 0; t < trunks; t++) {
    const az = leanAz + (t * Math.PI * 2) / trunks;
    const out = trunks > 1 ? 0.22 : 0;
    const d = norm([Math.cos(az) * (Math.sin(lean) + out), Math.sin(az) * (Math.sin(lean) + out), 1]);
    const p = trunks > 1 ? [Math.cos(az) * trunkR * 0.9, Math.sin(az) * trunkR * 0.9, 0] : [0, 0, 0];
    grow([p[0], p[1], -trunkR * 0.5], d, trunkLen * (1 + (rand() - 0.5) * 0.15), trunkR, 0, true);
  }

  // Stretch (or squeeze) the branches to the asked height; thicknesses stay.
  let top = 0;
  for (const b of branches) for (const p of b.pts) top = Math.max(top, p[2]);
  const k = top > 0 ? H / top : 1;
  for (const b of branches) for (const p of b.pts) (p[0] *= k), (p[1] *= k), (p[2] *= k);
  for (const kn of knots) kn.p = [kn.p[0], kn.p[1], kn.p[2]]; // (already scaled with its branch)

  // Roots: from inside the trunk, out and down onto the ground.
  const roots = [];
  const nr = Math.max(0, Math.min(12, Math.round(o.roots)));
  for (let i = 0; i < nr; i++) {
    const az = (i / nr) * Math.PI * 2 + (rand() - 0.5) * 0.5;
    const out = [Math.cos(az), Math.sin(az), 0];
    const reach = trunkR * (3 + rand() * 2.5) * Math.sqrt(trunks);
    const r0 = trunkR * (0.45 + rand() * 0.15);
    const pts = [], radii = [];
    const n = 8;
    for (let j = 0; j <= n; j++) {
      const t = j / n;
      const wob = (rand() - 0.5) * gnarl * trunkR * 0.6 * t;
      const p = add(mul(out, trunkR * 0.3 + reach * t), mul([-out[1], out[0], 0], wob));
      const r = Math.max(minR, r0 * (1 - t * 0.85));
      // Rise into the trunk at the start, hug the ground (half buried) after.
      p[2] = trunkR * 1.4 * (1 - t) ** 2 + r * 0.15 - r * 0.5;
      pts.push(p);
      radii.push(r);
    }
    roots.push({ pts, radii, level: 0 });
  }
  return { branches, roots, tips, knots, trunkR, options: o, H };
}

// Swept tube with bark: rings along the polyline (frames carried along so
// they don't twist), closed at both ends. Returns { vert: Float32Array,
// tri: Uint32Array } – a closed, consistently wound surface.
function tubeMesh({ pts, radii }, { bark, seed, minSeg = 6, maxSeg = 22, edge = 1.2 }) {
  const n = pts.length;
  const seg = Math.max(minSeg, Math.min(maxSeg, Math.round((2 * Math.PI * radii[0]) / edge)));
  const T = pts.map((p, i) => norm(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)])));
  let N = anyPerp(T[0]);
  const vert = [];
  const phase = [seed * 1.7, seed * 3.1, seed * 5.3];
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      // Parallel transport of the normal.
      N = norm(sub(N, mul(T[i], dot(N, T[i]))));
      s += len(sub(pts[i], pts[i - 1]));
    }
    const B = cross(T[i], N);
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      // Bark: grooves running along the branch, wandering slowly.
      const w = s / Math.max(1, radii[0] * 6);
      const g = Math.sin(5 * a + phase[0] + w) * 0.5 + Math.sin(9 * a + phase[1] - w * 1.3) * 0.3 + Math.sin(14 * a + phase[2] + w * 0.7) * 0.2;
      const r = radii[i] * (1 + bark * 0.2 * g);
      const off = add(mul(N, Math.cos(a) * r), mul(B, Math.sin(a) * r));
      vert.push(...add(pts[i], off));
    }
  }
  const base = vert.length / 3;
  vert.push(...sub(pts[0], mul(T[0], radii[0] * 0.2))); // bottom centre
  vert.push(...add(pts[n - 1], mul(T[n - 1], radii[n - 1] * 0.8))); // rounded tip
  const tri = [];
  for (let i = 0; i + 1 < n; i++) {
    for (let k = 0; k < seg; k++) {
      const a = i * seg + k, b = i * seg + ((k + 1) % seg), c = (i + 1) * seg + ((k + 1) % seg), d = (i + 1) * seg + k;
      tri.push(a, b, c, a, c, d);
    }
  }
  for (let k = 0; k < seg; k++) {
    tri.push(base, (k + 1) % seg, k); // bottom cap
    const last = (n - 1) * seg;
    tri.push(base + 1, last + k, last + ((k + 1) % seg)); // tip
  }
  return { vert: new Float32Array(vert), tri: new Uint32Array(tri) };
}

// The tree as a manifold-3d solid.
export function buildTree(wasm, options = {}) {
  const { Manifold, Mesh } = wasm;
  const tree = growTree(options);
  const o = tree.options;
  const bark = Math.max(0, Math.min(1.5, +o.bark));
  const parts = [];
  const made = [];
  const solidOf = (mesh) => {
    const m = new Mesh({ numProp: 3, vertProperties: mesh.vert, triVerts: mesh.tri });
    m.merge();
    const solid = new Manifold(m);
    made.push(solid);
    // An inside-out tube (seen from the wrong end) has negative volume.
    if (solid.volume() < 0) return null;
    return solid;
  };
  try {
    const all = [...tree.roots, ...tree.branches];
    all.forEach((b, i) => {
      try {
        const s = solidOf(tubeMesh(b, { bark: b.level > 3 ? bark * 0.4 : bark, seed: i + o.seed, edge: Math.max(0.6, tree.trunkR / 4) }));
        if (s) parts.push(s);
      } catch {
        // a tube that folds over itself is left out
      }
    });
    // Swellings where branches fork.
    const knot = Manifold.sphere(1, 16);
    made.push(knot);
    for (const kn of tree.knots) {
      const s = knot.scale(kn.r).translate(kn.p);
      made.push(s);
      parts.push(s);
    }
    // Leaves: small, thick-enough leaf blades in sprays on the twigs.
    if (o.leaves && o.leaves !== 'none') {
      const rand = rng(o.seed + 99);
      const size = +o.leafSize || Math.max(3, tree.H * 0.05);
      const thick = Math.max(0.8, size * 0.08);
      const perTip = o.leaves === 'crown' ? 9 : 6;
      const leaf = Manifold.sphere(1, 10);
      made.push(leaf);
      const tips = tree.tips.slice(0, 700);
      for (const tip of tips) {
        // A spray: pairs of leaves along the last part of the twig, angled
        // forwards, the last one at the tip – like a fern or an acacia.
        const pts = tip.pts, n = pts.length - 1;
        const pairs = o.leaves === 'crown' ? 5 : 4;
        const up = [0, 0, 1];
        for (let j = 0; j <= pairs; j++) {
          const t = 0.35 + 0.65 * (j / pairs);
          const fi = t * n, i0 = Math.min(n - 1, Math.floor(fi));
          const at = add(pts[i0], mul(sub(pts[i0 + 1], pts[i0]), fi - i0));
          const d = norm(sub(pts[i0 + 1], pts[i0]));
          // "Flat" side of the spray: across the twig, as level as it gets.
          let across = cross(d, up);
          if (len(across) < 0.2) across = anyPerp(d);
          across = norm(across);
          const sides = j === pairs ? [0] : [1, -1];
          for (const side of sides) {
            const s = size * (0.8 + rand() * 0.35) * (j === pairs ? 1.1 : 1);
            const ang = side === 0 ? 0 : (55 + rand() * 15) * (Math.PI / 180);
            const out = norm(add(mul(d, Math.cos(ang)), mul(across, side * Math.sin(ang))));
            // Its stalk end touches the twig.
            const centre = add(at, mul(out, s * 0.42));
            const x = out;
            let z = norm(cross(out, across));
            if (z[2] < 0) z = mul(z, -1);
            const y = cross(z, x);
            const mat = [...mul(x, s * 0.5), 0, ...mul(y, s * 0.2), 0, ...mul(z, thick / 2), 0, ...centre, 1];
            const blade = leaf.transform(mat);
            made.push(blade);
            parts.push(blade);
          }
        }
      }
    }
    if (!parts.length) throw new Error('The tree came out empty.');
    const whole = Manifold.union(parts);
    made.push(whole);
    // Flat bottom on the plate.
    const { min, max } = whole.boundingBox();
    const floor = Manifold.cube([max[0] - min[0] + 20, max[1] - min[1] + 20, max[2] + 10]).translate([min[0] - 10, min[1] - 10, 0]);
    made.push(floor);
    const cut = whole.intersect(floor);
    made.push(cut);
    // One piece: crumbs (a leaf that only grazes its twig, slivers) are left out.
    const pieces = cut.decompose();
    let best = null;
    for (const p of pieces) if (!best || p.volume() > best.volume()) best = p;
    for (const p of pieces) if (p !== best) p.delete();
    return best;
  } finally {
    for (const m of made) m.delete?.();
  }
}
