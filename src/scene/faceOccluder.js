import * as THREE from 'three';
import {
  CANONICAL_FACE_VERTICES,
  CANONICAL_FACE_INDICES,
} from '../glasses/canonicalFaceMesh.js';

/**
 * Builds a depth-only "occluder" of the canonical human face, in the same
 * metric-cm space as the glasses. Parented under the face-transform anchor it
 * writes to the depth buffer but not to color (invisible), so any part of the
 * glasses that ends up *behind* the face gets depth-culled: the nose swings in
 * front of the far lens when you turn to profile, and the temple arms vanish
 * where they pass behind the head. This depth relationship is the single thing
 * that makes the overlay read as genuinely worn rather than pasted flat on top
 * of the video.
 *
 * The mesh is the average (canonical) face, rigidly posed/scaled by the
 * tracker — not a per-frame reconstruction of the user's own face — which is
 * the standard, robust approach for a rigid-transform try-on and is accurate
 * enough around the nose/brow/cheeks where the occlusion actually matters.
 */
export function createFaceOccluder() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(CANONICAL_FACE_VERTICES.slice(), 3)
  );
  geometry.setIndex(new THREE.BufferAttribute(CANONICAL_FACE_INDICES.slice(), 1));
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    colorWrite: false, // invisible: only the depth it writes matters
    // DoubleSide so occlusion is winding-independent; on a thin face shell both
    // sides sit at essentially the same depth, so this can't over-occlude.
    side: THREE.DoubleSide,
  });
  material.polygonOffset = true;
  material.polygonOffsetFactor = 1;
  material.polygonOffsetUnits = 1;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'face-occluder';
  mesh.renderOrder = -1; // lay depth down before any glasses geometry draws
  return mesh;
}
