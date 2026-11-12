# 考试流程逆向

证据来源：REA 已处理的 `speaking-mock-df5b4187.js`（sha256 见 manifest）中 async 编排函数链，以及 `speaking-mock-session-15339205.js`。

## 1. 时间配置 [VERIFIED]
代码里硬编码的常量对象：`{verification:4, part1:30, preparation:60, part2:120, part3:60, minFinish:5}`，单位为秒。
- Part 1 每题作答上限 30s；Part 2 准备 60s、作答 120s；Part 3 每题 60s。
- 作答 5s 后才允许"提前结束本题"。
- 计时器：`setInterval` 每 250ms 用 `Date.now()` 差值重算剩余秒数（不累加 tick，避免漂移）。[VERIFIED]

## 2. 状态（phase）[VERIFIED]
`initializing → ready → intro → verification → question ⇄ recording → preparation → recording → … → finishing →（路由跳转 result）`

## 3. 主流程（静态还原）[VERIFIED]
```mermaid
flowchart TD
  A[页面加载: 请求麦克风权限 permissionStatus=requesting] --> B[从当季题库选择话题 planLoading]
  B -->|无法组成完整 P1/P2/P3| X[错误: 请换一组题目重试]
  B --> C[开始确认对话框 + 可选摄像头]
  C --> D[创建本地 session id=speaking-mock-时间戳, status=running, 存 sessionStorage]
  D --> E[intro: 播放 00_product_intro]
  E --> F[问候: 按当前小时选 morning/afternoon → 04 preferred name → 05 出示证件]
  F --> G[verification 4s → 06 identification complete]
  G --> H[Part1: 07 intro → 每题: 播放题目 → 录音 ≤30s → 反馈 OK/Right/Thank you]
  H --> I[Part2: 11 intro → 12 topic reveal → preparation 60s → 13 start speaking → 录音 ≤120s → 14 time up]
  I --> J[Part3: 16 intro → 每题录音 ≤60s]
  J --> K[17 test end → finishing: 等待后台提交任务 submissionTask]
  K --> L[status=completed, 埋点 completed{answer_count,duration_seconds} → 跳转 /ielts/speak-mock/result]
```

## 4. 题目来源 [VERIFIED]
- `planMessage: "正在从当季题库中选择话题…"`：题目来自**固定的季度题库**。
- 选择逻辑：在话题列表里**优先过滤 `practiced_count <= 0` 的话题**，然后 `Math.random()` 随机抽一个；全部练过时退回全量随机。
- Part 1 用一个话题；Part 2 和 Part 3 共用另一个话题（`part23Topic`）。Part 3 题目取自同一话题的 `mktTopicIssuesList`，**是预置题，不是根据回答生成**。
- 题目字段：`topic_issues_id`、`mkt_topic_issues_title`、`answer_ideas.question_audio_url`（题目音频）、`problem_prompt/problem_guide`（题卡提示）、`mkt_topic_issues_time`（建议时长）。

## 5. 特别问题
| 问题 | 结论 |
|---|---|
| 固定题库？ | [VERIFIED] 是 |
| 每次随机？ | [VERIFIED] 随机，并且优先未练习话题 |
| Part 3 动态生成？ | [VERIFIED] 模考代码中没有任何 LLM/对话接口调用；Part 3 题目来自题库，过渡语来自 `dynamic-templates.txt` 模板（例如 `Let's consider [subtopic].`） |
| 跳过 / 重录？ | [VERIFIED] 作答 ≥5s 可提前结束；模考流程中**没有重录分支**（检索不到"重录"字样，流程为单向 await 链）。[INFERRED] 单题练习页支持重录 |
| 重新开始？ | [INFERRED] 结果页链接回 `/ielts/speak-mock`，即重新开始一场新考试 |
| 刷新页面？ | [VERIFIED] 有 `beforeunload` 监听；会话序列化到 sessionStorage `ielts-speaking-mock-session-v1`，序列化时**排除 `blob`/`pcmChunks`/`submissionTask`**。[INFERRED] 刷新后录音音频会丢失，无法从中途恢复考试 |
| 断网？ | [VERIFIED] 转写和评测前会检查 `navigator.onLine`，离线时抛出 `offline` 错误。[UNKNOWN] 恢复策略 |
| 出分时间？ | [UNKNOWN] 需要运行时观察。[INFERRED] 评测在每题作答后后台进行（submissionTask），结束时只是等待剩余任务完成 |
