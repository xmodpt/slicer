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

   Shift adds, Ctrl removes. Right-drag rotates, middle-drag pans, wheel zooms,
   hold Alt to rotate with the left button. `Ctrl+A` all, `Esc` none,
   `Ctrl+I` invert, `+`/`-` grow/shrink.
   **Objects found:** when a file is opened, the model is analysed and split
   into likely objects, even if everything is fused into one surface. Shapes
   are separated where the surface folds inwards (a concave crease, like the
   ring where a candle meets the cake top); tiny fragments are merged into their
   neighbours. The list shows each object with its size – hover to highlight it,
   click to select it (Shift adds, Ctrl removes), ✕ deletes it. If objects come
   out merged, lower *Split at creases over*; if the model is chopped into too
   many pieces, raise it. The *Sample* button loads a cake with candles to try it.
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
- `src/segment.js` – splits the mesh into suggested objects at concave creases.
- `src/samples.js` – the built-in cake-with-candles sample.
- `src/viewer.js` – Three.js rendering and GPU ID-buffer picking (selection only
  hits what you can see).
- `src/main.js` – UI, tools, undo/redo.
