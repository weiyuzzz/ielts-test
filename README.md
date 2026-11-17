# Band Nine — IELTS Speaking 智能模考平台

基于 **Next.js 16 (App Router) + PostgreSQL (Drizzle ORM) + Tailwind 4** 的雅思口语全真模拟考试系统：从当季题库生成考试、3D 数字考官语音提问、录音与自动转写、四维度 AI 评分、中文诊断报告，并内置完整的**考试环境诊断中心**与**本地 Kokoro TTS 引擎**。

| 模块 | 说明 |
|---|---|
| Speaking 模考 | Part 1/2/3 全流程（11–15 分钟）、Part 专项练习、**自选练习不限时**、防作弊模式（全真模考单次作答） |
| 数字考官 | 3D 数字人（Three.js + GLB + 15 Viseme 词级口型）与轻量 2D 考官，按会话冻结切换 |
| 考官语音 | 本地 Kokoro 引擎（GPU 优先、词级时间戳）/ Azure Neural TTS / 浏览器语音，逐句预合成 |
| 评分与报告 | 四项 IELTS 标准 AI 评分 + 声学证据，**中文诊断报告**，缺证据绝不伪造分数 |
| 环境诊断中心 | `/settings` 一键体检：数据库 / 题库 / 存储 / TTS 实合成 / LLM / ASR / 发音 / GPU 全链路真实检测 |
| 题库后台 `/admin` | 导入季度题库、切换启用季度、音频覆盖率统计、AI 服务热配置 |
| 学习资料 | `/speaking/questions` 示范答案与思路拆解、`/speaking/practice` 跟读训练 |
| **一键启动** | Windows `start.bat` 一次拉起 Kokoro + PostgreSQL + Next.js 三个服务 |
| Listening / Reading / Writing | 🚧 规划中 |

---

## 一、本地快速开始（推荐：一键启动）

适用于已在本机部署 Kokoro-FastAPI 的 Windows 开发环境。前置条件：Node.js 18+、Kokoro 引擎位于 `D:\tts\Kokoro-FastAPI`（含 `.venv` 与模型，见 [`docs/tts-engine-deployment.md`](./docs/tts-engine-deployment.md)）、已执行过一次 `npm install`。

### 首次初始化（仅一次）

```bash
cp .env.example .env
```

把 `.env` 中的 `DATABASE_URL` 库名改为 `ielts_platform`（一键启动脚本创建的库名）：

```ini
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/ielts_platform
```

本地 Kokoro 所需的最小配置（若 `.env.example` 中是注释状态，请取消注释）：

```ini
TTS_PROVIDER=openai
EXAMINER_PROFILE=kokoro-af-heart
TTS_BASE_URL=http://localhost:8880/v1
TTS_MODEL=kokoro
TTS_VOICE=af_heart
TTS_STREAM=0                  # 禁用流式：引擎分块流式会丢长句前半段
TTS_TIMEOUT_MS=120000
ALLOW_LOCAL_AI_ENDPOINTS=1    # 放行出站护栏，自托管引擎必需
```

> 首次启动数据库时脚本会自动 `initdb` 并建库；表结构可用 `npx drizzle-kit push --config=drizzle.config.json` 同步（日常启动无需重复执行）。

### 日常启动

**双击项目根目录的 `start.bat`**。它会按 Kokoro → PostgreSQL → Next.js 的顺序拉起三个服务，每个都带端口幂等检测（已在运行就 `skip`），并等待就绪后自动打开 <http://localhost:3000>。

三个服务运行在最小化独立窗口中，标题分别为 `IELTS-Kokoro-TTS`、`IELTS-Postgres`、`IELTS-NextJS`；关闭这些窗口即停止对应服务，双击脚本所在的控制台窗口可直接关闭。首次加载 Kokoro 模型约需 15 秒。

| 脚本 | 作用 |
|---|---|
| `start.bat` | 一键编排三个服务（Windows，双击即用） |
| `scripts/start-kokoro.mjs` | 用已装好的 venv uvicorn 启动 Kokoro（`:8880`），跳过 pip 安装与模型下载 |
| `scripts/start-postgres.mjs` | 启动嵌入式 PostgreSQL（`:5432`，数据目录 `.pgdata/`） |

### 手动启动（非 Windows 或自定义环境）

```bash
# 终端 1：数据库
node scripts/start-postgres.mjs
# 首次还需同步表结构
npx drizzle-kit push --config=drizzle.config.json

# 终端 2：应用（开发模式）
npm run dev -- -p 3000
# 或生产模式
npm run build && npm run start -- -p 3000
```

Kokoro 需另行按 [`docs/tts-engine-deployment.md`](./docs/tts-engine-deployment.md) 部署启动；不启动引擎也能考试，此时考官语音降级为屏幕文字。

### 验证

```bash
curl --noproxy '*' http://127.0.0.1:3000/api/health        # {"ok":true}
curl -sS --noproxy '*' http://localhost:8880/health        # {"status":"healthy"}
```

打开 `/settings` 的诊断中心，全部就绪项（尤其 `Exam environment` 的 DB · bank · mic · examiner voice）应为绿。

---

## 二、口语测试框架

### 考试流程

完整模考严格遵循 IELTS Speaking 规范（Part 1 预算延长 1 分钟用于练习）：

| 部分 | 时长 | 内容 |
|---|---|---|
| Part 1 | 5–6 min | 3 个话题、10–11 道简短问答（每日话题 + 万年保留题） |
| Part 2 | 3–4 min | 1 分钟准备 + 2 分钟独白（cue card + You should say 要点） |
| Part 3 | 4–5 min | 围绕 Part 2 话题的抽象讨论，含 AI 动态追问 |

- 考试状态机在服务端权威推进（`src/lib/speaking/exam-machine.ts`）：答题提交、重复请求、跳过、结束全部原子化，刷新/重连不丢状态。
- 全真模考每题一次作答；练习模式允许回放后重录。
- **自选练习（题库页手选题目组卷）：不设每个 Part 与总时间限制**——回答改为绿色正计时秒表，不自动跳 Part、不自动结束，随时可手动完成；考官语音与评分不变。正式模拟（随机抽题）仍严格计时，两者互不影响。该模式由会话快照的 `untimed` 冻结标志控制。
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

## 三、评分逻辑

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

> **发音评估的前提**：P 维度必须有可用的音频评估服务。若使用腾讯云 SOE，账号需开通「智聆口语评测」产品且未欠费，否则报告会显示 `Pronunciation – not assessed`（服务错误会如实暴露，不会伪造 band）。也可在 `/admin` 切换到 Azure 发音评估（`AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION`）。

---

## 四、项目配置

### 环境变量（详见 `.env.example`）

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接串（必需；一键启动用 `ielts_platform` 库） |
| `AUDIO_STORAGE_DIR` | 答题录音目录（默认 `./storage/audio`，需可写持久卷） |
| `LEARNING_CONTENT_DIR` | 学习素材 sidecar 目录（默认在源码树内，生产必须外置持久卷） |
| `ADMIN_TOKEN` | 设置后 `/admin` 的写操作必须带 `x-admin-token` 头 |
| `LLM_PROVIDER` + Key | `openai` / `deepseek` / `anthropic` / `qwen` / `gemini`（未配置则考试完成但 unscored） |
| `ASR_PROVIDER` + Key | `openai`（Whisper 兼容）/ `tencent-asr` / `browser` |
| `PRONUNCIATION_PROVIDER` | `azure`（`AZURE_SPEECH_KEY/REGION`）或 `tencent-soe`（需开通该服务） |
| `TTS_*` | 考官语音（见第一节 Kokoro 最小配置；或 Azure） |
| `ALLOW_LOCAL_AI_ENDPOINTS=1` | 自托管引擎（本机 Kokoro）必需，放行出站 URL 护栏；护栏只读 `.env` 明文，`/admin` 配置覆盖不了 |
| `TTS_CONCURRENCY` / `TTS_START_GATE_MS` | 合成并发数 / 开考准备门禁（默认按引擎类型 1–2、120 秒） |
| `TTS_SERVICE_MANAGER` | `nssm`/`launchd`：声明后诊断中心提供受管引擎重启（固定命令白名单 + 审计日志） |

所有 Provider 也可在 `/admin`「AI 服务」面板热配置（写入 `storage/ai-config.json`，保存即生效，密钥不出服务器）。

### 考官语音引擎（本地 Kokoro，推荐）

生产推荐本机 [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)：GPU 优先、离线、免额度，且 `/dev/captioned_speech` 提供词级时间戳（口型同步的数据源）。完整部署/保活（Windows NSSM / macOS launchd）见 [`docs/tts-engine-deployment.md`](./docs/tts-engine-deployment.md)。本机一键启动脚本默认引擎路径为 `D:\tts\Kokoro-FastAPI`，换机器时请先按文档部署，再按需调整 `scripts/start-kokoro.mjs` 顶部的 `ENGINE_DIR`。

引擎健康状态由诊断中心实时探测；配置了受管服务时可直接从页面重启并验证恢复。

### 数据库迁移

- Drizzle 迁移链在 `drizzle/`（当前至 `0006_digital_human_toggle`），`npx drizzle-kit push` 直接同步，或逐个应用迁移文件。
- `tests/migration-check.mjs` 验证迁移链与 schema 完全一致（CI 强制）。

---

## 五、考试环境诊断中心

`/settings` 顶部卡片，开考前一键体检，**每项都是真实执行**：

- 数据库真实 `SELECT 1`、启用题库真实数量查询、音频存储写/读/清理探针；
- TTS 实际合成考官测试句并校验音频字节数与格式（不是 HTTP 200 就算通过）；
- LLM 小型 JSON 探测，失败归类（Key 无效 / 模型不可用 / 限流 / 超时 / 格式异常）；
- ASR / 发音 Provider 配置核验，可选真实音频往返探测（录音仅存页面内存）；
- GPU / WebGL / GLB / Three.js / 真实 3D 渲染 FPS 与 15 Viseme 完整性。

顶部四项就绪状态：**Exam environment / Scoring / Complete band / Digital human**，附考试模式建议；结果本地持久化，刷新不丢。其中 `Exam environment` 概括为 `DB · bank · mic · examiner voice`，四项全部就绪才显示绿标；付费探测运行前明确告知用量，麦克风类检测仅在用户主动点击后触发。

---

## 六、测试

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

## 七、文档索引

| 文档 | 内容 |
|---|---|
| [`docs/architecture.md`](./docs/architecture.md) | 系统架构 |
| [`docs/api.md`](./docs/api.md) / [`docs/roadmap.md`](./docs/roadmap.md) | API 说明 / 路线图 |
| [`docs/scoring-rubric.md`](./docs/scoring-rubric.md) / [`docs/scoring-criteria.md`](./docs/scoring-criteria.md) | 评分描述符与标准整理 |
| [`docs/tts-engine-deployment.md`](./docs/tts-engine-deployment.md) | Kokoro 引擎部署、GPU 优先、保活 |
| [`docs/phase2-examiner-voice.md`](./docs/phase2-examiner-voice.md) | 考官语音系统设计 |
| [`docs/phase3-question-learning.md`](./docs/phase3-question-learning.md) | 题库与学习资料 |
| [`docs/bank-audit.md`](./docs/bank-audit.md) | 题库对账 |
| [`docs/test-report.md`](./docs/test-report.md) / [`docs/ci.md`](./docs/ci.md) | 测试报告 / CI 说明 |
| [`docs/reverse-engineering/`](./docs/reverse-engineering/) | 数字人/音频/考试流逆向笔记 |

---

> Band 为 AI 生成的练习反馈，非官方 IELTS 成绩。
