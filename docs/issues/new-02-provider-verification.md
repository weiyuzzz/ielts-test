# [Voice] Azure / OpenAI 未实机验证：缺少密钥，自然度结论与默认音色仍未定

<!-- labels: voice, help wanted -->

## 背景

Phase 2 建了 VoiceProfile（5 个预设）与 Voice Lab，但本机只配置了 Kokoro
（`TTS_BASE_URL=localhost:8880`，`TTS_MODEL=kokoro`，`TTS_VOICE=af_heart`）。

**Azure Neural TTS 与 OpenAI `gpt-4o-mini-tts` 只做了代码与单元测试层面的验证，没有跑过真实合成。**

## 已确定的（有证据）

| 项 | 证据 |
|---|---|
| 请求未配置的 provider 会明确失败 | 实测 `502 [azure-tts] config: AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not configured` |
| act 真的改变波形 | 同句 `greeting` vs `question` md5 不同 |
| 缓存 key 含 profile/act/format | 单测 `profileFingerprint` + 客户端 `ttsTaskKey` 覆盖 |
| 语速参数生效 | 同一句 speed 0.90 / 1.10 产出体积不同 |

## 未验证的（不能编造结论）

- Azure SSML 在真实服务上是否 100% 合法（`<break time>` + `prosody` + `emphasis` 组合），以及 `mstts:express-as` 是否只在支持时使用。
- `gpt-4o-mini-tts` 的 `instructions` 是否真的按 act 产生语气差异（我们**不发送** `ssml` 字段给官方接口）。
- 三家引擎的主观自然度排序 —— 这只能靠耳朵，机器打分没有意义。
- `en-GB-SoniaNeural` 与 `en-GB-RyanNeural` 哪个更适合做考官。

## 待办

1. 配置 `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION`，在 `/settings` 的 Voice Lab 用固定 7 句语料逐条试听，记录合成延迟 / 体积 / 采样率 / 错误原文。
2. 配置 `OPENAI_API_KEY`（或支持 `instructions` 的兼容服务），同样跑 7 句。
3. 对比后确定**默认 profile** 写进 `.env.example` 与 README，并说明取舍（口音 vs 自然度 vs 延迟 vs 成本）。
4. 把结论回填本 issue，附 7 句语料的 A/B 听感记录（人工，不是机器分）。

## 验收

- `Voice Lab` 中 azure / openai / kokoro 三家都能出音且无 4xx
- README「考官语音」章节给出实测延迟表与推荐配置
- 未配置的 provider 仍保持明确报错，不静默替换
