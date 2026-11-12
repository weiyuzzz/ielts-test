# 逆向技术总结

## 目标系统（代码层面已验证）
```
Vue3 SPA (Vite)
 ├─ 编排：前端 async 脚本链 + 固定时间配置（无服务端考试 Session）
 ├─ 状态：sessionStorage "ielts-speaking-mock-session-v1"（不含音频）
 ├─ 考官：预录 TTS MP3（火山 seed-tts-2.0）放在阿里云 OSS + 题库题目音频
 ├─ 录音：MediaRecorder(webm/ogg/mp4 协商) ∥ AudioContext 16k ScriptProcessor PCM
 ├─ ASR：浏览器 WebSocket 直连火山 bigmodel 流式识别（服务端签发 STS JWT）
 ├─ 发音：EngineEvaluat SDK en.pred.score（服务端签发 warrantId），音素级结果
 ├─ 语言：correction 服务 → LR / GRA + 句子 diff
 └─ 结果：维度 FC/Pron ← evaluation，LR/GRA ← correction；总分缺失时回退为 6.5
```

## 功能对照表：目标产品 vs 我们的系统
| 能力 | 爱听写（证据等级） | 本项目 |
|---|---|---|
| 完整模考 P1→P2→P3 | 有 [VERIFIED] | 有：服务端权威状态机 |
| 专项练习 | `speak/:type` [INFERRED] | Part 1/2/3 专项，与模考共用同一引擎 |
| 时间配置 | 硬编码常量 [VERIFIED] | `src/lib/speaking/config.ts`，并作为快照存入会话 |
| 题库 | 季度题库，随机抽取并优先未练 [VERIFIED] | 原创题库（数据库），随机抽取并优先未练 |
| 考官语言 | 固定脚本 [VERIFIED] | 模板 + 可选 LLM（只用于 Part 3 追问和过渡语，次数受状态机限制） |
| 考官语音 | 预录 MP3 [VERIFIED] | TTSProvider：浏览器 speechSynthesis / OpenAI 兼容 TTS |
| 重复题目 | 未发现 [UNKNOWN] | 支持，次数可配置 |
| 录音 | 双通道 [VERIFIED] | 双通道（MediaRecorder 协商 + 16k WAV），支持设备选择 |
| ASR | 火山实时流 [VERIFIED] | ASRProvider：OpenAI 兼容 Whisper（服务端，带时间戳）/ 浏览器 Web Speech（客户端，标注来源） |
| 发音评测 | 专业 SDK [VERIFIED] | PronunciationProvider：Azure Pronunciation Assessment；未配置时**明确标注未评估** |
| 语言评分 | correction 服务 | LLMProvider（JSON Schema 校验）+ 确定性指标引擎；没有 LLM 时使用标注为 heuristic 的规则评分 |
| 刷新恢复 | 音频丢失 [INFERRED] | 音频入库，按服务端 currentStep 恢复 |
| 重复提交 | [UNKNOWN] | idempotency key + 唯一约束 |
| 报告 | 维度分 + diff + 音素 | 四项分数 + 理由 + 句子级证据 + 改写 + 亮点 + 建议 + 模型/提示词/Provider 版本 |
