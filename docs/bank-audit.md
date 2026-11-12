# 题库与腾讯文档一致性核查（2026-11-13）

对照文档：腾讯文档《雅思口语9-12月题库【Part123】》（file_id `PXzPpDIjkken`），全文 159.7 万字符。
核对脚本：`scripts/parse-bank-doc.py`（可复跑，逐主题断言题数）。

## 0. 一句话结论

题库**只包含大陆题**，非大陆题一条都没有混进来；Part 2 / Part 3 与文档一致；
**Part 1 之前少了整整 40 道大陆题**（含 Websites、Science 两个主题整块缺失），现已按文档重建。

## 1. 考区怎么判定

文档里每个 Part 1 行尾有 `🌍 考区` 列：

```
| 题目名称 | 🌍 考区 | 🔎 类型 | 🤚 数量 | 🤓 考试人数 |
| 1 | Paper-纸张 ... | 大陆地区 | 9-12月新题 | 5 | 1701 |
```

Part 2 卡片表同样有考区列；非大陆卡在正文里的标题写成 `[非大陆地区 9-12月新题]Describe ...`。
Part 3 没有独立考区列，**随所属 Part 2 卡**。

> 上一轮核查的错误就在这里：正则把「上一行的考区」当成了「下一行主题的考区」，
> 于是把 6 个非大陆主题误判为「大陆但缺失」，并建议补进来。这个判断是错的。

## 2. 非大陆题：文档里有哪些，库里有没有

| 部分 | 非大陆主题 | 题量 | 库内是否存在 |
|---|---|---|---|
| Part 1 | Feeling bored 感到无聊 | 4 | 否 |
| Part 1 | Computers / tablets 电脑/平板 | 5 | 否 |
| Part 1 | Street market 街边市场 | 4 | 否 |
| Part 1 | Collecting things 收集物品 | 4 | 否 |
| Part 1 | Lost and found 失物招领 | 5 | 否 |
| Part 1 | Friends 朋友 | 9 | 否 |
| Part 2 | 公共场所丢失物品 / 想再去一次的城市 / 节约时间的方法·改变 / 改变重要决定 / 一见且想继续了解的人 / 送朋友的礼物 / 印象深刻的课程 | 7 张卡 | 否 |

Part 1 合计排除 31 题、Part 2 排除 7 张卡，其 Part 3 讨论题随卡一并排除。
按卡片名边界逐块核对，非大陆卡块内的 P3 问句命中库内 **0** 条。

## 3. Part 1 重建前后

| | 主题 | 题数 |
|---|---|---|
| 文档（大陆） | 33 | 211 |
| 重建前 | 31 | 170 |
| 重建后 | 33 | **211** |

差 1 题是文档把 `Who helps u the most？Why？` 写在同一格（22 个小问 / 21 格），脚本按格计数，未拆分。

逐主题变化：

| 主题 | 前 | 后 | 说明 |
|---|---|---|---|
| Work or studies | 12 | 21 | 合并小问只取了首问 |
| Home & Accommodation | 12 | 17 | 同上 |
| Hometown | 12 | 15 | 同上 |
| The city you live in | 9 | 11 | 同上 |
| Headphones | 3 | 5 | 缺 `What type of headphones do you use?`、`When would you use headphones?` |
| Morning time | 3 | 5 | 缺后两题 |
| Singing | 5 | 6 | 缺首题 `Do you like singing?` |
| Outer space and stars | 3 | 4 | 缺 `Do u like science fiction movies?` |
| Tiredness / Travelling / Watch | 3 | 4 | 各缺首题 |
| **Websites** | 0 | **7** | 整块缺失（大陆·保留题） |
| **Science** | 0 | **6** | 整块缺失（大陆·保留题） |
| Shopping | 5 | 4 | **删掉误入的例句** `Does this time work for you?` |
| Shoes / Mirrors | 4 | 4 | 题数不变，`How often?` 残片还原为 `Do you like buying shoes? How often?` |

## 4. Part 2 / Part 3

- Part 2：文档 65 张卡（48 行索引 + 17 张与内容同格的卡），其中大陆 58 张；库内 58 张，**完全一致**，无非大陆卡。
- Part 3：库内 280 题分布在 55 张卡上，**全部能在文档原文中检索到**，没有编造；有 3 张卡文档未给 P3。
- 发现 2 组题干完全相同的卡：`对结果开心的重要决定` / `重要决定`、`和朋友度过的愉快夜晚` / `印象深刻的聚会`。文档里这两组共用同一个串题故事，可能是刻意合并，也可能是重复录入——**未改动**，留待确认。

## 5. 根因与修复

根因：`2026-09-12-mainland.json` 是一次性手工解析产物，仓库里没有解析脚本，也没有覆盖率断言。
当时的解析以 `📢 语音跟读 X-N.mp3` 编号为锚点，没有音频编号的题目与整块主题被静默丢弃。

修复：`scripts/parse-bank-doc.py`

```bash
python3 scripts/parse-bank-doc.py --doc /tmp/doc.txt --check   # 逐主题对账
python3 scripts/parse-bank-doc.py --doc /tmp/doc.txt --write   # 写回题库 JSON
```

- 只写 `大陆地区` 行，非大陆行只打印不写入；
- 每写一个主题前断言 `抽取数 == 文档自述数量`，不一致直接退出码 1、不写文件；
- 文档文本不落仓库（第三方内容），需要时用 tencent-docs 的 `get_content` 重新导出。

## 6. 副作用（需要知道）

- `importBank()` 是整表重建：题库集合 id 由 3 变为 12，`questions` 重新插入，
  历史模考的子步骤留下 549 条悬空 `question_id`（题干文本是快照，报告仍可打开）。
- 本地库此前缺 `assessment_findings.descriptor_refs` 列（合并进了分档判据代码但没跑迁移），
  已按 `drizzle/0001` 补齐；`node tests/migration-check.mjs` 现为 parity OK。

## 7. 复核方式

```bash
python3 scripts/parse-bank-doc.py --doc /tmp/doc.txt --check
node tests/integration.mjs http://127.0.0.1:3100   # 30/30
```
