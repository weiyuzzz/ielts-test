#!/bin/bash
# =============================================================================
# IELTS platform — local TTS engine (Kokoro-FastAPI) setup, macOS / Linux
#
# GPU-first with automatic fallback (engine auto-detects at boot):
#   Apple Silicon (M1/M2/M3…) → PyTorch MPS   (GPU, ~5-10x faster than CPU)
#   NVIDIA Linux              → PyTorch CUDA (GPU)
#   no GPU                    → CPU
#
# The engine runs on the HOST (not in Docker): macOS Docker VMs cannot reach
# the GPU, so the only way to get real GPU inference on a Mac is a host
# process. Windows/NVIDIA users: use setup-tts-engine.ps1 instead.
#
# The app talks to http://localhost:8880 regardless of engine — no app config
# change is needed when you switch engines.
#
# Usage:
#   ./setup-tts-engine.sh            # GPU-first (auto MPS/CUDA/CPU)
#   ./setup-tts-engine.sh cpu        # force CPU
# =============================================================================
set -euo pipefail

ENGINE_DIR="${TTS_ENGINE_DIR:-$HOME/tts-engine/Kokoro-FastAPI}"
REPO="https://github.com/remsky/Kokoro-FastAPI"
PORT="${PORT:-8880}"
MODE="${1:-gpu}"   # gpu | cpu

echo "==> TTS engine setup (mode: $MODE)"

# 1) Stop any Docker Kokoro container holding port 8880 (CPU image).
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qi kokoro; then
  echo "==> Stopping the Docker kokoro container (it occupies port $PORT)"
  docker ps --format '{{.Names}}' | grep -i kokoro | xargs -r docker stop || true
fi

# 2) Clone / update the engine.
if [ ! -d "$ENGINE_DIR" ]; then
  echo "==> Cloning Kokoro-FastAPI into $ENGINE_DIR"
  git clone --depth 1 "$REPO" "$ENGINE_DIR"
fi
cd "$ENGINE_DIR"
git pull --ff-only 2>/dev/null || true

# 3) Install uv if missing (the engine's package manager).
if ! command -v uv >/dev/null 2>&1; then
  echo "==> Installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

# 4) Start script per platform/mode (official launchers; they set USE_GPU and
#    the engine auto-detects MPS → CUDA → CPU and falls back by itself).
if [ "$MODE" = "cpu" ]; then
  START="start-cpu.sh"
elif [ "$(uname)" = "Darwin" ]; then
  START="start-gpu_mac.sh"       # MPS on Apple Silicon
else
  START="start-gpu.sh"           # CUDA on NVIDIA Linux
fi
chmod +x "$START" 2>/dev/null || true

echo "==> Starting the engine with $START (first run downloads the model, ~1GB)"
nohup bash "$START" > "$ENGINE_DIR/engine.log" 2>&1 &
echo "==> Logs: $ENGINE_DIR/engine.log"

# 5) Wait for health.
echo -n "==> Waiting for http://localhost:$PORT/health "
for i in $(seq 1 120); do
  if curl -sf -m 2 "http://localhost:$PORT/health" >/dev/null 2>&1; then
    echo " OK"
    echo "==> Engine is up. Device reported at boot (see engine.log):"
    grep -iE "device|mps|cuda|cpu" "$ENGINE_DIR/engine.log" | head -5 || true
    exit 0
  fi
  echo -n "."
  sleep 2
done
echo " TIMEOUT — check $ENGINE_DIR/engine.log"
exit 1
