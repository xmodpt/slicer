import * as THREE from 'three';

// Camera navigation around a target point.
//
// - rotate: "free" tumbles in every direction (no locking at the poles);
//   "turntable" spins around the world Z axis and keeps Z pointing up.
// - pan moves the target with the mouse, zoom moves toward the cursor.
// - Works for both a perspective and an orthographic camera; the orthographic
//   view size follows the same `distance` so switching keeps the framing.
//
// `buttons` maps mouse buttons (0 left, 1 middle, 2 right) to 'rotate', 'pan'
// or null; buttons mapped to null are left alone for the selection tools.
export class CameraControls extends THREE.EventDispatcher {
  constructor(domElement, perspective, orthographic) {
    super();
    this.dom = domElement;
    this.perspective = perspective;
    this.orthographic = orthographic;
    this.target = new THREE.Vector3();
    this.orientation = new THREE.Quaternion();
    this.distance = 10;
    this.sceneRadius = 1;
    this.mode = 'free';
    this.buttons = { 0: null, 1: 'pan', 2: 'rotate' };
    this.rotateSpeed = 0.008;
    this._drag = null;

    domElement.addEventListener('pointerdown', (e) => this._down(e));
    domElement.addEventListener('pointermove', (e) => this._move(e));
    domElement.addEventListener('pointerup', (e) => this._up(e));
    domElement.addEventListener('pointercancel', (e) => this._up(e));
    domElement.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    this.setView([0.55, -0.75, 0.45], [0, 0, 1]);
  }

  get dragging() {
    return !!this._drag;
  }

  // Looks at the target from direction `dir` (pointing from target to camera).
  setView(dir, up = [0, 0, 1]) {
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(...dir), new THREE.Vector3(), new THREE.Vector3(...up));
    this.orientation.setFromRotationMatrix(m);
    this.update();
  }

  frame(center, radius) {
    this.target.copy(center);
    this.sceneRadius = radius || 1;
    this.distance = (this.sceneRadius / Math.sin(THREE.MathUtils.degToRad(this.perspective.fov / 2))) * 1.1;
    this.update();
  }

  // New rotation centre; the camera stays where it is and turns to face it.
  setPivot(point) {
    const camPos = this.target.clone().add(this._axis(2).multiplyScalar(this.distance));
    const offset = camPos.clone().sub(point);
    if (offset.lengthSq() < 1e-12) return;
    const up = this.mode === 'turntable' ? new THREE.Vector3(0, 0, 1) : this._axis(1);
    this.orientation.setFromRotationMatrix(new THREE.Matrix4().lookAt(offset, new THREE.Vector3(), up));
    this.target.copy(point);
    this.distance = offset.length();
    this.update();
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === 'turntable') this._rotate(0, 0); // removes any roll
    this.update();
  }

  // Camera axis in world space: 0 right, 1 up, 2 backwards (toward the camera).
  _axis(i) {
    const v = new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
    return v.applyQuaternion(this.orientation);
  }

  _rotate(dx, dy) {
    if (this.mode === 'free') {
      const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dx * this.rotateSpeed);
      const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -dy * this.rotateSpeed);
      this.orientation.multiply(qx).multiply(qy).normalize();
      return;
    }
    // Turntable: azimuth around world Z, elevation clamped short of the poles.
    const back = this._axis(2);
    let az = Math.atan2(back.y, back.x) - dx * this.rotateSpeed;
    let el = Math.asin(THREE.MathUtils.clamp(back.z, -1, 1)) + dy * this.rotateSpeed;
    el = THREE.MathUtils.clamp(el, -Math.PI / 2 + 1e-3, Math.PI / 2 - 1e-3);
    const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
    this.orientation.setFromRotationMatrix(new THREE.Matrix4().lookAt(dir, new THREE.Vector3(), new THREE.Vector3(0, 0, 1)));
  }

  _halfHeight() {
    return this.distance * Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2));
  }

  _worldPerPixel() {
    return (2 * this._halfHeight()) / Math.max(1, this.dom.clientHeight);
  }

  _pan(dx, dy) {
    const s = this._worldPerPixel();
    this.target.addScaledVector(this._axis(0), -dx * s).addScaledVector(this._axis(1), dy * s);
  }

  // Zooms by `factor`, keeping the point under the cursor in place.
  zoomAt(factor, clientX, clientY) {
    const r = this.dom.getBoundingClientRect();
    const nx = ((clientX - r.left) / r.width) * 2 - 1;
    const ny = 1 - ((clientY - r.top) / r.height) * 2;
    const halfH = this._halfHeight(), halfW = halfH * (r.width / r.height);
    const cursor = this.target.clone().addScaledVector(this._axis(0), nx * halfW).addScaledVector(this._axis(1), ny * halfH);
    const minDist = this.sceneRadius * 1e-3;
    const f = Math.max(factor, minDist / this.distance);
    this.distance *= f;
    this.target.sub(cursor).multiplyScalar(f).add(cursor);
    this.update();
  }

  update() {
    const pos = this.target.clone().addScaledVector(this._axis(2), this.distance);
    const reach = this.distance + this.sceneRadius * 4;
    for (const cam of [this.perspective, this.orthographic]) {
      cam.position.copy(pos);
      cam.quaternion.copy(this.orientation);
      cam.up.copy(this._axis(1));
    }
    this.perspective.near = Math.max(this.distance * 1e-3, this.sceneRadius * 1e-4);
    this.perspective.far = reach;
    const aspect = this.dom.clientWidth / Math.max(1, this.dom.clientHeight) || 1;
    const halfH = this._halfHeight();
    Object.assign(this.orthographic, { left: -halfH * aspect, right: halfH * aspect, top: halfH, bottom: -halfH, near: -reach, far: reach });
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
    this.orthographic.updateProjectionMatrix();
    this.perspective.updateMatrixWorld();
    this.orthographic.updateMatrixWorld();
    this.dispatchEvent({ type: 'change' });
  }

  _down(e) {
    let action = this.buttons[e.button];
    if (action === 'rotate' && e.shiftKey) action = 'pan';
    if (!action || this._drag) return;
    this._drag = { action, x: e.clientX, y: e.clientY, id: e.pointerId };
    this.dom.setPointerCapture(e.pointerId);
    this.dom.style.cursor = action === 'pan' ? 'move' : 'grabbing';
  }

  _move(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    if (d.action === 'rotate') this._rotate(dx, dy);
    else this._pan(dx, dy);
    this.update();
  }

  _up(e) {
    if (!this._drag || e.pointerId !== this._drag.id) return;
    this._drag = null;
    this.dom.style.cursor = '';
    this.dispatchEvent({ type: 'end' });
  }

  _wheel(e) {
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    this.zoomAt(Math.exp(THREE.MathUtils.clamp(delta, -200, 200) * 0.0015), e.clientX, e.clientY);
  }
}
