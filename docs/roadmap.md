# 任务状态与后续计划

## 阶段状态
| Phase | 状态 | 产出 |
|---|---|---|
| 0 环境检查 | ✅ | 未预装 REA；通过 `npx rea-agents@latest`（v6.8.0）运行，没有改动 Agent 配置；沙箱里没有 Chrome、麦克风和 API Key |
| 1 逆向 | ✅（静态）/ ⛔（运行时） | REA 静态 JS 应用分析 + 8 篇报告；运行时 CDP 观察受阻（见下） |
| 2 设计 | ✅ | docs/architecture.md、docs/api.md |
| 3 前端 | ✅ | Dashboard、四科页面、考试页、报告、历史、设置、题库 |
| 4 后端/AI | ✅ | 状态机、题库、音频、ASR/LLM/TTS/发音适配器、评分、报告 |
| 5 测试 | ✅（服务端）/ ⚠️（浏览器实机） | 18 项单元测试 + 22 项集成测试，全部通过 |
| 6 交付 | ✅ | README、.env.example、文档 |

## 阻塞项与下一步具体操作
1. **REA 运行时观察**：需要在本机用独立 Profile 启动 Chrome 并手动完成一次模考。命令和操作步骤见 `docs/reverse-engineering/evidence-and-unknowns.md §4`。
2. **真实 AI 服务**：配置 `OPENAI_API_KEY`（服务端 ASR 加 LLM 评分和追问）和 `AZURE_SPEECH_KEY/REGION`（发音），然后重新跑一次完整模考，对比 heuristic 与 llm 两条评分记录（assessments 表会同时保留）。
3. **浏览器实机测试**：Chrome 和 Safari（macOS/iOS）各完成一次完整模考。

## 后续三科计划（复用现有基础设施）
共享：`exam_sessions.module`、`exam_questions`（kind 可扩展为 mcq/gap/essay）、`assessments`/`assessment_dimensions`（维度换成 TR/CC/LR/GRA 等）、`findings`、History 和 Dashboard 聚合。
- **Listening**：音频素材表、单次播放控制、答案键自动判分（不需要 AI）、转写对照。
- **Reading**：文章与题组表、分屏阅读器、高亮、判分加证据句定位。
- **Writing**：编辑器（计时、字数）、复用 LLMProvider 和 validate/evidence 机制做四项评分（Task Response / Coherence & Cohesion / Lexical Resource / Grammatical Range & Accuracy）。
