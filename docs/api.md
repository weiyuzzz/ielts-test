# API 文档

身份：httpOnly cookie `ielts_uid`（由 `src/proxy.ts` 签发）。所有错误统一返回 `{ error, code? }`。

| Method | Path | Body | 返回 | 说明 |
|---|---|---|---|---|
| GET | /api/health | – | `{ok}` | 健康检查 |
| GET | /api/config | – | `{asr, llm, tts, pronunciation}` | 当前 Provider（不含密钥）；`tts` 含 `model/voice/format/streaming` |
| POST | /api/speaking/sessions | `{mode: full\|part1\|part2\|part3}` | 201 `{id}` | 抽题并创建考试计划 |
| GET | /api/speaking/sessions | – | `{sessions[]}` | 历史列表 |
| GET | /api/speaking/sessions/:id | – | `{session, steps[], assessment}` | 状态、步骤、当前答案和转写（用于恢复） |
| POST | /api/speaking/sessions/:id/answers | multipart: `examQuestionId, idempotencyKey, durationMs, audio?, wav?, browserTranscript?` | 201 `{answerId,status,asrDurationMs}` / 200 `{duplicate:true}` | 409 表示非当前步骤或已作答；413 表示文件过大；415 表示非音频 |
| POST | /api/speaking/sessions/:id/advance | `{fromStep}` | `{currentStep, partChanged?, followUp?{text,generator}, finished?, duplicate?}` | 由状态机决定下一步 |
| POST | /api/speaking/sessions/:id/complete-answer | multipart: 同 `/answers` + `fromStep` | 201 `{answer,advance,timings,view}` / 200 `answer.duplicate:true` | **统一提交**：一次请求完成「保存答案 → 状态机推进 → 返回完整 session view」，客户端无需再 GET。保留幂等键、Session 所有权、并发安全与音频/答题记录；full 模考不做同步 ASR，practice Part 3 保留追问所需的同步转写。`view` 与 GET /api/speaking/sessions/:id 同构 |
| POST | /api/speaking/sessions/:id/repeat | `{examQuestionId}` | `{remaining}` | 429 表示已达重复上限 |
| POST | /api/speaking/sessions/:id/skip-part | `{fromStep}` | `{currentStep, finished, skipped, partChanged, view}` | 某一段超时：把该段未答的题标 `skipped`（永远不计入评分），游标跳到下一段首题并返回完整 view；已是最后一段则 `finished: true`、游标停在末题，调用方播完收尾语后照常 `finish`。`fromStep` 过期时返回 `duplicate: true`，不会连跳两段 |
| POST | /api/speaking/sessions/:id/finish | – | `{status, assessmentId, duplicate}` | 结束考试并异步启动评分 |
| POST | /api/speaking/sessions/:id/abandon | – | `{status}` | 中途退出 |
| GET | /api/speaking/sessions/:id/report | – | `{assessment, dimensions[], findings[], report}` | 404 表示尚无评分 |
| POST | /api/speaking/sessions/:id/report | – | `{assessmentId, duplicate}` | 重新评分（保留旧的评分记录） |
| GET | /api/audio/:id | Range 可选 | audio/* (200/206) | 只能访问自己的录音 |
| GET | /api/tts?text=&voice= | – | audio/* (progressive stream) | 实时播放最高优先级：**不等待** POST 预加载，并取消同文本的预加载任务；`X-TTS-Cache: miss-stream \| hit \| miss`；`X-TTS-Synthesis-Ms` + `Server-Timing` 供性能追踪 |
| POST | /api/tts | `{text, voice?}` | audio/* | 后台预加载（可取消，客户端断开即中止）；501 表示使用浏览器 TTS |
| PUT | /api/settings | `{displayName?, targetBand?, examDate?, examinerVoice?, showSubtitles?}` | `{ok,user}` | |
| GET | /api/admin/banks | `?id=` 可选 | `{banks[], protected}` / `{set, topics[], audio, examinerProfile, learning}` | 列出季度题库（含 `audio.{withAudio,total}`）；带 `id` 时返回题库内容、音频覆盖率、逐题音频/素材状态 |
| POST | /api/admin/banks | `{bank: {...}, activate?: boolean}` | 201 `{id, season, counts}` | 导入/覆盖同一 season 的题库；写操作在设置 ADMIN_TOKEN 后需 `x-admin-token` |
| PUT | /api/admin/banks | `{id}` | `{id, active}` | 切换启用题库，考试只从启用题库抽题 |

评分状态新增 `unscored`：未配置 AI 评分时流程照常完成但不产生分数（`overallBand: null`、`dimensions: []`）；AI 失败为 `failed`，均不回退启发式分数。接入 AI 后若四项未全部评估，`overallBand` 仍为 `null`。

`/api/tts` 两个方法共享服务端内存 LRU 缓存（按引擎/音色/文本/格式/语速/韵律生成 key），同一句的并发请求只合成一次。文本上限 1500 字符，需携带 `ielts_uid` cookie。

## 学习与跟读（Phase 3）

| Method | Path | Body | 返回 | 说明 |
|---|---|---|---|---|
| GET | /api/learning/questions | `?topicKey=&part=` | `{season, region, questions[], asr:{available,id}}` | 某主题的题目 + 学习素材（示范答案/思路/关键词/跟读音频）+ `followAudio` 可播性。考试链路不调用 |
| POST | /api/learning/asr | multipart: `audio`(wav/webm), `hint?` | 200 `{status:"ok", text, provider}` / `{status:"unavailable", reason}` / `{status:"failed", error}`；400 `invalid_audio`；413 `audio_too_large` | Shadowing 转写。**不落库**：音频在内存中转写后丢弃，绝不写 `answer_records`/`audio_assets`。缺 ASR 时返回 200 + `unavailable`，页面仍可录音回放 |
