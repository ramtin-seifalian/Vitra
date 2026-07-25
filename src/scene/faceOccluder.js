import * as THREE from 'three';
import {
  CANONICAL_FACE_VERTICES,
  CANONICAL_FACE_INDICES,
} from '../glasses/canonicalFaceMesh.js';

const VERTEX_COUNT = CANONICAL_FACE_VERTICES.length / 3;

function makeDepthOnlyMaterial() {
  const material = new THREE.MeshBasicMaterial({
    colorWrite: false, // invisible: only the depth it writes matters
    side: THREE.DoubleSide,
  });
  material.polygonOffset = true;
  material.polygonOffsetFactor = 1;
  material.polygonOffsetUnits = 1;
  return material;
}

const _canonical = new THREE.Vector3();
const _ray = new THREE.Vector3();

/**
 * Live, per-frame "3D scan" occluder of the user's actual face — the
 * architecture commercial try-ons use, rather than a posed average-face
 * stand-in.
 *
 * Each frame, every one of the 468 MediaPipe landmarks contributes a vertex:
 *   - screen position comes from the LIVE landmark (normalized video coords
 *     unprojected through the render camera), so silhouettes — nose edge,
 *     brow, cheek, jaw — match the user's real features pixel-accurately,
 *     whatever their face shape;
 *   - depth comes from the rigidly posed canonical vertex (the same smoothed
 *     transform the glasses hang from), keeping depth metric and consistent
 *     with the glasses so in-front/behind decisions are stable.
 *
 * The mesh writes depth but no color, so the real face hides whatever glasses
 * geometry sits behind it: the nose covers the far lens in profile, cheeks
 * clip the lens bottoms, and the frame never gets falsely eaten by an
 * average-face brow that the user doesn't have.
 */
export class LiveFaceOccluder {
  constructor() {
    const geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(CANONICAL_FACE_VERTICES.length);
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(CANONICAL_FACE_INDICES.slice(), 1));

    this.mesh = new THREE.Mesh(geometry, makeDepthOnlyMaterial());
    this.mesh.name = 'live-face-occluder';
    this.mesh.renderOrder = -1; // lay depth down before any glasses geometry
    this.mesh.frustumCulled = false; // positions stream in every frame
    this.mesh.visible = false;

    this._hasPrev = false; // EMA state for landmark jitter smoothing
  }

  /**
   * @param {Array<{x,y,z}>} landmarks 468 normalized-video-space landmarks
   * @param {THREE.Matrix4} anchorMatrix smoothed face-anchor world matrix
   * @param {THREE.PerspectiveCamera} camera the AR render camera
   */
  update(landmarks, anchorMatrix, camera) {
    if (!landmarks || landmarks.length < VERTEX_COUNT) return;
    const pos = this.positions;
    const smooth = this._hasPrev ? 0.55 : 1; // EMA blend toward the new frame

    for (let i = 0; i < VERTEX_COUNT; i++) {
      // Metric depth of this vertex from the rigidly posed canonical face.
      _canonical
        .fromArray(CANONICAL_FACE_VERTICES, i * 3)
        .applyMatrix4(anchorMatrix);
      const depth = _canonical.z; // view space === world space (camera at origin)

      // Camera ray through the live landmark's screen position...
      const lm = landmarks[i];
      _ray.set(lm.x * 2 - 1, -(lm.y * 2 - 1), 0.5).applyMatrix4(camera.projectionMatrixInverse);
      // ...pushed out to the canonical depth along that ray.
      _ray.multiplyScalar(depth / _ray.z);

      const j = i * 3;
      pos[j] += (_ray.x - pos[j]) * smooth;
      pos[j + 1] += (_ray.y - pos[j + 1]) * smooth;
      pos[j + 2] += (_ray.z - pos[j + 2]) * smooth;
    }
    this._hasPrev = true;
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.visible = true;
  }

  hide() {
    this.mesh.visible = false;
    this._hasPrev = false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/**
 * Approximate skull volume behind the face. The landmark mesh only covers the
 * face itself, but the temple arms run 10cm+ further back: this dome hides
 * the far arm behind the head on profile turns, and swallows the near arm's
 * ear hook just behind the ear — so the straight part of the arm stays
 * visible over the ear and only the end hook disappears behind it, like real
 * glasses. It opens toward +Z and starts behind the face shell, so it can
 * never wrongly occlude anything in front of the face.
 */
export function createSkullDome() {
  const geometry = new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  geometry.rotateX(-Math.PI / 2); // dome points -Z, open cap faces +Z
  geometry.scale(7.5, 10.2, 11); // half-widths (cm): head width/height/depth
  geometry.translate(0, 0.8, -1.8); // cap just behind the face boundary
  const dome = new THREE.Mesh(geometry, makeDepthOnlyMaterial());
  dome.name = 'skull-occluder';
  dome.renderOrder = -1;
  return dome;
}
