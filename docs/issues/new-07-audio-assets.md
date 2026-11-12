# [Content/Voice] 考官音频资源缺口：0/508，需要授权录音与音色标注

<!-- labels: voice, content, help wanted -->

已关闭的 #2 只解决了「通路与校验」，资源本身仍为 0。这条只跟踪资源获取，代码侧不需要再改。

## 现状

```
GET /api/admin/banks?id=3
audio: { total: 508, ready: 0, missing: 508, coveragePercent: 0 }
```

## 关键约束：录音必须与考试音色一致

运行时判定是**严格字符串相等**（`questionVoiceProfile === session.voiceProfile.id`，`exam-runner.tsx`）。
不同音色的录音不会「部分生效」，而是直接回退 TTS。因此：

- 先定考官音色基线（当前部署 `kokoro-af-heart`；若计划换 Azure，先定再录）。
- `questionVoiceProfile` 写**考试实际使用的 profile id**（`azure-sonia`），
  不要写 `azure:en-GB-SoniaNeural`——同一音色但字符串不等，会被拒（后台标为「仅需改标签」）。

## 待办

1. 确定音色基线。
2. 录制/获取 508 条题干音频（同一说话人、设备、房间；Part 2 题卡另录整卡朗读）。
3. 授权确认：源文档自带 mp3 授权不明，未经确认不得入库。
4. 托管：HTTPS 长链接；本地开发可用 `http://localhost`（唯一放行项）。

## 验收

- [ ] `/admin` 覆盖率 > 0，`ready` = 实际可用录音数
- [ ] `voiceMismatch` / `unlabelled` / `invalidUrl` 均为 0
- [ ] 任取 3 题，模考题干由录音播放且不中途换音色
- [ ] 题库 JSON 的 `source` 记录音频来源与授权状态

参考：`src/lib/content/bank-import.ts`、`src/lib/content/audio-policy.ts`、`docs/phase3-question-learning.md`。
