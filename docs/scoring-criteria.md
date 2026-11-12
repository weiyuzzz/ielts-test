# 雅思口语评分标准（整理版）

> 来源：腾讯文档《雅思口语 9-12 月题库【Part123】》→「考试评分标准-Criteria」小节。
> 本文只是把原文的四项评分依据与关键指标重新组织成可检索的结构，**没有新增判分规则**。
> 原文在该小节之后还有一张「0–9 分对应评分标准」表，但它是**图片**，文本层里没有内容，
> 因此本文件不包含分档描述符（见文末「缺什么」）。

## 一、评分依据：4 个标准

雅思口语按 9 个分数等级评定，评分依据四个维度，四项权重相同：

| 代号 | 维度 | 英文 |
|---|---|---|
| FC | 流利度与连贯性 | Fluency and Coherence |
| LR | 词汇资源 | Lexical Resource |
| GRA | 语法范围与准确性 | Grammatical Range and Accuracy |
| P | 发音 | Pronunciation |

本项目的评分模块用的就是这四个代号（`src/lib/speaking/scoring.ts`），四项各占 25%，
缺任意一项时不产生总分——这与「四项权重相同」一致。

## 二、流利度与连贯性（FC）

**考察什么**：能否以正常的语速、连贯性和较小的表达负担讲话，并把想法与语言有效连接，
形成连贯、有逻辑的表达。

**流利度的关键指标**

- **语速（speech rate）**：理想情况下不应过慢，否则难以在脑中维持词与句之间的连接。
- **表达连续性（speech continuity）**：表达应保持流畅，不应频繁被下列情况打断：
  - 反复重启句子（false starts）
  - 回退修改（backtracking）
  - 无意义的重复（functionless repetition）
  - 频繁停顿找词（pausing to search for words）

**连贯性的关键指标**

- **逻辑顺序**（logical sequencing of spoken sentences）
- **结构标记清晰**（clear marking）：用合理停顿、话语标记（连接词、填充词）标出讲话结构，
  例如讨论、叙述、论证的不同阶段
- **内容相关性**（relevance）：每句话都应服务于当前发言的整体目的
- **衔接手段**（cohesive devices）：句内与句间的逻辑连接词（however、because 等）、代词、连词

## 三、词汇资源（LR）

**考察什么**：可使用的词汇范围，它影响三件事——能讨论的话题范围、表达意义的准确性、
态度表达的清晰程度。

**关键指标**

- **词汇多样性**（variety of words used）
- **词汇的充分性与恰当性**（adequacy & appropriacy），包含：
  - 指称意义（referential meaning）：能否准确表达事物与概念
  - 语体（style）：正式 / 非正式是否合适
  - 搭配（collocation）：含习语表达是否自然
  - 态度表达（attitude）：能否表达赞同、中立或反对
- **同义替换能力**（paraphrase ability）：词汇不够时能否换一种说法，允许有或没有明显停顿

## 四、语法范围与准确性（GRA）

**考察什么**：能否准确、恰当地使用句法结构满足口语考试要求，同时看语法资源是否丰富。

**范围的关键指标**

- 口语句子的长度（length of spoken sentences）
- 从句的恰当使用（appropriate use of subordinate clauses）
- 动词短语的复杂性（complexity of the verb phrase）：进行时 / 完成时、情态、被动语态
- 其他短语的复杂性（complexity of other phrases）：前置修饰与后置修饰
- 句型结构多样性（range of sentence structures）：为突出信息重点而调整成分位置

**准确性的关键指标**

- **错误密度**（error density）：一定话语量中语法错误的数量
- **错误的交际影响**（communicative effect of error）：错误是否影响理解、清晰度或准确性

## 五、发音（P）

**考察什么**：能否准确且持续地使用多种语音特征，把有意义的信息清晰地传达出去。

**关键指标**

- 把语音切分为有意义的表达单元：句内自然分段（chunking）
- 节奏与重音（rhythm & stress timing）、连读（linking）：连音、弱读、省音（elision）
- 重音与语调（stress & intonation）：强调重点（emphatic）或对比（contrastive）
- 发音准确性（sound production）：单词重音（word stress）、元音与辅音（vowel & consonant）
- 听者理解所需付出的努力（是否费劲）
- 口音对理解的整体影响（accent intelligibility）

## 六、这份整理能干什么、不能干什么

**能**：

- 作为写作/练习时的自检清单：每个维度下列出的指标就是「考官在听什么」。
- 与本项目报告页的四项维度一一对应，便于把扣分点落到具体指标上。

**不能**：

- **不能当分档描述符用**。0–9 分每一档的原文在文档里是图片，文本层没有，我们不能凭空补。
  项目里 `descriptor_refs` 仍是空的（见 issue #4）。
- **不能据此生成分数**。指标是描述性的，不是阈值。本项目在没有接入 LLM 评分时一律输出
  `unscored`，不会用「关键词覆盖率」之类的代理指标冒充 band。
- 原文档为第三方整理内容，本文件仅作内部学习参考，不对外宣称官方口径；官方标准以
  IELTS 官网与《Official IELTS Practice Materials》为准。

## 附：与题库学习素材的衔接

题库素材里的「思路速记 / 语料扩展」按上述维度组织：

| 评分维度 | 对应的学习素材 |
|---|---|
| FC | 思路速记的段落顺序、连接词（Note 里的 but / so / when 说明） |
| LR | 语料扩展（同义表达、搭配）、关键词速记 |
| GRA | 示范答案里的从句与复杂结构（Note 里的 `I don't need to…`、`what really struck me is…`） |
| P | 跟读（Shadowing）与逐段 TTS，用于节奏、重音与连读的模仿 |

素材本身是**练习资料**，不是评分依据；`/speaking/questions` 与练习页都按这个定位标注。
