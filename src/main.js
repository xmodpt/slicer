import * as THREE from 'three';
import { EditableMesh } from './mesh.js';
import { parseSTL, writeBinarySTL } from './stl.js';
import { Viewer } from './viewer.js';
import { segmentObjects } from './segment.js';
import { cakeWithCandles } from './samples.js';
import { makeZip } from './zip.js';
import { NavGizmo } from './gizmo.js';
import { cutWithPins, analyzeCut, connectorOptions } from './cut.js';
import { findFloatingParts } from './floating.js';
import { CutGizmo } from './cutgizmo.js';
import { modelInfo, resinUse, overhangs, bestOrientation, wallThickness } from './analysis.js';
import { diagnose, repair, selfIntersections, mirror, smooth } from './repair.js';
import { combine, addBase, textOutlines, svgOutlines, stamp, hollow, drillHoles } from './csg.js';
import { parseOBJ, writeOBJ, read3MF, write3MF } from './formats.js';
import { allPrinters, selectedPrinter, selectPrinter, saveCustomPrinter, deleteCustomPrinter, fitCheck } from './printers.js';

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
  mode: null, // 'normal' (whole models) | 'edit' (parts) | 'cut'
  faceGroup: new Int32Array(0), // model (group) id of every triangle; replaced, never changed in place
  groupNames: new Map(),
  nextGroup: 1,
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
  {
    const b = mesh.bounds();
    state.openSize = Math.max(...[0, 1, 2].map((k) => b.max[k] - b.min[k])); // for "% of the original size"
  }
  state.fileName = name;
  state.modelName = null;
  state.faceGroup = new Int32Array(mesh.triangleCount); // the file is one model
  state.groupNames = new Map();
  state.nextGroup = 1;
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
  setMode('normal'); // a freshly opened model is one solid model
  updatePlacement();
  if (state.tool === 'cut') setCut({ offset: null });
  updateButtons();
}

function openFile(file) {
  return busy(async () => {
    await stage('Reading file…', 0);
    const buffer = await readFile(file, (f) => setProgress('Reading file…', f * 0.25));
    await stage('Reading triangles…', 0.27);
    const ext = (file.name.match(/\.(\w+)$/)?.[1] || '').toLowerCase();
    if (ext === '3mf') return loadModels(await read3MF(buffer), file.name);
    if (ext === 'obj') return loadModels(parseOBJ(new TextDecoder().decode(buffer)), file.name);
    await loadSoup(parseSTL(buffer), file.name);
  });
}

// Several models from one file (3MF, OBJ): one mesh, each model its own group.
async function loadModels(models, name) {
  if (!models.length) throw new Error('The file contains no triangles.');
  const total = models.reduce((n, m) => n + m.soup.length, 0);
  const soup = new Float32Array(total);
  let o = 0;
  const ranges = [];
  for (const m of models) {
    soup.set(m.soup, o);
    ranges.push([o / 9, (o + m.soup.length) / 9, m.name]);
    o += m.soup.length;
  }
  await loadSoup(soup, name);
  if (models.length < 2 || state.mesh.triangleCount !== total / 9) return;
  const groups = new Int32Array(state.mesh.triangleCount);
  ranges.forEach(([a, b, n], k) => groups.fill(k === 0 ? 0 : newGroupId(n), a, b));
  state.groupNames.set(0, ranges[0][2]);
  state.faceGroup = groups;
  renderObjectList();
  updateExportLabels();
}

// The desktop app opens .stl files double-clicked in Explorer / Finder / a
// file manager through this (the file is served by the app's local server).
window.openFromUrl = async (url, name) => {
  const blob = await (await fetch(url)).blob();
  return openFile(new File([blob], name));
};

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

const exportSelectedOnly = () => $('export-selected').checked;

$('export').addEventListener('click', () => {
  const { mesh } = state;
  if (exportSelectedOnly()) {
    if (!countSelected()) return toast('Select something to export first');
    const part = mesh.extractFaces(state.selection);
    return download(writeBinarySTL(part.positions, part.indices), baseName() + '_selection.stl');
  }
  download(writeBinarySTL(mesh.positions, mesh.indices), baseName() + '_edited.stl');
});
$('export-selected').addEventListener('change', updateButtons);

const MAX_PARTS_LISTED = 50;

function groupFile(group) {
  const m = state.mesh.extractFaceList(group.faces());
  const name = group.id === 0 && !state.groupNames.has(0) ? `${baseName()}_edited` : `${baseName()}_${safeName(group.name)}`;
  return { name: name + '.stl', data: new Uint8Array(writeBinarySTL(m.positions, m.indices)) };
}

// Models to export: all, or (with the toggle) the ones with a selected face.
function exportableGroups() {
  let groups = listGroups();
  if (exportSelectedOnly()) {
    groups = groups.filter((g) => g.parts.some((p) => p.faces.some((t) => state.selection[t])));
    if (!groups.length) {
      toast('Select something to export first');
      return [];
    }
  }
  if (groups.length > 100 && !confirm(`There are ${groups.length} separate models – export ${groups.length} files?`)) return [];
  // Unique file names.
  const used = new Map();
  return groups.map((g) => {
    const f = groupFile(g);
    const n = used.get(f.name) || 0;
    used.set(f.name, n + 1);
    if (n) f.name = f.name.replace(/\.stl$/, `_${n + 1}.stl`);
    return f;
  });
}

// The models (or the selected ones) for 3MF / OBJ.
function exportModels() {
  let groups = listGroups();
  if (exportSelectedOnly()) groups = groups.filter((g) => g.parts.some((p) => p.faces.some((t) => state.selection[t])));
  return groups.map((g) => {
    const m = state.mesh.extractFaceList(g.faces());
    return { name: g.name, positions: m.positions, indices: m.indices };
  });
}
$('export-3mf').addEventListener('click', () => {
  const models = exportModels();
  if (!models.length) return toast('Select something to export first');
  download(write3MF(models), baseName() + '.3mf', 'model/3mf');
});
$('export-obj').addEventListener('click', () => {
  const models = exportModels();
  if (!models.length) return toast('Select something to export first');
  download(writeOBJ(models), baseName() + '.obj', 'model/obj');
});

$('export-zip').addEventListener('click', () => {
  const files = exportableGroups();
  if (files.length) download(makeZip(files), baseName() + (exportSelectedOnly() ? '_selected_models.zip' : '_models.zip'), 'application/zip');
});

$('export-each').addEventListener('click', async () => {
  for (const f of exportableGroups()) {
    download(f.data, f.name);
    await new Promise((r) => setTimeout(r, 400)); // browsers drop rapid back-to-back downloads
  }
});

function renderPartList() {
  state.parts = state.mesh.parts();
  updateExportLabels();
}

function updateExportLabels() {
  const groups = state.mesh ? listGroups() : [];
  const only = exportSelectedOnly();
  const selected = only && state.mesh ? groups.filter((g) => g.parts.some((p) => p.faces.some((t) => state.selection[t]))).length : groups.length;
  $('export').textContent = only ? 'Export selection as one STL' : groups.length > 1 ? 'Export everything as one STL' : 'Export model';
  $('export-zip').disabled = $('export-each').disabled = $('export-3mf').disabled = $('export-obj').disabled = selected < 1;
  $('export-zip').textContent = only
    ? `Download ${selected} selected model${selected === 1 ? '' : 's'} (.zip)`
    : `Download ${groups.length > 1 ? `all ${groups.length} models` : 'the model'} (.zip)`;
  $('export-each').textContent = only ? 'Download selected models as separate STLs' : 'Download each model as its own STL';
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
  const file = [...e.dataTransfer.files].find((f) => /\.(stl|3mf|obj)$/i.test(f.name)) || e.dataTransfer.files[0];
  if (file) openFile(file);
});

// ---------------------------------------------------------------------------
// Edits (undoable)

// Runs an undoable geometry change. fn may return a message, or
// { message, selection } to select faces of the changed mesh afterwards.
// Mesh + model groups, for undo.
function snapshotAll() {
  return { ...state.mesh.snapshot(), faceGroup: state.faceGroup };
}

function restoreAll(snap) {
  state.mesh.restore(snap);
  state.faceGroup = snap.faceGroup && snap.faceGroup.length === state.mesh.triangleCount ? snap.faceGroup : new Int32Array(state.mesh.triangleCount);
}

function edit(fn) {
  if (!state.mesh) return;
  const before = snapshotAll();
  state.moving = false;
  const result = fn(state.mesh);
  const { message, selection } = typeof result === 'object' && result ? result : { message: result };
  if (state.mesh.indices !== before.indices) {
    state.faceGroup = remapGroups(before);
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
  state.redo.push(snapshotAll());
  restoreAll(state.undo.pop());
  refresh();
}

function redo() {
  if (!state.redo.length) return;
  state.moving = false;
  state.undo.push(snapshotAll());
  restoreAll(state.redo.pop());
  refresh();
}

$('delete').addEventListener('click', deleteSelected);
$('split').addEventListener('click', splitSelection);
$('fill').addEventListener('click', closeHoles);
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('frame').addEventListener('click', () => viewer.frame());
$('frame-plate').addEventListener('click', () => viewer.framePrinter());
$('show-boundary').addEventListener('change', (e) => viewer.setBoundariesVisible(e.target.checked));
$('show-wire').addEventListener('change', (e) => viewer.setWireframe(e.target.checked));
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => viewer.setView(b.dataset.view));
$('projection').addEventListener('change', (e) => viewer.setProjection(e.target.value));
$('rotate-mode').addEventListener('change', (e) => viewer.controls.setMode(e.target.value));

// ---------------------------------------------------------------------------
// Fix model: floating parts and holes, with one-click fixes.

function renderFix() {
  const box = $('fix-report');
  box.innerHTML = '';
  if (!state.mesh) {
    box.textContent = 'Open a model first.';
    return;
  }
  const s = state.stats || state.mesh.stats();
  const floating = state.floating || [];
  const add = (ok, title, text, actions = []) => {
    const div = document.createElement('div');
    div.className = 'fix-item ' + (ok ? 'ok' : 'bad');
    div.innerHTML = '<div class="what"></div><div class="why"></div><div class="row"></div>';
    div.querySelector('.what').textContent = (ok ? '✓ ' : '⚠ ') + title;
    div.querySelector('.why').textContent = text;
    for (const [label, fn, cls] of actions) {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      div.querySelector('.row').append(b);
    }
    box.append(div);
  };
  if (floating.length) {
    const tris = floating.reduce((n, p) => n + p.faces.length, 0);
    add(false, `${floating.length} floating part${floating.length === 1 ? '' : 's'}`,
      `${tris.toLocaleString()} triangles float in space – not on the plate and not touching anything that is. They would print in mid-air.`,
      [['Select', () => applyFaces(floatingFaces(), 'replace')], ['Delete them', deleteFloating, 'danger']]);
  } else add(true, 'No floating parts', 'Every part rests on the plate or touches one that does.');
  if (s.holes || s.openChains) {
    add(false, `${s.holes} hole${s.holes === 1 ? '' : 's'} – not solid`,
      'The surface has openings, so the model is not a closed solid. Slicers may print it wrong or not at all.' + (s.openChains ? ` ${s.openChains} open edge chain(s) can't be closed automatically.` : ''),
      [['Close holes', () => closeAllHoles(), 'primary']]);
  } else add(true, 'Closed – no holes', 'The surface is closed all round.');
  if (s.nonManifoldEdges) add(false, `${s.nonManifoldEdges} non-manifold edge${s.nonManifoldEdges === 1 ? '' : 's'}`, 'Edges shared by more than two triangles (e.g. touching or overlapping pieces). Most slicers cope with this; if not, delete or split the pieces in Edit mode.');
  const solid = !floating.length && !s.holes && !s.openChains;
  const p = document.createElement('p');
  p.className = 'fix-summary ' + (solid ? 'ok' : 'bad');
  p.textContent = solid ? (s.watertight ? 'The model is solid and ready to print.' : 'No floating parts or holes left.') : 'Not ready yet – fix the items below, or press Fix everything.';
  box.prepend(p);
  $('fix-all').disabled = solid;
}

function deleteFloating() {
  if (!state.floating?.length) return;
  applyFaces(floatingFaces(), 'replace');
  deleteSelected();
}

function closeAllHoles() {
  edit((mesh) => {
    const r = mesh.fillHoles({ maxEdges: Infinity });
    return r.filled ? `Closed ${r.filled} hole(s) with ${r.added.toLocaleString()} triangles` : 'No holes to close';
  });
}

$('fix-check').addEventListener('click', () => {
  if (!state.mesh) return;
  updateStats();
  checkFloating();
  renderFix();
  toast('Checked');
});
$('fix-all').addEventListener('click', () => {
  if (!state.mesh) return;
  const steps = [];
  if (state.floating?.length) {
    steps.push(`deleted ${state.floating.length} floating part(s)`);
    deleteFloating();
  }
  if (state.holes || state.stats?.openChains) {
    const before = state.holes;
    closeAllHoles();
    steps.push(`closed ${before} hole(s)`);
  }
  renderFix();
  toast(steps.length ? 'Fixed: ' + steps.join(', ') : 'Nothing to fix');
});

// ---------------------------------------------------------------------------
// Models (groups of parts)
//
// Every triangle carries the id of the model it belongs to. A model is a set
// of whole parts: in Normal mode it is picked, moved, resized and exported as
// one; in Edit mode parts can be grouped into one model or ungrouped.

function newGroupId(name) {
  const id = state.nextGroup++;
  if (name) state.groupNames.set(id, name);
  return id;
}

function groupName(id) {
  return state.groupNames.get(id) || (id === 0 ? modelName() : `Model ${id + 1}`);
}

// Groups after a change of the triangles: each part goes to the model most of
// its corners belonged to before (matched by position); new pieces become
// models of their own.
function remapGroups(before) {
  const mesh = state.mesh;
  const old = before.faceGroup;
  const out = new Int32Array(mesh.triangleCount);
  if (!old || !old.length) return out;
  let single = true;
  for (let t = 1; t < old.length && single; t++) if (old[t] !== old[0]) single = false;
  if (single) return out.fill(old[0]);
  const P0 = before.positions, I0 = before.indices;
  const key = (P, v) => P[v * 3] + ',' + P[v * 3 + 1] + ',' + P[v * 3 + 2];
  const was = new Map();
  for (let t = 0; t < old.length; t++) for (let k = 0; k < 3; k++) was.set(key(P0, I0[t * 3 + k]), old[t]);
  const P = mesh.positions, I = mesh.indices;
  for (const part of mesh.parts()) {
    const votes = new Map();
    const step = Math.max(1, Math.floor(part.faces.length / 2000)); // a sample is enough
    for (let i = 0; i < part.faces.length; i += step) {
      const t = part.faces[i];
      for (let k = 0; k < 3; k++) {
        const g = was.get(key(P, I[t * 3 + k]));
        if (g !== undefined) votes.set(g, (votes.get(g) || 0) + 1);
      }
    }
    let id = -1, best = 0;
    for (const [g, n] of votes) if (n > best) (best = n), (id = g);
    if (id < 0) id = newGroupId();
    for (const t of part.faces) out[t] = id;
  }
  return out;
}

// The models: [{ id, name, faces, parts }] in order of first appearance.
function listGroups() {
  const byId = new Map();
  for (const part of state.parts || []) {
    const id = state.faceGroup[part.faces[0]] ?? 0;
    if (!byId.has(id)) byId.set(id, { id, parts: [] });
    byId.get(id).parts.push(part);
  }
  return [...byId.values()].map((g) => ({
    ...g,
    name: groupName(g.id),
    triangles: g.parts.reduce((n, p) => n + p.faces.length, 0),
    faces: () => g.parts.flatMap((p) => Array.from(p.faces)),
  }));
}

function groupFacesOf(face) {
  const id = state.faceGroup[face];
  const out = [];
  state.faceGroup.forEach((g, t) => g === id && out.push(t));
  return out;
}

// Normal mode works on whole models: grow the selection to them.
function expandSelectionToGroups() {
  if (!state.mesh || !countSelected()) return;
  const ids = new Set();
  state.selection.forEach((v, t) => v && ids.add(state.faceGroup[t]));
  state.faceGroup.forEach((g, t) => (state.selection[t] = ids.has(g) ? 1 : 0));
  selectionChanged();
}

function selectedParts() {
  return (state.parts || []).filter((p) => p.faces.some((t) => state.selection[t]));
}

function changeGroups(next, message) {
  state.undo.push(snapshotAll());
  if (state.undo.length > 50) state.undo.shift();
  state.redo = [];
  state.faceGroup = next;
  renderObjectList();
  updateExportLabels();
  updateButtons();
  toast(message);
}

function groupSelected() {
  if (!state.mesh) return;
  const parts = selectedParts();
  const ids = new Set(parts.map((p) => state.faceGroup[p.faces[0]]));
  if (parts.length < 2 || ids.size < 2) {
    toast(parts.length < 2 ? 'Select two or more parts to group them' : 'These parts are already one model');
    return;
  }
  const target = Math.min(...ids);
  const next = Int32Array.from(state.faceGroup);
  for (const p of parts) for (const t of p.faces) next[t] = target;
  // Whole models that were touched join completely.
  next.forEach((g, t) => ids.has(g) && (next[t] = target));
  changeGroups(next, `Grouped into one model: ${groupName(target)}`);
}

function ungroupSelected() {
  if (!state.mesh) return;
  let parts = selectedParts();
  if (!parts.length) {
    toast('Select the parts to ungroup');
    return;
  }
  // Parts sharing a model with nothing else are already on their own.
  const count = new Map();
  for (const p of state.parts) count.set(state.faceGroup[p.faces[0]], (count.get(state.faceGroup[p.faces[0]]) || 0) + 1);
  parts = parts.filter((p) => count.get(state.faceGroup[p.faces[0]]) > 1);
  if (!parts.length) {
    toast('Each selected part is already a model of its own');
    return;
  }
  const next = Int32Array.from(state.faceGroup);
  const kept = new Set();
  for (const p of parts) {
    const g = state.faceGroup[p.faces[0]];
    // When every part of a model is selected, the first one keeps the model.
    const all = parts.filter((q) => state.faceGroup[q.faces[0]] === g).length === count.get(g);
    if (all && !kept.has(g)) {
      kept.add(g);
      continue;
    }
    const id = newGroupId();
    for (const t of p.faces) next[t] = id;
  }
  changeGroups(next, parts.length === 1 ? 'Ungrouped – the part is now a model of its own' : `Ungrouped – ${parts.length} parts are now separate models`);
}

$('group').addEventListener('click', groupSelected);
$('pick-all').addEventListener('click', () => runSelection('all'));
$('pick-none').addEventListener('click', () => runSelection('none'));
$('ungroup').addEventListener('click', ungroupSelected);

// Run after every geometry change, once the model is on screen.
const ANALYSIS_STEPS = [
  { label: 'Finding objects…', run: () => analyzeObjects() },
  { label: 'Checking for holes…', run: () => updateStats() },
  { label: 'Listing parts…', run: () => renderPartList() },
  { label: 'Looking for floating parts…', run: () => checkFloating() },
];

// Floating parts (see floating.js).
function findFloating() {
  return state.mesh ? findFloatingParts(state.mesh, state.parts || []) : [];
}

function checkFloating() {
  const floating = (state.floating = state.mesh ? findFloating() : []);
  const before = state.floatingFirst || new Set();
  state.floatingFirst = new Set(floating.map((p) => p.faces[0]));
  if (before.size !== state.floatingFirst.size || [...before].some((f) => !state.floatingFirst.has(f))) renderObjectList();
  if (cardOverride === 'fix') renderFix();
  const box = $('floating-warning');
  box.hidden = !floating.length;
  if (!floating.length) return;
  const tris = floating.reduce((n, p) => n + p.faces.length, 0);
  $('floating-text').textContent =
    `${floating.length} floating part${floating.length === 1 ? '' : 's'} (${tris.toLocaleString()} triangles) ` +
    `${floating.length === 1 ? "isn't" : "aren't"} touching the plate or anything else and would print in mid-air. ` +
    'Delete them unless you plan to move them down.';
  if (state.floatingCount !== floating.length) toast(`⚠ ${floating.length} floating part(s) found – see the Objects panel`);
  state.floatingCount = floating.length;
}

const floatingFaces = () => (state.floating || []).flatMap((p) => Array.from(p.faces));
$('floating-select').addEventListener('click', () => applyFaces(floatingFaces(), 'replace'));
$('floating-delete').addEventListener('click', () => {
  applyFaces(floatingFaces(), 'replace');
  deleteSelected();
});
$('floating-dismiss').addEventListener('click', () => ($('floating-warning').hidden = true));

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
  if (state.faceGroup.length !== mesh.triangleCount) state.faceGroup = new Int32Array(mesh.triangleCount);
  state.hidden = null;
  state.partNames = [];
  state.names = new Map();
  $('show-all').hidden = true;
  state.selection = new Uint8Array(mesh.triangleCount);
  viewer.setMesh(mesh, state.selection, { frame });
  ANALYSIS_STEPS.forEach(runStep);
  updatePlacement();
  if (state.tool === 'cut') setCut({});
  if (state.tool === 'scale') fillScale({ force: true });
  if (cardOverride === 'fix') renderFix();
  state.thickness = null;
  refreshPanel();
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
  ];
  $('stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  state.holes = s.holes;
  state.stats = s;
}

function countSelected() {
  let n = 0;
  for (const v of state.selection) n += v;
  return n;
}

function updateButtons() {
  const has = !!state.mesh;
  const selected = has ? countSelected() : 0;
  $('export').disabled = !has || (exportSelectedOnly() && !selected);
  if (has) updateExportLabels();
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
  viewer.setObjects(state.seg.objectOf, $('obj-colors').checked && state.partsMode ? state.objectColors : null);
  viewer.setSelection(state.selection);
}

// Rows of the objects list: one per detected object.
function objectRows() {
  return state.seg.objects.map((o) => ({ ids: [o.id], name: o.id === 0 ? 'Main body' : `Object ${o.id}` }));
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

  const facesOfRow = (row) => {
    const out = [];
    for (const id of row.ids) for (const t of facesOf(id)) out.push(t);
    return out;
  };

  const groups = listGroups();
  const partIndex = new Map(parts.map((p, i) => [p, i]));
  const editing = state.partsMode;

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
        swatch: '#' + state.objectColors[row.ids[0]].getHexString(),
        faces: () => facesOfRow(row),
        hoverIds: row.ids,
        remove: true,
      });
    }
    if (rows.length > MAX_CHILDREN) treeNote(list, depth, `+ ${rows.length - MAX_CHILDREN} smaller objects (pick them with the Object tool)`);
  };

  groups.slice(0, MAX_PARTS_LISTED).forEach((group) => {
    const key = 'group:' + group.id;
    const gParts = group.parts;
    const subRows = gParts.length === 1 ? rowsByPart[partIndex.get(gParts[0])] : [];
    const hasChildren = editing && (gParts.length > 1 || subRows.length > 1);
    addTreeRow(list, {
      key,
      depth: 0,
      name: group.name,
      rename: (v) => state.groupNames.set(group.id, v),
      meta: `${gParts.length > 1 ? gParts.length + ' parts · ' : ''}${group.triangles.toLocaleString()} tris`,
      title: editing ? '' : 'A model: picked, moved, resized and exported as one. Edit mode (Tab) shows its parts.',
      badge: gParts.some((p) => state.floatingFirst?.has(p.faces[0])) ? 'floating' : null,
      faces: group.faces,
      hoverIds: gParts.flatMap((p) => rowsByPart[partIndex.get(p)].flatMap((r) => r.ids)),
      group: hasChildren,
      defaultOpen: groups.length <= 5,
      icon: '◆',
      download: () => {
        const f = groupFile(group);
        download(f.data, f.name);
      },
      remove: true,
    });
    if (!hasChildren || !isOpen(key, groups.length <= 5)) return;
    if (gParts.length === 1) {
      addObjects(subRows, 1);
      return;
    }
    gParts.slice(0, MAX_PARTS_LISTED).forEach((part) => {
      const i = partIndex.get(part);
      const pkey = 'part:' + i;
      const rows = rowsByPart[i];
      addTreeRow(list, {
        key: pkey,
        depth: 1,
        name: partName(i),
        rename: (v) => (state.partNames[i] = v),
        meta: `${part.faces.length.toLocaleString()} tris${part.open ? ' · open' : ''}`,
        badge: state.floatingFirst?.has(part.faces[0]) ? 'floating' : null,
        faces: () => part.faces,
        hoverIds: rows.flatMap((r) => r.ids),
        group: rows.length > 1,
        defaultOpen: false,
        icon: '▣',
        remove: true,
      });
      if (rows.length > 1 && isOpen(pkey, false)) addObjects(rows, 2);
    });
    if (gParts.length > MAX_PARTS_LISTED) treeNote(list, 1, `+ ${gParts.length - MAX_PARTS_LISTED} more small pieces`);
  });
  if (groups.length > MAX_PARTS_LISTED) treeNote(list, 0, `+ ${groups.length - MAX_PARTS_LISTED} more models`);
  if (!editing) treeNote(list, 0, groups.length > 1 ? 'Click a model to select it. Edit mode (Tab) shows the parts.' : 'Shown as one solid model. Edit mode (Tab) shows its parts.');
  else if (groups.length === 1 && parts.length === 1 && rowsByPart[0].length <= 1) treeNote(list, 1, 'No sub-objects found. Lower “Split at creases” to split the model further.');
}

function isOpen(key, fallback) {
  return state.open.has(key) ? state.open.get(key) : fallback;
}

function modelName() {
  return state.modelName || state.fileName.replace(/\.(stl|3mf|obj)$/i, '');
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
    applyFaces(faces(), modeFor(e, 'replace'));
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
// Selection

function selectionChanged(faces) {
  if (faces) viewer.updateFaces(faces, state.selection);
  else viewer.setSelection(state.selection);
  updateButtons();
  clearTimeout(selectionChanged.timer);
  selectionChanged.timer = setTimeout(() => {
    updatePlacement();
    if (state.tool === 'scale') fillScale();
  }, 150); // not on every brush stroke
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
  if (state.mode === 'normal' && (name === 'grow' || name === 'shrink')) return; // whole models only
  selectionCommands[name]();
  selectionChanged();
}

for (const name of Object.keys(selectionCommands)) $('sel-' + name).addEventListener('click', () => runSelection(name));

// ---------------------------------------------------------------------------
// Tools and pointer interaction

const brushCursor = $('brush-cursor');
const boxRect = $('box-rect');
let orbitOverride = false; // Alt held

const SELECT_TOOLS = ['object', 'click', 'brush', 'box', 'part', 'region'];
// Each mode has its own tools; View (orbit) is in all of them.
const MODE_TOOLS = {
  normal: ['pick', 'move', 'rotate', 'scale', 'layflat'],
  edit: [...SELECT_TOOLS, 'block'],
  cut: ['cut'],
};
const MODE_DEFAULT = { normal: 'pick', edit: 'object', cut: 'cut' };
const MODE_HINTS = {
  normal: 'Normal mode – pick, move, rotate, resize and export whole models',
  edit: 'Edit mode – select, delete, split, group parts',
  cut: 'Cut mode – cut with pins, holes or dowels',
};
const modeOfTool = (tool) => Object.keys(MODE_TOOLS).find((m) => MODE_TOOLS[m].includes(tool));

function setMode(mode, tool) {
  const leaving = state.mode;
  if (mode !== leaving) {
    state.mode = mode;
    // Back from Edit: the parts become solid models again – holes left by
    // deleting are closed, and the selection covers whole models.
    if (leaving === 'edit' && state.mesh) {
      if ($('close-on-exit').checked && state.holes) closeHoles();
      expandSelectionToGroups();
    }
    if (mode === 'normal') expandSelectionToGroups();
    for (const b of document.querySelectorAll('[data-appmode]')) b.classList.toggle('active', b.dataset.appmode === mode);
    for (const b of document.querySelectorAll('#toolrail [data-modes]')) b.hidden = !b.dataset.modes.split(' ').includes(mode);
    $('view-mode').textContent = { normal: 'Normal', edit: 'Edit', cut: 'Cut' }[mode];
    $('view-mode').className = 'mode-chip ' + mode;
    $('view-mode').title = MODE_HINTS[mode];
    state.partsMode = mode === 'edit';
    if (state.mesh && state.seg) {
      applyObjectColors();
      renderObjectList();
    }
  }
  setTool(tool || (mode === 'edit' && state.lastSelect) || MODE_DEFAULT[mode], true);
}

for (const b of document.querySelectorAll('[data-appmode]')) b.addEventListener('click', () => setMode(b.dataset.appmode));

const CARD_TITLES = {
  pick: 'Select models',
  select: 'Select',
  block: 'Block cut & select',
  move: 'Move',
  rotate: 'Rotate on the plate',
  scale: 'Resize',
  fix: 'Fix model',
  layflat: 'Lay flat',
  cut: 'Plane cut',
  holes: 'Close holes',
  orbit: 'View',
  info: 'Model info',
  overhang: 'Overhangs & orientation',
  thickness: 'Wall thickness',
  repair: 'Repair',
  measure: 'Measure',
  hollow: 'Hollow & drain holes',
  text: 'Text / logo',
  base: 'Add a base',
  combine: 'Combine models',
  mirror: 'Mirror',
  smooth: 'Smooth',
};
const TOOL_HINTS = {
  pick: 'Click a model to select it · Shift adds · Ctrl removes · Tab = Edit mode for its parts',
  object: 'Object: click a sub-object to select it · Shift adds · Ctrl removes',
  click: 'Triangle: click triangles to select them',
  brush: 'Brush: paint over the model to select',
  box: 'Box: drag a rectangle to select',
  part: 'Part: click to select a whole separate piece',
  region: 'Region: click to select a smooth/flat area',
  block: 'Block: drag a rectangle to cut and select the block inside',
  move: 'Move: drag a part · Shift = up/down · Ctrl = snap · arrows / PgUp / PgDn',
  rotate: 'Rotate: drag on the model to spin it · Shift snaps to 15° · Q / E',
  scale: 'Resize: type the size in mm or %, or use a preset',
  layflat: 'Lay flat: click the face that should rest on the plate',
  cut: 'Cut: drag the orb (arrow slides, rings tilt) or click the model · Enter cuts',
  orbit: 'View: left-drag rotates, right-drag pans, wheel zooms',
};
let cardOverride = null; // a card opened by an action button (Close holes)
let cardClosed = false;

function cardFor(tool) {
  return SELECT_TOOLS.includes(tool) ? 'select' : tool;
}

function showCard() {
  const name = cardOverride || cardFor(state.tool);
  const card = $('tool-card');
  card.hidden = cardClosed && !cardOverride;
  $('card-title').textContent = CARD_TITLES[name] || '';
  for (const b of card.querySelectorAll('.card-body')) b.classList.toggle('shown', b.dataset.card === name);
  for (const o of card.querySelectorAll('[data-mode]')) o.classList.toggle('shown', o.dataset.mode === state.tool);
  for (const b of document.querySelectorAll('#toolrail [data-action="holes"]')) b.classList.toggle('active', cardOverride === 'holes');
  for (const b of document.querySelectorAll('#toolrail [data-action="fix"]')) b.classList.toggle('active', cardOverride === 'fix');
}

function setTool(tool, fromMode = false) {
  // A tool of another mode switches to that mode first.
  const mode = modeOfTool(tool);
  if (!fromMode && mode && mode !== state.mode) return setMode(mode, tool);
  state.tool = tool;
  if (SELECT_TOOLS.includes(tool)) state.lastSelect = tool;
  if (tool === 'scale') fillScale({ force: true });
  if (tool === 'cut' && state.mesh) setCut({});
  else showCutPlane();
  setHoverObjects([]);
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
  for (const b of document.querySelectorAll('[data-rail="select"]')) b.classList.toggle('active', SELECT_TOOLS.includes(tool));
  cardOverride = null;
  cardClosed = false;
  showCard();
  $('status-hint').textContent = TOOL_HINTS[tool] || '';
  updateControls();
}

$('card-close').addEventListener('click', () => {
  if (cardOverride) closePanel();
  else cardClosed = true;
  showCard();
});
for (const b of document.querySelectorAll('[data-rail="select"]')) {
  b.addEventListener('click', () => setTool(state.lastSelect || 'object'));
}
function openFix() {
  cardOverride = 'fix';
  cardClosed = false;
  showCard();
  renderFix();
}
for (const b of document.querySelectorAll('#toolrail [data-action="fix"]')) {
  b.addEventListener('click', () => {
    if (cardOverride === 'fix') {
      cardOverride = null;
      showCard();
    } else openFix();
  });
}
$('floating-fix').addEventListener('click', openFix);
for (const b of document.querySelectorAll('#toolrail [data-action="holes"]')) {
  b.addEventListener('click', () => {
    cardOverride = cardOverride === 'holes' ? null : 'holes';
    cardClosed = false;
    showCard();
  });
}

// Top-bar drop-down menus: click to open, click elsewhere to close.
for (const b of document.querySelectorAll('[data-menu]')) {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = b.parentElement;
    const open = !menu.classList.contains('open');
    for (const m of document.querySelectorAll('.menu.open')) m.classList.remove('open');
    menu.classList.toggle('open', open);
  });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-panel')) for (const m of document.querySelectorAll('.menu.open')) m.classList.remove('open');
});
for (const b of document.querySelectorAll('.menu-panel > button, .menu-panel .views button')) {
  b.addEventListener('click', () => b.closest('.menu').classList.remove('open'));
}

function updateControls() {
  const orbit = state.tool === 'orbit' || orbitOverride;
  // Click tools: a click selects, a left-drag turns the model around (left /
  // right only); the right button rotates freely.
  const clickTool = ['pick', 'object', 'click', 'part', 'region', 'layflat', 'cut'].includes(state.tool);
  // Tools that drag on the model (Rotate, Brush): a drag that starts on empty
  // space rotates the view instead. Box and Block need empty space for their
  // rectangle.
  const onModel = (e) => {
    const r = canvas.getBoundingClientRect();
    return viewer.faceAt(e.clientX - r.left, e.clientY - r.top) >= 0;
  };
  const dragOnModelTool = ['rotate', 'brush', 'move'].includes(state.tool);
  viewer.controls.buttons = {
    0: orbit
      ? 'rotate'
      : state.tool === 'cut'
        ? (e) => {
            const r = canvas.getBoundingClientRect();
            return cutGizmo.hit(e.clientX - r.left, e.clientY - r.top) ? null : 'spin-drag';
          }
        : clickTool
          ? 'spin-drag'
          : dragOnModelTool
            ? (e) => (onModel(e) ? null : 'spin')
            : null,
    1: 'pan',
    2: state.tool === 'orbit' ? 'pan' : 'rotate',
  };
  const cursors = { brush: 'none', pick: 'pointer', object: 'pointer', layflat: 'pointer', cut: 'pointer', rotate: 'ew-resize', move: 'move' };
  view.style.cursor = orbit ? 'grab' : cursors[state.tool] || 'crosshair';
  if (orbit) brushCursor.style.display = 'none';
}

for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));

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
  if (viewer.controls.dragging) return; // the view took this drag
  const p = localPos(e);
  if (state.tool === 'cut') {
    const handle = cutGizmo.hit(p.x, p.y);
    if (handle) {
      canvas.setPointerCapture(e.pointerId);
      cutGizmo.startDrag(handle, p.x, p.y, cut);
      drag = { start: p, gizmo: true, moved: false };
      return;
    }
  }
  canvas.setPointerCapture(e.pointerId);
  drag = { start: p, mode: modeFor(e, state.tool === 'brush' ? 'add' : 'replace'), moved: false };
  if (state.tool === 'brush') brushAt(p, drag.mode);
  if (state.tool === 'rotate') startSpin(p.x);
  if (state.tool === 'move') startSlide(p);
});

canvas.addEventListener('pointermove', (e) => {
  const p = localPos(e);
  if (state.tool === 'brush' && !orbitOverride) moveBrushCursor(p);
  if (state.tool === 'object' && state.seg && e.buttons === 0) {
    const face = viewer.faceAt(p.x, p.y);
    setHoverObjects(face < 0 ? [] : rowObjects(state.seg.objectOf[face]));
  }
  if (state.tool === 'cut' && !drag && e.buttons === 0) cutGizmo.setHover(cutGizmo.hit(p.x, p.y));
  if (!drag) return;
  if (drag.gizmo) {
    cutGizmo.moveDrag(p.x, p.y);
    return;
  }
  if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 3) drag.moved = true;
  if (state.tool === 'rotate') updateSpin(p.x, e.shiftKey);
  if (state.tool === 'move') updateSlide(p, e.shiftKey, e.ctrlKey || e.metaKey);
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
  if (drag.gizmo) {
    drag = null;
    cutGizmo.endDrag();
    return;
  }
  drag = null;
  const tool = state.tool;

  if (tool === 'rotate') {
    endSpin();
    return;
  }
  if (tool === 'move') {
    endSlide();
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
  // A panel waiting for a click on the model (Measure, drain holes, text).
  if (state.pickMode && PANELS[state.pickMode]?.click) {
    const point = viewer.pointAt(p.x, p.y);
    if (point) PANELS[state.pickMode].click(point.toArray(), viewer.faceAt(p.x, p.y), e);
    return;
  }
  if (tool === 'cut' && manualPlacement() && !e.shiftKey) {
    manualClick(p, e.ctrlKey || e.metaKey);
    return;
  }

  const face = viewer.faceAt(p.x, p.y);
  if (face < 0) {
    if (mode === 'replace') runSelection('none');
    return;
  }
  if (tool === 'pick') {
    applyFaces(groupFacesOf(face), mode);
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
  if (tool === 'cut') {
    cutClick(face, p);
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
    state.undo.push(snapshotAll());
    if (state.undo.length > 50) state.undo.shift();
    state.redo = [];
    state.moving = true;
  }
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    state.moving = false;
    checkFloating();
  }, 800);
  change();
  viewer.updatePositions(mesh);
  updatePlacement();
  updateButtons();
  if (cardOverride === 'overhang' || cardOverride === 'info') refreshPanel();
  if (cardOverride === 'thickness') state.thickness = null;
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
  if (!state.selection[face] && state.mode === 'normal') applyFaces(groupFacesOf(face), 'replace');
  const target = countSelected() && state.selection[face] ? moveTarget() : { faces: null, label: 'whole model' };
  const { normal } = mesh.flatAreaNormal(face, 2);
  transformBurst(() => mesh.layFlat(normal, target.faces));
  state.moving = false; // each click is its own undo step
  toast(target.faces ? 'Laid the selected model flat on that face' : 'Laid the model flat on that face');
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

// Move tool: drag a part across the plate under the mouse (Shift: up/down,
// Ctrl: snap to the move step).
let slide = null;

function startSlide(p) {
  const mesh = state.mesh;
  const face = viewer.faceAt(p.x, p.y);
  if (face < 0) return;
  if (!state.selection[face]) applyFaces(groupFacesOf(face), 'replace');
  const grab = viewer.pointAt(p.x, p.y);
  if (!grab) return;
  state.moving = false;
  slide = { base: mesh.snapshot(), target: moveTarget(), grab, delta: [0, 0, 0], frame: 0 };
}

function updateSlide(p, vertical, snap) {
  if (!slide) return;
  const ray = viewer.rayAt(p.x, p.y);
  const g = slide.grab;
  let d;
  if (vertical) {
    // Vertical plane through the grab point, facing the camera.
    const n = new THREE.Vector3(ray.direction.x, ray.direction.y, 0);
    if (n.lengthSq() < 1e-8) return;
    const hit = ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), g), new THREE.Vector3());
    if (!hit) return;
    d = [0, 0, hit.z - g.z];
  } else {
    if (Math.abs(ray.direction.z) < 0.02) return; // looking along the plate
    const hit = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -g.z), new THREE.Vector3());
    if (!hit) return;
    d = [hit.x - g.x, hit.y - g.y, 0];
  }
  if (snap) d = d.map((x) => Math.round(x / moveStep) * moveStep);
  slide.delta = d;
  if (slide.frame) return;
  slide.frame = requestAnimationFrame(() => {
    if (!slide) return;
    slide.frame = 0;
    state.mesh.restore(slide.base);
    state.mesh.translate(...slide.delta, slide.target.vertices);
    viewer.updatePositions(state.mesh);
    updatePlacement();
    const [x, y, z] = slide.delta;
    const el = $('angle-readout');
    el.hidden = false;
    el.textContent = `ΔX ${x.toFixed(1)}  ΔY ${y.toFixed(1)}  ΔZ ${z.toFixed(1)}`;
  });
}

function endSlide() {
  if (!slide) return;
  cancelAnimationFrame(slide.frame);
  const { base, delta, target } = slide;
  slide = null;
  showAngle(null);
  state.mesh.restore(base);
  if (!delta.some((x) => x)) {
    viewer.updatePositions(state.mesh);
    return;
  }
  transformBurst(() => state.mesh.translate(...delta, target.vertices));
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
  checkFit();
  if (!state.mesh) {
    el.textContent = '';
    return;
  }
  const target = countSelected() ? state.selection : null;
  const com = state.mesh.centerOfMass(target);
  if (!com) return;
  const { min, max } = state.mesh.bounds(target);
  el.innerHTML =
    `<b>${target ? 'Selection' : 'Model'}</b> X ${fmt(com.center[0])} · Y ${fmt(com.center[1])} · Z ${fmt(com.minZ)}` +
    ` · Size ${fmt(max[0] - min[0])} × ${fmt(max[1] - min[1])} × ${fmt(max[2] - min[2])}`;
}

// ---------------------------------------------------------------------------
// Printer: its build plate in the view, and whether the model fits it.

function checkFit() {
  const chip = $('fit-chip');
  const printer = state.printer;
  if (!printer || !state.mesh) {
    chip.hidden = true;
    viewer.setPrinterFits(true);
    return;
  }
  const { fits, over } = fitCheck(printer, state.mesh.bounds());
  chip.hidden = false;
  chip.className = 'fit-chip ' + (fits ? 'ok' : 'bad');
  chip.textContent = fits
    ? `Fits the ${printer.name}`
    : `Doesn't fit the ${printer.name} – ${['X', 'Y', 'Z'].map((a, i) => (over[i] ? `${a} +${fmt(over[i])}` : '')).filter(Boolean).join(', ')} mm`;
  chip.title = fits ? `Build area ${printer.x} × ${printer.y} × ${printer.z} mm` : 'Move it onto the plate, turn it, resize it or cut it into parts';
  viewer.setPrinterFits(fits);
}

function applyPrinter(printer) {
  state.printer = printer;
  $('printer-name').textContent = printer ? printer.name : 'No printer';
  viewer.setPrinter(printer);
  checkFit();
}

function renderPrinterList() {
  const list = $('printer-list');
  list.innerHTML = '';
  const current = state.printer?.id || '';
  const add = (p) => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="radio" name="printer" /> <span class="pn"></span><span class="dims"></span>`;
    const radio = label.querySelector('input');
    radio.checked = (p?.id || '') === current;
    label.querySelector('.pn').textContent = p ? p.name : 'No printer – a plain grid';
    label.querySelector('.dims').textContent = p ? `${p.x} × ${p.y} × ${p.z}` : '';
    radio.addEventListener('change', () => {
      selectPrinter(p ? p.id : null);
      applyPrinter(p);
      viewer.framePrinter();
    });
    if (p) {
      const edit = document.createElement('button');
      edit.className = 'edit';
      edit.textContent = p.brand === 'Custom' ? 'Edit' : 'Copy';
      edit.title = p.brand === 'Custom' ? 'Change this printer' : 'Start your own profile from this one';
      edit.addEventListener('click', (e) => {
        e.preventDefault();
        state.editingPrinter = p.brand === 'Custom' ? p.id : null;
        $('pc-name').value = p.brand === 'Custom' ? p.name : `${p.brand} ${p.name} (mine)`;
        $('pc-x').value = p.x;
        $('pc-y').value = p.y;
        $('pc-z').value = p.z;
        $('pc-delete').hidden = !state.editingPrinter;
        $('pc-status').textContent = '';
      });
      label.append(edit);
    }
    list.append(label);
  };
  add(null);
  let brand = '';
  for (const p of allPrinters()) {
    if (p.brand !== brand) {
      brand = p.brand;
      const h = document.createElement('div');
      h.className = 'brand-head';
      h.textContent = brand === 'Custom' ? 'Your printers' : brand;
      list.append(h);
    }
    add(p);
  }
}

$('printer-open').addEventListener('click', () => {
  renderPrinterList();
  $('pc-status').textContent = '';
  $('printer-modal').hidden = false;
});
$('printer-close').addEventListener('click', () => ($('printer-modal').hidden = true));
$('printer-modal').addEventListener('click', (e) => e.target === $('printer-modal') && ($('printer-modal').hidden = true));
$('pc-save').addEventListener('click', () => {
  try {
    const p = saveCustomPrinter({ id: state.editingPrinter, name: $('pc-name').value, x: $('pc-x').value, y: $('pc-y').value, z: $('pc-z').value });
    state.editingPrinter = p.id;
    selectPrinter(p.id);
    applyPrinter(p);
    viewer.framePrinter();
    renderPrinterList();
    $('pc-delete').hidden = false;
    $('pc-status').textContent = `Saved and selected: ${p.name}.`;
  } catch (err) {
    $('pc-status').textContent = err.message;
  }
});
$('pc-delete').addEventListener('click', () => {
  if (!state.editingPrinter) return;
  deleteCustomPrinter(state.editingPrinter);
  if (state.printer?.id === state.editingPrinter) {
    selectPrinter(null);
    applyPrinter(null);
  }
  state.editingPrinter = null;
  $('pc-delete').hidden = true;
  renderPrinterList();
  $('pc-status').textContent = 'Deleted.';
});
for (const id of ['pc-name', 'pc-x', 'pc-y', 'pc-z']) $(id).addEventListener('keydown', (e) => e.stopPropagation());
applyPrinter(selectedPrinter());

// ---------------------------------------------------------------------------
// Tools panels (Tools ▾): each opens a card; some colour the model (overlay)
// or wait for clicks on it (pickMode).

const PANELS = {};
function openPanel(name) {
  for (const m of document.querySelectorAll('.menu.open')) m.classList.remove('open');
  if (!state.mesh) return toast('Open a model first');
  if (cardOverride && cardOverride !== name) closePanel();
  if (state.tool !== 'pick' && state.mode !== 'edit' && !['measure', 'hollow', 'text'].includes(name)) setTool(MODE_DEFAULT[state.mode]);
  cardOverride = name;
  cardClosed = false;
  showCard();
  PANELS[name]?.open?.();
}
function closePanel() {
  const name = cardOverride;
  cardOverride = null;
  PANELS[name]?.close?.();
  state.pickMode = null;
  viewer.setMarkers(null);
  setOverlay(null);
}
// Re-run the open panel after the model changed.
function refreshPanel() {
  if (cardOverride && PANELS[cardOverride]?.refresh) PANELS[cardOverride].refresh();
}
for (const b of document.querySelectorAll('[data-panel]')) b.addEventListener('click', (e) => {
  e.stopPropagation();
  openPanel(b.dataset.panel);
});

const OVERLAY_COLORS = [new THREE.Color(0xff4d55), new THREE.Color(0xf2a33a), new THREE.Color(0x4cc479)];
function setOverlay(index) {
  if (!state.mesh) return;
  viewer.setOverlay(index ? { index, palette: OVERLAY_COLORS } : null);
  viewer.setSelection(state.selection);
}

// The faces the tools work on: the selected models, else everything.
function targetFaces() {
  if (!countSelected()) return null;
  const groups = new Set();
  state.selection.forEach((v, t) => v && groups.add(state.faceGroup[t]));
  const faces = [];
  state.faceGroup.forEach((g, t) => groups.has(g) && faces.push(t));
  return faces;
}

// Model info.
PANELS.info = {
  open: () => PANELS.info.refresh(),
  refresh() {
    const faces = targetFaces();
    const info = modelInfo(state.mesh, faces);
    const r = resinUse(info.volume, { density: +$('info-density').value || 1.1, pricePerKg: +$('info-price').value || 0 });
    const stats = state.mesh.stats();
    const rows = [
      ['Model', faces ? 'Selected models' : 'Everything'],
      ['Size', info.size.map((v) => fmt(v)).join(' × ') + ' mm'],
      ['Volume', `${(info.volume / 1000).toFixed(2)} cm³`],
      ['Surface', `${(info.area / 100).toFixed(1)} cm²`],
      ['Resin', `${r.ml.toFixed(1)} ml`],
      ['Weight', `${r.grams.toFixed(1)} g`],
      ['Cost', r.cost.toFixed(2)],
      ['Triangles', (faces ? faces.length : state.mesh.triangleCount).toLocaleString()],
    ];
    $('info-list').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    $('info-note').textContent = stats.watertight
      ? 'Supports add a little more resin (typically 5–15 %).'
      : 'The model has holes or loose edges, so the volume is only an estimate – Tools ▾ → Repair, or close the holes, first.';
  },
};
for (const id of ['info-density', 'info-price']) $(id).addEventListener('input', () => cardOverride === 'info' && PANELS.info.refresh());

// Overhangs & auto-orient.
PANELS.overhang = {
  open: () => PANELS.overhang.refresh(),
  refresh() {
    const { mask, area } = overhangs(state.mesh, { angle: +$('oh-angle').value });
    const index = new Uint8Array(mask.length).fill(255);
    mask.forEach((v, t) => v && (index[t] = 0));
    setOverlay(index);
    $('oh-info').textContent = area > 0.5 ? `Overhanging area: ${(area / 100).toFixed(1)} cm² (red).` : 'Nothing overhangs at this angle.';
  },
};
$('oh-angle').addEventListener('input', (e) => {
  $('oh-angle-val').textContent = e.target.value + '°';
  if (cardOverride === 'overhang') PANELS.overhang.refresh();
});
$('oh-orient').addEventListener('click', () =>
  busy(async () => {
    await stage('Trying orientations…', null);
    const faces = targetFaces();
    const sub = faces ? state.mesh.extractFaceList(faces) : state.mesh;
    const best = bestOrientation(sub, { angle: +$('oh-angle').value });
    const d = new THREE.Vector3(...best.down).normalize();
    const target = new THREE.Vector3(0, 0, -1);
    const dotv = d.dot(target);
    const mask = faces ? state.mesh.verticesOf(faceMaskOf(faces)) : null;
    if (dotv < 0.9999) {
      const axis = dotv < -0.9999 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3().crossVectors(d, target).normalize();
      const angle = Math.acos(Math.max(-1, Math.min(1, dotv)));
      transformBurst(() => {
        const c = state.mesh.centerOfMass(faces ? faceMaskOf(faces) : null).center;
        state.mesh.rotate(axis.toArray(), angle, c, mask);
        const minZ = state.mesh.bounds(faces ? faceMaskOf(faces) : null).min[2];
        state.mesh.translate(0, 0, -minZ, mask);
      });
      state.moving = false;
    }
    $('oh-result').textContent =
      best.before.area - best.area < 1
        ? 'It was already turned the best way.'
        : `Overhangs ${(best.before.area / 100).toFixed(1)} → ${(best.area / 100).toFixed(1)} cm²; height ${fmt(best.before.height)} → ${fmt(best.height)} mm. Ctrl+Z turns it back.`;
    PANELS.overhang.refresh();
    viewer.frame();
  }),
);
function faceMaskOf(faces) {
  const m = new Uint8Array(state.mesh.triangleCount);
  for (const t of faces) m[t] = 1;
  return m;
}

// Wall thickness.
PANELS.thickness = {
  open: () => PANELS.thickness.refresh(true),
  refresh(recompute) {
    if (recompute || !state.thickness || state.thickness.length !== state.mesh.triangleCount) {
      state.thickness = wallThickness(state.mesh);
    }
    const min = +$('th-min').value || 1;
    const th = state.thickness;
    const index = new Uint8Array(th.length);
    let thin = 0, thinArea = 0;
    const P = state.mesh.positions, I = state.mesh.indices;
    for (let t = 0; t < th.length; t++) {
      index[t] = th[t] < min ? 0 : th[t] < min * 1.5 ? 1 : 2;
      if (index[t] === 0) {
        thin++;
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        thinArea += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      }
    }
    setOverlay(index);
    $('th-info').textContent = thin ? `${(thinArea / 100).toFixed(2)} cm² thinner than ${min} mm (red).` : `No walls thinner than ${min} mm.`;
    $('th-select').disabled = !thin;
  },
};
$('th-min').addEventListener('input', () => cardOverride === 'thickness' && PANELS.thickness.refresh());
$('th-min').addEventListener('keydown', (e) => e.stopPropagation());
$('th-select').addEventListener('click', () => {
  const min = +$('th-min').value || 1;
  const faces = [];
  state.thickness.forEach((v, t) => v < min && faces.push(t));
  if (state.mode !== 'edit') setMode('edit');
  applyFaces(faces, 'replace');
});

// Repair.
PANELS.repair = {
  open: () => PANELS.repair.refresh(),
  refresh() {
    const d = diagnose(state.mesh);
    state.crossing = d.crossing;
    const row = (n, what, fix) => `<div class="${n ? 'bad' : 'good'}">${n ? `⚠ ${n.toLocaleString()} ${what}` : `✓ No ${what}`}${n && fix ? ` – ${fix}` : ''}</div>`;
    $('repair-report').innerHTML =
      row(d.flipped, 'faces turned the wrong way', 'Repair turns them round') +
      row(d.duplicate, 'duplicate triangles', 'Repair removes them') +
      row(d.degenerate, 'zero-size triangles', 'Repair removes them') +
      row(d.sheet, 'paper-thin double-wall triangles', 'Repair removes them') +
      row(d.crossing.length, 'faces passing through other faces', 'usually parts that overlap; fine for resin slicers, but Combine models (join) merges them cleanly');
    $('repair-run').disabled = !(d.flipped || d.duplicate || d.degenerate || d.sheet);
    $('repair-select').disabled = !d.crossing.length;
  },
};
$('repair-run').addEventListener('click', () =>
  busy(async () => {
    await stage('Repairing…', null);
    let r;
    edit((mesh) => {
      r = repair(mesh);
      return `Repaired: ${r.flipped} faces turned round, ${r.duplicate + r.degenerate + r.sheet} bad triangles removed`;
    });
  }),
);
$('repair-select').addEventListener('click', () => {
  if (!state.crossing?.length) return;
  if (state.mode !== 'edit') setMode('edit');
  applyFaces(state.crossing, 'replace');
});

// Measure: clicks on the model.
PANELS.measure = {
  open() {
    state.pickMode = 'measure';
    state.measure = [];
    if (state.tool !== 'pick' && state.tool !== 'object') setTool(MODE_DEFAULT[state.mode]);
    PANELS.measure.show();
  },
  show() {
    const pts = state.measure || [];
    viewer.setMarkers(pts);
    const rows = [];
    if (pts.length >= 2) {
      const [a, b] = pts;
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      rows.push(['Distance', `${fmt(Math.hypot(...d))} mm`], ['X · Y · Z', d.map((v) => fmt(Math.abs(v))).join(' · ') + ' mm']);
    }
    if (pts.length === 3) {
      const [a, b, c] = pts.map((p) => new THREE.Vector3(...p));
      const u = a.sub(b), w = c.sub(b);
      rows.push(['Angle', `${((u.angleTo(w) * 180) / Math.PI).toFixed(1)}°`]);
      const d2 = pts[2].map((v, i) => v - pts[1][i]);
      rows.push(['2nd distance', `${fmt(Math.hypot(...d2))} mm`]);
    }
    $('measure-out').innerHTML = rows.length ? rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') : `<dt>Click a point on the model</dt><dd></dd>`;
  },
  click(point) {
    if ((state.measure?.length || 0) >= 3) state.measure = [];
    state.measure.push(point);
    PANELS.measure.show();
  },
};
$('measure-clear').addEventListener('click', () => {
  state.measure = [];
  PANELS.measure.show();
});

// An edit that moves vertices but keeps the triangles in order (mirror,
// smooth): the models stay as they are, one undo step.
function reshape(fn) {
  if (!state.mesh) return;
  const before = snapshotAll();
  state.moving = false;
  const message = fn(state.mesh);
  state.undo.push(before);
  if (state.undo.length > 50) state.undo.shift();
  state.redo = [];
  refresh();
  if (message) toast(message);
}

// Mirror.
for (const b of document.querySelectorAll('[data-mirror]')) {
  b.addEventListener('click', () => {
    const axis = +b.dataset.mirror;
    const faces = targetFaces();
    const fm = faces ? faceMaskOf(faces) : null;
    const vm = fm ? state.mesh.verticesOf(fm) : null;
    reshape((mesh) => {
      const { min, max } = mesh.bounds(fm);
      const c = [0, 1, 2].map((i) => (min[i] + max[i]) / 2);
      mirror(mesh, axis, c, vm, fm);
      if (axis === 2) {
        const z = mesh.bounds(fm).min[2];
        mesh.translate(0, 0, -z, vm);
      }
      return `Mirrored ${['left ↔ right', 'front ↔ back', 'upside down'][axis]}`;
    });
  });
}

// Smooth.
$('sm-strength').addEventListener('input', (e) => ($('sm-strength-val').textContent = e.target.value + '%'));
$('sm-passes').addEventListener('keydown', (e) => e.stopPropagation());
$('sm-run').addEventListener('click', () =>
  busy(async () => {
    await stage('Smoothing…', null);
    // Edit mode: the selected faces; else the selected models or everything.
    const faces = state.mode === 'edit' && countSelected() ? null : targetFaces();
    const fm = state.mode === 'edit' && countSelected() ? state.selection.slice() : faces ? faceMaskOf(faces) : null;
    reshape((mesh) => {
      // Each model's lowest point, to put it back down afterwards (smoothing
      // rounds the bottom edge a little).
      const models = state.mode === 'edit' && countSelected() ? [] : listGroups().map((g) => faceMaskOf(g.faces())).filter((m) => !fm || m.some((v, t) => v && fm[t]));
      const z0 = models.map((m) => mesh.bounds(m).min[2]);
      smooth(mesh, { passes: Math.max(1, Math.min(50, +$('sm-passes').value || 5)), strength: +$('sm-strength').value / 100, faceMask: fm });
      models.forEach((m, i) => mesh.translate(0, 0, z0[i] - mesh.bounds(m).min[2], mesh.verticesOf(m)));
      return 'Smoothed – Ctrl+Z to undo';
    });
  }),
);

// ---------------------------------------------------------------------------
// Solid operations (csg.js, manifold-3d – loaded when first needed).

let manifoldWasm = null;
async function manifoldModule() {
  if (!manifoldWasm) {
    const [{ default: Module }, { default: wasmUrl }] = await Promise.all([import('manifold-3d'), import('manifold-3d/manifold.wasm?url')]);
    const wasm = await Module({ locateFile: () => wasmUrl });
    wasm.setup();
    manifoldWasm = wasm;
  }
  return manifoldWasm;
}

// The models a tool works on: the selected ones, else all. [{ id, name, faces }]
function targetGroups() {
  const all = listGroups();
  if (!countSelected()) return all;
  return all.filter((g) => g.parts.some((p) => p.faces.some((t) => state.selection[t])));
}
const meshOfGroup = (g) => {
  const m = state.mesh.extractFaceList(g.faces());
  return { positions: m.positions, indices: m.indices };
};

// Replace models: drops the faces of `groups` (ids) and adds `meshes`
// ([{ positions, indices, name }]) as models of their own. One undo step.
function replaceModels(groups, meshes, message) {
  const drop = new Set(groups);
  const keepGroups = [];
  edit((mesh) => {
    const P = mesh.positions, I = mesh.indices;
    const keep = [];
    for (let t = 0; t < mesh.triangleCount; t++) if (!drop.has(state.faceGroup[t])) keep.push(t);
    for (const t of keep) keepGroups.push(state.faceGroup[t]);
    const nv = P.length / 3 + meshes.reduce((n, m) => n + m.positions.length / 3, 0);
    const pos = new Float32Array(nv * 3);
    pos.set(P);
    const idx = new Uint32Array(keep.length * 3 + meshes.reduce((n, m) => n + m.indices.length, 0));
    keep.forEach((t, i) => idx.set(I.subarray(t * 3, t * 3 + 3), i * 3));
    let vo = P.length / 3, io = keep.length * 3;
    for (const m of meshes) {
      pos.set(m.positions, vo * 3);
      for (let i = 0; i < m.indices.length; i++) idx[io + i] = m.indices[i] + vo;
      vo += m.positions.length / 3;
      io += m.indices.length;
    }
    mesh._set(pos, idx);
    // Unused vertices of the dropped faces go away.
    mesh.deleteFaces(new Uint8Array(mesh.triangleCount));
    return message;
  });
  const next = new Int32Array(state.mesh.triangleCount);
  next.set(keepGroups);
  let o = keepGroups.length;
  for (const m of meshes) {
    next.fill(newGroupId(m.name), o, o + m.indices.length / 3);
    o += m.indices.length / 3;
  }
  state.faceGroup = next;
  state.selection = new Uint8Array(state.mesh.triangleCount);
  viewer.setSelection(state.selection);
  renderObjectList();
  updateExportLabels();
  refreshPanel();
}

function solidTask(label, fn) {
  return busy(async () => {
    await stage(label, null);
    const wasm = await manifoldModule();
    await new Promise((r) => setTimeout(r, 20)); // let the label show
    try {
      await fn(wasm);
    } catch (err) {
      toast(err.message || String(err));
    }
  });
}

// Combine.
PANELS.combine = {
  open: () => PANELS.combine.refresh(),
  refresh() {
    const groups = countSelected() ? targetGroups() : [];
    $('cb-info').textContent = groups.length >= 2 ? `${groups.length} models selected: ${groups.map((g) => g.name).join(', ')}.` : 'Select at least two models (click, Shift-click).';
    const sel = $('cb-keep');
    sel.innerHTML = '';
    for (const g of groups) sel.add(new Option(g.name, g.id));
    for (const id of ['cb-join', 'cb-cut', 'cb-overlap']) $(id).disabled = groups.length < 2;
  },
};
const doCombine = (op) => {
  const groups = targetGroups();
  if (groups.length < 2) return;
  let ordered = groups;
  if (op === 'cut') {
    const keepId = +$('cb-keep').value;
    ordered = [groups.find((g) => g.id === keepId), ...groups.filter((g) => g.id !== keepId)];
  }
  solidTask('Combining…', (wasm) => {
    const r = combine(wasm, ordered.map(meshOfGroup), op);
    const name = op === 'join' ? ordered.map((g) => g.name).join(' + ') : op === 'cut' ? `${ordered[0].name} (cut)` : 'Overlap';
    replaceModels(ordered.map((g) => g.id), [{ ...r, name }], { join: 'Joined into one model', cut: 'Cut out', overlap: 'Kept the overlap' }[op]);
  });
};
$('cb-join').addEventListener('click', () => doCombine('join'));
$('cb-cut').addEventListener('click', () => doCombine('cut'));
$('cb-overlap').addEventListener('click', () => doCombine('overlap'));

// Base.
PANELS.base = { open() {} };
$('bs-add').addEventListener('click', () => {
  const groups = targetGroups();
  if (!groups.length) return;
  const opts = { shape: $('bs-shape').value, margin: +$('bs-margin').value || 0, height: Math.max(0.6, +$('bs-height').value || 3), bevel: Math.max(0, +$('bs-bevel').value || 0), join: $('bs-join').checked };
  solidTask('Adding the base…', (wasm) => {
    // All target models on one base: joined first when there are several.
    const model = groups.length > 1 ? combine(wasm, groups.map(meshOfGroup), 'join') : meshOfGroup(groups[0]);
    const name = groups.map((g) => g.name).join(' + ');
    const r = addBase(wasm, model, opts);
    const meshes = opts.join ? [{ ...r.mesh, name: `${name} on base` }] : [{ ...r.model, name }, { ...r.base, name: 'Base' }];
    replaceModels(groups.map((g) => g.id), meshes, 'Base added');
  });
});

// Text / logo.
state.txMode = 'raise';
for (const b of document.querySelectorAll('[data-txmode]')) {
  b.addEventListener('click', () => {
    state.txMode = b.dataset.txmode;
    for (const o of document.querySelectorAll('[data-txmode]')) o.classList.toggle('active', o === b);
  });
}
const fonts = {};
async function loadFont(name) {
  if (!fonts[name]) {
    const [{ Font }, json] = await Promise.all([
      import('three/examples/jsm/loaders/FontLoader.js'),
      {
        helvetiker_bold: () => import('three/examples/fonts/helvetiker_bold.typeface.json'),
        helvetiker_regular: () => import('three/examples/fonts/helvetiker_regular.typeface.json'),
        optimer_bold: () => import('three/examples/fonts/optimer_bold.typeface.json'),
        gentilis_bold: () => import('three/examples/fonts/gentilis_bold.typeface.json'),
      }[name](),
    ]);
    fonts[name] = new Font(json.default || json);
  }
  return fonts[name];
}
PANELS.text = {
  open() {
    state.pickMode = 'text';
    state.txSpot = null;
    $('tx-apply').disabled = true;
    $('tx-hint').textContent = 'Click on the model where it should go.';
  },
  click(point, face) {
    if (face < 0) return;
    const n = new THREE.Vector3(...state.mesh.faceNormals().slice(face * 3, face * 3 + 3));
    state.txSpot = { point, normal: n.toArray(), group: state.faceGroup[face] };
    viewer.setMarkers([point], { lines: false });
    $('tx-apply').disabled = false;
    $('tx-hint').textContent = `On ${groupName(state.txSpot.group)} – press “Add it”, or click elsewhere to move it.`;
  },
};
$('tx-svg').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  state.txSvg = f ? await f.text() : null;
  $('tx-logo').hidden = !f;
  $('tx-logo').textContent = f ? `Logo: ${f.name} (clear the file to use text)` : '';
  $('tx-size-label').textContent = f ? 'Logo width' : 'Letter height';
});
for (const id of ['tx-text', 'tx-size', 'tx-depth', 'tx-angle']) $(id).addEventListener('keydown', (e) => e.stopPropagation());
$('tx-apply').addEventListener('click', () => {
  const spot = state.txSpot;
  if (!spot) return;
  const g = listGroups().find((x) => x.id === spot.group);
  if (!g) return;
  solidTask(state.txSvg ? 'Adding the logo…' : 'Adding the text…', async (wasm) => {
    const size = Math.max(0.5, +$('tx-size').value || 6);
    let polys;
    if (state.txSvg) {
      const { SVGLoader } = await import('three/examples/jsm/loaders/SVGLoader.js');
      polys = svgOutlines(SVGLoader, state.txSvg, size);
    } else {
      const text = $('tx-text').value.trim();
      if (!text) throw new Error('Type the text first.');
      polys = textOutlines(await loadFont($('tx-font').value), text, size);
    }
    const r = stamp(wasm, meshOfGroup(g), polys, { point: spot.point, normal: spot.normal, depth: Math.max(0.1, +$('tx-depth').value || 1), mode: state.txMode, angle: +$('tx-angle').value || 0 });
    replaceModels([g.id], [{ ...r, name: g.name }], state.txMode === 'raise' ? 'Added – Ctrl+Z to undo' : 'Engraved – Ctrl+Z to undo');
    state.txSpot = null;
    viewer.setMarkers(null);
    $('tx-apply').disabled = true;
    $('tx-hint').textContent = 'Done. Click on the model to add another.';
  });
});

// Hollow & drain holes.
PANELS.hollow = {
  open() {
    state.pickMode = 'hollow';
    PANELS.hollow.show();
  },
  show() {
    const n = state.drains?.length || 0;
    viewer.setMarkers((state.drains || []).map((h) => h.point), { lines: false, color: 0x5cc8ff });
    $('hl-holes').textContent = n ? `${n} hole${n > 1 ? 's' : ''} placed – click to add more, then “Drill holes”.` : 'Click on the model where each hole goes (near the bottom, on the side facing the plate).';
    $('hl-drill').disabled = $('hl-clear').disabled = !n;
  },
  click(point, face) {
    if (face < 0) return;
    const n = state.mesh.faceNormals().slice(face * 3, face * 3 + 3);
    state.drains = [...(state.drains || []), { point, normal: [...n], group: state.faceGroup[face] }];
    PANELS.hollow.show();
  },
};
$('hl-clear').addEventListener('click', () => {
  state.drains = [];
  PANELS.hollow.show();
});
for (const id of ['hl-wall', 'hl-dia']) $(id).addEventListener('keydown', (e) => e.stopPropagation());
$('hl-run').addEventListener('click', () => {
  const groups = targetGroups();
  const wall = Math.max(0.5, +$('hl-wall').value || 2);
  solidTask('Hollowing – this can take a little while…', (wasm) => {
    const out = [];
    let before = 0, after = 0;
    for (const g of groups) {
      const m = meshOfGroup(g);
      const r = hollow(wasm, m, { wall });
      before += modelInfo(state.mesh, g.faces()).volume;
      after += modelInfo({ positions: r.mesh.positions, indices: r.mesh.indices, triangleCount: r.mesh.indices.length / 3 }).volume;
      out.push({ ...r.mesh, name: g.name });
    }
    replaceModels(groups.map((g) => g.id), out, `Hollowed with ${wall} mm walls`);
    $('hl-info').textContent = `Resin ${(before / 1000).toFixed(1)} → ${(after / 1000).toFixed(1)} ml (−${Math.round((1 - after / before) * 100)} %). Now add drain holes.`;
  });
});
$('hl-drill').addEventListener('click', () => {
  const drains = state.drains || [];
  if (!drains.length) return;
  const dia = Math.max(0.5, +$('hl-dia').value || 3);
  const depth = Math.max(4, (+$('hl-wall').value || 2) * 3);
  solidTask('Drilling…', (wasm) => {
    const byGroup = new Map();
    for (const h of drains) byGroup.set(h.group, [...(byGroup.get(h.group) || []), h]);
    const groups = listGroups().filter((g) => byGroup.has(g.id));
    const out = groups.map((g) => ({ ...drillHoles(wasm, meshOfGroup(g), byGroup.get(g.id), { diameter: dia, depth }), name: g.name }));
    replaceModels(groups.map((g) => g.id), out, `Drilled ${drains.length} drain hole${drains.length > 1 ? 's' : ''}`);
    state.drains = [];
    PANELS.hollow.show();
  });
});

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
for (const b of document.querySelectorAll('[data-rotate]')) {
  b.addEventListener('click', () => {
    const [x, y, z, sign] = b.dataset.rotate.split(',').map(Number);
    rotateBy([x, y, z], sign * (z ? rotateStep : 90));
  });
}
for (const b of document.querySelectorAll('[data-angle]')) {
  b.addEventListener('click', () => {
    rotateStep = +b.dataset.angle;
    for (const o of document.querySelectorAll('[data-angle]')) o.classList.toggle('active', o === b);
  });
}
$('move-center').addEventListener('click', () => placeTarget({ center: true, drop: true }));
$('move-drop').addEventListener('click', () => placeTarget({ center: false, drop: true }));
// Shortcuts box under the "?" – open by default, remembers being closed.
function showHelp(show) {
  $('help').hidden = !show;
  try {
    localStorage.setItem('help-hidden', show ? '0' : '1');
  } catch {
    // storage unavailable: just don't remember
  }
}
$('help-open').addEventListener('click', () => showHelp($('help').hidden));
$('help-close').addEventListener('click', () => showHelp(false));
try {
  showHelp(localStorage.getItem('help-hidden') !== '1');
} catch {
  showHelp(true);
}

// ---------------------------------------------------------------------------
// Plane cut with connector pins

// The cut plane: n·p = offset. `center` (on the plane) is where the orb sits,
// `u` an in-plane direction that orients the orb's rings.
const cut = { mode: 'z', normal: [0, 0, 1], offset: 0, center: null, u: [1, 0, 0], manual: [] };
const manualPlacement = () => $('cut-place').value === 'manual';
const cutGizmo = new CutGizmo(viewer, () => cutFromGizmo());
const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

// Range of positions along the cut normal that cross the model.
function cutRange() {
  const p = state.mesh.positions, n = cut.normal;
  let lo = Infinity, hi = -Infinity;
  for (let v = 0; v < p.length; v += 3) {
    const d = n[0] * p[v] + n[1] * p[v + 1] + n[2] * p[v + 2];
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return [lo, hi];
}

function setCut({ mode, normal, offset } = {}) {
  if (!state.mesh) return;
  if (mode) cut.mode = mode;
  if (normal) {
    // Hand-placed connectors follow small tilts; a new direction clears them.
    if (cut.manual.length && normal[0] * cut.normal[0] + normal[1] * cut.normal[1] + normal[2] * cut.normal[2] < 0.87) cut.manual = [];
    cut.normal = normal;
  }
  const [lo, hi] = cutRange();
  cut.offset = offset ?? (cut.offset > lo && cut.offset < hi ? cut.offset : (lo + hi) / 2);
  orientCutHandle();
  syncCutControls(lo, hi);
}

// Keeps the orb on the plane (near the model's centre) and its rings square to the normal.
function orientCutHandle() {
  const n = cut.normal;
  const dotN = (p) => n[0] * p[0] + n[1] * p[1] + n[2] * p[2];
  const c = cut.center || viewer.geometry.boundingSphere.center.toArray();
  const d = dotN(c) - cut.offset;
  cut.center = [c[0] - d * n[0], c[1] - d * n[1], c[2] - d * n[2]];
  let u = cut.u;
  const un = dotN(u);
  u = [u[0] - un * n[0], u[1] - un * n[1], u[2] - un * n[2]];
  if (Math.hypot(...u) < 1e-6) u = Math.abs(n[0]) < 0.9 ? [1 - n[0] * n[0], -n[0] * n[1], -n[0] * n[2]] : [-n[1] * n[0], 1 - n[1] * n[1], -n[1] * n[2]];
  const l = Math.hypot(...u);
  cut.u = u.map((x) => x / l);
}

// After dragging the orb: the plane follows the handle.
function cutFromGizmo() {
  const n = cut.normal, c = cut.center;
  cut.mode = 'free';
  cut.offset = n[0] * c[0] + n[1] * c[1] + n[2] * c[2];
  syncCutControls(...cutRange());
}

function syncCutControls(lo, hi) {
  const slider = $('cut-pos');
  slider.min = lo;
  slider.max = hi;
  slider.step = (hi - lo) / 1000 || 0.01;
  slider.value = cut.offset;
  $('cut-pos-num').value = cut.offset.toFixed(2);
  for (const b of document.querySelectorAll('[data-plane]')) b.classList.toggle('active', b.dataset.plane === cut.mode);
  showCutPlane();
  scheduleCutAnalysis();
}

function showCutPlane() {
  const on = state.tool === 'cut' && !!state.mesh;
  if (!on) {
    viewer.setConnectorPreview(null);
    viewer.setCutOutline(null);
    viewer.setCutOutline(null);
  }
  viewer.setCutPlane(on ? cut : null);
  cutGizmo.update(on ? cut : null, on ? viewer.geometry.boundingSphere.radius : 0);
}

function cutOptions() {
  return {
    type: $('cut-type').value,
    pins: $('cut-pins').value,
    diameter: +$('cut-dia').value || 0,
    length: +$('cut-len').value || 0,
    tolerance: Math.max(0, +$('cut-tol').value || 0),
    manual: manualPlacement() ? cut.manual.map(onCutPlane) : undefined,
    sizeScale: choosingOptions() ? state.cutScale || 1 : 1,
  };
}

// With automatic size, count and placement, the analysis offers a few
// connector choices (recommended, bigger/fewer, smaller/more) to pick from.
function choosingOptions() {
  return !manualPlacement() && $('cut-type').value !== 'none' && !(+$('cut-dia').value) && $('cut-pins').value === 'auto';
}

// A point moved straight onto the current cut plane.
function onCutPlane(p) {
  const n = cut.normal;
  const d = n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - cut.offset;
  return [p[0] - d * n[0], p[1] - d * n[1], p[2] - d * n[2]];
}

// Manual placement: a click on the plane adds a connector there (Ctrl+click
// removes the nearest one); it is checked at once.
function manualClick(p, remove) {
  const ray = viewer.rayAt(p.x, p.y);
  const n = new THREE.Vector3(...cut.normal);
  const hit = ray.intersectPlane(new THREE.Plane(n, -cut.offset), new THREE.Vector3());
  if (!hit) return;
  const q = hit.toArray();
  if (remove) {
    if (!cut.manual.length) return;
    let best = 0;
    cut.manual.forEach((m, i) => {
      const a = onCutPlane(m), b = onCutPlane(cut.manual[best]);
      if (Math.hypot(a[0] - q[0], a[1] - q[1], a[2] - q[2]) < Math.hypot(b[0] - q[0], b[1] - q[1], b[2] - q[2])) best = i;
    });
    cut.manual.splice(best, 1);
    runCutAnalysis();
    toast('Connector removed');
    return;
  }
  cut.manual.push(q);
  runCutAnalysis();
  const m = state.cutPlan?.manual?.at(-1);
  if (m) toast(`${m.ok ? '✓' : '✗'} Connector ${cut.manual.length}: ${m.reason}`);
}

function syncPlacementUI() {
  const manual = manualPlacement();
  $('cut-manual').hidden = !manual;
  $('cut-pins-row').hidden = manual;
}
$('cut-place').addEventListener('change', () => {
  syncPlacementUI();
  scheduleCutAnalysis();
});
$('cut-clear').addEventListener('click', () => {
  cut.manual = [];
  scheduleCutAnalysis();
});

// Step 1/2/3 of the cut guide.
function setCutStep(step) {
  for (const li of document.querySelectorAll('#cut-guide li')) {
    const n = +li.dataset.step;
    li.classList.toggle('step-current', n === step);
    li.classList.toggle('step-done', n < step);
  }
}

const fmtMM = (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));

function connectorText(conns) {
  if (!conns.length) return 'no connectors';
  const pins = conns.filter((c) => c.kind === 'pin'), dowels = conns.filter((c) => c.kind === 'dowel');
  // "3 pins Ø6 × 9", or with mixed sizes "5 pins Ø4–8".
  const range = (vals) => {
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return hi - lo < 0.05 ? fmtMM(lo) : `${fmtMM(lo)}–${fmtMM(hi)}`;
  };
  const part = (list, name) =>
    list.length ? `${list.length} ${name}${list.length > 1 ? 's' : ''} Ø${range(list.map((c) => 2 * c.r))} × ${range(list.map((c) => (c.kind === 'dowel' ? 2 * c.h : c.h)))}` : '';
  return [part(pins, 'pin'), part(dowels, 'dowel')].filter(Boolean).join(' + ');
}

// Analyses the current plane (debounced) and shows, per cut area, which
// connectors fit and why – plus a preview on the plane.
let analysisTimer = null;
function scheduleCutAnalysis() {
  clearTimeout(analysisTimer);
  if (state.tool !== 'cut' || !state.mesh) return;
  $('cut-done').hidden = true;
  setCutStep(1);
  if (state.mesh.triangleCount > 400000) {
    // Big models: on request only.
    viewer.setConnectorPreview(null);
    viewer.setCutOutline(null);
    $('cut-analysis').innerHTML = '<button id="cut-analyse">Check connectors for this plane</button>';
    $('cut-analyse').addEventListener('click', () => runCutAnalysis());
    return;
  }
  analysisTimer = setTimeout(runCutAnalysis, 350);
}

function runCutAnalysis() {
  const box = $('cut-analysis');
  let result, options = null;
  try {
    if (choosingOptions()) {
      options = connectorOptions(state.mesh, cut, cutOptions());
      const pick = options.find((o) => o.scale === (state.cutScale || 1)) || options[0];
      state.cutScale = pick.scale;
      result = pick.result;
    } else result = analyzeCut(state.mesh, cut, cutOptions());
  } catch (err) {
    box.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'overall';
    p.textContent = err.message;
    box.append(p);
    viewer.setConnectorPreview(null);
    viewer.setCutOutline(null);
    state.cutPlan = null;
    return;
  }
  state.cutPlan = result;
  setCutStep(2);
  box.innerHTML = '';
  if (options && options.length > 1) {
    const list = document.createElement('div');
    list.className = 'cut-options';
    list.innerHTML = '<div class="sub-head">Choose the connectors</div>';
    const rec = options[0].result;
    // Biggest first; the recommended one is marked.
    for (const o of [...options].sort((a, b) => b.scale - a.scale)) {
      const conns = o.result.areas.flatMap((a) => a.connectors);
      const lost = o.result.areas.some((a, i) => !a.connectors.length && rec.areas[i]?.connectors.length);
      const b = document.createElement('button');
      b.className = 'cut-option' + (o.scale === state.cutScale ? ' active' : '');
      b.innerHTML = '<span class="dot"></span><span class="label"></span><span class="what"></span>';
      const n = conns.length, n0 = rec.pins.length;
      b.querySelector('.label').textContent =
        o.scale === 1 ? 'Recommended' : o.scale > 1 ? (n < n0 ? 'Fewer, bigger' : 'Bigger') : n > n0 ? 'More, smaller' : 'Smaller';
      b.querySelector('.what').textContent = connectorText(conns) + (lost ? ' · some areas glue only' : '');
      b.title = 'Use these connectors – the preview and the cut follow your choice';
      b.addEventListener('click', () => {
        state.cutScale = o.scale;
        runCutAnalysis();
      });
      list.append(b);
    }
    box.append(list);
  }
  const areas = result.areas;
  const shown = areas.slice(0, 8);
  shown.forEach((a, i) => {
    const div = document.createElement('div');
    div.className = 'area ' + (a.connectors.length ? 'ok' : 'none');
    const label = areas.length > 1 ? `Area ${i + 1}` : 'Cut area';
    div.innerHTML = '<div class="what"></div><div class="why"></div>';
    div.querySelector('.what').textContent = `${label} · ${fmtMM(a.size[0])} × ${fmtMM(a.size[1])} mm → ${a.connectors.length ? connectorText(a.connectors) : 'glue only'}`;
    div.querySelector('.why').textContent = [...new Set(a.notes)].join(' ') || (a.connectors.length ? 'Fits with walls around every hole.' : '');
    box.append(div);
  });
  if (areas.length > shown.length) {
    const more = areas.slice(shown.length);
    const p = document.createElement('p');
    p.className = 'overall';
    p.textContent = `+ ${more.length} smaller areas: ${more.reduce((n, a) => n + a.connectors.length, 0)} connectors.`;
    box.append(p);
  }
  for (const note of result.notes) {
    const p = document.createElement('p');
    p.className = 'overall';
    p.textContent = note;
    box.append(p);
  }
  if (result.manual) {
    result.manual.forEach((m, i) => {
      const div = document.createElement('div');
      div.className = 'area ' + (m.ok ? 'ok' : 'none');
      div.innerHTML = '<div class="what"></div><div class="why"></div>';
      div.querySelector('.what').textContent = `Connector ${i + 1} ${m.ok ? '✓' : '✗'}`;
      div.querySelector('.why').textContent = m.reason;
      box.append(div);
    });
  }
  // Connectors that don't fit are shown in red where they were placed.
  const bad = (result.manual || []).filter((m) => !m.ok).map((m) => ({ kind: 'bad', center3: m.point, r: m.size?.r || 1.5, h: m.size?.h || 3 }));
  viewer.setConnectorPreview([...areas.flatMap((a) => a.connectors), ...bad], cut.normal);
  viewer.setCutOutline(result.outlines);
}

function doCut() {
  if (!state.mesh) return;
  clearTimeout(analysisTimer);
  const before = state.mesh.triangleCount;
  let result = null;
  edit((mesh) => {
    try {
      result = cutWithPins(mesh, cut, cutOptions());
      return `Cut into closed halves with ${connectorText(result.areas.flatMap((a) => a.connectors))}`;
    } catch (err) {
      toast(err.message);
    }
  });
  clearTimeout(analysisTimer); // the plane now sits on the new caps – nothing to analyse until it moves
  $('cut-analysis').innerHTML = '';
  if (!result || state.mesh.triangleCount === before) return;
  cut.manual = [];
  state.lastCut = {
    normal: [...cut.normal],
    offset: cut.offset,
    dowelFaces: result.dowelFaces,
    hasPins: result.pins.some((p) => p.kind === 'pin'),
    longest: Math.max(0, ...result.pins.map((p) => Math.max(p.length, p.holeDepth))),
  };
  // The halves become separate models (the lower one keeps the name); the
  // dowels are one more model.
  {
    const next = Int32Array.from(state.faceGroup);
    const groups = cutGroups();
    const upperOf = new Map();
    for (const part of groups.upper) {
      const g = next[part.faces[0]];
      if (!upperOf.has(g)) upperOf.set(g, newGroupId(`${groupName(g)} (top)`));
      for (const t of part.faces) next[t] = upperOf.get(g);
    }
    // All dowels together: one model of their own, lying beside the model.
    if (groups.dowel.length) {
      const id = newGroupId(groups.dowel.length === 1 ? 'Dowel' : `Dowels (${groups.dowel.length})`);
      for (const part of groups.dowel) for (const t of part.faces) next[t] = id;
    }
    state.faceGroup = next;
    renderObjectList();
    updateExportLabels();
  }
  viewer.setConnectorPreview(null);
  viewer.setCutOutline(null);
  setCutStep(4);
  const conns = result.areas.flatMap((a) => a.connectors);
  const where = conns.length ? ` ${connectorSides(cut.normal, conns)} The halves still touch, so the connectors sit inside each other – “Pull apart” shows them.` : '';
  $('cut-done-text').textContent = `Cut done – ${connectorText(conns)}.${where} Next: arrange the halves for printing, then download the parts.`;
  const tips = [
    'Arrange for printing lays each half on its best face and puts them side by side.',
    ...result.notes,
    `Holes are ${(+$('cut-tol').value || 0).toFixed(2)} mm wider than the pins: if the fit is too tight after printing, raise "Hole wider by" (e.g. 0.3–0.4 mm) and cut again (Ctrl+Z first).`,
    'Glue with CA (super glue) or epoxy; dry-fit first.',
  ];
  const ul = $('cut-tips');
  ul.innerHTML = '';
  for (const t of tips) {
    const li = document.createElement('li');
    li.textContent = t;
    ul.append(li);
  }
  $('cut-done').hidden = false;
  showCutPlane();
}

// Where the connectors went, in words: "Pins stand on the −X half, …".
function connectorSides(n, conns) {
  const k = [0, 1, 2].reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a), 0);
  const axis = 'XYZ'[k];
  const pos = n[k] > 0;
  const names = k === 2 ? ['bottom', 'top'] : [`−${axis}`, `+${axis}`];
  const lower = names[pos ? 0 : 1], upper = names[pos ? 1 : 0];
  const pins = conns.filter((c) => c.kind === 'pin').length, dowels = conns.length - pins;
  return [
    pins ? `Pins stand on the ${lower} half; their holes are in the ${upper} half.` : '',
    dowels ? `Dowel holes are in both halves; the dowels lie on the plate beside the model as one group.` : '',
  ].filter(Boolean).join(' ');
}

// The parts of the model after the last cut, by side of the cut plane.
function cutGroups() {
  const lc = state.lastCut;
  const mesh = state.mesh;
  const n = lc.normal;
  const groups = { lower: [], upper: [], dowel: [] };
  for (const part of mesh.parts()) {
    const f0 = part.faces[0];
    if (lc.dowelFaces && f0 >= lc.dowelFaces[0] && f0 < lc.dowelFaces[1]) {
      groups.dowel.push(part);
      continue;
    }
    const b = mesh.boundsOfFaces(part.faces);
    const c = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2);
    groups[n[0] * c[0] + n[1] * c[1] + n[2] * c[2] > lc.offset ? 'upper' : 'lower'].push(part);
  }
  return groups;
}

const maskOfParts = (list) => {
  const m = new Uint8Array(state.mesh.triangleCount);
  for (const p of list) for (const t of p.faces) m[t] = 1;
  return m;
};

// After a cut: slide the upper half away along the plane normal so the pins
// and holes are visible.
function pullApart() {
  const lc = state.lastCut;
  const mesh = state.mesh;
  if (!lc || !mesh) return;
  const { upper } = cutGroups();
  if (!upper.length) return;
  const gap = Math.max(10, lc.longest * 3);
  const d = lc.normal.map((x) => x * gap);
  transformBurst(() => mesh.translate(d[0], d[1], d[2], mesh.verticesOf(maskOfParts(upper))));
  state.moving = false;
  lc.offset += gap; // the upper half moved with its side of the plane
  viewer.frame();
  toast('Halves pulled apart – rotate the view to see the pins and holes');
}

// After a cut: lay the halves on their best faces and place everything side
// by side on the plate (one undo step).
function arrangeForPrinting() {
  const lc = state.lastCut;
  const mesh = state.mesh;
  if (!lc || !mesh) return;
  const n = lc.normal;
  const groups = cutGroups();
  const maskOf = maskOfParts;
  transformBurst(() => {
    // Upper half: cut face (facing -n) down. Lower half: with pins, cut face up
    // so the pins point up; without, cut face down (flat on the plate).
    if (groups.upper.length) mesh.layFlat(n.map((x) => -x), maskOf(groups.upper));
    if (groups.lower.length) mesh.layFlat(lc.hasPins ? n.map((x) => -x) : n, maskOf(groups.lower));
    let x = 0;
    for (const key of ['lower', 'upper', 'dowel']) {
      if (!groups[key].length) continue;
      const mask = maskOf(groups[key]);
      const b = mesh.bounds(mask);
      mesh.translate(x - b.min[0], -(b.min[1] + b.max[1]) / 2, -b.min[2], mesh.verticesOf(mask));
      x += b.max[0] - b.min[0] + 5;
    }
    // Centre the whole layout on the plate.
    const all = mesh.bounds();
    mesh.translate(-(all.min[0] + all.max[0]) / 2, 0, 0);
  });
  state.moving = false;
  setTool('move'); // hides the cut plane; parts can be nudged now
  viewer.frame();
  toast('Arranged for printing – nudge parts with Move if needed, then Export ▾ → Download all parts');
}

$('cut-arrange').addEventListener('click', arrangeForPrinting);
$('cut-apart').addEventListener('click', pullApart);
$('cut-export').addEventListener('click', () => $('export-zip').click());
for (const id of ['cut-type', 'cut-pins', 'cut-dia', 'cut-len', 'cut-tol']) $(id).addEventListener('change', scheduleCutAnalysis);

for (const b of document.querySelectorAll('[data-plane]')) {
  b.addEventListener('click', () => {
    const mode = b.dataset.plane;
    if (mode === 'face') {
      cut.mode = 'face';
      for (const o of document.querySelectorAll('[data-plane]')) o.classList.toggle('active', o === b);
      toast('Click a face of the model – the cut plane will be parallel to it');
      return;
    }
    cut.u = mode === 'x' ? [0, 1, 0] : [1, 0, 0];
    setCut({ mode, normal: AXES[mode], offset: null });
  });
}
$('cut-pos').addEventListener('input', (e) => setCut({ offset: +e.target.value }));
$('cut-pos-num').addEventListener('change', (e) => setCut({ offset: +e.target.value }));
$('cut-flip').addEventListener('click', () => setCut({ normal: cut.normal.map((x) => -x), offset: -cut.offset }));
$('cut-reset').addEventListener('click', () => {
  cut.center = null;
  cut.u = [1, 0, 0];
  setCut({ mode: 'z', normal: [0, 0, 1], offset: null });
});
$('cut-go').addEventListener('click', doCut);

// Cut tool click: put the plane through the clicked point (Face mode: also
// turn it parallel to the clicked face).
function cutClick(face, p) {
  const point = viewer.pointAt(p.x, p.y);
  if (!point) return;
  const pt = point.toArray();
  let normal = cut.normal;
  if (cut.mode === 'face') normal = state.mesh.flatAreaNormal(face, 2).normal.map((x) => -x);
  cut.center = pt;
  setCut({ normal, offset: normal[0] * pt[0] + normal[1] * pt[1] + normal[2] * pt[2] });
}

// ---------------------------------------------------------------------------
// Resize

let scaleBase = null; // size of the target when the card was filled
let scaleEdited = null; // 'pct' or the axis index typed last
let scalePct0 = 100; // what the % box shows for the current size

// Accepts "1000", "1000 %", "12,5", "12.5 mm".
const readNumber = (id) => parseFloat($(id).value.replace(',', '.').replace(/[^\d.eE+-]/g, ''));

function scaleTargetBounds() {
  const target = moveTarget();
  const b = target.faces ? state.mesh.bounds(target.faces) : state.mesh.bounds();
  return { target, size: [0, 1, 2].map((k) => b.max[k] - b.min[k]) };
}

function fillScale({ force = false } = {}) {
  if (!state.mesh) return;
  // Don't overwrite what the user is typing.
  if (!force && scaleBase && document.activeElement?.closest?.('[data-card="scale"]')) return;
  const { target, size } = scaleTargetBounds();
  scaleBase = size;
  scaleEdited = null;
  $('scale-target').textContent = target.faces
    ? 'Resizing the selected parts.'
    : countSelected()
      ? 'The selection is joined to the rest of the model, so the whole model is resized. Split it (S) first to resize it on its own.'
      : 'Resizing the whole model.';
  ['x', 'y', 'z'].forEach((a, k) => ($('scale-' + a).value = size[k].toFixed(2)));
  // The whole model's % is measured against its size when it was opened.
  scalePct0 = !target.faces && state.openSize ? (Math.max(...size) / state.openSize) * 100 : 100;
  $('scale-pct').value = String(+scalePct0.toFixed(2));
  $('scale-pct-of').textContent = target.faces ? '% of now' : '% of original';
}

// Typing one size with "keep proportions" scales the others to match.
['x', 'y', 'z'].forEach((a, k) => {
  $('scale-' + a).addEventListener('input', () => {
    scaleEdited = k;
    if (!scaleBase || !scaleBase[k]) return;
    const f = readNumber('scale-' + a) / scaleBase[k];
    if (!(f > 0)) return;
    if ($('scale-lock').checked) {
      ['x', 'y', 'z'].forEach((b, j) => j !== k && ($('scale-' + b).value = (scaleBase[j] * f).toFixed(2)));
      $('scale-pct').value = String(+(f * scalePct0).toFixed(2));
    } else {
      $('scale-pct').value = '';
    }
  });
});
$('scale-pct').addEventListener('input', () => {
  scaleEdited = 'pct';
  const f = readNumber('scale-pct') / scalePct0;
  if (!scaleBase || !(f > 0)) return;
  ['x', 'y', 'z'].forEach((a, k) => ($('scale-' + a).value = (scaleBase[k] * f).toFixed(2)));
});

function applyScale(factors) {
  if (!state.mesh) return;
  if (factors.some((f) => !(f > 0) || !isFinite(f))) {
    toast('Type a size above 0 (mm) or a percentage, e.g. 1000');
    return;
  }
  const { target } = scaleTargetBounds();
  const com = state.mesh.centerOfMass(target.faces);
  if (!com || factors.every((f) => Math.abs(f - 1) < 1e-9)) return;
  state.moving = false;
  transformBurst(() => state.mesh.scale(...factors, [com.center[0], com.center[1], com.minZ], target.vertices));
  state.moving = false;
  viewer.updatePlate();
  viewer.frame();
  fillScale({ force: true });
  const s = scaleBase.map((v) => v.toFixed(1)).join(' × ');
  const pct = $('scale-pct-of').textContent === '% of original' ? ` (${$('scale-pct').value} % of the original)` : '';
  toast(`Resized to ${s} mm${pct}`);
}

$('scale-apply').addEventListener('click', () => {
  if (!state.mesh) return;
  if (!scaleBase) fillScale({ force: true });
  // The size now, in case the model changed since the card was filled.
  const now = scaleTargetBounds().size;
  if (scaleEdited === 'pct') {
    const f = (readNumber('scale-pct') / scalePct0) * (Math.max(...scaleBase) / Math.max(...now) || 1);
    applyScale([f, f, f]);
    return;
  }
  applyScale(['x', 'y', 'z'].map((a, k) => (now[k] ? readNumber('scale-' + a) / now[k] : 1)));
});
for (const id of ['scale-x', 'scale-y', 'scale-z', 'scale-pct']) {
  $(id).addEventListener('keydown', (e) => e.key === 'Enter' && $('scale-apply').click());
}
for (const b of document.querySelectorAll('[data-scale]')) {
  b.addEventListener('click', () => {
    const f = +b.dataset.scale;
    applyScale([f, f, f]);
  });
}

// ---------------------------------------------------------------------------
// Keyboard

const toolKeys = {
  v: 'orbit', t: 'click', b: 'brush', x: 'box', p: 'part', g: 'region', o: 'object', k: 'block', r: 'rotate', l: 'layflat', c: 'cut', m: 'move', z: 'scale',
};

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
  } else if (mod && e.key.toLowerCase() === 'g') {
    e.shiftKey ? ungroupSelected() : groupSelected();
  } else if (mod) {
    return;
  } else if (e.key === 'Tab') {
    setMode(state.mode === 'edit' ? 'normal' : 'edit');
  } else if (e.key === '1' || e.key === '2' || e.key === '3') {
    setMode(['normal', 'edit', 'cut'][+e.key - 1]);
  } else if (e.key.toLowerCase() === 'o' && !e.shiftKey) {
    setTool(state.mode === 'edit' ? 'object' : 'pick');
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelected();
  } else if (e.key === 'Escape') {
    runSelection('none');
  } else if (e.key === '+' || e.key === '=') {
    runSelection('grow');
  } else if (e.key === '-') {
    runSelection('shrink');
  } else if (e.key === 'Enter' && state.tool === 'cut') {
    doCut();
  } else if (e.key.toLowerCase() === 's') {
    splitSelection();
  } else if (e.key.toLowerCase() === 'w') {
    openFix();
  } else if (e.key.toLowerCase() === 'h') {
    if (state.mesh) closeHoles();
  } else if (e.key.toLowerCase() === 'f') {
    viewer.frame();
  } else if (e.key === '?') {
    showHelp($('help').hidden);
  } else if (toolKeys[e.key.toLowerCase()] && !e.shiftKey) {
    setTool(toolKeys[e.key.toLowerCase()]);
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

setMode('normal');
updateButtons();

$('app-version').textContent = 'v' + __APP_VERSION__;
for (const el of document.querySelectorAll('.ver')) el.textContent = __APP_VERSION__;

// About window: the logo in the top bar, ⚙ → About, or Help → About in the
// Windows app (which calls window.showAbout).
function showAbout(show = true) {
  $('about').hidden = !show;
}
window.showAbout = showAbout;
$('brand').addEventListener('click', () => showAbout());
$('brand').addEventListener('keydown', (e) => e.key === 'Enter' && showAbout());
$('about-open').addEventListener('click', () => showAbout());
$('about-close').addEventListener('click', () => showAbout(false));
$('about').addEventListener('click', (e) => e.target === $('about') && showAbout(false));
window.addEventListener('keydown', (e) => e.key === 'Escape' && !$('about').hidden && showAbout(false));

// Splash: shown for a moment while the app starts, then fades out.
setTimeout(() => {
  $('splash').classList.add('hide');
  setTimeout(() => $('splash').remove(), 500);
}, Math.max(0, 1400 - performance.now()));
window.__appStarted = true;

// Unsaved edits: ask before the page is closed or navigated away from.
window.addEventListener('beforeunload', (e) => {
  if (state.undo.length) e.preventDefault();
});
