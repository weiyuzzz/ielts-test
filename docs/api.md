# API 文档

身份：httpOnly cookie `ielts_uid`（由 `src/proxy.ts` 签发）。所有错误统一返回 `{ error, code? }`。

| Method | Path | Body | 返回 | 说明 |
|---|---|---|---|---|
| GET | /api/health | – | `{ok}` | 健康检查 |
| GET | /api/config | – | `{asr, llm, tts, pronunciation}` | 当前 Provider（不含密钥）；`tts` 含 `model/voice/format/streaming` |
| POST | /api/speaking/sessions | `{mode: full\|part1\|part2\|part3}` | 201 `{id}` | 抽题并创建考试计划 |
| GET | /api/speaking/sessions | – | `{sessions[]}` | 历史列表 |
| GET | /api/speaking/sessions/:id | – | `{session, steps[], assessment}` | 状态、步骤、当前答案和转写（用于恢复） |
| POST | /api/speaking/sessions/:id/answers | multipart: `examQuestionId, idempotencyKey, durationMs, audio?, wav?, browserTranscript?` | 201 `{answerId,status}` / 200 `{duplicate:true}` | 409 表示非当前步骤或已作答；413 表示文件过大；415 表示非音频 |
| POST | /api/speaking/sessions/:id/advance | `{fromStep}` | `{currentStep, partChanged?, followUp?{text,generator}, finished?, duplicate?}` | 由状态机决定下一步 |
| POST | /api/speaking/sessions/:id/repeat | `{examQuestionId}` | `{remaining}` | 429 表示已达重复上限 |
| POST | /api/speaking/sessions/:id/finish | – | `{status, assessmentId, duplicate}` | 结束考试并异步启动评分 |
| POST | /api/speaking/sessions/:id/abandon | – | `{status}` | 中途退出 |
| GET | /api/speaking/sessions/:id/report | – | `{assessment, dimensions[], findings[], report}` | 404 表示尚无评分 |
| POST | /api/speaking/sessions/:id/report | – | `{assessmentId, duplicate}` | 重新评分（保留旧的评分记录） |
| GET | /api/audio/:id | Range 可选 | audio/* (200/206) | 只能访问自己的录音 |
| GET | /api/tts?text=&voice= | – | audio/* (progressive stream) | 逐句流式返回；`X-TTS-Cache: miss-stream \| hit` 标识是否命中服务端缓存 |
| POST | /api/tts | `{text, voice?}` | audio/* | 完整缓冲（兼容旧调用）；501 表示使用浏览器 TTS |
| PUT | /api/settings | `{displayName?, targetBand?, examDate?, examinerVoice?, showSubtitles?}` | `{ok,user}` | |

`/api/tts` 两个方法共享服务端内存 LRU 缓存（按引擎/音色/文本/格式/语速/韵律生成 key），同一句的并发请求只合成一次。文本上限 1500 字符，需携带 `ielts_uid` cookie。
