"""
Image-to-3D backends.

Kept behind one interface so the model can be swapped without touching the
service or the browser: `generate(image) -> glb bytes`. Two ship here.

TRELLIS is the default and the one to use in production. It is MIT licensed
with no usage or territorial restrictions, which among the strong open models
is the distinguishing feature for a commercial storefront — Hunyuan3D produces
better PBR texture but ships under a community licence that excludes the EU,
the UK and South Korea.

The mock backend exists so the browser pipeline — normalisation, lens
separation, materials, try-on — can be built and tested against the real API
contract on a machine with no GPU.
"""
from __future__ import annotations

import io
import logging
import os
from pathlib import Path

from PIL import Image

log = logging.getLogger("vitra.backend")


class Backend:
    def generate(self, image: Image.Image, *, remove_background: bool = True, seed: int = 0) -> bytes:
        raise NotImplementedError


def _strip_background(image: Image.Image) -> Image.Image:
    """
    Cut the product out of its backdrop.

    The model reconstructs whatever it is shown, so a visible backdrop becomes
    part of the object. Anything already carrying an alpha channel is left
    alone — a caller that has cut the subject out itself should not have it
    done twice.
    """
    if image.mode == "RGBA" and image.getchannel("A").getextrema()[0] < 255:
        return image
    try:
        import rembg  # imported lazily: it pulls a model of its own
    except ImportError:
        log.warning("rembg not installed; using the photo as-is")
        return image
    return rembg.remove(image)


class MockBackend(Backend):
    """
    Returns a fixed GLB regardless of input.

    Not a stand-in for quality — it is how the rest of the system is tested
    without a GPU, so that when the real weights are dropped in, everything
    downstream is already known to work.
    """

    def __init__(self) -> None:
        self.path = Path(
            os.environ.get(
                "VITRA_MOCK_GLB",
                Path(__file__).resolve().parents[2] / "public" / "models" / "sunglasses-khronos.glb",
            )
        )

    def generate(self, image: Image.Image, *, remove_background: bool = True, seed: int = 0) -> bytes:
        if not self.path.exists():
            raise RuntimeError(f"mock GLB not found at {self.path}")
        return self.path.read_bytes()


class TrellisBackend(Backend):
    """
    Microsoft TRELLIS, run locally.

    Weights are downloaded once on first use and then stay resident on the GPU;
    loading them per request would dominate the runtime.
    """

    def __init__(self) -> None:
        # Imported here rather than at module import so that `VITRA_BACKEND=mock`
        # needs none of the heavy stack installed.
        from trellis.pipelines import TrellisImageTo3DPipeline

        model = os.environ.get("VITRA_TRELLIS_MODEL", "microsoft/TRELLIS-image-large")
        log.info("loading TRELLIS weights: %s", model)
        self.pipeline = TrellisImageTo3DPipeline.from_pretrained(model)
        self.pipeline.cuda()
        self.texture_size = int(os.environ.get("VITRA_TEXTURE_SIZE", 2048))
        self.simplify = float(os.environ.get("VITRA_SIMPLIFY", 0.92))

    def generate(self, image: Image.Image, *, remove_background: bool = True, seed: int = 0) -> bytes:
        from trellis.utils import postprocessing_utils

        if remove_background:
            image = _strip_background(image)

        outputs = self.pipeline.run(image.convert("RGB"), seed=seed)

        # Bake to a textured mesh. `simplify` keeps the result light enough to
        # load on a phone, which is where the try-on actually runs.
        glb = postprocessing_utils.to_glb(
            outputs["gaussian"][0],
            outputs["mesh"][0],
            simplify=self.simplify,
            texture_size=self.texture_size,
        )
        buffer = io.BytesIO()
        glb.export(buffer, file_type="glb")
        return buffer.getvalue()


class Hunyuan3DBackend(Backend):
    """
    Tencent Hunyuan3D — better PBR texture than TRELLIS.

    Its weights ship under the Tencent Hunyuan Community License, which permits
    selling generated assets but is NOT MIT and excludes the EU, the UK and
    South Korea. Read it against where the storefront actually operates before
    switching to this.
    """

    def __init__(self) -> None:
        from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
        from hy3dgen.texgen import Hunyuan3DPaintPipeline

        model = os.environ.get("VITRA_HUNYUAN_MODEL", "tencent/Hunyuan3D-2")
        log.info("loading Hunyuan3D weights: %s", model)
        self.shape = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(model)
        self.paint = Hunyuan3DPaintPipeline.from_pretrained(model)

    def generate(self, image: Image.Image, *, remove_background: bool = True, seed: int = 0) -> bytes:
        if remove_background:
            image = _strip_background(image)
        mesh = self.shape(image=image)[0]
        mesh = self.paint(mesh, image=image)
        buffer = io.BytesIO()
        mesh.export(buffer, file_type="glb")
        return buffer.getvalue()


BACKENDS = {
    "mock": MockBackend,
    "trellis": TrellisBackend,
    "hunyuan3d": Hunyuan3DBackend,
}


def get_backend(name: str) -> Backend:
    try:
        return BACKENDS[name]()
    except KeyError as exc:
        raise RuntimeError(
            f"unknown backend {name!r}; expected one of {sorted(BACKENDS)}"
        ) from exc
