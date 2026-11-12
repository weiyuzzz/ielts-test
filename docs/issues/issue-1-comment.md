## 更新：并行冲突已解决，Phase 1 已合入 main

> 集成分支 `integration/voice-perf` → `main`，提交 **`80d58a2`**（远程已同步）。
> 本 issue 第五节列出的「合入前必须处理」的 3 个重叠文件已全部解决，第六节验收清单逐项对照如下。

### 一、合并方式（没有「取我方」丢功能）

三步合并，基线是 `origin/main`：

```
077a6e3  main 共同祖先
  ├─ 98ba2b1  main：Part3 延续 Part2、环形倒计时、真实音量反馈
  └─ cb68fa0  Phase 1：音频调度 / 生命周期 / 录音会话（本 issue）
                ↓
80d58a2  main = 077a6e3 + 98ba2b1 + cb68fa0 + Phase 2(e8f54f5)
```

| 重叠文件 | 实际冲突 | 处理结果 |
|---|---|---|
| `exam-runner.tsx` | **唯一冲突**：录音启动处（`DualRecorder` vs `RecordingSession`） | 取 Phase 1 的 `RecordingSession.startAnswer()`，**保留 98ba2b1 的快起慢落音量包络**（`setLevel` + `setBars`），倒计时圆环与 `bars` 全部保留 |
| `exam-service.ts` | 无冲突（自动合并） | Phase 1 的 `completeAnswer()` 与 98ba2b1 的 Part3 同话题抽题**同时存在**，已回归验证 |
| `docs/architecture.md` | 无冲突 | 新增的 4.2 音频章节保留，4.1 链路图按合并后的实现重写 |

Phase 2（`phase2/examiner-voice`，本 issue 第五节提到的另一分支）也已合入。职责边界确认如下，**没有重复实现延迟改造**：

- Phase 1：调度器、播放状态机、录音会话、complete-answer、metrics —— 全部保留为唯一音频管线。
- Phase 2：只做「怎么说像人」——VoiceProfile（provider 与音色解耦）、SpeechAct（7 种表达）、Voice Lab。
- 两者的接缝：`ttsTaskKey` 扩展 `act` / `profile`；服务端缓存 key 改为 `provider + model + profileFingerprint(act, format) + text`；`AudioPreloader` 的预热与首句门禁都按 session 的 profile 合成。**不存在第二套队列或第二份缓存。**

### 二、验收清单对照

- [x] 有 PostgreSQL 环境跑通集成测试 —— **30/30 通过**（原 27 项 + Phase 1 的 complete-answer 3 项 + TTS 缓存 3 项，实际条目见 `tests/integration.mjs`）
- [x] 与 `98ba2b1` / `phase2/examiner-voice` 协调后合并，确认无功能回退 —— 倒计时、音量反馈、Part3 同话题组卷全部回归通过
- [x] `npx tsc --noEmit` / `npx eslint .` / `npx next build` —— 全部通过
- [x] `tests/unit.test.ts` **30/30**、`tests/audio-perf.test.ts` **24/24**
- [ ] **浏览器手工验收（BROWSER-ONLY）仍未做** —— 本机 Playwright 驱动与缓存浏览器版本不匹配，重新下载被安全策略中断（进程被 SIGTERM），所以「渐进流是否从首个 chunk 起播 / 两段语音绝不重叠 / AudioWorklet 渲染 / iOS 手势解锁 / Safari Range」这些只能由人工在真实浏览器确认
- [x] 真实 TTS provider 下 `X-TTS-Cache: hit / miss / miss-stream` —— 本机 Kokoro 实测通过（重复请求 10 ms 命中）

### 三、合并后实测数据（本机 Kokoro，3100 端口）

| 场景 | 结果 |
|---|---|
| 同一句 `act=greeting` vs `act=question` | 200，29612 B / 29228 B，**md5 不同** → 表达类型真的改变波形 |
| 重复请求同一 (text, act, profile) | **0.010 s**，`X-TTS-Cache: hit` |
| 冷启动短句 | 2.6–3.2 s（CPU 引擎） |
| 未配置 Azure 却显式请求 `profile=azure-sonia` | **502** `[azure-tts] config: AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not configured`，不静默换声音 |
| complete-answer 往返 | 44 ms |

### 四、对第三节「设计权衡」的回应

四条权衡**全部保留**，未擅自调整：

1. `say()` 失败时保留一次用户确认（复用 `blocked` UI）—— 合并后依旧，且现在失败判定更严格（截断/中断不算播完）。
2. `finish` 仍为独立请求 —— 未动。
3. 服务端 TTS 缓存是进程内 LRU，多实例不共享 —— 未动，已作为 Phase 3 待办（见新 issue）。
4. Safari < 14.1 回退 `ScriptProcessorNode` —— 未动。

### 五、合并中发现并修掉的一个真实缺陷

Phase 2 原实现把首句门禁预热成 `ack + lead + question` **拼接后的长句**，而实际播放是**三段独立音频**。结果：白合成一次长音频，首句仍然没准备好，等于门禁失效。

合并后门禁与播放共用同一组 `ScriptLine[]`（`buildScriptPlan().firstLines`），`ensureOpeningAndFirst()` 逐段等待。这属于「并行开发各自正确、合起来才暴露」的问题，正好是本节列出的风险类型。
