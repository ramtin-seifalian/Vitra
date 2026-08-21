/**
 * Turns a product photo into the vector + colour data the 3D builder needs.
 *
 * Front photo -> outer frame silhouette, lens apertures (three detection
 * tiers), rim colour, lens tint, and a background-padded texture canvas.
 * Side photo -> temple (arm) silhouette normalised hinge-left, hinge height.
 */
import {
  flipPhoto,
  segment,
  labelComponents,
  componentMask,
  fillHoles,
  distanceToOutside,
  maskMedianColor,
  maskMeanColor,
  makePaddedCanvas,
} from './segmentation.js';
import { extractContour, polygonArea } from './contours.js';

/**
 * Contour tolerance, in pixels, scaled to the photo. A fixed 1px tolerance
 * keeps every pixel stair-step of the mask boundary, and extruding those
 * gives the frame and temple edges a sawtooth look; tying it to the image
 * size keeps real design curves while dropping sampling noise.
 */
function contourEps(w, h) {
  return Math.max(1.2, Math.max(w, h) * 0.0035);
}

/** Luminance 0..1 of an [r,g,b] 0..255 colour. */
export function luminance([r, g, b]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Crop-safe sub-mask AND of two masks. */
function andMask(a, b, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i] && b[i] ? 1 : 0;
  return out;
}

/**
 * Pick up to two lens components from a candidate mask: the two largest that
 * sit on opposite halves of the frame, or one wide "shield" blob.
 */
function pickLensComponents(candMask, w, h, frame) {
  const { labels, components } = labelComponents(candMask, w, h);
  const frameW = frame.maxX - frame.minX + 1;
  const frameH = frame.maxY - frame.minY + 1;
  const minArea = frame.area * 0.02;
  const good = components
    .filter((c) => c.area >= minArea)
    .filter((c) => c.maxY - c.minY + 1 > frameH * 0.18)
    .sort((a, b) => b.area - a.area);
  if (!good.length) return null;
  const shield = good[0];
  if (shield.maxX - shield.minX + 1 > frameW * 0.62 && shield.area > frame.area * 0.18) {
    return { labels, picked: [shield] };
  }
  const centerX = (frame.minX + frame.maxX) / 2;
  const left = good.find((c) => c.cx < centerX);
  const right = good.find((c) => c.cx >= centerX);
  if (left && right && left !== right) return { labels, picked: [left, right] };
  return null;
}

/**
 * Analyse the front photo.
 * opts: { tolerance, rimFraction } — rimFraction only matters for the
 * geometric-inset fallback tier.
 */
export function analyzeFrontPhoto(imageData, opts = {}) {
  const { width: w, height: h } = imageData;
  const n = w * h;
  const tolerance = opts.tolerance ?? 42;

  const { solid, bgLike, borderBg } = segment(imageData, tolerance);
  const { labels: solidLabels, components: solidComps } = labelComponents(solid, w, h);
  if (!solidComps.length) throw new Error('no-object');
  const frame = solidComps.reduce((a, b) => (b.area > a.area ? b : a));
  if (frame.area < n * 0.02) throw new Error('object-too-small');
  const frameW = frame.maxX - frame.minX + 1;
  const frameMask = componentMask(solidLabels, frame.id, w, h);

  // ---- Tier 1: enclosed background-coloured regions = see-through lens holes.
  const holeCand = new Uint8Array(n);
  for (let i = 0; i < n; i++) holeCand[i] = bgLike[i] && !borderBg[i] && frameMask[i] ? 1 : 0;
  const holeLab = labelComponents(holeCand, w, h);
  const significantHoles = holeLab.components
    .filter((c) => c.area >= frame.area * 0.02)
    .sort((a, b) => b.area - a.area);

  // "object" = frame acetate/metal only (significant holes punched out),
  // for rim colour sampling and the distance transform.
  const objectMask = new Uint8Array(frameMask);
  const significantHoleIds = new Set(significantHoles.map((c) => c.id));
  if (significantHoles.length) {
    for (let i = 0; i < n; i++) {
      if (holeCand[i] && significantHoleIds.has(holeLab.labels[i])) objectMask[i] = 0;
    }
  }

  const dist = distanceToOutside(objectMask, w, h);
  const band = Math.max(2.5, w * 0.004);
  const rimBand = new Uint8Array(n);
  for (let i = 0; i < n; i++) rimBand[i] = objectMask[i] && dist[i] >= 1 && dist[i] <= band * 1.6 ? 1 : 0;
  const rimColor = maskMedianColor(imageData, rimBand, 2);

  let lensSource = null;
  let lensLabels = null;
  let lensPicked = null;

  if (significantHoles.length >= 1) {
    const picks = pickLensComponents(holeCand, w, h, frame);
    if (picks) {
      lensSource = 'holes';
      lensLabels = picks.labels;
      lensPicked = picks.picked;
    }
  }

  // ---- Tier 2: lenses differ in colour from the rim (sunglasses).
  if (!lensPicked) {
    const { data } = imageData;
    for (const thresh of [60, 44, 30]) {
      const cand = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (!objectMask[i] || dist[i] <= band * 1.8) continue;
        const p = i * 4;
        const d = Math.hypot(data[p] - rimColor[0], data[p + 1] - rimColor[1], data[p + 2] - rimColor[2]);
        if (d > thresh) cand[i] = 1;
      }
      const picks = pickLensComponents(cand, w, h, frame);
      if (picks) {
        // Fill specular-highlight holes inside each lens blob.
        for (const c of picks.picked) {
          const cm = fillHoles(componentMask(picks.labels, c.id, w, h), w, h);
          c.filledMask = cm;
        }
        lensSource = 'color';
        lensLabels = picks.labels;
        lensPicked = picks.picked;
        break;
      }
    }
  }

  // ---- Tier 3: geometric inset — erode the frame by a rim thickness.
  if (!lensPicked) {
    const rimPx = Math.max(3, frameW * (opts.rimFraction ?? 0.045));
    const cand = new Uint8Array(n);
    for (let i = 0; i < n; i++) cand[i] = objectMask[i] && dist[i] > rimPx ? 1 : 0;
    const picks = pickLensComponents(cand, w, h, frame);
    if (picks) {
      lensSource = 'inset';
      lensLabels = picks.labels;
      lensPicked = picks.picked;
    }
  }

  // ---- Contours.
  const eps = contourEps(w, h);
  const outerContour = extractContour(
    (x, y) => frameMask[y * w + x] === 1,
    w, h, frame.sx, frame.sy,
    { eps, smooth: 3 }
  );
  if (!outerContour || polygonArea(outerContour) < frame.area * 0.4) throw new Error('contour-failed');

  const apertures = [];
  let lensTint = null;
  if (lensPicked) {
    const tintMask = new Uint8Array(n);
    for (const c of lensPicked) {
      const cm = c.filledMask ?? componentMask(lensLabels, c.id, w, h);
      const contour = extractContour((x, y) => cm[y * w + x] === 1, w, h, c.sx, c.sy, {
        eps,
        smooth: 3,
      });
      if (contour) apertures.push(contour);
      if (lensSource !== 'holes') for (let i = 0; i < n; i++) if (cm[i]) tintMask[i] = 1;
    }
    if (lensSource !== 'holes') lensTint = maskMeanColor(imageData, tintMask);
  }

  // Hinge lug height: mean y of outer-contour points hugging the right edge.
  const lugXMin = frame.maxX - frameW * 0.03;
  const lugPts = outerContour.filter(([x]) => x >= lugXMin);
  const lugY = lugPts.length
    ? lugPts.reduce((s, p) => s + p[1], 0) / lugPts.length
    : (frame.minY + frame.maxY) / 2;

  return {
    width: w,
    height: h,
    frame,
    frameMask,
    outerContour,
    apertures,
    lensSource,
    lensTint,
    rimColor,
    lugY,
    paddedCanvas: makePaddedCanvas(imageData, frameMask, 10),
  };
}

/**
 * Analyse the side (temple/arm) photo. Auto-mirrors the photo so the hinge
 * end (the visually taller end) is on the left.
 */
export function analyzeTemplePhoto(photo, opts = {}, _flipped = false) {
  const { imageData } = photo;
  const { width: w, height: h } = imageData;
  const tolerance = opts.tolerance ?? 42;

  const { solid } = segment(imageData, tolerance);
  const { labels, components } = labelComponents(solid, w, h);
  if (!components.length) throw new Error('no-object');
  const comp = components.reduce((a, b) => (b.area > a.area ? b : a));
  if (comp.area < w * h * 0.01) throw new Error('object-too-small');
  const mask = fillHoles(componentMask(labels, comp.id, w, h), w, h);
  const compW = comp.maxX - comp.minX + 1;

  // Which end is the hinge? Compare mean column occupancy of the two ends.
  const endShare = Math.max(4, Math.round(compW * 0.18));
  const columnFill = (x0, x1) => {
    let count = 0;
    for (let x = x0; x <= x1; x++) for (let y = comp.minY; y <= comp.maxY; y++) count += mask[y * w + x];
    return count / (x1 - x0 + 1);
  };
  const leftFill = columnFill(comp.minX, comp.minX + endShare);
  const rightFill = columnFill(comp.maxX - endShare, comp.maxX);
  if (rightFill > leftFill * 1.25 && !_flipped) {
    return analyzeTemplePhoto(flipPhoto(photo), opts, true);
  }

  const contour = extractContour((x, y) => mask[y * w + x] === 1, w, h, comp.sx, comp.sy, {
    eps: contourEps(w, h),
    smooth: 3,
  });
  if (!contour) throw new Error('contour-failed');

  // Hinge-end vertical midpoint: mean y of mask pixels in the first columns.
  let sumY = 0, count = 0;
  for (let x = comp.minX; x <= comp.minX + endShare; x++) {
    for (let y = comp.minY; y <= comp.maxY; y++) {
      if (mask[y * w + x]) { sumY += y; count++; }
    }
  }
  const hingeMidY = count ? sumY / count : (comp.minY + comp.maxY) / 2;

  return {
    width: w,
    height: h,
    photo, // the (possibly mirrored) photo these coordinates belong to
    comp,
    mask,
    contour,
    hingeMidY,
    flipped: _flipped,
    color: maskMedianColor(imageData, mask, 2),
    paddedCanvas: makePaddedCanvas(imageData, mask, 8),
  };
}
