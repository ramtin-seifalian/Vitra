"""
Vitra 3D generation service.

Turns one product photo of a pair of glasses into a textured GLB, by running
an image-to-3D model on a GPU this service owns. It exists as a separate
process from the web app for two reasons: the model weights are gigabytes and
have to stay resident on a GPU, and nothing about the photo should leave the
operator's own infrastructure.

The default backend is TRELLIS, which is MIT licensed with no usage or
territorial restrictions — the only one of the strong open models that is
unambiguously safe for a commercial storefront.

Run without a GPU with `VITRA_BACKEND=mock` to exercise the whole pipeline
end to end; the mock returns a fixed GLB so the browser side can be built and
tested against the real API contract.
"""
from __future__ import annotations

import base64
import io
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from PIL import Image

from .backends import get_backend

log = logging.getLogger("vitra")
logging.basicConfig(level=os.environ.get("VITRA_LOG_LEVEL", "INFO"))

# Browsers must be allowed to call this from wherever the storefront is served.
ALLOWED_ORIGINS = [o for o in os.environ.get("VITRA_ALLOWED_ORIGINS", "*").split(",") if o]

# A shared secret, checked on every generate call. Without it anyone who finds
# the URL can spend the GPU; it is not a substitute for a firewall but it stops
# the service being trivially open.
API_TOKEN = os.environ.get("VITRA_API_TOKEN", "").strip()

MAX_UPLOAD_BYTES = int(os.environ.get("VITRA_MAX_UPLOAD_BYTES", 20 * 1024 * 1024))
MAX_IMAGE_PX = int(os.environ.get("VITRA_MAX_IMAGE_PX", 2048))

app = FastAPI(title="Vitra 3D generation", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS or ["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

_backend = None


def backend():
    """Load the model once, on first use, not at import."""
    global _backend
    if _backend is None:
        name = os.environ.get("VITRA_BACKEND", "trellis")
        log.info("loading backend %s", name)
        _backend = get_backend(name)
    return _backend


@app.get("/health")
def health():
    name = os.environ.get("VITRA_BACKEND", "trellis")
    return {
        "ok": True,
        "backend": name,
        # Reported without loading the model, so a health check never pulls
        # gigabytes of weights onto the GPU.
        "loaded": _backend is not None,
    }


def _decode_image(raw: bytes) -> Image.Image:
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="image too large")
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
    except Exception as exc:  # noqa: BLE001 - any decode failure is the same to the caller
        raise HTTPException(status_code=400, detail=f"unreadable image: {exc}") from exc

    image = image.convert("RGBA")
    # Oversized photos cost time and add nothing: the model works from a square
    # crop far smaller than a modern phone camera produces.
    if max(image.size) > MAX_IMAGE_PX:
        scale = MAX_IMAGE_PX / max(image.size)
        image = image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            Image.LANCZOS,
        )
    return image


@app.post("/generate")
async def generate(
    image: Optional[UploadFile] = File(default=None),
    image_base64: Optional[str] = Form(default=None),
    token: Optional[str] = Form(default=None),
    remove_background: bool = Form(default=True),
    seed: int = Form(default=0),
):
    """One photo in, one textured GLB out."""
    if API_TOKEN and (token or "").strip() != API_TOKEN:
        raise HTTPException(status_code=401, detail="bad token")

    if image is not None:
        raw = await image.read()
    elif image_base64:
        payload = image_base64.split(",", 1)[-1]  # tolerate a data: URL
        try:
            raw = base64.b64decode(payload, validate=False)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail="bad base64") from exc
    else:
        raise HTTPException(status_code=400, detail="no image supplied")

    pil = _decode_image(raw)
    job = uuid.uuid4().hex[:8]
    started = time.time()
    log.info("[%s] generating from %sx%s", job, pil.width, pil.height)

    try:
        glb = backend().generate(pil, remove_background=remove_background, seed=seed)
    except Exception as exc:  # noqa: BLE001
        log.exception("[%s] generation failed", job)
        return JSONResponse(status_code=500, content={"error": str(exc)})

    elapsed = time.time() - started
    log.info("[%s] done in %.1fs, %d bytes", job, elapsed, len(glb))
    return Response(
        content=glb,
        media_type="model/gltf-binary",
        headers={
            "X-Vitra-Job": job,
            "X-Vitra-Seconds": f"{elapsed:.1f}",
            "Content-Disposition": f'attachment; filename="{job}.glb"',
            # The browser reads these to report what happened.
            "Access-Control-Expose-Headers": "X-Vitra-Job, X-Vitra-Seconds",
        },
    )
