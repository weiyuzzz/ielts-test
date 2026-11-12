# [Voice] 预置考官音频通路实际未启用：题库没有 audio 字段，questionAudioUrl 恒为 null

<!-- labels: voice, bug -->

## 现状

为了「不让可疑录音冒充考官」，代码对预置音频做了严格限制：

```ts
function presetAudioFor(step, profileId) {
  if (!step.questionAudioUrl) return null;
  if (!step.questionVoiceProfile || step.questionVoiceProfile !== profileId) return null;
  return step.questionAudioUrl;
}
```

同时 `src/lib/server/bank-service.ts` 的导入逻辑**不写** `question_audio_url` /
`question_voice_profile`（`BankEntry` 只有 text / textZh / cuePoints，题库 JSON 里也没有音频字段）。

结论：`questionAudioUrl` 永远是 `null`，`preloadPresetAudio()`、`speakPreset()`、
`AudioPreloader` 的 preset 分支全部是**死代码**。工程质量没问题，但功能等于不存在。

## 为什么这仍然值得修

- 题库原文档每题都带考官提问 mp3（`Noise-1.mp3` 这类），真人录音的公信力高于任何 TTS。
- 一旦导入音频，`questionVoiceProfile` 的校验会立刻发挥作用：只有同一音色的录音才会被播放，
  不会出现「前半场真人后半场合成音」的割裂。

## 建议做法

1. `BankEntry` 增加 `audio?: string` 与 `audioProfile?: string`，导入时写入两列。
2. 音频文件放 `public/audio/questions/`（或对象存储），文件名与题库 `key` 对齐。
3. 后台 `/admin` 的题库详情显示每题是否有音频、录制 profile，便于排查「为什么没播录音」。
4. 若录音音色与用户选的 profile 不一致，**保持现在的行为**：跳过录音、用 TTS 合成并提示，不中途换人。

## 验收

- 至少一个主题的题卡带真实音频，考试中能听到录音而不是合成音
- 录音 profile 不匹配时仍然走 TTS，且日志/UI 能说明原因
- `/admin` 能看到音频覆盖率（多少题有录音）
