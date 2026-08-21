/**
 * Orbitable studio viewer for the generated model — same look as the
 * idle-preview hero shot, plus zoom, so the user can inspect every detail.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const _center = new THREE.Vector3();
const _sphere = new THREE.Sphere();

export class GeneratorViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
    this.camera.position.set(0, 1, 24);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    // Held well below 1: the point of this viewer is to show the colour that
    // was measured off the product, and a full-strength studio environment
    // plus ACES tone mapping washes a saturated frame out to a pale tint.
    this.scene.environmentIntensity = 0.55;

    const key = new THREE.DirectionalLight(0xffffff, 0.75);
    key.position.set(5, 6, 8);
    this.scene.add(key);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.2));

    this.holder = new THREE.Group();
    this.scene.add(this.holder);
    this.current = null;
    this.wrapper = null;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 1.6;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 60;

    this._resize = this._resize.bind(this);
    this._tick = this._tick.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
    this._raf = requestAnimationFrame(this._tick);
  }

  setAutoRotate(on) {
    this.controls.autoRotate = on;
  }

  /**
   * Show a model group (replacing the previous one), centred and framed.
   * Centring is done on a wrapper rather than on the group itself, so the
   * model keeps its authored origin (the front slab's optical centre) — which
   * is what the try-on placement and the GLB export both rely on.
   */
  setModel(group) {
    if (this.wrapper) this.holder.remove(this.wrapper);
    this.wrapper = null;
    this.current = group;
    if (!group) return;
    const box = new THREE.Box3().setFromObject(group);
    box.getCenter(_center);
    this.wrapper = new THREE.Group();
    this.wrapper.position.copy(_center).negate();
    this.wrapper.add(group);
    box.getBoundingSphere(_sphere);
    const halfFov = Math.tan((this.camera.fov * Math.PI) / 360) * Math.min(1, this.camera.aspect);
    const dist = (_sphere.radius / halfFov) * 1.05;
    this.camera.position.set(0, _sphere.radius * 0.1, dist);
    this.controls.target.set(0, 0, 0);
    this.holder.add(this.wrapper);
  }

  _resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _tick() {
    this._raf = requestAnimationFrame(this._tick);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._resize);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
