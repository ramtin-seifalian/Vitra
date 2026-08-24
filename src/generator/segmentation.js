/**
 * Client-side product-photo segmentation for the photo->3D glasses builder.
 *
 * Everything here runs on plain ImageData with typed arrays — no external
 * services, no ML downloads — which is what keeps the generator fully
 * self-contained. Accuracy therefore depends on the photo following the
 * shooting guide (uniform light background, straight-on angle); the UI
 * states those requirements explicitly.
 */

/** Load a File into a processing canvas, downscaled to maxDim on the long edge. */
export async function loadPhoto(file, maxDim = 1000) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('image-load-failed'));
      i.src = url;
    });
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return { canvas, imageData: ctx.getImageData(0, 0, w, h), width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Horizontally mirror a loaded photo (used to normalise temple orientation). */
export function flipPhoto(photo) {
  const { width: w, height: h } = photo;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(photo.canvas, 0, 0);
  return { canvas, imageData: ctx.getImageData(0, 0, w, h), width: w, height: h };
}

function colorDist(data, i, r, g, b) {
  const dr = data[i] - r;
  const dg = data[i + 1] - g;
  const db = data[i + 2] - b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Median colour of the 2px border ring — the background estimate. */
export function estimateBackground(imageData) {
  const { data, width: w, height: h } = imageData;
  const rs = [], gs = [], bs = [];
  const push = (x, y) => {
    const i = (y * w + x) * 4;
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0); push(x, Math.min(1, h - 1)); push(x, h - 1); push(x, Math.max(0, h - 2));
  }
  for (let y = 0; y < h; y++) {
    push(0, y); push(Math.min(1, w - 1), y); push(w - 1, y); push(Math.max(0, w - 2), y);
  }
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  return [med(rs), med(gs), med(bs)];
}

/**
 * Split the image into: background connected to the border (borderBg),
 * background-coloured pixels anywhere (bgLike), and the solid object mask
 * (everything not border-connected background — enclosed holes stay "solid"
 * here and are separated later).
 */
/**
 * Sobel gradient magnitude on luma, 0..255 per pixel.
 *
 * Colour distance alone cannot find a frame's boundary: a silver wire rim on a
 * white backdrop is within a few units of the background, so any tolerance
 * loose enough to remove the backdrop also eats the rim. An edge, however, is
 * still an edge — a thin bright rim has a strong gradient at its border even
 * when its colour barely differs.
 */
export function gradientMagnitude(imageData) {
  const { data, width: w, height: h } = imageData;
  const n = w * h;
  const luma = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    luma[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  }
  const grad = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -luma[i - w - 1] - 2 * luma[i - 1] - luma[i + w - 1] +
        luma[i - w + 1] + 2 * luma[i + 1] + luma[i + w + 1];
      const gy =
        -luma[i - w - 1] - 2 * luma[i - w] - luma[i - w + 1] +
        luma[i + w - 1] + 2 * luma[i + w] + luma[i + w + 1];
      grad[i] = Math.min(255, Math.hypot(gx, gy) / 4);
    }
  }
  return grad;
}

/** Value at the given percentile (0..1) of `values` over pixels where mask is set. */
export function maskedPercentile(values, mask, q) {
  const picked = [];
  for (let i = 0; i < values.length; i++) if (!mask || mask[i]) picked.push(values[i]);
  if (!picked.length) return 0;
  picked.sort((a, b) => a - b);
  return picked[Math.min(picked.length - 1, Math.floor(q * picked.length))];
}

/**
 * The object mask, taking every piece of the product rather than the single
 * biggest blob.
 *
 * A thin, bright part — a wire bridge, a polished nose bar — can be light
 * enough that the background fill walks through it, cutting the frame into
 * separate components. Picking the largest then keeps one lens ring and
 * throws the rest of the glasses away. Dilating before labelling rejoins
 * pieces that are merely a few pixels apart, and the grouping is then mapped
 * back onto the undilated mask so no thickness is invented.
 */
export function groupObject(solid, w, h) {
  const n = w * h;
  const { labels, components } = labelComponents(solid, w, h);
  if (!components.length) return null;

  const biggest = components.reduce((a, b) => (b.area > a.area ? b : a));

  // Every significant piece at roughly the same height belongs to the product.
  // A thin bright part — a wire bridge, a polished nose bar — can be light
  // enough that the background fill walks through it, cutting the frame into
  // pieces that a "largest component" rule then throws away: on a round wire
  // frame that leaves one lens ring and discards the other half of the
  // glasses. The vertical-overlap test is what keeps a caption or a speck in
  // the corner of the photo from being swept in along with them.
  // Proximity, not vertical overlap: in a top-down view the arms run
  // perpendicular to the front and barely share its rows, so an overlap test
  // discards them and the frame measures a few millimetres deep. Distance
  // between bounding boxes works whichever way the product is facing, and
  // still rejects a caption or a speck in the corner of the photo.
  const gap = Math.max(8, Math.hypot(w, h) * 0.04);
  const boxGap = (a, b) => {
    const dx = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
    const dy = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
    return Math.hypot(dx, dy);
  };

  const keep = new Set([biggest.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of components) {
      if (keep.has(c.id) || c.area < biggest.area * 0.015) continue;
      for (const other of components) {
        if (!keep.has(other.id)) continue;
        if (boxGap(c, other) <= gap) {
          keep.add(c.id);
          grew = true;
          break;
        }
      }
    }
  }

  const mask = new Uint8Array(n);
  let area = 0;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let sx = -1;
  let sy = -1;
  for (let i = 0; i < n; i++) {
    if (!solid[i] || !keep.has(labels[i])) continue;
    mask[i] = 1;
    area++;
    const x = i % w;
    const y = (i / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (sy < 0) {
      sx = x;
      sy = y;
    }
  }
  if (area === 0) return null;
  return { mask, area, minX, minY, maxX, maxY, sx, sy, pieces: keep.size };
}

export function segment(imageData, tolerance, options = {}) {
  const { data, width: w, height: h } = imageData;
  const n = w * h;
  const [br, bg, bb] = estimateBackground(imageData);
  const bgLike = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (colorDist(data, i * 4, br, bg, bb) < tolerance) bgLike[i] = 1;
  }

  // The flood may not cross a strong edge. Without this a light frame on a
  // light backdrop is simply absorbed: its colour is within tolerance, so the
  // fill walks straight through it. Its border still has a real gradient, and
  // stopping there keeps the rim in the object.
  const grad = options.gradient ?? gradientMagnitude(imageData);
  const edgeAt = options.edgeThreshold ?? Math.max(10, maskedPercentile(grad, null, 0.985));
  const blocked = new Uint8Array(n);
  for (let i = 0; i < n; i++) blocked[i] = grad[i] > edgeAt ? 1 : 0;

  // BFS from every border pixel through bgLike pixels.
  const borderBg = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  const seed = (i) => {
    if (bgLike[i] && !borderBg[i] && !blocked[i]) {
      borderBg[i] = 1;
      queue[qt++] = i;
    }
  };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % w, y = (i / w) | 0;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (y > 0) seed(i - w);
    if (y < h - 1) seed(i + w);
  }
  const solid = new Uint8Array(n);
  for (let i = 0; i < n; i++) solid[i] = borderBg[i] ? 0 : 1;
  return { solid, bgLike, borderBg, background: [br, bg, bb], grad, edgeAt };
}

/**
 * 4-connected component labelling. Returns { labels, components } where each
 * component is { id, area, minX, minY, maxX, maxY, sx, sy (topmost-leftmost
 * pixel), cx, cy (centroid) }.
 */
export function labelComponents(mask, w, h) {
  const n = w * h;
  const labels = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const components = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || labels[start] !== -1) continue;
    const id = components.length;
    let qh = 0, qt = 0;
    labels[start] = id;
    queue[qt++] = start;
    let area = 0, minX = w, minY = h, maxX = 0, maxY = 0, sumX = 0, sumY = 0;
    while (qh < qt) {
      const i = queue[qh++];
      const x = i % w, y = (i / w) | 0;
      area++;
      sumX += x; sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const tryPush = (j) => {
        if (mask[j] && labels[j] === -1) { labels[j] = id; queue[qt++] = j; }
      };
      if (x > 0) tryPush(i - 1);
      if (x < w - 1) tryPush(i + 1);
      if (y > 0) tryPush(i - w);
      if (y < h - 1) tryPush(i + w);
    }
    components.push({
      id, area, minX, minY, maxX, maxY,
      sx: start % w, sy: (start / w) | 0,
      cx: sumX / area, cy: sumY / area,
    });
  }
  return { labels, components };
}

/** Keep only one labelled component as a fresh mask. */
export function componentMask(labels, id, w, h) {
  const n = w * h;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (labels[i] === id) out[i] = 1;
  return out;
}

/**
 * Fill any enclosed holes of a mask (pixels not reachable from the image
 * border through non-mask pixels). Used for temple silhouettes and to make
 * lens blobs solid despite specular highlights.
 */
export function fillHoles(mask, w, h) {
  const n = w * h;
  const outside = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  const seed = (i) => {
    if (!mask[i] && !outside[i]) { outside[i] = 1; queue[qt++] = i; }
  };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % w, y = (i / w) | 0;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (y > 0) seed(i - w);
    if (y < h - 1) seed(i + w);
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

/**
 * Two-pass chamfer distance transform: distance (in px) from each mask pixel
 * to the nearest non-mask pixel. Good enough for rim bands and erosion.
 */
export function distanceToOutside(mask, w, h) {
  const n = w * h;
  const INF = 1e7;
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) dist[i] = mask[i] ? INF : 0;
  const D = Math.SQRT2;
  // Forward pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dist[i] === 0) continue;
      let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + 1);
      if (y > 0) {
        d = Math.min(d, dist[i - w] + 1);
        if (x > 0) d = Math.min(d, dist[i - w - 1] + D);
        if (x < w - 1) d = Math.min(d, dist[i - w + 1] + D);
      }
      dist[i] = d;
    }
  }
  // Backward pass
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (dist[i] === 0) continue;
      let d = dist[i];
      if (x < w - 1) d = Math.min(d, dist[i + 1] + 1);
      if (y < h - 1) {
        d = Math.min(d, dist[i + w] + 1);
        if (x < w - 1) d = Math.min(d, dist[i + w + 1] + D);
        if (x > 0) d = Math.min(d, dist[i + w - 1] + D);
      }
      dist[i] = d;
    }
  }
  return dist;
}

/** Median colour over the pixels of a mask (subsampled for speed). */
export function maskMedianColor(imageData, mask, step = 3) {
  const { data, width: w, height: h } = imageData;
  const rs = [], gs = [], bs = [];
  for (let i = 0; i < w * h; i += step) {
    if (!mask[i]) continue;
    const p = i * 4;
    rs.push(data[p]); gs.push(data[p + 1]); bs.push(data[p + 2]);
  }
  if (!rs.length) return [40, 40, 40];
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  return [med(rs), med(gs), med(bs)];
}

/** Mean colour over the pixels of a mask. */
export function maskMeanColor(imageData, mask) {
  const { data, width: w, height: h } = imageData;
  let r = 0, g = 0, b = 0, count = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    const p = i * 4;
    r += data[p]; g += data[p + 1]; b += data[p + 2];
    count++;
  }
  if (!count) return [40, 40, 40];
  return [r / count, g / count, b / count];
}

/**
 * Photo canvas with the object's colours bled outward over the background by
 * `passes` px, so extrusion bevels / texture filtering never pick up white
 * background fringes.
 */
export function makePaddedCanvas(imageData, mask, passes = 10) {
  const { width: w, height: h } = imageData;
  const n = w * h;
  const src = new Uint8ClampedArray(imageData.data); // copy
  const filled = new Uint8Array(mask);
  for (let pass = 0; pass < passes; pass++) {
    const nextFilled = new Uint8Array(filled);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (filled[i]) continue;
        let r = 0, g = 0, b = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (!filled[j]) continue;
            const p = j * 4;
            r += src[p]; g += src[p + 1]; b += src[p + 2];
            count++;
          }
        }
        if (count) {
          const p = i * 4;
          src[p] = r / count; src[p + 1] = g / count; src[p + 2] = b / count;
          src[p + 3] = 255;
          nextFilled[i] = 1;
        }
      }
    }
    filled.set(nextFilled);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').putImageData(new ImageData(src, w, h), 0, 0);
  return canvas;
}
