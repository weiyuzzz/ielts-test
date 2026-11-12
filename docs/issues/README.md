# Issue 草稿与同步

这里存放 GitHub issue 的正文草稿，内容与仓库代码一一对应，改动随 PR 一起审阅。
`scripts/sync-issues.sh` 会把它们创建到 `weiyuzzz/ielts-test`，并把
`issue-1-comment.md` 作为状态更新发到 Phase 1 的跟踪 issue #1。

## 现有 issue（GitHub 上已有）

| # | 标题 | 状态 | 本次处理 |
|---|---|---|---|
| 1 | [Speaking][Phase 1] 音频性能改造：已修复问题、待验证项与并行开发冲突 | open | 并行冲突已解决、已合入 `main`（`80d58a2`）；用 `issue-1-comment.md` 回帖更新验收结果。浏览器手工验收仍未做，故不关闭。 |

## 新增 issue（草稿，尚未创建）

| 文件 | 标题 | 标签 | 为什么现在提 |
|---|---|---|---|
| `new-01-bank-media.md` | 题库素材未导入：范文 / 思路 / 关键词 / 跟读音频，shadowing 缺失 | content, enhancement | 题库只有「考什么」，没有「怎么答」；这是产品完整度的最大缺口 |
| `new-02-band-descriptors.md` | 0–9 分档描述符缺失，AI 评分只有关键指标 | scoring, help wanted | 文档里分档是图片，接口取不到文字，当时没有编造；需要人工录入才能让评分稳定 |
| `new-03-provider-verification.md` | Azure / OpenAI 未实机验证，默认音色未定 | voice, help wanted | 只有 Kokoro 有密钥；自然度结论必须靠听，不能靠测 |
| `new-04-preset-audio-path.md` | 预置考官音频通路未启用（题库无 audio 字段） | voice, bug | 校验逻辑写好了，但数据永远为空，功能实际不存在 |
| `new-05-ci.md` | 缺少 CI，PR 冲突只能人工判断 | infra, enhancement | 三个人并行改同一批文件，这轮靠手工合并三次才没出事 |

## 用法

```bash
brew install gh && gh auth login
./scripts/sync-issues.sh                 # 回帖 #1 + 创建缺失的 issue
./scripts/sync-issues.sh --no-comment    # 只创建 issue
```

脚本是幂等的：标题已存在的会跳过，标签不存在会先创建。
