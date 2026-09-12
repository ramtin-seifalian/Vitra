#!/usr/bin/env bash
#
# Install TRELLIS and this service on a fresh Linux GPU box.
#
# Written for a rented pod started from a PyTorch + CUDA image, which is the
# cheapest way to try this: a model is generated once per product and cached
# forever, so the GPU is only needed while adding products to the catalogue.
#
# Stops at the first failure on purpose. TRELLIS compiles several CUDA
# extensions and that is where this goes wrong; carrying on would leave a
# half-built environment that fails later with a much more confusing error.

set -euo pipefail

TRELLIS_DIR="${TRELLIS_DIR:-$HOME/TRELLIS}"
SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31m!! %s\033[0m\n' "$1" >&2; exit 1; }

step "Checking the GPU"
command -v nvidia-smi >/dev/null 2>&1 || fail "nvidia-smi not found — this needs an NVIDIA GPU box."
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader

vram_mib="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1 | tr -d ' ')"
if [ "${vram_mib:-0}" -lt 15000 ]; then
  fail "TRELLIS needs at least 16GB of VRAM; this card reports ${vram_mib}MiB."
fi

step "Checking CUDA"
command -v nvcc >/dev/null 2>&1 \
  || fail "nvcc not found. Start from a CUDA development image — the runtime-only images cannot compile TRELLIS's extensions."
nvcc --version | tail -2

step "Fetching TRELLIS"
if [ -d "$TRELLIS_DIR/.git" ]; then
  echo "already present at $TRELLIS_DIR"
else
  git clone --recurse-submodules https://github.com/microsoft/TRELLIS.git "$TRELLIS_DIR"
fi

step "Installing TRELLIS (this compiles CUDA extensions and takes a while)"
cd "$TRELLIS_DIR"
# Flags are TRELLIS's own, from its README. --basic is the core; the rest are
# the geometry and rendering extensions its image-to-3D path needs.
# shellcheck disable=SC1091
. ./setup.sh --new-env --basic --xformers --flash-attn --diffoctreerast --spconv --mipgaussian --kaolin --nvdiffrast
pip install -e .

step "Installing the Vitra service into the same environment"
cd "$SERVICE_DIR"
pip install -r requirements.txt
pip install rembg   # cuts the product out of its backdrop before generation

step "Verifying the service imports"
VITRA_BACKEND=mock python -c "
from app.main import app
print('service imports cleanly')
"

cat <<'DONE'

==> Done.

Start the service with:

    export VITRA_BACKEND=trellis
    export VITRA_API_TOKEN="$(openssl rand -hex 24)"
    export VITRA_ALLOWED_ORIGINS="https://ramtin-seifalian.github.io"
    echo "token: $VITRA_API_TOKEN"
    uvicorn app.main:app --host 0.0.0.0 --port 8099

The first generation downloads several gigabytes of weights; later ones are
much faster. Check it is alive with:

    curl http://localhost:8099/health

Then paste the pod's public HTTPS URL and that token into the generator page,
under «ساخت با هوش مصنوعی».

Stop the pod when you are finished — billing is per second of uptime, not per
model generated.
DONE
