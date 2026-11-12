# 评分报告逆向

## 1. 维度来源 [VERIFIED]
结果组件中的维度定义：
```
fluency                    流利度&连贯性   source: evaluation
pron                       发音            source: evaluation
lexical_resource           词汇丰富度      source: correction
grammatical_range_accuracy 语法准确度      source: correction
```
- 也就是说 **FC 和 Pronunciation 都来自音频评测 SDK**（`en.pred.score`），**LR 和 GRA 来自文本纠错服务**。
- [INFERRED] FC 由发音引擎的 fluency 子分（语速、停顿）映射而来，**没有对连贯性（逻辑、衔接）做文本分析**。这是目标产品的一个局限。
- [VERIFIED] 总分回退逻辑：`speaking_score` 落在 5–8 之间时直接使用，否则默认显示 **6.5**。这说明在缺分情况下界面会显示占位分数。

## 2. 报告内容
| 项 | 结论 |
|---|---|
| 整体 Band | [VERIFIED] 有（`speaking_score`，带回退逻辑） |
| 四项分数 | [VERIFIED] 有，但来源不同（见上） |
| 逐题评分 | [VERIFIED] `speaking-mock-topic-score`，按题目/话题展示 `practiceResult` |
| 逐句语法纠错 | [VERIFIED] `correction-diff`（原句/修改后 diff） |
| 发音问题定位 | [VERIFIED] 音素级 `phoneme-progress`，以及词级 `speak-aligned-word` |
| 更自然表达 | [VERIFIED] 题目附带 `band_6_0`/`band_7_0` 范例（这是**题库预置**的范文，不是针对用户回答生成的） |
| 转录文本 | [VERIFIED] `speak-transcript__plain` |
| 回放录音 | [VERIFIED] `localAudioUrl/oss_url/cloudAudioUrl` |
| 学习建议 | [UNKNOWN] |

## 3. 评分逻辑判断
- 语言分析：基于转写文本（correction）。
- 发音：基于音频（SDK，音素级）。
- 综合：[UNKNOWN] 总分的计算公式。代码只消费后端给出的 `speaking_score`。
- [UNKNOWN] 多组不同水平回答的评分差异。需要运行时实验，未执行。

## 4. 我们的改进
- FC 同时使用音频时间特征（语速、停顿，来自 ASR 时间戳）和文本连贯性分析。
- 不使用"默认 6.5"这类占位分数；缺失的维度直接显示为缺失，总分只按可用维度计算，并标注"不完整"。
- 改写建议针对用户实际句子生成，而不是只给范文。
