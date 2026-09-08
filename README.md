# Vitra — Virtual Eyewear Try-On

Phase 1 of a WordPress/WooCommerce virtual try-on plugin for eyewear shops.
This phase is a standalone web page: a default 3D glasses model, and a
"Try On" button that uses your webcam to overlay the glasses on your face in
real time.

## Roadmap

- **Phase 1 (done):** single page, procedural 3D glasses, webcam
  face-tracked try-on.
- **Phase 2 (done):** real glTF glasses models with a per-model registry
  (scale / fit / material overrides), live face occlusion.
- **Phase 2.5 (done):** a self-contained photo → 3D generator
  (`generator.html`): upload product photos of a real pair of glasses and get
  a 3D model of *that* frame back, wearable in the try-on.
- **Phase 3 (next):** package as a WordPress/WooCommerce plugin — API-key
  settings, per-product model upload or AI generation from photos, and a
  Try On button on the single product page. See **[ROADMAP.md](ROADMAP.md)**
  for the full build plan.

## Wearing your own 3D model

The try-on page takes a `.glb` directly — "یا فایل GLB خودتان را آپلود کنید",
under the Try On button. It is stored locally (IndexedDB), survives a reload,
and appears as the same "عینک من" style chip a generated frame does.

An uploaded model is **auto-fitted** first, because nothing in a glTF says
which way a pair of glasses faces. It may be in metres or millimetres, modelled
Z-up, facing away from the camera, and centred wherever its author left the
origin; dropped in untouched it lands off-screen, wrong-sized and backwards.
`glasses/fitUploadedFrame.js` recovers the frame from its own geometry, using
facts true of every pair: it is far wider and deeper than it is tall, so the
shortest axis is up; it is mirror-symmetric left to right but a slab at one end
with two thin arms trailing off the other, so the *skewed* axis is depth and the
balanced one width; the wide end is the front; and the arms hook down behind the
ear, so the far end sits lower. The model is then scaled to a real frame width
and re-origined on the front, exactly as a generated frame is authored.

Verified against a real product model presented five ways — as authored, Z-up,
facing away, upside-down, and at 1000× scale — all of which converge on the
same normalised result. The fit sliders under "تنظیم دقیق" correct anything the
model's own proportions still make wrong.

Only `.glb` is accepted: a `.gltf` references external files that a single
upload cannot carry. A file that will not parse is rejected at upload with a
reason, rather than becoming a broken style chip. There is one custom slot, so
uploading replaces a generated frame and vice versa.

## Building a frame from photos (`generator.html`)

Reached from the link under the Try On button. Upload a **front** photo of a
real pair of glasses (a **side** photo of one open temple is optional but
recommended) and the page reconstructs the frame in 3D, shows it in an
orbitable studio viewer, and can hand it straight to the try-on or export it
as a `.glb`.

### Which photos, and why three

One straight-on photo cannot determine a frame. Its thickness front-to-back,
the curve it wraps around the face, and the length of its arms are all
invisible head-on — they used to be guessed from the rim's width, which is why
a model could match its photo exactly and still be wrong the moment it was
turned. Three orthogonal views each measure something none of the others can:

| Photo | What is measured from it |
|---|---|
| **Front** (required) | outer silhouette, both lens apertures, rim thickness, frame and lens colour |
| **Side** (recommended) | the arm's taper, where it bends over the ear, and the front's pantoscopic lean |
| **Top** (recommended) | **front thickness, face-form curvature, and true temple length** |

A single three-quarter photo is intuitive but is the *worst* input for
automated measurement: everything in it is foreshortened by an unknown
perspective, so nothing can be measured without first solving for camera pose.
Orthogonal views need no such solving — each one is measured directly, and the
top view even scales itself, because its widest span is the frame width
already entered. The page states plainly which numbers were measured and which
were assumed, so a missing view is never silently guessed at.

### Photo requirements

Accuracy is bounded by the photo, so the page states these up front:

- **Plain, uniform background** — white paper is ideal. The background is
  identified from the image's border ring and flood-filled away, so a busy
  background is the one thing that will break reconstruction.
- **Straight-on front view**, no perspective, frame filling most of the
  frame — the silhouette is taken literally, so a tilted shot yields a
  tilted frame.
- **Even light**, no hard shadow under the frame and no blown-out specular
  glare on the lenses.
- **Side photo:** the whole pair from directly side-on with the temples open.
  Either way round — the page finds the front by its profile.
- **Top photo:** the whole pair lying open, camera directly overhead.
- Enter the frame's real **total width in mm** (printed on the temple, e.g.
  `52□18-145`) so the model comes out at true scale, in the same metric face
  space the tracker uses.

### How the reconstruction works

Everything runs locally in the browser on typed arrays — no service calls, no
model downloads (`src/generator/`):

1. **Background removal** (`segmentation.js`) — the border ring gives a
   median background colour; every pixel within a tolerance of it that is
   *connected to the border* is background. Pixels enclosed by the frame are
   deliberately kept separate, because those are the lens holes.
2. **Lens detection** (`photoAnalysis.js`) — three tiers, tried in order:
   background-coloured **enclosed holes** (clear eyeglasses seen against the
   backdrop), then a **colour split** against the measured rim colour
   (tinted sunglasses), then a purely **geometric inset** of the silhouette.
   Which tier fired is reported in the UI, since it tells the user whether
   the photo did its job.
3. **Contours** (`contours.js`) — Moore-neighbour boundary tracing, then
   Ramer–Douglas–Peucker simplification at an image-size-relative tolerance,
   then Chaikin corner-cutting. The tolerance has to scale with the photo:
   at a fixed 1px it keeps every pixel stair-step, and extruding those gives
   the frame and temple edges a visible sawtooth.
4. **Shape fitting** (`shapeFit.js`) — the step that makes this a
   reconstruction rather than a photo cut-out. A traced outline is noisy and
   slightly asymmetric; real glasses are manufactured and symmetric, so that
   prior is imposed: the two apertures are averaged into ONE canonical
   aperture used mirrored on both sides, the outer silhouette is folded onto
   its own mirror image, and curves are low-pass filtered — apertures by
   elliptic Fourier descriptors (~10 harmonics, enough to keep round vs
   square vs cat-eye distinct), the outer silhouette by local averaging
   (Fourier rings badly on its straight runs and hinge lugs). The aperture is
   then classified and measured into the spec a frame is actually specified
   by: lens width × height, bridge, rim thicknesses — the `52□18-145` printed
   inside every real temple.
5. **Model building** (`photoGlassesBuilder.js`) — real geometry from that
   spec. **The photo is never used as a texture** — only for shape and for the
   measured colours of the parts. What that geometry involves:
   - the front is extruded with a deep quarter-circle bevel, giving the
     pillowed cross-section milled acetate has, and is bent around the face on
     its own surface normals rather than sheared, so the outer edges rotate
     with the curve instead of still pointing straight back;
   - shading uses creased normals throughout. `ExtrudeGeometry` is
     non-indexed, so a plain `computeVertexNormals()` yields one normal per
     triangle and renders the rounded rim as visible facets;
   - lenses are spherical caps at a real base curve, tessellated as concentric
     rings so the curve is smooth across the whole lens — a flat polygon reads
     as a sheet of glass dropped in the hole;
   - temples are swept along a 3D path, capped at both ends, with the taper
     measured off the side photo at stations along the arm. The measurement is
     forced monotonic: past the ear bend a column of the mask spans the whole
     hook, which otherwise reads as an arm that gets *thicker* toward the ear;
   - an endpiece block bridges the arm to the front. The hinge itself is sunk
     inside it and never visible from outside on an acetate frame, so it is
     not modelled.

   Shape fitting runs at 256 points for accuracy but the mesh is built at
   lower resolution, since creased normals de-index the geometry and every
   extra outline point then costs three vertices on each surrounding surface. Lens opacity is
   derived from the measured lens luminance (dark tint → dense lens) and is
   adjustable live, and the tint is rendered as a synthesised vertical
   gradient rather than sampled pixels.

The reconstruction refuses rather than guesses: if two lens apertures aren't
found, or the measured proportions aren't those of a pair of glasses, it
reports what's wrong with the photo instead of producing a plausible-looking
wrong model.

### Measured accuracy

Correctness here is measured, not eyeballed. `scripts`-free but reproducible:
real 3D frames (the Khronos sunglasses asset and the repo's own parametric
frames) are rendered as orthographic product photos, pushed through the
reconstruction, and the result is re-rendered from the same viewpoints and
compared by silhouette IoU, with dimensions checked against the source's known
geometry.

On the acetate frame, whose exact spec is known: lens width **51.7mm vs 52.0**,
bridge **18.6 vs 18.2**, lens height **39.4 vs 40.5** — inside 3%. Silhouette
overlap is around **0.81 front / 0.68 side / 0.73 top**.

Thin wire frames are weaker (front ~0.67–0.84, top as low as 0.21): a silver
rim on a white backdrop is barely separable by colour, mirrored lenses break
into fragments under their own highlights, and on a strongly wrapped frame the
front's ends curve back nearly as far as the arms reach, so "front" and "arm"
stop being separable by depth alone. Where the top view's numbers fail that
physical sanity check, the entered temple length is used instead of a wrong
measurement.

The model is authored in face-space centimetres with its origin at the
front's optical centre, which is exactly what the try-on placement expects —
so "امتحان روی صورت" saves the GLB to IndexedDB and it appears as its own
style chip (`عینک من`) on the try-on page.

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
- **Default model:** a real, e-commerce-grade 3D sunglasses model
  (`public/models/sunglasses-khronos.glb`, loaded via
  `src/glasses/loadGlassesModel.js`) with physically based transparent /
  iridescent lens materials. Three procedurally generated styles
  (`src/glasses/createGlasses.js`: round / square / aviator) remain as
  zero-asset alternatives and as the fallback if the model file fails to
  load. Client-provided scanned models plug into the same registry
  (`GLASSES_MODELS`).
- **Occlusion:** an invisible, depth-only render of MediaPipe's canonical
  face mesh plus an approximate skull dome (`src/scene/faceOccluder.js`)
  lets the real face hide whatever sits behind it — the nose covers the far
  lens in profile, and the temple arms disappear behind the head — which is
  what makes the glasses read as genuinely worn.

### 3D model credits

- "Sunglasses" by Eric Chadwick, © 2024 Darmstadt Graphics Group GmbH,
  licensed [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/), from
  [KhronosGroup/glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/SunglassesKhronos)
  (Khronos and 3D Commerce logo marks belong to The Khronos Group).

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
- The photo generator reconstructs the frame from its *silhouette*: a
  straight-on front view plus a side view. It cannot recover what a
  silhouette does not carry — the front's true curvature is approximated by a
  fixed cylindrical face-form wrap, and surface decoration (printed logos,
  tortoiseshell patterning, two-tone laminates) is reduced to a single
  measured colour per part, because the alternative — projecting the
  photograph onto the model — only looks right from the angle it was shot
  from. Frames photographed against a busy background fail segmentation
  outright, by design.
