# Phase 3 — 题库学习素材 & Shadowing 跟读

分支：`feat/phase3-question-learning`（从 `main@c70f233` 创建，不直接改 main）
覆盖 Issue：#2（预置考官音频）、#5（题库学习素材）
角色边界：未改动 `src/db/schema.ts`、Drizzle migration、评分/报告模块、`exam-runner.tsx`、`speech.ts`、`recording-session.ts`、`tts-scheduler.ts`、`tests/unit.test.ts`、`tests/integration.mjs`、`package.json`。

---

## 0. 一个必须先说清的前提：`questions.learningContent` 不存在

任务书要求"使用共享 Schema `questions.learningContent`"，但**本仓库的 main 上并没有这个字段**，也没有 Phase 3 共享接口提交：

```
$ grep -n "learningContent\|question_audio_url" src/db/schema.ts
68:    questionAudioUrl: text("question_audio_url"),
74:    questionVoiceProfile: text("question_voice_profile"),
# 没有任何 learning_content 列
```

而任务书同时明令禁止修改 `src/db/schema.ts` 与 Drizzle migration。这两条约束在当前代码上是互斥的，我没有偷偷改 schema，也没有假装字段存在。

**采取的替代方案**：学习素材存为**按季度版本化的 sidecar JSON**（`src/data/learning/<season>.json`），由 `src/lib/content/store.ts` 读取，按 `season + topicKey + part + 归一化题干` 与题目关联。

为什么这个方案不是"退而求其次"：

| 维度 | 若加列 `learning_content` | 当前 sidecar |
|---|---|---|
| 与共享接口的兼容 | 需要等接口负责人 | 零依赖，接口落地后可无缝迁移（只需换掉 `store.ts` 的读实现） |
| 模考隔离 | 靠查询时不 select 该列 | **物理解耦**：考试链路根本不读这个文件 |
| 重导入稳定性 | 天然稳定（同 row） | 用自然键而非 `id`（`importBank()` 是 delete+insert，id 会变） |
| 内容评审/版本 | 需另做表 | JSON 可 diff、可 code review、可回滚 |

迁移路径写进了 `store.ts` 顶部注释：接口落地后，`loadSeasonIndex()` 改为查库即可，上层（页面、后台、测试）无需改动。

---

## 1. 音频：两类资源，两条链路

| | A. 考官题目音频 | B. 学习跟读音频 |
|---|---|---|
| 字段 | `questions.questionAudioUrl` + `questionVoiceProfile` | `learning.followAudio.{url,voiceProfile}` |
| 用途 | 正式模考朗读题干 | 学习页跟读示范 |
| 播放器 | 考试音频链路（`speech.ts` / runner） | 独立 `<audio>`（`lib/content/playback.ts`） |
| 音色要求 | **必须**等于本场考试音色，否则拒绝播放并回退 TTS | 只需可识别，不要求等于考官 |
| 能否互换 | 否 | 否（`decideFollowAudio().usableInExam` 恒为 `false`） |
| 存储 | 数据库列 | sidecar JSON |
| 缓存 | TTS/预置缓存按 session 与 profile | 按文本+profile 的对象 URL 缓存（页面级） |

职责集中在 `src/lib/content/audio-policy.ts`：

- `decideExaminerAudio(asset, sessionProfileId)` → `preset | tts`，并给出 `status`（`ready / missing / unlabelled / invalid-url / voice-mismatch`）与 `reason`。
- `decideFollowAudio(ref)` → 只判断"能不能播"，并显式标注 `usableInExam: false`。
- `audioFields(question)` → 分别返回两个角色的 URL，**故意不提供**"拿到这道题的音频"这种含糊 API。

### 校验规则（导入期）

- 外部地址必须 HTTPS；`http://` 仅允许 loopback（本地开发）；拒绝 `javascript:` / `data:` / `file:`、拒绝带凭据的 URL、拒绝相对路径。
- 有 URL 必须有 `questionVoiceProfile`；音色无法解析成 `provider:voice` 身份（`canonicalVoiceId`）→ 拒绝整份导入（400）。
- 学习素材里的非法 `followAudio` **不阻断**导入，只是丢弃并给出 warning（学习素材不该挡住考试题库导入）。
- 未标注音色的考官音频一律拒绝：宁可回退 TTS，也不让陌生声音冒充考官。

### 运行时一致性

`exam-runner.tsx` 已有的判定是**原始 id 严格相等**（`questionVoiceProfile !== profileId`），我没有改它（禁改）。后台的"能否播放"按同一规则计算，另外用 `canonicalVoiceId` 标出"同一个音色、只是写法不同"的情况（`equivalentVoice`），后台会提示"仅需改标签"——这样后台不会承诺一个考试会拒绝的播放。

> 真实覆盖率见第 8 节：**0 / 549**。这不是没做，而是没有可授权使用的录音，也没有伪造。

---

## 2. 学习素材数据结构

类型定义在 `src/lib/content/types.ts`：

```ts
QuestionLearningContent = {
  sampleAnswer?: { paragraphs: string[]; source: LearningSource; reviewStatus; targetBandHint? }
  ideaNotes?:   { stage: "main-idea"|"reason"|"example"|"result"|"contrast"; text; textZh? }[]
  keyPhrases?:  { phrase; zh; example; usage? }[]
  followAudio?: { url; voiceProfile; source; durationMs? }
}
LearningSource = { kind: "team"|"ai-draft"|"third-party"|"imported"; label; url? }
ReviewStatus = "draft" | "reviewed" | "rejected"
```

三条硬规则：

1. **AI 草稿不能自我升级**：`source.kind === "ai-draft"` 时，`reviewStatus` 强制回落为 `draft`，无论文件里写的是什么。
2. **不用范文改题干**：`deriveImportPlan()` 原样复制 `text`，学习素材只写进 sidecar；测试 1 断言了这一点。
3. **不宣称官方分数**：`targetBandHint` 只是自填目标，UI 从不渲染成"Band 8/9 范文"；当前数据里全部为 `null`。

题库 JSON 只需在题目对象上加 `learning`（也接受顶层 `followAudio` 简写）：

```json
{ "text": "Where is your hometown?",
  "learning": { "sampleAnswer": {"paragraphs": ["..."], "source": {"kind":"team","label":"内容组"}, "reviewStatus":"reviewed"} } }
```

不含 `learning` 的旧题库：零改动、零 warning。

---

## 3. 题库后台（`/admin`）

列表新增「预置考官音频」列：`有音频题数 / 总题数 · 覆盖率`。

题库详情新增：

- 四个统计块：总题数、可用预置音频（覆盖率）、音色不匹配（含"仅需改标签"数量）、无音频/无效（走 TTS）。
- 学习素材覆盖率条：示范答案题数、跟读音频数、已人工审核数。
- 逐题状态：`预置音频 / TTS / 音色不符 / 未标注音色 / URL 无效` + 不可播原因 + URL 与音色标注 + 素材来源与审核状态。
- 导入结果会列出 warning（被丢弃的学习素材、未保存的文件写入等）。

---

## 4. `/speaking/questions`：学习内容浏览器

从只读列表升级为可展开的资料库：

- Part 1/2/3 筛选 + 主题/题干搜索 + 分页（默认 40 题，避免一次性平铺 549 题）。
- 折叠行只显示题干 + 素材状态（`草稿` / `已审核` / `仅题目`），展开后展示：
  - **Sample answer**：逐段文本 + 段级播放（服务端神经语音，无引擎时回退浏览器语音并明示）、逐段复制、来源与审核状态、来源链接。
  - **Idea notes**：Main idea / Reason / Example / Result / Contrast 五类固定骨架。
  - **Key phrases**：英文词组 + 中文解释 + 英文例句 + 使用场景 + 复制。
  - **Follow audio**：有授权录音就是 `<audio>` 播放；没有就说明原因并提供"TTS 试听首段"。
  - **进入 Shadowing**：带 `topicKey/part/q` 深链。
- 顶部固定声明：示范答案是练习素材，不是考试内容，也不是官方范文。

---

## 5. `/speaking/practice`：Shadowing 跟读

流程与任务书一致：

```
选题(Part/Topic) → 看示范答案 → 播放原音 → 录音 → 回放 → ASR 转写 → 与示范文本对比 → 遗漏/差异 + 练习建议 → 标记完成
```

实现要点：

- **复用 `RecordingSession`**（未改一行）：整页只 acquire 一次麦克风/AudioContext，每段录音独立 MediaRecorder + 16k WAV。
- **转写**：`POST /api/learning/asr`，服务端复用现有 `getASR()`；返回 `ok | unavailable | failed` 三种状态（均 200，除参数错误）。无 ASR 时页面顶部明示"可录音回放，不能转写"，按钮禁用但录音链路完好。
- **对比**：`lib/content/diff.ts` 做词级 LCS → `match / missing / extra / changed` 四类标记，展示时长、词数、wpm 与参考词覆盖率。
- **逐句练习**：示范答案按句拆分，点句子进入单句模式，ASR 的 `hint` 同步为单句。
- **诚实标注**：差异显式标注"参考信息，ASR 可能识别有误"；输出里没有任何发音分、音素结论或 Band——`speechStats` 只有 `words/durationMs/wpm`（测试断言了 key 集合）。
- **不落库**：录音只存在于页面（`createTakeStore().persistence === "session-memory"`），ASR 在内存中转写后丢弃，绝不写 `answer_records` / `audio_assets`；离开页面 `dispose()` 释放麦克风并 revoke object URL。

---

## 6. API

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/learning/questions?topicKey=&part=` | 返回某主题的题目 + 学习素材 + `followAudio` 可播性 + ASR 可用性 |
| POST | `/api/learning/asr` | multipart `audio`(wav/webm) + `hint`；返回 `{status: ok\|unavailable\|failed, ...}`，不落库 |
| GET | `/api/admin/banks` | 列表新增 `audio.{withAudio,total}`；`?id=` 详情新增 `audio` 覆盖统计、`learning` 覆盖统计、逐题 `audio/followAudio/learning` 状态、`examinerProfile` |

---

## 7. 测试

`npx tsx --test tests/bank-learning.test.ts` → **14/14 通过**（13 个任务书要求项 + 1 个 diff 行为测试）。其中第 4 项是真实数据库幂等测试（无 `DATABASE_URL` 时自动 skip）。

| # | 覆盖点 | 结论 |
|---|---|---|
| 1 | 旧题库无 learningContent | 正常导入，4 题，0 素材，无 warning |
| 2 | 完整学习素材 | 4 题不变，1 条素材，字段与来源/审核状态正确 |
| 3 | 部分/空素材 | 6 题全部导入，仅 2 条可用素材，空 `sampleAnswer` 被丢弃并 warning |
| 4 | 同季度重复导入 | 真实 DB：题目数一致、只有 1 个 set、sidecar 只有 1 条、未抢占启用位 |
| 5 | 考官音频字段 | URL 与音色原样入库，且不产生素材条目 |
| 6 | 音色不匹配 | 不同音色 → 回退 TTS；相同音色 → 播放；同音色不同写法 → 拒绝但标记可改标签；未标注 → 拒绝 |
| 7 | 非 HTTPS | http/ftp/javascript/data/相对路径/带凭据全部拒绝；loopback 放行；导入抛 `invalid_audio_url` / `unlabelled_audio` / `invalid_voice_profile` |
| 8 | 两类音频不混用 | follow 音频不进 `questionAudioUrl`；`usableInExam === false` |
| 9 | Full Mock 无学习素材 | 投影后无任何 learning key，key 集合等于白名单 |
| 10 | 学习页拿到完整素材 | 4 类素材齐全；按归一化题干匹配（大小写/空格不敏感） |
| 11 | 无 ASR 仍可录音回放 | take 保留、`canReplay === true`、转写为 unavailable |
| 12 | 不进 AnswerRecord | 6 个文件静态扫描无 DB/answer_records 引用；take 字段集合不含 answerId/sessionId |
| 13 | ASR 失败不崩溃 | failed 后可重试、可回放；成功重试覆盖错误；新录音重置转写 |

回归：

```
npm run typecheck      ✅
npm run lint           ✅
npx tsx --test tests/unit.test.ts tests/audio-perf.test.ts   ✅ 54/54
node tests/integration.mjs http://127.0.0.1:3100             ✅ 30/30
npm run build          ✅（新增 /speaking/practice、/api/learning/*）
```

线上实测（3100，生产构建）：

```
GET /                    200
GET /speaking/questions  200 (265 KB)
GET /speaking/practice   200
GET /admin               200
GET /api/admin/banks?id=3 → audio.total=549, ready=0, coveragePercent=0；learning 6/549 (1.1%)
GET /api/learning/questions?topicKey=hometown&part=1 → 12 题，3 题有示范答案
POST /api/learning/asr   → {"status":"unavailable", "reason":"未配置服务端语音识别…"}
```

---

## 8. 真实数据状态（不美化）

| 指标 | 数值 |
|---|---|
| 当季大陆题库题目总数 | **549**（Part 1 211 / Part 2 58 / Part 3 280） |
| 有预置考官音频的题目 | **0**（覆盖率 **0%**） |
| 音色不匹配 / 未标注 / URL 无效 | 0 / 0 / 0（因为没有音频，不是"通过检查"） |
| 有学习素材的题目 | **6**（1.2%） |
| 有跟读音频的题目 | **0** |
| 已人工审核的素材 | **0** |

首批 6 条素材（`src/data/learning/2026-09-12.json`）覆盖：Hometown 的 3 道 Part 1、`Describe a noisy place you have been to`（P2）、及其 2 道 Part 3。全部标注 `source.kind = "ai-draft"`、`reviewStatus = "draft"`、`targetBandHint = null`，UI 上显示为「未审核草稿」。这些答案是我写的示范文本，**不是**官方 Band 8/9 范文，也不来自第三方题库。

---

## 9. 仍需授权或人工提供的素材

1. **考官题目音频 549 条**：需要与当前考官音色完全一致的录音；外部音频还必须 HTTPS 可访问。第三方题库自带的音轨授权不明，**没有**复制进来。
2. **示范答案人工审核**：现有 6 条是草稿；其余 502 题没有范文。批量生成前需要确定"谁审、按什么标准审"，否则只是把未核验内容放大 80 倍。
3. **跟读音频**：建议随审校后的范文一起录制（同一音色），并在 JSON 里填 `followAudio.voiceProfile`。
4. **内容来源合规**：`LearningSource.label` 必须写真实来源；`third-party` 需要可出示的授权说明。

## 10. 暂未实现

- 学习进度持久化（当前"标记完成"只在 `localStorage`，没有跨设备同步）。
- 排行榜、社交、积分、自动 Band 预估（任务书明确第一版不做）。
- 逐句时间戳对齐（ASR word timings 已返回但未用于高亮同步）。
- 跟读录音的本地持久化（刻意不做：练习录音不应变成评估数据）。
- 课后复习队列 / 错题本。

## 11. 浏览器手工验收（未完成，需真人）

自动测试覆盖不到、需要真机确认的部分：

- 麦克风权限拒绝/设备占用时的提示文案与恢复路径。
- 音量条在真实说话时的响应（当前是 `RecordingSession.onLevel` 的同一包络）。
- 浏览器语音回退（`speechSynthesis`）在 Safari/Chrome 的音色差异。
- 展开/收起 + 逐段播放的交互手感与移动端布局。

这些没有做截图验证，因此本报告不对其观感作任何断言。

## 附：题量修正（2026-11-13）

Part 1 曾少导入 40 道**大陆**题（含 Websites、Science 两个主题整块缺失），已按文档重建：
Part 1 由 170 题 / 31 主题变为 211 题 / 33 主题，题库总量 508 → 549。
非大陆题（Feeling bored、Computers / tablets、Street market、Collecting things、
Lost and found、Friends 共 31 题，以及 7 张非大陆 Part 2 卡）始终没有被导入，本次也未引入。

核查过程、逐主题差异与根因见 [`docs/bank-audit.md`](./bank-audit.md)；
解析器为 `scripts/parse-bank-doc.py`，带逐主题题数断言，可复跑。

---

## 附：全量学习素材导入（2026-11-13）

上一版只有 6 题示例素材。这一版把腾讯文档里的答案、中文翻译、思路速记、语料扩展按题导入。

### 规模（真实数字，非估算）

| 项目 | 数量 |
|---|---|
| 题库题目 | 549（Part 1 211 / Part 2 58 / Part 3 280） |
| 有示范答案 | **490**（Part 1 211 / **Part 3 279** / Part 2 0） |
| 有中文对照 | 490 |
| 有思路速记 | 490（P1 211 / P3 279） |
| 有关键词 | 489 |
| 有语料扩展 | 145（P1 139 / P3 6） |
| 有考试人数 | 269（P1 211 / P2 58） |

### 为什么缺 59 题

- **Part 2 的 58 张卡（0 题有答案）**：文档里这 58 张卡共用 12 个「串题故事」，
  并没有一卡一份答案；块结构还不一致（有的块缺 📔/📕，有的块跨了别的卡）。
  强行映射会把 A 卡的答案挂到 B 卡上——这比缺更糟，所以本期整块不导入，
  卡片仍保留题卡要点与考试人数，界面显示「暂无素材」。
- **1 道 Part 3**（`Why aren’t young people willing to listen to the experiences of older people?`）
  在原文档里只有「关键词速记」，没有 🗣️ 具体回答。

### 为什么 P1 只有 139 题有语料扩展

五个万年保留题主题（Hometown 15、Home & Accommodation 17、Work or studies 22、
The area you live in 7、The city you live in 11，共 72 题）在文档里**没有 📕 语料扩展**。
这些主题采用「类似小问合并回答」，一组小问共用一段答案，已按 `variantLabel = 合并回答（同组共用）` 标注。

### 数据链路

- 解析器：`scripts/parse-learning-doc.py`（以题库题干为锚点，未匹配即报错，绝不新建题目）。
- 产物：`src/data/learning/2026-09-12.json`（2.1 MB，549 条，按 `part|topicKey|归一化题干` 与题库一一对应）。
- 校验：题库 549 ↔ 素材 549，缺 0、多 0、重复 0；`src/data/question-banks/*.json` 一字未改，
  所以没有删题、没有改题。
- 页面：`/speaking/questions` 首屏只传题目与统计（356 KB，此前把素材全塞进去是 1.66 MB），
  展开某题时才按主题拉取素材。

### 仍未做的事

- Part 2 的串题故事素材（需要单独设计「一故事多卡」的模型，而不是塞进单题）。
- 0–9 分档描述符：文档里是图片，文本层没有，未臆造（见 `docs/scoring-criteria.md`）。
- 所有素材 `reviewStatus` 仍为 `draft`：来自第三方整理，未经人工审核，不能宣称官方范文。
