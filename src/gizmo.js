// Blender-style navigation gizmo in the corner of the view:
// - an axis ball showing the view orientation; click an axis to look along
//   it, drag the ball to rotate the view;
// - buttons below it: drag to zoom, drag to pan, perspective/orthographic
//   toggle, plate grid toggle.

const AXES = [
  { label: 'X', dir: [1, 0, 0], color: '#e5484d', view: 'right' },
  { label: 'Y', dir: [0, 1, 0], color: '#8ac926', view: 'back' },
  { label: 'Z', dir: [0, 0, 1], color: '#3d7eff', view: 'top' },
  { label: '', dir: [-1, 0, 0], color: '#e5484d', view: 'left' },
  { label: '', dir: [0, -1, 0], color: '#8ac926', view: 'front' },
  { label: '', dir: [0, 0, -1], color: '#3d7eff', view: 'bottom' },
];

export class NavGizmo {
  constructor(container, viewer, { onProjectionChange } = {}) {
    this.viewer = viewer;
    this.onProjectionChange = onProjectionChange;
    this.size = 110;
    this.el = document.createElement('div');
    this.el.className = 'nav-gizmo';
    this.el.innerHTML = `
      <canvas title="Click an axis to look along it, drag to rotate"></canvas>
      <button data-drag="zoom" title="Drag up/down to zoom">🔍</button>
      <button data-drag="pan" title="Drag to pan">✋</button>
      <button data-act="projection" title="Perspective / orthographic">🎥</button>
      <button data-act="grid" title="Show / hide the plate grid">▦</button>`;
    container.append(this.el);

    this.canvas = this.el.querySelector('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.canvas.height = this.size * dpr;
    this.canvas.style.width = this.canvas.style.height = this.size + 'px';
    this.ctx = this.canvas.getContext('2d');
    this.ctx.scale(dpr, dpr);
    this.hover = null;
    this.handles = [];

    viewer.controls.addEventListener('change', () => this.draw());
    this._ballEvents();
    for (const b of this.el.querySelectorAll('[data-drag]')) this._dragButton(b, b.dataset.drag);
    this.el.querySelector('[data-act="projection"]').addEventListener('click', () => {
      const next = viewer.camera === viewer.orthographicCamera ? 'perspective' : 'orthographic';
      viewer.setProjection(next);
      this.onProjectionChange?.(next);
    });
    this.el.querySelector('[data-act="grid"]').addEventListener('click', (e) => {
      viewer.plate.visible = !viewer.plate.visible;
      e.currentTarget.classList.toggle('off', !viewer.plate.visible);
      viewer.requestRender();
    });
    this.draw();
  }

  // Projects each axis into the view: screen x/y plus depth (toward viewer > 0).
  _project() {
    const q = this.viewer.controls.orientation.clone().invert();
    const r = this.size / 2 - 14;
    const c = this.size / 2;
    return AXES.map((a) => {
      const v = { x: a.dir[0], y: a.dir[1], z: a.dir[2] };
      // Rotate the world axis into camera space.
      const { x, y, z } = rotate(v, q);
      return { ...a, sx: c + x * r, sy: c - y * r, depth: z };
    });
  }

  draw() {
    const ctx = this.ctx, c = this.size / 2;
    ctx.clearRect(0, 0, this.size, this.size);
    if (this.hover === 'ball' || this.dragging) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.arc(c, c, c - 2, 0, Math.PI * 2);
      ctx.fill();
    }
    const pts = this._project().sort((a, b) => a.depth - b.depth); // far first
    this.handles = pts;
    for (const p of pts) {
      const positive = !!p.label;
      if (positive) {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(c, c);
        ctx.lineTo(p.sx, p.sy);
        ctx.stroke();
      }
      const hot = this.hover === p;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, positive ? 11 : 9, 0, Math.PI * 2);
      if (positive) {
        ctx.fillStyle = p.color;
        ctx.fill();
        if (hot) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.label, p.sx, p.sy + 0.5);
      } else {
        ctx.fillStyle = hot ? p.color : 'rgba(20,22,28,0.6)';
        ctx.fill();
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  _handleAt(x, y) {
    // Nearest-first among the front-most handles.
    const hits = this.handles.filter((p) => (p.sx - x) ** 2 + (p.sy - y) ** 2 <= 12 ** 2);
    return hits.length ? hits[hits.length - 1] : null;
  }

  _ballEvents() {
    const cv = this.canvas;
    const local = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      const p = local(e);
      drag = { x: e.clientX, y: e.clientY, moved: false, handle: this._handleAt(p.x, p.y) };
      this.dragging = true;
    });
    cv.addEventListener('pointermove', (e) => {
      const p = local(e);
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
        if (drag.moved) {
          this.viewer.controls.rotateBy(dx, dy);
          drag.x = e.clientX;
          drag.y = e.clientY;
        }
        return;
      }
      const h = this._handleAt(p.x, p.y) || ((p.x - this.size / 2) ** 2 + (p.y - this.size / 2) ** 2 < (this.size / 2) ** 2 ? 'ball' : null);
      if (h !== this.hover) {
        this.hover = h;
        cv.style.cursor = h && h !== 'ball' ? 'pointer' : 'grab';
        this.draw();
      }
    });
    const end = () => {
      if (drag && !drag.moved && drag.handle) this.viewer.setView(drag.handle.view);
      drag = null;
      this.dragging = false;
      this.draw();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => {
      if (!drag) {
        this.hover = null;
        this.draw();
      }
    });
  }

  _dragButton(button, kind) {
    let last = null;
    button.style.cursor = kind === 'zoom' ? 'ns-resize' : 'move';
    button.addEventListener('pointerdown', (e) => {
      button.setPointerCapture(e.pointerId);
      last = { x: e.clientX, y: e.clientY };
      button.classList.add('active');
    });
    button.addEventListener('pointermove', (e) => {
      if (!last) return;
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      if (kind === 'zoom') this.viewer.controls.zoomBy(Math.exp(dy * 0.01));
      else this.viewer.controls.panBy(dx, dy);
    });
    const end = () => {
      last = null;
      button.classList.remove('active');
    };
    button.addEventListener('pointerup', end);
    button.addEventListener('pointercancel', end);
  }
}

// Rotates vector v by quaternion q (x, y, z, w).
function rotate(v, q) {
  const { x, y, z, w } = q;
  const ix = w * v.x + y * v.z - z * v.y;
  const iy = w * v.y + z * v.x - x * v.z;
  const iz = w * v.z + x * v.y - y * v.x;
  const iw = -x * v.x - y * v.y - z * v.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
}
