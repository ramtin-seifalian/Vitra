import * as THREE from 'three';

// A rounded-rectangle THREE.Shape centered at origin, width w, height h,
// corner radius r (clamped to fit). Used for both 'square' lens rims and,
// with r = min(w,h)/2, as a stand-in for a full round lens.
export function roundedRectShape(w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  const x = -w / 2;
  const y = -h / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x, y + rr);
  shape.lineTo(x, y + h - rr);
  shape.quadraticCurveTo(x, y + h, x + rr, y + h);
  shape.lineTo(x + w - rr, y + h);
  shape.quadraticCurveTo(x + w, y + h, x + w, y + h - rr);
  shape.lineTo(x + w, y + rr);
  shape.quadraticCurveTo(x + w, y, x + w - rr, y);
  shape.lineTo(x + rr, y);
  shape.quadraticCurveTo(x, y, x, y + rr);
  return shape;
}

// A teardrop-ish aviator lens shape: wider/flatter across the brow, narrowing
// toward a rounded point at the bottom-outer edge.
export function aviatorShape(w, h) {
  const shape = new THREE.Shape();
  const topY = h * 0.42;
  const botY = -h * 0.58;
  shape.moveTo(-w * 0.5, topY * 0.35);
  shape.bezierCurveTo(-w * 0.55, topY, -w * 0.2, topY * 1.15, 0, topY * 1.05);
  shape.bezierCurveTo(w * 0.2, topY * 1.15, w * 0.55, topY, w * 0.5, topY * 0.35);
  shape.bezierCurveTo(w * 0.58, -topY * 0.2, w * 0.42, botY * 0.75, w * 0.12, botY);
  shape.bezierCurveTo(w * 0.02, botY * 1.08, -w * 0.02, botY * 1.08, -w * 0.12, botY);
  shape.bezierCurveTo(-w * 0.42, botY * 0.75, -w * 0.58, -topY * 0.2, -w * 0.5, topY * 0.35);
  return shape;
}

// Offsets a closed 2D shape's points inward/outward by `d` (simple normal
// offset, good enough for the thin lens-rim widths used here).
export function insetShape(shape, d) {
  const pts = shape.getPoints(64);
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const tangent = new THREE.Vector2().subVectors(next, prev).normalize();
    const normal = new THREE.Vector2(tangent.y, -tangent.x);
    out.push(new THREE.Vector2(pts[i].x + normal.x * d, pts[i].y + normal.y * d));
  }
  return new THREE.Shape(out);
}
