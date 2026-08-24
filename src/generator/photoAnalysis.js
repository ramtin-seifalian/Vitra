/**
 * Turns a product photo into the vector + colour data the 3D builder needs.
 *
 * Front photo -> outer frame silhouette, lens apertures (three detection
 * tiers), rim colour, lens tint, and a background-padded texture canvas.
 * Side photo -> temple (arm) silhouette normalised hinge-left, hinge height.
 */
import {
  segment,
  groupObject,
  gradientMagnitude,
  maskedPercentile,
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
 * Score how well two components read as the left and right lens of one frame.
 *
 * The strongest thing known about a pair of lens apertures is that they are
 * mirror images about the frame's centreline: same size, same height, equal
 * and opposite offsets. The rim, whatever its colour, does not form such a
 * pair — so symmetry separates lenses from everything else without relying on
 * any assumption about what colour either one is.
 *
 * Returns a cost; lower is better, Infinity means "not a plausible pair".
 */
function pairCost(a, b, frame) {
  const centerX = (frame.minX + frame.maxX) / 2;
  const frameW = frame.maxX - frame.minX + 1;
  const frameH = frame.maxY - frame.minY + 1;
  if (a.cx >= centerX || b.cx <= centerX) return Infinity;

  const offsetSkew = Math.abs((centerX - a.cx) - (b.cx - centerX)) / frameW;
  const areaSkew = Math.abs(a.area - b.area) / Math.max(a.area, b.area);
  const heightSkew = Math.abs(a.cy - b.cy) / frameH;
  const sizeSkew =
    Math.abs((a.maxY - a.minY) - (b.maxY - b.minY)) / Math.max(a.maxY - a.minY, b.maxY - b.minY, 1);

  if (offsetSkew > 0.12 || areaSkew > 0.45 || heightSkew > 0.12) return Infinity;
  // Prefer big, well-matched pairs: area is what tells a lens from a stray
  // reflection that happens to have a mirror twin.
  return offsetSkew * 3 + areaSkew * 2 + heightSkew * 3 + sizeSkew - (a.area + b.area) / frame.area;
}

/** Best mirror-symmetric pair among candidate components, or null. */
function bestPair(components, frame) {
  let best = null;
  let bestCost = Infinity;
  for (let i = 0; i < components.length; i++) {
    for (let j = 0; j < components.length; j++) {
      if (i === j) continue;
      const cost = pairCost(components[i], components[j], frame);
      if (cost < bestCost) {
        bestCost = cost;
        best = [components[i], components[j]];
      }
    }
  }
  return best;
}

/**
 * Structural lens detection: the apertures are the thick, mirror-paired
 * regions the rim encloses.
 *
 * This asks nothing about colour. A region is a lens candidate if it is a
 * blob rather than a sliver (the rim is thin, a lens is not) and if it has a
 * mirror twin. That holds for clear lenses, black lenses on a black frame,
 * and mirrored lenses alike, where every colour rule fails on at least one.
 */
function pickLensByStructure(frameMask, grad, w, h, frame, trace) {
  const n = w * h;

  // The threshold has to be measured *inside* the frame. Taken over the whole
  // image it is set by the object's edge against the backdrop, which is far
  // stronger than the rim-to-lens boundary, so every interior edge falls under
  // it and the rim and lenses merge into one blob.
  const inner = new Uint8Array(n);
  const distIn = distanceToOutside(frameMask, w, h);
  const skin = Math.max(2, w * 0.004);
  for (let i = 0; i < n; i++) inner[i] = frameMask[i] && distIn[i] > skin ? 1 : 0;
  const edgeAt = Math.max(6, maskedPercentile(grad, inner, 0.88));
  if (trace) trace.interiorEdgeAt = +edgeAt.toFixed(1);

  const interior = new Uint8Array(n);
  for (let i = 0; i < n; i++) interior[i] = frameMask[i] && grad[i] <= edgeAt ? 1 : 0;

  const dist = distanceToOutside(interior, w, h);
  const { labels, components } = labelComponents(interior, w, h);
  if (trace) trace.structureComponents = components.length;
  if (!components.length) return null;

  const thickness = new Map();
  for (let i = 0; i < n; i++) {
    if (!interior[i]) continue;
    const id = labels[i];
    if (dist[i] > (thickness.get(id) ?? 0)) thickness.set(id, dist[i]);
  }

  const frameH = frame.maxY - frame.minY + 1;
  const candidates = components.filter(
    (c) => c.area >= frame.area * 0.03 && (thickness.get(c.id) ?? 0) >= frameH * 0.07
  );
  if (trace) trace.structureCandidateCount = candidates.length;
  if (candidates.length < 2) return null;

  if (trace) {
    trace.structureCandidates = candidates
      .sort((a, b) => b.area - a.area)
      .slice(0, 6)
      .map((c) => ({
        area: +(c.area / frame.area).toFixed(3),
        thick: +((thickness.get(c.id) ?? 0) / frameH).toFixed(3),
        cx: +((c.cx - frame.minX) / (frame.maxX - frame.minX)).toFixed(2),
        cy: +((c.cy - frame.minY) / frameH).toFixed(2),
      }));
  }
  const pair = bestPair(candidates, frame);
  if (trace) trace.structurePaired = !!pair;
  if (!pair) return null;

  // A mirrored or gradient lens is broken up by its own highlights, so close
  // each blob's holes before its outline is traced.
  for (const c of pair) c.filledMask = fillHoles(componentMask(labels, c.id, w, h), w, h);
  return { labels, picked: pair };
}

/**
 * Rim thickness, measured where the rim actually is.
 *
 * Deriving it from the outer bounding box — half-width minus the lens edge —
 * silently measures the temples instead: in a front-on photo the arms stick
 * out past the front on both sides, so a 7mm rim reads as 18mm and every
 * dimension derived from it follows. Here each point of the aperture outline
 * is asked how far it is from the outside of the frame, which is the rim's
 * local thickness, and the answer is taken as a median per region so a single
 * bad boundary point cannot move it.
 */
function measureRimPx(frameMask, apertures, w, h, frame) {
  const dist = distanceToOutside(frameMask, w, h);
  const centerX = (frame.minX + frame.maxX) / 2;
  const side = [];
  const top = [];
  const bottom = [];

  for (const contour of apertures) {
    let cx = 0;
    let cy = 0;
    for (const [x, y] of contour) {
      cx += x;
      cy += y;
    }
    cx /= contour.length;
    cy /= contour.length;

    for (const [x, y] of contour) {
      const px = Math.min(w - 1, Math.max(0, Math.round(x)));
      const py = Math.min(h - 1, Math.max(0, Math.round(y)));
      const d = dist[py * w + px];
      if (!(d > 0)) continue;
      const dx = x - cx;
      const dy = y - cy;
      // Classify by which way the outline is facing at this point.
      if (Math.abs(dx) > Math.abs(dy)) {
        // Only the outboard flank measures the side rim; the inboard flank
        // measures the bridge, which is a different thickness.
        if ((cx < centerX && dx < 0) || (cx >= centerX && dx > 0)) side.push(d);
      } else if (dy < 0) top.push(d);
      else bottom.push(d);
    }
  }

  const median = (a) => {
    if (!a.length) return null;
    const s2 = a.slice().sort((p, q) => p - q);
    return s2[s2.length >> 1];
  };
  return { side: median(side), top: median(top), bottom: median(bottom) };
}

/**
 * Trim the front silhouette down to the frame front, dropping the temples.
 *
 * In a front-on photo the arms are visible past both ends of the front. Left
 * in, they become part of the extruded front and inflate the frame's width.
 * A column belongs to the front if it carries most of the frame's height, or
 * if it is within the span the lenses themselves occupy.
 */
function trimTemples(frameMask, w, h, frame, apertures) {
  const extent = new Int32Array(w);
  for (let x = frame.minX; x <= frame.maxX; x++) {
    let lo = -1;
    let hi = -1;
    for (let y = frame.minY; y <= frame.maxY; y++) {
      if (frameMask[y * w + x]) {
        if (lo < 0) lo = y;
        hi = y;
      }
    }
    extent[x] = lo < 0 ? 0 : hi - lo + 1;
  }
  let maxExtent = 0;
  for (let x = frame.minX; x <= frame.maxX; x++) maxExtent = Math.max(maxExtent, extent[x]);

  // The lenses must stay inside the kept span whatever the height test says.
  let apMin = Infinity;
  let apMax = -Infinity;
  for (const c of apertures) {
    for (const [x] of c) {
      if (x < apMin) apMin = x;
      if (x > apMax) apMax = x;
    }
  }

  const tall = (x) => extent[x] >= maxExtent * 0.55;
  let lo = Math.round(apMin);
  let hi = Math.round(apMax);
  while (lo > frame.minX && tall(lo - 1)) lo--;
  while (hi < frame.maxX && tall(hi + 1)) hi++;

  const trimmed = new Uint8Array(w * h);
  for (let y = frame.minY; y <= frame.maxY; y++) {
    for (let x = lo; x <= hi; x++) trimmed[y * w + x] = frameMask[y * w + x];
  }
  return { trimmed, lo, hi, trimmedFraction: 1 - (hi - lo + 1) / (frame.maxX - frame.minX + 1) };
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

  const trace = opts.trace ?? null;
  const grad = gradientMagnitude(imageData);
  const { solid, bgLike, borderBg, edgeAt } = segment(imageData, tolerance, { gradient: grad });
  if (trace) trace.edgeAt = +edgeAt.toFixed(1);
  const { components: solidComps } = labelComponents(solid, w, h);
  const grouped = groupObject(solid, w, h);
  if (!grouped) throw new Error('no-object');
  const frame = grouped;
  if (frame.area < n * 0.02) throw new Error('object-too-small');
  const frameW = frame.maxX - frame.minX + 1;
  const frameMask = frame.mask;
  if (trace) {
    trace.solidComponents = solidComps.length;
    trace.pieces = frame.pieces;
    trace.groupedAreaGain = +(frame.area / Math.max(...solidComps.map((c) => c.area), 1)).toFixed(2);
    trace.solidTop = solidComps
      .slice()
      .sort((a, b) => b.area - a.area)
      .slice(0, 5)
      .map((c) => ({ a: c.area, box: [c.minX, c.minY, c.maxX, c.maxY] }));
    trace.frameAreaFrac = +(frame.area / n).toFixed(3);
    trace.frameBox = [frame.minX, frame.minY, frame.maxX, frame.maxY];
  }

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
  // Provisional rim colour, used only to drive the colour-split tier below.
  // It is re-measured properly once the lenses are known.
  const rimBand = new Uint8Array(n);
  for (let i = 0; i < n; i++) rimBand[i] = objectMask[i] && dist[i] >= 1 && dist[i] <= band * 1.6 ? 1 : 0;
  let rimColor = maskMedianColor(imageData, rimBand, 2);

  let lensSource = null;
  let lensLabels = null;
  let lensPicked = null;

  // ---- Tier 0: structural — thick, mirror-paired regions inside the rim.
  {
    const picks = pickLensByStructure(frameMask, grad, w, h, frame, trace);
    if (picks) {
      lensSource = 'structure';
      lensLabels = picks.labels;
      lensPicked = picks.picked;
    }
  }

  if (!lensPicked && significantHoles.length >= 1) {
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

  // Re-measure the frame's colour now that the lenses are known: everything
  // inside the silhouette that is not a lens, stepped in from the boundary.
  //
  // Sampling the outermost pixels instead — as the provisional pass above
  // does — reads the anti-aliased edge, where the frame blends into the
  // backdrop. On a black frame shot on white that returns near-white, and the
  // whole model comes out the colour of the background instead of the frame.
  if (lensPicked) {
    const notLens = new Uint8Array(frameMask);
    for (const c of lensPicked) {
      const cm = c.filledMask ?? componentMask(lensLabels, c.id, w, h);
      for (let i = 0; i < n; i++) if (cm[i]) notLens[i] = 0;
    }
    const rimDist = distanceToOutside(notLens, w, h);
    for (const inset of [band * 1.6, band * 0.9, 1]) {
      const sample = new Uint8Array(n);
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (notLens[i] && rimDist[i] >= inset) {
          sample[i] = 1;
          count++;
        }
      }
      if (count > 40) {
        rimColor = maskMedianColor(imageData, sample, 2);
        break;
      }
    }
  }

  // The front's own silhouette, with the arms trimmed off, plus the rim
  // measured against it.
  const trim = apertures.length ? trimTemples(frameMask, w, h, frame, apertures) : null;
  const frontMask = trim ? trim.trimmed : frameMask;
  let frontSx = frame.sx;
  let frontSy = frame.sy;
  if (trim) {
    outer: for (let y = frame.minY; y <= frame.maxY; y++) {
      for (let x = trim.lo; x <= trim.hi; x++) {
        if (frontMask[y * w + x]) {
          frontSx = x;
          frontSy = y;
          break outer;
        }
      }
    }
  }
  if (trace && trim) trace.trimmedFraction = +trim.trimmedFraction.toFixed(3);
  // The width the user measures with a ruler is the front's, not the span of
  // the splayed arms, so the scale must come from the trimmed silhouette.
  const frontWidthPx = trim ? trim.hi - trim.lo + 1 : frame.maxX - frame.minX + 1;
  const frontMinX = trim ? trim.lo : frame.minX;

  const outerContour = extractContour(
    (x, y) => frontMask[y * w + x] === 1,
    w, h, frontSx, frontSy,
    { eps, smooth: 3 }
  );
  if (!outerContour || outerContour.length < 8) throw new Error('contour-failed');

  const rimPx = apertures.length ? measureRimPx(frontMask, apertures, w, h, frame) : null;
  if (trace) trace.rimPx = rimPx;

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
    frontMask,
    frontWidthPx,
    frontMinX,
    outerContour,
    rimPx,
    trace,
    apertures,
    lensSource,
    lensTint,
    rimColor,
    lugY,
    paddedCanvas: makePaddedCanvas(imageData, frameMask, 10),
  };
}

/**
 * Analyse a photo taken looking straight down on the glasses, temples open.
 *
 * This is the view that carries everything the front cannot see. From the
 * front, a frame's thickness, the curve it wraps around the face, and the
 * length of its arms are all invisible — they were previously guessed from
 * the rim's width, which is why a reconstruction could match the photo head-on
 * and still be wrong the moment it was turned. Looking down, all three are
 * measured directly, and the view scales itself: its widest span IS the front
 * width the user has already entered.
 *
 * Returns measurements in pixels plus the curvature, all relative to this
 * photo's own frame width, so the caller converts with a single scale.
 */
export function analyzeTopPhoto(photo, opts = {}) {
  const { imageData } = photo;
  const { width: w, height: h } = imageData;
  const tolerance = opts.tolerance ?? 42;

  const grad = gradientMagnitude(imageData);
  const { solid } = segment(imageData, tolerance, { gradient: grad });
  const obj = groupObject(solid, w, h);
  if (!obj) throw new Error('no-object');
  const { mask } = obj;

  const widthPx = obj.maxX - obj.minX + 1;
  const heightPx = obj.maxY - obj.minY + 1;
  if (widthPx < 20 || heightPx < 10) throw new Error('object-too-small');

  // Which end of the photo is the front? The front spans the full width; the
  // arms are two narrow bars. Coverage tells them apart, so the user does not
  // have to remember which way round to hold the camera.
  const rowCoverage = (y) => {
    let c = 0;
    for (let x = obj.minX; x <= obj.maxX; x++) if (mask[y * w + x]) c++;
    return c / widthPx;
  };
  let nearSum = 0;
  let farSum = 0;
  const band = Math.max(1, Math.round(heightPx * 0.15));
  for (let k = 0; k < band; k++) {
    nearSum += rowCoverage(obj.minY + k);
    farSum += rowCoverage(obj.maxY - k);
  }
  const frontAtTop = nearSum >= farSum;
  const rowOf = (i) => (frontAtTop ? obj.minY + i : obj.maxY - i);

  // Front edge profile: how far back the front's leading edge sits at each
  // column. Its curvature is the face-form wrap.
  const xs = [];
  const ys = [];
  for (let x = obj.minX; x <= obj.maxX; x++) {
    for (let i = 0; i < heightPx; i++) {
      const y = rowOf(i);
      if (mask[y * w + x]) {
        xs.push(x);
        ys.push(i);
        break;
      }
    }
  }
  if (xs.length < 8) throw new Error('contour-failed');

  // Keep only the columns the FRONT occupies. The arms usually splay wider
  // than the front, and in those outer columns the first thing the camera
  // sees is an arm, sitting far back. Fitting the face-form curve through
  // those points bends the front dramatically when it is in fact straight —
  // and they inflate the width the whole view is scaled by.
  const sortedYs = ys.slice().sort((a, b) => a - b);
  const medianY = sortedYs[sortedYs.length >> 1];

  // Two passes. A flat fraction of the photo's depth is the wrong yardstick
  // for "still part of the front": on a wrapped frame the ends curve back
  // further than that and get cut, which shrinks the width this view is
  // scaled by and inflates every measurement taken from it. The first pass
  // gets a rough thickness; the second uses it as the real tolerance.
  const collect = (limit) => {
    const fxs = [];
    const fys = [];
    for (let i = 0; i < xs.length; i++) {
      if (ys[i] <= limit) {
        fxs.push(xs[i]);
        fys.push(ys[i]);
      }
    }
    return { fxs, fys };
  };

  let picked = collect(medianY + Math.max(3, heightPx * 0.12));
  if (picked.fxs.length >= 8) {
    // Bounded: unbounded, a strongly wrapped front makes the tolerance large
    // enough to swallow the arms, and then the view is scaled by the whole
    // object instead of the front — which collapses every length it reports.
    const roughDepth = Math.max(2, sortedYs[Math.floor(sortedYs.length * 0.75)] - medianY);
    const widened = collect(
      medianY + Math.min(Math.max(3, roughDepth * 4), heightPx * 0.3)
    );
    if (widened.fxs.length >= 8) picked = widened;
  }
  const { fxs, fys } = picked;
  if (fxs.length < 8) throw new Error('contour-failed');
  const frontMinX = Math.min(...fxs);
  const frontMaxX = Math.max(...fxs);
  const frontWidthPx = frontMaxX - frontMinX + 1;

  // Least squares fit of depth = a + k*(x - cx)^2 over the front edge.
  const cx = (frontMinX + frontMaxX) / 2;
  let s0 = 0;
  let s2 = 0;
  let s4 = 0;
  let sy = 0;
  let sy2 = 0;
  for (let i = 0; i < fxs.length; i++) {
    const u = (fxs[i] - cx) ** 2;
    s0 += 1;
    s2 += u;
    s4 += u * u;
    sy += fys[i];
    sy2 += fys[i] * u;
  }
  const det = s0 * s4 - s2 * s2;
  const wrapKPx = Math.abs(det) < 1e-6 ? 0 : (s0 * sy2 - s2 * sy) / det;

  // Front thickness, measured at the bridge: the centre columns contain only
  // the front, never an arm, so the run of object pixels there is its depth.
  const depths = [];
  const centreBand = Math.max(2, Math.round(frontWidthPx * 0.06));
  for (let x = Math.round(cx - centreBand); x <= Math.round(cx + centreBand); x++) {
    if (x < obj.minX || x > obj.maxX) continue;
    let started = false;
    let run = 0;
    for (let i = 0; i < heightPx; i++) {
      const on = mask[rowOf(i) * w + x] === 1;
      if (on) {
        started = true;
        run++;
      } else if (started) break;
    }
    if (run > 0) depths.push(run);
  }
  depths.sort((a, b) => a - b);
  const frontDepthPx = depths.length ? depths[depths.length >> 1] : Math.max(2, widthPx * 0.03);

  // Arm splay: how much wider the arms sit than the hinges they leave from,
  // measured between the front and the far end.
  const spanAt = (i) => {
    let lo = -1;
    let hi = -1;
    const y = rowOf(i);
    for (let x = obj.minX; x <= obj.maxX; x++) {
      if (mask[y * w + x]) {
        if (lo < 0) lo = x;
        hi = x;
      }
    }
    return lo < 0 ? null : { lo, hi };
  };
  const nearArm = spanAt(Math.min(heightPx - 1, Math.round(frontDepthPx * 1.6)));
  const farArm = spanAt(Math.max(0, heightPx - 1 - Math.round(heightPx * 0.08)));
  let splayRad = 0;
  if (nearArm && farArm) {
    const run = Math.max(1, heightPx - frontDepthPx * 1.6);
    splayRad = Math.atan(((farArm.hi - farArm.lo) - (nearArm.hi - nearArm.lo)) / 2 / run);
  }

  return {
    width: w,
    height: h,
    photo,
    mask,
    obj,
    widthPx,
    frontWidthPx,
    frontDepthPx,
    totalDepthPx: heightPx,
    wrapKPx,
    splayRad,
    frontAtTop,
  };
}

/**
 * Analyse a photo of the whole pair seen from the side, temples open.
 *
 * The earlier side analysis wanted a photo of a single detached arm, which is
 * both an awkward thing to ask for and throws away what a real side view
 * carries: the front's thickness, the angle it leans at, and where the arm
 * bends over the ear. Here the front and the arm are separated by their own
 * profile — the front is the tall part at one end, the arm the long low one —
 * so the natural photo works and measures more.
 */
export function analyzeSidePhoto(photo, opts = {}) {
  const { imageData } = photo;
  const { width: w, height: h } = imageData;
  const tolerance = opts.tolerance ?? 42;

  const grad = gradientMagnitude(imageData);
  const { solid } = segment(imageData, tolerance, { gradient: grad });
  const obj = groupObject(solid, w, h);
  if (!obj) throw new Error('no-object');
  const { mask } = obj;
  const spanW = obj.maxX - obj.minX + 1;
  const spanH = obj.maxY - obj.minY + 1;
  if (spanW < 20 || spanH < 10) throw new Error('object-too-small');

  const columnRun = (x) => {
    let lo = -1;
    let hi = -1;
    for (let y = obj.minY; y <= obj.maxY; y++) {
      if (mask[y * w + x]) {
        if (lo < 0) lo = y;
        hi = y;
      }
    }
    return lo < 0 ? null : { lo, hi, mid: (lo + hi) / 2, height: hi - lo + 1 };
  };

  const runs = [];
  let maxHeight = 0;
  for (let x = obj.minX; x <= obj.maxX; x++) {
    const r = columnRun(x);
    runs.push(r);
    if (r && r.height > maxHeight) maxHeight = r.height;
  }

  // Which end is the front? It is the tall one. Detecting it means the user
  // does not have to face the glasses a particular way.
  const band = Math.max(1, Math.round(spanW * 0.15));
  let leftTall = 0;
  let rightTall = 0;
  for (let k = 0; k < band; k++) {
    leftTall += runs[k]?.height ?? 0;
    rightTall += runs[runs.length - 1 - k]?.height ?? 0;
  }
  const frontAtLeft = leftTall >= rightTall;
  const ordered = frontAtLeft ? runs : runs.slice().reverse();

  // The front runs from that end for as long as the profile stays tall.
  let frontDepthPx = 0;
  while (
    frontDepthPx < ordered.length &&
    (ordered[frontDepthPx]?.height ?? 0) >= maxHeight * 0.62
  ) {
    frontDepthPx++;
  }
  frontDepthPx = Math.max(frontDepthPx, 2);
  const frontHeightPx = maxHeight;

  // Pantoscopic tilt: the lean of the front's leading edge. Positive means the
  // bottom of the front sits closer to the face, as a worn frame does.
  const edgeXs = [];
  const edgeYs = [];
  for (let y = obj.minY; y <= obj.maxY; y++) {
    for (let i = 0; i < ordered.length; i++) {
      const x = frontAtLeft ? obj.minX + i : obj.maxX - i;
      if (mask[y * w + x]) {
        if (i < frontDepthPx * 2) {
          edgeXs.push(i);
          edgeYs.push(y);
        }
        break;
      }
    }
  }
  let pantoscopic = 0;
  if (edgeXs.length > 6) {
    const n2 = edgeXs.length;
    const mx = edgeXs.reduce((a, b) => a + b, 0) / n2;
    const my = edgeYs.reduce((a, b) => a + b, 0) / n2;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n2; i++) {
      num += (edgeYs[i] - my) * (edgeXs[i] - mx);
      den += (edgeYs[i] - my) ** 2;
    }
    // dx per dy; a front leaning back at the top gives a positive angle.
    if (den > 1e-6) pantoscopic = Math.atan(num / den);
  }

  // The arm: everything past the front, measured at stations that follow it.
  const armStart = frontDepthPx;
  const armLenPx = Math.max(1, ordered.length - armStart);
  const stationCount = 24;
  const picked = [];
  let prevMid = null;
  for (let s = 0; s < stationCount; s++) {
    const i = armStart + Math.round(((s + 0.5) / stationCount) * (armLenPx - 1));
    const r = ordered[Math.min(i, ordered.length - 1)];
    if (!r) {
      picked.push(null);
      continue;
    }
    prevMid = r.mid;
    picked.push(r);
  }
  const first = picked.find(Boolean);
  const baseHeight = first ? first.height : Math.max(2, maxHeight * 0.3);

  const heights = picked.map((p) => (p ? p.height / baseHeight : null));
  for (let s = 0; s < stationCount; s++) {
    if (heights[s] == null) heights[s] = heights.slice(0, s).filter((v) => v != null).pop() ?? 1;
  }
  for (let s = 1; s < stationCount; s++) heights[s] = Math.min(heights[s], heights[s - 1]);
  const smooth = heights.map((_, i) => {
    const a = heights[Math.max(i - 1, 0)];
    const b = heights[i];
    const c = heights[Math.min(i + 1, stationCount - 1)];
    return (a + 2 * b + c) / 4;
  });

  // Ear bend: how far the arm's centreline drops, and where it starts to.
  const startMid = first ? first.mid : 0;
  let drop = 0;
  for (const p of picked) if (p) drop = Math.max(drop, p.mid - startMid);
  let bendAt = 0.78;
  if (drop > baseHeight * 0.35) {
    for (let s = stationCount - 1; s >= 0; s--) {
      if (picked[s] && picked[s].mid - startMid < drop * 0.25) {
        bendAt = (s + 0.5) / stationCount;
        break;
      }
    }
  }

  return {
    width: w,
    height: h,
    photo,
    mask,
    obj,
    frontAtLeft,
    frontDepthPx,
    frontHeightPx,
    armLengthPx: armLenPx,
    armBaseHeightPx: baseHeight,
    earDropPx: drop,
    pantoscopic,
    stations: smooth,
    bendAt,
  };
}
