# STL Mesh Editor

A browser app to open STL files, delete parts of the mesh, and close the model
again so it's watertight.

## Run

```bash
npm install
npm run dev       # open the printed URL
npm run build     # static build in dist/ (works from any folder / web host)
npm test          # unit tests for the mesh logic
npm start         # build + serve the optimized version (port 4173)
```

### Running on a Raspberry Pi / another machine

The server listens on all network interfaces, so on the Pi it prints a
`Network:` address next to `Local:`. Open that one (e.g.
`http://192.168.1.50:5173`, or `http://raspberrypi.local:5173`) from the
other computer – `localhost` only works on the Pi itself.

- Use `npm start` for everyday use – it's much lighter on the Pi than `npm run dev`.
- If the page still doesn't load, a firewall on the Pi may be blocking the port:
  `sudo ufw allow 5173` (dev) / `sudo ufw allow 4173` (`npm start`).
- To keep it running after you log out, use e.g. `pm2` or a systemd service
  running `npm start` in this folder.

### AI object recognition (optional)

The *Ask AI to identify objects* button sends a few rendered views of the model
to Claude, which names the detected objects (e.g. "Candle"), groups pieces that
belong together and suggests what to keep or remove – optionally based on a
goal you type, like "remove the candles". It runs on the server, so the API key
is never sent to the browser.

1. Get an API key at <https://console.anthropic.com/>.
2. On the machine running the app (e.g. the Pi), create a file `.env` in this
   folder containing:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
   (or `export ANTHROPIC_API_KEY=...` before `npm start`). `.env` is ignored by git.
3. Restart `npm start`.

Each analysis is one request to the Claude Opus 5.5 model with four images –
typically a few cents. Everything else in the app works without a key.

## Workflow

1. **Open** an `.stl` (binary or ASCII) with *Open STL…* or drag it onto the window.
2. **Select** the triangles to remove with one of the tools:

   | Tool | Key | What it does |
   |------|-----|--------------|
   | Object | 7 | Hover to preview, click to select a whole detected object (e.g. a candle on a cake) |
   | Orbit | 1 | Left-drag rotates the view |
   | Triangle | 2 | Click single triangles |
   | Brush | 3 | Paint over visible triangles |
   | Box | 4 | Drag a rectangle (tick *Select through* to include hidden faces) |
   | Part | 5 | Click to select a whole connected part (e.g. a floating support) |
   | Region | 6 | Click to flood-select a smooth/flat area up to a max angle |
   | Block | 8 | Drag a rectangle: cuts the model cleanly along its edges (all the way through) and selects the block inside |

   Shift adds, Ctrl removes. `Ctrl+A` all, `Esc` none, `Ctrl+I` invert,
   `+`/`-` grow/shrink.

   **Navigation:** right-drag rotates, Shift+right-drag or middle-drag pans,
   the wheel zooms toward the cursor, double-click sets the rotation centre,
   hold Alt to rotate with the left button. *Rotate: Free* tumbles in every
   direction; *Turntable* keeps Z up. The view buttons (Top, Front, Right…)
   look straight along an axis, and *Camera: Orthographic* removes
   perspective – together they give exact, axis-aligned Block cuts.

   **Objects found:** when a file is opened, the model is analysed and split
   into likely objects, even if everything is fused into one surface. Shapes
   are separated where the surface folds inwards (a concave crease, like the
   ring where a candle meets the cake top); tiny fragments are merged into their
   neighbours. The list shows each object with its size – hover to highlight it,
   click to select it (Shift adds, Ctrl removes), ✕ deletes it. If objects come
   out merged, lower *Split at creases over*; if the model is chopped into too
   many pieces, raise it. The *Sample* button loads a cake with candles to try it.
   After *Ask AI*, the list shows the AI's names and groups, items it suggests
   removing are tagged, and clicking one part of a group with the Object tool
   selects the whole group. Hover over a row to read the AI's reasoning.
3. **Delete** the selection (`Delete` / `Backspace`). Hole rims are outlined in red,
   and the inside of the model shows through in dark red.
4. **Close holes** (`H`) to cap every hole – or only holes up to N edges.
   Each hole is triangulated in its best-fit plane (flat cap for planar cuts),
   falling back to a fan around the centre for very twisted holes. The patch
   follows the orientation of the surrounding faces.
5. **Split into parts** (optional): select a region (e.g. with Block) and press
   *Split selection into new part* (`S`). The selection is detached from the
   rest and the cut faces on both sides are closed, so each part is a solid of
   its own. Example – an L-shaped wall: Top view, Orthographic, Block-drag over
   one leg starting at the corner, `S`.
6. **Export:** *Parts & export* lists every separate part. Download each part
   as its own STL, all parts in one ZIP, or *Export whole model* as one file.

`Ctrl+Z` / `Ctrl+Y` undo and redo. The *Model* panel shows triangle count,
holes, parts and whether the mesh is watertight.

## Code layout

- `src/stl.js` – STL parsing (binary + ASCII) and binary export.
- `src/mesh.js` – indexed mesh: vertex welding, topology, delete, hole detection
  and filling, selection helpers. No browser dependencies.
- `src/segment.js` – splits the mesh into suggested objects at concave creases.
- `src/samples.js` – the built-in cake-with-candles sample.
- `server/ai.js` – server-side Claude request for *Ask AI* (hooked into the Vite
  server by `vite.config.js`).
- `src/controls.js` – camera navigation (free/turntable rotation, pan, zoom to cursor).
- `src/zip.js` – minimal ZIP writer for the multi-part download.
- `src/viewer.js` – Three.js rendering and GPU ID-buffer picking (selection only
  hits what you can see).
- `src/main.js` – UI, tools, undo/redo.
