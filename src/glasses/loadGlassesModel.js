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
    position: [0, -0.15, 5.0],
    // CC-BY 4.0 — Eric Chadwick / Darmstadt Graphics Group GmbH, via
    // KhronosGroup/glTF-Sample-Assets (see README credits).
  },
};

export const MODEL_STYLES = Object.keys(GLASSES_MODELS);

export function isModelStyle(style) {
  return style in GLASSES_MODELS;
}

const loader = new GLTFLoader();
const cache = new Map(); // style -> Promise<THREE.Group> (the raw loaded scene)

function loadRawModel(style) {
  if (!cache.has(style)) {
    const { url } = GLASSES_MODELS[style];
    cache.set(
      style,
      loader.loadAsync(url).then((gltf) => gltf.scene)
    );
  }
  return cache.get(style);
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
    const { scale, position } = GLASSES_MODELS[style];
    const group = new THREE.Group();
    group.name = `glasses-${style}`;
    const instance = raw.clone(true);
    instance.scale.setScalar(scale);
    instance.position.fromArray(position);
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
