/**
 * Binary-mask contour extraction: Moore-neighbour boundary tracing followed
 * by Ramer-Douglas-Peucker simplification and Chaikin corner-cutting, so a
 * jagged pixel boundary becomes the smooth closed outline a THREE.Shape
 * needs. All coordinates are image pixels (y down).
 */

// 8 directions, clockwise in image coordinates (y down), starting East.
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

/**
 * Trace the outer boundary of the region containing (sx, sy) — which must be
 * its topmost-then-leftmost pixel. `inside(x, y)` is the region predicate.
 * Returns an ordered array of [x, y] boundary pixels (clockwise).
 */
export function traceBoundary(inside, w, h, sx, sy) {
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && inside(x, y);
  const points = [[sx, sy]];
  let cx = sx, cy = sy;
  let entry = 0; // pretend we arrived moving East — valid for topmost-leftmost start
  let firstDir = -1;
  const maxSteps = 4 * (w + h) * 8 + w * h;
  for (let step = 0; step < maxSteps; step++) {
    let dir = -1;
    const scanStart = (entry + 6) % 8;
    for (let k = 0; k < 8; k++) {
      const d = (scanStart + k) % 8;
      if (at(cx + DX[d], cy + DY[d])) { dir = d; break; }
    }
    if (dir === -1) return points; // isolated pixel
    if (cx === sx && cy === sy && firstDir !== -1) {
      if (dir === firstDir) break; // closed the loop with the same exit
    }
    if (firstDir === -1) firstDir = dir;
    cx += DX[dir];
    cy += DY[dir];
    if (cx === sx && cy === sy) {
      entry = dir;
      continue; // don't duplicate the start point
    }
    points.push([cx, cy]);
    entry = dir;
  }
  return points;
}

/** Perpendicular distance of p from segment ab. */
function perpDist(p, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const len = Math.hypot(abx, aby);
  if (len < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * aby - (p[1] - a[1]) * abx) / len;
}

/** Iterative Ramer-Douglas-Peucker on an open polyline. */
function rdpOpen(points, eps) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    let maxD = 0, maxI = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = perpDist(points[i], points[i0], points[i1]);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > eps && maxI !== -1) {
      keep[maxI] = 1;
      stack.push([i0, maxI], [maxI, i1]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** RDP for a closed contour: split at the two farthest-apart-ish points. */
export function simplifyClosed(points, eps) {
  if (points.length < 6) return points.slice();
  // Split at index of point farthest from point 0.
  let far = 1, maxD = -1;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]);
    if (d > maxD) { maxD = d; far = i; }
  }
  const a = rdpOpen(points.slice(0, far + 1), eps);
  const b = rdpOpen(points.slice(far).concat([points[0]]), eps);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

/** One round of Chaikin corner cutting on a closed polygon. */
function chaikinOnce(points) {
  const out = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    out.push(
      [0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]],
      [0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]
    );
  }
  return out;
}

export function smoothClosed(points, iterations = 2) {
  let out = points;
  for (let i = 0; i < iterations; i++) out = chaikinOnce(out);
  return out;
}

/** Full pipeline: trace -> simplify -> smooth, for one labelled region. */
export function extractContour(inside, w, h, sx, sy, { eps = 1.4, smooth = 2 } = {}) {
  const raw = traceBoundary(inside, w, h, sx, sy);
  if (raw.length < 8) return null;
  const simplified = simplifyClosed(raw, eps);
  if (simplified.length < 4) return null;
  return smoothClosed(simplified, smooth);
}

export function polygonArea(points) {
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}
