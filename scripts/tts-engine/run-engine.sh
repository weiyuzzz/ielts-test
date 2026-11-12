#!/bin/bash
# Wrapper for launchd: boots the Kokoro-FastAPI engine with the MPS device.
# launchd keeps this alive (KeepAlive) — if PyTorch MPS crashes (the known
# MPSGraph over-release issue), the engine is restarted within seconds.
cd "$(dirname "$0")"
export USE_GPU=true
export DEVICE_TYPE=mps
export PYTORCH_ENABLE_MPS_FALLBACK=1
export PYTHONPATH="$PWD:$PWD/api"
export MODEL_DIR=src/models
export VOICES_DIR=src/voices/v1_0
export WEB_PLAYER_PATH="$PWD/web"
exec .venv/bin/python -m uvicorn api.src.main:app --host 0.0.0.0 --port 8880
