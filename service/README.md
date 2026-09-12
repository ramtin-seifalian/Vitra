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

## Do not buy a server for this

Work out the actual workload first. A model is generated **once per product**
and the GLB is then cached forever; the try-on itself runs in the customer's
browser and never touches a GPU. So the GPU is needed only while adding
products to the catalogue.

At roughly 30 seconds a photo, 100 products is under an hour of GPU time.
Rented at about $0.34/hr for an RTX 4090 that is **well under $1 for the whole
catalogue**. A card to put in a machine costs four figures and would sit idle
between product launches.

Rent by the hour, and only reconsider if you ever find yourself generating
continuously.

## Hardware

Official TRELLIS requirements: **Linux**, **CUDA 11.8 or 12.2**, **Python 3.8+**,
and an **NVIDIA GPU with at least 16GB of VRAM** (tested on A100 and A6000).
An RTX 4090 (24GB) is the cheapest card that comfortably clears this.

Generation takes roughly 10–40 seconds per photo. The weights are several
gigabytes and download once on first use, so budget 10–15 minutes for the very
first run.

## Renting, step by step

1. Make an account on a GPU marketplace — [RunPod](https://runpod.io) or
   [Vast.ai](https://vast.ai). RunPod's Community Cloud and Vast.ai's
   marketplace are the cheap tiers; the "secure"/verified tiers cost roughly
   double for the same card.
2. Start a pod with an **RTX 4090 (24GB)**. Give it **60GB+ of disk** — the
   weights and CUDA extensions are large.

   **Watch the CUDA version.** TRELLIS is tested on CUDA 11.8 and 12.2, and
   current RunPod PyTorch templates offer 12.8 and newer. The Python side is
   fine on those; the risk is the half-dozen CUDA extensions the setup script
   compiles (flash-attn, spconv, nvdiffrast, kaolin, diffoctreerast), which are
   the part that breaks on an untested toolkit. Prefer a template offering
   **CUDA 12.1–12.4** where one is available. If a build fails, that is the
   first thing to change — not the script.

   Note also that a **network volume keeps billing after the pod is stopped**
   (a few dollars a month for 80GB). It is worth keeping between sessions so
   the weights do not download again; delete it when the project is done.
3. Expose **port 8099** (RunPod calls this an HTTP port).
4. Open the pod's terminal and run the setup script below.
5. Take the pod's public URL and paste it into the generator page, with the
   token you set.
6. **Stop the pod when you are done.** Billing is per second of uptime, not
   per model — an idle pod still costs money.

Generate, check the result, and only then decide whether the quality justifies
going further. That test costs a couple of dollars, not a server.

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

### Copy-paste, in the pod's terminal

```bash
# 1. Get the code and install TRELLIS. Takes 15-30 minutes, mostly compiling.
cd /workspace
git clone https://github.com/ramtin-seifalian/Vitra
cd Vitra/service
bash setup-trellis.sh

# 2. Make a token and start the service. Copy the token it prints.
export VITRA_BACKEND=trellis
export VITRA_API_TOKEN="$(openssl rand -hex 24)"
export VITRA_ALLOWED_ORIGINS="https://ramtin-seifalian.github.io"
echo "=== TOKEN: $VITRA_API_TOKEN ==="
uvicorn app.main:app --host 0.0.0.0 --port 8099
```

Check it from a second terminal with `curl http://localhost:8099/health`, then
paste the pod's public HTTPS URL and that token into the generator page under
«ساخت با هوش مصنوعی».

Clone into `/workspace` (or wherever the network volume is mounted) so the
work survives a pod restart. The model weights land in the Hugging Face cache;
set `HF_HOME=/workspace/hf` before the first run to keep those on the volume
too, or they are re-downloaded every time the pod is recreated.

### What the script does

On the GPU box:

```bash
git clone https://github.com/ramtin-seifalian/Vitra
cd Vitra/service
bash setup-trellis.sh          # installs TRELLIS, its extensions, and this service
```

Then run it:

```bash
export VITRA_BACKEND=trellis
export VITRA_API_TOKEN="$(openssl rand -hex 24)"   # note this down
export VITRA_ALLOWED_ORIGINS="https://ramtin-seifalian.github.io"
echo "token: $VITRA_API_TOKEN"
uvicorn app.main:app --host 0.0.0.0 --port 8099
```

The TRELLIS install compiles several CUDA extensions and is the fiddly part.
Run it interactively the first time so a failing step is visible; the script
stops at the first error rather than carrying on with a half-built
environment.

**A browser on an HTTPS page cannot call a plain HTTP endpoint.** The
storefront is served over HTTPS, so the service needs TLS too. On RunPod the
proxied pod URL is already HTTPS, which is the simplest route; on your own box,
put it behind nginx or Caddy with a certificate.

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
