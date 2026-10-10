import * as THREE from 'three';
import { EditableMesh } from './mesh.js';
import { parseSTL, writeBinarySTL } from './stl.js';
import { Viewer } from './viewer.js';
import { segmentObjects } from './segment.js';
import { cakeWithCandles } from './samples.js';
import { makeZip } from './zip.js';
import { NavGizmo } from './gizmo.js';

const $ = (id) => document.getElementById(id);
const view = $('view');
const viewer = new Viewer(view);
new NavGizmo(view, viewer, { onProjectionChange: (kind) => ($('projection').value = kind) });

const state = {
  mesh: null,
  selection: new Uint8Array(0),
  fileName: 'model.stl',
  tool: 'object',
  seg: null, // detected objects, see segment.js
  hidden: null, // per-face mask of hidden ("layer off") triangles
  open: new Map(), // outliner rows expanded/collapsed by the user
  names: new Map(), // renamed sub-objects
  partNames: [],
  modelName: null,
  objectColors: [],
  undo: [],
  redo: [],
};

// ---------------------------------------------------------------------------
// Loading / saving

// Shows a step and its progress (0..1, or null for no bar) in the "working"
// indicator and lets the browser repaint, so slow steps are visible.
function stage(label, progress = null) {
  setProgress(label, progress);
  return new Promise((r) => setTimeout(r, 30));
}

function setProgress(label, progress) {
  if (label) $('busy-label').textContent = label;
  const bar = $('busy-bar');
  bar.hidden = progress === null;
  if (progress !== null) {
    const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
    $('busy-fill').style.width = pct + '%';
    $('busy-pct').textContent = pct + '%';
  }
}

function readFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
    reader.readAsArrayBuffer(file);
  });
}

async function busy(fn) {
  $('busy').style.display = 'block';
  await stage('Working…');
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toast(err.message || String(err));
    const name = $('file-name');
    name.textContent = 'Error: ' + (err.message || String(err));
    name.classList.add('error');
  } finally {
    $('busy').style.display = 'none';
    setProgress('Working…', null);
  }
}

// Progress while loading: reading 0-25%, joining 30-75%, drawing and analysis after.
async function loadSoup(soup, name) {
  const joining = `Joining ${(soup.length / 9).toLocaleString()} triangles…`;
  await stage(joining, 0.3);
  const mesh = await EditableMesh.fromSoupAsync(soup, { onProgress: (f) => setProgress(joining, 0.3 + f * 0.45) });
  if (!mesh.triangleCount) throw new Error('The file contains no triangles.');
  if ($('auto-place').checked) mesh.placeOnPlate();
  state.mesh = mesh;
  state.fileName = name;
  state.modelName = null;
  state.open = new Map();
  state.undo = [];
  state.redo = [];
  $('file-name').textContent = name;
  $('file-name').classList.remove('error');
  $('drop-hint').style.display = 'none';
  await stage('Drawing…', 0.78);
  state.selection = new Uint8Array(mesh.triangleCount);
  state.hidden = null;
  state.partNames = [];
  state.names = new Map();
  $('show-all').hidden = true;
  viewer.setMesh(mesh, state.selection, { frame: true });
  for (const [i, step] of ANALYSIS_STEPS.entries()) {
    await stage(step.label, 0.82 + (i / ANALYSIS_STEPS.length) * 0.18);
    runStep(step);
  }
  await stage('Done', 1);
  updatePlacement();
  updateButtons();
}

function openFile(file) {
  return busy(async () => {
    await stage('Reading file…', 0);
    const buffer = await readFile(file, (f) => setProgress('Reading file…', f * 0.25));
    await stage('Reading triangles…', 0.27);
    await loadSoup(parseSTL(buffer), file.name);
  });
}

$('file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) openFile(file);
  e.target.value = '';
});

$('sample').addEventListener('click', () =>
  busy(() => loadSoup(cakeWithCandles(), 'cake-with-candles.stl')),
);

function download(data, name, type = 'model/stl') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'model';
const baseName = () => safeName(modelName());

$('export').addEventListener('click', () => {
  const { mesh } = state;
  download(writeBinarySTL(mesh.positions, mesh.indices), baseName() + '_edited.stl');
});

const MAX_PARTS_LISTED = 50;

function partFile(part, i) {
  const m = state.mesh.extractFaceList(part.faces);
  const name = state.partNames[i] ? `${baseName()}_${safeName(state.partNames[i])}` : `${baseName()}_part${i + 1}`;
  return { name: name + '.stl', data: new Uint8Array(writeBinarySTL(m.positions, m.indices)) };
}

function exportableParts() {
  const parts = state.parts;
  if (parts.length > 100 && !confirm(`The model has ${parts.length} separate pieces – export ${parts.length} files?`)) return [];
  return parts;
}

$('export-zip').addEventListener('click', () => {
  const files = exportableParts().map(partFile);
  if (files.length) download(makeZip(files), baseName() + '_parts.zip', 'application/zip');
});

$('export-each').addEventListener('click', async () => {
  const files = exportableParts().map(partFile);
  for (const f of files) {
    download(f.data, f.name);
    await new Promise((r) => setTimeout(r, 400)); // browsers drop rapid back-to-back downloads
  }
});

function renderPartList() {
  const parts = (state.parts = state.mesh.parts());
  $('export-zip').disabled = $('export-each').disabled = parts.length < 1;
  $('export-zip').textContent = parts.length > 1 ? `Download all ${parts.length} parts (.zip)` : 'Download part (.zip)';
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
  state.moving = false;
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
  state.moving = false;
  state.redo.push(state.mesh.snapshot());
  state.mesh.restore(state.undo.pop());
  refresh();
}

function redo() {
  if (!state.redo.length) return;
  state.moving = false;
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

// Run after every geometry change, once the model is on screen.
const ANALYSIS_STEPS = [
  { label: 'Finding objects…', run: () => analyzeObjects() },
  { label: 'Checking for holes…', run: () => updateStats() },
  { label: 'Listing parts…', run: () => renderPartList() },
];

// A failing analysis step must not hide the model.
function runStep(step) {
  try {
    step.run();
  } catch (err) {
    console.error(err);
    window.__showFatal?.(`${step.label.replace('…', '')} failed: ${err.message}`);
  }
}

// Geometry changed: rebuild everything and clear the selection.
function refresh({ frame = false } = {}) {
  const { mesh } = state;
  state.hidden = null;
  state.partNames = [];
  state.names = new Map();
  $('show-all').hidden = true;
  state.selection = new Uint8Array(mesh.triangleCount);
  viewer.setMesh(mesh, state.selection, { frame });
  ANALYSIS_STEPS.forEach(runStep);
  updatePlacement();
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
  for (const o of objects) {
    if (covered.has(o.id)) continue;
    rows.push({ ids: [o.id], name: o.id === 0 ? 'Main body' : `Object ${o.id}` });
  }
  return rows;
}

// The outliner: the file as one group, its separate parts, and the detected
// sub-objects of each part. Rows select (Shift adds, Ctrl removes), highlight
// on hover, hide/show with the eye, collapse, and rename on double-click.
const MAX_CHILDREN = 40;

function renderObjectList() {
  const list = $('object-list');
  list.innerHTML = '';
  if (!state.mesh || !state.seg) return;
  const { objects, facesOf } = state.seg;
  const parts = (state.parts = state.mesh.parts());
  const partOf = new Int32Array(state.mesh.triangleCount);
  parts.forEach((part, i) => part.faces.forEach((t) => (partOf[t] = i)));

  state.rows = objectRows();
  state.rowOfObject = new Map();
  state.rows.forEach((row, r) => row.ids.forEach((id) => state.rowOfObject.set(id, r)));
  const rowsByPart = parts.map(() => []);
  for (const row of state.rows) rowsByPart[partOf[facesOf(row.ids[0])[0]]].push(row);

  const allIds = objects.length <= 2000 ? objects.map((o) => o.id) : [];
  const facesOfRow = (row) => {
    const out = [];
    for (const id of row.ids) for (const t of facesOf(id)) out.push(t);
    return out;
  };

  addTreeRow(list, {
    key: 'model',
    depth: 0,
    name: modelName(),
    rename: (v) => (state.modelName = v),
    meta: `${state.mesh.triangleCount.toLocaleString()} tris`,
    faces: () => null, // everything
    hoverIds: allIds,
    group: true,
    icon: '◆',
  });
  if (!isOpen('model', true)) return;

  const addObjects = (rows, depth) => {
    for (const row of rows.slice(0, MAX_CHILDREN)) {
      const triangles = row.ids.reduce((n, id) => n + objects[id].triangles, 0);
      const key = 'obj:' + row.ids[0];
      addTreeRow(list, {
        key,
        depth,
        name: state.names.get(key) || row.name + (row.ids.length > 1 ? ` (${row.ids.length} parts)` : ''),
        rename: (v) => state.names.set(key, v),
        meta: `${triangles.toLocaleString()} tris`,
        title: row.title,
        badge: row.suggestion && row.suggestion !== 'keep' ? row.suggestion : null,
        swatch: '#' + state.objectColors[row.ids[0]].getHexString(),
        faces: () => facesOfRow(row),
        hoverIds: row.ids,
        remove: true,
      });
    }
    if (rows.length > MAX_CHILDREN) treeNote(list, depth, `+ ${rows.length - MAX_CHILDREN} smaller objects (pick them with the Object tool)`);
  };

  if (parts.length === 1) {
    // One piece: its sub-objects sit directly under the model.
    if (rowsByPart[0].length > 1) addObjects(rowsByPart[0], 1);
    else treeNote(list, 1, 'No sub-objects found. Lower “Split at creases” to split the model further.');
    return;
  }
  parts.slice(0, MAX_PARTS_LISTED).forEach((part, i) => {
    const key = 'part:' + i;
    const rows = rowsByPart[i];
    addTreeRow(list, {
      key,
      depth: 1,
      name: partName(i),
      rename: (v) => (state.partNames[i] = v),
      meta: `${part.faces.length.toLocaleString()} tris${part.open ? ' · open' : ''}`,
      faces: () => part.faces,
      hoverIds: rows.flatMap((r) => r.ids),
      group: rows.length > 1,
      defaultOpen: parts.length <= 5,
      icon: '▣',
      download: () => {
        const f = partFile(part, i);
        download(f.data, f.name);
      },
      remove: true,
    });
    if (rows.length > 1 && isOpen(key, parts.length <= 5)) addObjects(rows, 2);
  });
  if (parts.length > MAX_PARTS_LISTED) {
    treeNote(list, 1, `+ ${parts.length - MAX_PARTS_LISTED} more small pieces` + (parts.length > 500 ? ' – the triangles in this file may not be connected to each other' : ''));
  }
}

function isOpen(key, fallback) {
  return state.open.has(key) ? state.open.get(key) : fallback;
}

function modelName() {
  return state.modelName || state.fileName.replace(/\.stl$/i, '');
}

function partName(i) {
  return state.partNames[i] || `Part ${i + 1}`;
}

function treeNote(list, depth, text) {
  const li = document.createElement('li');
  li.className = 'note';
  li.style.paddingLeft = 8 + depth * 16 + 'px';
  li.textContent = text;
  list.append(li);
}

function addTreeRow(list, row) {
  const li = document.createElement('li');
  li.className = 'tree-row' + (row.depth === 0 ? ' root' : '');
  li.style.paddingLeft = 4 + row.depth * 16 + 'px';
  li.title = (row.title ? row.title + '\n\n' : '') + 'Click to select · Shift adds · Ctrl removes · double-click the name to rename';
  const faces = () => row.faces() || allFaces();
  const hidden = isHidden(faces());
  const open = row.group && isOpen(row.key, row.defaultOpen ?? true);
  li.innerHTML = `
    <span class="caret">${row.group ? (open ? '▾' : '▸') : ''}</span>
    <button class="eye ${hidden ? 'off' : ''}" title="${hidden ? 'Show' : 'Hide'}">${hidden ? '◌' : '👁'}</button>
    ${row.swatch ? '<span class="swatch"></span>' : `<span class="icon">${row.icon || ''}</span>`}
    <span class="name"></span>
    ${row.badge ? `<span class="badge ${row.badge}">${row.badge}</span>` : ''}
    <span class="meta">${row.meta}</span>
    ${row.download ? '<button class="act" data-act="download" title="Download as STL">STL</button>' : ''}
    ${row.remove ? '<button class="act" data-act="remove" title="Delete">✕</button>' : ''}`;
  if (row.swatch) li.querySelector('.swatch').style.background = row.swatch;
  const name = li.querySelector('.name');
  name.textContent = row.name;
  if (hidden) li.classList.add('hidden-row');

  li.querySelector('.caret').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!row.group) return;
    state.open.set(row.key, !open);
    renderObjectList();
  });
  li.querySelector('.eye').addEventListener('click', (e) => {
    e.stopPropagation();
    setHiddenFaces(faces(), !hidden);
  });
  li.addEventListener('mouseenter', () => setHoverObjects(row.hoverIds));
  li.addEventListener('mouseleave', () => setHoverObjects([]));
  li.addEventListener('click', (e) => {
    if (row.depth === 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey) runSelection('all');
    else applyFaces(faces(), modeFor(e, 'replace'));
  });
  name.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    const input = document.createElement('input');
    input.className = 'rename';
    input.value = row.name;
    name.replaceWith(input);
    input.focus();
    input.select();
    const done = (save) => {
      if (save && input.value.trim()) row.rename(input.value.trim());
      renderObjectList();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') done(true);
      if (ev.key === 'Escape') done(false);
      ev.stopPropagation();
    });
    input.addEventListener('blur', () => done(true));
    input.addEventListener('click', (ev) => ev.stopPropagation());
  });
  li.querySelector('[data-act="download"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    row.download();
  });
  li.querySelector('[data-act="remove"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    applyFaces(faces(), 'replace');
    deleteSelected();
  });
  list.append(li);
}

function allFaces() {
  return Array.from({ length: state.mesh.triangleCount }, (_, i) => i);
}

// Hidden faces ("layers" turned off): not drawn, not pickable. Reset when the
// triangles change (delete, split, close holes…).
function isHidden(faces) {
  const h = state.hidden;
  if (!h || !faces.length) return false;
  for (const t of faces) if (!h[t]) return false;
  return true;
}

function setHiddenFaces(faces, hide) {
  if (!state.hidden) state.hidden = new Uint8Array(state.mesh.triangleCount);
  for (const t of faces) state.hidden[t] = hide ? 1 : 0;
  viewer.setHidden(state.mesh, state.hidden);
  renderObjectList();
  const count = state.hidden.reduce((n, v) => n + v, 0);
  $('show-all').hidden = !count;
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
$('show-all').addEventListener('click', () => state.mesh && setHiddenFaces(allFaces(), false));

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
  clearTimeout(selectionChanged.timer);
  selectionChanged.timer = setTimeout(updatePlacement, 150); // not on every brush stroke
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
  // Click tools: a click selects, a left-drag rotates (as in slicers).
  const clickTool = ['object', 'click', 'part', 'region', 'layflat'].includes(state.tool);
  viewer.controls.buttons = {
    0: orbit ? 'rotate' : clickTool ? 'rotate-drag' : null,
    1: 'pan',
    2: state.tool === 'orbit' ? 'pan' : 'rotate',
  };
  const cursors = { brush: 'none', object: 'pointer', layflat: 'pointer', rotate: 'ew-resize' };
  view.style.cursor = orbit ? 'grab' : cursors[state.tool] || 'crosshair';
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
  if (state.tool === 'rotate') startSpin(p.x);
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
  if (state.tool === 'rotate') updateSpin(p.x, e.shiftKey);
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

  if (tool === 'rotate') {
    endSpin();
    return;
  }
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
  if (tool === 'layflat') {
    layFlatAt(face);
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
// Moving the model (joystick, arrow keys)

let moveStep = 1;
let moveTimer;
let stretchWarned = false;

// What a move applies to: the selected part(s) if the selection is a
// separate piece, otherwise the whole model.
function moveTarget() {
  const mesh = state.mesh;
  if (!countSelected()) return { faces: null, vertices: null, label: 'whole model' };
  const inSel = mesh.verticesOf(state.selection);
  const inRest = new Uint8Array(mesh.vertexCount);
  for (let t = 0; t < mesh.triangleCount; t++) {
    if (!state.selection[t]) for (let k = 0; k < 3; k++) inRest[mesh.indices[t * 3 + k]] = 1;
  }
  if (inSel.some((v, i) => v && inRest[i])) {
    if (!stretchWarned) toast('The selection is joined to the rest – moving the whole model. Split it (S) to move it on its own.');
    stretchWarned = true;
    return { faces: null, vertices: null, label: 'whole model' };
  }
  return { faces: state.selection, vertices: inSel, label: 'selection' };
}

function moveBy(dx, dy, dz) {
  if (!state.mesh || (!dx && !dy && !dz)) return;
  const target = moveTarget();
  transformBurst(() => state.mesh.translate(dx, dy, dz, target.vertices));
}

// Runs a position-only change (move/rotate). A burst of them – holding a key
// or button – is one undo step; the triangles and selection stay as they are.
function transformBurst(change) {
  const mesh = state.mesh;
  if (!state.moving) {
    state.undo.push(mesh.snapshot());
    if (state.undo.length > 50) state.undo.shift();
    state.redo = [];
    state.moving = true;
  }
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => (state.moving = false), 1200);
  change();
  viewer.updatePositions(mesh);
  updatePlacement();
  updateButtons();
}

let rotateStep = 15;

// Rotates the move target around its centre of mass. Tipping over X or Y
// puts it back on the plate afterwards.
function rotateBy(axis, degrees) {
  if (!state.mesh || !degrees) return;
  const target = moveTarget();
  const com = state.mesh.centerOfMass(target.faces);
  if (!com) return;
  transformBurst(() => {
    state.mesh.rotate(axis, (degrees * Math.PI) / 180, com.center, target.vertices);
    if (axis[2] === 0) {
      const after = state.mesh.centerOfMass(target.faces);
      state.mesh.translate(0, 0, -after.minZ, target.vertices);
    }
  });
}

// Lay-flat tool: the clicked face's flat area goes face-down on the plate.
// The whole model turns as one group, unless the clicked face is part of a
// selection of separate parts – then only those turn.
function layFlatAt(face) {
  const mesh = state.mesh;
  const target = countSelected() && state.selection[face] ? moveTarget() : { faces: null, label: 'whole model' };
  const { normal } = mesh.flatAreaNormal(face, 2);
  transformBurst(() => mesh.layFlat(normal, target.faces));
  state.moving = false; // each click is its own undo step
  toast(target.faces ? 'Laid the selected parts flat on that face' : 'Laid the model flat on that face');
}

// Rotate tool: dragging sideways spins the target around Z (Shift snaps to 15°).
let spin = null;

function startSpin(x) {
  const target = moveTarget();
  const com = state.mesh.centerOfMass(target.faces);
  if (!com) return;
  state.moving = false;
  spin = { x, base: state.mesh.snapshot(), target, pivot: com.center, angle: 0, frame: 0 };
}

function updateSpin(x, snap) {
  if (!spin) return;
  let angle = (x - spin.x) * 0.5;
  if (snap) angle = Math.round(angle / 15) * 15;
  spin.angle = angle;
  if (spin.frame) return;
  spin.frame = requestAnimationFrame(() => {
    if (!spin) return;
    spin.frame = 0;
    state.mesh.restore(spin.base);
    state.mesh.rotate([0, 0, 1], (spin.angle * Math.PI) / 180, spin.pivot, spin.target.vertices);
    viewer.updatePositions(state.mesh);
    showAngle(spin.angle);
  });
}

function endSpin() {
  if (!spin) return;
  cancelAnimationFrame(spin.frame);
  const { base, angle, pivot, target } = spin;
  spin = null;
  showAngle(null);
  state.mesh.restore(base);
  if (!angle) {
    viewer.updatePositions(state.mesh);
    return;
  }
  state.moving = false;
  transformBurst(() => state.mesh.rotate([0, 0, 1], (angle * Math.PI) / 180, pivot, target.vertices));
  state.moving = false;
}

function showAngle(angle) {
  const el = $('angle-readout');
  el.hidden = angle === null;
  if (angle !== null) el.textContent = `${angle > 0 ? '+' : ''}${angle.toFixed(1)}°`;
}

// Centre of mass to X = Y = 0 and/or bottom to Z = 0, for the move target.
function placeTarget({ center = true, drop = true } = {}) {
  if (!state.mesh) return;
  const com = state.mesh.centerOfMass(moveTarget().faces);
  if (!com) return;
  moveBy(center ? -com.center[0] : 0, center ? -com.center[1] : 0, drop ? -com.minZ : 0);
}

const fmt = (v) => (Math.abs(v) < 0.005 ? '0.00' : v.toFixed(2));

function updatePlacement() {
  const el = $('placement');
  $('joystick').hidden = !state.mesh;
  if (!state.mesh) return;
  const target = countSelected() ? state.selection : null;
  const com = state.mesh.centerOfMass(target);
  if (!com) return;
  const { min, max } = state.mesh.bounds(target);
  el.innerHTML =
    `<b>${target ? 'Selection' : 'Model'}</b> X ${fmt(com.center[0])} · Y ${fmt(com.center[1])} · Z ${fmt(com.minZ)}` +
    `<br>Size ${fmt(max[0] - min[0])} × ${fmt(max[1] - min[1])} × ${fmt(max[2] - min[2])}`;
}

// Joystick buttons repeat while held.
for (const b of document.querySelectorAll('#joystick [data-move]')) {
  let timer;
  const stop = () => clearTimeout(timer);
  const once = () => {
    const [x, y, z] = b.dataset.move.split(',').map(Number);
    moveBy(x * moveStep, y * moveStep, z * moveStep);
  };
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    once();
    const repeat = (delay) => (timer = setTimeout(() => (once(), repeat(70)), delay));
    repeat(400);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, stop);
}
for (const b of document.querySelectorAll('#joystick [data-step]')) {
  b.addEventListener('click', () => {
    moveStep = +b.dataset.step;
    for (const o of document.querySelectorAll('#joystick [data-step]')) o.classList.toggle('active', o === b);
  });
}
for (const b of document.querySelectorAll('#joystick [data-rotate]')) {
  b.addEventListener('click', () => {
    const [x, y, z, sign] = b.dataset.rotate.split(',').map(Number);
    rotateBy([x, y, z], sign * (z ? rotateStep : 90));
  });
}
for (const b of document.querySelectorAll('#joystick [data-angle]')) {
  b.addEventListener('click', () => {
    rotateStep = +b.dataset.angle;
    for (const o of document.querySelectorAll('#joystick [data-angle]')) o.classList.toggle('active', o === b);
  });
}
$('lay-flat').addEventListener('click', () => setTool('layflat'));
$('move-center').addEventListener('click', () => placeTarget({ center: true, drop: true }));
$('move-drop').addEventListener('click', () => placeTarget({ center: false, drop: true }));
$('help-open').addEventListener('click', () => ($('help').hidden = false));
$('help-close').addEventListener('click', () => ($('help').hidden = true));

// ---------------------------------------------------------------------------
// Keyboard

const toolKeys = { 1: 'orbit', 2: 'click', 3: 'brush', 4: 'box', 5: 'part', 6: 'region', 7: 'object', 8: 'block', 9: 'rotate', 0: 'layflat' };

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
  if (e.target instanceof HTMLSelectElement) return;
  // Arrow keys move along the plate axis closest to that screen direction,
  // PageUp/PageDown move up/down; Shift moves 10x further.
  const arrows = { ArrowRight: ['right', 1], ArrowLeft: ['right', -1], ArrowUp: ['up', 1], ArrowDown: ['up', -1] };
  if (!e.ctrlKey && !e.metaKey && !e.altKey && state.mesh) {
    const step = moveStep * (e.shiftKey ? 10 : 1);
    if (arrows[e.key]) {
      const [dir, sign] = arrows[e.key];
      const [ax, ay] = viewer.screenAxes()[dir];
      moveBy(ax * sign * step, ay * sign * step, 0);
      e.preventDefault();
      return;
    }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      moveBy(0, 0, (e.key === 'PageUp' ? 1 : -1) * step);
      e.preventDefault();
      return;
    }
    if (e.key === 'Home') {
      placeTarget();
      e.preventDefault();
      return;
    }
    if (e.key.toLowerCase() === 'q' || e.key.toLowerCase() === 'e') {
      rotateBy([0, 0, 1], (e.key.toLowerCase() === 'q' ? 1 : -1) * rotateStep * (e.shiftKey ? 2 : 1));
      e.preventDefault();
      return;
    }
  }
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
    if (!$('help').hidden) $('help').hidden = true;
    else runSelection('none');
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
  } else if (e.key === '?') {
    $('help').hidden = !$('help').hidden;
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

window.__appStarted = true;

// Unsaved edits: ask before the page is closed or navigated away from.
window.addEventListener('beforeunload', (e) => {
  if (state.undo.length) e.preventDefault();
});
