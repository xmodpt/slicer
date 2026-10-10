# STL Mesh Editor

A browser app to open STL files, delete parts of the mesh, and close the model
again so it's watertight.

## Run

```bash
npm install
npm run dev       # open the printed URL
npm run build     # static build in dist/ (works from any folder / web host)
npm test          # unit tests for the mesh logic
```

## Workflow

1. **Open** an `.stl` (binary or ASCII) with *Open STL…* or drag it onto the window.
2. **Select** the triangles to remove with one of the tools:

   | Tool | Key | What it does |
   |------|-----|--------------|
   | Orbit | 1 | Left-drag rotates the view |
   | Triangle | 2 | Click single triangles |
   | Brush | 3 | Paint over visible triangles |
   | Box | 4 | Drag a rectangle (tick *Select through* to include hidden faces) |
   | Part | 5 | Click to select a whole connected part (e.g. a floating support) |
   | Region | 6 | Click to flood-select a smooth/flat area up to a max angle |

   Shift adds, Ctrl removes. Right-drag rotates, middle-drag pans, wheel zooms,
   hold Alt to rotate with the left button. `Ctrl+A` all, `Esc` none,
   `Ctrl+I` invert, `+`/`-` grow/shrink.
3. **Delete** the selection (`Delete` / `Backspace`). Hole rims are outlined in red,
   and the inside of the model shows through in dark red.
4. **Close holes** (`H`) to cap every hole – or only holes up to N edges.
   Each hole is triangulated in its best-fit plane (flat cap for planar cuts),
   falling back to a fan around the centre for very twisted holes. The patch
   follows the orientation of the surrounding faces.
5. **Export STL** to download the edited model as binary STL.

`Ctrl+Z` / `Ctrl+Y` undo and redo. The *Model* panel shows triangle count,
holes, parts and whether the mesh is watertight.

## Code layout

- `src/stl.js` – STL parsing (binary + ASCII) and binary export.
- `src/mesh.js` – indexed mesh: vertex welding, topology, delete, hole detection
  and filling, selection helpers. No browser dependencies.
- `src/viewer.js` – Three.js rendering and GPU ID-buffer picking (selection only
  hits what you can see).
- `src/main.js` – UI, tools, undo/redo.
