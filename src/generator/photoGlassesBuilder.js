import * as THREE from 'three';
import {
  boundsOf,
  canonicalAperture,
  centroidOf,
  ensureCCW,
  measureSpec,
  measureTempleProfile,
  smoothRing,
  symmetrizeAboutAxis,
} from './shapeFit.js';

/**
 * Building a frame from a measured spec.
 *
 * The photo is used for two things only: the *shape* of the frame (via
 * shapeFit.js, which cleans and symmetrizes the traced outlines into a
 * manufacturable spec) and the *colours* of its parts. It is never used as a
 * texture. Projecting the photograph onto the model is what makes a
 * reconstruction look like a picture of glasses stuck to a board rather than
 * a pair of glasses, and it fails completely the moment the frame is seen
 * from any angle other than the one it was shot from.
 *
 * Everything below is real geometry: a moulded front with the apertures cut
 * through it, lenses seated under the rim lip, hinge rivets, and temples
 * swept along a 3D path with the taper measured off the side photo.
 *
 * The model is authored in centimetres with its origin at the front's optical
 * centre, matching the metric face space in glasses/faceAnchors.js.
 */

export const DEFAULT_PARAMS = {
  frameWidthMM: 140,
  templeLengthMM: 145,
  depthCM: null, // null = derive from the measured rim thickness
  lensOpacity: null, // null = derive from the measured lens tint
  wrapK: 0.008, // face-form: how much the front curves back around the face
  pantoscopic: 0.05, // forward tilt of the front, in radians
};

// A frame this thin in the rim is a wire frame, not moulded acetate.
const METAL_RIM_CM = 0.28;

function rgbColor([r, g, b]) {
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
}

function luminance([r, g, b]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Opacity implied by how dark the lens photographed: a near-black sunglass
 * lens is nearly opaque, a clear prescription lens barely tints at all.
 */
export function suggestLensOpacity(front) {
  if (front.lensSource === 'holes') return 0.16; // saw the backdrop through it
  if (!front.lensTint) return 0.55;
  const l = luminance(front.lensTint);
  return Math.min(0.92, Math.max(0.2, 1 - l * 0.85));
}

/**
 * A lens tint as a vertical gradient, generated from the measured colour —
 * denser at the brow, lighter at the bottom, as real tinted lenses are.
 * Synthesised, not sampled: no part of the photo ends up on the model.
 */
function lensGradient(color) {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const top = color.clone().multiplyScalar(0.78);
  const bottom = color.clone().multiplyScalar(1.18);
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0, `#${top.getHexString()}`);
  g.addColorStop(1, `#${bottom.getHexString()}`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Points -> THREE.Vector2 ring with the winding three expects. */
function toVec2(points, clockwise = false) {
  const ring = ensureCCW(points);
  const ordered = clockwise ? ring.slice().reverse() : ring;
  return ordered.map((p) => new THREE.Vector2(p.x, p.y));
}

/** Offset a ring inward/outward along its own normals (positive = outward). */
function offsetRing(points, distance) {
  const n = points.length;
  const c = centroidOf(points);
  return points.map((p, i) => {
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    // Outward normal of the local edge direction.
    let nx = next.y - prev.y;
    let ny = -(next.x - prev.x);
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    // Point the normal away from the centroid.
    if ((p.x - c.x) * nx + (p.y - c.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { x: p.x + nx * distance, y: p.y + ny * distance };
  });
}

/** Bend a geometry back around the face: z -= k*x^2 (a cylindrical face-form). */
function applyWrap(geometry, k) {
  if (!k) return geometry;
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    pos.setZ(i, pos.getZ(i) - k * x * x);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

// ------------------------------------------------------------------ materials

function buildMaterials(front, spec, lensOpacity) {
  const frameColor = rgbColor(front.rimColor ?? [40, 40, 46]);
  const isMetal = spec.rim < METAL_RIM_CM;

  const frame = new THREE.MeshPhysicalMaterial({
    color: frameColor,
    // A wire frame is metal; a moulded rim is polished plastic with a
    // clearcoat, which is what gives acetate its wet-looking highlight.
    metalness: isMetal ? 0.92 : 0.0,
    roughness: isMetal ? 0.3 : 0.34,
    // Enough clearcoat to read as polished acetate, not so much that the
    // studio environment blows the measured colour out to a pale highlight.
    clearcoat: isMetal ? 0.0 : 0.55,
    clearcoatRoughness: 0.14,
    envMapIntensity: 0.6,
  });

  const hardware = new THREE.MeshPhysicalMaterial({
    color: frameColor.clone().lerp(new THREE.Color(0xc9b98a), 0.65),
    metalness: 1.0,
    roughness: 0.3,
  });

  const tint = rgbColor(front.lensTint ?? [70, 74, 84]);
  const lens = new THREE.MeshPhysicalMaterial({
    map: lensGradient(tint),
    color: 0xffffff,
    transparent: true,
    opacity: lensOpacity,
    roughness: 0.12,
    metalness: 0,
    ior: 1.52,
    // Kept low so a dark lens stays dark instead of picking up the studio
    // environment and washing out to grey.
    envMapIntensity: 0.35,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  return { frame, hardware, lens, isMetal };
}

// ------------------------------------------------------------------ the front

function buildFront(spec, curves, depth, params, material) {
  const shape = new THREE.Shape(toVec2(curves.outer));
  for (const side of [-1, 1]) {
    const placed = curves.aperture.map((p) => ({
      x: side * p.x + side * spec.lensCenterX,
      y: p.y + spec.lensCenterY,
    }));
    shape.holes.push(new THREE.Path(toVec2(placed, true)));
  }

  const bevel = Math.min(depth * 0.34, spec.rim * 0.42);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: depth - bevel * 2,
    bevelEnabled: bevel > 0.004,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 1,
  });
  geometry.translate(0, 0, bevel);
  applyWrap(geometry, params.wrapK);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'front';
  return mesh;
}

function buildLenses(spec, curves, depth, params, material) {
  const meshes = [];
  // Seat the lens slightly *under* the rim lip, as a lens sits in its groove.
  const seated = offsetRing(curves.aperture, 0.035);
  for (const side of [-1, 1]) {
    const mirrored = seated.map((p) => ({ x: side * p.x, y: p.y }));
    const geometry = new THREE.ShapeGeometry(new THREE.Shape(toVec2(mirrored)));

    // Remap v across the aperture so the gradient runs top-to-bottom once.
    const b = boundsOf(curves.aperture);
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setY(i, (uv.getY(i) - b.minY) / Math.max(b.height, 1e-6));
    }
    uv.needsUpdate = true;

    const cx = side * spec.lensCenterX;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'lens';
    mesh.renderOrder = 2;
    // Planar and tilted to the face-form slope at its own centre. Bending the
    // outline-only triangulation instead would show as facets across the glass.
    mesh.position.set(cx, spec.lensCenterY, depth * 0.42 - params.wrapK * cx * cx);
    mesh.rotation.y = Math.atan(2 * params.wrapK * cx);
    meshes.push(mesh);
  }
  return meshes;
}

// ------------------------------------------------------------------ temples

/** Rounded-rectangle cross-section, as a ring of unit offsets (u, v). */
function templeSection(segments = 14) {
  // Superellipse with exponent 4: a rectangle with softened corners, which is
  // the cross-section an acetate arm is milled to. Exponent 2 would be an
  // ellipse (too round, reads as wire); higher would be a hard rectangle.
  const k = 4;
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push([Math.sign(c) * Math.abs(c) ** (2 / k), Math.sign(s) * Math.abs(s) ** (2 / k)]);
  }
  return pts;
}

/**
 * A temple arm, swept along a 3D path: back along the head, over the ear,
 * then hooked down behind it. The height taper comes from the side photo,
 * measured at stations along the arm rather than traced as a silhouette — a
 * nick in a traced outline becomes a spike in the mesh, where a measured
 * profile just moves one station slightly.
 */
function buildTemple({ side, spec, profile, lengthCM, hinge, material }) {
  const L = lengthCM;
  const bend = profile?.bendAt ?? 0.74;

  // Straight run back along the head, then a hook whose curvature builds
  // gradually. Too few control points through the bend and Catmull-Rom puts a
  // visible kink where a real arm has a smooth curve over the ear.
  const hook = (f) => bend + (1 - bend) * f;
  const path = new THREE.CatmullRomCurve3(
    [
      [0, 0, 0],
      [0.08, -0.02, -L * bend * 0.3],
      [0.14, -0.07, -L * bend * 0.62],
      [0.15, -0.14, -L * bend * 0.88],
      [0.14, -0.3, -L * hook(0.3)],
      [0.1, -0.72, -L * hook(0.62)],
      [0.02, -1.25, -L * hook(0.87)],
      [-0.08, -1.8, -L * 0.995],
    ].map(([x, y, z]) => new THREE.Vector3(side * x, y, z))
  );

  // Mirroring by path rather than by a negative scale: scale.x = -1 inverts
  // the winding order and the lighting with it. Reversing the cross-section
  // ring on the mirrored side keeps the triangles facing outward.
  const section = side < 0 ? templeSection().reverse() : templeSection();
  const steps = 72;
  const positions = [];
  const indices = [];
  const up = new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  const point = new THREE.Vector3();

  const heightAt = (t) => {
    if (!profile?.stations?.length) return THREE.MathUtils.lerp(1, 0.55, t ** 0.8);
    const f = t * (profile.stations.length - 1);
    const i = Math.min(Math.floor(f), profile.stations.length - 2);
    return THREE.MathUtils.lerp(profile.stations[i], profile.stations[i + 1], f - i);
  };

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    path.getPointAt(t, point);
    path.getTangentAt(t, tangent);
    normal.crossVectors(up, tangent).normalize();
    binormal.crossVectors(tangent, normal).normalize();

    const h = (spec.templeHeight * heightAt(t)) / 2;
    const w = (spec.templeThickness * THREE.MathUtils.lerp(1, 0.78, t)) / 2;

    for (const [u, v] of section) {
      positions.push(
        point.x + normal.x * w * u + binormal.x * h * v,
        point.y + normal.y * w * u + binormal.y * h * v,
        point.z + normal.z * w * u + binormal.z * h * v
      );
    }
    if (i < steps) {
      const a = i * section.length;
      const b = (i + 1) * section.length;
      for (let k = 0; k < section.length; k++) {
        const k2 = (k + 1) % section.length;
        indices.push(a + k, b + k, b + k2, a + k, b + k2, a + k2);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = side < 0 ? 'temple-left' : 'temple-right';
  mesh.position.copy(hinge);
  return mesh;
}

/** Small metal rivet on the outer face of the front, at the hinge line. */
function buildRivet(position, material) {
  const geometry = new THREE.CylinderGeometry(0.085, 0.085, 0.08, 16);
  geometry.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'rivet';
  mesh.position.copy(position);
  return mesh;
}

/** Nose pads — present on wire frames, moulded into the arch on acetate ones. */
function buildNosePad(side, spec, material) {
  const geometry = new THREE.SphereGeometry(0.16, 12, 10);
  geometry.scale(0.55, 1.25, 0.5);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'nose-pad';
  mesh.position.set(
    side * (spec.bridgeGap * 0.32),
    spec.lensCenterY - spec.lensHeight * 0.2,
    -0.22
  );
  mesh.rotation.z = side * 0.28;
  return mesh;
}

// ------------------------------------------------------------------ assembly

/** Everything the reconstruction refuses to guess at. */
function validate(front, spec) {
  if (front.apertures.length < 2) {
    throw new Error('need-two-lenses');
  }
  const aspect = spec.totalWidth / Math.max(spec.totalHeight, 1e-6);
  if (aspect < 1.6 || aspect > 6.5) throw new Error('not-glasses-shaped');
  if (spec.lensWidth < 2.5 || spec.lensWidth > 8.5) throw new Error('implausible-lens-size');
  if (spec.bridgeGap > spec.lensWidth) throw new Error('implausible-bridge');
}

export function buildGlassesModel({ front, side = null, params: userParams = {} }) {
  const params = { ...DEFAULT_PARAMS, ...userParams };

  // ---- Photo pixels -> centimetres, origin at the frame's centre.
  const frameWidthPx = front.frame.maxX - front.frame.minX + 1;
  const s = params.frameWidthMM / 10 / frameWidthPx;
  const ax = (front.frame.minX + front.frame.maxX) / 2;
  const ay = (front.frame.minY + front.frame.maxY) / 2;
  const toCm = (contour) => contour.map(([px, py]) => ({ x: (px - ax) * s, y: (ay - py) * s }));

  // ---- Clean the traced outlines into a manufacturable shape.
  const outer = smoothRing(symmetrizeAboutAxis(toCm(front.outerContour), 0, 256), 3, 0.5);

  const apertureRings = front.apertures.map(toCm);
  const centres = apertureRings.map(centroidOf);
  const order = centres[0].x <= (centres[1]?.x ?? Infinity) ? [0, 1] : [1, 0];
  const leftRing = apertureRings[order[0]];
  const rightRing = apertureRings[order[1]];

  const aperture = canonicalAperture(leftRing, rightRing, 256, 10);
  const lensCenterX =
    centres.length > 1
      ? (Math.abs(centres[0].x) + Math.abs(centres[1].x)) / 2
      : Math.abs(centres[0].x);
  const lensCenterY =
    centres.reduce((acc, c) => acc + c.y, 0) / centres.length;

  const spec = measureSpec(aperture, outer, lensCenterX, lensCenterY);
  validate(front, spec);

  // ---- Parts of the spec that come from the side photo or sensible defaults.
  const lengthCM = params.templeLengthMM / 10;
  let profile = null;
  if (side) {
    profile = measureTempleProfile(side.mask, side.width, side.height, side.comp);
    const sideScale = lengthCM / profile.lengthPx;
    // Height measured *at the hinge station*. The side photo's overall bounding
    // box is much taller than the arm, because it includes the ear hook's drop.
    spec.templeHeight = Math.min(Math.max(profile.baseHeightPx * sideScale, 0.35), 2.4);
  } else {
    spec.templeHeight = Math.min(Math.max(spec.rimTop * 1.5, 0.5), 1.6);
  }
  spec.templeThickness = Math.min(Math.max(spec.rim * 0.75, 0.16), 0.7);

  const depth = params.depthCM ?? Math.min(Math.max(spec.rim * 0.9, 0.18), 0.85);
  const lensOpacity = params.lensOpacity ?? suggestLensOpacity(front);
  spec.depth = depth;

  // ---- Build.
  const materials = buildMaterials(front, spec, lensOpacity);
  const group = new THREE.Group();
  group.name = 'photo-glasses';

  const frontPivot = new THREE.Group();
  frontPivot.name = 'front-pivot';
  frontPivot.rotation.x = params.pantoscopic;

  frontPivot.add(buildFront(spec, { outer, aperture }, depth, params, materials.frame));
  for (const lens of buildLenses(spec, { outer, aperture }, depth, params, materials.lens)) {
    frontPivot.add(lens);
  }

  const halfWidth = spec.totalWidth / 2;
  const lugY = front.lugY != null ? (ay - front.lugY) * s : spec.lensCenterY + spec.lensHeight * 0.3;
  const hingeX = halfWidth - spec.rim * 0.45;
  const hingeZ = depth * 0.5 - params.wrapK * hingeX * hingeX;

  for (const side_ of [-1, 1]) {
    frontPivot.add(
      buildRivet(new THREE.Vector3(side_ * hingeX, lugY, hingeZ + 0.02), materials.hardware)
    );
    if (materials.isMetal) frontPivot.add(buildNosePad(side_, spec, materials.hardware));
  }
  group.add(frontPivot);

  for (const side_ of [-1, 1]) {
    group.add(
      buildTemple({
        side: side_,
        spec,
        profile,
        lengthCM,
        hinge: new THREE.Vector3(side_ * (halfWidth - spec.rim * 0.3), lugY, hingeZ - depth * 0.35),
        material: materials.frame,
      })
    );
  }

  return { group, lensMaterial: materials.lens, spec };
}

/**
 * Dispose everything a built model allocated. Geometry and materials are
 * deliberately shared (both temples, one lens material for both eyes), so
 * each resource is disposed exactly once.
 */
export function disposeModel(group) {
  const seen = new Set();
  const once = (resource) => {
    if (!resource || seen.has(resource)) return false;
    seen.add(resource);
    return true;
  };
  group.traverse((obj) => {
    if (once(obj.geometry)) obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const m of mats) {
      if (!once(m)) continue;
      if (once(m.map)) m.map.dispose();
      m.dispose();
    }
  });
}
