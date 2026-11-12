# AI 考官行为分析

## 结论：脚本驱动的问答系统，不是 LLM 动态考官
- [VERIFIED] 考官话术 = 18 条固定脚本（`fixed-audio-scripts.txt`，预录 MP3）+ 7 条动态模板（`dynamic-templates.txt`，变量只有 `[Part 2 topic]`、`[subtopic]` 这类话题名）+ 题库题目。
- [VERIFIED] 编排是固定的 await 链：`intro → opening → verification → part1 → part2 → part3 → end`。不读取用户回答内容，也没有分支。
- [VERIFIED] Part 1 每题后的反馈从 `08_feedback_ok` / `09_feedback_right` / `10_feedback_thank_you` 中选。[INFERRED] 轮换或随机选择，与回答内容无关。
- [VERIFIED] 问候语根据 `new Date().getHours()<12` 选择 morning/afternoon。
- [VERIFIED] 模考 chunk 中**不存在**任何 chat/completion/LLM 请求。

## 逐项回答
| 问题 | 结论 |
|---|---|
| 固定话术？ | [VERIFIED] 是 |
| 上下文记忆？ | [VERIFIED] 没有（除了 Part 2/3 共享话题） |
| 回答影响下一题？ | [VERIFIED] 不影响 |
| 可以要求重复？ | [UNKNOWN] 流程中没有 repeat 分支；[INFERRED] 不支持 |
| 异常回答处理？ | [VERIFIED] 没有基于内容的处理；超时到点就自动进入下一题 |
| 空白回答识别？ | [INFERRED] 不在考试过程中识别；评测时可能因 `no-score` 失败 |
| 时间管理？ | [VERIFIED] 每题有硬性时长上限，作答 5s 后允许提前结束 |

## 对比实验（简短/长/偏题/无意义回答）
[UNKNOWN] 没有执行。需要真实浏览器、麦克风和可能的登录态。不过静态代码已经证明流程中没有基于回答的分支，所以这类实验预期只会影响评分，不会影响考官行为。实验步骤见 `evidence-and-unknowns.md`。

## 对我们设计的影响
我们保留"状态机严格控制流程"这一优点，在状态机允许的节点（仅 Part 3）引入 LLM 生成的追问，并设置次数上限。没有 LLM 时降级为模板追问，并在数据库里记录 `generator=template|llm`。
