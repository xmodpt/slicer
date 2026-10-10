// STL reading and writing.
//
// parseSTL() returns a "triangle soup": a Float32Array with 9 floats
// (3 vertices * xyz) per triangle. Normals stored in the file are ignored;
// orientation is taken from the vertex winding, as most tools do.

export function parseSTL(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  if (isBinarySTL(bytes)) return parseBinary(bytes);
  return parseASCII(bytes);
}

function isBinarySTL(bytes) {
  if (bytes.byteLength < 84) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  if (84 + count * 50 === bytes.byteLength) return true;
  // Not an exact size match: treat as ASCII only if it looks like one.
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(1024, bytes.byteLength)));
  return !(/^\s*solid/i.test(head) && /facet/i.test(head));
}

function parseBinary(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(80, true);
  const count = Math.min(declared, Math.floor((bytes.byteLength - 84) / 50));
  const out = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    const base = 84 + t * 50 + 12; // skip normal
    for (let k = 0; k < 9; k++) out[t * 9 + k] = view.getFloat32(base + k * 4, true);
  }
  return out;
}

function parseASCII(bytes) {
  const text = new TextDecoder().decode(bytes);
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  const values = [];
  let m;
  while ((m = re.exec(text)) !== null) values.push(+m[1], +m[2], +m[3]);
  const triFloats = values.length - (values.length % 9);
  if (triFloats === 0) throw new Error('No triangles found – is this a valid STL file?');
  return new Float32Array(values.slice(0, triFloats));
}

// Writes a binary STL from indexed geometry.
export function writeBinarySTL(positions, indices, header = 'stl-mesh-editor') {
  const count = indices.length / 3;
  const buffer = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buffer);
  const headerBytes = new TextEncoder().encode(header.slice(0, 80));
  new Uint8Array(buffer, 0, headerBytes.length).set(headerBytes);
  view.setUint32(80, count, true);

  let o = 84;
  for (let t = 0; t < count; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    view.setFloat32(o, nx, true); view.setFloat32(o + 4, ny, true); view.setFloat32(o + 8, nz, true);
    o += 12;
    for (const v of [a, b, c]) {
      view.setFloat32(o, positions[v], true);
      view.setFloat32(o + 4, positions[v + 1], true);
      view.setFloat32(o + 8, positions[v + 2], true);
      o += 12;
    }
    o += 2; // attribute byte count
  }
  return buffer;
}
