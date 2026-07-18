# Vitra — Virtual Eyewear Try-On

Phase 1 of a WordPress/WooCommerce virtual try-on plugin for eyewear shops.
This phase is a standalone web page: a default 3D glasses model, and a
"Try On" button that uses your webcam to overlay the glasses on your face in
real time.

## Roadmap

- **Phase 1 (this repo, current):** single page, default procedural 3D
  glasses, webcam face-tracked try-on.
- **Phase 2:** load real scanned glasses models (client-provided).
- **Phase 3:** package as a WordPress/WooCommerce plugin — model upload on
  the product admin page, try-on widget on the single product page.

## How it works

- **3D rendering:** [three.js](https://threejs.org/).
- **Face tracking:** [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
  running fully client-side (WASM/GPU), producing a per-frame
  `facialTransformationMatrix` — a rigid transform from a canonical 3D face
  model into camera space.
- **Placement:** the glasses are positioned using real anatomical
  coordinates pulled directly from MediaPipe's own canonical face model
  (`src/glasses/faceAnchors.js`) — e.g. eye-center spacing works out to the
  real-world average human interpupillary distance (~6.3cm), which is a
  strong sanity check that the fit math is right. The three.js camera is
  configured to match MediaPipe's own assumed virtual camera (63° vertical
  FOV) so the matrix can be applied directly with no ad-hoc calibration.
- **Smoothing:** a One Euro Filter (position) + adaptive slerp (rotation)
  removes tracking jitter while staying responsive to real head motion —
  see `src/tracking/oneEuroFilter.js`.
- **Default model:** the glasses shown are procedurally generated
  (`src/glasses/createGlasses.js`, styles: round / square / aviator) so
  phase 1 has zero dependency on external 3D assets. Phase 2 swaps this for
  real scanned models.

## Fit calibration

Because exact fit depends on each person's face and camera, an in-page
"تنظیم دقیق" panel (visible once Try On is active) exposes live
position/scale sliders. Good values found during testing should be baked
into the defaults in `src/scene/arTryOn.js` (`setFitOffset` call in
`main.js`) over time.

## Development

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build to dist/
```

`npm run dev` / `npm run build` first copy the MediaPipe WASM runtime from
`node_modules` into `public/mediapipe/wasm` (see
`scripts/copy-mediapipe-wasm.mjs`) so the app serves it from the same
origin instead of a third-party CDN. The face-tracking model weights
(~4MB) still load lazily from Google's CDN on first use — that part
requires the deployed page to have normal internet access to
`storage.googleapis.com`, same as any MediaPipe-based site.

## Known limitations (phase 1)

- Tested for build correctness, camera acquisition, and UI flow. The live
  on-face fit has **not** been visually verified against a real face in
  this environment (dev sandbox has no camera with a real face), so the
  fit-calibration panel is included specifically so this can be tuned by
  eye on first real-world test.
- No product catalog / WordPress integration yet — that's phase 3.
