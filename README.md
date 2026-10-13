# STL Mesh Editor

A browser app to open STL files, delete parts of the mesh, and close the model
again so it's watertight.

**Version 1.1.0**

What's new in 1.1:
- Mouse: left-drag turns the model around (left/right only, like a
  turntable); right-drag rotates freely.
- The AI features were removed – the app works fully offline and never
  contacts an outside service.

## Desktop apps – Windows, macOS, Linux

Download from the repository's **Releases** page:

| System | File | How |
|---|---|---|
| Windows | `STL-Mesh-Editor-<version>-setup.exe` | Installer: Start menu and desktop shortcut, uninstall in *Settings → Apps* |
| Windows | `STL-Mesh-Editor-<version>-portable.exe` | No install – just run it (e.g. from a USB stick) |
| macOS | `STL-Mesh-Editor-<version>-mac-universal.dmg` | Open it and drag the app to *Applications* (Intel and Apple Silicon) |
| Linux | `STL-Mesh-Editor-<version>-linux-x86_64.AppImage` / `-arm64.AppImage` | `chmod +x` it and run – works on most distributions |
| Linux | `stl-mesh-editor_<version>_amd64.deb` / `_arm64.deb` | Ubuntu, Debian, Raspberry Pi OS (64-bit): `sudo apt install ./stl-mesh-editor_….deb` |

The installed apps open `.stl` files when you double-click them (*Open with →
STL Mesh Editor*). Downloads use a normal *Save as* dialog.

**The apps aren't code-signed** (that needs paid certificates), so the first
start shows a warning:
- **Windows:** *"Windows protected your PC"* → **More info → Run anyway**.
- **macOS:** *"can't be opened because it is from an unidentified developer"*
  or *"is damaged"* → right-click the app → **Open**, or in Terminal:
  `xattr -cr "/Applications/STL Mesh Editor.app"`.

**Building them:** the workflow `.github/workflows/desktop-apps.yml` builds
all of them on GitHub's Windows, macOS and Linux machines. On GitHub:
*Releases → Draft a new release* → *Choose a tag*: type e.g. `v1.1.0` (on the
branch with this code) → *Publish release*. After about 10 minutes the files
appear under the release's *Assets*. To build one yourself (Node.js 20+, on
that system):

```bash
npm install
npm run desktop:win      # Windows → desktop/release/
npm run desktop:mac      # macOS (needs a Mac)
npm run desktop:linux    # Linux
npm run desktop          # just run the app
```

## Run

```bash
npm install
npm run dev       # open the printed URL
npm run build     # static build in dist/ (works from any folder / web host)
npm test          # unit tests for the mesh logic
npm start         # build + serve the optimized version (port 4173)
```

### Running on a Raspberry Pi / another machine

After every `git pull`, run `npm install` before `npm start` – updates can add
packages.

The server listens on all network interfaces, so on the Pi it prints a
`Network:` address next to `Local:`. Open that one (e.g.
`http://192.168.1.50:5173`, or `http://raspberrypi.local:5173`) from the
other computer – `localhost` only works on the Pi itself.

- Use `npm start` for everyday use – it's much lighter on the Pi than `npm run dev`.
- If the page still doesn't load, a firewall on the Pi may be blocking the port:
  `sudo ufw allow 5173` (dev) / `sudo ufw allow 4173` (`npm start`).
- To keep it running after you log out, use e.g. `pm2` or a systemd service
  running `npm start` in this folder.

## Printer

The **printer button** in the top bar (it shows the chosen printer) opens
the profiles: resin printers from Anycubic, Elegoo, Phrozen, Creality and
Uniformation with their build volumes – or *No printer* for a plain grid.
**Copy** a profile or fill in the form to save your own (stored in the
browser). The chosen printer's build plate is drawn in the view (print area
with a 10 mm grid, the build height as a dashed box, the printer body below,
as slicers show it); **View ▾ → Plate** shows the whole printer. The status
bar says whether the model fits; the print area turns red when it doesn't.

## Files

Opens **STL, 3MF and OBJ** (open button or drag and drop). A 3MF or OBJ with
several objects opens as several models. **Export ▾** saves STL (whole, per
model or as a zip), **3MF** (one file, every model kept separate – for Bambu
Studio, PrusaSlicer, Orca, Chitubox, Lychee) and **OBJ**.

## Tools ▾

**Check**
- **Model info** – size, volume, surface, resin in ml, weight and cost
  (density and price per kg are editable) for the selected models or all.
- **Repair** – finds and fixes faces turned the wrong way (also whole
  inside-out models), duplicate, zero-size and paper-thin double-wall
  triangles; finds faces passing through other faces (and selects them).
- **Wall thickness** – colours the model: red thinner than the minimum,
  orange close to it, green fine; *Select the thin areas*.
- **Overhangs & auto-orient** – red faces need supports at the chosen angle;
  *Auto-orient* turns the model (or the selected ones) so the least area
  overhangs (ties: the lower one).
- **Measure** – click two points for the distance (and X·Y·Z), a third for
  the angle.

**Change** (solid operations with manifold-3d – results are always closed;
the input must be closed too)
- **Hollow & drain holes** – a shell with walls of the chosen thickness (the
  inside follows the outside at an even distance), then click where drain
  holes go and *Drill holes*. Shows the resin saved.
- **Text / logo** – type text (4 fonts) or load an SVG logo, click on the
  model, *Add it* raised or engraved, any height, depth and turn.
- **Add a base** – round, oval or rectangular plinth with a bevel under the
  selected models (or all), joined to them or as a separate model.
- **Combine models** – select two or more: join into one, cut the others out
  of one of them, or keep only the overlap.
- **Mirror** – X, Y or Z, across the model's centre.
- **Smooth** – Taubin smoothing (doesn't shrink); in Edit mode only the
  selected faces, with the edge of the area kept in place.

Everything is one undo step (Ctrl+Z).

## Modes

The switch in the top bar (or `1` / `2` / `3`, `Tab` toggles Normal ↔ Edit):

- **Normal** – work with whole **models**: click a model to select it (Shift
  adds, Ctrl removes), then Move, Rotate, Resize, Lay flat or Export it.
  An opened file is one solid model.
- **Edit** – the model's **parts** and sub-objects (coloured, listed in the
  tree): select, delete, split, Block cut, close holes, and **group / ungroup**
  parts (`Ctrl+G` / `Ctrl+Shift+G`). Grouped parts are one model in Normal
  mode – moved, resized and exported together; an ungrouped part is a model of
  its own. Split pieces stay in their model until you ungroup them.
  Leaving Edit makes everything solid models again: holes left open are
  closed (*⚙ → Close holes when leaving Edit mode*) and the selection grows to
  whole models.
- **Cut** – the plane cut with pins, holes or dowels. The two halves become
  separate models (the top one is named “… (top)”). Dowels are made lying on
  the plate right beside the model, together as one more model (“Dowels”),
  so they can be moved or exported in one go.

Undo/redo covers grouping too.

## Fix model

The wrench button (`W`, in Normal and Edit mode) opens **Fix model**, which
checks the model and fixes what it finds:

- **Floating parts** – pieces in mid-air, not on the plate and not touching
  anything that is. *Select* or *Delete them*. (The Objects panel also warns
  about them, with a *Fix…* button.)
- **Holes** – openings that keep the model from being a closed solid.
  *Close holes* closes them all.
- Non-manifold edges are reported for information.

*Fix everything* does both in one go; *Check again* re-runs the checks. When
all is well it says the model is solid and ready to print.

## Layout

- **Top bar:** Open, Sample, **Export ▾** (whole model, selection only, all parts
  as ZIP or separate STLs), Undo/Redo, the file name, then **View ▾** (standard
  views, camera, rotation mode, hole edges, wireframe, colour by object),
  **⚙ Settings** (place on plate when opening, close cut faces when splitting,
  sub-object sensitivity).
- **Mode switch** (top bar): Normal | Edit | Cut.
- **Tool rail** (left of the 3D view) – only the current mode's tools:
  Normal: Select models, Move, Rotate, Resize, Lay flat, Delete · Edit:
  Select, Block, Split, Close holes, Delete, Group, Ungroup · Cut: Cut ·
  and View in every mode. Clicking a tool opens a small card
  with just that tool's options (× hides it).
- **Right sidebar:** the object tree – models in Normal mode; models, their
  parts and sub-objects in Edit mode – with the floating-parts warning, and
  model info.
- **Status bar:** the current mode, a hint for the current tool, the position/size of the model
  or selection, and the selection count.
- **Navigation gizmo** (top right) and the **Shortcuts** box under the `?`.

## Keyboard shortcuts

The *Shortcuts* box under the `?` (top right) lists them all; × closes it and
`?` brings it back. Each tool button also shows its letter.

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| `1` / `2` / `3` | Normal / Edit / Cut mode | `Tab` | Normal ↔ Edit |
| `Ctrl+G` | Group parts into one model | `Ctrl+Shift+G` | Ungroup |
| `W` | Fix model | | |
| `O` | Select model (Normal) / object (Edit) | `R` | Rotate on plate |
| `V` | View / orbit | `L` | Lay flat |
| `T` | Triangle select | `C` | Cut / plane cut (`Enter` cuts) |
| `B` | Brush select | `S` | Split selection into a part |
| `X` | Box select | `H` | Close holes |
| `K` | Block cut & select | `Del` | Delete selection |
| `P` | Part select | `F` | Frame the model |
| `G` | Region select | `Q` / `E` | Turn left / right on the plate |
| `M` | Move part with the mouse | `Z` | Resize |
| arrows | Move on the plate | `PgUp` / `PgDn` | Move up / down |
| `Home` | Centre on the plate | `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+A` / `Ctrl+I` / `Esc` | All / invert / none | `+` / `−` | Grow / shrink selection |

A tool's key switches to its mode when needed (e.g. `C` goes to Cut mode).

## Workflow

1. **Open** an `.stl` (binary or ASCII) with *Open STL…* or drag it onto the window.
   A progress bar shows each loading step. By default the model is placed on
   the plate like in a slicer: centre of mass at X = Y = 0, bottom at Z = 0
   (untick *Place on plate when opening* to keep the file's coordinates).
2. **Select** the triangles to remove with one of the tools:

   | Tool | Key | What it does |
   |------|-----|--------------|
   | Object | O | Hover to preview, click to select a whole detected object (e.g. a candle on a cake) |
   | View | V | Left-drag rotates the view |
   | Triangle | T | Click single triangles |
   | Brush | B | Paint over visible triangles |
   | Box | X | Drag a rectangle (tick *Select through* to include hidden faces) |
   | Part | P | Click to select a whole connected part (e.g. a floating support) |
   | Region | G | Click to flood-select a smooth/flat area up to a max angle |
   | Block | K | Drag a rectangle: cuts the model cleanly along its edges (all the way through) and selects the block inside |

   Shift adds, Ctrl removes. `Ctrl+A` all, `Esc` none, `Ctrl+I` invert,
   `+`/`-` grow/shrink.

   **Navigation:** right-drag rotates freely. Left-drag with the click tools
   (Object, Triangle, Part, Region, Lay flat, Cut; a plain click still
   selects), or starting on empty space in the other tools except Box and
   Block, only turns the model around – left/right movement spins the view
   around the vertical axis, like a turntable, and the tilt stays.
   Middle-drag or Shift+right-drag pans, the wheel zooms toward the cursor,
   the mouse side buttons zoom, double-click sets the rotation centre, hold
   Alt to rotate with the left button in any tool. The **navigation gizmo**
   (top right, like Blender's) shows the orientation: click an axis to look
   along it, drag the ball to rotate; below it are drag-to-zoom, drag-to-pan,
   perspective/orthographic and plate-grid buttons. The *Shortcuts*
   box under the `?` lists every key (× closes it, `?` brings it back). *Rotate: Free* tumbles in every
   direction; *Turntable* keeps Z up. The view buttons (Top, Front, Right…)
   look straight along an axis, and *Camera: Orthographic* removes
   perspective – together they give exact, axis-aligned Block cuts.

   (These selection tools are in **Edit** mode; Normal mode picks whole
   models.)

   **Objects (outliner):** each file comes in as one group – the model –
   with its separate parts and the sub-objects detected in each part beneath
   it, much like a slicer's or Blender's object list. Sub-objects are found
   even when everything is fused into one surface: shapes are separated where
   the surface folds inwards (a concave crease, like the ring where a candle
   meets the cake top), and tiny fragments are merged into their neighbours.
   - Click a row to select that model/part/sub-object (Shift adds, Ctrl
     removes); hovering highlights it in the view.
   - 👁 hides/shows it like a layer – hidden pieces aren't drawn or picked
     (they are still saved on export). *Show everything* brings them back.
   - ▸/▾ collapses or expands a group; double-click a name to rename it.
     Part names are used for the exported file names.
   - *STL* downloads a part, ✕ deletes the row's triangles.
   If sub-objects come out merged, lower *Split at creases over*; if the model
   is chopped into too many pieces, raise it. *Sample* loads a cake with
   candles to try it.
3. **Delete** the selection (`Delete` / `Backspace`). Hole rims are outlined in red,
   and the inside of the model shows through in dark red.
4. **Close holes** (`H`) to cap every hole – or only holes up to N edges.
   Each hole is triangulated in its best-fit plane (flat cap for planar cuts),
   falling back to a fan around the centre for very twisted holes. The patch
   follows the orientation of the surrounding faces.
5. **Move** (optional): the move pad (bottom right) moves the model – or, with
   a split-off part selected, just that part – by the chosen step (0.1 / 1 /
   10 mm); hold a button to repeat. ⌂ centres it on the plate, ⤓ drops it to
   Z = 0. Keys: arrows move on the plate (following the view), PageUp/PageDown
   up/down, Shift = 10× step, Home = centre on plate. The panel shows the
   position (centre of mass, bottom) and size.
   **Move with the mouse:** the *Move* tool (`M`) – drag a part and it slides
   across the plate under the cursor (it gets selected if it wasn't); Shift
   moves it up/down, Ctrl snaps to the move step.
   **Rotate:** the *Rotate* tool (`R`) spins the model (or selected part) on
   the plate as you drag left/right – Shift snaps to 15°. The move pad's ⟲ ⟳
   buttons and `Q` / `E` rotate by the chosen angle (5/15/45/90°); *X 90°* /
   *Y 90°* tip it over and set it back on the plate.
   **Resize:** the *Resize* tool (`Z`) – type the size in mm for X, Y, Z or a
   percentage of the size it had when it was opened (so 1000 % is ten times
   the original, however often you resize; for selected parts it is % of
   their current size); *Keep proportions* scales all axes together. Presets
   (relative to the current size): 50 %, 200 %, 1000 %, *inch → mm* (×25.4, for models saved in inches) and *mm → inch*.
   *Apply size* (or Enter) resizes around the bottom centre, so the model
   stays on the plate. With split-off parts selected, only they are resized.
   **Lay flat:** the *Lay flat* tool (`L`) – click any face and the model
   turns so that face (with the flat area around it) rests on the plate.
   The whole model turns as one group; to turn only some parts, select them
   first and click a face on them.
   **Cut with connectors:** the *Cut* tool (`C`) guides you in three steps:
   1. *Place the plane* – X, Y, Z, *Face* (parallel to a face you click), or
      any angle with the Meshmixer-style **orb**: drag its arrow to slide the
      plane, its red and green rings to tilt it, its ball to move the handle.
      Clicking the model or the slider also places it; *Reset* goes back to a
      flat Z cut.
   2. *Check the connectors* – every separate cut area is analysed as the
      plane moves: its size, which connectors fit (and why, or why not), with
      a preview on the plane. *Type*: **Auto** picks per area, **Pin & hole**
      (a pin on the lower half, a hole in the upper one – *Flip* swaps them),
      **Dowels** (holes in both halves plus separate dowel parts, printed lying
      down – stronger), or **None** (glue only). Size and count are automatic
      or set by you; holes are 0.2 mm wider than the pins (*Hole wider by*, in mm) and a
      bit deeper. Automatic size and count follow the cut area: up to Ø10 mm
      on ordinary prints, bigger and more of them on big models (up to 8 per
      area). Thin walls get small connectors; areas too thin get none,
      and holes never break through the other side.
      **Choose the connectors:** with automatic size and count, the panel
      lists a few choices for the cut – *Recommended*, *Bigger* (or fewer,
      bigger), and *More, smaller* ones (down to Ø2.5) – each with its count
      and size. Click one: the preview and the cut follow it.
      **Placement:** *Automatic* picks the spots; *Manual* lets you click on
      the plane where each connector goes (the cut outline is drawn in yellow).
      Each one is checked at once – green fits, red doesn't, and the list says
      why (too close to the edge, off the cut face, too close to another
      connector, not enough material behind it). Ctrl+click removes the
      nearest, Shift+click moves the plane, *Remove all* starts over.
   3. *Cut* (or Enter) – both halves are closed and get their connectors.
      The message says which half has the pins and which the holes. Right
      after the cut the halves still touch, so each pin sits inside its hole
      and can't be seen – *Pull apart* slides the hole half away along the cut.
      *Arrange for printing* then lays each half on its best face (pins up,
      or cut face down) and puts the halves and dowels side by side; download
      them with *Download parts*. Tips for printing and gluing are shown.
6. **Split into parts** (optional): select a region (e.g. with Block) and press
   *Split selection into new part* (`S`). The selection is detached from the
   rest and the cut faces on both sides are closed, so each part is a solid of
   its own. Example – an L-shaped wall: Top view, Orthographic, Block-drag over
   one leg starting at the corner, `S`.
7. **Export:** download every model as its own STL, all models in one ZIP,
   or everything as one file. A single model downloads from its row in the
   outliner (*STL*). Tick *Only the selected model(s)* to export just the
   selection – as one STL or the selected models as a ZIP or separate files.
   To export a split-off part as its own file, ungroup it first (Edit mode,
   `Ctrl+Shift+G`).

**Floating parts:** after loading and after every change, pieces that don't
rest on the plate and don't touch anything that does (directly or through
other pieces) are reported in the Objects panel and tagged *floating* in the
tree – they would print in mid-air. *Select them* / *Delete them* deal with
them in one click. Touching is judged on the surfaces themselves (to
about 1/400 of the model's size), so a loose piece is found even right next
to a tilted wall; pieces enclosed inside the solid don't count.

`Ctrl+Z` / `Ctrl+Y` undo and redo. The *Model* panel shows triangle count,
holes, parts and whether the mesh is watertight.

## Code layout

- `src/stl.js` – STL parsing (binary + ASCII) and binary export.
- `src/mesh.js` – indexed mesh: vertex welding, topology, delete, hole detection
  and filling, selection helpers. No browser dependencies.
- `src/segment.js` – splits the mesh into suggested objects at concave creases.
- `src/samples.js` – the built-in cake-with-candles sample.
- `src/gizmo.js` – the navigation gizmo.
- `src/cut.js` – plane cut with caps and connector pins/holes.
- `src/cutgizmo.js` – the cut plane's orb (slide / tilt / move handles).
- `src/controls.js` – camera navigation (free/turntable rotation, pan, zoom to cursor).
- `src/zip.js` – minimal ZIP writer for the multi-part download.
- `src/viewer.js` – Three.js rendering and GPU ID-buffer picking (selection only
  hits what you can see).
- `src/main.js` – UI, tools, undo/redo.
- `src/floating.js` – finds parts floating in mid-air.
- `src/printers.js` – resin printer profiles and the fit check.
- `src/formats.js` – OBJ and 3MF reading and writing (with a small zip reader).
- `src/analysis.js` – model info, overhangs and auto-orient, wall thickness.
- `src/repair.js` – repair, self-crossings, mirror, smooth.
- `src/csg.js` – join/cut/overlap, base, text and logos, hollowing, drain holes.
- `desktop/` – the Windows app (Electron): `main.cjs` serves the built app
  from a local web server in its own window.
