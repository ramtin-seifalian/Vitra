/**
 * Turning traced pixel outlines into a *frame specification*.
 *
 * A boundary traced off a photo is a noisy, slightly asymmetric polygon: it
 * carries lens flare, JPEG fringing, a shadow on one side, and whatever the
 * segmentation got wrong. Extruding that directly is what makes a
 * reconstruction look like a photo cut-out rather than a product.
 *
 * Real glasses are manufactured objects, and that is prior knowledge worth
 * using. This module imposes it:
 *   - the two lens apertures are mirror images of one another, so they are
 *     averaged into ONE canonical aperture used (mirrored) on both sides;
 *   - the front is symmetric about its own vertical axis, so the outer
 *     silhouette is folded onto itself and averaged;
 *   - a designed edge is smooth, so every curve is low-pass filtered in the
 *     Fourier domain — enough harmonics to keep round/square/cat-eye
 *     distinct, few enough to erase pixel noise.
 *
 * The output is a measured spec (lens width/height, bridge, rim thicknesses)
 * plus clean curves, which the builder turns into real geometry. Nothing
 * here ever samples the photo's pixels for appearance.
 *
 * All input and output points are in centimetres, in front-local space:
 * origin at the centre of the frame, +x right, +y up.
 */

// ---------------------------------------------------------------- primitives

/** Signed area; positive when the ring winds counter-clockwise. */
function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function ensureCCW(pts) {
  return signedArea(pts) < 0 ? pts.slice().reverse() : pts;
}

export function centroidOf(pts) {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

export function boundsOf(pts) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

/** Resample a closed ring to n points spaced evenly along its arc length. */
export function resampleClosed(pts, n) {
  const m = pts.length;
  const seg = new Float64Array(m);
  let total = 0;
  for (let i = 0; i < m; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % m];
    seg[i] = Math.hypot(q.x - p.x, q.y - p.y);
    total += seg[i];
  }
  if (total === 0) return pts.slice(0, 1);

  const out = [];
  const step = total / n;
  let i = 0;
  let walked = 0; // arc length consumed within segment i
  for (let k = 0; k < n; k++) {
    let target = k * step;
    while (i < m - 1 && walked + seg[i] < target) {
      walked += seg[i];
      i++;
    }
    const t = seg[i] > 0 ? (target - walked) / seg[i] : 0;
    const p = pts[i];
    const q = pts[(i + 1) % m];
    out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  }
  return out;
}

/**
 * Cyclic shift of `b` that best matches `a` (both already resampled to the
 * same length). Two rings traced from different blobs start at arbitrary
 * points, so they must be phase-aligned before they can be averaged.
 */
function bestShift(a, b) {
  const n = a.length;
  let bestK = 0;
  let bestCost = Infinity;
  // Coarse pass: every 4th shift, on every other point.
  for (let k = 0; k < n; k += 4) {
    let cost = 0;
    for (let i = 0; i < n; i += 2) {
      const p = a[i];
      const q = b[(i + k) % n];
      cost += (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (cost >= bestCost) break;
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestK = k;
    }
  }
  // Fine pass around the winner, at full resolution.
  bestCost = Infinity;
  const coarse = bestK;
  for (let k = coarse - 4; k <= coarse + 4; k++) {
    const kk = ((k % n) + n) % n;
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const p = a[i];
      const q = b[(i + kk) % n];
      cost += (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestK = kk;
    }
  }
  return bestK;
}

function averageRings(a, b) {
  const k = bestShift(a, b);
  const n = a.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = a[i];
    const q = b[(i + k) % n];
    out[i] = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  }
  return out;
}

/**
 * Low-pass a closed curve in the Fourier domain (an elliptic Fourier
 * descriptor truncated to `harmonics` terms). This is what converts a traced
 * outline into a *designed* one: harmonic 1 is the base ellipse, and each
 * further harmonic adds a level of corner definition. Around 10 keeps a
 * square frame's corners crisp and a cat-eye's flick intact while pixel-level
 * jitter — which lives in the high harmonics — disappears.
 */
export function fourierSmooth(pts, harmonics = 10) {
  const n = pts.length;
  const h = Math.min(harmonics, Math.floor(n / 2) - 1);
  const out = new Array(n);
  // Coefficients for m in [-h, h]; m=0 is the centroid.
  const re = new Float64Array(2 * h + 1);
  const im = new Float64Array(2 * h + 1);
  for (let mi = 0; mi <= 2 * h; mi++) {
    const m = mi - h;
    let ar = 0;
    let ai = 0;
    for (let k = 0; k < n; k++) {
      const ang = (-2 * Math.PI * m * k) / n;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      ar += pts[k].x * c - pts[k].y * s;
      ai += pts[k].x * s + pts[k].y * c;
    }
    re[mi] = ar / n;
    im[mi] = ai / n;
  }
  for (let k = 0; k < n; k++) {
    let xr = 0;
    let xi = 0;
    for (let mi = 0; mi <= 2 * h; mi++) {
      const m = mi - h;
      const ang = (2 * Math.PI * m * k) / n;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      xr += re[mi] * c - im[mi] * s;
      xi += re[mi] * s + im[mi] * c;
    }
    out[k] = { x: xr, y: xi };
  }
  return out;
}

/**
 * Gentle Laplacian smoothing of a closed ring.
 *
 * Fourier truncation is the right tool for a lens aperture — a closed, convex
 * shape a dozen harmonics describe well — but the wrong one for the outer
 * silhouette, which has long straight runs and small hinge lugs. Those need
 * high harmonics, so truncating rings (Gibbs) and the frame's edges come out
 * visibly wavy. Local averaging removes trace noise without that.
 */
export function smoothRing(pts, iterations = 3, weight = 0.5) {
  let cur = pts;
  const n = pts.length;
  for (let it = 0; it < iterations; it++) {
    const next = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = cur[i];
      const a = cur[(i - 1 + n) % n];
      const b = cur[(i + 1) % n];
      next[i] = {
        x: p.x + weight * ((a.x + b.x) / 2 - p.x),
        y: p.y + weight * ((a.y + b.y) / 2 - p.y),
      };
    }
    cur = next;
  }
  return cur;
}

// ------------------------------------------------------------- symmetrizing

/** Mirror a ring about x = axis, restoring its winding direction. */
function mirrorX(pts, axis = 0) {
  return pts.map((p) => ({ x: 2 * axis - p.x, y: p.y })).reverse();
}

/**
 * Fold a closed ring onto its own mirror image and average — the front of a
 * pair of glasses is symmetric, so this removes the asymmetry a photo's
 * lighting and perspective introduce.
 */
export function symmetrizeAboutAxis(pts, axis = 0, n = 256) {
  const a = resampleClosed(ensureCCW(pts), n);
  const b = resampleClosed(ensureCCW(mirrorX(a, axis)), n);
  return averageRings(a, b);
}

/**
 * Average the two lens apertures into one canonical aperture, centred on the
 * origin. Both eyes of a real frame are cut from the same template, so the
 * pair carries two noisy observations of a single shape — averaging them
 * halves the noise, and using the result on both sides guarantees the
 * symmetry a manufactured frame has.
 */
export function canonicalAperture(left, right, n = 256, harmonics = 10) {
  const rings = [];
  for (const [pts, mirror] of [[left, false], [right, true]]) {
    if (!pts) continue;
    const ring = mirror ? mirrorX(pts, 0) : pts;
    const c = centroidOf(ring);
    rings.push(resampleClosed(ensureCCW(ring.map((p) => ({ x: p.x - c.x, y: p.y - c.y }))), n));
  }
  const merged = rings.length === 2 ? averageRings(rings[0], rings[1]) : rings[0];
  const smoothed = fourierSmooth(merged, harmonics);
  const c = centroidOf(smoothed);
  return smoothed.map((p) => ({ x: p.x - c.x, y: p.y - c.y }));
}

// ------------------------------------------------------------- measuring

/**
 * Shape family, from the aperture's proportions and where it carries its
 * width. Reported to the user, and used to pick sensible rim styling.
 */
export function classifyAperture(pts) {
  const b = boundsOf(pts);
  const ratio = b.width / Math.max(b.height, 1e-6);

  // "Fill": how much of the bounding box the outline actually occupies. A
  // circle fills ~0.79, a rounded square ~0.95.
  const fill = Math.abs(signedArea(pts)) / Math.max(b.width * b.height, 1e-6);

  // Where the widest part sits vertically, as a fraction of height from the
  // bottom. A cat-eye is widest high up; an aviator low.
  let widestY = 0;
  let widest = -1;
  const rows = 24;
  for (let r = 0; r < rows; r++) {
    const y = b.minY + ((r + 0.5) / rows) * b.height;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      if ((p.y <= y && q.y > y) || (q.y <= y && p.y > y)) {
        const t = (y - p.y) / (q.y - p.y);
        const x = p.x + (q.x - p.x) * t;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
    if (hi - lo > widest) {
      widest = hi - lo;
      widestY = (y - b.minY) / b.height;
    }
  }

  if (fill > 0.86) return ratio > 1.45 ? 'مستطیلی' : 'مربعی';
  if (fill < 0.83 && ratio < 1.25) return 'رُند';
  if (widestY > 0.62) return 'گربه‌ای';
  if (widestY < 0.42 && ratio > 1.3) return 'خلبانی';
  return ratio > 1.35 ? 'بیضی کشیده' : 'بیضی';
}

/**
 * Derive the optical spec a frame is actually specified by, from the cleaned
 * curves. These are the numbers printed inside a real temple (52-18-145).
 *
 * @param aperture canonical aperture, centred on the origin (cm)
 * @param outer    symmetrized outer silhouette (cm, centred on x=0)
 * @param lensCenterX distance from the frame's centreline to a lens centre
 * @param lensCenterY height of the lens centres within the outer silhouette
 */
export function measureSpec(aperture, outer, lensCenterX, lensCenterY) {
  const a = boundsOf(aperture);
  const o = boundsOf(outer);

  const lensWidth = a.width;
  const lensHeight = a.height;
  const bridgeGap = Math.max(2 * lensCenterX - lensWidth, lensWidth * 0.12);
  const halfWidth = Math.max(Math.abs(o.minX), Math.abs(o.maxX));

  // The aperture is centred on the origin, so its edges in frame space are
  // offset by where the lens centres actually sit.
  const apertureTop = lensCenterY + a.maxY;
  const apertureBottom = lensCenterY + a.minY;

  return {
    lensWidth,
    lensHeight,
    bridgeGap,
    lensCenterX,
    lensCenterY,
    totalWidth: halfWidth * 2,
    totalHeight: o.height,
    // Rim thicknesses, measured where each actually sits on the frame.
    rim: Math.max(halfWidth - (lensCenterX + lensWidth / 2), 0.06),
    rimTop: Math.max(o.maxY - apertureTop, 0.05),
    rimBottom: Math.max(apertureBottom - o.minY, 0.04),
    shape: classifyAperture(aperture),
  };
}
