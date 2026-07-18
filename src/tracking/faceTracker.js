import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

// Self-hosted (copied from node_modules by scripts/copy-mediapipe-wasm.mjs,
// see package.json pre{dev,build}) so the app doesn't depend on a
// third-party CDN being reachable at runtime. The ~10MB model weights still
// load lazily from Google's CDN, which is the standard/expected place for
// them and far too large to vendor into the plugin itself.
const WASM_BASE = `${import.meta.env.BASE_URL}mediapipe/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export class FaceTracker {
  constructor() {
    this.landmarker = null;
    this.lastVideoTime = -1;
  }

  async init({ onProgress } = {}) {
    onProgress?.('loading-runtime');
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE);

    onProgress?.('loading-model');
    this.landmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true,
    });
    onProgress?.('ready');
  }

  /**
   * Runs detection for the current video frame. Safe to call every
   * requestAnimationFrame — internally skips re-processing the same frame.
   * @returns {Float32Array|null} column-major 4x4 facial transformation
   *   matrix for the first detected face, or null if no new result / no face.
   */
  detect(videoEl) {
    if (!this.landmarker || videoEl.readyState < 2) return null;
    if (videoEl.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = videoEl.currentTime;

    const result = this.landmarker.detectForVideo(videoEl, performance.now());
    const matrix = result.facialTransformationMatrixes?.[0]?.data;
    return matrix ?? null;
  }

  dispose() {
    this.landmarker?.close();
    this.landmarker = null;
  }
}
