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
  detail: 'normal', // 'draft' | 'normal' | 'fine' – mesh resolution
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
    // The trunk flares out where it meets the ground.
    if (isTrunk) for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (t < 0.22) radii[i] *= 1 + 0.55 * (1 - t / 0.22) ** 2;
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
    knots.push({ p: pts[n], r: r1 });
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

// ---------------------------------------------------------------------------
// Surface detail

// Smooth 3D gradient noise (Perlin), -1..1, seeded.
function makeNoise(seed) {
  const rand = rng(seed + 7);
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const G = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y, z) => {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    x -= X; y -= Y; z -= Z;
    const xi = X & 255, yi = Y & 255, zi = Z & 255;
    const u = fade(x), v = fade(y), w = fade(z);
    const g = (h, dx, dy, dz) => {
      const q = G[h % 12];
      return q[0] * dx + q[1] * dy + q[2] * dz;
    };
    const a = perm[xi] + yi, aa = perm[a] + zi, ab = perm[a + 1] + zi;
    const b = perm[xi + 1] + yi, ba = perm[b] + zi, bb = perm[b + 1] + zi;
    const l = (t, a1, b1) => a1 + t * (b1 - a1);
    return l(w,
      l(v, l(u, g(perm[aa], x, y, z), g(perm[ba], x - 1, y, z)), l(u, g(perm[ab], x, y - 1, z), g(perm[bb], x - 1, y - 1, z))),
      l(v, l(u, g(perm[aa + 1], x, y, z - 1), g(perm[ba + 1], x - 1, y, z - 1)), l(u, g(perm[ab + 1], x, y - 1, z - 1), g(perm[bb + 1], x - 1, y - 1, z - 1))));
  };
}

// Bark height at a point on a branch, 0 (top of a ridge) .. 1 (deepest
// crack): ridges running along the branch that split and merge, broken by
// short cross cracks – like oak or olive bark.
function barkAt(noise, u, v, w) {
  // u, v: round the branch (mm, as a circle so it wraps); w: along it (mm).
  const ridge = 1 - Math.abs(noise(u * 0.9, v * 0.9, w * 0.18)); // long ridges
  const fine = 1 - Math.abs(noise(u * 2.2 + 17, v * 2.2, w * 0.5));
  const cross = Math.max(0, noise(u * 0.6 + 40, v * 0.6, w * 1.4)) * 0.6; // cross cracks
  const h = 0.62 * ridge * ridge + 0.38 * fine - cross;
  return Math.min(1, Math.max(0, 1 - h));
}

// Catmull-Rom: a smooth curve through the branch's points, sampled about
// every `step` mm, with its radii.
function smoothPath(pts, radii, step) {
  const n = pts.length;
  const out = [], rad = [];
  for (let i = 0; i + 1 < n; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
    const segLen = len(sub(p2, p1));
    const k = Math.max(1, Math.ceil(segLen / step));
    for (let j = 0; j < k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      const c = (a, b, cc, d) => 0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
      out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1]), c(p0[2], p1[2], p2[2], p3[2])]);
      rad.push(radii[i] + (radii[i + 1] - radii[i]) * t);
    }
  }
  out.push(pts[n - 1]);
  rad.push(radii[n - 1]);
  return { pts: out, radii: rad };
}

// Swept tube with bark: rings along the smoothed branch (frames carried along
// so they don't twist), closed at both ends with a rounded tip. Returns
// { vert, tri } – a closed, consistently wound surface.
function tubeMesh(branch, { bark, noise, edge = 0.4, maxSeg = 96 }) {
  const { pts, radii } = smoothPath(branch.pts, branch.radii, edge * 1.3);
  const n = pts.length;
  const seg = Math.max(8, Math.min(maxSeg, Math.round((2 * Math.PI * radii[0]) / edge)));
  const T = pts.map((p, i) => norm(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)])));
  let N = anyPerp(T[0]);
  const vert = [];
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      N = norm(sub(N, mul(T[i], dot(N, T[i])))); // parallel transport
      s += len(sub(pts[i], pts[i - 1]));
    }
    const B = cross(T[i], N);
    const r0 = radii[i];
    // Grooves up to ~0.6 mm deep, less on thin twigs.
    const depth = bark * Math.min(0.9, r0 * 0.3);
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      // Noise on the branch's own surface: round (as a circle of the base
      // radius, so it wraps) and along.
      const r = r0 - (depth > 0 ? depth * barkAt(noise, ca * radii[0], sa * radii[0], s + branch.offset) : 0);
      vert.push(pts[i][0] + (N[0] * ca + B[0] * sa) * r, pts[i][1] + (N[1] * ca + B[1] * sa) * r, pts[i][2] + (N[2] * ca + B[2] * sa) * r);
    }
  }
  const base = vert.length / 3;
  vert.push(...sub(pts[0], mul(T[0], radii[0] * 0.2))); // bottom centre
  // Rounded tip: two shrinking rings, then the point.
  const tipRings = 2;
  for (let q = 1; q <= tipRings; q++) {
    const f = q / (tipRings + 1);
    const c = add(pts[n - 1], mul(T[n - 1], radii[n - 1] * 0.7 * f));
    const rr = radii[n - 1] * Math.cos((f * Math.PI) / 2);
    const Bn = cross(T[n - 1], N);
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      vert.push(...add(c, add(mul(N, Math.cos(a) * rr), mul(Bn, Math.sin(a) * rr))));
    }
  }
  const apex = vert.length / 3;
  vert.push(...add(pts[n - 1], mul(T[n - 1], radii[n - 1] * 0.75)));
  const tri = [];
  const ring = (i) => (i < n ? i * seg : base + 1 + (i - n) * seg);
  for (let i = 0; i + 1 < n + tipRings; i++) {
    const A = ring(i), Bq = ring(i + 1);
    for (let k = 0; k < seg; k++) {
      const a = A + k, b = A + ((k + 1) % seg), c = Bq + ((k + 1) % seg), d = Bq + k;
      tri.push(a, b, c, a, c, d);
    }
  }
  const lastRing = ring(n + tipRings - 1);
  for (let k = 0; k < seg; k++) {
    tri.push(base, (k + 1) % seg, k); // bottom cap
    tri.push(apex, lastRing + k, lastRing + ((k + 1) % seg)); // tip
  }
  return { vert: new Float32Array(vert), tri: new Uint32Array(tri) };
}

// A leaf blade: pointed at both ends, widest a third of the way, thicker
// along the middle vein. Lies along +X, flat in XY, stalk end at the origin.
function leafMesh(length, width, thick, { rows = 10, around = 10 } = {}) {
  const vert = [0, 0, 0];
  for (let i = 1; i < rows; i++) {
    const t = i / rows;
    const w = (width / 2) * Math.sin(Math.PI * Math.pow(t, 0.75)) ** 0.9;
    const h = (thick / 2) * Math.max(0.35, Math.sin(Math.PI * t));
    for (let k = 0; k < around; k++) {
      const a = (k / around) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      // Lens-shaped section, a ridge (the vein) along the top.
      const vein = sa > 0 ? 1 + 0.5 * Math.max(0, 1 - Math.abs(ca) * 4) : 1;
      vert.push(t * length, ca * w, sa * h * vein + Math.abs(ca) * w * 0.12);
    }
  }
  vert.push(length, 0, 0);
  const tri = [];
  const last = 1 + (rows - 2) * around;
  for (let k = 0; k < around; k++) tri.push(0, 1 + ((k + 1) % around), 1 + k);
  for (let i = 0; i < rows - 2; i++) {
    const A = 1 + i * around, B = A + around;
    for (let k = 0; k < around; k++) {
      const a = A + k, b = A + ((k + 1) % around), c = B + ((k + 1) % around), d = B + k;
      tri.push(a, b, c, a, c, d);
    }
  }
  const tip = vert.length / 3 - 1;
  for (let k = 0; k < around; k++) tri.push(tip, last + k, last + ((k + 1) % around));
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
  // Detail: how long the mesh's edges are (mm).
  const edge = { draft: 0.9, normal: 0.45, fine: 0.3 }[o.detail] || 0.45;
  const noise = makeNoise(o.seed);
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
        b.offset = i * 37.3; // each branch its own stretch of bark
        const s = solidOf(tubeMesh(b, { bark, noise, edge: b.radii[0] < 1.5 ? edge * 0.8 : edge }));
        if (s) parts.push(s);
      } catch {
        // a tube that folds over itself is left out
      }
    });
    // Swellings where branches fork.
    const knot = Manifold.sphere(1, 40);
    made.push(knot);
    for (const kn of tree.knots) {
      // Just under the bark, so the fork is filled but no smooth ball shows.
      const s = knot.scale(Math.max(0.3, kn.r - bark * Math.min(0.9, kn.r * 0.3) * 0.9)).translate(kn.p);
      made.push(s);
      parts.push(s);
    }
    // Leaves: small, thick-enough leaf blades in sprays on the twigs.
    if (o.leaves && o.leaves !== 'none') {
      const rand = rng(o.seed + 99);
      const size = +o.leafSize || Math.max(3, tree.H * 0.05);
      const thick = Math.max(0.8, size * 0.08);
      const perTip = o.leaves === 'crown' ? 9 : 6;
      const leaf = solidOf(leafMesh(1, 0.4, thick / size, { rows: o.detail === 'draft' ? 6 : o.detail === 'fine' ? 12 : 8, around: o.detail === 'draft' ? 6 : o.detail === 'fine' ? 10 : 8 }));
      if (!leaf) throw new Error('leaf');
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
            // Its stalk end sits in the twig.
            const centre = add(at, mul(out, -Math.min(0.6, s * 0.08)));
            const x = out;
            let z = norm(cross(out, across));
            if (z[2] < 0) z = mul(z, -1);
            const y = cross(z, x);
            const mat = [...mul(x, s), 0, ...mul(y, s), 0, ...mul(z, s), 0, ...centre, 1];
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
