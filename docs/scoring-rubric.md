# 评分标准化：结构化 Band Descriptor 与可引用证据

> 对应 issue **#4**。分支 `feat/phase3-scoring-ci`。

## 1. 为什么要做

改造前 `band-descriptors.ts` 只有四项的**关键指标**（indicators），没有 0–9 的分档措辞。
评分 prompt（`speaking-language-v2.0-criteria`）因此只给模型「看什么」，不给「档位长什么样」，
模型只能靠自身先验对齐 band —— 同一段回答换模型可能差 0.5–1 分，也无法做「改造前后同一样本」的回归。

本次把四项 × 0–9 档位录入为**结构化、可引用**的数据，prompt 改为「按档位判据逐条比对」，
报告页可展示「依据第 X 档第 Y 条」。

## 2. 数据结构

`src/lib/speaking/band-descriptors.ts`

```ts
interface BandDescriptor {
  id: string;        // 稳定唯一：<DIM>-B<band>-<nn>，如 GRA-B6-01
  dimension: "FC" | "LR" | "GRA" | "P";
  band: number;      // 整数 0–9（没有 6.5）
  text: string;      // 简明、可判断的判据（转述）
  focus: string;     // 短标签：fluency / cohesion / range / accuracy / intelligibility ...
}
```

- 数据由 `SEEDS`（按维度、档位分组）生成，ID 由 `(dimension, band, index)` 推导，
  **不会漂移**；导出时按「维度 → 档位升序 → ID」稳定排序，便于 diff 与快照。
- 每档 1–4 条判据；`P` 的 7 / 5 / 3 档保留官方「桥接式」表述
  （「具备 B6 全部正面特征 + 部分 B8 正面特征」），因为官方就是这么写的。
- 覆盖度：4 维度 × 10 档，共 **69** 条判据
  （FC 19 / LR 18 / GRA 17 / P 15），每个维度都完整覆盖 Band 0–9。
  注入 prompt 的 rubric 约 6.9 KB。

### ID 约定

| 段 | 含义 | 例 |
|---|---|---|
| 前缀 | 维度 | `FC` `LR` `GRA` `P` |
| `B<band>` | 整数档位 | `B6` |
| `-nn` | 该档内序号（两位） | `-01` |

`FC-B7-01` = 流利度与连贯性 · 第 7 档 · 第 1 条。**不要重编号**：历史报告会引用这些 ID。

## 3. 半分规则（重要）

官方档位**只有整数**，没有 6.5 的官方措辞。本次实现明确区分：

- `band` 永远是整数；
- 6.5 表示「介于 6 与 7 之间」，评分时选更接近的整数档，并引用**跨档的**判据；
- `allowedBandsFor(6.5) === [6, 7]`，`allowedBandsFor(7) === [7]`；
- `halfBandRule()` 会把这条规则写进 prompt，禁止模型把半分当成官方档位或编造 6.5 判据。

## 4. Prompt 变化（`speaking-language-v3.0-rubric`）

`buildScoringMessages()` 现在注入完整 rubric（`descriptorBrief()`），并要求：

1. 每个维度先做 **Best Fit**：选最贴合证据的单一整数档；
2. 半分取更接近的整数档，不得伪造档位；
3. `descriptorRefs` 列 2–4 个**原样复制**的 ID（本档或相邻档），**禁止编造**；
4. rationale 必须写「考生实际做了什么」，不得复述判据原文。

硬性纪律（写进 prompt）：

- 不得用词数 / 答案长度 / 复杂句数量推断 band；
- 不得把连接词数量等同于连贯性（滥用连接词反而会降低 FC）；
- Part 1 的简短是正确策略，**仅因简短不得扣分**，也不得因冗长加分；
- **不得评 P**：只有 ASR 转写，没有音频；P 由音频评测单独给出。

保留原有的引用防幻觉（`quote` 必须能在转写中找到）与 ASR 误识别保护（`possibleAsrError`）。

## 5. 输出校验（`validateLanguageScore`）

新增 `descriptorRefs` 校验，规则集中在 `checkDescriptorRefs()`：

| 情况 | 处理 |
|---|---|
| 字段缺失（旧输出 / 旧 prompt） | 视为 `[]`，**兼容**，不报错 |
| ID 不存在 | 丢弃该 ID，计入 `rejectedRefs` |
| ID 属于别的维度 | 丢弃 |
| ID 档位与得分相差 > 1 档 | 丢弃 |
| 重复 ID | 去重 |
| 某维度给了 refs 但**全部无效** | 抛 `ScoringValidationError` → 触发重试 |
| 某维度给了 refs 但**没有任何一条落在本档** | 抛错 → 触发重试 |

保证：**虚构 ID 永远不会出现在返回结果、数据库或 UI 中**（测试 7 覆盖）。

`rejectedRefs` 会回传给 `report-service`，可写入 notes 说明「有 N 条引用因不合法被丢弃」。

## 6. 报告页

`report-view.tsx`：

- 维度卡：Band + rationale + 引用到的判据（ID + 档位 + focus + 判据原文）；
- 每条 finding：原文证据、修改建议、解释、以及它支撑的判据 ID；
- 旧记录没有 `descriptorRefs` 时正常展示，只是不出现判据块；
- 启发式评分明确标注「无法引用判据」；
- 「How this was scored」增加 rubric revision 与免责声明：
  **判据为结构化转述，非官方原文；报告不是官方分数，也不构成任何分数保证。**

## 7. 来源与版本

```ts
DESCRIPTOR_SOURCE = {
  title: "IELTS Speaking band descriptors (public version)",
  publisher: "British Council / IELTS Partners",
  url: "https://takeielts.britishcouncil.org/take-ielts/ielts-results-scores",
  retrieved: "2026-11-13",
  revision: "rubric-1.0",
}
```

- 文本是**结构化转述**，不是官方原文，也不代表 IELTS 官方认可。
- `revision` 每次改动判据都要升版；报告页会显示它，便于回溯某份报告用的是哪版标准。

## 8. 持久化（已完成）

`assessment_findings.descriptor_refs` 已落地：

- **Schema**：`jsonb("descriptor_refs").$type<string[]>().notNull().default([])`
- **迁移**：`drizzle/0001_learning_audio_descriptor_refs.sql`
  （同时补上 PR #9 加了列却没生成迁移的历史缺口；全部是 ADD COLUMN / SET DEFAULT，不删表不删数据）
- **写入**：`report-service.ts` 在插入 finding 时写 `descriptorRefs: f.descriptorRefs ?? []`
- **读取**：`getReport()` 把 `null` 归一化为 `[]`，旧记录照常展示
- **验证**：`tests/integration.mjs` 用真实 PostgreSQL 写入 → SQL 读回 → 报告 API 读回；
  `tests/migration-check.mjs` 校验迁移链与 `schema.ts` 完全一致

## 9. 仍未验证

- **真实 LLM 评分质量**：本仓库 CI 不调用付费模型，只校验**结构、引用合法性与单调性**。
  自动化测试通过 ≠ 评分质量已验证。「同一回答换模型差异 ≤ 0.5」需要离线批跑 + 人工抽检。
- 报告页的判据展示只在无 LLM 环境下做过降级验证（`unscored` 时无 findings），
  带真实 findings 的视觉效果需在有 API Key 的环境人工确认。
