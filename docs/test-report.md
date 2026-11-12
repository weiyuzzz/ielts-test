# 测试报告

运行环境：沙箱 Node 22 + PostgreSQL，生产构建（`next build` + `next start`）。Provider 配置：ASR=browser-web-speech，LLM=none，TTS=browser，Pronunciation=none（沙箱里没有 API Key）。

## 1. 单元测试 `npx tsx --test tests/unit.test.ts` → **18/18 通过**
覆盖：状态机（当前步骤校验、模考禁止重答、练习允许重录、陈旧 advance、Part 3 追问规则、沉默不追问、追问上限、Part 1/2 不追问、重复上限、结束条件）、配置、IELTS 取整、指标、评分测试集、语法规则误报、LLM 输出校验（无效 JSON、缺失维度、越界分数、捏造引用被丢弃）、Provider 超时、追问净化、MIME 协商（Chrome/Safari/不支持/抛异常）、WAV 编码。

**测试发现并修复的真实缺陷**
1. `withTimeout` 先 abort 再 reject，导致 Provider 的 "aborted" 错误先赢得竞争，超时无法被正确分类（LLM/ASR/TTS 超时场景）。已修复。
2. 启发式评分校准问题：MATTR 在短回答上饱和，导致中等水平的 LR 被打到 9；多项惩罚叠加，导致弱考生的 FC 被打到 0。已重新校准。

**评分测试集（三档模拟回答，各 4 题）**，启发式评分器的实际输出：
| 档次 | FC | LR | GRA |
|---|---|---|---|
| LOW（简短、填充词多、含语法错误） | 2 | 4.5 | 2.5 |
| MID（完整、简单连接） | 6 | 7 | 6 |
| HIGH（复杂句、高级词汇） | 6.5 | 8.5 | 7 |

分数随水平单调递增；高水平和中等样本上语法规则 0 误报；跨题没有重复的发现。已知局限：LR 对长词比例比较敏感（MID 的 7 略高），所以报告中始终标注 heuristic，只作粗略估计。

## 2. 端到端 API 测试 `node tests/integration.mjs` → **22/22 通过**
输入为合成 WAV 加上提供的转写文本（模拟浏览器 ASR 路径），用来驱动真实的数据库和评分管线。
- 正常完成完整模考（P1→P2→P3），Part 3 短回答插入了追问（generator=template），step_index 保持连续
- 越序作答 409；未作答就 advance 409；重复提交同一 idempotency key 返回同一 answerId；重复 advance、重复 finish 均幂等
- 用户沉默（0.5s）记为 `no_response`；全程沉默的考试评分为 **failed** 且 overall=null（不编造分数）
- 报告包含 4 个维度；P 为 `not_assessed`，isComplete=false；包含 promptVersion；实测 overall 6.5（FC 4.5 / LR 8 / GRA 6.5，heuristic；LR 是重新校准前的结果）
- Range 请求返回 206（Safari 回放）；跨用户访问 404；重新评分会新建评估记录
- 练习重录 attempt=2；abandon 之后作答 409；"刷新"后从服务端恢复 current_step；非音频上传 415

## 3. 未能在沙箱中实测的场景（如实说明）
| 场景 | 状态 | 说明 |
|---|---|---|
| 真实麦克风授权成功/失败、录音中切换设备、Chrome/Safari 实机 | **未实测** | 沙箱里没有浏览器和音频设备。代码层面：权限错误分类（permission_denied/no_device/insecure）、track `ended` → device_disconnected、MIME 协商（单测已覆盖）、阻塞面板可重新选择设备 |
| 上传失败重试、断网 | 部分 | 重试逻辑已实现（指数退避，等待 online 事件，用同一 idempotency key）；服务端幂等已由集成测试验证；浏览器断网没有实测 |
| LLM/ASR/TTS 真实调用、无效 JSON、超时 | 部分 | 校验、超时和回退逻辑已有单测；没有 Key，无法调用真实服务 |
| 音频过大 | 部分 | 服务端 413 和客户端尺寸检查已实现；没有构造 24MB 文件测试 |

建议在有浏览器的机器上执行：Chrome 和 Safari 各完成一次 Part 1 练习和一次完整模考，并记录结果。
