import * as THREE from 'three';
import { analyzeFrontPhoto } from '../generator/photoAnalysis.js';

/**
 * Turning a generic generated mesh into a pair of glasses.
 *
 * An image-to-3D model reconstructs the surface it was shown and nothing more.
 * It has no idea it is looking at eyewear, so it hands back one merged mesh
 * with one material and — the thing that gives it away immediately — **solid,
 * opaque lenses**. Worn on a face that reads as a blindfold. No amount of
 * texture quality fixes it, because the problem is semantic: some of those
 * triangles are glass and the model does not know which.
 *
 * This is where the photo analysis built for the parametric path earns its
 * keep a second time. Rather than guessing at the mesh, the mesh is rendered
 * straight-on and that render is run through the same aperture detector used
 * on product photos — which finds the two thick, mirror-paired regions the rim
 * encloses. Because the render is made here, the camera is known exactly, so
 * every aperture pixel maps back to model coordinates with no registration
 * guesswork. Triangles landing inside an aperture and facing the viewer are
 * the lenses; everything else is the frame.
 *
 * The two are then split into separate meshes so each can carry its own
 * material: the generated texture stays on the frame, and the lenses become
 * real transparent glass.
 */

const RENDER_PX = 768;

/** Orthographic straight-on render of the model onto white. */
function renderFront(object, renderer) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());

  const halfW = (Math.max(size.x, size.y) / 2) * 1.1;
  const camera = new THREE.OrthographicCamera(-halfW, halfW, halfW, -halfW, -1000, 1000);
  camera.position.set(centre.x, centre.y, centre.z + 100);
  camera.lookAt(centre.x, centre.y, centre.z);
  camera.updateProjectionMatrix();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);
  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(2, 4, 8);
  scene.add(key);

  const parent = object.parent;
  scene.add(object);

  const target = new THREE.WebGLRenderTarget(RENDER_PX, RENDER_PX);
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);

  const pixels = new Uint8Array(RENDER_PX * RENDER_PX * 4);
  renderer.readRenderTargetPixels(target, 0, 0, RENDER_PX, RENDER_PX, pixels);
  renderer.setRenderTarget(prevTarget);
  target.dispose();

  if (parent) parent.add(object);
  else scene.remove(object);

  // readRenderTargetPixels returns rows bottom-up; ImageData is top-down.
  const data = new Uint8ClampedArray(RENDER_PX * RENDER_PX * 4);
  for (let y = 0; y < RENDER_PX; y++) {
    const src = (RENDER_PX - 1 - y) * RENDER_PX * 4;
    data.set(pixels.subarray(src, src + RENDER_PX * 4), y * RENDER_PX * 4);
  }

  return {
    imageData: new ImageData(data, RENDER_PX, RENDER_PX),
    // Everything needed to map a pixel back to model space.
    halfW,
    centre,
    box,
  };
}

/** Fill a pixel mask from a traced contour (even-odd scanline fill). */
function maskFromContours(contours, w, h) {
  const mask = new Uint8Array(w * h);
  for (const contour of contours) {
    let minY = h;
    let maxY = 0;
    for (const [, y] of contour) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(h - 1, Math.ceil(maxY)); y++) {
      const crossings = [];
      for (let i = 0; i < contour.length; i++) {
        const [x1, y1] = contour[i];
        const [x2, y2] = contour[(i + 1) % contour.length];
        if (y1 === y2) continue;
        if ((y >= y1 && y < y2) || (y >= y2 && y < y1)) {
          crossings.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      crossings.sort((a, b) => a - b);
      for (let c = 0; c + 1 < crossings.length; c += 2) {
        const from = Math.max(0, Math.ceil(crossings[c]));
        const to = Math.min(w - 1, Math.floor(crossings[c + 1]));
        for (let x = from; x <= to; x++) mask[y * w + x] = 1;
      }
    }
  }
  return mask;
}

/**
 * Grow a mask by a few pixels.
 *
 * The lens outline traced from the render runs along the rim's inner edge, so
 * triangles straddling that edge fall on the frame side and keep the original
 * texture — which at the lens boundary is the lens's own colour. Against the
 * now-transparent glass beside them they read as a jagged coloured fringe.
 * Growing the mask slightly takes those boundary triangles with the lens.
 */
function dilateMask(mask, w, h, radius) {
  let current = mask;
  for (let step = 0; step < radius; step++) {
    const next = new Uint8Array(current);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (current[i]) continue;
        if (
          current[i - 1] || current[i + 1] ||
          current[i - w] || current[i + w]
        ) {
          next[i] = 1;
        }
      }
    }
    current = next;
  }
  return current;
}

/** A transparent lens material, tinted to whatever the photo measured. */
function makeLensMaterial(tint, opacity) {
  return new THREE.MeshPhysicalMaterial({
    color: tint ?? new THREE.Color(0x2a2f38),
    transparent: true,
    opacity,
    roughness: 0.1,
    metalness: 0,
    ior: 1.52,
    envMapIntensity: 0.4,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

/**
 * Split one mesh into its lens and frame triangles.
 * Returns null when the mesh has no lens triangles at all.
 */
function splitMesh(mesh, isLensAt, lensMaterial, minZ) {
  const geometry = mesh.geometry;
  const pos = geometry.attributes.position;
  if (!pos) return null;

  const index = geometry.index;
  const faceCount = index ? index.count / 3 : pos.count / 3;
  const vertexOf = (f, k) => (index ? index.getX(f * 3 + k) : f * 3 + k);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const centroid = new THREE.Vector3();

  const lensFaces = [];
  const frameFaces = [];
  for (let f = 0; f < faceCount; f++) {
    const i0 = vertexOf(f, 0);
    const i1 = vertexOf(f, 1);
    const i2 = vertexOf(f, 2);
    a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    normal.copy(b).sub(a).cross(c.clone().sub(a)).normalize();

    // A lens faces the viewer, and sits in the front. Both tests are needed:
    // the aperture mask is two-dimensional, so a temple running back behind
    // the frame still projects inside it from straight on — without the depth
    // test the arms and ear hooks are turned to glass along with the lenses.
    // The normal test excludes the rim's inner wall, which is inside the
    // aperture outline but points sideways.
    const facingViewer = Math.abs(normal.z) > 0.55;
    const inFront = centroid.z >= minZ;
    (facingViewer && inFront && isLensAt(centroid) ? lensFaces : frameFaces).push(i0, i1, i2);
  }
  // A handful of stray triangles is misclassification, not a lens. Requiring a
  // real share of the mesh keeps an arm whose hinge end clips the aperture in
  // projection from being cut in two over a few dozen faces.
  const lensTriangles = lensFaces.length / 3;
  if (lensTriangles < Math.max(40, faceCount * 0.04)) return null;

  const build = (faces) => {
    const g = new THREE.BufferGeometry();
    for (const name of Object.keys(geometry.attributes)) {
      g.setAttribute(name, geometry.attributes[name]);
    }
    g.setIndex(faces);
    g.computeBoundingSphere();
    return g;
  };

  const frame = new THREE.Mesh(build(frameFaces), mesh.material);
  frame.name = `${mesh.name || 'part'}-frame`;
  const lens = new THREE.Mesh(build(lensFaces), lensMaterial);
  lens.name = `${mesh.name || 'part'}-lens`;
  lens.renderOrder = 2;

  return { frame, lens, lensFaces: lensFaces.length / 3, frameFaces: frameFaces.length / 3 };
}

/**
 * Give a generated frame real glass.
 *
 * @param {THREE.Object3D} object  model already normalised into face space
 * @param {object} options
 * @param {THREE.WebGLRenderer} options.renderer  used for the analysis render
 * @param {THREE.Color} [options.lensTint]
 * @param {number} [options.lensOpacity]
 * @returns {{ group: THREE.Object3D, info: object }}
 */
export function refineGeneratedFrame(object, { renderer, lensTint, lensOpacity = 0.55 } = {}) {
  const info = { lensFound: false, lensFaces: 0, frameFaces: 0, reason: null };

  // The analysis render needs a GL context. Callers on the try-on path do not
  // have one to spare, so borrow a small offscreen one and give it straight
  // back — this runs once per model, not per frame.
  let ownRenderer = null;
  if (!renderer) {
    try {
      ownRenderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
      ownRenderer.setSize(RENDER_PX, RENDER_PX, false);
      renderer = ownRenderer;
    } catch (err) {
      info.reason = `no-renderer: ${err?.message ?? err}`;
      return { group: object, info };
    }
  }
  try {
    return refine(object, renderer, lensTint, lensOpacity, info);
  } finally {
    ownRenderer?.dispose();
  }
}

function refine(object, renderer, lensTint, lensOpacity, info) {

  let apertures = [];
  try {
    const { imageData, halfW, centre, box } = renderFront(object, renderer);
    const analysis = analyzeFrontPhoto(imageData, { tolerance: 46 });
    apertures = analysis.apertures ?? [];
    info.detectedApertures = apertures.length;

    if (apertures.length < 2) {
      info.reason = 'no-apertures';
      return { group: object, info };
    }

    const mask = dilateMask(maskFromContours(apertures, RENDER_PX, RENDER_PX), RENDER_PX, RENDER_PX, 4);
    // Inverse of the orthographic projection used for the render.
    const toPixel = (p) => {
      const u = ((p.x - centre.x) / halfW + 1) / 2;
      const v = 1 - ((p.y - centre.y) / halfW + 1) / 2;
      return [Math.round(u * RENDER_PX), Math.round(v * RENDER_PX)];
    };
    const isLensAt = (p) => {
      const [px, py] = toPixel(p);
      if (px < 0 || py < 0 || px >= RENDER_PX || py >= RENDER_PX) return false;
      return mask[py * RENDER_PX + px] === 1;
    };

    // Lenses live in the front of the model, never back along the arms.
    const depth = box.max.z - box.min.z;
    const minZ = box.max.z - Math.max(depth * 0.22, 0.8);
    info.lensMinZ = +minZ.toFixed(2);

    const lensMaterial = makeLensMaterial(lensTint, lensOpacity);
    const meshes = [];
    object.updateMatrixWorld(true);
    object.traverse((o) => {
      if (o.isMesh) meshes.push(o);
    });

    for (const mesh of meshes) {
      const split = splitMesh(mesh, isLensAt, lensMaterial, minZ);
      if (!split) continue;
      info.lensFound = true;
      info.lensFaces += split.lensFaces;
      info.frameFaces += split.frameFaces;
      // The replacements take the original's place in the hierarchy, so they
      // must inherit its own local transform — the split geometry still holds
      // untransformed vertices, and re-parenting without this silently drops
      // whatever scale or offset the mesh carried.
      const parent = mesh.parent ?? object;
      for (const part of [split.frame, split.lens]) {
        part.position.copy(mesh.position);
        part.quaternion.copy(mesh.quaternion);
        part.scale.copy(mesh.scale);
        parent.add(part);
      }
      parent.remove(mesh);
    }
    if (!info.lensFound) info.reason = 'no-forward-faces-in-apertures';
  } catch (err) {
    info.reason = `analysis-failed: ${err?.message ?? err}`;
  }

  return { group: object, info };
}
