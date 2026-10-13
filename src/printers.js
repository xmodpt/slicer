// Resin printer profiles: the build area (X × Y on the plate, Z height) in mm.
// Figures are the makers' published build volumes; check yours in its manual
// – any profile can be copied and edited, or a custom one added.

export const PRINTERS = [
  { id: 'anycubic-mono-4', brand: 'Anycubic', name: 'Photon Mono 4', x: 153.4, y: 87, z: 165 },
  { id: 'anycubic-m5s', brand: 'Anycubic', name: 'Photon Mono M5s', x: 218.88, y: 122.88, z: 200 },
  { id: 'anycubic-m7-pro', brand: 'Anycubic', name: 'Photon Mono M7 Pro', x: 223.78, y: 126.38, z: 230 },
  { id: 'anycubic-m7-max', brand: 'Anycubic', name: 'Photon Mono M7 Max', x: 298, y: 164, z: 300 },
  { id: 'anycubic-x-6ks', brand: 'Anycubic', name: 'Photon Mono X 6Ks', x: 195.84, y: 122.4, z: 200 },
  { id: 'elegoo-mars-4-ultra', brand: 'Elegoo', name: 'Mars 4 Ultra', x: 153.36, y: 77.76, z: 165 },
  { id: 'elegoo-mars-5-ultra', brand: 'Elegoo', name: 'Mars 5 Ultra', x: 153.36, y: 77.76, z: 165 },
  { id: 'elegoo-saturn-3-ultra', brand: 'Elegoo', name: 'Saturn 3 Ultra', x: 218.88, y: 122.88, z: 260 },
  { id: 'elegoo-saturn-4-ultra', brand: 'Elegoo', name: 'Saturn 4 Ultra', x: 211.68, y: 118.37, z: 220 },
  { id: 'elegoo-jupiter-se', brand: 'Elegoo', name: 'Jupiter SE', x: 277.85, y: 156.26, z: 300 },
  { id: 'phrozen-mini-8k-s', brand: 'Phrozen', name: 'Sonic Mini 8K S', x: 165, y: 72, z: 180 },
  { id: 'phrozen-mighty-revo', brand: 'Phrozen', name: 'Sonic Mighty Revo', x: 223, y: 126, z: 235 },
  { id: 'phrozen-mega-8k-s', brand: 'Phrozen', name: 'Sonic Mega 8K S', x: 330, y: 185, z: 400 },
  { id: 'creality-halot-mage-s', brand: 'Creality', name: 'Halot-Mage S', x: 228, y: 128, z: 230 },
  { id: 'creality-halot-one', brand: 'Creality', name: 'Halot-One', x: 127, y: 80, z: 160 },
  { id: 'uniformation-gktwo', brand: 'Uniformation', name: 'GKtwo', x: 228, y: 128, z: 245 },
];

const KEY_SELECTED = 'stl-editor.printer';
const KEY_CUSTOM = 'stl-editor.printers.custom';

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export function customPrinters() {
  const list = read(KEY_CUSTOM, []);
  return Array.isArray(list) ? list.filter(validPrinter) : [];
}

export function allPrinters() {
  return [...PRINTERS, ...customPrinters()];
}

export function validPrinter(p) {
  return p && typeof p.id === 'string' && [p.x, p.y, p.z].every((v) => Number.isFinite(+v) && +v > 0);
}

// The chosen printer, or null (no printer: a plain grid).
export function selectedPrinter() {
  const id = read(KEY_SELECTED, null);
  return allPrinters().find((p) => p.id === id) || null;
}
export function selectPrinter(id) {
  write(KEY_SELECTED, id);
}

// Adds or replaces a custom profile; returns it.
export function saveCustomPrinter({ id, name, x, y, z }) {
  const list = customPrinters();
  const p = { id: id || 'custom-' + Date.now().toString(36), brand: 'Custom', name: String(name || 'My printer').slice(0, 60), x: +x, y: +y, z: +z };
  if (!validPrinter(p)) throw new Error('Width, depth and height must be numbers above 0.');
  const i = list.findIndex((q) => q.id === p.id);
  if (i >= 0) list[i] = p;
  else list.push(p);
  write(KEY_CUSTOM, list);
  return p;
}
export function deleteCustomPrinter(id) {
  write(KEY_CUSTOM, customPrinters().filter((p) => p.id !== id));
}

// Does a bounding box fit the printer's build area (centred on the origin,
// standing on Z = 0)? Returns { fits, over: [dx, dy, dz] } – how far it sticks
// out on each axis (0 = fine).
export function fitCheck(printer, bounds, eps = 1e-3) {
  const { min, max } = bounds;
  const hx = printer.x / 2, hy = printer.y / 2;
  const over = [
    Math.max(0, max[0] - hx, -hx - min[0]),
    Math.max(0, max[1] - hy, -hy - min[1]),
    Math.max(0, max[2] - printer.z, -min[2]),
  ].map((v) => (v > eps ? v : 0));
  return { fits: over.every((v) => v === 0), over };
}
