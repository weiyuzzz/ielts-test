# Band Nine — IELTS 四科备考平台（第一阶段：Speaking）

Next.js 16 (App Router) + PostgreSQL (Drizzle ORM) + Tailwind 4。默认运行在 **3100 端口**。

| 模块 | 状态 |
|---|---|
| Speaking | ✅ 完整模考 + Part 1/2/3 专项、当季题库、录音/转写、考官语音、报告 |
| 题库后台 `/admin` | ✅ 导入季度题库、切换启用季度、查看题库内容 |
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
- **题库列表**：季度、考区、各部分题目数、是否启用。
- **查看内容**：按 Part 筛选 / 搜索，逐主题展示题目与题卡要点。
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

### 延迟优化
实测本地 Kokoro 短句 2–4s、长句 9–13s。优化点：setup 阶段预取整场台词（并发 2，POST 完整缓冲）+ blob 预解码、服务端 LRU 缓存与 in-flight 去重、`GET /api/tts` 逐句流式 pipe、四级播放兜底（缓存 → 流式 → 完整缓冲 → 浏览器语音）。重复台词从 7.6s 降到 0.03s；动态追问首字节约 3s 即可出声。详见 `.env.example` 与 `docs/architecture.md`。

## 无 API Key 时的行为（真实，不做伪造）
| 能力 | 默认 | 说明 |
|---|---|---|
| ASR | 浏览器 Web Speech API | Firefox 不支持时音频照常保存，但没有转写 |
| 考官语音 | 浏览器 speechSynthesis | 配置任一 TTS 服务后自动切换 |
| 评分 | **不评分** | 未接入 AI 时只走完整考试流程，录音/转写/回放照常可用 |
| Pronunciation | **不评估** | 不会根据文本估算发音 |

## 测试
```bash
npx tsx --test tests/unit.test.ts                 # 单元测试（22 项）
npm run build && npx next start -p 3100 &
node tests/integration.mjs http://localhost:3100  # 端到端（含题库后台、组卷规则、未评分行为）
```

## 文档
- `docs/architecture.md`：架构、数据模型、状态机、题库与语音链路
- `docs/api.md`：API（含 `/api/admin/banks`）
- `docs/reverse-engineering/`：REA 逆向报告（8 篇 + 证据 manifest）
- `docs/test-report.md`、`docs/roadmap.md`

## 版本控制
`main` 分支。`.gitignore` 忽略 `node_modules/`、`.next/`、`.env*`（保留 `.env.example`）、`storage/`、`.workbuddy/` 等生成物与本地密钥。**不要把包含密钥的 `.env` 提交进仓库。**
