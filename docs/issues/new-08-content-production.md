# [Content] 学习素材生产缺口：502 题无示范答案、0 条人工审核、0 条跟读音频

<!-- labels: content, help wanted -->

已关闭的 #5 解决了「素材体系 + shadowing」。这条只跟踪内容生产与审核。

## 现状

```
learning.sampleAnswerCoverage: { total: 508, withSampleAnswer: 6, withFollowAudio: 0, reviewed: 0, sampleAnswerPercent: 1.2 }
```

## 为什么不能 AI 批量生成后直接上线

- 现有 6 条标 `ai-draft` + `draft`，页面显示「未审核草稿」；批量生成会把这个状态放大 80 倍。
- 产品承诺「不宣称官方 Band 8/9 范文」，没有审核环节的批量生成直接违背它。
- `targetBandHint` 目前全为 `null`，不应由生成器随手填。

## 待办

1. 定审核流程：谁审、标准（准确性 / 是否像口语 / 是否鼓励背模板）、审核后改 `reviewStatus=reviewed`。
2. 分批生产：Part 1 高频主题 → Part 2 题卡 → Part 3，每批 20–30 题，review 后再进下一批。
3. 跟读录音随审校后的范文录制，填 `followAudio.url` + `voiceProfile`（HTTPS）。
4. 来源合规：`source.label` 写真实来源；`third-party` 需可出示授权。

## 验收

- [ ] 每批素材都有 `reviewStatus`，`/admin` 的「已人工审核」数量可见增长
- [ ] 未审核内容始终标为草稿，不出现「官方范文」措辞
- [ ] 跟读音频数量与已审校范文匹配，或明确记录缺口
- [ ] 同季度重复导入后 `entries` 不翻倍（幂等）

参考：`src/lib/content/types.ts`、`src/lib/content/validate.ts`、`docs/phase3-question-learning.md`。
