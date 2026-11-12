# =============================================================================
# IELTS platform - local TTS engine (Kokoro-FastAPI) setup, Windows
#
# GPU-first with automatic fallback (engine auto-detects at boot):
#   NVIDIA GPU  -> PyTorch CUDA (GPU, ~5-10x faster than CPU)
#   no GPU      -> CPU
#
# Requires: git, uv (https://docs.astral.sh/uv/), NVIDIA driver + CUDA for GPU.
# The engine runs on the HOST so CUDA is directly available (Docker + WSL2 also
# works, but the host process is the simplest path).
#
# Usage:
#   .\setup-tts-engine.ps1            # GPU-first (auto CUDA/CPU)
#   .\setup-tts-engine.ps1 cpu        # force CPU
# =============================================================================
param([string]$Mode = "gpu")

$ErrorActionPreference = "Stop"
$EngineDir = if ($env:TTS_ENGINE_DIR) { $env:TTS_ENGINE_DIR } else { "$HOME\tts-engine\Kokoro-FastAPI" }
$Repo = "https://github.com/remsky/Kokoro-FastAPI"
$Port = if ($env:PORT) { $env:PORT } else { "8880" }

Write-Host "==> TTS engine setup (mode: $Mode)"

# 1) Stop any Docker Kokoro container holding the port.
$dockerOk = Get-Command docker -ErrorAction SilentlyContinue
if ($dockerOk) {
  $containers = docker ps --format "{{.Names}}" 2>$null | Select-String -Pattern "kokoro" -SimpleMatch
  if ($containers) {
    Write-Host "==> Stopping the Docker kokoro container(s) (they occupy port $Port)"
    $containers | ForEach-Object { docker stop $_.ToString().Trim() }
  }
}

# 2) Clone / update the engine.
if (-not (Test-Path $EngineDir)) {
  Write-Host "==> Cloning Kokoro-FastAPI into $EngineDir"
  git clone --depth 1 $Repo $EngineDir
}
Set-Location $EngineDir
git pull --ff-only 2>$null

# 3) Start script per mode (official launcher; the engine auto-detects
#    CUDA and falls back to CPU by itself).
if ($Mode -eq "cpu") { $Start = "start-cpu.ps1" } else { $Start = "start-gpu.ps1" }

Write-Host "==> Starting the engine with $Start (first run downloads the model, ~1GB)"
Start-Process -FilePath "powershell" -ArgumentList "-NoExit", "-File", $Start -WorkingDirectory $EngineDir

# 4) Wait for health.
Write-Host "==> Waiting for http://localhost:$Port/health"
$ok = $false
foreach ($i in 1..120) {
  try {
    Invoke-WebRequest -Uri "http://localhost:$Port/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
    $ok = $true; break
  } catch { Write-Host -NoNewline "."; Start-Sleep -Seconds 2 }
}
if ($ok) {
  Write-Host "`n==> Engine is up. Check the engine window for the device line (cuda/cpu)."
} else {
  Write-Host "`n==> TIMEOUT - check the engine window output."
  exit 1
}
