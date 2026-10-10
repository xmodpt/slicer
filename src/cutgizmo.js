import * as THREE from 'three';

// Meshmixer-style handle for the cut plane, drawn at the plane's centre:
// - arrow: drag to slide the plane along its normal;
// - two rings: drag to tilt the plane around either in-plane axis;
// - ball: drag to move the handle across the plane.
// Handles are drawn on top of the model so they stay grabbable.

const COLORS = { arrow: 0x5cc8ff, ringU: 0xff6b6b, ringV: 0x6bdc8a, orb: 0xffd166 };

export class CutGizmo {
  constructor(viewer, onChange) {
    this.viewer = viewer;
    this.onChange = onChange;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.group.renderOrder = 10;
    viewer.scene.add(this.group);
    this.handles = []; // pickable (invisible, fat) meshes
    this.visuals = {}; // name -> visible meshes
    this.size = 0;
    this.hovered = null;
    this.drag = null;
  }

  // plane: { normal, center, u } (u = an in-plane direction); radius = model size.
  update(plane, radius) {
    if (!plane) {
      this.group.visible = false;
      this.viewer.requestRender();
      return;
    }
    if (Math.abs(radius - this.size) > 1e-9) this._build(radius);
    const n = new THREE.Vector3(...plane.normal).normalize();
    const u = new THREE.Vector3(...plane.u).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    // Local frame: x = u, y = v, z = n.
    this.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n));
    this.group.position.set(...plane.center);
    this.group.visible = true;
    this.group.updateMatrixWorld(true);
    this.viewer.requestRender();
  }

  _build(radius) {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      child.traverse((o) => o.geometry?.dispose());
    }
    this.handles = [];
    this.visuals = {};
    this.size = radius;
    const R = radius * 0.42;
    const mat = (color, opacity = 1) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
    const add = (name, visual, pick) => {
      visual.renderOrder = 10;
      this.group.add(visual);
      (this.visuals[name] ||= []).push(visual);
      if (pick) {
        pick.visible = false;
        pick.userData.handle = name;
        this.group.add(pick);
        this.handles.push(pick);
      }
    };

    // Arrow along +n (local z), with a short stub below.
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.025, R * 0.025, R * 1.3, 12), mat(COLORS.arrow));
    shaft.rotation.x = Math.PI / 2;
    shaft.position.z = R * 0.35;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(R * 0.09, R * 0.25, 20), mat(COLORS.arrow));
    tip.rotation.x = Math.PI / 2;
    tip.position.z = R * 1.1;
    const arrowPick = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.12, R * 0.12, R * 1.6, 8), mat(0));
    arrowPick.rotation.x = Math.PI / 2;
    arrowPick.position.z = R * 0.45;
    add('arrow', shaft, arrowPick);
    add('arrow', tip);

    // Ring rotating around u (local x): torus axis must be x → turn the default (z-axis) torus.
    const ring = (name, color, rot) => {
      const t = new THREE.Mesh(new THREE.TorusGeometry(R, R * 0.022, 8, 96), mat(color, 0.95));
      const p = new THREE.Mesh(new THREE.TorusGeometry(R, R * 0.09, 6, 64), mat(0));
      t.rotation.set(...rot);
      p.rotation.set(...rot);
      add(name, t, p);
    };
    ring('ringU', COLORS.ringU, [0, Math.PI / 2, 0]); // axis = local x (u)
    ring('ringV', COLORS.ringV, [Math.PI / 2, 0, 0]); // axis = local y (v)

    const orb = new THREE.Mesh(new THREE.SphereGeometry(R * 0.11, 24, 16), mat(COLORS.orb));
    const orbPick = new THREE.Mesh(new THREE.SphereGeometry(R * 0.16, 12, 8), mat(0));
    add('orb', orb, orbPick);
  }

  // Handle under a CSS-pixel position, or null.
  hit(x, y) {
    if (!this.group.visible) return null;
    const ray = new THREE.Raycaster();
    ray.ray.copy(this.viewer.rayAt(x, y));
    const hits = ray.intersectObjects(this.handles, false);
    // Prefer the orb, then the arrow, then rings, when they overlap.
    const order = ['orb', 'arrow', 'ringU', 'ringV'];
    hits.sort((a, b) => order.indexOf(a.object.userData.handle) - order.indexOf(b.object.userData.handle));
    return hits[0]?.object.userData.handle || null;
  }

  setHover(name) {
    if (name === this.hovered) return;
    this.hovered = name;
    for (const [key, meshes] of Object.entries(this.visuals)) {
      for (const m of meshes) m.material.color.setHex(key === name ? 0xffffff : COLORS[key]);
    }
    this.viewer.requestRender();
  }

  // Dragging. `plane` is the live cut plane object ({ normal, center, u });
  // it is updated in place and onChange() is called.
  startDrag(name, x, y, plane) {
    const ray = this.viewer.rayAt(x, y);
    const n = new THREE.Vector3(...plane.normal);
    const u = new THREE.Vector3(...plane.u);
    const c = new THREE.Vector3(...plane.center);
    this.drag = { name, n0: n.clone(), u0: u.clone(), c0: c.clone(), plane };
    if (name === 'arrow') this.drag.t0 = lineParam(ray, c, n);
    if (name === 'ringU' || name === 'ringV') {
      const axis = name === 'ringU' ? u.clone() : new THREE.Vector3().crossVectors(n, u);
      this.drag.axis = axis;
      this.drag.a0 = ringAngle(ray, c, axis);
      this.drag.x0 = x;
    }
    this.setHover(name);
  }

  moveDrag(x, y) {
    const d = this.drag;
    if (!d) return;
    const ray = this.viewer.rayAt(x, y);
    const p = d.plane;
    if (d.name === 'arrow') {
      const t = lineParam(ray, d.c0, d.n0);
      if (t === null || d.t0 === null) return;
      p.center = d.c0.clone().addScaledVector(d.n0, t - d.t0).toArray();
    } else if (d.name === 'orb') {
      const hit = ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(d.n0, d.c0), new THREE.Vector3());
      if (!hit) return;
      p.center = hit.toArray();
    } else {
      let a = ringAngle(ray, d.c0, d.axis);
      // Ring seen edge-on: fall back to horizontal mouse movement.
      const delta = a === null || d.a0 === null ? (x - d.x0) * 0.01 : a - d.a0;
      const q = new THREE.Quaternion().setFromAxisAngle(d.axis, delta);
      p.normal = d.n0.clone().applyQuaternion(q).normalize().toArray();
      p.u = d.u0.clone().applyQuaternion(q).normalize().toArray();
    }
    this.onChange();
  }

  endDrag() {
    const was = !!this.drag;
    this.drag = null;
    this.setHover(null);
    return was;
  }
}

// Parameter along the line (origin c, direction n) of the point closest to the ray.
function lineParam(ray, c, n) {
  const d = ray.direction, w0 = new THREE.Vector3().subVectors(c, ray.origin);
  const b = d.dot(n), denom = 1 - b * b;
  if (Math.abs(denom) < 1e-6) return null; // looking straight along the arrow
  return (b * w0.dot(d) - w0.dot(n)) / denom;
}

// Angle of the ray's hit on the ring plane (through c, perpendicular to axis).
function ringAngle(ray, c, axis) {
  if (Math.abs(ray.direction.dot(axis)) < 0.08) return null;
  const hit = ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(axis, c), new THREE.Vector3());
  if (!hit) return null;
  const b1 = new THREE.Vector3(1, 0, 0);
  if (Math.abs(b1.dot(axis)) > 0.9) b1.set(0, 1, 0);
  b1.addScaledVector(axis, -b1.dot(axis)).normalize();
  const b2 = new THREE.Vector3().crossVectors(axis, b1);
  const r = hit.sub(c);
  return Math.atan2(r.dot(b2), r.dot(b1));
}
