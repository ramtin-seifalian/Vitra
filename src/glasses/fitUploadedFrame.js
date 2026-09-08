import * as THREE from 'three';

/**
 * Normalising a glasses model somebody else authored.
 *
 * Frames the generator builds are already in this app's face space —
 * centimetres, +X right, +Y up, +Z toward the viewer, origin at the front's
 * optical centre. An arbitrary .glb is not: it may be in metres or
 * millimetres, modelled Z-up, facing away from the camera, and centred on
 * wherever its author happened to leave the origin. Dropped in untouched it
 * lands somewhere off-screen, at the wrong size, pointing the wrong way.
 *
 * Nothing in a glTF says which way a pair of glasses faces, so the axes are
 * recovered from the shape itself, using facts true of every pair:
 *
 *   - it is far wider and deeper than it is tall, so the shortest axis is up;
 *   - it is mirror-symmetric left to right, but along its depth it is a slab
 *     at one end and two thin arms trailing off the other — so the depth axis
 *     is the skewed one and the width axis the balanced one;
 *   - the front is the end that is wide, the arms the end that is narrow;
 *   - the arms hook downward behind the ear, so the far end sits lower.
 *
 * The result is scaled to a real frame width and re-origined on the front, so
 * it drops onto the face anchor exactly like a generated one. The fit sliders
 * remain for correcting whatever the model's own proportions make wrong.
 */

const MAX_SAMPLES = 6000;

/** World-space vertex positions of every mesh, subsampled. */
function samplePoints(object) {
  object.updateMatrixWorld(true);
  const meshes = [];
  let total = 0;
  object.traverse((o) => {
    const pos = o.isMesh && o.geometry?.attributes?.position;
    if (!pos) return;
    meshes.push(o);
    total += pos.count;
  });
  if (!total) return [];

  const stride = Math.max(1, Math.ceil(total / MAX_SAMPLES));
  const points = [];
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      points.push(v.clone());
    }
  }
  return points;
}

function statsAlong(points, axis) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const p of points) {
    const c = p.getComponent(axis);
    if (c < min) min = c;
    if (c > max) max = c;
    sum += c;
  }
  const mean = sum / points.length;
  let m2 = 0;
  let m3 = 0;
  for (const p of points) {
    const d = p.getComponent(axis) - mean;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= points.length;
  m3 /= points.length;
  const sd = Math.sqrt(m2);
  return { min, max, mean, extent: max - min, skew: sd > 1e-9 ? m3 / (sd * sd * sd) : 0 };
}

/**
 * Work out which model axis is width, which is depth, and which way each
 * points. Returns unit vectors in the model's own space.
 */
function deriveAxes(points) {
  const stats = [0, 1, 2].map((a) => statsAlong(points, a));

  // Shortest axis is up: a frame is a few centimetres tall against ~14 wide
  // and ~15 deep.
  let upAxis = 0;
  for (let a = 1; a < 3; a++) if (stats[a].extent < stats[upAxis].extent) upAxis = a;

  const rest = [0, 1, 2].filter((a) => a !== upAxis);
  // Depth is the skewed one — a dense slab at the front, two thin arms
  // trailing far off the back. Width is symmetric about the bridge.
  const depthAxis =
    Math.abs(stats[rest[0]].skew) >= Math.abs(stats[rest[1]].skew) ? rest[0] : rest[1];
  const widthAxis = rest[0] === depthAxis ? rest[1] : rest[0];

  // Which end along depth is the front? The one that is wide: the front spans
  // the whole frame, the arms are two narrow rails.
  const d = stats[depthAxis];
  const cut = d.extent * 0.25;
  const widthSpread = (lo, hi) => {
    let min = Infinity;
    let max = -Infinity;
    for (const p of points) {
      const c = p.getComponent(depthAxis);
      if (c < lo || c > hi) continue;
      const wv = p.getComponent(widthAxis);
      if (wv < min) min = wv;
      if (wv > max) max = wv;
    }
    return max > min ? max - min : 0;
  };
  const lowIsFront = widthSpread(d.min, d.min + cut) > widthSpread(d.max - cut, d.max);
  const depthSign = lowIsFront ? -1 : 1; // front should end up at +Z

  // Which way is up? The arms hook down behind the ear, so the rear end of the
  // model sits below the front.
  const frontLo = lowIsFront ? d.min : d.max - cut;
  const frontHi = lowIsFront ? d.min + cut : d.max;
  const meanUpIn = (lo, hi) => {
    let sum = 0;
    let n = 0;
    for (const p of points) {
      const c = p.getComponent(depthAxis);
      if (c < lo || c > hi) continue;
      sum += p.getComponent(upAxis);
      n++;
    }
    return n ? sum / n : 0;
  };
  const rearLo = lowIsFront ? d.max - cut : d.min;
  const rearHi = lowIsFront ? d.max : d.min + cut;
  const upSign = meanUpIn(rearLo, rearHi) < meanUpIn(frontLo, frontHi) ? 1 : -1;

  const unit = (axis, sign) => {
    const v = new THREE.Vector3();
    v.setComponent(axis, sign);
    return v;
  };
  const up = unit(upAxis, upSign);
  const depth = unit(depthAxis, depthSign);
  // Width follows from the other two, which also guarantees a right-handed
  // basis — picking its sign independently can mirror the model.
  const width = new THREE.Vector3().crossVectors(up, depth);
  return { width, up, depth, stats, widthAxis, upAxis, depthAxis };
}

/**
 * Re-frame an uploaded glasses model into face space.
 *
 * @param {THREE.Object3D} scene   the parsed glTF scene (not modified)
 * @param {number} frameWidthMM    real width of the frame front
 * @returns {{ group: THREE.Group, info: object }}
 */
export function fitUploadedFrame(scene, frameWidthMM = 140) {
  const object = scene.clone(true);
  const points = samplePoints(object);
  if (points.length < 8) {
    throw new Error('empty-model');
  }

  const { width, up, depth } = deriveAxes(points);

  // Rotate the model so its own axes line up with the face space's.
  const basis = new THREE.Matrix4().makeBasis(width, up, depth);
  const align = new THREE.Matrix4().copy(basis).invert();

  const aligned = points.map((p) => p.clone().applyMatrix4(align));
  const ax = statsAlong(aligned, 0);
  const ay = statsAlong(aligned, 1);
  const az = statsAlong(aligned, 2);

  // Scale from the FRONT's width. The full bounding box spans the splayed
  // arms, which on many frames are wider than the front itself.
  const frontCut = az.max - az.extent * 0.25;
  let frontMinX = Infinity;
  let frontMaxX = -Infinity;
  let frontSumY = 0;
  let frontCount = 0;
  for (const p of aligned) {
    if (p.z < frontCut) continue;
    if (p.x < frontMinX) frontMinX = p.x;
    if (p.x > frontMaxX) frontMaxX = p.x;
    frontSumY += p.y;
    frontCount++;
  }
  const frontWidth = frontCount && frontMaxX > frontMinX ? frontMaxX - frontMinX : ax.extent;
  const scale = frameWidthMM / 10 / frontWidth;

  // Origin on the front's optical centre, matching how generated frames are
  // authored, so the same placement on the face anchor works for both.
  const originX = (frontMinX + frontMaxX) / 2;
  const originY = frontCount ? frontSumY / frontCount : ay.mean;
  const originZ = az.max;

  const group = new THREE.Group();
  group.name = 'uploaded-frame';
  object.applyMatrix4(align);
  object.position.sub(new THREE.Vector3(originX, originY, originZ));
  object.updateMatrixWorld(true);

  const holder = new THREE.Group();
  holder.add(object);
  holder.scale.setScalar(scale);
  group.add(holder);

  return {
    group,
    info: {
      scale,
      frontWidthModelUnits: frontWidth,
      sizeCM: {
        width: ax.extent * scale,
        height: ay.extent * scale,
        depth: az.extent * scale,
      },
    },
  };
}
