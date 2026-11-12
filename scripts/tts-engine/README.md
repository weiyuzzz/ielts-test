# Local TTS engine (Kokoro-FastAPI) — GPU-first, cross-platform

The speaking module's examiner voice and lip-sync word timestamps come from a
local **Kokoro-FastAPI** engine on port **8880**. The app talks to
`http://localhost:8880` no matter how the engine is deployed, so switching
engines never changes app config.

## Device selection (GPU-first, automatic)

The engine detects the device at boot (`api/src/core/config.py`):

```
USE_GPU=true  →  MPS (Apple Silicon)  →  CUDA (NVIDIA)  →  CPU fallback
```

So "GPU 优先，无 GPU 回退 CPU" is the engine's built-in behaviour — the
launchers below only set `USE_GPU` and the right dependency extras.

## Setup

### macOS (Apple Silicon — M1/M2/M3)

```bash
./scripts/tts-engine/setup-tts-engine.sh
```

Runs the engine **on the host** with PyTorch **MPS**: Docker VMs on macOS
cannot reach the GPU, so a host process is the only way to get real GPU
inference on a Mac. Typical speedup vs the CPU Docker image: **5–10× per
line** (30–60 s → 3–8 s).

### Windows (NVIDIA)

```powershell
.\scripts\tts-engine\setup-tts-engine.ps1
```

Requires the NVIDIA driver (CUDA capable GPU). Falls back to CPU
automatically when no CUDA device is present.

### Force CPU

```bash
./scripts/tts-engine/setup-tts-engine.sh cpu
```

## Notes

- The engine is cloned to `~/tts-engine/Kokoro-FastAPI` (outside this repo);
  first start downloads the ~1 GB model.
- Engine logs: `~/tts-engine/Kokoro-FastAPI/engine.log`.
- The old Docker `kokoro-tts` container is stopped automatically (it occupies
  port 8880). Start it again if you ever want to go back:
  `docker start kokoro-tts`.
- Lip-sync quality is unchanged: `/dev/phonemize` and `/dev/captioned_speech`
  (word timestamps) are served by this engine either way.

## Keep it running (macOS launchd, crash auto-restart)

PyTorch MPS has a known stability issue (`MPSGraph` over-release crash) that
can kill the engine mid-exam. A launchd keepalive service restarts it within
seconds — installed automatically, or manually:

```bash
cp scripts/tts-engine/com.ielts.kokoro-tts.plist ~/Library/LaunchAgents/
cp ~/tts-engine/Kokoro-FastAPI/run-engine.sh ~/tts-engine/Kokoro-FastAPI/  # if missing
chmod +x ~/tts-engine/Kokoro-FastAPI/run-engine.sh
launchctl load ~/Library/LaunchAgents/com.ielts.kokoro-tts.plist
```

- `launchctl unload ~/Library/LaunchAgents/com.ielts.kokoro-tts.plist` to stop
- If the engine dies mid-exam, the affected line shows the "audio unavailable"
  panel — the exam continues from the subtitles; the next line plays normally.
