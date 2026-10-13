import * as THREE from 'three';
import { CameraControls } from './controls.js';

const BASE_COLOR = new THREE.Color(0xb9c0cc);
const SELECTED_COLOR = new THREE.Color(0xff7a1a);
const HOVER_COLOR = new THREE.Color(0x5cc8ff);

// Renders the mesh and answers "which triangles are under the cursor" using
// an off-screen ID buffer: every triangle is drawn with its index encoded as
// a colour, so picking respects occlusion and costs one texture read.
export class Viewer {
  constructor(container) {
    this.container = container;
    if (!document.createElement('canvas').getContext('webgl2')) {
      throw new Error(
        'This browser has no WebGL 2, which the 3D view needs. Turn on hardware acceleration ' +
          '(Chrome: Settings → System → "Use graphics acceleration"), check chrome://gpu, or try another browser/computer.',
      );
    }
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1b1e24);
    this.perspectiveCamera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    this.orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    this.camera = this.perspectiveCamera;
    this.scene.add(this.perspectiveCamera, this.orthographicCamera);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404650, 1.6));
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.keyLight.position.set(1, 1.5, 2);
    this.camera.add(this.keyLight); // light follows the view

    this.controls = new CameraControls(this.canvas, this.perspectiveCamera, this.orthographicCamera);
    this.controls.addEventListener('change', () => {
      this.pickDirty = true;
      this.requestRender();
    });
    // Double-click on the model: rotate around that point from now on.
    this.canvas.addEventListener('dblclick', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const p = this.pointAt(e.clientX - r.left, e.clientY - r.top);
      if (p) this.controls.setPivot(p);
    });

    this.frontMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.75,
      metalness: 0.05,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    // Inside faces are drawn red so holes and flipped faces stand out.
    this.backMaterial = new THREE.MeshBasicMaterial({
      color: 0x8f2f35,
      side: THREE.BackSide,
      polygonOffset: true, // pushed further back so it never peeks through edges
      polygonOffsetFactor: 4,
      polygonOffsetUnits: 8,
    });
    this.wireMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, wireframe: true, transparent: true, opacity: 0.25 });
    this.pickMaterial = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      vertexShader: `
        attribute float faceId;
        varying float vFace;
        void main() {
          vFace = faceId;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying float vFace;
        void main() {
          float id = floor(vFace + 0.5) + 1.0;
          float r = mod(id, 256.0);
          float g = mod(floor(id / 256.0), 256.0);
          float b = floor(id / 65536.0);
          gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
        }`,
    });

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.plate = new THREE.Group(); // build-plate grid at Z = 0
    this.scene.add(this.plate);
    this.pickScene = new THREE.Scene();
    this.pickTarget = new THREE.WebGLRenderTarget(1, 1);
    this.pickPixels = new Uint8Array(4);
    this.pickDirty = true;

    this.boundaryMaterial = new THREE.LineBasicMaterial({ color: 0xff3b4a });
    this.boundaryLines = null;
    this.showWireframe = false;
    this.showBoundaries = true;

    this.hoverObjects = new Set();
    this._needsRender = true;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      if (this._needsRender) {
        this._needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
      requestAnimationFrame(loop);
    };
    loop();
  }

  requestRender() {
    this._needsRender = true;
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.controls.update();
    this.pickDirty = true;
    this.requestRender();
  }

  // Rebuilds the GPU geometry for a mesh. `selection` is a per-triangle mask.
  setMesh(mesh, selection, { frame = false } = {}) {
    for (const child of [...this.group.children]) this.group.remove(child);
    for (const child of [...this.pickScene.children]) this.pickScene.remove(child);
    this.geometry?.dispose();

    const T = mesh.triangleCount;
    this.hidden = null;
    const positions = mesh.toSoup();
    const faceIds = new Float32Array(T * 3);
    for (let t = 0; t < T; t++) faceIds[t * 3] = faceIds[t * 3 + 1] = faceIds[t * 3 + 2] = t;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(T * 9), 3));
    geometry.setAttribute('faceId', new THREE.BufferAttribute(faceIds, 1));
    geometry.computeBoundingSphere();
    this.geometry = geometry;
    this.positions = positions;
    this.triangleCount = T;

    this.group.add(new THREE.Mesh(geometry, this.frontMaterial));
    this.group.add(new THREE.Mesh(geometry, this.backMaterial));
    this.wireMesh = new THREE.Mesh(geometry, this.wireMaterial);
    this.wireMesh.visible = this.showWireframe;
    this.group.add(this.wireMesh);
    this.pickScene.add(new THREE.Mesh(geometry, this.pickMaterial));

    this.setBoundaryEdges(mesh);
    this.updatePlate();
    this.setObjects(null, null);
    this.overlay = null;
    this.setSelection(selection);
    if (frame) this.frame();
    this.pickDirty = true;
    this.requestRender();
  }

  // After a move: new vertex positions, same triangles (selection and object
  // colours stay valid).
  updatePositions(mesh) {
    const attr = this.geometry.getAttribute('position');
    attr.array.set(mesh.toSoup());
    this._collapseHidden(attr.array);
    attr.needsUpdate = true;
    this.positions = attr.array;
    this.geometry.computeBoundingSphere();
    const lines = this.boundaryLines.geometry.getAttribute('position');
    lines.array.set(this._boundaryPositions(mesh.positions));
    lines.needsUpdate = true;
    this.boundaryLines.geometry.computeBoundingSphere();
    this.pickDirty = true;
    this.requestRender();
  }

  // Hides faces (mask per triangle, or null for none). Hidden triangles are
  // collapsed to a point on the GPU: not drawn and not pickable.
  setHidden(mesh, mask) {
    this.hidden = mask && mask.some((v) => v) ? mask : null;
    this.updatePositions(mesh);
  }

  _collapseHidden(arr) {
    const h = this.hidden;
    if (!h) return;
    for (let t = 0; t < h.length; t++) {
      if (!h[t]) continue;
      const o = t * 9;
      arr[o + 3] = arr[o + 6] = arr[o];
      arr[o + 4] = arr[o + 7] = arr[o + 1];
      arr[o + 5] = arr[o + 8] = arr[o + 2];
    }
  }

  // Planned connectors on the cut plane: pins stick up from the plane (green),
  // dowels go through it (purple). list: [{ center3, r, h, kind }].
  setConnectorPreview(list, normal) {
    if (!this.connectorGroup) {
      this.connectorGroup = new THREE.Group();
      this.connectorGroup.renderOrder = 9;
      this.scene.add(this.connectorGroup);
    }
    for (const c of [...this.connectorGroup.children]) {
      this.connectorGroup.remove(c);
      c.geometry.dispose();
    }
    const n = normal ? new THREE.Vector3(...normal).normalize() : null;
    for (const c of list || []) {
      const dowel = c.kind === 'dowel';
      const len = dowel ? 2 * c.h : c.h;
      const geo = new THREE.CylinderGeometry(c.r, c.r, len, 24);
      const color = c.kind === 'bad' ? 0xe5484d : dowel ? 0xc77dff : 0x2fd36e;
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false });
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = 9;
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
      m.position.set(...c.center3).addScaledVector(n, dowel ? 0 : len / 2);
      this.connectorGroup.add(m);
    }
    this.requestRender();
  }

  // Outline of the cut section (loops of 3D points), drawn over everything so
  // it shows where the cut face is. null hides it.
  setCutOutline(loops) {
    if (this.cutOutline) {
      this.scene.remove(this.cutOutline);
      this.cutOutline.geometry.dispose();
      this.cutOutline = null;
    }
    if (loops?.length) {
      const pts = [];
      for (const loop of loops) {
        for (let i = 0; i < loop.length; i++) pts.push(...loop[i], ...loop[(i + 1) % loop.length]);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.cutOutline = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false, transparent: true }));
      this.cutOutline.renderOrder = 8;
      this.scene.add(this.cutOutline);
    }
    this.requestRender();
  }

  // Translucent preview of a cut plane n·p = offset (null hides it).
  setCutPlane(plane) {
    if (!this.cutPlane) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x5cc8ff, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
      this.cutPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      this.cutPlane.add(new THREE.LineSegments(new THREE.EdgesGeometry(this.cutPlane.geometry), new THREE.LineBasicMaterial({ color: 0x5cc8ff })));
      this.scene.add(this.cutPlane);
    }
    this.cutPlane.visible = !!plane && !!this.geometry;
    if (this.cutPlane.visible) {
      const n = new THREE.Vector3(...plane.normal).normalize();
      const sphere = this.geometry.boundingSphere;
      const centre = plane.center
        ? new THREE.Vector3(...plane.center)
        : sphere.center.clone().addScaledVector(n, plane.offset - n.dot(sphere.center));
      this.cutPlane.position.copy(centre);
      if (plane.u) {
        const u = new THREE.Vector3(...plane.u).normalize();
        this.cutPlane.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, new THREE.Vector3().crossVectors(n, u), n));
      } else {
        this.cutPlane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      }
      this.cutPlane.scale.setScalar(sphere.radius * 2.4);
    }
    this.requestRender();
  }

  // The printer to show (a profile from printers.js), or null for a plain grid.
  setPrinter(printer) {
    this.printer = printer;
    this.updatePlate();
  }

  // Mark the print area red when the model doesn't fit.
  setPrinterFits(fits) {
    this.printerFits = fits;
    if (this.printAreaLine) this.printAreaLine.material.color.set(fits ? 0x2fd36e : 0xff4d55);
    this.requestRender();
  }

  // Without a printer: a grid on the XY plane through the origin, a bit larger
  // than the model, with red X and green Y axis lines. With one: its build
  // plate, print area and build height, and the printer body below.
  updatePlate() {
    for (const child of [...this.plate.children]) {
      this.plate.remove(child);
      child.traverse?.((o) => {
        o.geometry?.dispose();
        o.material?.dispose?.();
      });
    }
    this.printAreaLine = null;
    if (this.printer) {
      this._buildPrinter(this.printer);
      this.requestRender();
      return;
    }
    if (!this.geometry) return;
    const sphere = this.geometry.boundingSphere;
    const reach = Math.abs(sphere.center.x) + Math.abs(sphere.center.y) + sphere.radius;
    const step = 10 ** Math.floor(Math.log10(Math.max(reach, 1e-6) / 5));
    const half = Math.ceil((reach * 1.3) / step) * step;
    const grid = new THREE.GridHelper(half * 2, Math.round((half * 2) / step), 0x3a404c, 0x2a2f38);
    grid.rotation.x = Math.PI / 2; // GridHelper lies in XZ; turn it into XY
    grid.material.depthWrite = false;
    this.plate.add(grid);
    const axis = (to, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), to]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthWrite: false }));
    };
    this.plate.add(axis(new THREE.Vector3(half, 0, 0), 0xd9534f), axis(new THREE.Vector3(0, half, 0), 0x5cb85c));
    this.plateStep = step;
  }

  _buildPrinter({ x, y, z }) {
    const P = this.plate;
    const hx = x / 2, hy = y / 2;
    const lines = (pts, color, opts = {}) => {
      const g = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p)));
      const m = opts.dashed
        ? new THREE.LineDashedMaterial({ color, dashSize: opts.dash || 4, gapSize: opts.gap || 3, transparent: true, opacity: opts.opacity ?? 1, depthWrite: false })
        : new THREE.LineBasicMaterial({ color, transparent: true, opacity: opts.opacity ?? 1, depthWrite: false });
      const l = new THREE.LineSegments(g, m);
      if (opts.dashed) l.computeLineDistances();
      return l;
    };
    // Build plate: a metal slab a little larger than the print area.
    const m = Math.max(4, Math.min(x, y) * 0.04);
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(x + 2 * m, y + 2 * m, 2.5),
      new THREE.MeshStandardMaterial({ color: 0x8d939e, metalness: 0.55, roughness: 0.45, transparent: true, opacity: 0.92 }),
    );
    slab.position.z = -1.25 - 0.02;
    P.add(slab);
    // Grid over the print area (10 mm, 50 mm lines brighter).
    const minor = [], major = [];
    for (let gx = -Math.floor(hx / 10) * 10; gx <= hx + 1e-6; gx += 10) (Math.round(gx) % 50 === 0 ? major : minor).push([gx, -hy, 0.01], [gx, hy, 0.01]);
    for (let gy = -Math.floor(hy / 10) * 10; gy <= hy + 1e-6; gy += 10) (Math.round(gy) % 50 === 0 ? major : minor).push([-hx, gy, 0.01], [hx, gy, 0.01]);
    P.add(lines(minor, 0x5d636e, { opacity: 0.55 }), lines(major, 0x767d8a, { opacity: 0.8 }));
    // Print area outline (green; red when the model doesn't fit).
    const c = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
    const outline = [];
    for (let i = 0; i < 4; i++) outline.push([...c[i], 0.02], [...c[(i + 1) % 4], 0.02]);
    this.printAreaLine = lines(outline, this.printerFits === false ? 0xff4d55 : 0x2fd36e);
    P.add(this.printAreaLine);
    // Build height: the volume the model must stay in.
    const box = [];
    for (let i = 0; i < 4; i++) {
      box.push([...c[i], z], [...c[(i + 1) % 4], z]);
      box.push([...c[i], 0], [...c[i], z]);
    }
    P.add(lines(box, 0x6f8fb8, { dashed: true, opacity: 0.45 }));
    // Printer body below the plate (see-through), on posts – as slicers show it.
    const bw = x * 1.32 + 30, bd = y * 1.5 + 40, bh = Math.max(40, Math.min(x, y) * 0.45);
    const gap = Math.max(25, z * 0.2);
    const bodyGeo = new THREE.BoxGeometry(bw, bd, bh);
    const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({ color: 0x9aa1ad, transparent: true, opacity: 0.13, depthWrite: false, roughness: 0.8 }));
    body.position.set(0, 0, -gap - bh / 2);
    P.add(body);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(bodyGeo), new THREE.LineBasicMaterial({ color: 0x8b93a0, transparent: true, opacity: 0.35, depthWrite: false }));
    edges.position.copy(body.position);
    P.add(edges);
    const postGeo = new THREE.CylinderGeometry(Math.max(2, x * 0.012), Math.max(2, x * 0.012), gap - 2.5, 16);
    postGeo.rotateX(Math.PI / 2);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x9aa1ad, transparent: true, opacity: 0.45, metalness: 0.4, roughness: 0.5 });
    for (const [px, py] of [[-hx * 0.85, -hy * 0.75], [hx * 0.85, -hy * 0.75], [-hx * 0.85, hy * 0.75], [hx * 0.85, hy * 0.75], [0, -hy * 0.75], [0, hy * 0.75]]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(px, py, -2.5 - (gap - 2.5) / 2);
      P.add(post);
    }
    // Axes from the plate's centre.
    const axisLen = Math.min(hx, hy) * 0.35;
    P.add(lines([[0, 0, 0.03], [axisLen, 0, 0.03]], 0xd9534f), lines([[0, 0, 0.03], [0, axisLen, 0.03]], 0x5cb85c));
    this.plateStep = 10;
  }

  // World axis (X or Y, with sign) closest to the screen's right and up
  // directions, for arrow keys that follow the view.
  screenAxes() {
    const pick = (v) => (Math.abs(v.x) >= Math.abs(v.y) ? [Math.sign(v.x) || 1, 0] : [0, Math.sign(v.y) || 1]);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    let up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    // Looking straight down/up: screen-up is in the plate already; otherwise
    // use the viewing direction projected onto the plate.
    if (Math.abs(up.z) > 0.7) up = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const r = pick(right);
    let u = pick(up);
    if (u[0] === 0 ? r[0] === 0 : u[1] === 0 && r[1] === 0) u = r[0] === 0 ? [Math.sign(up.x) || 1, 0] : [0, Math.sign(up.y) || 1];
    return { right: r, up: u };
  }

  setBoundaryEdges(mesh) {
    if (this.boundaryLines) {
      this.group.remove(this.boundaryLines);
      this.boundaryLines.geometry.dispose();
    }
    // The edge list only changes with the triangles; moves reuse it.
    this.boundaryEdgeList = mesh.boundaryEdges();
    const g = new THREE.BufferGeometry();
    const arr = this._boundaryPositions(mesh.positions);
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    this.boundaryLines = new THREE.LineSegments(g, this.boundaryMaterial);
    this.boundaryLines.visible = this.showBoundaries;
    this.group.add(this.boundaryLines);
  }

  _boundaryPositions(p) {
    const edges = this.boundaryEdgeList;
    const arr = new Float32Array(edges.length * 6);
    edges.forEach(([a, b], i) => {
      arr.set(p.subarray(a * 3, a * 3 + 3), i * 6);
      arr.set(p.subarray(b * 3, b * 3 + 3), i * 6 + 3);
    });
    return arr;
  }

  // Colour of face t: selection first, then the hovered object, then the
  // optional per-object colours, else the plain model colour.
  _faceColor(t, mask) {
    if (mask[t]) return SELECTED_COLOR;
    // An analysis overlay (wall thickness, overhangs): one palette index per face.
    if (this.overlay) {
      const i = this.overlay.index[t];
      if (i !== 255) return this.overlay.palette[i];
    }
    const objectOf = this.objectOf;
    if (objectOf && this.hoverObjects.has(objectOf[t])) return HOVER_COLOR;
    if (objectOf && this.objectColors) return this.objectColors[objectOf[t]] || BASE_COLOR;
    return BASE_COLOR;
  }

  // objectOf: per-face object id (or null); colors: THREE.Color per object id,
  // or null to draw the model in one colour.
  setObjects(objectOf, colors) {
    this.objectOf = objectOf;
    this.objectColors = colors;
    this.hoverObjects = new Set();
  }

  // overlay: { index: Uint8Array per face (255 = no colour), palette: [THREE.Color] }
  // or null. Call setSelection afterwards to repaint.
  setOverlay(overlay) {
    this.overlay = overlay && overlay.index.length === this.triangleCount ? overlay : null;
  }

  setSelection(mask) {
    const colors = this.geometry.getAttribute('color');
    const arr = colors.array;
    for (let t = 0; t < this.triangleCount; t++) {
      const c = this._faceColor(t, mask);
      for (let k = 0; k < 3; k++) {
        arr[t * 9 + k * 3] = c.r; arr[t * 9 + k * 3 + 1] = c.g; arr[t * 9 + k * 3 + 2] = c.b;
      }
    }
    colors.clearUpdateRanges();
    colors.needsUpdate = true;
    this.requestRender();
  }

  // Recolours only the given faces (used while brushing and hovering).
  updateFaces(faces, mask) {
    if (!faces.length) return;
    const colors = this.geometry.getAttribute('color');
    const arr = colors.array;
    let lo = Infinity, hi = -Infinity;
    for (const t of faces) {
      const c = this._faceColor(t, mask);
      for (let k = 0; k < 3; k++) {
        arr[t * 9 + k * 3] = c.r; arr[t * 9 + k * 3 + 1] = c.g; arr[t * 9 + k * 3 + 2] = c.b;
      }
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    colors.addUpdateRange(lo * 9, (hi - lo + 1) * 9);
    colors.needsUpdate = true;
    this.requestRender();
  }

  setWireframe(on) {
    this.showWireframe = on;
    if (this.wireMesh) this.wireMesh.visible = on;
    this.requestRender();
  }

  setBoundariesVisible(on) {
    this.showBoundaries = on;
    if (this.boundaryLines) this.boundaryLines.visible = on;
    this.requestRender();
  }

  frame() {
    const sphere = this.geometry?.boundingSphere;
    if (!sphere || !isFinite(sphere.radius) || sphere.radius === 0) return;
    this.controls.frame(sphere.center, sphere.radius);
  }

  // The whole printer in view: plate, build height and the body below.
  framePrinter() {
    if (!this.printer) return this.frame();
    const { x, y, z } = this.printer;
    const center = new THREE.Vector3(0, 0, z * 0.25);
    this.controls.frame(center, Math.hypot(x * 0.75, y * 0.8, z * 0.6));
  }

  // Standard views. `dir` points from the model toward the camera.
  setView(name) {
    const views = {
      iso: [[0.55, -0.75, 0.45], [0, 0, 1]],
      front: [[0, -1, 0], [0, 0, 1]],
      back: [[0, 1, 0], [0, 0, 1]],
      left: [[-1, 0, 0], [0, 0, 1]],
      right: [[1, 0, 0], [0, 0, 1]],
      top: [[0, 0, 1], [0, 1, 0]],
      bottom: [[0, 0, -1], [0, -1, 0]],
    };
    const [dir, up] = views[name];
    this.controls.setView(dir, up);
    this.frame();
  }

  setProjection(kind) {
    this.camera = kind === 'orthographic' ? this.orthographicCamera : this.perspectiveCamera;
    this.camera.add(this.keyLight);
    this.controls.update();
  }

  // Camera ray through a CSS-pixel position.
  rayAt(x, y) {
    const ndc = new THREE.Vector2((x / this.canvas.clientWidth) * 2 - 1, 1 - (y / this.canvas.clientHeight) * 2);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    return ray.ray;
  }

  // Surface point under a CSS-pixel position, or null.
  pointAt(x, y) {
    const face = this.faceAt(x, y);
    if (face < 0) return null;
    const ndc = new THREE.Vector2((x / this.canvas.clientWidth) * 2 - 1, 1 - (y / this.canvas.clientHeight) * 2);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const p = this.positions, o = face * 9;
    const a = new THREE.Vector3(p[o], p[o + 1], p[o + 2]);
    const b = new THREE.Vector3(p[o + 3], p[o + 4], p[o + 5]);
    const c = new THREE.Vector3(p[o + 6], p[o + 7], p[o + 8]);
    const plane = new THREE.Plane().setFromCoplanarPoints(a, b, c);
    return ray.ray.intersectPlane(plane, new THREE.Vector3()) || a.add(b).add(c).divideScalar(3);
  }

  // The four planes bounding the screen rectangle, extended through the whole
  // scene along the view direction. Points inside have n·p + d >= 0.
  rectPlanes(x0, y0, x1, y1) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const ax = (Math.min(x0, x1) / w) * 2 - 1, bx = (Math.max(x0, x1) / w) * 2 - 1;
    const ay = 1 - (Math.max(y0, y1) / h) * 2, by = 1 - (Math.min(y0, y1) / h) * 2;
    const cam = this.camera;
    cam.updateMatrixWorld();
    const un = (x, y, z) => new THREE.Vector3(x, y, z).unproject(cam);
    const centre = un((ax + bx) / 2, (ay + by) / 2, 0);
    const edges = [
      [ax, ay, ax, by],
      [bx, ay, bx, by],
      [ax, ay, bx, ay],
      [ax, by, bx, by],
    ];
    return edges.map(([x0, y0, x1, y1]) => {
      const plane = new THREE.Plane().setFromCoplanarPoints(un(x0, y0, -1), un(x0, y0, 1), un(x1, y1, -1));
      if (plane.distanceToPoint(centre) < 0) plane.negate();
      return { normal: plane.normal.toArray(), constant: plane.constant };
    });
  }

  // ---------------------------------------------------------------------------
  // Picking

  _ensurePickBuffer() {
    if (!this.pickDirty || !this.geometry) return;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = size.x, h = size.y;
    if (this.pickTarget.width !== w || this.pickTarget.height !== h) this.pickTarget.setSize(w, h);
    if (this.pickPixels.length !== w * h * 4) this.pickPixels = new Uint8Array(w * h * 4);

    const prevColor = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    this.camera.updateMatrixWorld();
    this.renderer.setRenderTarget(this.pickTarget);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(this.pickScene, this.camera);
    this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, w, h, this.pickPixels);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(prevColor, prevAlpha);
    this.pickW = w;
    this.pickH = h;
    this.pickDirty = false;
  }

  _idAt(px, py) {
    if (px < 0 || py < 0 || px >= this.pickW || py >= this.pickH) return -1;
    const i = ((this.pickH - 1 - py) * this.pickW + px) * 4;
    const p = this.pickPixels;
    return p[i] + p[i + 1] * 256 + p[i + 2] * 65536 - 1;
  }

  // Visible triangle under a point in CSS pixels relative to the canvas, or -1.
  faceAt(x, y) {
    if (!this.geometry) return -1;
    this._ensurePickBuffer();
    const r = this.renderer.getPixelRatio();
    return this._idAt(Math.floor(x * r), Math.floor(y * r));
  }

  // Visible triangles inside a circle (CSS pixels).
  facesInCircle(x, y, radius) {
    if (!this.geometry) return [];
    this._ensurePickBuffer();
    const r = this.renderer.getPixelRatio();
    const cx = x * r, cy = y * r, rr = radius * r;
    const out = new Set();
    for (let py = Math.floor(cy - rr); py <= Math.ceil(cy + rr); py++) {
      for (let px = Math.floor(cx - rr); px <= Math.ceil(cx + rr); px++) {
        if ((px - cx) ** 2 + (py - cy) ** 2 > rr * rr) continue;
        const id = this._idAt(px, py);
        if (id >= 0) out.add(id);
      }
    }
    return [...out];
  }

  // Visible triangles inside a rectangle (CSS pixels).
  facesInRect(x0, y0, x1, y1) {
    if (!this.geometry) return [];
    this._ensurePickBuffer();
    const r = this.renderer.getPixelRatio();
    const out = new Set();
    const ax = Math.floor(Math.min(x0, x1) * r), bx = Math.ceil(Math.max(x0, x1) * r);
    const ay = Math.floor(Math.min(y0, y1) * r), by = Math.ceil(Math.max(y0, y1) * r);
    for (let py = ay; py <= by; py++) {
      for (let px = ax; px <= bx; px++) {
        const id = this._idAt(px, py);
        if (id >= 0) out.add(id);
      }
    }
    return [...out];
  }

  // All triangles whose centre projects into the rectangle, hidden ones too.
  facesInRectThrough(x0, y0, x1, y1) {
    if (!this.geometry) return [];
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
    this.camera.updateMatrixWorld();
    const m = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).elements;
    const p = this.positions;
    const out = [];
    for (let t = 0; t < this.triangleCount; t++) {
      if (this.hidden?.[t]) continue;
      const o = t * 9;
      const x = (p[o] + p[o + 3] + p[o + 6]) / 3, y = (p[o + 1] + p[o + 4] + p[o + 7]) / 3, z = (p[o + 2] + p[o + 5] + p[o + 8]) / 3;
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw <= 0) continue; // behind the camera
      const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw * 0.5 + 0.5) * w;
      const sy = (0.5 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw * 0.5) * h;
      if (sx >= ax && sx <= bx && sy >= ay && sy <= by) out.push(t);
    }
    return out;
  }
}
