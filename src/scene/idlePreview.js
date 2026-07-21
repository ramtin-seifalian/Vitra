import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { getGlasses, disposeGlasses } from '../glasses/loadGlassesModel.js';

const _center = new THREE.Vector3();
const _sphere = new THREE.Sphere();

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

    this.current = null;
    this._styleRequest = 0;

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

  async setStyle(style) {
    const request = ++this._styleRequest;
    const next = await getGlasses(style);
    if (request !== this._styleRequest) return;
    if (this.current) {
      this.group.remove(this.current);
      disposeGlasses(this.current);
    }
    // Glasses are authored in worn position (offset in face space); recentre
    // them so the hero shot spins about the frame's own centre, and pull the
    // camera back far enough for the whole pair (temples included — real
    // models have full-length arms) to stay in frame while auto-rotating.
    const box = new THREE.Box3().setFromObject(next);
    box.getCenter(_center);
    next.position.sub(_center);
    box.getBoundingSphere(_sphere);
    // Portrait stages are width-bound: shrink the effective fov by the aspect
    // ratio so the frame stays fully visible through the auto-rotation.
    const halfFov = Math.tan((this.camera.fov * Math.PI) / 360) * Math.min(1, this.camera.aspect);
    this.camera.position.set(0, 0.3, (_sphere.radius / halfFov) * 0.85);
    this.current = next;
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
