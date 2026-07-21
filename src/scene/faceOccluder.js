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
function makeDepthOnlyMaterial() {
  const material = new THREE.MeshBasicMaterial({
    colorWrite: false, // invisible: only the depth it writes matters
    // DoubleSide so occlusion is winding-independent; on a thin face shell both
    // sides sit at essentially the same depth, so this can't over-occlude.
    side: THREE.DoubleSide,
  });
  material.polygonOffset = true;
  material.polygonOffsetFactor = 1;
  material.polygonOffsetUnits = 1;
  return material;
}

export function createFaceOccluder() {
  const group = new THREE.Group();
  group.name = 'face-occluder';

  const faceGeometry = new THREE.BufferGeometry();
  faceGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(CANONICAL_FACE_VERTICES.slice(), 3)
  );
  faceGeometry.setIndex(new THREE.BufferAttribute(CANONICAL_FACE_INDICES.slice(), 1));
  faceGeometry.computeVertexNormals();
  const face = new THREE.Mesh(faceGeometry, makeDepthOnlyMaterial());
  face.renderOrder = -1; // lay depth down before any glasses geometry draws
  group.add(face);

  // The canonical mesh only covers the face itself (it ends at the ears,
  // z≈-2.4), but real temple arms run 10cm+ further back. This dome
  // approximates the rest of the skull so the far temple/earhook is hidden by
  // the head on profile turns instead of poking out past the face's edge. It
  // opens toward +Z and starts behind the face shell, so it can never wrongly
  // occlude anything in front of the face.
  const skullGeometry = new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  skullGeometry.rotateX(-Math.PI / 2); // dome points -Z, open cap faces +Z
  skullGeometry.scale(7.0, 10.2, 11); // half-widths (cm): head width/height/depth
  skullGeometry.translate(0, 0.8, -2.0); // cap just behind the face boundary
  const skull = new THREE.Mesh(skullGeometry, makeDepthOnlyMaterial());
  skull.renderOrder = -1;
  group.add(skull);

  return group;
}
