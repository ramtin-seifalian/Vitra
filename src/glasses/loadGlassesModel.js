import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createGlasses } from './createGlasses.js';

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
