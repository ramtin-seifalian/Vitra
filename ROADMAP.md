# Vitra — Phase 3 Roadmap: WooCommerce Virtual Try-On Plugin

This document is the build plan for turning the phase-1/2 try-on engine (this
repo) into a distributable WordPress plugin for WooCommerce eyewear shops.

Status legend: `[x]` done · `[ ]` planned

---

## 1. Product goal

A WooCommerce shop owner installs one plugin and gets:

1. **A settings page** holding API keys for the three supported 3D-generation
   services (Meshy, Tripo, Sloyd).
2. **A per-product panel** where they either
   - upload a ready `.glb` model directly, **or**
   - upload product photos and have a 3D model generated from them
     (requires one of the API keys above).
3. **A "Try On" button** on the single-product page that opens the camera and
   places that product's glasses on the shopper's face in real time.

The engine that does the placement is what already exists in this repo.

---

## 2. What already exists (phases 1–2)

| Capability | Module | State |
|---|---|---|
| Face tracking (MediaPipe, 468 landmarks + rigid pose) | `src/tracking/faceTracker.js` | [x] |
| Jitter smoothing (One Euro + slerp) | `src/tracking/smoothedFaceAnchor.js` | [x] |
| Anatomical mounting anchors (metric cm) | `src/glasses/faceAnchors.js` | [x] |
| Live per-frame face occlusion from the user's own landmarks | `src/scene/faceOccluder.js` | [x] |
| Skull + ear occluders (temples behind head / hook behind ear) | `src/scene/faceOccluder.js` | [x] |
| Pixel-exact video↔canvas alignment | `src/scene/arTryOn.js` (`_resize`) | [x] |
| glTF model registry (per-model scale / fit / material overrides) | `src/glasses/loadGlassesModel.js` | [x] |
| Procedural fallback styles | `src/glasses/createGlasses.js` | [x] |

**Key asset for phase 3:** the model registry already separates *model source*
from *fit metadata*. A generated or uploaded model becomes one more registry
entry — the try-on engine itself needs no changes.

---

## 3. The critical unsolved piece: **model normalization**

AI services (and arbitrary seller uploads) return models in **arbitrary
orientation, scale, and origin**. Dropping one straight onto a face produces a
crooked, wrongly-sized result. Normalizing it is where this plugin earns its
value, and it must be automatic — sellers will not hand-align meshes.

### Normalization algorithm (per model, run once at import)

1. **Symmetry plane** — glasses are bilaterally symmetric. Find the plane that
   best mirrors the vertex cloud onto itself → gives the model's X axis and
   true center.
2. **Principal axes (PCA)** — longest axis = frame width (X), second =
   temple direction (Z). Resolves rotation ambiguity.
3. **Front/back disambiguation** — temples extend *backward* from the widest
   points; the lens plane is the dense, flat cluster at the opposite end.
   Fixes 180° flips.
4. **Bridge detection** — the vertex cluster nearest the symmetry plane on the
   lens-plane side is the nose bridge: the anatomical mounting point.
5. **Metric scale** — scale so measured frame width equals the seller-entered
   width in mm. (Most frames have this printed on the temple arm.)
6. **Anchor placement** — translate so the detected bridge sits on
   `NOSE_BRIDGE` from `faceAnchors.js`.

Output: a normalized `.glb` plus a small JSON fit record. Every model, from
any source, then behaves identically in the try-on.

**Where this runs:** in the **admin browser**, not PHP. PHP has no usable 3D
stack; the browser already has three.js and all of our geometry code. The
admin page loads the model into a hidden canvas, normalizes it, exports via
`GLTFExporter`, and uploads the normalized result. PHP only stores files and
brokers API calls.

- [ ] `src/pipeline/normalizeModel.js` — steps 1–6 above
- [ ] `src/pipeline/normalizeModel.test.js` — synthetic models at known
      rotations/scales must normalize back to a fixed pose

---

## 4. Material realification from photo

Generated geometry is accurate but material fidelity varies (Meshy/Tripo can
return untextured meshes; free tiers usually do). Glasses are, materially,
simple: a frame in one or two colors plus a lens tint. So instead of full
texture baking we **sample colors from the product photo** and drive our
existing PBR material system.

1. Segment the glasses from the (uniform) photo background.
2. Classify each mesh part as frame vs lens (lens = the flat, enclosed
   surfaces inside the rim apertures).
3. Sample dominant frame color; estimate finish (metal vs plastic) from
   specular highlight distribution, with a seller override dropdown.
4. Sample lens tint + estimate opacity.
5. Apply via the existing `tint` mechanism in `loadGlassesModel.js`.
6. **Always** replace lens material with our own physical glass material —
   transparency is the known weak point of every scan/AI method, and we
   already render it correctly.

- [ ] `src/pipeline/extractMaterials.js`
- [ ] Seller override UI (frame color picker, finish dropdown, lens tint)

---

## 5. Plugin architecture

```
vitra-vto/
├── vitra-vto.php                  # header, WooCommerce dependency guard
├── includes/
│   ├── class-settings.php         # admin settings: 3 API keys
│   ├── class-product-meta.php     # per-product panel + meta storage
│   ├── class-generator.php        # server-side API broker (Meshy/Tripo/Sloyd)
│   ├── class-rest.php             # REST routes for async job polling
│   └── class-frontend.php         # Try On button + lazy asset enqueue
├── admin/
│   └── js/vitra-admin.js          # normalization + material pass (three.js)
├── assets/
│   └── js/vitra-tryon.js          # built bundle of this repo's engine
└── uploads/vitra-models/          # normalized .glb + fit JSON per product
```

### Settings page
- [ ] Three API key fields: Meshy, Tripo, Sloyd
- [ ] Provider selection when more than one key is present
- [ ] Keys stored in `wp_options`, **never** exposed to the frontend; all
      provider calls are made server-side from PHP

### Product edit page (WooCommerce product data panel)
- [ ] Checkbox: *Enable 3D try-on for this product*
- [ ] Radio: *Upload 3D model* | *Generate from photos* (the latter disabled,
      with an explanatory notice, when no API key is configured)
- [ ] Upload path: `.glb` / `.gltf` file field
- [ ] Generate path: photo upload (front, side, top) + **frame width in mm**
- [ ] Live preview canvas showing the normalized model before saving
- [ ] Material override controls (§4)

### Generation flow (async)
Generation takes minutes, so it cannot block a page load.

- [ ] `POST` job to provider, persist job id in product meta
- [ ] Poll job status from the admin page via our REST route
- [ ] On completion: download `.glb` server-side → hand to admin JS →
      normalize + materialize → upload result → store as product meta
- [ ] Surface provider errors (quota, invalid key, failed generation) as
      actionable admin notices

### Frontend
- [ ] "Try On" button overlaid on the product image, shown only when the
      product has a model
- [ ] Lazy-load the engine bundle + model **on click only** (the bundle is
      ~800KB; it must not affect normal shop page-load performance)
- [ ] Modal try-on view: camera permission → tracking → placement
- [ ] Graceful messaging for: permission denied, no camera, unsupported
      browser, insecure context (HTTPS is required for camera access)

---

## 6. Delivery phases

Each phase ends in something testable on a real site.

### Phase 3.1 — Plugin skeleton, direct upload path
Proves the whole plugin shell and the frontend experience with **no AI
involved**.
- [ ] Plugin scaffold + WooCommerce dependency guard
- [ ] Settings page (keys stored, not yet used)
- [ ] Product panel with direct `.glb` upload
- [ ] Frontend Try On button + modal running the existing engine
- [ ] **Milestone:** upload the current `sunglasses-khronos.glb` to a real
      product and try it on from the shop's product page

### Phase 3.2 — Normalization
- [ ] `normalizeModel.js` + tests
- [ ] Wire into the admin upload path with preview
- [ ] **Milestone:** a deliberately mis-oriented model auto-corrects and fits

### Phase 3.3 — AI generation
- [ ] Provider adapters (Tripo first — highest reported geometry accuracy and
      textures/PBR default to on via API)
- [ ] Async job flow + polling + error surfacing
- [ ] **Milestone:** photo in → usable, correctly-fitted model out, no manual
      steps

### Phase 3.4 — Material realification
- [ ] Photo-driven color/finish extraction (§4)
- [ ] Seller override UI
- [ ] **Milestone:** generated model visually matches the product photo

### Phase 3.5 — Hardening
- [ ] Model caching / CDN-friendly headers
- [ ] Mobile performance pass (target: sustained 30fps mid-range Android)
- [ ] i18n (Persian + English), RTL admin layout
- [ ] Uninstall cleanup, capability checks, nonce coverage on every write

---

## 7. Decisions taken

| Decision | Rationale |
|---|---|
| Seller supplies their own API key (BYOK) | Plugin stays free; no billing infrastructure; per-model cost (~$0.20–0.55) settles directly between seller and provider |
| Normalization runs in the admin browser | PHP has no viable 3D stack; three.js + our geometry code already exist client-side |
| Lens material always replaced by ours | Transparency is the failure mode of every scan/AI pipeline; we already render it correctly |
| Frame width in mm is required | Guarantees metric scale independent of model source; the number is printed on most frames |
| Tripo integrated first | Reported best geometry accuracy in hands-on testing; `texture` and `pbr` default to `true` in its API |

## 8. Open questions

- [ ] Multi-variant products (same frame, several colors) — one model with
      material variants, or one model per variation?
- [ ] Should shoppers be able to save/share a try-on snapshot?
- [ ] Model storage: WordPress uploads dir vs a dedicated CDN for larger
      catalogs
