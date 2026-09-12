# Vitra 3D generation service

Turns one product photo into a textured GLB, by running an image-to-3D model on
a GPU you own. Nothing about the photo leaves your infrastructure.

## Why this runs on your own hardware

The alternative is a hosted API, which is faster to set up but sends every
product photo to a third party and bills per model. Self-hosting costs a GPU
box and nothing per generation.

**Use TRELLIS.** It is MIT licensed with no usage or territorial restrictions —
among the strong open models, that is what makes it safe for a commercial
storefront. Hunyuan3D produces better PBR texture but ships under the Tencent
Hunyuan Community License, which **excludes the EU, the UK and South Korea**;
it is included here as a backend, but check the licence against where you
actually trade before switching to it.

## Hardware

TRELLIS wants an NVIDIA GPU with **16GB VRAM or more** (24GB is comfortable).
Generation takes roughly 10–40 seconds per photo depending on the card. The
weights are several gigabytes and are downloaded once on first use.

## Quick start — mock mode, no GPU

Prove the whole pipeline works before spending anything on hardware. The mock
backend returns a fixed GLB, so the browser side — upload, auto-orientation,
scaling, lens separation, try-on — can all be exercised against the real API.

```bash
cd service
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
VITRA_BACKEND=mock VITRA_API_TOKEN=dev-token \
  uvicorn app.main:app --host 0.0.0.0 --port 8099
```

Then in the generator page, open **«ساخت با هوش مصنوعی»** and set:

- service URL → `http://localhost:8099`
- token → `dev-token`

"تست اتصال" should report `backend: mock`.

## Real mode — TRELLIS on a GPU

```bash
# 1. TRELLIS and its dependencies, per its own install instructions:
git clone https://github.com/microsoft/TRELLIS
cd TRELLIS && . ./setup.sh --dev --basic --xformers --flash-attn --diffoctreerast --spconv --mipgaussian --kaolin --nvdiffrast
pip install -e .

# 2. This service, in the same environment:
cd /path/to/Vitra/service
pip install -r requirements.txt
pip install rembg            # background removal before generation

# 3. Run it:
VITRA_BACKEND=trellis \
VITRA_API_TOKEN="$(openssl rand -hex 24)" \
VITRA_ALLOWED_ORIGINS="https://your-storefront.example" \
  uvicorn app.main:app --host 0.0.0.0 --port 8099
```

Put it behind a reverse proxy with TLS. A browser on an HTTPS page cannot call
an HTTP endpoint, so the service needs a certificate — the try-on page already
requires HTTPS for camera access.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `VITRA_BACKEND` | `trellis` | `trellis`, `hunyuan3d`, or `mock` |
| `VITRA_API_TOKEN` | *(empty)* | Shared secret; when empty the endpoint is open |
| `VITRA_ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins |
| `VITRA_MAX_UPLOAD_BYTES` | `20971520` | Reject larger uploads |
| `VITRA_MAX_IMAGE_PX` | `2048` | Longest edge; larger photos are downscaled |
| `VITRA_TEXTURE_SIZE` | `2048` | Baked texture resolution (TRELLIS) |
| `VITRA_SIMPLIFY` | `0.92` | Mesh decimation; higher is lighter |
| `VITRA_TRELLIS_MODEL` | `microsoft/TRELLIS-image-large` | Weights to load |
| `VITRA_MOCK_GLB` | bundled sample | GLB the mock backend returns |

`VITRA_API_TOKEN` is a secret for **your own** service. Set it from the
environment; do not commit it.

## API

```
GET  /health    -> { ok, backend, loaded }

POST /generate  (multipart/form-data)
     image             file      the product photo
     image_base64      string    alternative to `image`
     token             string    required when VITRA_API_TOKEN is set
     remove_background bool      default true
     seed              int       default 0
  -> 200 model/gltf-binary, with X-Vitra-Job and X-Vitra-Seconds headers
  -> 400 unreadable image · 401 bad token · 413 too large · 500 generation failed
```

## What happens to the model afterwards

The service returns a generic mesh. It does not know it is looking at eyewear,
so its lenses come back **solid**, which on a face reads as a blindfold. The
browser fixes that, in `src/glasses/`:

1. `fitUploadedFrame.js` — recovers which way the model faces and how big it
   is, and re-origins it on the front's optical centre.
2. `refineGeneratedFrame.js` — renders the model straight-on, runs that render
   through the same aperture detector used on product photos, and splits the
   triangles inside each aperture into their own mesh with transparent glass.

The frame keeps the generated texture throughout, so printed logos and the text
on the temples survive into the worn model.
