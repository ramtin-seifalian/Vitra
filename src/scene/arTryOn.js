import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { getGlasses, disposeGlasses } from '../glasses/loadGlassesModel.js';
import { LiveFaceOccluder, createSkullDome, createEarOccluders } from './faceOccluder.js';
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

    // videoWidth/Height are the decoded frames' ground truth; track settings
    // can report pre-rotation (landscape-swapped) values on mobile.
    const settings = this.stream.getVideoTracks()[0].getSettings();
    this.videoW = this.videoEl.videoWidth || settings.width;
    this.videoH = this.videoEl.videoHeight || settings.height;

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

    // Occlusion, two layers (both invisible, depth-only):
    // 1. a live per-frame mesh of the user's OWN face built from the 468
    //    tracked landmarks (screen-accurate silhouettes — see faceOccluder.js),
    //    positioned in world space each frame, so it lives at the scene root;
    this.faceMesh = new LiveFaceOccluder();
    this.scene.add(this.faceMesh.mesh);
    // 2. approximate skull + pinna volumes rigidly tracking the head: the
    //    dome hides the far temple arm behind the head, the ear pads hide
    //    each arm's end hook behind the ear while its straight part stays
    //    visible riding over the ear.
    this.skull = createSkullDome();
    this.faceAnchor.group.add(this.skull);
    this.ears = createEarOccluders();
    this.faceAnchor.group.add(this.ears);

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

  /**
   * Pixel-exact "cover" layout, applied identically to the video AND the 3D
   * canvas. CSS object-fit crops the video but used to leave the canvas
   * stretched to the stage's different aspect ratio, so the render was
   * squeezed relative to the video — glasses drifted off the face more the
   * further it sat from the image centre or the more the head turned. Sizing
   * both elements to the video's native aspect (scaled to cover the stage,
   * centred, overflow clipped by the stage) keeps every rendered pixel
   * aligned with the video pixel beneath it, at any camera aspect or angle.
   */
  _resize() {
    if (!this.renderer || !this.videoW || !this.videoH) return;
    const stage = this.canvasEl.parentElement.getBoundingClientRect();
    if (!stage.width || !stage.height) return;

    const scale = Math.max(stage.width / this.videoW, stage.height / this.videoH);
    const w = Math.round(this.videoW * scale);
    const h = Math.round(this.videoH * scale);
    const left = Math.round((stage.width - w) / 2);
    const top = Math.round((stage.height - h) / 2);
    for (const el of [this.videoEl, this.canvasEl]) {
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      // The page is RTL: over-constrained absolute boxes resolve from `right`
      // there, so the stylesheet's inset:0 must be explicitly released.
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    }

    this.renderer.setSize(w, h, false); // buffer only; CSS size set above
    this.camera.aspect = this.videoW / this.videoH;
    this.camera.updateProjectionMatrix();
  }

  _tick() {
    this._raf = requestAnimationFrame(this._tick.bind(this));
    const detection = this.tracker.detect(this.videoEl);
    const hasFace = this.faceAnchor.update(detection?.matrix ?? null, performance.now());

    if (hasFace) {
      if (detection?.landmarks) {
        this.faceAnchor.group.updateMatrixWorld();
        this.faceMesh.update(detection.landmarks, this.faceAnchor.group.matrixWorld, this.camera);
      }
      this._noFaceFrames = 0;
      this.onStatus?.(null);
    } else {
      this.faceMesh.hide();
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
    this.faceMesh?.dispose();
    this.faceMesh = null;
    this.skull?.geometry.dispose();
    this.skull?.material.dispose();
    this.skull = null;
    this.ears?.traverse((obj) => {
      obj.geometry?.dispose();
      obj.material?.dispose();
    });
    this.ears = null;
    this.renderer?.dispose();
    this.renderer = null;
  }
}
