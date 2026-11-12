# 音频系统逆向

证据：`speak-evaluation-a5a6b953.js`、`speaking-mock-df5b4187.js`（REA 已解析；下文出现的常量都在源码中直接可见）。

## 1. 采集 [VERIFIED]
- 用 `navigator.mediaDevices.getUserMedia({audio:{channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true}})` 获取麦克风。
- 要求 `isSecureContext`，否则报"当前浏览器不支持录音，请确认使用 HTTPS 或更换浏览器"。
- **双通道录音**：
  1. `MediaRecorder` 按顺序协商 MIME：`audio/webm;codecs=opus` → `audio/webm` → `audio/ogg;codecs=opus` → `audio/mp4`，都不支持时用浏览器默认值。`ondataavailable` 收集 chunk，`onstop` 时合成 Blob，用于回放。
  2. Web Audio：`new AudioContext({sampleRate:16000})`（失败时回退到默认采样率）→ `createMediaStreamSource` → `createScriptProcessor(4096,1,1)` → gain=0 的 GainNode → destination，收集 **PCM Int16** 分块（`pcmInt16Chunks`），并计算音量 `volume`。
- 兼容 `webkitAudioContext`（Safari）。
- 麦克风 track 的 `ended` 事件会触发 `microphone/disconnected` 错误。[VERIFIED] 这对应"录音中切换或拔出设备"的处理。
- [VERIFIED] 没有调用 `enumerateDevices`，即**不提供设备选择**。没有 AudioWorklet。
- [VERIFIED] 最短时长：后台收尾任务使用 `minDurationSeconds:1`。

## 2. 实时 ASR：火山引擎 [VERIFIED]
- WebSocket：`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`，`binaryType=arraybuffer`。
- 鉴权：先请求本站 `/api/study/kouyu-zhenti/v1/evaluation/volcengine-sts-token` 拿临时凭证，再拼 URL 参数 `api_app_key`、`api_access_key="Jwt; <token>"`、`api_resource_id=volc.seedasr.sauc.duration`、`api_connect_id`。即**浏览器直连 ASR，服务端只签发短期 Token**。
- 二进制协议：header（version/headerSize/messageType: fullClientRequest=1, audioOnlyRequest=2, fullServerResponse=9, serverErrorResponse=15；flags；JSON 序列化；可选压缩）。
- 请求参数片段：`end_window_size: max(200, volcengineEndWindowSize||800)`（服务端 VAD 断句窗口，单位 ms）、`force_to_speech_time:1000`。
- 采样：16 kHz 单声道，按固定毫秒分包发送（`Math.floor(16000*Ep/1000)` 个样本一包）。
- 有"等待实时转写结果超时"错误，并有超时余量 `+2000ms`。
- 时间戳：结果页存在 `wordAlignments` / `speak-aligned-word`。[INFERRED] 带词级时间戳。
- [INFERRED] 标点恢复由 bigmodel ASR 提供；[UNKNOWN] 是否开启了 ITN/标点参数。

## 3. 发音评测 SDK [VERIFIED]
- 全局 `window.EngineEvaluat`（动态加载 SDK，`loadSdk`，12s 超时），参数包括 `applicationId`、`userId`、`warrantId`（来自 `/api/study/kouyu-zhenti/v1/evaluation/authorize`）、`coreType:"en.pred.score"`、`refText`、`precision:0.5`、`outputPhones:1`、`phdet:1`、`rank:9`、`evalTime:15000`、`saveAudio:0`、`needResample:true`、`configAudio({sampleRate:16000})`。
- 把 PCM 按 4096 样本分片喂给 SDK；从结果中读取 `result.overall ?? result.pron`，缺失时报 `no-score`。
- 输出包含音素（phones，界面上是 `phoneme-progress-*`）以及 accuracy/fluency/integrity/rhythm/stress/intonation/speed 等字段（从中文标签映射表推断字段名）。
- [INFERRED] `en.pred.score` 是"开放题/预测文本"评测：用 ASR 文本作为 refText 喂给发音引擎。
- [UNKNOWN] 具体供应商。`EngineEvaluat` + `warrantId` 的命名和国内某些口语评测厂商的 Web SDK 一致，但没有直接证据。

## 4. 考官语音 [VERIFIED]
- **预录 TTS**：配置为 `{provider:"volcengine", resource_id:"seed-tts-2.0", speaker:"zh_female_vv_uranus_bigtts", format:"mp3", sample_rate:24000}`，共 18 条固定脚本（`00_product_intro` … `17_test_end`），以 MP3 形式存放在阿里云 OSS `lbxl-audio/kouyumokao/`。
- 考官人设名为 "Leo"（脚本文本），音色名称却是女声 speaker（配置与人设不一致，属于观察到的事实）。
- 题目音频：题库字段 `question_audio_url`。[INFERRED] 也是离线批量生成的 TTS。
- 动态模板（如 `part_3_introduction`）的 `audio_url:null`。[UNKNOWN] 运行时怎么发声：模考 chunk 里没有 speechSynthesis 调用，入口 bundle 的 speechSynthesis 用于单词发音模块。
- 可开关字幕 `speaking_mock_show_subtitles`。[UNKNOWN] 是否支持重复播放题目：模考流程中没找到 repeat 分支。

## 5. 传输与上传
- [VERIFIED] 没有 WebRTC。ASR 走 WebSocket 实时流。
- [VERIFIED] 回放音频 URL 的优先级：`localAudioUrl → oss_url → cloudAudioUrl → audio_url`。[INFERRED] 录音会上传到 OSS。
- [UNKNOWN] 上传的具体端点、分片方式、进度和重试。模考 chunk 只有后台 `submissionTask`，上传逻辑在 REA 未覆盖的其他 chunk 中。

## 6. 超时与错误模型 [VERIFIED]
统一的 `Vt(fn,{signal,timeout=20000,stage})` 包装：AbortSignal 可取消，超时时抛出 `{stage, code:"timeout"}`，并按逆序执行 cleanup。stage 包括 microphone / recognition-auth / recognition / evaluation-auth / evaluation-sdk / evaluation / mediaRecorder / audioSampler。

## 7. 对我们的启示
- 学习：MIME 协商列表、16k PCM 并行采集、按 stage 分类的错误、track ended 处理、ASR/评测 Token 由服务端短期签发。
- 改进：增加设备选择；音频入库、可重放、可重试；把 ASR 放在服务端适配器后面，便于更换供应商。
