# Phase 2 — Examiner Voice System 交付报告

分支：`phase2/examiner-voice`（基于 `main` @ 98ba2b1）

本阶段只做考官语音的自然度、音色一致性与 Provider 管理，不改考试流程、题库与评分。
Phase 1 的预取 / 流式 / 缓存调度保持不变，只在其上增加 profile 维度。

---

## 1. 当前考官声音存在的问题

改造前逐条核对代码与实测：

| 问题 | 具体表现 | 根因 |
|---|---|---|
| 声音机械 | 长句听起来像导航播报 | 整段文本一次性合成，无句间呼吸；只有一种 rate |
| 各类台词一个腔调 | 问候、Part 引导、提问、叫停、结束语完全相同 | 没有「谁说这句话、说的是什么类型的话」的概念，所有文本走同一条路径 |
| 停顿机械 | 只在标点处机械停顿 | 停顿长度写死（weak/medium），与句子功能无关 |
| 音色可能不一致 | 题库预置音频、Azure、OpenAI、Kokoro 混用 | 没有统一的音色身份；预置音频不做音色校验就直接播放 |
| 配置无法统一 | 每家 provider 参数不同 | `TTS_VOICE` 里塞 Azure 音色名或 Kokoro 音色名，靠字符串猜 provider |
| 没有试听手段 | 只能改完重启再听 | 缺 A/B 工具，也无法看到合成耗时与格式 |
| 考试中音色可能被改 | 改设置影响进行中的考试 | 音色只存在用户设置里，session 没有快照 |

## 2. 修改的文件及原因

| 文件 | 改动 | 原因 |
|---|---|---|
| `src/lib/speaking/voice-profile.ts` | **新增** | VoiceProfile 类型、5 个内置预设、env/旧值解析、指纹、入参清洗 |
| `src/lib/speaking/speech-act.ts` | **新增** | 7 种 SpeechAct 及各自的语速系数、停顿、强调策略、steering 文本 |
| `src/lib/ai/tts-text.ts` | 新增 `prepareExaminerSpeech` / `toAzureSsmlForAct` / `pickEmphasisWord`；保留旧函数 | 文本前端的唯一入口；按 act 产出纯文本、SSML、instructions、rate |
| `src/lib/ai/types.ts` | `TTSProvider` 增加 `supports` 能力描述；选项增加 `profile` / `speechAct` | 让上层知道引擎到底支持什么，而不是假设 |
| `src/lib/ai/providers.ts` | 重写 OpenAI 兼容与 Azure 两条通道；删除重复的 azureTTS | 按能力分支发送字段；Azure 用精确 `<break time>` + `prosody` + `emphasis` |
| `src/lib/ai/registry.ts` | 新增 `getTTSFor(provider)` / `ttsAvailability()`；capabilities 暴露 profiles、acts、availability | 显式选择 provider 时必须命中或明确失败，不能静默换声音 |
| `src/app/api/tts/route.ts` | 接受 `act` / `profile`（id 或完整对象）；缓存 key 改为 profile 指纹 | 缓存必须区分全部影响波形的参数 |
| `src/lib/audio/speech.ts` | 预取与播放链路带上 act / profileId；浏览器回退按 act 调整 rate/pitch | 同一句话按不同 act 合成是不同音频，客户端缓存键也要区分 |
| `src/app/speaking/exam/[id]/exam-runner.tsx` | 台词拆成带 act 的 `ScriptLine[]`；ack 独立成句；预置音频做音色校验；使用 session 快照音色 | 表达类型要落到真实的每一句话上；音色不能被预置音频或新设置悄悄换掉 |
| `src/lib/server/exam-service.ts` | 创建考试时写入 `configSnapshot.voiceProfile`；返回 `questionAudioProfile` | 音色快照；预置音频来源可追溯 |
| `src/lib/server/bank-service.ts` | 题目支持 `questionAudioUrl` + `questionVoiceProfile` | 预录音频必须带来源音色 |
| `src/db/schema.ts` | `questions.question_voice_profile` | 同上（已 `drizzle-kit push`） |
| `src/app/settings/settings-form.tsx` | 音色改为 profile 下拉，未知值保留为 custom | 旧值兼容，避免用户设置被丢弃 |
| `src/app/settings/voice-lab.tsx` | **新增** | A/B 试听、指标展示、保存为考试音色 |
| `src/app/settings/page.tsx` | 接入 Voice Lab，展示当前 profile | — |
| `tests/unit.test.ts` | 新增 7 项测试（29 项） | act 策略、SSML 合法性、profile 解析与指纹、参数清洗 |
| `README.md` / `.env.example` / 本文件 | 文档与配置说明 | — |

## 3. 新的 VoiceProfile 架构

```
内置预设 + 环境变量        用户偏好(users.examiner_voice)     考试快照(configSnapshot.voiceProfile)
        │                          │                                  │
        └── resolveVoiceProfile ───┴──────────────────────────────────┘
                                   │
                        VoiceProfile { provider, voice, speed, pitch, style?, instructions?, prosody }
                                   │
                    prepareExaminerSpeech({ text, speechAct, profile })
                                   │
              plain text / SSML / instructions / final speed / pitch
                                   │
                     provider adapter（能力探测后只发支持的字段）
```

三层职责清晰：预设是默认值，用户偏好决定「下一场」，快照决定「这一场」。
`profileFingerprint()` 把 provider、voice、language、speed、pitch、style、instructions、prosody、act、format 串成缓存身份。

## 4. Provider 实际能力对比

| Provider | SSML | instructions | style | pitch | 降级行为 | 本机实测 |
|---|---|---|---|---|---|---|
| Azure Neural | ✅ 精确 `<break time="Xms">`、`prosody rate/pitch`、`emphasis` | ❌ | 仅在显式配置 style 时发 `mstts:express-as` | ✅ 半音→百分比 | 不支持的 style 不发；非法 XML 由单测拦截 | **未配置密钥**，仅离线校验 SSML 合法性与降级逻辑 |
| OpenAI `gpt-4o-mini-tts` | ❌ 官方拒绝未知字段 | ✅ 按 act 分派 | ❌ | ❌ | 不发 `ssml` 字段 | **未配置密钥** |
| OpenAI `tts-1` / `-hd` | ❌ | ❌ | ❌ | ❌ | 只发纯文本 | 未配置 |
| Kokoro（OpenAI 兼容） | ✅ `<break strength>` | ❌ | ❌ | ❌ | 不支持时退回纯文本 | ✅ 实测（本机 8880） |
| Browser `speechSynthesis` | ❌ | ❌ | ❌ | ✅ | 明确告知是浏览器回退 | ✅ |

能力探测写在 provider 构造时（`supports`），并暴露到 `/api/config`。

## 5. 默认推荐声音与参数

| 场景 | 推荐 | 参数 |
|---|---|---|
| 有 Azure 密钥 | `azure-sonia`（en-GB-SoniaNeural） | speed 0.96、pitch 0、48kHz PCM |
| 只有 OpenAI | `openai-marin` | speed 0.97、instructions 按 act 分派 |
| 本机 Kokoro | `kokoro-af-heart` | speed 0.95、SSML 停顿、mp3 |
| 无任何服务 | `browser-en-gb` | rate 0.94、pitch 1.0，并声明是回退 |

选择依据：Azure Sonia 是现成最自然的英式神经音色；Kokoro 的 `af_heart` 是 A 级音色但偏美式，本机默认沿用；`bf_emma` 虽是英式但官方评级 B-。

## 6. A/B 测试结果

**如实说明**：本机只配置了 Kokoro，Azure 与 OpenAI 未配置密钥，因此**无法给出四家 provider 的主观听感对比**，也不编造。已交付的是可复现的测试手段与客观数据。

同一句话（`Thank you. That is the end of the speaking test.`，act=closing）换语速：

| 参数 | 输出体积 | 合成耗时 | 说明 |
|---|---|---|---|
| speed 0.90 | 65,708 B | 6.13 s | 更慢 → 音频更长 |
| speed 1.10 | 57,644 B | 6.40 s | 更快 → 音频更短 |

同一句话（`Do you enjoy reading books?`）换 act：

| act | 输出体积 | 合成耗时 | 缓存 |
|---|---|---|---|
| greeting | 29,612 B | 7.29 s（冷） | miss |
| question | 29,228 B | 1.23 s（冷） | miss（不同 key） |
| greeting 重放 | — | **0.009 s** | hit |

md5 不同 → 不同 act 确实产生不同音频，而不是复用同一段。

主观结论需要你在 `/settings` 的 Voice Lab 里自己听：选 A/B 两个 profile，点「A/B compare」，用固定 7 句语料横向比较。

## 7. 音色一致性测试

| 场景 | 机制 | 验证 |
|---|---|---|
| 同一场考试 | `configSnapshot.voiceProfile` 冻结；客户端优先用快照 | 代码路径 + `resolveSessionVoice` 回退到部署默认（不会随机换人） |
| 考试中改设置 | 快照优先，props 变化不影响 | `voiceRef` 只被快照覆盖 |
| 预置音频 | 必须有 `questionVoiceProfile` 且与本次 profile 一致才播放 | 否则跳过并提示，改用 TTS |
| Provider 未配置 | `getTTSFor` 抛 config 错误 | 实测返回 `502 {"error":"[azure-tts] config: AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not configured"}`，不静默降级 |
| 换音色后的缓存 | key 含 profile 指纹 | 单测断言 voice/speed/pitch/act/format 变化都会改变 key |

## 8. 合成延迟测试

本机 Kokoro（CPU）：

| 场景 | 耗时 |
|---|---|
| 短句冷启动（greeting） | 6.1–7.3 s |
| 短句冷启动（question，引擎内部有文本缓存） | 1.2–1.5 s |
| 命中服务端缓存 | 0.009 s |
| 长句（Part 2 说明，Phase 1 数据） | 9 s，但发生在 setup 预取阶段，用户无感 |
| 未预取的动态追问（Phase 1 数据） | 首字节约 3 s 出声 |

Phase 2 没有增加任何新的同步合成点：act 只改变合成参数，不改变调用次数；ack 拆成独立短句后，单句更短、预取命中率更高。

## 9. 尚未解决的问题

1. **Azure / OpenAI 未做真机验证**：没有密钥。SSML 合法性、字段分支、降级行为有单测与代码保证，但真实音质与 `instructions` 是否生效需要配好密钥后在 Voice Lab 复核。
2. **主观自然度未评分**：这是刻意的——机器打分不能代表真人听感。当前只提供 A/B 工具。
3. **`mstts:express-as` 的 style 白名单**：取决于具体神经音色，目前只在显式配置时发送；若要启用，需要按音色文档确认支持列表。
4. **浏览器回退的音色匹配**：旧值 `af_heart` 在浏览器里匹配不到同名 voice，会退到「云端/Neural 优先」的启发式选择；这是回退路径，已在设置页注明。
5. **预置音频库为空**：机制已就绪（字段 + 校验 + 提示），但题库没有实际录音文件，未做端到端播放验证。

## 10. Phase 3 建议

1. **接入真实预置音频**：为高频固定台词（开场、Part 2 说明、叫停、结束语）录制一套 `azure-sonia` 音频，带 `questionVoiceProfile` 入库；这类台词占整场 40% 以上，可彻底消除设备端 TTS 延迟与音色漂移。
2. **音色 A/B 的量化辅助**：仍以人耳为准，但可增加「基频方差 / 停顿分布 / 语速稳定性」等客观指标作为参考，不做自动评分。
3. **按 section 细分 act**：Part 3 追问可单独设为 `probe`，语速略快、停顿更短，更接近真实考官的追问节奏。
4. **多考官音色轮换**：目前每场随机考官姓名但音色固定；可让姓名与 profile 绑定，并保证同一 session 内一致。
5. **Voice Lab 增加批量对比**：一次跑完 7 句语料并生成对比表（延迟/体积），便于回归时快速发现 provider 退化。
6. **把 Azure 的 `style` 做成受控枚举**：仅对确认支持 `chat`/`calm` 的音色开放，避免 400。

---

## 复现命令

```bash
npm run typecheck
npm run lint
npx tsx --test tests/unit.test.ts     # 30 项
npx tsx --test tests/audio-perf.test.ts   # 24 项（Phase 1 调度/生命周期）
npm run build && npx next start -p 3100
node tests/integration.mjs http://localhost:3100   # 30 项

# 手工验证 act 与 profile 隔离
curl -s -b cookie -X POST localhost:3100/api/tts -H 'Content-Type: application/json' \
  -d '{"text":"Do you enjoy reading books?","act":"greeting","profile":"kokoro-af-heart"}' -D -
# 响应头：X-TTS-Act: greeting / X-TTS-Cache: miss
```


---

## 与 Phase 1 的合并记录（`integration/voice-perf`）

Phase 1（`feat/speaking-audio-perf-phase1`）与 Phase 2（`phase2/examiner-voice`）从同一个
commit 分叉，两边都重写了 `speech.ts` / `tts/route.ts` / `exam-runner.tsx`。合并原则是
**保留 Phase 1 的底座，把 Phase 2 的语音表现层接上去**，而不是让两套音频管线共存。

| 文件 | 处理方式 |
|---|---|
| `tts/route.ts` | 保留 Phase 1 的 live/prefetch 优先级、取消 warm-up、in-flight 共享；缓存 key 换成 `provider + model + profileFingerprint(act, format) + text` |
| `lib/audio/speech.ts` | 保留调度器与播放状态机；`ttsTaskKey` 增加 `act` / `profile`，POST/GET 都带上；浏览器回退按 act 调整 rate/pitch |
| `lib/audio/audio-resources.ts` | `PreloadEntry` 带 `act`，预热与首句门禁都使用 session 的 profile；`classifyScriptLines` 仍接受纯字符串（Phase 1 的单测全部保留） |
| `exam-runner.tsx` | 冲突只在录音启动处（取 `RecordingSession` + 保留音量包络）。语音侧改为「一句台词拆成多段、每段带 act」，逐段播放；首句门禁改为等待真实的分段，而不是一个不会被播放的合成长句 |
| `exam-service.ts` | 在 Phase 1 的 `completeAnswer` 基础上补回 `configSnapshot.voiceProfile` 快照与 `questionVoiceProfile` |

合并时发现并修掉的一个真实缺陷：Phase 2 原实现把首句门禁预热成 `ack + lead + question`
拼接后的长句，而实际播放是三段独立音频 —— 等于白合成一次、首句仍然没准备好。合并后门禁
与播放使用同一组 `ScriptLine`。

验证：`typecheck` / `lint` / 30 单测 / 24 音频测试 / 30 项集成测试通过；实测同一句
`act=greeting` 与 `act=question` 音频 md5 不同，重复请求 10 ms 命中缓存，未配置 Azure
时返回 `502` 而不是换声音。
