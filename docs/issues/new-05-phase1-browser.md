# [Speaking][Phase 1] 浏览器手工验收与真实设备回归（自动测试覆盖不到的部分）

<!-- labels: voice, test, help wanted -->

## 为什么要单独留一条

Phase 1 + Phase 2 已合并进 `main`（`80d58a2`），自动化检查全绿：

```bash
npm run typecheck && npm run lint
npx tsx --test tests/unit.test.ts        # 30
npx tsx --test tests/audio-perf.test.ts  # 24
node tests/integration.mjs http://localhost:3100   # 30
```

但音频链路的几个关键行为**只能在真实浏览器里看**。本机 Playwright 驱动与缓存浏览器版本不匹配，
重新下载被安全策略中断（进程被 SIGTERM），所以这部分一直没有验证过，不能算「已完成」。

## 待人工验收清单

| # | 检查项 | 期望 | 备注 |
|---|---|---|---|
| 1 | `<audio>` 渐进流是否从**第一个 chunk** 起播 | 首字节到达即出声，不等整段合成完 | Chrome + Safari 各一次 |
| 2 | 两段考官语音绝不重叠 | 上一句 `ended` 后才开始下一句 | 复现方式：连点两题 / 刷新后立刻进入 |
| 3 | 中断与失败不推进考试 | 拔掉网络后口播失败 → 出现「Examiner audio unavailable」并要求确认 | 不允许静默跳到下一题 |
| 4 | `getUserMedia` 权限提示与中途换设备 | 拒绝权限有恢复 UI；答题中拔麦克风不崩，已录部分保留 | `recording-session.reopen()` |
| 5 | AudioWorklet 是否在音频线程渲染 PCM | `public/audio/pcm-worklet.js` 正常加载，控制台无回退告警 | 失败会自动回退 ScriptProcessor |
| 6 | Safari Range 请求 | `questionAudioUrl` 播放返回 206 | 预置音频启用后才有意义（见另一条 issue） |
| 7 | iOS 用户手势解锁 | 首次点击后 `speechSynthesis` 可发声 | 浏览器兜底路径 |
| 8 | 圆环方向与音量反馈 | 准备顺时针、作答逆时针；说话时 32 根条随音量动 | 98ba2b1 的视觉效果 |

## 顺带需要记录的数字

- `window.__B9_AUDIO_METRICS__()`：`tts_synthesis_ms` / `playback_start_delay_ms` / `inter_turn_gap_ms` 的真机值
- `X-TTS-Cache` 命中率（预热整场后应接近 100%）

## 验收

- 上表 1–8 全部在 Chrome / Safari 上过一遍，结果回填本 issue
- 若发现偏差，单独开 issue 并附复现步骤，不在这条里直接改

## 来源

本 issue 承接已归档的 Phase 1 跟踪 issue 第四、五节（「未验证项」与「设计权衡」），
其余已修复内容见 `docs/phase2-examiner-voice.md` 的合并记录。
