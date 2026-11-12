# [Voice][Avatar] 数字考官 + Lip Sync 系统上线后的问题跟踪与真机回归

<!-- labels: voice, enhancement, test -->

## 背景

数字考官（Three.js + GLB，5 男 5 女不同面孔）与词级锚定 Lip Sync 已合入
`feat/examiner-digital-human-lipsync`。真机联调发现并修复了若干链路问题，
本 issue 跟踪两件事：**已修项的真机回归验收** 与 **未根治的遗留风险**。

## 已修复，待真机回归

| 问题 | 根因 | 修复 |
|---|---|---|
| 考官声音变机械音 | 合成失败时降级到浏览器语音 | 全链路禁降级（`noBrowserFallback`）：失败显示 "audio unavailable" 面板，读字幕继续 |
| 题目只念后半部分 | 引擎分块流式丢弃前半块 + MPS 崩溃链 | 禁用流式（`TTS_STREAM=0`），统一走完整合成（含词级时间戳） |
| 切下一题音频丢失 | UI 先切换、音频未就绪 | `say()` 在触碰 UI 前逐行等待全部台词就绪（advancing 界面显示等待） |
| 开考进度条 4/64 突然跳页 | 进度条显示全脚本预热（64 行），跳转门槛是开场 2-3 句 | 进度条改为只显示开场行就绪度，与门槛一致 |
| 确认开考后卡顿 + 口型不同步 | 数字人组件在确认后才挂载，15MB 模型重载 | 模型从麦克风调试页起挂载并贯穿全程（零重载）+ 开场 viseme 轨道预热 |
| 进麦克风调试即弹权限 | MicCheck 挂载即 acquire | 改为显式「Enable microphone test」按钮；「Turn off microphone」完全释放 |
| MPS 引擎进程死亡导致 audio unavailable | PyTorch MPS 崩溃 + 无进程管理 | macOS launchd KeepAlive（崩溃 5 秒内自动重启、开机自启） |

## 未根治的遗留风险

1. **PyTorch MPS 崩溃（MPSGraph objc over-release）**
   - 已缓解：launchd 秒级重启 + 播放等待轮询覆盖重启窗口；单次崩溃只影响
     当句（提示面板读字幕继续）。
   - 未根治：崩溃本身来自 PyTorch 2.8 的 MPS 后端。候选方案：升级/降级
     torch、切回 CPU（稳定但 30s/句）、或 Windows/NVIDIA CUDA 验证后统一。
   - 需要数据：记录崩溃频率再决策。
2. **考官 GLB 未压缩**（10 × ~14MB）：首次加载偏慢。候选：gltf-transform
   + meshopt/draco 压缩至 ~1/3。
3. **Windows/NVIDIA CUDA 路径未实机验证**：脚本已备
   （`scripts/tts-engine/setup-tts-engine.ps1`），需要一台 NVIDIA 机器回归。
4. **Azure / OpenAI 真声未实机验证**：同 #3（旧 issue）。

## 验收清单（真机）

- [ ] 完整模考：开考进度条 → 麦克风调试 → 考官开口，全程无机械音
- [ ] 快速跳题（5 秒后 early-finish）连续 5 次：无音频丢失、无截断
- [ ] 刷新恢复：考官形象/声音/进度与中断前一致
- [ ] 设置页切换 10 位考官：形象、姓名、声音联动正确
- [ ] Lip Sync Lab：所有音色试听（等待进度条出现、无降级）
- [ ] 引擎崩溃注入（kill 引擎进程）：当句提示面板，下一句自动恢复真声
