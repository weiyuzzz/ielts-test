# 目标产品概览：爱听写 IELTS Speaking Mock（/ielts/speak-mock）

> 标注说明：**[VERIFIED]** = 我们用 REA 静态分析或直接 HTTP 获取的公开资源中有明确证据；**[INFERRED]** = 根据间接证据推断；**[UNKNOWN]** = 当前条件下无法确认。
> 证据清单：`evidence/rea-static-analysis-manifest.json`（REA evidence_id `ev_075420e8…77e0`）。

## 1. 调查方式与边界（重要）

| 项 | 状态 |
|---|---|
| REA 是否预装 | 否。沙箱里没有全局 `rea`，也没有 MCP 客户端配置 |
| REA 获取方式 | `npx -y rea-agents@latest`（v6.8.0）。没有做全局安装，也**没有改动任何 Agent 配置** |
| `rea doctor` | Node 22 / Debian 12 正常；Hopper/Ghidra/IDA/JADX 缺失（只有原生二进制分析需要，本项目不涉及） |
| 浏览器 / CDP | **沙箱里没有 Chrome/Chromium，也没有麦克风和摄像头**，所以 REA 的 Browser & Runtime Observation、Network Request Observation、Runtime Behavior Comparison **都没法执行** |
| 实际用到的 REA 能力 | JavaScript Application Inspection + Script Source Inspection：匿名 HTTPS GET 获取公开 JS 资源（入口 `index-3abb4774.js`，以及 `speaking-mock-*`、`speak-evaluation-*` 共 6 个文件），然后跑 `rea analyze-javascript-application`，得到 1073 个节点、1247 条边、102 个 endpoint 节点、3 个 storage 节点 |
| 未做的事 | 没登录，没绕过任何鉴权，没获取 Token/Cookie/用户音频，没调用目标站点的私有 API |

因此本报告的结论分两类：一类是**代码路径层面的已验证事实**（"代码会这样做"），另一类是**运行时层面的未知项**（"线上实际返回了什么"）。后者在 `evidence-and-unknowns.md` 里给出了需要用户在本机执行的 REA CDP 观察步骤。

## 2. 技术栈
- [VERIFIED] 前端是 Vite 构建的 Vue 3 SPA：入口 HTML 引用 `/assets/index-*.js`，带 `__vite_is_modern_browser` legacy 检测，组件里有 `__scopeId`/`data-v-*` 痕迹。
- [VERIFIED] 用 Tailwind 类名做样式（例如 `part2-cue-canvas … border-r border-black/5 bg-white`）。
- [VERIFIED] 接入了 GA4、百度统计、Microsoft Clarity；Clarity 会用 sessionStorage 里的 `user.phone_number` 做 identify（入口 HTML 内联脚本）。

## 3. 路由（REA route endpoint 节点）
- [VERIFIED] `/ielts`、`speak-mock`、`speak-mock/result`、`speak/:type`、`/philippine-speaking`，另有 `/ielts/read/`、`/ielts/write/`、`/ielts/v2/` 等。
- [INFERRED] `speak/:type` 是按 Part 划分的单题练习页，复用 `speak-evaluation` 组件（模考结果页会链接到 `/ielts/speak/`）。

## 4. 页面结构图（根据代码中的状态字段与模板重建）
```
/ielts/speak-mock
├── 开始确认对话框（"请准备好纸笔（Part 2 需要）" + 开启视频开关 + 全屏）   [VERIFIED]
├── 考试主界面
│   ├── 顶部：Part 指示 / 倒计时 countdown/countdownTotal / 录音状态红点 [VERIFIED]
│   ├── 考官区：isExaminerSpeaking；可开关字幕 speaking_mock_show_subtitles [VERIFIED]
│   ├── 题干区：displayQuestion / displayPrompts（Part 2 题卡 part2-cue-canvas）[VERIFIED]
│   ├── 摄像头预览（只用于模拟，文案为"不会录制"）                         [VERIFIED]
│   └── "提前结束本题"（canFinishCurrentStep，作答 ≥ minFinish=5s 后出现） [VERIFIED]
└── 完成后 → /ielts/speak-mock/result                                    [VERIFIED]
/ielts/speak-mock/result
└── 按话题汇总分数（speaking-mock-topic-score），可跳转到单题练习详情     [VERIFIED]
```
- [UNKNOWN] 移动端的具体交互差异。代码里有 `sm:` 响应式类，viewport 禁止缩放，但没有真机或浏览器观察。

## 5. 功能总结
1. 完整模考：固定脚本驱动，三个 Part 串行。
2. 单题练习（speak/:type）：录音、实时转写、发音评测、语法纠错、话题笔记。
3. 结果页：按话题和题目汇总；四项维度中 **FC 与 Pronunciation 来自 "evaluation"（语音评测 SDK），LR 与 GRA 来自 "correction"（文本纠错）**。[VERIFIED]

## 6. 可借鉴 vs 我们改进的点
| 目标产品 | 我们的设计 |
|---|---|
| 会话状态只存在 sessionStorage，音频 Blob 不持久化 | 服务端权威状态机 + 数据库持久化，刷新后可以恢复 |
| 考官为固定脚本，没有 LLM | 固定流程控制 + 可选 LLM 生成考官话术和 Part 3 追问（由状态机限定） |
| 发音评分依赖第三方 SDK | Pronunciation 走可替换的 Provider；没有音频评测时明确标注"未评估" |
| 题库为站方内容 | 自编原创题库 |
