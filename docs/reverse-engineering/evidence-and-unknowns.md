# 证据、验证过程与未知项

## 1. 证据链
| # | 步骤 | 产物 |
|---|---|---|
| E1 | `curl https://www.idictation.cn/ielts/speak-mock`（匿名，HTTP 200，4225B） | 入口 HTML：Vite SPA、`/assets/index-3abb4774.js` |
| E2 | 从入口 bundle 的动态 import 映射中定位口语 chunk，匿名下载 | 6 个 JS 文件，sha256 记录在 manifest |
| E3 | `npx rea-agents@latest doctor` | Node 正常；原生引擎缺失（与本任务无关） |
| E4 | `rea analyze-javascript-application <dir> --json` | evidence_id `ev_075420e828f753c17c04748d8062d5c2adec06414d9b47473424f78eaacb77e0`；1073 nodes / 1247 edges / 102 endpoint / 3 storage |
| E5 | 对 REA 已收录的源码做定点检索（MediaRecorder、WebSocket、sampleRate、tts、phase 等），并统计各 chunk 的 API 出现次数 | 本目录各报告引用的常量与调用片段 |

## 2. 结论可信度
| 结论 | 等级 | 依据 |
|---|---|---|
| MediaRecorder MIME 协商列表 | VERIFIED | E5（`isTypeSupported` 列表） |
| 16k PCM ScriptProcessor 并行采集 | VERIFIED | E5 |
| 火山 bigmodel 流式 ASR（WebSocket） | VERIFIED（代码路径） | E5 常量与 `new WebSocket` |
| 发音 SDK `EngineEvaluat`、`en.pred.score` | VERIFIED（代码路径） | E5 |
| 考官为预录 TTS MP3（seed-tts-2.0） | VERIFIED | E5 配置对象 |
| 无 LLM 考官 | VERIFIED（在已获取的 chunk 范围内） | E5 检索为 0 |
| 时间配置 30/60/120/60/5/4 | VERIFIED | E5 |
| 会话保存在 sessionStorage，Blob 不持久 | VERIFIED | E4 storage 节点 + E5 |
| 刷新后无法恢复音频 | INFERRED | 由上一条推得 |
| 录音上传到 OSS | INFERRED | `oss_url` 字段 |
| 发音 SDK 供应商 | UNKNOWN | 只有命名特征 |
| 线上接口的实际请求/响应结构与耗时 | UNKNOWN | 没有 CDP 运行时观察 |
| 出分延迟、断网恢复、重复提交行为 | UNKNOWN | 同上 |
| 移动端交互差异 | UNKNOWN | 同上 |

> 注意：静态分析只能说明"代码包含这条路径"，不能说明"线上一定执行了这条路径"（可能有 feature flag 或配置开关）。所以上表的 VERIFIED 均指**代码层面已验证**。

## 3. 阻塞原因
1. 沙箱里没有 Chrome-family 浏览器，REA 的 CDP 观察无法连接。
2. 没有麦克风和摄像头设备，无法完成真实作答。
3. ASR 和评测凭证接口很可能需要登录态；本项目不会尝试绕过。

## 4. 需要用户在本机执行的 REA 运行时观察（下一步）
```bash
# 1) 使用独立 Profile 启动 Chrome（不影响日常浏览器）
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/rea-ielts-profile https://www.idictation.cn/ielts/speak-mock
# 2) 只授权目标源
export REA_BROWSER_OBSERVE_ENABLED=true
export REA_BROWSER_CDP_ENDPOINTS_JSON='["http://127.0.0.1:9222"]'
export REA_BROWSER_ALLOWED_ORIGINS_JSON='["https://www.idictation.cn"]'
npx rea-agents@latest list-browser-targets http://127.0.0.1:9222 --approved --json
npx rea-agents@latest inspect-web-page http://127.0.0.1:9222 <TARGET_ID> --approved --json
```
请用户依次手动完成以下操作，并在每个阶段各执行一次 inspect/capture（再用 `compare-web-captures` 对比）：
① 登录自己的账号 → ② 点击开始模考并授权麦克风 → ③ Part 1 正常作答一题，再沉默一题 → ④ Part 2 准备并作答 → ⑤ Part 3 分别给出简短、长、偏题、无意义回答 → ⑥ 等待跳转结果页并记录出分时间 → ⑦ 在 Part 1 中途刷新一次 → ⑧ 在 DevTools 中设置 Offline 后作答一题。
敏感值（Token、Cookie、手机号）在导出 evidence 前必须脱敏。
