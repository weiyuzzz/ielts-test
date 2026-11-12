# Band Nine — IELTS 四科备考平台（第一阶段：Speaking）

Next.js 16 (App Router) + PostgreSQL (Drizzle ORM) + Tailwind 4。默认运行在 **3100 端口**。

| 模块 | 状态 |
|---|---|
| Speaking | ✅ 完整模考 + Part 1/2/3 专项、当季题库、录音/转写、考官语音、报告 |
| 题库后台 `/admin` | ✅ 导入季度题库、切换启用季度、查看题库内容与音频覆盖率 |
| 学习资料 `/speaking/questions` | ✅ 示范答案 / 思路拆解 / 关键词组 / 跟读入口 |
| 跟读训练 `/speaking/practice` | ✅ Shadowing：听原音 → 录音 → 回放 → 转写对比 |
| Listening / Reading / Writing | 🚧 Coming Soon 页面 |

## 快速开始
```bash
npm install
cp .env.example .env             # 至少设置 DATABASE_URL
npx drizzle-kit push             # 建表 / 同步表结构
npm run build && npx next start -p 3100   # 生产；开发用 npm run dev -p 3100
```
首次调用考试或打开 `/admin` 时会自动导入内置的**大陆当季题库**并设为启用。录音保存在 `storage/audio/`（可用 `AUDIO_STORAGE_DIR` 修改）。

> 生产环境建议设置 `ADMIN_TOKEN`：设置后 `/api/admin/banks` 的导入与切换操作必须带 `x-admin-token` 请求头，后台页面会提供输入框（保存在浏览器 localStorage）。

## 学习素材与跟读（Phase 3）

题库只负责「考什么」，学习素材负责「怎么练」，两者物理隔离：

- 学习素材存在 `src/data/learning/<season>.json`，按 `season + topicKey + part + 归一化题干` 关联题目；考试链路从不读这个文件，所以模考里不会出现范文。
- 两类音频严格分开：`questions.questionAudioUrl`（考官朗读题干，音色必须等于本场考试音色，否则回退 TTS）与 `learning.followAudio`（跟读示范，永不进入考试）。
- `/speaking/questions`：Part 筛选 / 搜索 / 展开示范答案、思路、关键词，逐段播放与复制。
- `/speaking/practice`：听原音 → 录音 → 回放 → ASR 转写 → 词级差异对比。无 ASR 时仍可录音回放；录音只存在页面内，不写入考试成绩。
- 内容诚信：AI 起草的素材强制 `reviewStatus = draft`，UI 标注「未审核草稿」；当前 508 题中仅 6 题有素材、0 题有授权录音，报告见 `docs/phase3-question-learning.md`。

### 生产环境的 Sidecar 存储（必读）

学习素材是**文件**，不是数据库行，所以部署时必须给它一个**可写且持久**的目录：

```bash
LEARNING_CONTENT_DIR=/var/lib/bandnine/learning
```

- 不设置时使用默认路径 `./src/data/learning` —— 这是**源码目录**。在只读镜像、Serverless 或容器里重启即失效的环境下，导入会失败或素材在重新部署后丢失。
- 写入是**原子替换**（先写同目录临时文件再 `rename`），进程内对同一 season 串行化，避免并发导入互相覆盖。
- **多实例部署不保证一致**：单进程锁无法跨进程/跨实例。若横向扩容，需要把该目录放到共享持久卷，或改用对象存储/数据库（后续工作）。
- `/admin` 导入返回的 `warnings` 会带上写入失败原因；运维可用 `probeContentDir()` 做一次写探针。
- 该目录只影响学习素材；考试题目、答题记录、评分结果始终在 PostgreSQL 中。

## 季度题库与后台

### 数据源
内置 `src/data/question-banks/2026-09-12-mainland.json`，来自腾讯文档《雅思口语 9-12 月题库【Part123】》，**只保留考区标记为「大陆地区」的题目**：

| 内容 | 数量 |
|---|---|
| Part 1 主题 / 题目 | 31 主题 / 170 题（含 5 个「万年保留题」主题：Work or studies、The area you live in、Hometown、Home & Accommodation、The city you live in） |
| Part 2 题卡（含 You should say 要点） | 58 张 |
| Part 3 问题 | **280 题，归属到 55 张题卡**（平均每张卡 5.1 题，最多 7 题） |

**Part 3 是 Part 2 的延续**：文档里每个题卡块（`题卡名[考区]` 之后）都跟着该话题专属的 Part 3 讨论题，每题都有中文翻译和跟读音轨编号。解析时按「题卡名 → 该卡的 Part 3 题集」建立归属，组卷时**只从所选题卡自己的 Part 3 题集中抽题**，绝不跨话题借题——真实考试不会在 Part 3 突然换话题。3 张题卡（不会用的科技产品、有创造力的朋友、拥有健康习惯和作息的人）在文档中没有配套 Part 3 素材，带 Part 3 的考试会自动避开它们。

每题带 `season`、`region`、`type`（`evergreen` 万年保留题 / `new` 当季新题 / `retained` 当季保留题）、中文对照、考试人数等元数据。文档中的高分范文、思路解读、语音跟读音频属于素材，未导入考试题库；请勿在模考中展示范文。该题库为第三方整理资料，商用前请确认授权。内置题库与数据库不一致时（例如题库被修正），服务启动会自动重新导入。

### 后台 `/admin`
- **题库列表**：季度、考区、各部分题目数、是否启用、**预置考官音频覆盖率**。
- **查看内容**：按 Part 筛选 / 搜索，逐主题展示题目与题卡要点，并逐题标注音频状态（`预置音频 / TTS / 音色不符 / 未标注音色 / URL 无效`）与学习素材状态。
- **导入**：粘贴 JSON 或选择文件，格式见下；同一 `season` 重复导入是幂等覆盖。
- **切换启用**：任意时刻只有一个题库为 active，**考试严格从该题库抽题，绝不混用或凭空生成题目**。

导入格式：
```json
{
  "season": "2027-01-04",
  "region": "大陆地区",
  "label": "2027 年 1–4 月（大陆）",
  "topics": [
    { "key": "paper", "name": "Paper", "nameZh": "纸张", "type": "new", "category": "part1",
      "part1": [{ "text": "Have you made any crafts with paper?", "textZh": "你做过纸手工吗？" }],
      "part2": [], "part3": [] }
  ]
}
```
`type` 取 `evergreen | new | retained`；`part2` 条目可带 `cuePoints`。题目可选 `questionAudioUrl`（预置考官音频），为空时用 TTS 合成。

## 考试流程（按 IELTS Speaking 规范）

| 部分 | 时长 | 规则 |
|---|---|---|
| 开场 | – | 按时段问候 → 考官姓名 → 证件核验 → 考试说明 |
| Part 1 | 4–5 分钟 | **3 个主题 / 10–11 题**：1 个万年保留题主题抽 3 题（身份、住处类）+ **2 个当季主题**（新题/保留题）各抽 4 题；主题下随机抽题，优先未练习过的话题；每题上限 20s，短而直接 |
| Part 2 | 3–4 分钟 | 1 分钟题卡准备（可记笔记）+ 2 分钟独白，到点由考官叫停 |
| Part 3 | 4–5 分钟 | 4 题，**全部来自该题卡自己话题的 Part 3 题集**；抽样后按题库原顺序排列，保持从具体到抽象的递进；每题上限 60s |
| 整场 | 11–14 分钟 | `totalBudgetSeconds = 840` |

`full` 模考严格走题库脚本，**不插入 LLM 追问**；追问（模板或 AI）仅保留在练习模式。所有题目带 `generator: "bank"`，session 的 `configSnapshot` 记录所用 `bankSeason` / `bankRegion`，便于追溯。

## 作答界面

倒计时和录音反馈都在屏幕中央的同一组控件里，不分散注意力：

- **环形倒计时**：圆环即计时器。**Part 2 准备阶段顺时针蓄满**（60 → 0 秒，环从空转满），**作答阶段逆时针耗尽**（环从满转空），方向本身就是阶段提示。剩余 10 秒转琥珀色、5 秒转红色并脉冲，时间一到自动提交并进入下一题。
- **真实音量反馈**：录音时下方 32 根条由 `AnalyserNode` 的实时音量包络驱动（快起慢落，像硬件录音表），不是装饰性动画。检测到说话时条变红、圆环外圈出现随音量扩散的红色光晕，状态文字从 `Listening` 变为 `Hearing you`；安静时回落变灰并提示 `Speak now`。
- **无障碍**：音量条带 `aria-label` 与 `role="img"`，颜色变化同时配合文字状态，不只靠颜色传达。

## 评分策略

评分依据来自文档的「考试评分标准」：9 个等级，**四项独立分数各占 25%**——流利度与连贯性（FC）、词汇资源（LR）、语法范围与准确性（GRA）、发音（P）。`src/lib/speaking/band-descriptors.ts` 是唯一配置源，列出每项的关键指标（FC 的语速/连续性/连贯性、LR 的恰当性/搭配/paraphrase、GRA 的 range 与 accuracy 拆分、P 的 chunking/节奏/语调/可懂度）以及各 Part 的期望，并注入 AI 评分 prompt。明确规定：**Part 1 短答案是正确策略，不得因长度扣分；发音不是口音，任何口音都不扣分**。

- **没有接入 AI 评分时不评分**：未配置 `LLM_PROVIDER` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 时，考试流程照常完成，评估状态为 `unscored`，不生成任何分数、不用启发式估算分数；报告页仍可逐题回放录音与查看转写。
- 接入 AI 后才会评分；AI 调用失败时状态为 `failed`，同样不回退到启发式分数。
- 四项缺任一项（通常是未配置音频发音评测）时 `overallBand = null`，报告显示「未出总分」，四个维度卡片仍分别展示已评估项。
- 详细反馈按四个 criterion 分组，每条标注对应的关键指标（category）。
- 评分 prompt 版本 `speaking-language-v2.0-criteria`，报告记录所用版本与 provider，便于重跑对比。

## 考官语音（TTS）

### 三档引擎，自动选择
| 引擎 | 启用方式 | 自然度 |
|---|---|---|
| 浏览器 `speechSynthesis` | 未配置语音服务（自动降级） | ★ 优先云端 Natural/Neural 英式音色、提前预热 |
| OpenAI 兼容 `/audio/speech` | `TTS_PROVIDER=openai` + `TTS_BASE_URL` / `TTS_API_KEY` | ★★★ 支持本地 Kokoro / OpenAI `gpt-4o-mini-tts` |
| Azure Neural TTS | `TTS_PROVIDER=azure` + `AZURE_SPEECH_KEY/REGION` | ★★★★★ 英式神经音色、48 kHz 无损 PCM |

默认（本机）为 Docker 里的 Kokoro：`TTS_VOICE=af_heart`（Kokoro 唯一 A 级音色；英式 `bf_emma` 评级仅 B-）、`TTS_SPEED=0.95`、`TTS_PROSODY=1`（SSML 句间停顿）、`TTS_STREAM=1`、`TTS_FORMAT=mp3`。密钥只存在于服务端。

### 延迟与可靠性（Phase 1 音频底座）
实测本地 Kokoro 短句 2–4s、长句 9–13s，所以合成必须离开考试关键路径：

- **一个调度器**（`src/lib/audio/tts-scheduler.ts`）管所有合成：`CURRENT`（正在播）> `NEXT`（下一题）> `BACKGROUND`（后续台词）> `LOW`（重复问法、无应答兜底）。同一 (引擎, 音色, 格式, act, profile, 文本) 只合成一次，高优先级请求可抢占低优先级任务。
- **显式播放状态机**（`audio-lifecycle.ts`）：`loading → ready → playing → ended | interrupted | failed`。被中断或被截断的流**不算播完**，考试不会在坏音频上继续推进；失败时保留字幕并要求考生确认。
- **单个录音会话**（`recording-session.ts`）：整场复用同一 MediaStream 与 AudioContext，换题只换 buffer，首题之后几乎无启动延迟。
- **首句门禁**：`ensureOpeningAndFirst()` 只等开场那一句和第一题的预置音频，不等整场脚本，也不等兜底话术。
- **三级播放兜底**：已预取片段（blob 预解码）→ 渐进式 `GET /api/tts` 流 → 完整缓冲；全失败才回退浏览器语音，并如实提示。

重复台词从 7.6s 降到 10ms 级；未预取的动态追问首字节约 3s 即可出声。详见 `.env.example` 与 `docs/architecture.md`。

## 考官语音系统（Phase 2）

> **Phase 1 与 Phase 2 已合并为一套实现**：Phase 1 负责调度、播放生命周期与录音，Phase 2 负责「怎么说得像人」。VoiceProfile 与 SpeechAct 直接进入调度 key 和服务端缓存 key，不存在两套并行的音频管线。

### VoiceProfile：一套配置描述任何引擎
`src/lib/speaking/voice-profile.ts` 把「谁在说话」抽象成与供应商无关的结构：`provider`（azure / openai / kokoro / browser）+ `voice` + `speed` + `pitch` + `style?` + `instructions?` + `prosody`（句间/问句/分句停顿、是否强调）。Provider 与音色解耦，换引擎不需要改考试流程。

配置分三层，互不覆盖：

| 层级 | 来源 | 生效范围 |
|---|---|---|
| 默认 | 内置预设 `VOICE_PRESETS` + `TTS_PROVIDER/TTS_VOICE/TTS_SPEED` | 未做任何选择时 |
| 用户偏好 | `users.examiner_voice`（设置页 / Voice Lab） | 之后新建的考试 |
| 考试快照 | 创建考试时写入 `configSnapshot.voiceProfile` | **该场考试全程固定** |

考试中改设置不会改变当前考官声音；刷新页面也会读回快照，而不是最新设置。旧值全部兼容：`bf_emma`（Kokoro 旧音色名）→ `kokoro:bf_emma`，`en-GB-SoniaNeural` → `azure:en-GB-SoniaNeural`，`provider:voice` 原样识别。

### SpeechAct：同样是文字，说法不同
`src/lib/speaking/speech-act.ts` 定义 7 种表达类型，每种只调整**表达方式**，绝不改动题目文字或考试规则：

| Act | 语速 | 句间停顿 | 强调 | 典型台词 |
|---|---|---|---|---|
| `greeting` | ×0.99 | 240ms | 否 | Good morning. My name is Sarah. |
| `introduction` | ×1.00 | 260ms | 轻微 | In this first part, I'd like to ask… |
| `instruction` | ×0.96 | 300ms | 轻微 | You'll have one minute to prepare… |
| `question` | ×1.00 | 240ms / 问句 440ms | 轻微 | Do you enjoy reading? |
| `acknowledgement` | ×1.02 | 180ms | 否 | Thank you. / Right. |
| `time_warning` | ×1.00 | 300ms | 轻微 | That is the end of your talk. |
| `closing` | ×0.95 | 320ms | 否 | That is the end of the speaking test. |

`prepareExaminerSpeech()` 输出纯文本 + 可移植 SSML + 该 act 的 steering 文本 + 最终语速/音高；强调每句最多一个实词（停用词表过滤），因为过度强调最容易听起来像机器。开场白、Part 引导、追问、叫停、结束语分别以对应 act 合成，不再整场一个腔调。

### 各 Provider 的真实能力
| Provider | SSML | instructions | style | pitch | 本机状态 |
|---|---|---|---|---|---|
| Azure Neural | ✅ 精确 `<break time>` + `prosody rate/pitch` + `emphasis` | ❌ | 仅显式配置时 | ✅ | 未配置密钥，已做 SSML 合法性与降级测试 |
| OpenAI `gpt-4o-*-tts` | ❌（官方拒绝未知字段） | ✅ 按 act 分派 | ❌ | ❌ | 未配置密钥 |
| OpenAI `tts-1/-hd` | ❌ | ❌ | ❌ | ❌ | — |
| Kokoro 兼容 | ✅ `<break strength>` | ❌ | ❌ | ❌ | ✅ 实测可用 |
| 浏览器 | ❌（用 rate/pitch 近似） | ❌ | ❌ | ✅ | 仅兜底 |

**能力探测而非假设**：只给引擎发送它文档里支持的字段；Azure 的 `mstts:express-as` 仅在明确选择了 style 时发送，避免 400。请求了未配置的 provider 会返回明确错误（`502 … AZURE_SPEECH_KEY not configured`），**不会静默换成另一个声音**。

### 缓存身份
缓存 key = `provider` + `model` + `profileFingerprint`（含 `voice` / `language` / `speed` / `pitch` / `style` / `instructions` / `prosody` / `format`）+ `speechAct` + `text`。客户端调度 key 也包含 `act` 与 `profile`，所以预取和播放一定命中同一份；换音色 / 改语速 / 换 act 都会得到新 key，不可能读到上一次配置的音频。响应头带 `X-TTS-Provider / X-TTS-Voice / X-TTS-Act / X-TTS-Cache / X-TTS-Synthesis-Ms`，便于排查。

### Voice Lab（设置页底部）
同一句话、同一个 act，A/B 两个 profile 并排听：可切 Provider / 音色 / 语速 / 音高 / SpeechAct / 自定义文本，内置 7 句固定语料；每次合成显示**延迟、MIME、采样率、体积**，失败显示 Provider 原文错误。未配置的 provider 在下拉里标 `not configured` 且不可选。听到满意的，"Use for exams" 写入你的考试音色（只影响之后的新考试）。

> 自然度只能靠耳朵判断，所以这一块刻意不做机器打分。

## 无 API Key 时的行为（真实，不做伪造）
| 能力 | 默认 | 说明 |
|---|---|---|
| ASR | 浏览器 Web Speech API | Firefox 不支持时音频照常保存，但没有转写 |
| 考官语音 | 浏览器 speechSynthesis | 配置任一 TTS 服务后自动切换 |
| 评分 | **不评分** | 未接入 AI 时只走完整考试流程，录音/转写/回放照常可用 |
| Pronunciation | **不评估** | 不会根据文本估算发音 |

## AI 服务配置（后台 `/admin`）

LLM 评分、考官语音、转写、发音评测都能在 `/admin` 的「AI 服务」面板里配置，**保存即生效，无需重启**：

- 每个服务独立开关：关掉 LLM → 考试照常完成、报告显示「未评分」（绝不伪造分数）；关掉 TTS → 回退浏览器语音；关掉 ASR → 用浏览器 Web Speech。
- `provider = 自动` 沿用环境变量；显式选择后以面板为准（可填 Base URL / Model / Voice / Region）。
- 密钥只写入服务器上的 `storage/ai-config.json`（已 gitignore），接口只回传 `••••后四位`，**永远不会发到浏览器**。
- 该文件是**单实例**配置：多实例部署请用环境变量/密钥管理，或让各实例共享同一卷。
- 设置了 `ADMIN_TOKEN` 时，保存操作需要页面上方的管理令牌。

## 测试
```bash
npm run typecheck && npm run lint
npx tsx --test tests/unit.test.ts                 # 状态机 / 评分 / 指标（30）
npx tsx --test tests/audio-perf.test.ts           # 音频调度与生命周期（24）
npx tsx --test tests/scoring-rubric.test.ts       # 0–9 判据与引用校验（14）
npx tsx --test tests/bank-learning.test.ts        # 题库学习素材与音频策略（14，其中 1 项需要 DATABASE_URL）
npx tsx --test tests/learning-store.test.ts       # Sidecar 原子写 / 并发 / 配置诊断（7）

# 端到端（需要 PostgreSQL）
npx drizzle-kit push
npm run build && npx next start -p 3100 &
node tests/integration.mjs http://localhost:3100  # 28 项实际执行（共 31 项定义，3 项 TTS 检查在无服务端 TTS 时跳过）
node tests/migration-check.mjs                    # 迁移链与 schema.ts 一致性
```

以上数量与 `.github/workflows/ci.yml` 实际执行一致；CI 每次运行都会跑全部 8 类检查。

## 文档
- `docs/architecture.md`：架构、数据模型、状态机、题库与语音链路
- `docs/phase2-examiner-voice.md`：考官语音系统（VoiceProfile / SpeechAct / Provider 能力 / 集成说明）
- `docs/api.md`：API（含 `/api/admin/banks`）
- `docs/reverse-engineering/`：REA 逆向报告（8 篇 + 证据 manifest）
- `docs/test-report.md`、`docs/roadmap.md`

## 版本控制
`main` 分支。`.gitignore` 忽略 `node_modules/`、`.next/`、`.env*`（保留 `.env.example`）、`storage/`、`.workbuddy/` 等生成物与本地密钥。**不要把包含密钥的 `.env` 提交进仓库。**
