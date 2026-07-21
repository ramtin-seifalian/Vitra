import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { getGlasses, disposeGlasses } from '../glasses/loadGlassesModel.js';
import { createFaceOccluder } from './faceOccluder.js';
import { FaceTracker } from '../tracking/faceTracker.js';
import { SmoothedFaceAnchor } from '../tracking/smoothedFaceAnchor.js';
import { MEDIAPIPE_CAMERA } from '../glasses/faceAnchors.js';

const NO_FACE_HINT_FRAMES = 90; // ~1.5s at 60fps before nagging the user

/**
 * Live AR try-on: webcam -> MediaPipe FaceLandmarker -> Three.js glasses
 * rendered in a transparent overlay above the (separately, CSS-) mirrored
 * video element.
 */
export class ArTryOn {
  constructor(videoEl, canvasEl) {
    this.videoEl = videoEl;
    this.canvasEl = canvasEl;
    this.tracker = new FaceTracker();
    this.stream = null;
    this._raf = null;
    this._noFaceFrames = 0;
    this.onStatus = null; // (message: string|null, isError?: boolean) => void
  }

  async start(initialStyle = 'round') {
    this.onStatus?.('در حال فعال‌سازی دوربین…');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.videoEl.srcObject = this.stream;
    await this.videoEl.play();
    await this._waitForVideoReady();

    const { width, height } = this.stream.getVideoTracks()[0].getSettings();
    this.videoW = width || this.videoEl.videoWidth;
    this.videoH = height || this.videoEl.videoHeight;

    this.onStatus?.('در حال بارگذاری مدل ردیابی چهره…');
    await this.tracker.init({
      onProgress: (stage) => {
        if (stage === 'loading-model') this.onStatus?.('در حال دانلود مدل هوش مصنوعی…');
      },
    });

    this._setupScene();
    await this.setStyle(initialStyle);
    this.onStatus?.('صورت خود را مقابل دوربین قرار دهید', false);
    this._noFaceFrames = 0;
    this._raf = requestAnimationFrame(this._tick.bind(this));
  }

  _waitForVideoReady() {
    if (this.videoEl.readyState >= 2) return Promise.resolve();
    return new Promise((resolve) => {
      this.videoEl.addEventListener('loadeddata', () => resolve(), { once: true });
    });
  }

  _setupScene() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvasEl, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.06).texture;

    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(2, 3, 5);
    this.scene.add(key);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));

    // Camera matched to MediaPipe's own virtual-camera assumption so the
    // facialTransformationMatrix lands the glasses in the right place
    // without any manual calibration guesswork.
    this.camera = new THREE.PerspectiveCamera(
      MEDIAPIPE_CAMERA.verticalFovDegrees,
      this.videoW / this.videoH,
      MEDIAPIPE_CAMERA.near,
      MEDIAPIPE_CAMERA.far
    );

    this.faceAnchor = new SmoothedFaceAnchor();
    this.scene.add(this.faceAnchor.group);

    // Invisible depth-only face mesh: makes the real face hide the parts of the
    // glasses behind it (nose over far lens, temples behind the head). Parented
    // straight under the face anchor so it tracks the actual face — the fit
    // sliders below must move only the glasses, not this.
    this.occluder = createFaceOccluder();
    this.faceAnchor.group.add(this.occluder);

    // Live fit-calibration offset, adjustable from the UI sliders.
    this.fitOffset = new THREE.Group();
    this.faceAnchor.group.add(this.fitOffset);

    this.glasses = null;
    this._styleRequest = 0;

    this._resize();
    window.addEventListener('resize', this._resizeBound ?? (this._resizeBound = this._resize.bind(this)));
  }

  async setStyle(style) {
    if (!this.fitOffset) return;
    // Model styles load async; the token discards stale results if the user
    // taps another style before this one arrives.
    const request = ++this._styleRequest;
    const next = await getGlasses(style);
    if (request !== this._styleRequest || !this.fitOffset) return;
    if (this.glasses) {
      this.fitOffset.remove(this.glasses);
      disposeGlasses(this.glasses);
    }
    this.glasses = next;
    this.fitOffset.add(this.glasses);
  }

  setFitOffset({ y = 0, z = 0, scale = 1 } = {}) {
    if (!this.fitOffset) return;
    this.fitOffset.position.set(0, y, z);
    this.fitOffset.scale.setScalar(scale);
  }

  _resize() {
    if (!this.renderer) return;
    const w = this.canvasEl.clientWidth;
    const h = this.canvasEl.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = this.videoW / this.videoH;
    this.camera.updateProjectionMatrix();
  }

  _tick() {
    this._raf = requestAnimationFrame(this._tick.bind(this));
    const matrix = this.tracker.detect(this.videoEl);
    const hasFace = this.faceAnchor.update(matrix, performance.now());

    if (hasFace) {
      this._noFaceFrames = 0;
      this.onStatus?.(null);
    } else {
      this._noFaceFrames += 1;
      if (this._noFaceFrames === NO_FACE_HINT_FRAMES) {
        this.onStatus?.('صورت شما دیده نمی‌شود — نور بیشتر یا نزدیک‌تر شوید', false);
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    if (this._resizeBound) window.removeEventListener('resize', this._resizeBound);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.tracker.dispose();
    this.occluder?.traverse((obj) => {
      obj.geometry?.dispose();
      obj.material?.dispose();
    });
    this.occluder = null;
    this.renderer?.dispose();
    this.renderer = null;
  }
}
