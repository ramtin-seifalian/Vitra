import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createGlasses } from './createGlasses.js';
import { createAcetateFrame } from './createAcetateFrame.js';
import { loadCustomModel } from '../generator/customModelStore.js';
import { fitUploadedFrame } from './fitUploadedFrame.js';

// Parametric reproductions of real products, built from their optical spec
// (lens width x height, bridge, temple length) rather than loaded as assets.
const PARAMETRIC_FRAMES = {
  'square-oversized': {},
};

/**
 * Real scanned/authored glasses models (phase 2), registered alongside the
 * phase-1 procedural styles. Each entry maps the model's own space into the
 * MediaPipe metric-cm face space used by the tracker:
 *   - scale: glTF is authored in meters; the face space is centimeters.
 *   - position: translation (after scaling) that puts the nose pads on the
 *     nose bridge and the lenses just in front of the eyes. Derived from the
 *     model's measured part bounds vs the anatomical anchors in
 *     faceAnchors.js; fine-tunable live via the fit sliders.
 */
const GLASSES_MODELS = {
  sunglasses: {
    url: `${import.meta.env.BASE_URL}models/sunglasses-khronos.glb`,
    scale: 100,
    // y tuned down from -0.15 after on-face testing (glasses sat on the
    // brows); puts the lens centres on the pupil line.
    position: [0, -0.75, 5.0],
    // CC-BY 4.0 — Eric Chadwick / Darmstadt Graphics Group GmbH, via
    // KhronosGroup/glTF-Sample-Assets (see README credits).
  },
  // Second registered model: same CC-BY frame geometry re-materialed as a
  // matte-black sport pair with dark green non-iridescent lenses, in a
  // slightly narrower size — exercising exactly the per-model registry path
  // (own URL/scale/fit/materials) that client-scanned models will use.
  sport: {
    url: `${import.meta.env.BASE_URL}models/sunglasses-khronos.glb`,
    scale: 97,
    position: [0, -0.75, 5.0],
    tint: {
      frame: 0x23262b,
      frameMetalness: 0.25,
      frameRoughness: 0.55,
      lens: 0x14432f,
    },
  },
};

export const MODEL_STYLES = Object.keys(GLASSES_MODELS);

// The frame the user generated from their own product photos (generator.html).
// It is authored directly in face-space centimetres with its origin at the
// front's optical centre, so it only needs translating onto the nose bridge:
// lens centres onto the pupil line (y), and the back of the front slab just
// clear of the bridge (z) — the same numbers the other registry entries carry.
export const CUSTOM_STYLE = 'custom';
const CUSTOM_FIT = { position: [0, 2.5, 5.45] };

let customPromise = null;

/** Parse the GLB held in IndexedDB once; callers get clones of the result. */
function loadCustomScene() {
  customPromise ??= loadCustomModel().then(async (record) => {
    if (!record) throw new Error('no-custom-model');
    const gltf = await loader.parseAsync(record.glb, '');
    const meta = record.meta ?? {};

    // A frame this app generated is already authored in face space. One the
    // user uploaded is in whatever units, orientation and origin its author
    // chose, so it has to be measured and re-framed before it can be worn.
    if (meta.source === 'upload') {
      const { group } = fitUploadedFrame(gltf.scene, meta.frameWidthMM ?? 140);
      return group;
    }
    return gltf.scene;
  });
  return customPromise;
}

/** Drop the parse cache, so a newly generated frame is picked up. */
export function invalidateCustomModel() {
  customPromise = null;
}

/** Build the user's generated frame, ready to drop onto the face anchor. */
async function loadCustomGlasses() {
  const scene = await loadCustomScene();
  const group = new THREE.Group();
  group.name = 'glasses-custom';
  const instance = scene.clone(true);
  instance.position.fromArray(CUSTOM_FIT.position);
  group.add(instance);
  group.userData.style = CUSTOM_STYLE;
  group.userData.isModel = true; // clones share cached resources — never deep-disposed
  return group;
}

export function isModelStyle(style) {
  return style in GLASSES_MODELS;
}

// Per-model material overrides. Clones sharing the cached scene get their own
// material instances here, so tinting one style never affects another.
function applyTint(instance, tint) {
  instance.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const material = obj.material.clone();
    if (material.name.startsWith('lens')) {
      material.color.set(tint.lens);
      if ('iridescence' in material) material.iridescence = 0;
    } else {
      material.color.set(tint.frame);
      if (tint.frameMetalness != null) material.metalness = tint.frameMetalness;
      if (tint.frameRoughness != null) material.roughness = tint.frameRoughness;
    }
    obj.material = material;
  });
}

const loader = new GLTFLoader();
const cache = new Map(); // url -> Promise<THREE.Group> (the raw loaded scene)

function loadRawModel(style) {
  const { url } = GLASSES_MODELS[style];
  if (!cache.has(url)) {
    cache.set(
      url,
      loader.loadAsync(url).then((gltf) => gltf.scene)
    );
  }
  return cache.get(url);
}

/**
 * Returns a fresh Group for any style — procedural (sync path) or a real
 * model (loaded once, then cloned per request; clones share geometry and
 * materials with the cache, so model groups are flagged `isModel` and must
 * NOT be deep-disposed on style switches).
 * Falls back to a procedural style if the model file fails to load, so the
 * try-on never breaks on a missing/blocked asset.
 */
export async function getGlasses(style) {
  if (style === CUSTOM_STYLE) {
    try {
      return await loadCustomGlasses();
    } catch (err) {
      customPromise = null;
      console.warn('[glasses] no usable generated frame, using procedural fallback', err);
      return createGlasses('square');
    }
  }
  if (style in PARAMETRIC_FRAMES) {
    const group = createAcetateFrame(PARAMETRIC_FRAMES[style]);
    group.userData.style = style;
    return group;
  }
  if (!isModelStyle(style)) return createGlasses(style);
  try {
    const raw = await loadRawModel(style);
    const { scale, position, tint } = GLASSES_MODELS[style];
    const group = new THREE.Group();
    group.name = `glasses-${style}`;
    const instance = raw.clone(true);
    instance.scale.setScalar(scale);
    instance.position.fromArray(position);
    if (tint) applyTint(instance, tint);
    group.add(instance);
    group.userData.style = style;
    group.userData.isModel = true;
    return group;
  } catch (err) {
    console.warn(`[glasses] failed to load model "${style}", using procedural fallback`, err);
    return createGlasses('aviator');
  }
}

/** Style-switch cleanup that respects shared (cached) model resources. */
export function disposeGlasses(group) {
  if (!group || group.userData.isModel) return;
  group.traverse((obj) => {
    obj.geometry?.dispose();
    obj.material?.dispose();
  });
}
