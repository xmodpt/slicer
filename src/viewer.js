import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const BASE_COLOR = new THREE.Color(0xb9c0cc);
const SELECTED_COLOR = new THREE.Color(0xff7a1a);
const HOVER_COLOR = new THREE.Color(0x5cc8ff);

// Renders the mesh and answers "which triangles are under the cursor" using
// an off-screen ID buffer: every triangle is drawn with its index encoded as
// a colour, so picking respects occlusion and costs one texture read.
export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1b1e24);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    this.camera.position.set(2, -3, 2);
    this.camera.up.set(0, 0, 1); // STL files are usually Z-up
    this.scene.add(this.camera);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404650, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 1.5, 2);
    this.camera.add(key); // light follows the view

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.addEventListener('change', () => {
      this.pickDirty = true;
      this.requestRender();
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
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pickDirty = true;
    this.requestRender();
  }

  // Rebuilds the GPU geometry for a mesh. `selection` is a per-triangle mask.
  setMesh(mesh, selection, { frame = false } = {}) {
    for (const child of [...this.group.children]) this.group.remove(child);
    for (const child of [...this.pickScene.children]) this.pickScene.remove(child);
    this.geometry?.dispose();

    const T = mesh.triangleCount;
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
    this.setObjects(null, null);
    this.setSelection(selection);
    if (frame) this.frame();
    this.pickDirty = true;
    this.requestRender();
  }

  setBoundaryEdges(mesh) {
    if (this.boundaryLines) {
      this.group.remove(this.boundaryLines);
      this.boundaryLines.geometry.dispose();
    }
    const edges = mesh.boundaryEdges();
    const p = mesh.positions;
    const arr = new Float32Array(edges.length * 6);
    edges.forEach(([a, b], i) => {
      arr.set(p.subarray(a * 3, a * 3 + 3), i * 6);
      arr.set(p.subarray(b * 3, b * 3 + 3), i * 6 + 3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    this.boundaryLines = new THREE.LineSegments(g, this.boundaryMaterial);
    this.boundaryLines.visible = this.showBoundaries;
    this.group.add(this.boundaryLines);
  }

  // Colour of face t: selection first, then the hovered object, then the
  // optional per-object colours, else the plain model colour.
  _faceColor(t, mask) {
    if (mask[t]) return SELECTED_COLOR;
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
    const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dir = new THREE.Vector3(0.55, -0.75, 0.45).normalize();
    this.camera.near = sphere.radius / 1000;
    this.camera.far = sphere.radius * 1000;
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist * 1.1);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(sphere.center);
    this.controls.update();
  }

  // Renders the model from direction `dir` into a square image, off screen.
  // Returns RGBA pixels plus the visible face id per pixel (-1 = background),
  // both with the top row first.
  captureView(dir, size = 768) {
    const sphere = this.geometry.boundingSphere;
    const cam = new THREE.PerspectiveCamera(35, 1, sphere.radius / 100, sphere.radius * 100);
    const d = new THREE.Vector3(...dir).normalize();
    cam.up.set(0, 0, 1);
    if (Math.abs(d.z) > 0.99) cam.up.set(0, 1, 0);
    const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2));
    cam.position.copy(sphere.center).addScaledVector(d, dist * 1.05);
    cam.lookAt(sphere.center);
    cam.updateMatrixWorld();
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 1.5, 2);
    cam.add(key);
    this.scene.add(cam);

    const rt = new THREE.WebGLRenderTarget(size, size, { samples: 4 });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const boundaries = this.boundaryLines?.visible;
    if (this.boundaryLines) this.boundaryLines.visible = false;
    const raw = new Uint8Array(size * size * 4);
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, cam);
    this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, raw);

    const idRt = new THREE.WebGLRenderTarget(size, size);
    const idRaw = new Uint8Array(size * size * 4);
    const prevColor = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(idRt);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(this.pickScene, cam);
    this.renderer.readRenderTargetPixels(idRt, 0, 0, size, size, idRaw);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(prevColor, prevAlpha);

    if (this.boundaryLines) this.boundaryLines.visible = boundaries;
    this.scene.remove(cam);
    rt.dispose();
    idRt.dispose();
    this.requestRender();

    // Flip rows so the first row is the top of the image.
    const pixels = new Uint8ClampedArray(size * size * 4);
    const faces = new Int32Array(size * size);
    for (let y = 0; y < size; y++) {
      const src = (size - 1 - y) * size;
      pixels.set(raw.subarray(src * 4, (src + size) * 4), y * size * 4);
      for (let x = 0; x < size; x++) {
        const i = (src + x) * 4;
        faces[y * size + x] = idRaw[i] + idRaw[i + 1] * 256 + idRaw[i + 2] * 65536 - 1;
      }
    }
    return { pixels, faces, size };
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
