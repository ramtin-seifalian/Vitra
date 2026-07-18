import * as THREE from 'three';
import { Vector3OneEuroFilter, QuaternionSlerpFilter, OneEuroFilter } from './oneEuroFilter.js';

const tmpMatrix = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();

/**
 * Wraps a THREE.Group whose transform tracks MediaPipe's raw, per-frame
 * facialTransformationMatrix — decomposed into position/rotation/scale and
 * smoothed independently (smoothing a raw 4x4 matrix directly produces
 * warped, non-rigid results; smoothing the decomposed TRS is what every
 * production face-AR pipeline does).
 */
export class SmoothedFaceAnchor {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'face-anchor';
    this.group.visible = false;

    // minCutoff: higher = less lag but more jitter when still.
    // beta: higher = snappier response to fast motion.
    this.posFilter = new Vector3OneEuroFilter({ minCutoff: 0.8, beta: 0.6, dCutoff: 1.0 });
    this.quatFilter = new QuaternionSlerpFilter({ minCutoff: 0.9, beta: 14 });
    this.scaleFilter = new OneEuroFilter({ minCutoff: 0.8, beta: 0.4 });

    this.hasFace = false;
    this.framesSinceSeen = 0;
  }

  /** @param {Float32Array|number[]|null} matrixData column-major 4x4, or null if no face detected this frame */
  update(matrixData, timestampMs) {
    if (!matrixData) {
      this.framesSinceSeen += 1;
      if (this.framesSinceSeen > 8) {
        this.hasFace = false;
        this.group.visible = false;
      }
      return this.hasFace;
    }
    this.framesSinceSeen = 0;

    tmpMatrix.fromArray(matrixData);
    tmpMatrix.decompose(tmpPos, tmpQuat, tmpScale);

    const smoothedPos = this.posFilter.filter(tmpPos, timestampMs);
    const smoothedQuat = this.quatFilter.filter(tmpQuat, timestampMs);
    const uniformScale = (tmpScale.x + tmpScale.y + tmpScale.z) / 3;
    const smoothedScale = this.scaleFilter.filter(uniformScale, timestampMs);

    this.group.position.copy(smoothedPos);
    this.group.quaternion.copy(smoothedQuat);
    this.group.scale.setScalar(smoothedScale);

    this.hasFace = true;
    this.group.visible = true;
    return true;
  }
}
