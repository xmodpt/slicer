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
  minTwig: 0.7, // mm, thinnest twig radius (printable)
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
  const minR = Math.max(0.3, +o.minTwig || 0.7);
  const MAXN = 3000;

  // The skeleton is a graph of nodes; a branch is a few nearly straight
  // pieces between nodes, with a small kink at each – as wood grows.
  const nodes = [];
  const node = (p, parent, dir, level, trunk) => {
    const n = { p, parent, kids: [], dir, level, trunk };
    nodes.push(n);
    if (parent) parent.kids.push(n);
    return n;
  };

  const grow = (from, d, L, level, isTrunk) => {
    if (nodes.length > MAXN) return;
    const segs = isTrunk ? 4 + Math.floor(rand() * 2) : 2 + Math.floor(rand() * 3);
    let dir = d, prev = from;
    const along = [];
    for (let i = 0; i < segs; i++) {
      // A kink: turn a little about a random axis, and towards the light.
      const kink = gnarl * (isTrunk ? 0.22 : 0.45) * (0.35 + rand() * 0.65);
      dir = norm(rotate(dir, rotate(anyPerp(dir), dir, rand() * Math.PI * 2), kink));
      dir = norm(add(dir, [0, 0, isTrunk ? 0.18 : 0.1 - level * 0.015]));
      const n = node(add(prev.p, mul(dir, (L / segs) * (0.8 + rand() * 0.4))), prev, dir, level, isTrunk);
      along.push(n);
      prev = n;
    }
    if (level >= o.levels) return;
    // Side branches from the nodes along the way, spiralling round (golden
    // angle); none low on the trunk.
    const from0 = isTrunk ? Math.max(1, Math.floor(segs * 0.45)) : 0;
    const spots = along.slice(from0, -1);
    // Fewer side twigs on the outer levels (they'd only crowd).
    const outer = level >= o.levels - 1 ? 0.5 : 1;
    const k = spots.length ? Math.max(0, Math.round(o.branching * outer + (rand() - 0.5))) : 0;
    let az = rand() * Math.PI * 2;
    for (let j = 0; j < k; j++) {
      const at = spots[Math.min(spots.length - 1, Math.floor(((j + rand() * 0.9) / k) * spots.length))];
      az += 2.39996 + (rand() - 0.5) * 0.6;
      const side = rotate(anyPerp(at.dir), at.dir, az);
      const ang = (o.spread * (0.85 + rand() * 0.45) * Math.PI) / 180;
      grow(at, norm(add(mul(at.dir, Math.cos(ang)), mul(side, Math.sin(ang)))), L * (0.5 + rand() * 0.25), level + 1, false);
    }
    // The fork at the end: the leader carries on almost straight, the others
    // go off to the sides.
    const forks = rand() < (level >= o.levels - 1 ? 0.1 : 0.3) ? 3 : 2;
    const base = anyPerp(dir);
    const az0 = rand() * Math.PI * 2;
    for (let j = 0; j < forks; j++) {
      const side = rotate(base, dir, az0 + (j * Math.PI * 2) / forks + (rand() - 0.5) * 0.6);
      const ang = (o.spread * (j === 0 ? 0.25 + rand() * 0.25 : 0.6 + rand() * 0.45) * Math.PI) / 180;
      grow(prev, norm(add(mul(dir, Math.cos(ang)), mul(side, Math.sin(ang)))), L * (0.68 + rand() * 0.17), level + 1, false);
    }
  };

  const trunks = Math.max(1, Math.min(5, Math.round(o.trunks)));
  const trunkR = (H * 0.045 * Math.max(0.3, +o.thickness || 1)) / Math.sqrt(trunks);
  const lean = ((+o.lean || 0) * Math.PI) / 180;
  const leanAz = rand() * Math.PI * 2;
  const bases = [];
  for (let t = 0; t < trunks; t++) {
    const az = leanAz + (t * Math.PI * 2) / trunks;
    const out = trunks > 1 ? 0.25 : 0;
    const d = norm([Math.cos(az) * (Math.sin(lean) + out), Math.sin(az) * (Math.sin(lean) + out), 1]);
    const p0 = trunks > 1 ? [Math.cos(az) * trunkR * 0.9, Math.sin(az) * trunkR * 0.9, -trunkR * 0.5] : [0, 0, -trunkR * 0.5];
    const root = node(p0, null, d, 0, true);
    bases.push(root);
    grow(root, d, H * 0.38 * (1 + (rand() - 0.5) * 0.15), 0, true);
  }

  // Stretch (or squeeze) to the asked height; thicknesses don't depend on it.
  let top = 0;
  for (const n of nodes) top = Math.max(top, n.p[2]);
  const k = top > 0 ? H / top : 1;
  for (const n of nodes) n.p = [n.p[0] * k, n.p[1] * k, n.p[2] * k];

  // Thickness from what a branch carries (pipe model): the cross-section at
  // any point is about the sum of the twigs above it, so twigs are thin, the
  // trunk is thick and everything tapers in between.
  // Also how far it still is to the farthest tip: that shrinks with every
  // step outwards, so a branch keeps getting thinner all the way to its end,
  // not only where side twigs leave.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    n.tips = n.kids.length ? n.kids.reduce((s, c) => s + c.tips, 0) : 1;
    n.down = n.kids.length ? Math.max(...n.kids.map((c) => c.down + len(sub(c.p, n.p)))) : 0;
  }
  const E = 2.3;
  const tipR = minR * 0.55; // the very end of a twig: a point
  const twigEnd = Math.max(4, H * 0.05); // mm over which a twig narrows to it
  for (const root of bases) {
    const scale = trunkR / Math.pow(root.tips, 1 / E);
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      const byTips = scale * Math.pow(n.tips, 1 / E);
      const byLength = tipR + (trunkR - tipR) * Math.pow(n.down / root.down, 0.85);
      // Printable: at least the thinnest-twig size, except over the last few
      // mm where a twig narrows to its point (still thinner every step).
      const floor = n.down >= twigEnd ? minR * (1 + 0.004 * (n.down - twigEnd)) : tipR + (minR - tipR) * (n.down / twigEnd);
      n.r = Math.max(floor, Math.sqrt(byTips * byLength));
      // Thinner than where it grows from: a little along the branch, clearly
      // for a side branch.
      if (n.parent) n.r = Math.min(n.r, n.parent.r * (n.side ? 0.82 : 0.97));
      if (!n.kids.length) n.r = tipR;
      if (n.kids.length) {
        const main = n.kids.reduce((m, c) => (c.tips > m.tips ? c : m), n.kids[0]);
        for (const c of n.kids) c.side = c !== main;
      }
      stack.push(...n.kids);
    }
  }

  // Branches to mesh: the strongest child carries the branch on (so the bark
  // runs through the fork), the others start their own, from the node.
  const branches = [];
  const tips = [];
  const startChain = (from, first) => {
    // A side branch starts inside its parent, a little thinner than it.
    const pts = from ? [from.p] : [], radii = from ? [Math.min(first.r * 1.08, from.r * 0.9)] : [];
    let n = first;
    for (;;) {
      pts.push(n.p);
      radii.push(n.r);
      if (!n.kids.length) {
        if (n.parent) {
          const a = n.parent.parent;
          tips.push({ p: n.p, d: n.dir, level: n.level, pts: a ? [a.p, n.parent.p, n.p] : [n.parent.p, n.p] });
        }
        break;
      }
      const main = n.kids.reduce((m, c) => (c.tips > m.tips ? c : m), n.kids[0]);
      for (const c of n.kids) if (c !== main) side.push([n, c]);
      n = main;
    }
    branches.push({ pts, radii, level: first.level, trunk: !from });
  };
  const side = [];
  for (const root of bases) startChain(null, root);
  while (side.length) {
    const [from, c] = side.shift();
    startChain(from, c);
  }

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
  return { branches, roots, tips, knots: [], trunkR, options: o, H };
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

// The branch's path sampled about every `step` mm: straight between its
// nodes, with only the corners rounded a little (over about its own
// thickness), as on real wood.
function smoothPath(pts, radii, step) {
  const n = pts.length;
  const out = [], rad = [];
  for (let i = 0; i + 1 < n; i++) {
    const k = Math.max(1, Math.ceil(len(sub(pts[i + 1], pts[i])) / step));
    for (let j = 0; j < k; j++) {
      const t = j / k;
      out.push(add(pts[i], mul(sub(pts[i + 1], pts[i]), t)));
      rad.push(radii[i] + (radii[i + 1] - radii[i]) * t);
    }
  }
  out.push([...pts[n - 1]]);
  rad.push(radii[n - 1]);
  // Round the corners: average over a window about as long as it is thick.
  const sm = out.map((p, i) => {
    const w = Math.min(6, Math.max(0, Math.round((rad[i] * 1.2) / step)));
    if (!w || i === 0 || i === out.length - 1) return p;
    let c = [0, 0, 0], m = 0;
    for (let q = Math.max(0, i - w); q <= Math.min(out.length - 1, i + w); q++) (c = add(c, out[q])), m++;
    return mul(c, 1 / m);
  });
  return { pts: sm, radii: rad };
}

// Swept tube with bark: rings along the smoothed branch (frames carried along
// so they don't twist), closed at both ends with a rounded tip. Returns
// { vert, tri } – a closed, consistently wound surface.
function tubeMesh(branch, { bark, noise, edge = 0.4, maxSeg = 96 }) {
  // Thin twigs need fewer rings (their bark is too fine to see anyway).
  const thin = branch.radii[0] < 1.3;
  const { pts, radii } = smoothPath(branch.pts, branch.radii, edge * (thin ? 2.6 : 1.3));
  // The trunk flares out where it meets the ground.
  if (branch.trunk) {
    const z0 = pts[0][2], fh = radii[0] * 3.5;
    for (let i = 0; i < pts.length; i++) {
      const t = (pts[i][2] - z0) / fh;
      if (t < 1) radii[i] *= 1 + 0.6 * (1 - Math.max(0, t)) ** 2;
    }
  }
  const n = pts.length;
  const seg = Math.max(thin ? 7 : 8, Math.min(maxSeg, Math.round((2 * Math.PI * radii[0]) / (thin ? edge * 1.3 : edge))));
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
    // Leaves: fern-like fronds on the twigs – a thin, arching stem with pairs
    // of small leaflets, largest at the base, smaller towards the tip.
    if (o.leaves && o.leaves !== 'none') {
      const rand = rng(o.seed + 99);
      const frond = +o.leafSize || tree.H * 0.12; // frond length, mm
      const thick = Math.max(0.6, frond * 0.04); // leaflets stay printable
      const res = o.detail === 'draft' ? [4, 5] : o.detail === 'fine' ? [7, 8] : [5, 6];
      // A leaflet of length 1, width 0.42 and thickness 1 (scaled per use).
      const leaflet = solidOf(leafMesh(1, 0.42, 1, { rows: res[0], around: res[1] }));
      if (!leaflet) throw new Error('leaf');
      // Not every twig needs a frond on a big tree: at most ~450 (~700 dense).
      const dense = o.leaves === 'crown';
      const limit = dense ? 700 : 450;
      const all = tree.tips;
      const every = Math.max(1, all.length / limit);
      const pairs = dense ? 10 : 9;
      const up = [0, 0, 1];
      for (let f = 0; f < all.length; f += every) {
        const tip = all[Math.floor(f)];
        for (let copy = 0; copy < (dense ? 2 : 1); copy++) {
          // The frond grows on from the twig, spreading outwards and a little
          // down, its leaflets lying roughly level.
          let d = tip.d;
          if (copy) d = norm(rotate(d, anyPerp(d), 0.7 + rand() * 0.3));
          let fd = norm([d[0], d[1], d[2] * 0.35 - 0.1]);
          if (Math.hypot(fd[0], fd[1]) < 0.2) fd = norm(add(fd, mul(anyPerp(fd), 0.8)));
          const L = frond * (0.8 + rand() * 0.35);
          let across = cross(fd, up);
          across = len(across) < 0.2 ? anyPerp(fd) : norm(across);
          const lift = norm(cross(across, fd)); // the frond's "up"
          const at = (t) => add(add(tip.p, mul(fd, t * L)), mul(lift, L * (0.1 * Math.sin(Math.PI * t) - 0.18 * t * t)));
          // The stem (rachis): a thin tube along the arch.
          const stem = { pts: [0, 0.25, 0.5, 0.75, 1].map(at), radii: [0.55, 0.47, 0.4, 0.33, 0.25].map((k) => Math.max(0.3, thick * k)), level: 9 };
          const sm = solidOf(tubeMesh(stem, { bark: 0, noise, edge: Math.max(0.4, edge) }));
          if (sm) parts.push(sm);
          // Leaflets in pairs along the stem, and one at the end.
          for (let j = 0; j <= pairs; j++) {
            const t = j === pairs ? 1 : 0.12 + 0.84 * (j / pairs);
            const p0 = at(t), p1 = at(Math.min(1, t + 0.02));
            const sd = norm(sub(p1, p0));
            const sideAcross = norm(cross(sd, lift));
            const size = L * (j === pairs ? 0.2 : 0.3 * (1 - 0.6 * t)) * (0.9 + rand() * 0.2);
            for (const side of j === pairs ? [0] : [1, -1]) {
              const ang = side ? (58 + rand() * 10) * (Math.PI / 180) : 0;
              const out = norm(add(add(mul(sd, Math.cos(ang)), mul(sideAcross, side * Math.sin(ang))), mul(lift, side ? 0.12 : 0)));
              const z = norm(cross(out, side ? sideAcross : sideAcross));
              const zz = dot(z, lift) < 0 ? mul(z, -1) : z;
              const y = cross(zz, out);
              const base = add(p0, mul(out, -Math.min(0.4, size * 0.08)));
              const mat = [...mul(out, size), 0, ...mul(y, size), 0, ...mul(zz, thick), 0, ...base, 1];
              const blade = leaflet.transform(mat);
              made.push(blade);
              parts.push(blade);
            }
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
