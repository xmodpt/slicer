// Other mesh formats: OBJ (text) and 3MF (a zip with an XML model, used by
// Bambu Studio, PrusaSlicer, Orca, Chitubox, Lychee…). Readers return
// models as triangle soups ({ name, soup: Float32Array, 9 floats per
// triangle }); writers take [{ name, positions, indices }].

import { makeZip } from './zip.js';

// ---------------------------------------------------------------------------
// OBJ

export function parseOBJ(text) {
  const verts = [];
  const models = [];
  let cur = null;
  const start = (name) => {
    cur = { name, tris: [] };
    models.push(cur);
  };
  const lines = text.split(/\r?\n/);
  for (let raw of lines) {
    // Lines continued with a backslash are rare; comments are dropped.
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === 'v') verts.push(+parts[1], +parts[2], +parts[3]);
    else if (tag === 'o' || tag === 'g') {
      const name = parts.slice(1).join(' ') || 'Model';
      if (!cur || cur.tris.length) start(name);
      else cur.name = name;
    } else if (tag === 'f') {
      if (!cur) start('Model');
      const n = verts.length / 3;
      const ids = parts.slice(1).map((p) => {
        const i = parseInt(p.split('/')[0], 10);
        return i < 0 ? n + i : i - 1;
      });
      if (ids.some((i) => !(i >= 0 && i < n))) continue;
      for (let k = 1; k + 1 < ids.length; k++) cur.tris.push(ids[0], ids[k], ids[k + 1]); // fan
    }
  }
  return models
    .filter((m) => m.tris.length)
    .map((m) => {
      const soup = new Float32Array(m.tris.length * 3);
      m.tris.forEach((v, i) => soup.set(verts.slice(v * 3, v * 3 + 3), i * 3));
      return { name: m.name, soup };
    });
}

export function writeOBJ(models) {
  const out = ['# STL Mesh Editor'];
  let base = 1;
  for (const m of models) {
    out.push(`o ${m.name.replace(/\s+/g, '_')}`);
    const P = m.positions;
    for (let i = 0; i < P.length; i += 3) out.push(`v ${+P[i].toFixed(5)} ${+P[i + 1].toFixed(5)} ${+P[i + 2].toFixed(5)}`);
    const I = m.indices;
    for (let i = 0; i < I.length; i += 3) out.push(`f ${I[i] + base} ${I[i + 1] + base} ${I[i + 2] + base}`);
    base += P.length / 3;
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// ZIP reading (for 3MF): stored or deflated entries.

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZip(buffer) {
  const data = new Uint8Array(buffer);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // End of central directory: search backwards for its signature.
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a 3MF / zip file.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('Broken zip directory.');
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(data.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const lNameLen = view.getUint16(local + 26, true), lExtraLen = view.getUint16(local + 28, true);
    const startData = local + 30 + lNameLen + lExtraLen;
    const raw = data.subarray(startData, startData + size);
    files.set(name, { method, raw });
  }
  return {
    names: [...files.keys()],
    async read(name) {
      const f = files.get(name);
      if (!f) return null;
      if (f.method === 0) return f.raw;
      if (f.method === 8) return inflateRaw(f.raw);
      throw new Error(`Unsupported zip compression (${f.method}).`);
    },
  };
}

// ---------------------------------------------------------------------------
// 3MF

const unescapeXML = (s) => s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]);
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? unescapeXML(m[1]) : null;
};
// 3MF matrices: "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32", points as
// row vectors: p' = p · M (the last row is the translation).
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const parseMatrix = (s) => {
  const v = (s || '').trim().split(/\s+/).map(Number);
  return v.length === 12 && v.every(Number.isFinite) ? v : IDENTITY;
};
const mulMatrix = (a, b) => {
  // (p·a)·b
  const r = new Array(12);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = (i < 3 ? 0 : b[9 + j]) + a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
};

export function parse3MFModel(xml) {
  const objects = new Map();
  const objRe = /<(?:\w+:)?object\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?object>/g;
  let m;
  while ((m = objRe.exec(xml))) {
    const head = m[1], body = m[2];
    const id = attr(head, 'id');
    const obj = { id, name: attr(head, 'name') || `Object ${id}`, verts: null, tris: null, components: [] };
    const vSec = /<(?:\w+:)?vertices>([\s\S]*?)<\/(?:\w+:)?vertices>/.exec(body);
    if (vSec) {
      const verts = [];
      const vRe = /<(?:\w+:)?vertex\b([^>]*)\/?>/g;
      let v;
      while ((v = vRe.exec(vSec[1]))) verts.push(+attr(v[1], 'x'), +attr(v[1], 'y'), +attr(v[1], 'z'));
      const tris = [];
      const tSec = /<(?:\w+:)?triangles>([\s\S]*?)<\/(?:\w+:)?triangles>/.exec(body);
      const tRe = /<(?:\w+:)?triangle\b([^>]*)\/?>/g;
      let t;
      while (tSec && (t = tRe.exec(tSec[1]))) tris.push(+attr(t[1], 'v1'), +attr(t[1], 'v2'), +attr(t[1], 'v3'));
      obj.verts = verts;
      obj.tris = tris;
    }
    const cRe = /<(?:\w+:)?component\b([^>]*)\/?>/g;
    let c;
    while ((c = cRe.exec(body))) obj.components.push({ id: attr(c[1], 'objectid'), m: parseMatrix(attr(c[1], 'transform')) });
    objects.set(id, obj);
  }
  // Build items (what is printed), each possibly made of components.
  const items = [];
  const build = /<(?:\w+:)?build\b[^>]*>([\s\S]*?)<\/(?:\w+:)?build>/.exec(xml);
  const iRe = /<(?:\w+:)?item\b([^>]*)\/?>/g;
  let it;
  while (build && (it = iRe.exec(build[1]))) items.push({ id: attr(it[1], 'objectid'), m: parseMatrix(attr(it[1], 'transform')) });
  if (!items.length) for (const o of objects.values()) if (o.verts) items.push({ id: o.id, m: IDENTITY });

  const out = [];
  for (const item of items) {
    const root = objects.get(item.id);
    if (!root) continue;
    const tris = [];
    const collect = (obj, mat, depth) => {
      if (!obj || depth > 16) return;
      if (obj.verts && obj.tris) {
        const V = obj.verts;
        const tp = (i) => {
          const x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2];
          return [x * mat[0] + y * mat[3] + z * mat[6] + mat[9], x * mat[1] + y * mat[4] + z * mat[7] + mat[10], x * mat[2] + y * mat[5] + z * mat[8] + mat[11]];
        };
        for (let i = 0; i < obj.tris.length; i += 3) tris.push(...tp(obj.tris[i]), ...tp(obj.tris[i + 1]), ...tp(obj.tris[i + 2]));
      }
      for (const c of obj.components) collect(objects.get(c.id), mulMatrix(c.m, mat), depth + 1);
    };
    collect(root, item.m, 0);
    if (tris.length) out.push({ name: root.name, soup: new Float32Array(tris) });
  }
  return out;
}

export async function read3MF(buffer) {
  const zip = await readZip(buffer);
  const modelName = zip.names.find((n) => /^3D\/.*\.model$/i.test(n)) || zip.names.find((n) => /\.model$/i.test(n));
  if (!modelName) throw new Error('No 3D model found in this 3MF file.');
  const xml = new TextDecoder().decode(await zip.read(modelName));
  const models = parse3MFModel(xml);
  if (!models.length) throw new Error('This 3MF file has no triangles.');
  return models;
}

const xmlEscape = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

export function write3MF(models) {
  const objs = [], items = [];
  models.forEach((m, k) => {
    const id = k + 1;
    const P = m.positions, I = m.indices;
    const v = [], t = [];
    for (let i = 0; i < P.length; i += 3) v.push(`<vertex x="${+P[i].toFixed(5)}" y="${+P[i + 1].toFixed(5)}" z="${+P[i + 2].toFixed(5)}"/>`);
    for (let i = 0; i < I.length; i += 3) t.push(`<triangle v1="${I[i]}" v2="${I[i + 1]}" v3="${I[i + 2]}"/>`);
    objs.push(`<object id="${id}" name="${xmlEscape(m.name)}" type="model"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object>`);
    items.push(`<item objectid="${id}"/>`);
  });
  const model =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    '<metadata name="Application">STL Mesh Editor</metadata>' +
    `<resources>${objs.join('')}</resources><build>${items.join('')}</build></model>`;
  const enc = new TextEncoder();
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
      ),
    },
    { name: '3D/3dmodel.model', data: enc.encode(model) },
  ]);
}
