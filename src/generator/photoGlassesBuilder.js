import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  boundsOf,
  canonicalAperture,
  centroidOf,
  ensureCCW,
  measureSpec,
  resampleClosed,
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

// Shape fitting runs at 256 points for accuracy, but the *mesh* does not need
// that: creased normals de-index the geometry, so every extra outline point
// costs three vertices on each surrounding surface. These are the resolutions
// the model is actually built at — well past the point where more is visible,
// and small enough that the exported GLB stays quick to store and load.
const OUTER_SEGMENTS = 160;
const APERTURE_SEGMENTS = 120;
const LENS_SEGMENTS = 96;
const LENS_RINGS = 7;
const TEMPLE_STEPS = 56;

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

/**
 * Bend a geometry back around the face (a cylindrical face-form).
 *
 * Done as a real bend, not `z -= k*x^2`: that shears the slab, leaving its
 * side walls still pointing straight back while the surface curves away, so
 * the frame's outer edges face the wrong direction. Here each vertex is
 * re-seated on the curved mid-surface along that surface's own normal, so the
 * cross-section rotates with the curve as a moulded front's does.
 */
function applyWrap(geometry, k) {
  if (!k) return geometry;
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // Mid-surface z = -k*x^2; its unit normal is (2kx, 0, 1)/|.|.
    const inv = 1 / Math.hypot(2 * k * x, 1);
    pos.setX(i, x + z * 2 * k * x * inv);
    pos.setZ(i, -k * x * x + z * inv);
  }
  pos.needsUpdate = true;
  return geometry;
}

/**
 * Smooth shading that keeps designed edges crisp.
 *
 * ExtrudeGeometry is non-indexed, so a plain computeVertexNormals() gives one
 * normal per triangle — which renders the rounded rim as visible facets.
 * Creased normals average across gentle joins (the bevel) while leaving the
 * sharp front-to-side transition hard, which is exactly how polished acetate
 * catches light.
 */
function smoothed(geometry, creaseDegrees = 50) {
  return toCreasedNormals(geometry, (creaseDegrees * Math.PI) / 180);
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

  // three's bevel profile is a quarter-circle, so enough segments turn the
  // slab's edge into the rounded, pillowed cross-section milled acetate has.
  const bevel = Math.min(depth * 0.38, spec.rim * 0.45);
  const beveled = bevel > 0.004;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: beveled ? depth - bevel * 2 : depth,
    bevelEnabled: beveled,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 4,
    curveSegments: 1,
  });
  if (beveled) geometry.translate(0, 0, bevel);
  applyWrap(geometry, params.wrapK);

  const mesh = new THREE.Mesh(smoothed(geometry), material);
  mesh.name = 'front';
  return mesh;
}

/**
 * A lens as a real optical surface: a spherical cap cut to the aperture
 * outline, tessellated as concentric rings so the curve is smooth all the way
 * across. A flat polygon reads as a sheet of glass dropped into the hole; the
 * base curve is what makes it catch light like a lens.
 *
 * The geometry is built with its apex at z = 0 and its edges falling away
 * behind it, centred on the aperture's own centre.
 */
function buildLensGeometry(outline, baseRadius, rings = LENS_RINGS) {
  const ring = resampleClosed(ensureCCW(outline), LENS_SEGMENTS);
  const n = ring.length;
  const b = boundsOf(ring);
  const sag = (r) => baseRadius - Math.sqrt(Math.max(baseRadius * baseRadius - r * r, 0));

  const positions = [0, 0, 0];
  const uvs = [0.5, (0 - b.minY) / Math.max(b.height, 1e-6)];
  const indices = [];
  let maxSag = 0;

  for (let j = 1; j <= rings; j++) {
    const t = j / rings;
    for (let i = 0; i < n; i++) {
      const x = ring[i].x * t;
      const y = ring[i].y * t;
      const s = sag(Math.hypot(x, y));
      if (s > maxSag) maxSag = s;
      positions.push(x, y, -s);
      uvs.push(0.5, (y - b.minY) / Math.max(b.height, 1e-6));
    }
  }

  for (let i = 0; i < n; i++) indices.push(0, 1 + i, 1 + ((i + 1) % n));
  for (let j = 1; j < rings; j++) {
    const inner = 1 + (j - 1) * n;
    const outer = 1 + j * n;
    for (let i = 0; i < n; i++) {
      const i2 = (i + 1) % n;
      indices.push(inner + i, outer + i, outer + i2, inner + i, outer + i2, inner + i2);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals(); // indexed, so this smooths across the cap
  geometry.userData.maxSag = maxSag;
  return geometry;
}

function buildLenses(spec, curves, depth, params, material) {
  const meshes = [];
  // Seat the lens slightly proud of the aperture so it tucks under the rim
  // lip rather than floating in the hole.
  const seated = offsetRing(curves.aperture, 0.035);
  // Base curve: flatter on a big lens, so the cap never bulges out past the
  // front's own thickness. Roughly a base-4 to base-6 curve, as most frames use.
  const baseRadius = Math.max(12, spec.lensWidth * 2.4);

  for (const side of [-1, 1]) {
    const mirrored = seated.map((p) => ({ x: side * p.x, y: p.y }));
    const geometry = buildLensGeometry(mirrored, baseRadius);
    const { maxSag } = geometry.userData;

    const cx = side * spec.lensCenterX;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'lens';
    mesh.renderOrder = 2;
    // Sit the apex forward enough that the edges stay inside the front slab.
    const apexZ = Math.min(depth * 0.92, maxSag + depth * 0.12);
    mesh.position.set(cx, spec.lensCenterY, apexZ - params.wrapK * cx * cx);
    // Tilted to the face-form slope at its own centre.
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
  // Arms do not run straight back: they flare out to clear the head, and how
  // much is measured from the top view. Without it the reconstruction's arms
  // sit visibly inboard of the real ones along their whole length.
  // Arms flare only a few degrees to clear the head. Allowing more lets a
  // misread top view throw them outward for the whole arm's length, which on
  // a 145mm temple adds 5cm per side to the frame's width.
  const flare = Math.tan(Math.min(Math.max(spec.templeSplay ?? 0.03, -0.02), 0.1));
  const path = new THREE.CatmullRomCurve3(
    [
      [0, 0, 0],
      [0.02, -0.02, -L * bend * 0.3],
      [0.04, -0.07, -L * bend * 0.62],
      [0.05, -0.14, -L * bend * 0.88],
      [0.04, -0.3, -L * hook(0.3)],
      [0.02, -0.72, -L * hook(0.62)],
      [-0.02, -1.25, -L * hook(0.87)],
      [-0.08, -1.8, -L * 0.995],
    ].map(([x, y, z]) => new THREE.Vector3(side * (x + flare * -z), y, z))
  );

  // Mirroring by path rather than by a negative scale: scale.x = -1 inverts
  // the winding order and the lighting with it. Reversing the cross-section
  // ring on the mirrored side keeps the triangles facing outward.
  const section = side < 0 ? templeSection().reverse() : templeSection();
  const steps = TEMPLE_STEPS;
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

  // Cap both ends. A swept tube is open at its ends, which leaves a hole
  // looking straight into the arm at the hinge and at the ear tip.
  const ringSize = section.length;
  for (const [ringStart, flip] of [[0, true], [steps * ringSize, false]]) {
    const centre = positions.length / 3;
    let cxp = 0;
    let cyp = 0;
    let czp = 0;
    for (let k = 0; k < ringSize; k++) {
      cxp += positions[(ringStart + k) * 3];
      cyp += positions[(ringStart + k) * 3 + 1];
      czp += positions[(ringStart + k) * 3 + 2];
    }
    positions.push(cxp / ringSize, cyp / ringSize, czp / ringSize);
    for (let k = 0; k < ringSize; k++) {
      const k2 = (k + 1) % ringSize;
      if (flip) indices.push(centre, ringStart + k2, ringStart + k);
      else indices.push(centre, ringStart + k, ringStart + k2);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  // The swept cross-section is a rounded superellipse, so it is smooth all the
  // way round and wants smoothing all the way round — at a tighter crease
  // angle its own facets split into alternating hard and soft edges, which
  // shows as a fine serration running the length of the arm. 60 degrees keeps
  // the sweep smooth while still creasing the flat end caps.
  const mesh = new THREE.Mesh(smoothed(geometry, 60), material);
  mesh.name = side < 0 ? 'temple-left' : 'temple-right';
  mesh.position.copy(hinge);
  return mesh;
}

/**
 * The endpiece at the temple joint: the small block the front carries out to
 * meet the arm. In any three-quarter view this junction is right where the eye
 * lands, and without it the arm reads as butted against the frame. On an
 * acetate frame the hinge itself is sunk inside that block and never visible
 * from outside, so it is not modelled.
 */
function buildHinge(side, spec, depth, at, material) {
  const group = new THREE.Group();
  group.name = 'hinge';

  const block = new THREE.Mesh(
    new RoundedBoxLike(spec.rim * 1.15, spec.templeHeight * 0.9, depth * 0.85),
    material
  );
  block.position.copy(at);
  group.add(block);

  return group;
}

/** A box with softened edges, so the endpiece matches the moulded front. */
function RoundedBoxLike(w, h, d) {
  const shape = new THREE.Shape();
  const r = Math.min(w, h) * 0.3;
  shape.moveTo(-w / 2 + r, -h / 2);
  shape.lineTo(w / 2 - r, -h / 2);
  shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  shape.lineTo(w / 2, h / 2 - r);
  shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  shape.lineTo(-w / 2 + r, h / 2);
  shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  shape.lineTo(-w / 2, -h / 2 + r);
  shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  const bevel = d * 0.18;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: d - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 6,
  });
  geometry.translate(0, 0, -d / 2 + bevel);
  return smoothed(geometry, 50);
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
  // Wide enough to cover everything from a deep shield to a slim rimless pair.
  // The earlier lower bound rejected legitimately tall frames, and the point
  // of this gate is to catch a photo that is not glasses at all, not to
  // second-guess a frame's proportions.
  const aspect = spec.totalWidth / Math.max(spec.totalHeight, 1e-6);
  spec.aspect = aspect;
  if (aspect < 1.15 || aspect > 8) throw new Error('not-glasses-shaped');
  if (spec.lensWidth < 2.5 || spec.lensWidth > 8.5) throw new Error('implausible-lens-size');
  if (spec.bridgeGap > spec.lensWidth) throw new Error('implausible-bridge');
}

export function buildGlassesModel({ front, side = null, top = null, params: userParams = {} }) {
  const params = { ...DEFAULT_PARAMS, ...userParams };

  // ---- Photo pixels -> centimetres, origin at the frame's centre.
  // Scale from the *front's* width, with the arms trimmed off: that is the
  // measurement printed on a frame and the one the user takes with a ruler.
  const frameWidthPx = front.frontWidthPx ?? front.frame.maxX - front.frame.minX + 1;
  const s = params.frameWidthMM / 10 / frameWidthPx;
  const ax = front.frontMinX != null
    ? front.frontMinX + frameWidthPx / 2
    : (front.frame.minX + front.frame.maxX) / 2;
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

  // Prefer the rim measured against the silhouette over the one inferred from
  // the outer bounds; the inferred one is only a fallback for a photo whose
  // apertures could not be outlined.
  if (front.rimPx) {
    if (front.rimPx.side) spec.rim = front.rimPx.side * s;
    if (front.rimPx.top) spec.rimTop = front.rimPx.top * s;
    if (front.rimPx.bottom) spec.rimBottom = front.rimPx.bottom * s;
  }
  validate(front, spec);

  // Measure at full resolution, build at mesh resolution.
  const meshOuter = resampleClosed(outer, OUTER_SEGMENTS);
  const meshAperture = resampleClosed(aperture, APERTURE_SEGMENTS);

  // ---- What the top view measures directly, instead of it being guessed.
  // Front-to-back thickness, the face-form curve and the arm's reach are all
  // invisible head-on; without this view they came from a rule of thumb on the
  // rim's width, so a frame could match its photo exactly and still be the
  // wrong shape as soon as it was turned.
  let measuredDepth = null;
  let measuredLength = null;
  if (top && (top.frontWidthPx ?? top.widthPx) > 0) {
    // Scale by the front's span in this view, not the object's: the arms
    // usually splay wider than the front, and the width the user entered is
    // the front's.
    const s2 = params.frameWidthMM / 10 / (top.frontWidthPx ?? top.widthPx);
    measuredDepth = top.frontDepthPx * s2;
    measuredLength = Math.max(top.totalDepthPx - top.frontDepthPx, 1) * s2;

    // Sanity-check against what a frame can physically be. On a strongly
    // wrapped pair the front's ends curve back nearly as far as the arms
    // reach, so "front" and "arm" stop being separable by depth alone and the
    // arm can measure a few millimetres long. An arm is never shorter than
    // roughly half the frame's width, and a front is never a third of the
    // whole depth — outside that, the entered value is the better guess.
    const widthCM = params.frameWidthMM / 10;
    if (measuredLength < widthCM * 0.35 || measuredLength > widthCM * 2.2) {
      measuredLength = null;
    }
    if (measuredDepth > (top.totalDepthPx * s2) / 3 || measuredDepth < 0.1) {
      measuredDepth = null;
    }
    // y = k_px * x_px^2 in pixels becomes y_cm = (k_px / s2) * x_cm^2.
    params.wrapK = Math.min(Math.max(top.wrapKPx / s2, 0), 0.05);
    if (Number.isFinite(top.splayRad)) spec.templeSplay = top.splayRad;
  }

  // ---- Parts of the spec that come from the side photo or sensible defaults.
  const lengthCM = measuredLength ?? params.templeLengthMM / 10;
  let profile = null;
  if (side && side.stations) {
    // Whole-frame side view: the arm has already been separated from the front
    // by its profile, so its taper, bend and height come straight out, and the
    // front's lean comes with them.
    profile = { stations: side.stations, bendAt: side.bendAt };
    const sideScale = lengthCM / Math.max(side.armLengthPx, 1);
    spec.templeHeight = Math.min(Math.max(side.armBaseHeightPx * sideScale, 0.35), 2.4);
    if (Number.isFinite(side.pantoscopic)) {
      params.pantoscopic = Math.min(Math.max(side.pantoscopic, -0.02), 0.22);
    }
    // The side view also sees the front's thickness; use it when there is no
    // top view to measure it more directly.
    if (measuredDepth == null && side.frontDepthPx > 0) {
      measuredDepth = side.frontDepthPx * sideScale;
    }
  } else {
    spec.templeHeight = Math.min(Math.max(spec.rimTop * 1.5, 0.5), 1.6);
  }
  spec.templeThickness = Math.min(Math.max(spec.rim * 0.75, 0.16), 0.7);

  const depth =
    params.depthCM ?? measuredDepth ?? Math.min(Math.max(spec.rim * 0.9, 0.18), 0.85);
  const lensOpacity = params.lensOpacity ?? suggestLensOpacity(front);
  spec.depth = depth;
  spec.templeLength = lengthCM;
  spec.measuredFromTop = !!top;

  // ---- Build.
  const materials = buildMaterials(front, spec, lensOpacity);
  const group = new THREE.Group();
  group.name = 'photo-glasses';

  const frontPivot = new THREE.Group();
  frontPivot.name = 'front-pivot';
  frontPivot.rotation.x = params.pantoscopic;

  const curves = { outer: meshOuter, aperture: meshAperture };
  frontPivot.add(buildFront(spec, curves, depth, params, materials.frame));
  for (const lens of buildLenses(spec, curves, depth, params, materials.lens)) {
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

  // The temples are NOT part of the front's pivot: the pantoscopic angle is
  // precisely the angle between the front and the arms, so tilting both would
  // cancel it out. The hinge assembly lives in temple space and overlaps the
  // front slightly, which closes the seam that small angle opens.
  for (const side_ of [-1, 1]) {
    const root = new THREE.Vector3(
      side_ * (halfWidth - spec.rim * 0.3),
      lugY,
      hingeZ - depth * 0.35
    );
    group.add(buildHinge(side_, spec, depth, root, materials.frame));
    group.add(
      buildTemple({
        side: side_,
        spec,
        profile,
        lengthCM,
        hinge: root,
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
