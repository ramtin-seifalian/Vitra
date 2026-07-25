import * as THREE from 'three';
import {
  CANONICAL_FACE_VERTICES,
  CANONICAL_FACE_INDICES,
} from '../glasses/canonicalFaceMesh.js';

const VERTEX_COUNT = CANONICAL_FACE_VERTICES.length / 3;

// Glasses always sit in FRONT of the brows and forehead, so that region can
// only ever falsely occlude the frame's top rim (the "bitten" top edge seen
// in testing) — drop its triangles from the occluder entirely. A triangle is
// dropped only when all three vertices are in the upper-front face region;
// the temple sides (large y but small z) stay, since they legitimately hide
// the far arm on profile turns.
const OCCLUDER_INDICES = (() => {
  const src = CANONICAL_FACE_INDICES;
  const kept = [];
  const inBrowRegion = (vi) => {
    const y = CANONICAL_FACE_VERTICES[vi * 3 + 1];
    const z = CANONICAL_FACE_VERTICES[vi * 3 + 2];
    return y > 3.0 && z > 2.0;
  };
  for (let t = 0; t < src.length; t += 3) {
    if (inBrowRegion(src[t]) && inBrowRegion(src[t + 1]) && inBrowRegion(src[t + 2])) continue;
    kept.push(src[t], src[t + 1], src[t + 2]);
  }
  return new Uint16Array(kept);
})();

// The whole face occluder is recessed by this much (cm) along the view ray.
// Screen-space silhouettes are unaffected (vertices slide along their own
// camera rays), but near-coplanar depth fights — frame top vs brow ridge,
// lens bottom vs cheek — resolve in the glasses' favor, while real occlusion
// events (nose vs far lens: 3cm+ of depth difference) are untouched.
const DEPTH_RECESS = 0.5;

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
    geometry.setIndex(new THREE.BufferAttribute(OCCLUDER_INDICES.slice(), 1));

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
      // Metric depth of this vertex from the rigidly posed canonical face,
      // recessed slightly so near-coplanar contact points don't z-fight.
      _canonical
        .fromArray(CANONICAL_FACE_VERTICES, i * 3)
        .applyMatrix4(anchorMatrix);
      const depth = _canonical.z - DEPTH_RECESS; // view === world space (camera at origin)

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
 * Approximate skull volume behind the face, hiding the far temple arm behind
 * the head on profile turns. Its cap sits behind the ear line (z=-3.2): ray
 * analysis showed the previous cap at z=-1.8 swallowed the STRAIGHT part of
 * the near arm right where it rides over the ear — the patchy
 * mid-arm-disappearing seen in testing — so everything in front of the ear
 * line is now left to the face mesh and the ear occluders.
 */
export function createSkullDome() {
  const geometry = new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  geometry.rotateX(-Math.PI / 2); // dome points -Z, open cap faces +Z
  geometry.scale(7.6, 10.2, 11); // half-widths (cm): head width/height/depth
  geometry.translate(0, 0.8, -3.2); // cap behind the ear line
  const dome = new THREE.Mesh(geometry, makeDepthOnlyMaterial());
  dome.name = 'skull-occluder';
  dome.renderOrder = -1;
  return dome;
}

/**
 * The MediaPipe face mesh has no ears, so nothing ever hid the temple arm's
 * end hook — it rendered ON the ear instead of disappearing behind it. These
 * two ellipsoids stand in for the pinnae (ear canal at the canonical
 * tragion, ±7.66, 0.67, -2.44). Sized so the straight part of the arm,
 * passing ABOVE the ear (y≈3.3), stays visible, while the hook curving down
 * behind the pinna (x≈6.8, y<2, z<-2) falls inside and is hidden — exactly
 * how real glasses read on a real ear.
 */
export function createEarOccluders() {
  const group = new THREE.Group();
  group.name = 'ear-occluders';
  for (const side of [-1, 1]) {
    const geometry = new THREE.SphereGeometry(1, 16, 12);
    geometry.scale(1.0, 2.0, 1.7); // a pinna-sized vertical pad (cm)
    geometry.translate(side * 7.5, 0.6, -2.4);
    const ear = new THREE.Mesh(geometry, makeDepthOnlyMaterial());
    ear.renderOrder = -1;
    group.add(ear);
  }
  return group;
}
