import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createGlasses } from '../glasses/createGlasses.js';

/**
 * A rotating hero shot of the default glasses model, shown before the user
 * taps "Try On". Purely decorative — no camera, no tracking.
 */
export class IdlePreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    this.camera.position.set(0, 0.3, 22);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(5, 6, 8);
    this.scene.add(key);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.current = createGlasses('round');
    this.group.add(this.current);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.enableZoom = false;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 2.2;
    this.controls.minPolarAngle = Math.PI / 2 - 0.5;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.5;

    this._resize = this._resize.bind(this);
    this._tick = this._tick.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();

    this._raf = requestAnimationFrame(this._tick);
  }

  setStyle(style) {
    this.group.remove(this.current);
    this.current.traverse((obj) => {
      obj.geometry?.dispose();
      obj.material?.dispose();
    });
    this.current = createGlasses(style);
    this.group.add(this.current);
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

  pause() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  resume() {
    if (!this._raf) this._raf = requestAnimationFrame(this._tick);
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._resize);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
