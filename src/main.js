import * as THREE from 'three';
import { EditableMesh } from './mesh.js';
import { parseSTL, writeBinarySTL } from './stl.js';
import { Viewer } from './viewer.js';
import { segmentObjects } from './segment.js';
import { cakeWithCandles } from './samples.js';
import { makeZip } from './zip.js';

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

function download(data, name, type = 'model/stl') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const baseName = () => state.fileName.replace(/\.stl$/i, '');

$('export').addEventListener('click', () => {
  const { mesh } = state;
  download(writeBinarySTL(mesh.positions, mesh.indices), baseName() + '_edited.stl');
});

// Each separate shell of the mesh is a part, largest first.
function partMasks() {
  const { component, count, sizes } = state.mesh.connectedComponents();
  const order = [...Array(count).keys()].sort((a, b) => sizes[b] - sizes[a]);
  return order.map((c) => Uint8Array.from(component, (x) => (x === c ? 1 : 0)));
}

function partFile(mask, i) {
  const part = state.mesh.extractFaces(mask);
  return { name: `${baseName()}_part${i + 1}.stl`, data: new Uint8Array(writeBinarySTL(part.positions, part.indices)) };
}

$('export-zip').addEventListener('click', () => {
  const files = partMasks().map(partFile);
  download(makeZip(files), baseName() + '_parts.zip', 'application/zip');
});

$('export-each').addEventListener('click', async () => {
  const files = partMasks().map(partFile);
  for (const f of files) {
    download(f.data, f.name);
    await new Promise((r) => setTimeout(r, 400)); // browsers drop rapid back-to-back downloads
  }
});

function renderPartList() {
  const list = $('part-list');
  list.innerHTML = '';
  const masks = partMasks();
  // Parts with open edges are not watertight.
  const { offsets, heEdge } = state.mesh.topology();
  const openFace = new Uint8Array(state.mesh.triangleCount);
  for (let h = 0; h < heEdge.length; h++) {
    const e = heEdge[h];
    if (offsets[e + 1] - offsets[e] !== 2) openFace[(h / 3) | 0] = 1;
  }
  masks.forEach((mask, i) => {
    let tris = 0, open = false;
    mask.forEach((v, t) => {
      if (v) {
        tris++;
        if (openFace[t]) open = true;
      }
    });
    const li = document.createElement('li');
    li.title = 'Click to select this part';
    li.innerHTML = `<span class="name">Part ${i + 1}</span>
      <span class="meta">${tris.toLocaleString()} tris${open ? ' · <span class="bad">open</span>' : ''}</span>
      <button title="Download this part">STL</button>`;
    li.addEventListener('click', (e) => {
      const faces = [];
      mask.forEach((v, t) => v && faces.push(t));
      applyFaces(faces, modeFor(e, 'replace'));
    });
    li.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      const f = partFile(mask, i);
      download(f.data, f.name);
    });
    list.append(li);
  });
  $('export-zip').disabled = $('export-each').disabled = masks.length < 1;
  $('export-zip').textContent = masks.length > 1 ? `Download all ${masks.length} parts (.zip)` : 'Download part (.zip)';
}

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

// Runs an undoable geometry change. fn may return a message, or
// { message, selection } to select faces of the changed mesh afterwards.
function edit(fn) {
  if (!state.mesh) return;
  const before = state.mesh.snapshot();
  const result = fn(state.mesh);
  const { message, selection } = typeof result === 'object' && result ? result : { message: result };
  if (state.mesh.indices !== before.indices) {
    state.undo.push(before);
    if (state.undo.length > 50) state.undo.shift();
    state.redo = [];
    refresh();
  }
  if (selection) {
    state.selection.set(selection);
    selectionChanged();
  }
  if (message) toast(message);
}

// Block tool: cut along the rectangle's edges through the whole model and
// select the block inside.
function cutBlock(rect, mode) {
  const planes = viewer.rectPlanes(rect.x0, rect.y0, rect.x1, rect.y1);
  const oldSelection = state.selection;
  edit((mesh) => {
    const before = mesh.snapshot();
    const origin = mesh.cutByPlanes(planes); // new face -> face before the cut
    const inside = mesh.facesInsidePlanes(planes);
    if (!inside.some((v) => v)) {
      mesh.restore(before);
      toast('Nothing inside the rectangle');
      return;
    }
    const selection = new Uint8Array(mesh.triangleCount);
    for (let t = 0; t < selection.length; t++) {
      const was = oldSelection[origin ? origin[t] : t];
      selection[t] = mode === 'replace' ? inside[t] : mode === 'add' ? was | inside[t] : was & !inside[t];
    }
    return { selection, message: origin ? 'Cut along the rectangle and selected the block' : 'Selected the block' };
  });
}

function splitSelection() {
  if (!countSelected()) return;
  const selection = state.selection;
  edit((mesh) => {
    const r = mesh.splitOff(selection, { close: $('split-close').checked });
    if (!r.detached) {
      toast('The selection is already a separate part');
      return;
    }
    const closed = r.closed ? `, closed ${r.closed} cut face(s)` : '';
    return { selection, message: `Split into a new part${closed}` };
  });
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
$('split').addEventListener('click', splitSelection);
$('fill').addEventListener('click', closeHoles);
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('frame').addEventListener('click', () => viewer.frame());
$('show-boundary').addEventListener('change', (e) => viewer.setBoundariesVisible(e.target.checked));
$('show-wire').addEventListener('change', (e) => viewer.setWireframe(e.target.checked));
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => viewer.setView(b.dataset.view));
$('projection').addEventListener('change', (e) => viewer.setProjection(e.target.value));
$('rotate-mode').addEventListener('change', (e) => viewer.controls.setMode(e.target.value));

// Geometry changed: rebuild everything and clear the selection.
function refresh({ frame = false } = {}) {
  const { mesh } = state;
  state.selection = new Uint8Array(mesh.triangleCount);
  viewer.setMesh(mesh, state.selection, { frame });
  analyzeObjects();
  updateStats();
  renderPartList();
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
  $('split').disabled = !selected;
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
  // Object numbers change whenever the model is re-analysed, so earlier AI
  // results no longer apply.
  if (state.ai) $('ai-summary').textContent = 'The model changed – ask the AI again to update the names.';
  state.ai = null;
  $('ai-select-remove').hidden = true;
  applyObjectColors();
  renderObjectList();
}

function applyObjectColors() {
  viewer.setObjects(state.seg.objectOf, $('obj-colors').checked ? state.objectColors : null);
  viewer.setSelection(state.selection);
}

// Rows of the objects list: one per detected object, or – after an AI
// analysis – one per AI item (which can group several objects), followed by
// any objects the AI did not mention.
function objectRows() {
  const { objects } = state.seg;
  const rows = [];
  const covered = new Set();
  for (const item of state.ai?.items || []) {
    rows.push({ ids: item.object_ids, name: item.name, suggestion: item.suggestion, title: `${item.description}\n\n${item.reason}` });
    item.object_ids.forEach((id) => covered.add(id));
  }
  for (const o of objects.slice(0, MAX_LISTED)) {
    if (covered.has(o.id)) continue;
    rows.push({ ids: [o.id], name: o.id === 0 ? 'Main body' : `Object ${o.id}` });
  }
  return rows;
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
  }
  state.rows = objectRows();
  state.rowOfObject = new Map();
  state.rows.forEach((row, r) => row.ids.forEach((id) => state.rowOfObject.set(id, r)));
  if (objects.length === 1 && !state.ai) return;

  for (const row of state.rows) {
    const triangles = row.ids.reduce((n, id) => n + objects[id].triangles, 0);
    const pct = row.ids.reduce((n, id) => n + objects[id].share, 0) * 100;
    const li = document.createElement('li');
    li.title = (row.title ? row.title + '\n\n' : '') + 'Click to select (Shift adds, Ctrl removes)';
    li.innerHTML = `<span class="swatch"></span><span class="name"></span>
      ${row.suggestion && row.suggestion !== 'keep' ? `<span class="badge ${row.suggestion}">${row.suggestion}</span>` : ''}
      <span class="meta">${triangles.toLocaleString()} tris · ${pct < 0.1 ? '<0.1' : pct.toFixed(1)}%</span>
      <button title="Delete">✕</button>`;
    li.querySelector('.swatch').style.background = '#' + state.objectColors[row.ids[0]].getHexString();
    li.querySelector('.name').textContent = row.name + (row.ids.length > 1 ? ` (${row.ids.length} parts)` : '');
    li.addEventListener('mouseenter', () => setHoverObjects(row.ids));
    li.addEventListener('mouseleave', () => setHoverObjects([]));
    li.addEventListener('click', (e) => selectObjects(row.ids, modeFor(e, 'replace')));
    li.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      selectObjects(row.ids, 'replace');
      deleteSelected();
    });
    list.append(li);
  }
  if (objects.length > MAX_LISTED) note(`+ ${objects.length - MAX_LISTED} smaller objects (use the Object tool to pick them)`);
}

// Objects that belong to the same list row as `id` (AI groups several).
function rowObjects(id) {
  const r = state.rowOfObject?.get(id);
  return r === undefined ? [id] : state.rows[r].ids;
}

function setHoverObjects(ids) {
  if (!state.seg) return;
  const old = viewer.hoverObjects;
  const next = new Set(ids);
  if (old.size === next.size && [...next].every((id) => old.has(id))) return;
  viewer.hoverObjects = next;
  for (const id of new Set([...old, ...next])) viewer.updateFaces(state.seg.facesOf(id), state.selection);
}

function selectObjects(ids, mode) {
  const faces = [];
  for (const id of ids) for (const t of state.seg.facesOf(id)) faces.push(t);
  applyFaces(faces, mode);
}

$('obj-angle').addEventListener('input', (e) => ($('obj-angle-val').textContent = e.target.value + '°'));
$('obj-angle').addEventListener('change', () => state.mesh && busy(analyzeObjects));
$('obj-colors').addEventListener('change', () => state.mesh && applyObjectColors());

// ---------------------------------------------------------------------------
// AI analysis: render labelled views, send them to the server (server/ai.js)

const AI_VIEWS = [
  ['front-left, from above', [0.55, -0.75, 0.45]],
  ['back-right, from above', [-0.55, 0.75, 0.45]],
  ['top-down', [0, 0, 1]],
  ['front', [0, -1, 0.12]],
];

function describeObjects(ids) {
  const { mesh } = state;
  const p = mesh.positions, ind = mesh.indices;
  return ids.map((id) => {
    const o = state.seg.objects[id];
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const t of state.seg.facesOf(id)) {
      for (let k = 0; k < 3; k++) {
        const v = ind[t * 3 + k] * 3;
        for (let a = 0; a < 3; a++) {
          if (p[v + a] < min[a]) min[a] = p[v + a];
          if (p[v + a] > max[a]) max[a] = p[v + a];
        }
      }
    }
    return {
      id,
      triangles: o.triangles,
      share: o.share,
      size: max.map((v, a) => v - min[a]),
      center: max.map((v, a) => (v + min[a]) / 2),
    };
  });
}

// One JPEG view with every listed object labelled "#id" where it is visible.
function labelledView(dir, ids) {
  const { pixels, faces, size } = viewer.captureView(dir, 768);
  const wanted = new Set(ids);
  const count = new Map(), sumX = new Map(), sumY = new Map();
  for (let i = 0; i < faces.length; i++) {
    if (faces[i] < 0) continue;
    const id = state.seg.objectOf[faces[i]];
    if (!wanted.has(id)) continue;
    count.set(id, (count.get(id) || 0) + 1);
    sumX.set(id, (sumX.get(id) || 0) + (i % size));
    sumY.set(id, (sumY.get(id) || 0) + ((i / size) | 0));
  }
  // Put each label on the object's visible pixel nearest its visible centre.
  const anchors = new Map();
  for (const [id, n] of count) {
    if (n < 40) continue;
    const cx = sumX.get(id) / n, cy = sumY.get(id) / n;
    let best = Infinity, bx = 0, by = 0;
    for (let i = 0; i < faces.length; i += 3) {
      if (faces[i] < 0 || state.seg.objectOf[faces[i]] !== id) continue;
      const x = i % size, y = (i / size) | 0;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < best) { best = d; bx = x; by = y; }
    }
    anchors.set(id, [bx, by]);
  }

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(pixels, size, size), 0, 0);
  ctx.font = 'bold 18px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [id, [x, y]] of anchors) {
    const text = '#' + id;
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(x - w / 2, y - 12, w, 24);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x, y);
  }
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
}

async function askAI() {
  if (!state.mesh) return;
  const ids = state.seg.objects.slice(0, MAX_LISTED).map((o) => o.id);
  const button = $('ai-run');
  button.disabled = true;
  button.textContent = 'Asking AI…';
  $('ai-summary').textContent = 'Rendering views and asking the AI – this can take a minute.';
  try {
    // Render with object colours on and no selection, whatever the UI shows.
    setHoverObjects([]);
    viewer.setObjects(state.seg.objectOf, state.objectColors);
    viewer.setSelection(new Uint8Array(state.mesh.triangleCount));
    const images = AI_VIEWS.map(([view, dir]) => ({ view, data: labelledView(dir, ids) }));
    applyObjectColors();

    const seg = state.seg;
    const res = await fetch('./api/ai/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images, objects: describeObjects(ids), fileName: state.fileName, goal: $('ai-goal').value }),
    });
    const data = await res.json().catch(() => ({ error: `Server error ${res.status}` }));
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    if (state.seg !== seg) return; // model changed while waiting
    state.ai = data;
    $('ai-summary').textContent = data.model_description + (data.tips.length ? ' ' + data.tips.join(' ') : '');
    $('ai-select-remove').hidden = !data.items.some((i) => i.suggestion === 'remove');
    renderObjectList();
  } catch (err) {
    applyObjectColors();
    $('ai-summary').textContent = 'AI analysis failed: ' + (err.message || err);
  } finally {
    button.disabled = false;
    button.textContent = 'Ask AI to identify objects';
  }
}

$('ai-run').addEventListener('click', askAI);
$('ai-goal').addEventListener('keydown', (e) => e.key === 'Enter' && askAI());
$('ai-select-remove').addEventListener('click', () => {
  const ids = (state.ai?.items || []).filter((i) => i.suggestion === 'remove').flatMap((i) => i.object_ids);
  selectObjects(ids, 'replace');
});

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
  setHoverObjects([]);
  for (const b of document.querySelectorAll('#tools button')) b.classList.toggle('active', b.dataset.tool === tool);
  for (const o of document.querySelectorAll('.option[data-for]')) o.classList.toggle('shown', o.dataset.for === tool);
  updateControls();
}

function updateControls() {
  const orbit = state.tool === 'orbit' || orbitOverride;
  viewer.controls.buttons = {
    0: orbit ? 'rotate' : null,
    1: 'pan',
    2: state.tool === 'orbit' ? 'pan' : 'rotate',
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
    setHoverObjects(face < 0 ? [] : rowObjects(state.seg.objectOf[face]));
  }
  if (!drag) return;
  if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 3) drag.moved = true;
  if (state.tool === 'brush') brushAt(p, drag.mode);
  if (state.tool === 'box' || state.tool === 'block') {
    boxRect.classList.toggle('block', state.tool === 'block');
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
  setHoverObjects([]);
});

canvas.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const p = localPos(e);
  const { start, mode, moved } = drag;
  drag = null;
  const tool = state.tool;

  if (tool === 'block') {
    boxRect.style.display = 'none';
    if (moved) cutBlock({ x0: start.x, y0: start.y, x1: p.x, y1: p.y }, mode);
    return;
  }
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
    selectObjects(rowObjects(state.seg.objectOf[face]), mode);
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

const toolKeys = { 1: 'orbit', 2: 'click', 3: 'brush', 4: 'box', 5: 'part', 6: 'region', 7: 'object', 8: 'block' };

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
  } else if (e.key.toLowerCase() === 's') {
    splitSelection();
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
