import * as THREE from 'three';
import { roundedRectShape, insetShape } from './shapes.js';
import { EAR_TOP, TRAGION } from './faceAnchors.js';

/**
 * Parametric builder for thick acetate (plastic) frames — the chunky
 * oversized-square style, as opposed to the thin wire frames that
 * createGlasses.js covers. Everything is driven by the real optical
 * measurements a frame is actually specified by (lens width x lens height,
 * bridge/DBL, temple length), all in centimetres in the same metric face
 * space as faceAnchors.js, so a built frame drops straight onto the face
 * anchor at true scale.
 *
 * This is the shape of the phase-3 "parametric template": a real product is
 * reproduced by measuring it into a spec, not by hand-modelling it.
 */

const DEFAULT_SPEC = {
  // Measured off the reference product photography (front view, scaled by a
  // 52mm lens width): frame 138mm wide x 52mm tall, apertures 52 x 40.5.
  lensWidth: 5.2, // horizontal lens aperture (the "52" in 52-18-145)
  lensHeight: 4.05, // vertical aperture
  bridgeGap: 1.82, // DBL: gap between the two apertures
  rim: 0.78, // acetate rim at the sides of each aperture
  rimTop: 0.65, // brow rim
  rimBottom: 0.52, // rim below the aperture
  depth: 0.72, // front-to-back thickness of the acetate
  cornerRadius: 0.62, // aperture corners: crisp, only lightly softened
  outerRadius: 0.6, // outer silhouette corner rounding
  archHeight: 0.85, // how far the nose arch rises from the bottom edge
  pantoscopic: 0.06, // forward tilt of the whole front (radians)
  templeHeight: 1.7, // temple arm height at the hinge — chunky acetate
  templeHeightEnd: 0.85, // ...tapering to this at the ear
  templeThickness: 0.6,
  frameColor: 0x0b0b0d,
  frameRoughness: 0.16, // high-gloss polished acetate
  lensTop: 0x15151a, // gradient lens: near-black at the brow...
  lensBottom: 0x43434e, // ...fading only to a dark charcoal, never clear
  lensOpacity: 0.88, // sunglass-dark; eyes still read faintly through it
  hardwareColor: 0xc8a75a, // rivets and the sculpted temple initial
  wordmark: 'Dior', // brand name printed on the temple
};

/** Gradient lens tint, generated as a 1-D texture (dark top -> light bottom). */
function makeGradientTexture(topColor, bottomColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, `#${new THREE.Color(topColor).getHexString()}`);
  gradient.addColorStop(1, `#${new THREE.Color(bottomColor).getHexString()}`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Geometry of the front, derived once from the optical spec. */
function frontMetrics(spec) {
  const lensCenterX = spec.bridgeGap / 2 + spec.lensWidth / 2;
  return {
    lensCenterX,
    halfWidth: lensCenterX + spec.lensWidth / 2 + spec.rim,
    top: spec.lensHeight / 2 + spec.rimTop,
    bottom: -(spec.lensHeight / 2 + spec.rimBottom),
  };
}

/** The aperture (lens hole) outline for one side, in front-local space. */
function apertureShape(spec) {
  return roundedRectShape(spec.lensWidth, spec.lensHeight, spec.cornerRadius);
}

/**
 * The front, as a real acetate frame is made: ONE continuous slab of plastic
 * with two lens apertures cut through it and a nose arch cut up from the
 * bottom edge — not two rings plus a separate bridge part. This is what gives
 * a chunky acetate frame its uninterrupted moulded silhouette.
 */
function buildFront(spec, material) {
  const m = frontMetrics(spec);
  const r = spec.outerRadius;
  const archR = spec.bridgeGap * 0.62;
  const archTop = m.bottom + spec.archHeight;

  const s = new THREE.Shape();
  // Bottom edge, left half -> up over the nose arch -> bottom edge, right half
  s.moveTo(-m.halfWidth + r, m.bottom);
  s.lineTo(-archR, m.bottom);
  s.bezierCurveTo(-archR, archTop - archR * 0.4, -archR * 0.55, archTop, 0, archTop);
  s.bezierCurveTo(archR * 0.55, archTop, archR, archTop - archR * 0.4, archR, m.bottom);
  s.lineTo(m.halfWidth - r, m.bottom);
  // Right edge
  s.quadraticCurveTo(m.halfWidth, m.bottom, m.halfWidth, m.bottom + r);
  s.lineTo(m.halfWidth, m.top - r);
  s.quadraticCurveTo(m.halfWidth, m.top, m.halfWidth - r, m.top);
  // Top edge
  s.lineTo(-m.halfWidth + r, m.top);
  // Left edge
  s.quadraticCurveTo(-m.halfWidth, m.top, -m.halfWidth, m.top - r);
  s.lineTo(-m.halfWidth, m.bottom + r);
  s.quadraticCurveTo(-m.halfWidth, m.bottom, -m.halfWidth + r, m.bottom);

  // Two lens apertures punched through.
  for (const side of [-1, 1]) {
    const pts = apertureShape(spec)
      .getPoints(64)
      .map((p) => new THREE.Vector2(p.x + side * m.lensCenterX, p.y));
    s.holes.push(new THREE.Path(pts));
  }

  const geometry = new THREE.ExtrudeGeometry(s, {
    depth: spec.depth,
    bevelEnabled: true,
    bevelThickness: 0.07,
    bevelSize: 0.07,
    bevelSegments: 3,
    curveSegments: 32,
  });
  geometry.translate(0, 0, -spec.depth / 2);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

function buildLens(spec, material, side) {
  const m = frontMetrics(spec);
  const shape = insetShape(apertureShape(spec), -0.05); // seat under the rim lip
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.14,
    bevelEnabled: false,
    curveSegments: 32,
  });

  // ExtrudeGeometry emits UVs in *shape* coordinates (centimetres here), not
  // normalised 0..1, so a gradient map would clamp to flat bands outside the
  // 0..1 window. Remap v across the aperture height so the tint runs top to
  // bottom exactly once.
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setY(i, (uv.getY(i) + spec.lensHeight / 2) / spec.lensHeight);
  }
  uv.needsUpdate = true;

  geometry.translate(side * m.lensCenterX, 0, -0.07);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

/**
 * A thick acetate temple: a tapering rectangular arm that runs back along the
 * head, rides over the ear, and turns down behind it. Built as a swept
 * rectangular cross-section so it reads as solid acetate rather than a wire.
 */
function templePath(side, hingeX, hingeY, hingeZ) {
  return new THREE.CatmullRomCurve3(
    [
      [hingeX, hingeY, hingeZ],
      [hingeX + 0.12, hingeY - 0.05, hingeZ - 2.2],
      [TEMPLE_BACK_X, hingeY - 0.35, -0.4],
      [EAR_TOP[0] - 0.3, EAR_TOP[1] - 0.35, EAR_TOP[2] + 0.15],
      [TRAGION[0] - 0.45, TRAGION[1] - 0.15, TRAGION[2] - 0.25],
    ].map(([x, y, z]) => new THREE.Vector3(side * x, y, z))
  );
}

/** Outward-facing frame (outer normal + up) at a point along a temple path. */
function templeFrameAt(path, t, side) {
  const point = path.getPointAt(t);
  const tangent = path.getTangentAt(t);
  const outward = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), tangent).normalize();
  if (outward.x * side < 0) outward.negate();
  const up = new THREE.Vector3().crossVectors(tangent, outward).normalize();
  return { point, tangent, outward, up };
}

function buildTemple(side, spec, material, hingeX, hingeY, hingeZ) {
  const path = templePath(side, hingeX, hingeY, hingeZ);

  const steps = 64;
  const positions = [];
  const indices = [];
  const up = new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  const point = new THREE.Vector3();

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    path.getPointAt(t, point);
    path.getTangentAt(t, tangent);
    normal.crossVectors(up, tangent).normalize();
    binormal.crossVectors(tangent, normal).normalize();

    // Taper the arm from the hinge back to the ear.
    const h = THREE.MathUtils.lerp(spec.templeHeight, spec.templeHeightEnd, Math.pow(t, 0.75)) / 2;
    const w = (spec.templeThickness * THREE.MathUtils.lerp(1, 0.8, t)) / 2;

    for (const [sn, sb] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) {
      positions.push(
        point.x + normal.x * w * sn + binormal.x * h * sb,
        point.y + normal.y * w * sn + binormal.y * h * sb,
        point.z + normal.z * w * sn + binormal.z * h * sb
      );
    }
    if (i < steps) {
      const a = i * 4;
      const b = (i + 1) * 4;
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        indices.push(a + k, b + k, b + k2, a + k, b + k2, a + k2);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

// How far out the arm sits as it passes the temple of the head.
const TEMPLE_BACK_X = 7.25;

/**
 * Brand hardware on the outer face of the temple: the sculpted metal
 * initial at the hinge end, and the printed wordmark behind it. A retailer's
 * try-on has to show the frame the customer will actually receive, so these
 * are modelled as real geometry/decal rather than omitted.
 */
function buildTempleBranding(side, spec, path, hardwareMaterial) {
  const group = new THREE.Group();

  // Orientation basis on the outer face of the arm:
  //   local +X = forward along the arm (toward the lenses)
  //   local +Y = up
  //   local +Z = out of the arm's outer face
  // Building the ornaments against this explicit basis is what keeps the
  // initial readable rather than rotated into a "U".
  const orient = (t) => {
    const f = templeFrameAt(path, t, side);
    const x = f.tangent.clone().negate(); // tangent runs back toward the ear
    const z = f.outward.clone();
    const y = new THREE.Vector3().crossVectors(z, x).normalize();
    const basis = new THREE.Matrix4().makeBasis(x, y, z);
    return { frame: f, basis };
  };

  // Sculpted metal initial: a partial torus whose gap faces forward.
  const { frame: iFrame, basis: iBasis } = orient(0.11);
  const radius = spec.templeHeight * 0.3;
  const initial = new THREE.Mesh(
    new THREE.TorusGeometry(radius, radius * 0.3, 14, 48, Math.PI * 1.42),
    hardwareMaterial
  );
  // Rotate the arc so its opening is centred on +X (forward).
  initial.geometry.rotateZ(Math.PI * 0.29);
  initial.applyMatrix4(iBasis);
  initial.position
    .copy(iFrame.point)
    .addScaledVector(iFrame.outward, spec.templeThickness / 2 + 0.015);
  group.add(initial);

  // Printed wordmark, as a decal hugging the arm just behind the initial.
  const { frame: wFrame, basis: wBasis } = orient(0.3);
  const decal = new THREE.Mesh(
    new THREE.PlaneGeometry(spec.templeHeight * 1.6, spec.templeHeight * 0.52),
    new THREE.MeshBasicMaterial({
      map: makeWordmarkTexture(spec.wordmark),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    })
  );
  decal.applyMatrix4(wBasis);
  decal.position
    .copy(wFrame.point)
    .addScaledVector(wFrame.outward, spec.templeThickness / 2 + 0.012);
  decal.renderOrder = 2;
  group.add(decal);

  return group;
}

/** Wordmark rendered to a transparent texture. */
function makeWordmarkTexture(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 170;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f2f0ea';
  ctx.font = '600 104px Georgia, "Times New Roman", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Small metal rivets at the hinge corners, as on the reference frame. */
function buildRivet(spec, material, x, y, z) {
  const geometry = new THREE.CylinderGeometry(0.11, 0.11, 0.1, 16);
  geometry.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  return mesh;
}

/**
 * Builds a thick-acetate frame from an optical spec.
 * @param {Partial<typeof DEFAULT_SPEC>} overrides
 * @param {{lensCenterY?: number, frontZ?: number}} placement where the front
 *   sits in face space; defaults are tuned so the frame rests on the nose
 *   with the pupils in the upper half of the lenses, as an oversized frame does.
 */
export function createAcetateFrame(overrides = {}, placement = {}) {
  const spec = { ...DEFAULT_SPEC, ...overrides };
  const lensCenterY = placement.lensCenterY ?? 2.25;
  const frontZ = placement.frontZ ?? 4.45;

  const group = new THREE.Group();
  group.name = 'acetate-frame';

  const frameMaterial = new THREE.MeshPhysicalMaterial({
    color: spec.frameColor,
    metalness: 0.0,
    roughness: spec.frameRoughness,
    clearcoat: 0.85,
    clearcoatRoughness: 0.08,
    sheen: 0.2,
  });
  const lensMaterial = new THREE.MeshPhysicalMaterial({
    map: makeGradientTexture(spec.lensTop, spec.lensBottom),
    transparent: true,
    opacity: spec.lensOpacity,
    roughness: 0.06,
    metalness: 0.0,
    // Plain alpha rather than transmission: a transmissive lens picks up the
    // bright background and washes out to mid-grey, where a real dark
    // sunglass lens stays dark against the same background. Alpha keeps it
    // dark while still letting the eyes read faintly through it on a face.
    ior: 1.52,
    // Kept low: a bright room environment otherwise washes a dark sunglass
    // lens out to mid-grey.
    envMapIntensity: 0.55,
    side: THREE.DoubleSide,
  });
  const hardwareMaterial = new THREE.MeshPhysicalMaterial({
    color: spec.hardwareColor,
    metalness: 1.0,
    roughness: 0.28,
  });

  // The front: one continuous acetate slab, two lenses seated in it.
  const front = new THREE.Group();
  const m = frontMetrics(spec);
  const outerX = m.halfWidth;

  front.add(buildFront(spec, frameMaterial));
  for (const side of [-1, 1]) {
    front.add(buildLens(spec, lensMaterial, side));
    // Small metal rivet on the outer face, at the hinge line.
    front.add(
      buildRivet(spec, hardwareMaterial, side * (outerX - spec.rim * 0.45), 0.1, spec.depth / 2)
    );
  }

  front.position.set(0, lensCenterY, frontZ);
  front.rotation.x = spec.pantoscopic;
  group.add(front);

  // Temples hinge off the outer edge of the front, at the rivet line.
  // Start the arm slightly inside the front slab so the joint reads solid.
  const hingeZ = frontZ + spec.depth * 0.2;
  const hingeX = outerX - 0.22;
  const hingeY = lensCenterY + 0.35;
  for (const side of [-1, 1]) {
    group.add(buildTemple(side, spec, frameMaterial, hingeX, hingeY, hingeZ));
    const path = templePath(side, hingeX, hingeY, hingeZ);
    group.add(buildTempleBranding(side, spec, path, hardwareMaterial));
  }

  group.userData.spec = spec;
  return group;
}
