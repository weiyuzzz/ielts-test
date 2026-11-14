# Band Nine — IELTS Speaking 智能模考平台

基于 **Next.js 16 (App Router) + PostgreSQL (Drizzle ORM) + Tailwind 4** 的雅思口语全真模拟考试系统：从当季题库生成考试、3D 数字考官语音提问、录音与自动转写、四维度 AI 评分、中文诊断报告，并内置完整的**考试环境诊断中心**与**自托管 TTS 引擎部署方案**。

| 模块 | 说明 |
|---|---|
| Speaking 模考 | Part 1/2/3 全流程（11–15 分钟）、Part 专项练习、防作弊模式（全真模考单次作答） |
| 数字考官 | 3D 数字人（Three.js + GLB + 15 Viseme 词级口型）与轻量 2D 考官，按会话冻结切换 |
| 考官语音 | 本地 Kokoro 引擎（GPU 优先、词级时间戳）/ Azure Neural TTS / 浏览器语音，逐句预合成 |
| 评分与报告 | 四项 IELTS 标准 AI 评分 + 声学证据，**中文诊断报告**，缺证据绝不伪造分数 |
| 环境诊断中心 | `/settings` 一键体检：数据库 / 题库 / 存储 / TTS 实合成 / LLM / ASR / 发音 / GPU 全链路真实检测 |
| 题库后台 `/admin` | 导入季度题库、切换启用季度、音频覆盖率统计 |
| 学习资料 | `/speaking/questions` 示范答案与思路拆解、`/speaking/practice` 跟读训练 |
| Listening / Reading / Writing | 🚧 规划中 |

---

## 一、口语测试框架

### 考试流程

完整模考严格遵循 IELTS Speaking 规范（Part 1 预算延长 1 分钟用于练习）：

| 部分 | 时长 | 内容 |
|---|---|---|
| Part 1 | 5–6 min | 3 个话题、10–11 道简短问答（每日话题 + 万年保留题） |
| Part 2 | 3–4 min | 1 分钟准备 + 2 分钟独白（cue card + You should say 要点） |
| Part 3 | 4–5 min | 围绕 Part 2 话题的抽象讨论，含 AI 动态追问 |

- 考试状态机在服务端权威推进（`src/lib/speaking/exam-machine.ts`）：答题提交、重复请求、跳过、结束全部原子化，刷新/重连不丢状态。
- 每部分有硬性时间预算，考官到时收尾并进入下一部分；Part 1 支持在最少作答秒数后提前进入下一题。
- 全真模考每题一次作答；练习模式允许回放后重录。
- **Gate 分支抽题**：万年保留题里混有「学生版/上班族版」问题的 topic（如 Work or studies），考官必先问 gate 题（"Do you work, or are you a student?"），再按回答内容把后续待答题实时替换为对应分支的题库题；居住类 topic（hometown / home / area / city）同样先问「住在哪里」再展开。转写不可用或语义不明时保持中立题兜底。

### 题库

- 内置大陆当季题库（Part 1 213 题 / 33 主题、Part 2 58 卡、Part 3 280 题），首次打开 `/admin` 自动导入；`/admin` 可导入新季度 JSON 并切换启用。
- 考试严格从**启用题库**抽题，不跨季混题；题库对账见 [`docs/bank-audit.md`](./docs/bank-audit.md)。

### 数字考官与语音

- **3D 考官**：Three.js + GLB 数字人，Oculus 15 Viseme 形态键；Kokoro `captioned_speech` 词级时间戳驱动词级精确口型。渲染单 RAF 循环、离屏自动停帧、WebGL 上下文丢失自动降级 2D、卸载完整释放 GPU 资源。
- **2D 考官**：中年考官风格的轻量 SVG（零 GPU、零下载），音频包络驱动口型；3D 加载失败自动回退，互不影响考试状态机。
- **开关与冻结**：`/settings` 的 Examiner 卡可切换 3D/2D（立即持久化）；创建考试时该偏好与考官声音、形象一起**冻结进会话快照**，考试中途修改设置不影响进行中的考试。
- **语音链路**：四级优先合成调度（当前句 / 下一题 / 后续 / 备用话术），合成并发按引擎类型自适应（本地 CPU=1、GPU/远程=2，`TTS_CONCURRENCY` 可覆盖）；逐句流水线播放，失败有界重试 + 明确的用户选择（重试 / 检查服务 / 阅读继续），绝不静默降级为机械音。

### 录音与转写

- 一次 `getUserMedia` 贯穿整场考试（AudioWorklet / ScriptProcessor / MediaRecorder 三级采集策略），每题独立 PCM 缓冲 + 16 kHz mono WAV。
- ASR：OpenAI 兼容 Whisper / 腾讯云 ASR / 浏览器 Web Speech，由 Registry 统一选择；浏览器转写与录音同步进行。

---

## 二、评分逻辑

四项标准各占 25%，0–9 分档（0.5 步进），四项齐全才产生 Overall Band：

| 维度 | 证据来源 |
|---|---|
| FC 流利与连贯 | 转写文本 + 声学证据（停顿位置/时长、语速、平均语长、填充词、自我修正） |
| LR 词汇丰富度 | 仅实际语言表现 |
| GRA 语法多样性及准确性 | 仅实际语言表现 |
| P 发音 | **仅**音频评估 Provider（Azure / 腾讯 SOE）的原始音频证据 |

核心原则（详见 [`docs/scoring-rubric.md`](./docs/scoring-rubric.md) 与 [`docs/scoring-criteria.md`](./docs/scoring-criteria.md)）：

- **Provider 0–100 原始分只是证据，绝不换算成 Band**；LLM 对照公开评分描述符（`rubric-2.0-calibrated`，78 条 descriptor id）裁定档位并引用 2–4 条描述符 id。
- **不允许**由词数、语速、复杂句数量等任何数字直接推 Band；声学数据只作为流利度证据。
- 反伪造校验：findings 必须逐字引用考生原话、音频证据必须落在有词级时间戳的答案内、编造的 rubric id 一律丢弃。
- **缺 P 时不产生 Overall Band**（宁可缺失，不伪造）；LLM 未配置时考试照常完成、标记 unscored，只产出学习诊断指标（Heuristic 数据永远不进入 Band）。
- 报告面向用户的文本（rationale / strengths / weaknesses / limitations）**默认简体中文**，引语原文与 Band 数字保持英文。
- 每次评分的模型输出经括号配平的 JSON 提取 + 严格校验，模型尾随杂讯不影响解析；可重试，每次评分独立存档。

---

## 三、项目部署配置

### 快速开始

```bash
npm install
cp .env.example .env        # 至少设置 DATABASE_URL
npx drizzle-kit push        # 建表 / 同步表结构
npm run build && npm run next start -p 3100
```

### 环境变量（详见 `.env.example`）

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接串（必需） |
| `AUDIO_STORAGE_DIR` | 答题录音目录（默认 `./storage/audio`，需可写持久卷） |
| `LEARNING_CONTENT_DIR` | 学习素材 sidecar 目录（默认在源码树内，生产必须外置持久卷） |
| `ADMIN_TOKEN` | 设置后 `/admin` 的写操作必须带 `x-admin-token` 头 |
| `LLM_PROVIDER` + Key | `openai` / `deepseek` / `anthropic` / `qwen` / `gemini`（未配置则考试完成但 unscored） |
| `ASR_PROVIDER` + Key | `openai`（Whisper 兼容）/ `tencent-asr` / `browser` |
| `PRONUNCIATION_PROVIDER` | `azure`（`AZURE_SPEECH_KEY/REGION`）或 `tencent-soe` |
| `TTS_*` | 考官语音（见下节 Kokoro 最小配置；或 Azure） |
| `ALLOW_LOCAL_AI_ENDPOINTS=1` | 自托管引擎（本机 Kokoro）必需，放行出站 URL 护栏 |
| `TTS_CONCURRENCY` / `TTS_START_GATE_MS` | 合成并发数 / 开考准备门禁（默认按引擎类型 1–2、120 秒） |
| `TTS_SERVICE_MANAGER` | `nssm`/`launchd`：声明后诊断中心提供受管引擎重启（固定命令白名单 + 审计日志） |

所有 Provider 也可在 `/admin`「AI 服务」面板热配置（写入 `storage/ai-config.json`，保存即生效，密钥不出服务器）。

### 考官语音引擎（本地 Kokoro，推荐）

生产推荐本机 [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)：GPU 优先、离线、免额度，且 `/dev/captioned_speech` 提供词级时间戳（口型同步的数据源）。完整部署/保活（Windows NSSM / macOS launchd）见 [`docs/tts-engine-deployment.md`](./docs/tts-engine-deployment.md)。应用侧最小配置：

```ini
TTS_PROVIDER=openai
TTS_BASE_URL=http://localhost:8880/v1
TTS_MODEL=kokoro
TTS_VOICE=af_heart            # 男声 bm_george
TTS_STREAM=0                  # 禁用流式（引擎分块流式对长句丢前半段）
ALLOW_LOCAL_AI_ENDPOINTS=1
```

引擎健康状态由诊断中心实时探测；配置了受管服务时可直接从页面重启并验证恢复。

### 数据库迁移

- Drizzle 迁移链在 `drizzle/`（当前至 `0006_digital_human_toggle`），`npx drizzle-kit push` 直接同步，或逐个应用迁移文件。
- `tests/migration-check.mjs` 验证迁移链与 schema 完全一致（CI 强制）。

---

## 四、考试环境诊断中心

`/settings` 顶部卡片，开考前一键体检，**每项都是真实执行**：

- 数据库真实 `SELECT 1`、启用题库真实数量查询、音频存储写/读/清理探针；
- TTS 实际合成考官测试句并校验音频字节数与格式（不是 HTTP 200 就算通过）；
- LLM 小型 JSON 探测，失败归类（Key 无效 / 模型不可用 / 限流 / 超时 / 格式异常）；
- ASR / 发音 Provider 配置核验，可选真实音频往返探测（录音仅存页面内存）；
- GPU / WebGL / GLB / Three.js / 真实 3D 渲染 FPS 与 15 Viseme 完整性。

顶部四项就绪状态：**Exam environment / Scoring / Complete band / Digital human**，附考试模式建议；结果本地持久化，刷新不丢。付费探测运行前明确告知用量；麦克风类检测仅在用户主动点击后触发。

---

## 五、测试

```bash
npm run typecheck
npm run lint
npm run build
npx tsx --test tests/unit.test.ts tests/audio-perf.test.ts tests/scoring-rubric.test.ts \
  tests/diagnostics.test.ts tests/tts-fluency.test.ts tests/part-timing.test.ts \
  tests/lipsync.test.ts tests/learning-store.test.ts tests/bank-learning.test.ts \
  tests/bank-data.test.ts tests/tencent-asr.test.ts tests/tencent-soe.test.ts
# 端到端（需要 PostgreSQL + 生产服务）
node tests/integration.mjs http://localhost:3000
node tests/migration-check.mjs
```

CI（`.github/workflows/ci.yml`）：静态检查 + 全部离线测试 + 生产构建；另有 PostgreSQL 16 全栈集成作业。

---

## 六、文档索引

| 文档 | 内容 |
|---|---|
| [`docs/architecture.md`](./docs/architecture.md) | 系统架构 |
| [`docs/scoring-rubric.md`](./docs/scoring-rubric.md) / [`docs/scoring-criteria.md`](./docs/scoring-criteria.md) | 评分描述符与标准整理 |
| [`docs/tts-engine-deployment.md`](./docs/tts-engine-deployment.md) | Kokoro 引擎部署、GPU 优先、保活 |
| [`docs/phase2-examiner-voice.md`](./docs/phase2-examiner-voice.md) | 考官语音系统设计 |
| [`docs/phase3-question-learning.md`](./docs/phase3-question-learning.md) | 题库与学习资料 |
| [`docs/bank-audit.md`](./docs/bank-audit.md) | 题库对账 |
| [`docs/ci.md`](./docs/ci.md) | CI 说明 |
| [`docs/reverse-engineering/`](./docs/reverse-engineering/) | 数字人/音频/考试流逆向笔记 |

---

> Band 为 AI 生成的练习反馈，非官方 IELTS 成绩。
