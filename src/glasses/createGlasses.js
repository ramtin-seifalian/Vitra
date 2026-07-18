import * as THREE from 'three';
import { roundedRectShape, aviatorShape, insetShape } from './shapes.js';
import {
  LEFT_EYE_CENTER,
  RIGHT_EYE_CENTER,
  NOSE_BRIDGE,
  TEMPLE_SIDE,
  EAR_TOP,
  TRAGION,
} from './faceAnchors.js';

// All dimensions in centimeters, in the same real-world scale as
// faceAnchors.js, so a glasses group parented directly under the
// face-transform anchor (see tracking/smoothedFaceAnchor.js) needs no extra
// scaling to look correctly sized on a real face.
const LENS_CENTER_X = 3.35;
const LENS_HALF_WIDTH = 2.35;
const LENS_HEIGHT = 3.7;
const LENS_CENTER_Y = LEFT_EYE_CENTER[1] + 0.15;
const LENS_CENTER_Z = LEFT_EYE_CENTER[2] + 0.55;
const RIM_THICKNESS = 0.4;
const RIM_DEPTH = 0.45;
const BRIDGE_Z = NOSE_BRIDGE[2] - 0.35;
const BRIDGE_Y = LENS_CENTER_Y + LENS_HEIGHT * 0.34;

const STYLE_PRESETS = {
  round: {
    shapeFn: (w, h) => roundedRectShape(w, h, Math.min(w, h) / 2),
    width: LENS_HALF_WIDTH * 2 * 0.92,
    height: LENS_HEIGHT * 0.92,
    frameColor: 0x2b2620,
    metalness: 0.15,
    roughness: 0.35,
  },
  square: {
    shapeFn: (w, h) => roundedRectShape(w, h, Math.min(w, h) * 0.16),
    width: LENS_HALF_WIDTH * 2,
    height: LENS_HEIGHT * 0.86,
    frameColor: 0x1c1c1e,
    metalness: 0.1,
    roughness: 0.4,
  },
  aviator: {
    shapeFn: (w, h) => aviatorShape(w, h),
    width: LENS_HALF_WIDTH * 2 * 1.05,
    height: LENS_HEIGHT * 1.08,
    frameColor: 0xC9A24B,
    metalness: 0.75,
    roughness: 0.25,
  },
};

function buildRim(shapeFn, w, h, color, metalness, roughness) {
  const outer = shapeFn(w, h);
  const inner = insetShape(shapeFn(w, h), -RIM_THICKNESS);
  outer.holes.push(inner);

  const geometry = new THREE.ExtrudeGeometry(outer, {
    depth: RIM_DEPTH,
    bevelEnabled: true,
    bevelThickness: 0.03,
    bevelSize: 0.03,
    bevelSegments: 2,
    curveSegments: 24,
  });
  geometry.translate(0, 0, -RIM_DEPTH / 2);
  geometry.computeVertexNormals();

  const material = new THREE.MeshPhysicalMaterial({
    color,
    metalness,
    roughness,
    clearcoat: 0.4,
    clearcoatRoughness: 0.25,
  });
  return new THREE.Mesh(geometry, material);
}

function buildLens(shapeFn, w, h) {
  const inner = insetShape(shapeFn(w, h), -(RIM_THICKNESS + 0.03));
  const geometry = new THREE.ExtrudeGeometry(inner, {
    depth: 0.09,
    bevelEnabled: false,
    curveSegments: 24,
  });
  geometry.translate(0, 0, -0.045);
  geometry.computeVertexNormals();

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xdfe9ea,
    transmission: 1,
    transparent: true,
    opacity: 1,
    roughness: 0.04,
    metalness: 0,
    ior: 1.5,
    thickness: 0.15,
    envMapIntensity: 1.1,
    attenuationColor: new THREE.Color(0xe8f4f5),
    attenuationDistance: 2.5,
  });
  return new THREE.Mesh(geometry, material);
}

function buildBridge(color, metalness, roughness) {
  const gap = LENS_CENTER_X * 2 - LENS_HALF_WIDTH * 2 - RIM_THICKNESS * 2;
  const bridgeWidth = Math.max(gap, 1.2);
  const geometry = new THREE.CylinderGeometry(0.14, 0.14, bridgeWidth, 12);
  geometry.rotateZ(Math.PI / 2);
  const material = new THREE.MeshPhysicalMaterial({ color, metalness, roughness, clearcoat: 0.3 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, BRIDGE_Y, BRIDGE_Z);
  return mesh;
}

function buildNosePads(color) {
  const material = new THREE.MeshPhysicalMaterial({ color, metalness: 0.2, roughness: 0.5 });
  const group = new THREE.Group();
  [-1, 1].forEach((side) => {
    const geo = new THREE.SphereGeometry(0.22, 12, 10);
    geo.scale(1, 1.4, 0.6);
    const pad = new THREE.Mesh(geo, material);
    pad.position.set(side * 0.75, LENS_CENTER_Y - 0.3, NOSE_BRIDGE[2] - 0.55);
    pad.rotation.z = side * 0.35;
    group.add(pad);
  });
  return group;
}

// A real temple arm: leaves the frame hinge, runs straight back along the
// temple, rests over the top of the ear, then hooks down behind it. Routed
// through the actual side-of-head anatomy (faceAnchors) so, combined with the
// face occluder, it reads as wrapping around the head — the near arm passes in
// front of the ear and the far one is hidden behind it on profile turns.
function buildTemple(side, color, metalness, roughness) {
  const hingeX = LENS_CENTER_X + LENS_HALF_WIDTH + RIM_THICKNESS * 0.5;
  const points = [
    [hingeX, LENS_CENTER_Y, LENS_CENTER_Z - 0.1], // hinge on the frame
    [hingeX + 0.6, LENS_CENTER_Y + 0.05, 1.8], // back along the temple
    [TEMPLE_SIDE[0] + 0.3, TEMPLE_SIDE[1] - 1.0, -0.7], // approaching the ear
    [EAR_TOP[0] - 0.25, EAR_TOP[1] - 0.2, EAR_TOP[2] + 0.05], // over the ear top
    [TRAGION[0] - 0.3, TRAGION[1] + 0.05, TRAGION[2] - 0.05], // hook down behind ear
  ].map(([x, y, z]) => new THREE.Vector3(side * x, y, z));

  const curve = new THREE.CatmullRomCurve3(points);
  const geometry = new THREE.TubeGeometry(curve, 48, 0.135, 10, false);
  const material = new THREE.MeshPhysicalMaterial({ color, metalness, roughness, clearcoat: 0.3 });
  return new THREE.Mesh(geometry, material);
}

/**
 * Builds a procedural pair of glasses, in real-world centimeters, positioned
 * to sit correctly when parented under a face-transform anchor (no extra
 * offset needed). Guaranteed to render with zero external asset loading —
 * used as the phase-1 default until real scanned models arrive in phase 2.
 */
export function createGlasses(style = 'round') {
  const preset = STYLE_PRESETS[style] ?? STYLE_PRESETS.round;
  const { shapeFn, width, height, frameColor, metalness, roughness } = preset;

  const group = new THREE.Group();
  group.name = `glasses-${style}`;

  [-1, 1].forEach((side) => {
    const rim = buildRim(shapeFn, width, height, frameColor, metalness, roughness);
    rim.position.set(side * LENS_CENTER_X, LENS_CENTER_Y, LENS_CENTER_Z);
    group.add(rim);

    const lens = buildLens(shapeFn, width, height);
    lens.position.set(side * LENS_CENTER_X, LENS_CENTER_Y, LENS_CENTER_Z);
    group.add(lens);

    group.add(buildTemple(side, frameColor, metalness, roughness));
  });

  group.add(buildBridge(frameColor, metalness, roughness));
  group.add(buildNosePads(style === 'aviator' ? 0xC9A24B : 0x3a332c));

  group.userData.style = style;
  return group;
}

export const GLASSES_STYLES = Object.keys(STYLE_PRESETS);
