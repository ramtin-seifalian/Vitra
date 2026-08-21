/**
 * Builds a real-scale THREE.Group of a pair of glasses out of the photo
 * analyses. The front slab is the photographed silhouette extruded, with the
 * photo itself projected onto the front face (so every printed logo, pattern
 * and colour gradient of the product survives into the 3D model); the lens
 * apertures are punched through and filled with transparent physical lens
 * meshes tinted from the photo.
 *
 * Units are centimetres, like the rest of the app (faceAnchors space).
 */
import * as THREE from 'three';

export const DEFAULT_PARAMS = {
  frameWidthMM: 140, // total front width — printed sizes make this exact
  templeLengthMM: 145,
  depthCM: 0.42, // front-to-back thickness of the front slab
  templeThicknessCM: 0.28,
  lensOpacity: null, // null = auto from detected tint
  wrapK: 0.008, // subtle cylindrical face-form wrap: z -= wrapK * x^2
};

function rgbColor([r, g, b]) {
  return new THREE.Color(r / 255, g / 255, b / 255).convertSRGBToLinear();
}

/**
 * Texture over the photo canvas whose repeat/offset make raw shape-space
 * (x, y) UVs — which is exactly what ExtrudeGeometry/ShapeGeometry generate —
 * land on the right photo pixels. Mapping used by the shapes:
 *   x = (px - ax) * s ;  y = (ay - py) * s
 */
function textureForShape(canvas, ax, ay, s) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.repeat.set(1 / (s * canvas.width), 1 / (s * canvas.height));
  tex.offset.set(ax / canvas.width, 1 - ay / canvas.height);
  return tex;
}

function contourToShapePoints(contour, ax, ay, s) {
  return contour.map(([px, py]) => new THREE.Vector2((px - ax) * s, (ay - py) * s));
}

/** Subtle face-form wrap applied in place: z -= k * x^2. */
function applyWrap(geometry, k) {
  if (!k) return;
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    pos.setZ(i, pos.getZ(i) - k * x * x);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
}

/** Uniformly shrink a closed shape-space polygon toward its centroid. */
function shrinkPoints(points, factor) {
  let cx = 0, cy = 0;
  for (const p of points) { cx += p.x; cy += p.y; }
  cx /= points.length;
  cy /= points.length;
  return points.map((p) => new THREE.Vector2(cx + (p.x - cx) * factor, cy + (p.y - cy) * factor));
}

function frameMaterials(front, ax, ay, s) {
  const faceMat = new THREE.MeshPhysicalMaterial({
    map: textureForShape(front.paddedCanvas, ax, ay, s),
    roughness: 0.3,
    metalness: 0.0,
    clearcoat: 0.55,
    clearcoatRoughness: 0.22,
  });
  const sideMat = new THREE.MeshPhysicalMaterial({
    color: rgbColor(front.rimColor),
    roughness: 0.34,
    metalness: 0.0,
    clearcoat: 0.45,
    clearcoatRoughness: 0.3,
  });
  return [faceMat, sideMat];
}

function lensMaterial(front, opacity, faceTexture) {
  const usePhoto = front.lensSource === 'color' || front.lensSource === 'inset';
  const mat = new THREE.MeshPhysicalMaterial({
    color: usePhoto ? 0xffffff : 0xeef3f6,
    map: usePhoto ? faceTexture : null,
    transparent: true,
    opacity,
    roughness: 0.04,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.4,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  return mat;
}

/** Auto lens opacity: darker detected tints read as denser sunglass lenses. */
export function suggestLensOpacity(front) {
  if (!front || front.lensSource === 'holes' || !front.lensTint) return 0.16;
  const [r, g, b] = front.lensTint;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return Math.min(0.85, Math.max(0.3, 0.92 - lum * 0.95));
}

/** Procedural tapered temple silhouette (side view) used when no side photo. */
function proceduralTempleShape(lengthCM) {
  const L = lengthCM;
  const s = new THREE.Shape();
  s.moveTo(0, 0.5);
  s.lineTo(L * 0.72, 0.3);
  s.quadraticCurveTo(L * 0.94, 0.18, L * 0.985, -0.85);
  s.quadraticCurveTo(L, -1.15, L * 0.955, -1.15);
  s.quadraticCurveTo(L * 0.9, -0.35, L * 0.7, -0.28);
  s.lineTo(0, -0.5);
  s.closePath();
  return s;
}

function buildTemple({ side, params, hinge, sideFallbackColor }) {
  const thickness = params.templeThicknessCM;
  let geometry;
  let materials;
  if (side) {
    const s2 = params.templeLengthMM / 10 / (side.comp.maxX - side.comp.minX + 1);
    const ax = side.comp.minX;
    const ay = side.hingeMidY;
    const pts = contourToShapePoints(side.contour, ax, ay, s2);
    geometry = new THREE.ExtrudeGeometry(new THREE.Shape(pts), {
      depth: thickness,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.02,
      bevelSegments: 2,
    });
    const lidMat = new THREE.MeshPhysicalMaterial({
      map: textureForShape(side.paddedCanvas, ax, ay, s2),
      roughness: 0.3,
      metalness: 0.0,
      clearcoat: 0.55,
      clearcoatRoughness: 0.22,
      side: THREE.DoubleSide,
    });
    const edgeMat = new THREE.MeshPhysicalMaterial({
      color: rgbColor(side.color),
      roughness: 0.34,
      clearcoat: 0.45,
      side: THREE.DoubleSide,
    });
    materials = [lidMat, edgeMat];
  } else {
    geometry = new THREE.ExtrudeGeometry(proceduralTempleShape(params.templeLengthMM / 10), {
      depth: thickness,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.02,
      bevelSegments: 2,
    });
    materials = new THREE.MeshPhysicalMaterial({
      color: rgbColor(sideFallbackColor),
      roughness: 0.32,
      clearcoat: 0.5,
      clearcoatRoughness: 0.25,
      side: THREE.DoubleSide,
    });
  }

  const right = new THREE.Mesh(geometry, materials);
  right.name = 'temple-right';
  // Local +x (toward the ear tip) -> world -z; the textured lid faces +x
  // (outward). A touch under 90deg splays the arms slightly outward.
  right.rotation.y = Math.PI / 2 - 0.045;
  right.position.set(hinge.x, hinge.y, hinge.z);

  const left = new THREE.Group();
  left.name = 'temple-left';
  left.scale.x = -1; // mirror across the YZ plane
  const leftMesh = right.clone();
  left.add(leftMesh);

  return [right, left];
}

/**
 * Main entry: build the model.
 * front: analyzeFrontPhoto result (required)
 * side: analyzeTemplePhoto result (optional)
 */
export function buildGlassesModel({ front, side = null, params: userParams = {} }) {
  const params = { ...DEFAULT_PARAMS, ...userParams };
  const group = new THREE.Group();
  group.name = 'photo-glasses';

  const frameW = front.frame.maxX - front.frame.minX + 1;
  const s = params.frameWidthMM / 10 / frameW; // cm per photo px
  const ax = (front.frame.minX + front.frame.maxX) / 2;
  const ay = (front.frame.minY + front.frame.maxY) / 2;

  // ---- Front slab: photographed silhouette with the apertures punched out.
  const outer = new THREE.Shape(contourToShapePoints(front.outerContour, ax, ay, s));
  for (const aperture of front.apertures) {
    outer.holes.push(new THREE.Path(contourToShapePoints(aperture, ax, ay, s)));
  }
  const frontGeom = new THREE.ExtrudeGeometry(outer, {
    depth: params.depthCM,
    bevelEnabled: true,
    bevelThickness: 0.03,
    bevelSize: 0.03,
    bevelSegments: 2,
  });
  const [faceMat, sideMat] = frameMaterials(front, ax, ay, s);
  applyWrap(frontGeom, params.wrapK);
  const frontMesh = new THREE.Mesh(frontGeom, [faceMat, sideMat]);
  frontMesh.name = 'front';
  group.add(frontMesh);

  // ---- Lenses: slightly shrunk aperture shapes, seated inside the slab.
  const opacity = params.lensOpacity ?? suggestLensOpacity(front);
  const lensMat = lensMaterial(front, opacity, faceMat.map);
  for (const aperture of front.apertures) {
    const pts = shrinkPoints(contourToShapePoints(aperture, ax, ay, s), 1.015);
    const lensGeom = new THREE.ShapeGeometry(new THREE.Shape(pts));
    // A lens stays planar and is *tilted* to the face-form slope at its own
    // centre, rather than being bent like the frame front: ShapeGeometry
    // triangulates only the outline, so bending it point-by-point would show
    // as visible facets across the glass.
    let cx = 0;
    let cy = 0;
    for (const p of pts) { cx += p.x; cy += p.y; }
    cx /= pts.length;
    cy /= pts.length;
    // Re-origin the geometry on the lens centre so the tilt pivots there.
    lensGeom.translate(-cx, -cy, 0);
    const lens = new THREE.Mesh(lensGeom, lensMat);
    lens.name = 'lens';
    lens.renderOrder = 2;
    lens.position.set(cx, cy, params.depthCM * 0.5 - params.wrapK * cx * cx);
    // Surface is z = -k*x^2, so its normal at cx tilts by atan(2*k*cx).
    lens.rotation.y = Math.atan(2 * params.wrapK * cx);
    group.add(lens);
  }

  // ---- Temples, hinged at the outer edge of the front at lug height.
  const hingeX = (front.frame.maxX - ax) * s - 0.06;
  const hingeY = (ay - front.lugY) * s;
  const hinge = {
    x: hingeX,
    y: hingeY,
    z: -params.wrapK * hingeX * hingeX + params.depthCM * 0.2,
  };
  for (const temple of buildTemple({ side, params, hinge, sideFallbackColor: front.rimColor })) {
    group.add(temple);
  }

  return { group, lensMaterial: lensMat, params, scaleCmPerPx: s };
}

/**
 * Dispose everything a built model allocated. Geometry, materials and the
 * photo textures are deliberately shared (mirrored temples, one lens material
 * for both eyes), so each resource is disposed exactly once.
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
