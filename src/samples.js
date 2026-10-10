// Demo model: a round cake with candles, as ONE fused, watertight surface
// (no separate shells), built from voxels so it needs no boolean operations.
// Returns a triangle soup (9 floats per triangle).
export function cakeWithCandles({ radius = 18, height = 8, candles = 5, candleHeight = 12, unit = 1 } = {}) {
  const cx = radius, cy = radius;
  const size = [radius * 2 + 1, radius * 2 + 1, height + candleHeight];
  const filled = new Uint8Array(size[0] * size[1] * size[2]);
  const at = (x, y, z) => x + size[0] * (y + size[1] * z);
  const set = (x, y, z) => (filled[at(x, y, z)] = 1);

  for (let x = 0; x < size[0]; x++) {
    for (let y = 0; y < size[1]; y++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
      for (let z = 0; z < height; z++) set(x, y, z);
    }
  }
  // Candles: 2x2 columns standing on a ring.
  for (let i = 0; i < candles; i++) {
    const a = (2 * Math.PI * i) / candles;
    const x = Math.round(cx + radius * 0.55 * Math.cos(a)), y = Math.round(cy + radius * 0.55 * Math.sin(a));
    for (let z = height; z < height + candleHeight - 2; z++) {
      set(x, y, z); set(x + 1, y, z); set(x, y + 1, z); set(x + 1, y + 1, z);
    }
  }

  const isFilled = (x, y, z) =>
    x >= 0 && y >= 0 && z >= 0 && x < size[0] && y < size[1] && z < size[2] && filled[at(x, y, z)] === 1;

  // One quad per voxel face that borders empty space, wound outward.
  const faces = [
    { d: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { d: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
    { d: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
    { d: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { d: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
    { d: [0, 0, -1], c: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
  ];
  const out = [];
  for (let z = 0; z < size[2]; z++) {
    for (let y = 0; y < size[1]; y++) {
      for (let x = 0; x < size[0]; x++) {
        if (!isFilled(x, y, z)) continue;
        for (const { d, c } of faces) {
          if (isFilled(x + d[0], y + d[1], z + d[2])) continue;
          const v = c.map(([i, j, k]) => [(x + i - cx) * unit, (y + j - cy) * unit, (z + k) * unit]);
          out.push(...v[0], ...v[1], ...v[2], ...v[0], ...v[2], ...v[3]);
        }
      }
    }
  }
  return new Float32Array(out);
}
