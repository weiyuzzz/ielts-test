# TTS 引擎部署与配置规则（考官语音 / Lip Sync）

> 本文档是考官语音链路的**部署约定**。考试中的 "Examiner audio unavailable"
> 面板意味着本规则未被执行——按本文配置即可消除。
>
> 适用范围：所有部署环境（开发 / 生产）。App 侧代码不需要任何改动即可切换引擎。

## 1. 引擎与端口约定

- 引擎：[remsky/Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)（本仓库口型系统依赖其
  `/dev/phonemize` 与 `/dev/captioned_speech` 词级时间戳端点——**这是 OpenAI
  `/audio/speech` 的超集**，纯 OpenAI 兼容服务无法提供词级口型锚定）。
- 固定监听 **0.0.0.0:8880**，健康检查 `GET /health`。
- App 通过 `TTS_BASE_URL` 指向它，URL 结尾带不带 `/v1` 均可（代码自动剥离）。

## 2. 设备选择（GPU 优先，自动回退）

引擎启动时自动检测，无需人工指定：

```
USE_GPU=true  →  CUDA (NVIDIA)  →  CPU   # Windows / Linux
USE_GPU=true  →  MPS (Apple Silicon)  →  CPU   # macOS 宿主机
```

- **macOS 必须宿主机直跑**（Docker VM 无法访问 GPU），参考
  `scripts/tts-engine/setup-tts-engine.sh`；Windows/NVIDIA 用
  `scripts/tts-engine/setup-tts-engine.ps1` 或下方手 steps。
- 实测速度（M2 MPS）：23 词长句 ≈ **3.3 s**（CPU 容器 30–60 s）。

## 3. Windows 部署步骤（生产）

```powershell
# 前置：git、uv（irm https://astral.sh/uv/install.ps1 | iex）、NVIDIA 驱动（GPU 路径）
git clone https://github.com/remsky/Kokoro-FastAPI D:\tts\Kokoro-FastAPI
cd D:\tts\Kokoro-FastAPI
.\start-gpu.ps1        # 无 NVIDIA 显卡时用 .\start-cpu.ps1
# 首次启动下载 ~1GB 模型；验证：
curl http://localhost:8880/health
```

**保活（必须）**——PyTorch MPS/CUDA 均有低频崩溃风险，不配保活会在考试中出现
"audio unavailable"：

```powershell
nssm install KokoroTTS "powershell" "-File D:\tts\Kokoro-FastAPI\start-gpu.ps1"
nssm set KokoroTTS AppDirectory D:\tts\Kokoro-FastAPI
nssm start KokoroTTS
```

macOS 用 `scripts/tts-engine/com.ielts.kokoro-tts.plist`（launchd KeepAlive，
本机已安装）。

## 4. App 侧配置（.env —— 以下为**必须遵守**的取值）

```ini
TTS_PROVIDER=openai
TTS_BASE_URL=http://localhost:8880/v1
TTS_MODEL=kokoro
TTS_VOICE=af_heart                 # 女（A 级）；男用 bm_george（英式）
TTS_STREAM=0                       # 【必须】禁流式：引擎分块流式对长句丢前半块（"只念后半句"）
TTS_TIMEOUT_MS=120000              # 【必须】30s 默认会令长句 502 → 无声
KOKORO_WORD_TIMESTAMPS=1           # 词级时间戳（anchored 口型），默认开
```

`/admin` AI 面板等价配置：TTS 卡 → OpenAI-compatible / Kokoro + 同 Base URL + Voice。

## 5. 行为约定（为什么不能随意改动）

- **禁止浏览器语音降级**（`noBrowserFallback`）：合成失败显示
  "Examiner audio unavailable" 面板（读字幕继续），绝不冒充真声。机械音会
  摧毁数字考官的沉浸感，这是有意的产品决策。
- **就绪门槛**：开考与每次切题前，App 会等待该题全部音频合成完毕才切换
  界面——引擎慢时表现为进度条/提示，而不是静默卡死。
- 词级时间戳驱动口型（`X-TTS-Words` 响应头）；缺少引擎时口型退化为
  `normalized`（近似），仍然远优于纯能量开合。

## 6. 替代方案（本机不适合跑本地引擎时）

Azure Speech（质量最高、零运维）：

```ini
TTS_PROVIDER=azure
AZURE_SPEECH_KEY=<key>
AZURE_SPEECH_REGION=<region>       # 如 eastasia
TTS_VOICE=en-GB-RyanNeural         # 男 / en-GB-SoniaNeural 女
```

代价：口型从 `anchored` 降为 `normalized`（无词级时间戳路径），但仍是内容
驱动口型，不是机械音。

## 7. 故障排查

| 症状 | 检查 | 处理 |
|---|---|---|
| "Examiner audio unavailable" 面板 | `curl :8880/health` | 引擎挂了 → launchd/NSSM 应已自动重启；持续失败查引擎日志 |
| 考官沉默但无面板 | 引擎日志（合成是否进行） | 等待正常（就绪门槛）；超过 2 分钟查引擎 |
| 只念后半句 | `TTS_STREAM` 是否为 0 | 设 0 后重启 App |
| 声音机械 | `TTS_PROVIDER` 是否为 openai/azure | 本地引擎未部署时不会有声音（禁降级），不会出现机械音 |
