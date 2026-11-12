# 网络接口清单

> 所有条目都来自 REA 静态解析的字符串常量和调用位置，**不是运行时抓包**。请求和响应的具体结构只能在调用代码可见时推断；Token、AppKey 等值没有获取，也不应记录。

| 请求名称 | Method | Endpoint | 触发行为 | Request Shape | Response Shape | 时序 | 作用 | 证据 |
|---|---|---|---|---|---|---|---|---|
| ASR 临时凭证 | [UNKNOWN] | `/api/study/kouyu-zhenti/v1/evaluation/volcengine-sts-token` | 开始录音前 `transcriptionCredentials()` | [UNKNOWN] | [INFERRED] `{appId, token}`（代码读取 `G.appId`、`G.token`） | 每次录音前（可能有缓存，见 `tokenExpireTime`） | 签发火山 ASR 短期 JWT | [VERIFIED] 常量 + 调用（speak-evaluation chunk） |
| 实时 ASR | WebSocket | `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async` | 录音期间 | 二进制帧：fullClientRequest(JSON 配置) + audioOnlyRequest(PCM) | fullServerResponse(JSON 文本结果)/serverErrorResponse | 录音中实时 | 流式转写 | [VERIFIED] |
| 评测授权 | [UNKNOWN] | `/api/study/kouyu-zhenti/v1/evaluation/authorize` | `evaluationCredentials()`，12s 超时 | [UNKNOWN] | [INFERRED] `{warrantId, warrantExpireTime, applicationId, userId}` | 评测前 | 发音 SDK 授权 | [VERIFIED] |
| 发音 SDK | [UNKNOWN]（SDK 内部） | SDK 动态加载 | `loadSdk()` | PCM 4096 分片 | `{result:{overall/pron, …phones}}` | 每题录音后 | 发音、流利度评分 | [VERIFIED] |
| 考官固定音频 | GET | `https://lbxl-audio.oss-cn-beijing.aliyuncs.com/kouyumokao/*.mp3` | 各阶段播放 | — | audio/mpeg | 全程 | 预录 TTS | [VERIFIED] |
| 题库/话题列表 | [UNKNOWN] | [UNKNOWN]（在入口 bundle 的 API 封装中，未定位到具体函数） | 进入页面 | — | [VERIFIED] 字段：`list[].oral_materials_id, mkt_oral_materials_title, part_type, practiced_count, detail_text{mktTopicIssuesList,tIssuesPart2}, topic_issues[]` | 页面初始化 | 抽题 | [VERIFIED] 字段名（session chunk） |
| 用户配置 | [UNKNOWN] | [UNKNOWN] | `ensureConfigLoaded()`；开关时 `Ct({[key]:0|1})` | `{speaking_mock_show_subtitles:0|1}` 等 | — | 初始化/切换开关 | 用户偏好 | [VERIFIED] 调用 |
| 埋点 | [UNKNOWN] | [UNKNOWN] | `start`/`completed`/`cameraEnabled` | `{session_id, camera_enabled, answer_count, duration_seconds}` | — | 开始/结束 | 统计分析 | [VERIFIED] |
| 文本纠错 (correction) | [UNKNOWN] | [UNKNOWN] | 每题评测后 | [INFERRED] 转写文本 | [VERIFIED] 渲染字段：原句/改句 diff（`correction-diff__row`），以及 `lexical_resource`、`grammatical_range_accuracy` 分数 | 作答后 | LR/GRA | [VERIFIED] 渲染代码；端点 [UNKNOWN] |
| 文章发音评测提交 | [UNKNOWN] | `/api/study/article/v1/pronunciation/evaluation/submit` | 其他模块 | — | — | — | 其他模块（非口语模考） | [VERIFIED] 常量 |
| 学习统计 | [UNKNOWN] | `/api/study/review/v1/learning-stats/user-statistics` | Dashboard | — | — | — | 用户统计 | [VERIFIED] 常量 |
| 后台重新生成答题思路 | — | `/api/admin/tongzhuo-kouyu-editor/clear-and-regenerate-topic-issue-ideas` | 管理端 | — | — | — | [INFERRED] 题目答题思路由后台（可能是 LLM）批量生成 | [VERIFIED] 常量；**没有访问** |

## 调用链（静态）
用户点击开始 → `E.confirm` 对话框 → 创建本地 session（sessionStorage）→ 埋点 start → 播放 OSS MP3 → 题目阶段 `ge({issue,duration})` → getUserMedia + MediaRecorder + ScriptProcessor → `transcriptionCredentials()` → WebSocket ASR → 停止 → `evaluationCredentials()` → `loadSdk()` → `EngineEvaluat.start` 喂 PCM → `engineBackResultDone` 取 overall → correction（端点未知）→ 结果写入 session → `17_test_end` → 等待 submissionTask → 跳转结果页。

## 没有发现的接口
- [VERIFIED（代码层面没有）] 模考 chunk 中没有 LLM/Chat/SSE 接口，也没有考试 Session 创建接口：session id 由前端用 `speaking-mock-${Date.now()}` 生成。
