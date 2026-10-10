// Indexed triangle mesh with the editing operations the app needs:
// welding an STL triangle soup, deleting faces, finding holes (boundary
// loops), closing them, and selection helpers (connected parts, smooth
// regions, grow/shrink).
//
// Arrays are treated as immutable: every edit swaps in new arrays, so an undo
// snapshot is just a pair of references.

export class EditableMesh {
  constructor(positions, indices) {
    this.positions = positions; // Float32Array, xyz per vertex
    this.indices = indices; // Uint32Array, 3 per triangle
    this._topo = null;
    this._vertexFaces = null;
    this._normals = null;
  }

  get triangleCount() {
    return this.indices.length / 3;
  }

  get vertexCount() {
    return this.positions.length / 3;
  }

  // Merges coincident vertices of a triangle soup (9 floats per triangle) and
  // drops degenerate triangles.
  static fromSoup(soup, { tolerance } = {}) {
    const n = soup.length / 3;
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        const v = soup[i * 3 + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const eps = tolerance ?? (diag > 0 ? diag * 1e-7 : 1e-9);
    const inv = 1 / eps;

    const lookup = new Map();
    const remap = new Uint32Array(n);
    const positions = new Float32Array(n * 3);
    let vCount = 0;
    for (let i = 0; i < n; i++) {
      const x = soup[i * 3], y = soup[i * 3 + 1], z = soup[i * 3 + 2];
      const key = Math.round(x * inv) + ',' + Math.round(y * inv) + ',' + Math.round(z * inv);
      let id = lookup.get(key);
      if (id === undefined) {
        id = vCount++;
        lookup.set(key, id);
        positions[id * 3] = x; positions[id * 3 + 1] = y; positions[id * 3 + 2] = z;
      }
      remap[i] = id;
    }

    const indices = new Uint32Array(n);
    let t = 0;
    for (let i = 0; i < n; i += 3) {
      const a = remap[i], b = remap[i + 1], c = remap[i + 2];
      if (a === b || b === c || a === c) continue;
      indices[t++] = a; indices[t++] = b; indices[t++] = c;
    }
    return new EditableMesh(positions.slice(0, vCount * 3), indices.slice(0, t));
  }

  snapshot() {
    return { positions: this.positions, indices: this.indices };
  }

  restore(snap) {
    this._set(snap.positions, snap.indices);
  }

  _set(positions, indices) {
    this.positions = positions;
    this.indices = indices;
    this._topo = null;
    this._vertexFaces = null;
    this._normals = null;
  }

  // Triangle soup for rendering.
  toSoup() {
    const { positions: p, indices: ind } = this;
    const out = new Float32Array(ind.length * 3);
    for (let i = 0; i < ind.length; i++) {
      const v = ind[i] * 3;
      out[i * 3] = p[v]; out[i * 3 + 1] = p[v + 1]; out[i * 3 + 2] = p[v + 2];
    }
    return out;
  }

  bounds() {
    const p = this.positions;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (p[i + k] < min[k]) min[k] = p[i + k];
        if (p[i + k] > max[k]) max[k] = p[i + k];
      }
    }
    return { min, max };
  }

  // ---------------------------------------------------------------------------
  // Topology

  // Edge structure. Half-edge h = 3*t + k goes from corner k to corner k+1 of
  // triangle t. Each undirected edge gets an id; edgeHalfEdges lists the
  // half-edges using it (more than 2 means a non-manifold edge).
  topology() {
    if (this._topo) return this._topo;
    const ind = this.indices;
    const H = ind.length;
    const nv = this.vertexCount;
    const heEdge = new Int32Array(H);
    const lookup = new Map();
    let edgeCount = 0;
    const uses = [];
    for (let h = 0; h < H; h++) {
      const a = ind[h], b = ind[next(h)];
      const key = a < b ? a * nv + b : b * nv + a;
      let e = lookup.get(key);
      if (e === undefined) {
        e = edgeCount++;
        lookup.set(key, e);
        uses.push(0);
      }
      uses[e]++;
      heEdge[h] = e;
    }
    const offsets = new Uint32Array(edgeCount + 1);
    for (let e = 0; e < edgeCount; e++) offsets[e + 1] = offsets[e] + uses[e];
    const fill = offsets.slice(0, edgeCount);
    const edgeHalfEdges = new Uint32Array(H);
    for (let h = 0; h < H; h++) edgeHalfEdges[fill[heEdge[h]]++] = h;
    this._topo = { heEdge, offsets, edgeHalfEdges, edgeCount };
    return this._topo;
  }

  edgeUseCount(e) {
    const { offsets } = this.topology();
    return offsets[e + 1] - offsets[e];
  }

  // Calls cb(neighbourTriangle) for each triangle sharing an edge with t.
  forEachEdgeNeighbour(t, cb) {
    const { heEdge, offsets, edgeHalfEdges } = this.topology();
    for (let k = 0; k < 3; k++) {
      const e = heEdge[t * 3 + k];
      for (let i = offsets[e]; i < offsets[e + 1]; i++) {
        const other = (edgeHalfEdges[i] / 3) | 0;
        if (other !== t) cb(other);
      }
    }
  }

  // Vertex -> triangles (CSR).
  vertexFaces() {
    if (this._vertexFaces) return this._vertexFaces;
    const ind = this.indices;
    const nv = this.vertexCount;
    const offsets = new Uint32Array(nv + 1);
    for (let i = 0; i < ind.length; i++) offsets[ind[i] + 1]++;
    for (let v = 0; v < nv; v++) offsets[v + 1] += offsets[v];
    const fill = offsets.slice(0, nv);
    const faces = new Uint32Array(ind.length);
    for (let i = 0; i < ind.length; i++) faces[fill[ind[i]]++] = (i / 3) | 0;
    this._vertexFaces = { offsets, faces };
    return this._vertexFaces;
  }

  faceNormals() {
    if (this._normals) return this._normals;
    const { positions: p, indices: ind } = this;
    const T = this.triangleCount;
    const out = new Float32Array(T * 3);
    for (let t = 0; t < T; t++) {
      const a = ind[t * 3] * 3, b = ind[t * 3 + 1] * 3, c = ind[t * 3 + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      out[t * 3] = nx / len; out[t * 3 + 1] = ny / len; out[t * 3 + 2] = nz / len;
    }
    this._normals = out;
    return out;
  }

  // Edges used by exactly one triangle, as directed [from, to] pairs in the
  // winding of the triangle that owns them.
  boundaryEdges() {
    const { heEdge, offsets } = this.topology();
    const ind = this.indices;
    const out = [];
    for (let h = 0; h < ind.length; h++) {
      const e = heEdge[h];
      if (offsets[e + 1] - offsets[e] === 1) out.push([ind[h], ind[next(h)]]);
    }
    return out;
  }

  // Groups boundary edges into closed loops (holes). Each loop is a vertex
  // list ordered so that consecutive vertices (loop[i], loop[i+1]) are the
  // reverse of a boundary edge – i.e. the winding a patch closing the hole
  // must use to stay consistent with the surrounding triangles.
  // Returns { loops, openChains } where openChains counts boundary pieces that
  // could not be closed (usually from inconsistently oriented triangles).
  boundaryLoops() {
    const outgoing = new Map();
    for (const [a, b] of this.boundaryEdges()) {
      let list = outgoing.get(b);
      if (!list) outgoing.set(b, (list = []));
      list.push(a);
    }

    const loops = [];
    let openChains = 0;
    for (const start of outgoing.keys()) {
      while (outgoing.get(start).length) {
        const loop = [start];
        const pos = new Map([[start, 0]]);
        let cur = start;
        let closed = false;
        for (;;) {
          const list = outgoing.get(cur);
          if (!list || !list.length) break;
          const nxt = list.pop();
          if (nxt === start) { closed = true; break; }
          const seen = pos.get(nxt);
          if (seen !== undefined) {
            // Loop touches itself (pinched vertex): split off the inner loop.
            const inner = loop.splice(seen);
            for (const v of inner) pos.delete(v);
            loops.push(inner);
          }
          pos.set(nxt, loop.length);
          loop.push(nxt);
          cur = nxt;
        }
        if (closed) loops.push(loop);
        else openChains++;
      }
    }
    return { loops: loops.filter((l) => l.length >= 3), openChains };
  }

  // Splits faces into connected parts. Returns { component: Int32Array, count, sizes }.
  connectedComponents() {
    const T = this.triangleCount;
    const component = new Int32Array(T).fill(-1);
    const sizes = [];
    const stack = [];
    let count = 0;
    for (let s = 0; s < T; s++) {
      if (component[s] !== -1) continue;
      let size = 0;
      component[s] = count;
      stack.push(s);
      while (stack.length) {
        const t = stack.pop();
        size++;
        this.forEachEdgeNeighbour(t, (n) => {
          if (component[n] === -1) {
            component[n] = count;
            stack.push(n);
          }
        });
      }
      sizes.push(size);
      count++;
    }
    return { component, count, sizes };
  }

  // Separate shells, largest first: [{ faces: Uint32Array, open: bool }].
  // Linear time, however many shells there are.
  parts() {
    const { component, count, sizes } = this.connectedComponents();
    const { heEdge, offsets } = this.topology();
    const open = new Uint8Array(count);
    for (let h = 0; h < heEdge.length; h++) {
      const e = heEdge[h];
      if (offsets[e + 1] - offsets[e] !== 2) open[component[(h / 3) | 0]] = 1;
    }
    const start = new Uint32Array(count + 1);
    for (let c = 0; c < count; c++) start[c + 1] = start[c] + sizes[c];
    const fill = start.slice(0, count);
    const faces = new Uint32Array(this.triangleCount);
    for (let t = 0; t < faces.length; t++) faces[fill[component[t]]++] = t;
    return [...Array(count).keys()]
      .sort((a, b) => sizes[b] - sizes[a])
      .map((c) => ({ faces: faces.subarray(start[c], start[c + 1]), open: !!open[c] }));
  }

  stats() {
    const { loops, openChains } = this.boundaryLoops();
    const { offsets, edgeCount } = this.topology();
    let boundary = 0, nonManifold = 0;
    for (let e = 0; e < edgeCount; e++) {
      const u = offsets[e + 1] - offsets[e];
      if (u === 1) boundary++;
      else if (u > 2) nonManifold++;
    }
    const used = new Uint8Array(this.vertexCount);
    for (const v of this.indices) used[v] = 1;
    let vertices = 0;
    for (const u of used) vertices += u;
    return {
      triangles: this.triangleCount,
      vertices,
      holes: loops.length,
      openChains,
      boundaryEdges: boundary,
      nonManifoldEdges: nonManifold,
      parts: this.connectedComponents().count,
      watertight: boundary === 0 && nonManifold === 0 && this.triangleCount > 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Editing

  // Removes triangles whose mask entry is non-zero, then drops unused vertices.
  deleteFaces(mask) {
    const ind = this.indices;
    const keep = [];
    for (let t = 0; t < this.triangleCount; t++) if (!mask[t]) keep.push(t);
    const remap = new Int32Array(this.vertexCount).fill(-1);
    const indices = new Uint32Array(keep.length * 3);
    let nv = 0;
    const p = this.positions;
    const positions = new Float32Array(this.positions.length);
    keep.forEach((t, i) => {
      for (let k = 0; k < 3; k++) {
        const v = ind[t * 3 + k];
        if (remap[v] === -1) {
          remap[v] = nv;
          positions[nv * 3] = p[v * 3]; positions[nv * 3 + 1] = p[v * 3 + 1]; positions[nv * 3 + 2] = p[v * 3 + 2];
          nv++;
        }
        indices[i * 3 + k] = remap[v];
      }
    });
    const removed = this.triangleCount - keep.length;
    this._set(positions.slice(0, nv * 3), indices);
    return removed;
  }

  // Closes every hole with at most maxEdges boundary edges. Returns the
  // number of holes filled. Each hole is triangulated by ear clipping in its
  // best-fit plane, falling back to a fan around the hole centre when the
  // hole cannot be flattened cleanly.
  // `onlyVertices` (a mask over vertices) restricts filling to holes whose rim
  // lies entirely on those vertices.
  fillHoles({ maxEdges = Infinity, onlyVertices = null } = {}) {
    let { loops } = this.boundaryLoops();
    if (onlyVertices) loops = loops.filter((l) => l.every((v) => onlyVertices[v]));
    const targets = loops.filter((l) => l.length <= maxEdges);
    if (!targets.length) return { filled: 0, added: 0, skipped: loops.length };

    const extra = []; // new vertex coordinates
    const newTris = [];
    const base = this.vertexCount;
    const p = this.positions;
    const getPos = (v) =>
      v < base ? [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]] : extra.slice((v - base) * 3, (v - base) * 3 + 3);
    const addVertex = (xyz) => {
      extra.push(xyz[0], xyz[1], xyz[2]);
      return base + extra.length / 3 - 1;
    };

    for (const loop of targets) {
      for (const tri of triangulateLoop(loop, getPos, addVertex)) newTris.push(tri[0], tri[1], tri[2]);
    }

    const positions = new Float32Array(p.length + extra.length);
    positions.set(p);
    positions.set(extra, p.length);
    const indices = new Uint32Array(this.indices.length + newTris.length);
    indices.set(this.indices);
    indices.set(newTris, this.indices.length);
    this._set(positions, indices);
    return { filled: targets.length, added: newTris.length / 3, skipped: loops.length - targets.length };
  }

  // Splits every triangle crossing the plane n·p + constant = 0 so that no
  // triangle straddles it. Cut points are shared between neighbouring
  // triangles, so the mesh stays watertight. Returns the new triangle -> old
  // triangle mapping, or null when nothing was split.
  cutByPlane(normal, constant) {
    const p = this.positions, ind = this.indices, nv = this.vertexCount;
    const { min, max } = this.bounds();
    const eps = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 1e-6;
    const dist = new Float64Array(nv);
    for (let v = 0; v < nv; v++) {
      const d = normal[0] * p[v * 3] + normal[1] * p[v * 3 + 1] + normal[2] * p[v * 3 + 2] + constant;
      dist[v] = Math.abs(d) < eps ? 0 : d;
    }
    const extra = [];
    const cutVertex = new Map();
    const pointOnEdge = (a, b) => {
      const key = a < b ? a * nv + b : b * nv + a;
      let id = cutVertex.get(key);
      if (id === undefined) {
        const t = dist[a] / (dist[a] - dist[b]);
        for (let k = 0; k < 3; k++) extra.push(p[a * 3 + k] + t * (p[b * 3 + k] - p[a * 3 + k]));
        id = nv + extra.length / 3 - 1;
        cutVertex.set(key, id);
      }
      return id;
    };

    const out = [];
    const origin = [];
    let split = 0;
    for (let t = 0; t < ind.length; t += 3) {
      const tri = [ind[t], ind[t + 1], ind[t + 2]];
      const d = tri.map((v) => dist[v]);
      if ((d[0] >= 0 && d[1] >= 0 && d[2] >= 0) || (d[0] <= 0 && d[1] <= 0 && d[2] <= 0)) {
        out.push(tri[0], tri[1], tri[2]);
        origin.push(t / 3);
        continue;
      }
      split++;
      const above = [], below = [];
      for (let k = 0; k < 3; k++) {
        const a = tri[k], b = tri[(k + 1) % 3], da = d[k], db = d[(k + 1) % 3];
        if (da >= 0) above.push(a);
        if (da <= 0) below.push(a);
        if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
          const m = pointOnEdge(a, b);
          above.push(m);
          below.push(m);
        }
      }
      for (const poly of [above, below]) {
        for (let i = 1; i + 1 < poly.length; i++) {
          out.push(poly[0], poly[i], poly[i + 1]);
          origin.push(t / 3);
        }
      }
    }
    if (!split) return null;
    const positions = new Float32Array(p.length + extra.length);
    positions.set(p);
    positions.set(extra, p.length);
    this._set(positions, new Uint32Array(out));
    return Int32Array.from(origin);
  }

  // Cuts along each plane of a box-like region (inside: n·p + constant >= 0),
  // skipping planes that only cross the mesh outside the region. Returns the
  // new triangle -> original triangle mapping, or null if nothing was cut.
  cutByPlanes(planes) {
    let origin = null;
    planes.forEach((plane, i) => {
      const others = planes.filter((_, j) => j !== i);
      if (!this._planeCrossesRegion(plane, others)) return;
      const o = this.cutByPlane(plane.normal, plane.constant);
      if (o) origin = origin ? Int32Array.from(o, (t) => origin[t]) : o;
    });
    return origin;
  }

  // Does any triangle crossing `plane` reach into the region of `others`?
  _planeCrossesRegion(plane, others) {
    const p = this.positions, ind = this.indices;
    const d = (pl, v) => pl.normal[0] * p[v * 3] + pl.normal[1] * p[v * 3 + 1] + pl.normal[2] * p[v * 3 + 2] + pl.constant;
    for (let t = 0; t < ind.length; t += 3) {
      const tri = [ind[t], ind[t + 1], ind[t + 2]];
      const ds = tri.map((v) => d(plane, v));
      if (Math.min(...ds) >= 0 || Math.max(...ds) <= 0) continue;
      if (others.every((pl) => Math.max(...tri.map((v) => d(pl, v))) >= 0)) return true;
    }
    return false;
  }

  // Mask of triangles whose centre is on the inner side of every plane. A
  // triangle lying exactly on a plane goes with the solid behind it: inside
  // when it faces out of the region.
  facesInsidePlanes(planes) {
    const p = this.positions, ind = this.indices;
    const normals = this.faceNormals();
    const { min, max } = this.bounds();
    const eps = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 1e-5;
    const mask = new Uint8Array(this.triangleCount);
    for (let t = 0; t < mask.length; t++) {
      const c = [0, 1, 2].map((k) => (p[ind[t * 3] * 3 + k] + p[ind[t * 3 + 1] * 3 + k] + p[ind[t * 3 + 2] * 3 + k]) / 3);
      mask[t] = planes.every(({ normal: n, constant }) => {
        const d = n[0] * c[0] + n[1] * c[1] + n[2] * c[2] + constant;
        if (Math.abs(d) > eps) return d > 0;
        return n[0] * normals[t * 3] + n[1] * normals[t * 3 + 1] + n[2] * normals[t * 3 + 2] < 0;
      })
        ? 1
        : 0;
    }
    return mask;
  }

  // Detaches the selected triangles from the rest so they become a separate
  // part, and (with close) caps the openings this leaves on both sides.
  splitOff(mask, { close = true } = {}) {
    const ind = this.indices, nv = this.vertexCount;
    const inSel = new Uint8Array(nv), inRest = new Uint8Array(nv);
    for (let t = 0; t < this.triangleCount; t++) {
      const target = mask[t] ? inSel : inRest;
      for (let k = 0; k < 3; k++) target[ind[t * 3 + k]] = 1;
    }
    const dup = new Int32Array(nv).fill(-1);
    const extra = [];
    for (let v = 0; v < nv; v++) {
      if (!inSel[v] || !inRest[v]) continue;
      dup[v] = nv + extra.length / 3;
      extra.push(this.positions[v * 3], this.positions[v * 3 + 1], this.positions[v * 3 + 2]);
    }
    if (!extra.length) return { detached: 0, closed: 0 };

    const indices = ind.slice();
    for (let t = 0; t < this.triangleCount; t++) {
      if (!mask[t]) continue;
      for (let k = 0; k < 3; k++) {
        const v = indices[t * 3 + k];
        if (dup[v] >= 0) indices[t * 3 + k] = dup[v];
      }
    }
    const positions = new Float32Array(this.positions.length + extra.length);
    positions.set(this.positions);
    positions.set(extra, this.positions.length);
    this._set(positions, indices);

    let closed = 0;
    if (close) {
      const seam = new Uint8Array(this.vertexCount);
      for (let v = 0; v < nv; v++) if (dup[v] >= 0) seam[v] = seam[dup[v]] = 1;
      closed = this.fillHoles({ onlyVertices: seam }).filled;
    }
    return { detached: extra.length / 3, closed };
  }

  // Compact copy of the selected triangles (mask), e.g. for exporting one part.
  extractFaces(mask) {
    const faces = [];
    for (let t = 0; t < this.triangleCount; t++) if (mask[t]) faces.push(t);
    return this.extractFaceList(faces);
  }

  // Same, from a list of triangle indices.
  extractFaceList(faces) {
    const ind = this.indices, p = this.positions;
    const remap = new Map();
    const positions = [], indices = [];
    for (const t of faces) {
      for (let k = 0; k < 3; k++) {
        const v = ind[t * 3 + k];
        let id = remap.get(v);
        if (id === undefined) {
          id = positions.length / 3;
          remap.set(v, id);
          positions.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
        }
        indices.push(id);
      }
    }
    return new EditableMesh(new Float32Array(positions), new Uint32Array(indices));
  }

  // ---------------------------------------------------------------------------
  // Selection helpers. Masks are Uint8Array(triangleCount).

  // All triangles of the parts containing the seed triangles.
  selectConnected(seeds, mask, value = 1) {
    const visited = new Uint8Array(this.triangleCount);
    const stack = [...seeds];
    for (const s of seeds) visited[s] = 1;
    while (stack.length) {
      const t = stack.pop();
      mask[t] = value;
      this.forEachEdgeNeighbour(t, (n) => {
        if (!visited[n]) {
          visited[n] = 1;
          stack.push(n);
        }
      });
    }
    return mask;
  }

  // Flood fill across edges whose dihedral angle is below maxAngleDeg.
  selectSmoothRegion(seed, maxAngleDeg, mask, value = 1) {
    const normals = this.faceNormals();
    const cosLimit = Math.cos((maxAngleDeg * Math.PI) / 180);
    const visited = new Uint8Array(this.triangleCount);
    const stack = [seed];
    visited[seed] = 1;
    while (stack.length) {
      const t = stack.pop();
      mask[t] = value;
      this.forEachEdgeNeighbour(t, (n) => {
        if (visited[n]) return;
        const dot = normals[t * 3] * normals[n * 3] + normals[t * 3 + 1] * normals[n * 3 + 1] + normals[t * 3 + 2] * normals[n * 3 + 2];
        if (dot >= cosLimit) {
          visited[n] = 1;
          stack.push(n);
        }
      });
    }
    return mask;
  }

  // Adds every triangle touching a selected vertex.
  growSelection(mask) {
    const { offsets, faces } = this.vertexFaces();
    const ind = this.indices;
    const touched = new Uint8Array(this.vertexCount);
    for (let t = 0; t < this.triangleCount; t++) {
      if (mask[t]) for (let k = 0; k < 3; k++) touched[ind[t * 3 + k]] = 1;
    }
    for (let v = 0; v < touched.length; v++) {
      if (touched[v]) for (let i = offsets[v]; i < offsets[v + 1]; i++) mask[faces[i]] = 1;
    }
    return mask;
  }

  // Removes selected triangles that touch an unselected one.
  shrinkSelection(mask) {
    const ind = this.indices;
    const outside = new Uint8Array(this.vertexCount);
    for (let t = 0; t < this.triangleCount; t++) {
      if (!mask[t]) for (let k = 0; k < 3; k++) outside[ind[t * 3 + k]] = 1;
    }
    for (let t = 0; t < this.triangleCount; t++) {
      if (mask[t] && (outside[ind[t * 3]] || outside[ind[t * 3 + 1]] || outside[ind[t * 3 + 2]])) mask[t] = 0;
    }
    return mask;
  }
}

function next(h) {
  return h % 3 === 2 ? h - 2 : h + 1;
}

// ---------------------------------------------------------------------------
// Hole triangulation

// Returns triangles [a, b, c] (vertex ids) covering the loop. Triangles keep
// the loop's winding, so they match the orientation of the surrounding mesh.
export function triangulateLoop(loop, getPos, addVertex) {
  const n = loop.length;
  if (n < 3) return [];
  if (n === 3) return [[loop[0], loop[1], loop[2]]];

  const pts = loop.map(getPos);

  // Newell normal: the plane the hole is "most" facing, oriented by the loop.
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const nLen = Math.hypot(nx, ny, nz);
  if (nLen < 1e-20) return fan(loop, pts, addVertex);
  nx /= nLen; ny /= nLen; nz /= nLen;

  // Basis (u, v) of the plane with u x v = n.
  let ux, uy, uz;
  if (Math.abs(nx) < 0.9) { ux = 0; uy = nz; uz = -ny; } else { ux = -nz; uy = 0; uz = nx; }
  const uLen = Math.hypot(ux, uy, uz);
  ux /= uLen; uy /= uLen; uz /= uLen;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  const p2 = pts.map((p) => [p[0] * ux + p[1] * uy + p[2] * uz, p[0] * vx + p[1] * vy + p[2] * vz]);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of p2) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const scale = Math.max(maxX - minX, maxY - minY) || 1;
  const areaEps = scale * scale * 1e-12;

  const cross = (a, b, c) => (p2[b][0] - p2[a][0]) * (p2[c][1] - p2[a][1]) - (p2[b][1] - p2[a][1]) * (p2[c][0] - p2[a][0]);
  const samePoint = (i, j) => Math.abs(p2[i][0] - p2[j][0]) + Math.abs(p2[i][1] - p2[j][1]) < scale * 1e-9;
  const inside = (q, a, b, c) => cross(a, b, q) >= -areaEps && cross(b, c, q) >= -areaEps && cross(c, a, q) >= -areaEps;

  const tris = [];
  const idx = [...Array(n).keys()];
  const exhaustive = n <= 200; // pick the best-shaped ear for small holes
  while (idx.length > 3) {
    const m = idx.length;
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < m; i++) {
      const a = idx[(i - 1 + m) % m], b = idx[i], c = idx[(i + 1) % m];
      if (cross(a, b, c) <= areaEps) continue; // reflex or flat corner
      let blocked = false;
      for (const j of idx) {
        if (j === a || j === b || j === c) continue;
        if (samePoint(j, a) || samePoint(j, b) || samePoint(j, c)) continue;
        if (inside(j, a, b, c)) { blocked = true; break; }
      }
      if (blocked) continue;
      const score = minAngle(pts[a], pts[b], pts[c]);
      if (score > bestScore) { bestScore = score; best = i; }
      if (!exhaustive) break;
    }
    if (best < 0) {
      // Hole doesn't flatten into a simple polygon; close the rest with a fan.
      for (const t of fan(idx.map((i) => loop[i]), idx.map((i) => pts[i]), addVertex)) tris.push(t);
      return tris;
    }
    tris.push([loop[idx[(best - 1 + m) % m]], loop[idx[best]], loop[idx[(best + 1) % m]]]);
    idx.splice(best, 1);
  }
  tris.push([loop[idx[0]], loop[idx[1]], loop[idx[2]]]);
  return tris;
}

function fan(loop, pts, addVertex) {
  const c = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  const centre = addVertex([c[0] / pts.length, c[1] / pts.length, c[2] / pts.length]);
  return loop.map((v, i) => [v, loop[(i + 1) % loop.length], centre]);
}

function minAngle(a, b, c) {
  const ang = (p, q, r) => {
    const x1 = q[0] - p[0], y1 = q[1] - p[1], z1 = q[2] - p[2];
    const x2 = r[0] - p[0], y2 = r[1] - p[1], z2 = r[2] - p[2];
    const d = Math.hypot(x1, y1, z1) * Math.hypot(x2, y2, z2) || 1;
    return Math.acos(Math.max(-1, Math.min(1, (x1 * x2 + y1 * y2 + z1 * z2) / d)));
  };
  return Math.min(ang(a, b, c), ang(b, c, a), ang(c, a, b));
}
