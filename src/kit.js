// Printable kit of a standing figure: cut it at its joints, like a creator
// splits a figure for printing – the base off with a flat cut, then the feet,
// legs, arms and head along contoured lines around the joints (see neck.js),
// each cut closed on both sides with a pin and a matching hole.
//
// The torso can keep its arms (and legs) – for a scan with the hands in the
// pockets the arms can't come off cleanly anyway.

import { cutWithPins } from './cut.js';
import { seamLoop, smoothLine, splitAlongLine, cutAlongLoop } from './neck.js';

// The cuts a body (from findBodyParts) offers, in the order they are made.
// choices: { base, feet, legs, arms, head } – which to cut.
export function kitCuts(body, choices = {}) {
  const want = { base: true, feet: false, legs: true, arms: false, head: true, ...choices };
  const cuts = [];
  if (body.base && want.base) cuts.push({ key: 'base', name: 'Base', z: body.base.z });
  const joint = (prefix, key, name) => {
    for (const j of body.joints) {
      if (!j.name.startsWith(prefix) || !want[key]) continue;
      // How big the piece should be (triangles), to check the cut.
      const part = body.parts.find((p) => p.name.split(' ')[0] === name(j.name).split(' ')[0] && p.name.includes(side(j.name).trim().slice(1, 5)));
      cuts.push({ key, name: name(j.name), neck: j.neck, expect: part ? part.faces.length : 0 });
    }
  };
  const side = (n) => (n.includes('left') ? ' (left in Front view)' : n.includes('right') ? ' (right in Front view)' : '');
  joint('Ankle', 'feet', (n) => 'Foot' + side(n));
  joint('Hip', 'legs', (n) => 'Leg' + side(n));
  joint('Shoulder', 'arms', (n) => 'Arm' + side(n));
  joint('Neck', 'head', () => 'Head');
  return cuts;
}

// Which parts each triangle ends up in when the given cuts are made – for a
// preview, from the body parts: what isn't cut off stays with the torso.
export function kitPreview(body, cuts) {
  const keys = new Set(cuts.map((c) => c.key));
  const keep = (name) =>
    (name === 'Head' && keys.has('head')) ||
    (name.startsWith('Arm') && keys.has('arms')) ||
    (name.startsWith('Leg') && keys.has('legs')) ||
    (name === 'Base' && keys.has('base'));
  const parts = [];
  const torso = { name: 'Torso', faces: [] };
  parts.push(torso);
  for (const p of body.parts) {
    if (p.name === 'Torso' || !keep(p.name)) torso.faces.push(...p.faces);
    else parts.push({ name: p.name, faces: p.faces });
  }
  // Without the legs cut off, the torso is "Body".
  if (!keys.has('legs') && !keys.has('arms')) torso.name = 'Body';
  return parts;
}

// Makes the cuts (changes the mesh). Returns { labels, names, notes }:
// labels[t] is the index in names of the piece triangle t belongs to.
// options: connector (see neck.js), smooth (0..1), collar (head cut where the
// neck meets the clothes), tolerance (mm, for the base pins).
export function splitFigure(mesh, cuts, { connector = null, smooth = 0.6, collar = true, follow = 0.6, width = 0.9 } = {}) {
  const names = ['Torso'];
  let labels = new Int32Array(mesh.triangleCount);
  const notes = [];
  const done = [];
  for (const cut of cuts) {
    const before = mesh.snapshot();
    const prev = { positions: mesh.positions, indices: mesh.indices, labels };
    let cutOff = null; // per triangle: belongs to the piece cut off
    try {
      if (cut.z !== undefined) {
        const tolerance = connector?.tolerance ?? 0.2;
        const result = cutWithPins(mesh, { normal: [0, 0, 1], offset: cut.z }, { type: connector?.shape === 'none' ? 'none' : 'pin', tolerance });
        if (!result.areas.length) throw new Error('nothing to cut');
        // The base: everything below the cut (pins standing on it included).
        cutOff = new Uint8Array(mesh.triangleCount);
        const P = mesh.positions, I = mesh.indices;
        for (const part of mesh.parts()) {
          let lo = Infinity;
          for (const t of part.faces) for (let k = 0; k < 3; k++) lo = Math.min(lo, P[I[t * 3 + k] * 3 + 2]);
          if (lo < cut.z - 1e-6) for (const t of part.faces) cutOff[t] = 1;
        }
      } else {
        let loop = seamLoop(mesh, cut.neck, { follow: cut.key === 'head' && collar ? 1 : follow, width, collar: cut.key === 'head' && collar });
        if (!loop && cut.key === 'head' && collar) loop = seamLoop(mesh, cut.neck, { follow, width });
        if (!loop) throw new Error('no line found around it');
        if (smooth > 0) {
          const line = smoothLine(mesh, cut.neck, loop, { smooth });
          if (line) loop = splitAlongLine(mesh, line);
        }
        const result = cutAlongLoop(mesh, loop, cut.neck, connector);
        cutOff = result.faces;
        let n = 0;
        for (let t = 0; t < cutOff.length; t++) n += cutOff[t];
        if (cut.expect && n < cut.expect * 0.3) throw new Error('the line only went round a small bit of it – cut it by hand in Cut ▸ Around a neck');
      }
    } catch (err) {
      mesh.restore(before);
      notes.push(`${cut.name}: not cut – ${/all the way round/.test(err.message) ? 'it is joined to the rest somewhere else too (a hand in a pocket…), so it stays on' : err.message}.`);
      continue;
    }
    // Where two cut lines pass close by (the hips at the crotch) a cap can
    // leave a gap of a triangle or two: close those.
    if (mesh.fillHoles({ maxEdges: 12 }).added) {
      const grown = new Uint8Array(mesh.triangleCount);
      grown.set(cutOff.subarray(0, Math.min(cutOff.length, grown.length)));
      cutOff = grown;
    }
    labels = carryLabels(mesh, prev);
    const id = names.push(cut.name) - 1;
    for (const part of mesh.parts()) {
      let n = 0;
      for (const t of part.faces) n += cutOff[t] ? 1 : 0;
      if (n > part.faces.length / 2) for (const t of part.faces) labels[t] = id;
    }
    done.push(cut.name);
  }
  // Nothing taken off the torso's legs or arms: it is the whole body.
  if (!done.some((n) => /^(Leg|Arm)/.test(n))) names[0] = 'Body';
  return { labels, names, notes, done };
}

// Labels after an edit: each piece takes the label most of its corners had
// (by position) before.
function carryLabels(mesh, prev) {
  const key = (P, v) => P[v * 3] + ',' + P[v * 3 + 1] + ',' + P[v * 3 + 2];
  const was = new Map();
  const P0 = prev.positions, I0 = prev.indices;
  for (let t = 0; t < prev.labels.length; t++) for (let k = 0; k < 3; k++) was.set(key(P0, I0[t * 3 + k]), prev.labels[t]);
  const out = new Int32Array(mesh.triangleCount);
  const P = mesh.positions, I = mesh.indices;
  for (const part of mesh.parts()) {
    const votes = new Map();
    const step = Math.max(1, Math.floor(part.faces.length / 2000));
    for (let i = 0; i < part.faces.length; i += step) {
      const t = part.faces[i];
      for (let k = 0; k < 3; k++) {
        const g = was.get(key(P, I[t * 3 + k]));
        if (g !== undefined) votes.set(g, (votes.get(g) || 0) + 1);
      }
    }
    let id = 0, best = 0;
    for (const [g, n] of votes) if (n > best) (best = n), (id = g);
    for (const t of part.faces) out[t] = id;
  }
  return out;
}
