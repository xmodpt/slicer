import * as THREE from 'three';
import { EditableMesh } from './mesh.js';
import { parseSTL, writeBinarySTL } from './stl.js';
import { Viewer } from './viewer.js';
import { segmentObjects } from './segment.js';
import { cakeWithCandles } from './samples.js';

const $ = (id) => document.getElementById(id);
const view = $('view');
const viewer = new Viewer(view);

const state = {
  mesh: null,
  selection: new Uint8Array(0),
  fileName: 'model.stl',
  tool: 'object',
  seg: null, // detected objects, see segment.js
  objectColors: [],
  undo: [],
  redo: [],
};

// ---------------------------------------------------------------------------
// Loading / saving

async function busy(fn) {
  $('busy').style.display = 'block';
  await new Promise((r) => setTimeout(r, 20)); // let the indicator paint
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toast(err.message || String(err));
  } finally {
    $('busy').style.display = 'none';
  }
}

function loadSoup(soup, name) {
  const mesh = EditableMesh.fromSoup(soup);
  if (!mesh.triangleCount) throw new Error('The file contains no triangles.');
  state.mesh = mesh;
  state.fileName = name;
  state.undo = [];
  state.redo = [];
  $('file-name').textContent = name;
  $('drop-hint').style.display = 'none';
  refresh({ frame: true });
}

function openFile(file) {
  return busy(async () => loadSoup(parseSTL(await file.arrayBuffer()), file.name));
}

$('file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) openFile(file);
  e.target.value = '';
});

$('sample').addEventListener('click', () =>
  busy(() => {
    loadSoup(cakeWithCandles(), 'cake-with-candles.stl');
  }),
);

$('export').addEventListener('click', () => {
  const { mesh } = state;
  const data = writeBinarySTL(mesh.positions, mesh.indices);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'model/stl' }));
  a.download = state.fileName.replace(/\.stl$/i, '') + '_edited.stl';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const file = [...e.dataTransfer.files].find((f) => /\.stl$/i.test(f.name)) || e.dataTransfer.files[0];
  if (file) openFile(file);
});

// ---------------------------------------------------------------------------
// Edits (undoable)

function edit(fn) {
  if (!state.mesh) return;
  const before = state.mesh.snapshot();
  const message = fn(state.mesh);
  if (state.mesh.indices === before.indices) return; // nothing changed
  state.undo.push(before);
  if (state.undo.length > 50) state.undo.shift();
  state.redo = [];
  refresh();
  if (message) toast(message);
}

function deleteSelected() {
  if (!countSelected()) return;
  edit((mesh) => {
    const removed = mesh.deleteFaces(state.selection);
    return `Deleted ${removed.toLocaleString()} triangles`;
  });
}

function closeHoles() {
  const maxEdges = $('limit-holes').checked ? Math.max(3, +$('max-edges').value || 3) : Infinity;
  edit((mesh) => {
    const r = mesh.fillHoles({ maxEdges });
    if (!r.filled) {
      toast(r.skipped ? `No holes within the size limit (${r.skipped} larger)` : 'No holes to close');
      return;
    }
    const skipped = r.skipped ? `, ${r.skipped} larger hole(s) left open` : '';
    return `Closed ${r.filled} hole(s) with ${r.added.toLocaleString()} triangles${skipped}`;
  });
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(state.mesh.snapshot());
  state.mesh.restore(state.undo.pop());
  refresh();
}

function redo() {
  if (!state.redo.length) return;
  state.undo.push(state.mesh.snapshot());
  state.mesh.restore(state.redo.pop());
  refresh();
}

$('delete').addEventListener('click', deleteSelected);
$('fill').addEventListener('click', closeHoles);
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('frame').addEventListener('click', () => viewer.frame());
$('show-boundary').addEventListener('change', (e) => viewer.setBoundariesVisible(e.target.checked));
$('show-wire').addEventListener('change', (e) => viewer.setWireframe(e.target.checked));

// Geometry changed: rebuild everything and clear the selection.
function refresh({ frame = false } = {}) {
  const { mesh } = state;
  state.selection = new Uint8Array(mesh.triangleCount);
  viewer.setMesh(mesh, state.selection, { frame });
  analyzeObjects();
  updateStats();
  updateButtons();
}

function updateStats() {
  const s = state.mesh.stats();
  const status = s.watertight
    ? '<span class="good">Closed (watertight)</span>'
    : s.holes || s.openChains
      ? `<span class="bad">Open</span>`
      : `<span class="bad">Non-manifold</span>`;
  const rows = [
    ['Status', status],
    ['Triangles', s.triangles.toLocaleString()],
    ['Vertices', s.vertices.toLocaleString()],
    ['Holes', s.holes + (s.openChains ? ` (+${s.openChains} unclosable)` : '')],
    ['Parts', s.parts],
    ['Non-manifold edges', s.nonManifoldEdges],
    ['Selected', `<span id="sel-count">0</span>`],
  ];
  $('stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  state.holes = s.holes;
}

function countSelected() {
  let n = 0;
  for (const v of state.selection) n += v;
  return n;
}

function updateButtons() {
  const has = !!state.mesh;
  const selected = has ? countSelected() : 0;
  $('export').disabled = !has;
  $('delete').disabled = !selected;
  $('fill').disabled = !has || !state.holes;
  $('undo').disabled = !state.undo.length;
  $('redo').disabled = !state.redo.length;
  const el = $('sel-count');
  if (el) el.textContent = selected.toLocaleString();
}

// ---------------------------------------------------------------------------
// Detected objects

const MAX_LISTED = 40;
const OBJECT_PALETTE = [0x6fa8ff, 0x7bd88f, 0xd78fe8, 0xf2d464, 0x5fd3d0, 0xff8fa3, 0xa3a0ff, 0xb7e06a, 0x8fc7ff, 0xe6a4d8];

function analyzeObjects() {
  const { mesh } = state;
  state.seg = segmentObjects(mesh, { concaveAngle: +$('obj-angle').value });
  state.objectColors = state.seg.objects.map((o, i) =>
    // The main body keeps the model colour; the rest cycle through a palette
    // that avoids the orange used for the selection.
    new THREE.Color(i === 0 ? 0xb9c0cc : OBJECT_PALETTE[(i - 1) % OBJECT_PALETTE.length]),
  );
  applyObjectColors();
  renderObjectList();
}

function applyObjectColors() {
  viewer.setObjects(state.seg.objectOf, $('obj-colors').checked ? state.objectColors : null);
  viewer.setSelection(state.selection);
}

function renderObjectList() {
  const list = $('object-list');
  list.innerHTML = '';
  const { objects } = state.seg;
  const note = (text) => {
    const li = document.createElement('li');
    li.className = 'note';
    li.textContent = text;
    list.append(li);
  };
  if (objects.length === 1) {
    note('Only one object found. Lower the crease angle to split the model further.');
    return;
  }
  for (const o of objects.slice(0, MAX_LISTED)) {
    const li = document.createElement('li');
    li.title = 'Click to select (Shift adds, Ctrl removes)';
    const pct = o.share * 100;
    li.innerHTML = `<span class="swatch"></span><span class="name"></span>
      <span class="meta">${o.triangles.toLocaleString()} tris · ${pct < 0.1 ? '<0.1' : pct.toFixed(1)}%</span>
      <button title="Delete this object">✕</button>`;
    li.querySelector('.swatch').style.background = '#' + state.objectColors[o.id].getHexString();
    li.querySelector('.name').textContent = o.id === 0 ? 'Main body' : `Object ${o.id}`;
    li.addEventListener('mouseenter', () => setHoverObject(o.id));
    li.addEventListener('mouseleave', () => setHoverObject(-1));
    li.addEventListener('click', (e) => selectObject(o.id, modeFor(e, 'replace')));
    li.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      selectObject(o.id, 'replace');
      deleteSelected();
    });
    list.append(li);
  }
  if (objects.length > MAX_LISTED) note(`+ ${objects.length - MAX_LISTED} smaller objects (use the Object tool to pick them)`);
}

function setHoverObject(id) {
  if (!state.seg || viewer.hoverObject === id) return;
  const old = viewer.hoverObject;
  viewer.hoverObject = id;
  for (const o of [old, id]) if (o >= 0) viewer.updateFaces(state.seg.facesOf(o), state.selection);
}

function selectObject(id, mode) {
  applyFaces(state.seg.facesOf(id), mode);
}

$('obj-angle').addEventListener('input', (e) => ($('obj-angle-val').textContent = e.target.value + '°'));
$('obj-angle').addEventListener('change', () => state.mesh && busy(analyzeObjects));
$('obj-colors').addEventListener('change', () => state.mesh && applyObjectColors());

// ---------------------------------------------------------------------------
// Selection

function selectionChanged(faces) {
  if (faces) viewer.updateFaces(faces, state.selection);
  else viewer.setSelection(state.selection);
  updateButtons();
}

function applyFaces(faces, mode) {
  const sel = state.selection;
  if (mode === 'replace') sel.fill(0);
  const v = mode === 'remove' ? 0 : 1;
  for (const t of faces) sel[t] = v;
  selectionChanged(mode === 'replace' ? null : faces);
}

function modeFor(e, fallback) {
  if (e.ctrlKey || e.metaKey) return 'remove';
  if (e.shiftKey) return 'add';
  return fallback;
}

const selectionCommands = {
  all: () => state.selection.fill(1),
  none: () => state.selection.fill(0),
  invert: () => state.selection.forEach((v, i, a) => (a[i] = v ? 0 : 1)),
  grow: () => state.mesh.growSelection(state.selection),
  shrink: () => state.mesh.shrinkSelection(state.selection),
};

function runSelection(name) {
  if (!state.mesh) return;
  selectionCommands[name]();
  selectionChanged();
}

for (const name of Object.keys(selectionCommands)) $('sel-' + name).addEventListener('click', () => runSelection(name));

// ---------------------------------------------------------------------------
// Tools and pointer interaction

const brushCursor = $('brush-cursor');
const boxRect = $('box-rect');
let orbitOverride = false; // Alt held

function setTool(tool) {
  state.tool = tool;
  setHoverObject(-1);
  for (const b of document.querySelectorAll('#tools button')) b.classList.toggle('active', b.dataset.tool === tool);
  for (const o of document.querySelectorAll('.option[data-for]')) o.classList.toggle('shown', o.dataset.for === tool);
  updateControls();
}

function updateControls() {
  const orbit = state.tool === 'orbit' || orbitOverride;
  viewer.controls.mouseButtons = {
    LEFT: orbit ? THREE.MOUSE.ROTATE : -1,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: orbit && state.tool === 'orbit' ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE,
  };
  view.style.cursor = orbit ? 'grab' : state.tool === 'brush' ? 'none' : state.tool === 'object' ? 'pointer' : 'crosshair';
  if (orbit) brushCursor.style.display = 'none';
}

for (const b of document.querySelectorAll('#tools button')) b.addEventListener('click', () => setTool(b.dataset.tool));

$('region-angle').addEventListener('input', (e) => ($('region-angle-val').textContent = e.target.value + '°'));

const canvas = viewer.canvas;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

let drag = null;

function localPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function brushAt(p, mode) {
  const faces = viewer.facesInCircle(p.x, p.y, +$('brush-size').value / 2);
  applyFaces(faces, mode);
}

function moveBrushCursor(p) {
  const size = +$('brush-size').value;
  Object.assign(brushCursor.style, {
    display: 'block',
    left: p.x + 'px',
    top: p.y + 'px',
    width: size + 'px',
    height: size + 'px',
  });
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !state.mesh || state.tool === 'orbit' || orbitOverride) return;
  const p = localPos(e);
  canvas.setPointerCapture(e.pointerId);
  drag = { start: p, mode: modeFor(e, state.tool === 'brush' ? 'add' : 'replace'), moved: false };
  if (state.tool === 'brush') brushAt(p, drag.mode);
});

canvas.addEventListener('pointermove', (e) => {
  const p = localPos(e);
  if (state.tool === 'brush' && !orbitOverride) moveBrushCursor(p);
  if (state.tool === 'object' && state.seg && e.buttons === 0) {
    const face = viewer.faceAt(p.x, p.y);
    setHoverObject(face < 0 ? -1 : state.seg.objectOf[face]);
  }
  if (!drag) return;
  if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 3) drag.moved = true;
  if (state.tool === 'brush') brushAt(p, drag.mode);
  if (state.tool === 'box') {
    Object.assign(boxRect.style, {
      display: 'block',
      left: Math.min(p.x, drag.start.x) + 'px',
      top: Math.min(p.y, drag.start.y) + 'px',
      width: Math.abs(p.x - drag.start.x) + 'px',
      height: Math.abs(p.y - drag.start.y) + 'px',
    });
  }
});

canvas.addEventListener('pointerleave', () => {
  brushCursor.style.display = 'none';
  setHoverObject(-1);
});

canvas.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const p = localPos(e);
  const { start, mode, moved } = drag;
  drag = null;
  const tool = state.tool;

  if (tool === 'box') {
    boxRect.style.display = 'none';
    if (!moved) {
      if (mode === 'replace') runSelection('none');
      return;
    }
    const faces = $('box-through').checked
      ? viewer.facesInRectThrough(start.x, start.y, p.x, p.y)
      : viewer.facesInRect(start.x, start.y, p.x, p.y);
    applyFaces(faces, mode);
    return;
  }
  if (tool === 'brush' || moved) return;

  const face = viewer.faceAt(p.x, p.y);
  if (face < 0) {
    if (mode === 'replace') runSelection('none');
    return;
  }
  if (tool === 'object') {
    selectObject(state.seg.objectOf[face], mode);
    return;
  }
  if (tool === 'click') {
    applyFaces([face], mode === 'replace' && state.selection[face] && countSelected() === 1 ? 'remove' : mode);
    return;
  }
  const mask = new Uint8Array(state.mesh.triangleCount);
  if (tool === 'part') state.mesh.selectConnected([face], mask);
  if (tool === 'region') state.mesh.selectSmoothRegion(face, +$('region-angle').value, mask);
  const faces = [];
  mask.forEach((v, i) => v && faces.push(i));
  applyFaces(faces, mode);
});

// ---------------------------------------------------------------------------
// Keyboard

const toolKeys = { 1: 'orbit', 2: 'click', 3: 'brush', 4: 'box', 5: 'part', 6: 'region', 7: 'object' };

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Alt') {
    orbitOverride = true;
    updateControls();
    e.preventDefault();
    return;
  }
  if (mod && e.key.toLowerCase() === 'z') {
    e.shiftKey ? redo() : undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    redo();
  } else if (mod && e.key.toLowerCase() === 'a') {
    runSelection('all');
  } else if (mod && e.key.toLowerCase() === 'i') {
    runSelection('invert');
  } else if (mod) {
    return;
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelected();
  } else if (e.key === 'Escape') {
    runSelection('none');
  } else if (e.key === '+' || e.key === '=') {
    runSelection('grow');
  } else if (e.key === '-') {
    runSelection('shrink');
  } else if (e.key.toLowerCase() === 'h') {
    if (state.mesh) closeHoles();
  } else if (e.key.toLowerCase() === 'f') {
    viewer.frame();
  } else if (toolKeys[e.key]) {
    setTool(toolKeys[e.key]);
  } else {
    return;
  }
  e.preventDefault();
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'Alt') {
    orbitOverride = false;
    updateControls();
  }
});
window.addEventListener('blur', () => {
  orbitOverride = false;
  updateControls();
});

// ---------------------------------------------------------------------------

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

setTool('object');
updateButtons();
