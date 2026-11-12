# Band Nine — IELTS 四科备考平台（第一阶段：Speaking）

Next.js 16 (App Router) + PostgreSQL (Drizzle ORM) + Tailwind 4。默认运行在 **3100 端口**。

| 模块 | 状态 |
|---|---|
| Speaking | ✅ 可用：完整模考 + Part 1/2/3 专项、录音、转写、AI 考官追问、四项评分报告、历史 |
| Listening / Reading / Writing | 🚧 Coming Soon 页面（明确标注不可用） |

## 快速开始
```bash
npm install
cp .env.example .env             # 至少设置 DATABASE_URL；语音配置见下文
npx drizzle-kit push             # 建表（或执行 drizzle/ 下生成的 SQL）
npm run build && npx next start -p 3100   # 生产；开发用 npm run dev -p 3100
```
题库会在第一次访问时自动写入（`src/lib/server/seed.ts`，用 advisory lock 保证幂等）。录音默认保存在 `storage/audio/`（可用 `AUDIO_STORAGE_DIR` 修改）。

## 考官语音（TTS）

### 三档引擎，自动选择

| 引擎 | 启用方式 | 自然度 | 说明 |
|---|---|---|---|
| 浏览器 `speechSynthesis` | 未配置任何语音服务（自动降级） | ★ | 系统音色偏机械；已改为优先挑选云端 Natural / Neural 英式音色、提前预热音色列表、降低语速并规避 Chrome 长句卡死 |
| OpenAI 兼容 `/audio/speech` | `TTS_PROVIDER=openai` + `TTS_BASE_URL` / `TTS_API_KEY` | ★★★ | 支持 OpenAI `gpt-4o-mini-tts`、本地 Kokoro 等；自动加句间停顿、语速控制，支持 progressive 播放 |
| **Azure Neural TTS** | `TTS_PROVIDER=azure` + `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | ★★★★★ | `en-GB-SoniaNeural` / `en-GB-RyanNeural`，48 kHz 无损 PCM，最接近真人；**与发音评测复用同一份密钥** |

`TTS_PROVIDER` 留空时为 `auto`：有配置的服务优先，都没有才回退浏览器语音。密钥只存在于服务端，前端只拿到 `/api/config` 里的引擎信息。

### 默认配置（本机：Docker 里的 Kokoro，监听 8880）

`.env` 当前使用 `TTS_MODEL=kokoro`、`TTS_VOICE=af_heart`、`TTS_SPEED=0.95`、`TTS_PROSODY=1`、`TTS_STREAM=1`、`TTS_FORMAT=mp3`。

原先的 `bf_emma` 是英式音色里最好的，但 Kokoro 官方质量评级只有 **B-**，也正是"机械感"的主要来源；`af_heart` 是唯一评级 **A** 的音色。若口音比自然度更重要可改回 `bf_emma`；若两者都要，用 Azure 的 `en-GB-SoniaNeural`。

### 发音自然度做了什么

1. **韵律**：`src/lib/ai/tts-text.ts` 把考官台词按句切分，用 SSML `<break>` 插入 250 ms 句间停顿、问句后 500 ms 停顿（Kokoro 兼容引擎会翻译成 `[pause:0.25s]`，Azure 直接支持 SSML），避免整段平铺直叙。只有兼容引擎才发送 `ssml` / `allow_voice_tags`，OpenAI 官方接口不会收到不认识的字段。
2. **语气**：`gpt-4o-mini-tts` 会收到 `instructions`（沉稳、中性、不夸张的雅思考官），可用 `TTS_INSTRUCTIONS` 覆盖。
3. **语速**：默认 `0.95`，比机械的 1.0 更接近真人考官；浏览器回退降到 `0.92`。
4. **音质**：`TTS_FORMAT=wav` / `flac` 可关闭 MP3 有损压缩（本地部署体积不是问题，且省掉编码耗时）；Azure 默认输出 48 kHz 16-bit PCM。
5. **浏览器回退**：原先固定选 `en-GB` 本地音色，现在按音色打分优先云端 Neural 音色；页面加载即预热 `getVoices()`，不再让第一句话等 1.5 秒；加入 8 秒 `pause/resume` 心跳防止 Chrome 长句停读。

### 延迟做了什么

实测（本机 Kokoro/CPU）：短句合成 2–4 秒，Part 2 长句 9–13 秒。旧实现把「整段合成 → 整段下载 → `audio.play()`」放在考试主流程上，且**第一句完全没有预取**，所以每次考官开口前都有明显空白。

| 场景 | 优化前 | 优化后 |
|---|---|---|
| 首题考官发问 | 等完整合成 + 下载，4–13 s | 设置页/等待麦克风时已预取，**命中即播（≈0 s）** |
| 后续题目 | 每题等待合成 | 录音期间后台预取下一句，命中即播 |
| 重复台词 / 刷新 / 试听 | 每次重新合成 | 服务端 LRU 缓存直接返回，≈0 s |
| 临时生成的 Part 3 追问 | 等完整合成 | **progressive 播放**：第一句生成完就出声 |
| 浏览器回退首句 | 额外 1.5 s 等音色表 | 已预热，0 s |

具体机制：

- **全脚本预取**：`examLines()` 在 setup 阶段就把本场所有可能说出的台词（每步的两种应答变体、重复问法、固定结束语）按播放顺序排队；并发限制为 2，避免本地 CPU 引擎被压垮。预取走 `POST /api/tts` 的完整缓冲（单次合成比逐句流式更快完成），即时播放走 `GET` 流式，两者共享同一份服务端缓存。
- **提前解码**：预取结果转成 blob URL 并 `preload="auto"` + `load()`，播放时不再有解码/缓冲间隙；失败的请求不进缓存，可自动重试。
- **服务端缓存**：`/api/tts` 按 `voice|text|model|format|speed|prosody` 做内存 LRU（默认 80 条 / 32 MB），并对同一句的并发请求做 in-flight 去重。原先 POST 上的 `Cache-Control` 实际不会被浏览器缓存。
- **流式兜底**：新增 `GET /api/tts?text=…&voice=…`，服务端把上游的逐句音频流直接 pipe 给浏览器（响应头 `X-TTS-Cache: miss-stream`），同时把完整音频写入缓存；客户端若 12 秒内没能开始播放，自动回退到完整缓冲路径，再失败才回退浏览器语音。
- **首句保护**：`speak()` 优先等待已排队的预取（最多 1.5 秒），其余情况立刻走流式，不阻塞考试状态机。

### 验证

```bash
# 当前引擎、音色、格式、是否支持流式
curl -s http://localhost:3100/api/config | jq .tts

# 首次合成（看 X-TTS-Cache: miss-stream / miss），第二次应为 hit 且几乎瞬时
curl -s -c /tmp/c.jar http://localhost:3100/ >/dev/null
curl -s -b /tmp/c.jar -D - -o /tmp/clip.mp3 \
  'http://localhost:3100/api/tts?text=Thank%20you.%20That%20is%20the%20end%20of%20the%20speaking%20test.&voice=auto' \
  | grep -i 'x-tts-cache\|content-type'
```
也可以在 `/settings` 里用「Test voice」试听、切换音色（输入框已带常用音色建议）。

完整变量说明见 `.env.example`；追求最自然发音时只需改两行：
```bash
TTS_PROVIDER=azure
AZURE_SPEECH_KEY=...      # 与 PRONUNCIATION_PROVIDER 共用
AZURE_SPEECH_REGION=eastasia
```

## 无 API Key 时的行为（真实，不做伪造）
| 能力 | 默认 | 说明 |
|---|---|---|
| ASR | 浏览器 Web Speech API | Chrome/Edge/Safari 可用；Firefox 不支持，此时音频照常保存，但没有转写 |
| 考官语音 | 浏览器 speechSynthesis | 优先挑云端 Natural/Neural 英式音色，已预热；配置任一 TTS 服务后自动切换 |
| FC/LR/GRA | 确定性启发式评分器 | 报告中标注为 `heuristic` |
| Pronunciation | **不评估** | 不会根据文本估算发音；总分标注为 Provisional |

配置 `OPENAI_API_KEY`（或其他兼容服务）、`ANTHROPIC_API_KEY`、`AZURE_SPEECH_KEY/REGION` 后会自动切换到对应的 Provider。详见 `.env.example`。

## 测试
```bash
npx tsx --test tests/unit.test.ts                 # 单元测试：状态机、评分、校验、音频工具、TTS 文本前端（22 项）
npm run build && npx next start -p 3100 &
node tests/integration.mjs http://localhost:3100  # 端到端 API 测试（22 项 + 3 项 TTS 缓存/流式）
```
集成测试只在服务端 TTS 已配置时执行那 3 项语音检查，否则跳过。

## 文档
- `docs/reverse-engineering/`：REA 逆向报告（8 篇 + 证据 manifest）
- `docs/architecture.md`：架构、数据模型、状态机、AI 适配器、语音链路
- `docs/api.md`：API 文档（含 `GET /api/tts` 流式接口）
- `docs/test-report.md`：测试报告（实际运行结果）
- `docs/roadmap.md`：任务状态、阻塞项、后续三科计划

## 版本控制
仓库已初始化（`main` 分支）。`.gitignore` 忽略 `node_modules/`、`.next/`、`.env*`（保留 `.env.example`）、`storage/`、`.workbuddy/`、`tsconfig.tsbuildinfo` 等生成物与本地密钥。**不要把包含密钥的 `.env` 提交进仓库。**
