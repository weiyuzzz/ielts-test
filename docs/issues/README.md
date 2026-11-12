# Issue 清单与同步

这里的正文与仓库代码一一对应，改代码时顺手改这里，随 PR 一起审阅。

GitHub 上原本只有 1 个 issue（Phase 1 音频改造跟踪），它把「已修复 / 未验证 / 并行冲突 / 验收清单」
混在一条里。并行冲突已经解决、代码已合入 `main`，所以**旧 issue 已删除，按「一件事一条」拆成 6 条**。

## 当前状态（2026-11-13 更新）

| # | 标题 | 标签 | 状态 | 归属 |
|---|---|---|---|---|
| 2 | [Voice] 预置考官音频通路实际未启用 | voice, bug | ✅ closed（PR #9） | → 资源缺口见 #11 |
| 3 | [Voice] Azure / OpenAI 未实机验证，默认音色未定 | voice, help wanted | open（需密钥，本机无法验证） | Phase 2 遗留 |
| 4 | [Scoring] 0–9 分档描述符缺失 | scoring, help wanted | open（PR #8 进行中） | 评分 Agent |
| 5 | [Content] 题库素材未导入 + shadowing 缺失 | content, enhancement | ✅ closed（PR #9） | → 内容缺口见 #12 |
| 6 | [Speaking][Phase 1] 浏览器手工验收与真实设备回归 | voice, test, help wanted | open（需真人操作） | Phase 1 遗留 |
| 7 | [Infra] 缺少 CI；提交身份与部署约束 | infra, enhancement | open（PR #8 进行中） | 评分/CI Agent |
| 10 | [Scoring] 评分依据无法落库（`descriptor_refs` 接口需求） | scoring | open | 评分 Agent 提出，等 Schema 负责人 |
| 11 | [Content/Voice] 考官音频资源缺口：0/508 | voice, content, help wanted | open（需授权/录制） | Phase 3 衍生 |
| 12 | [Content] 学习素材生产缺口：502 题无答案、0 条审核 | content, help wanted | open（需人工写作+审核） | Phase 3 衍生 |

PR：#9（`feat/phase3-question-learning`，学习素材 + Shadowing）、#8（`feat/phase3-scoring-ci`，分档判据 + CI）。两者均**未合并 main**。

草稿文件：`new-01`…`new-06` → #2–#7（其中 #2 / #5 已关闭），`new-07` → #11，`new-08` → #12。草稿标题与线上标题保持一致，`sync-issues.mjs` 才能按标题幂等跳过。

## 为什么 #2 / #5 被关闭而不是标为"部分完成"

两条 issue 的**标题所陈述的技术事实**都已不成立：

- #2：「导入不写音频字段、preset 分支是死代码」→ 现已写字段、有校验、后台可见覆盖率。
- #5：「`grep -rn shadow src` 为空」→ Shadowing 已实现并有页面。

但**资源与内容仍然缺**（音频 0/508、素材 6/508）。把「代码完成」和「素材未获得」继续挂在同一条 issue 里，会让状态永远停在「进行中」，所以拆成 #11 / #12 单独跟踪，并各给了可勾选的验收条件。

## 旧 issue 的去向

| 旧 | 内容 | 去向 |
|---|---|---|
| #1 [Speaking][Phase 1] 音频性能改造 | 已修复（调度器 / 生命周期 / 录音会话 / complete-answer / metrics） | 已合并进 `main`（`80d58a2`），记录见 `docs/phase2-examiner-voice.md` |
| 同上 | 并行冲突（`exam-runner` / `exam-service` / `architecture`） | **已解决**，三个文件全部合入 |
| 同上 | 浏览器 BROWSER-ONLY 待验证 | → #6 |
| 同上 | 设计权衡（LRU 单进程 / finish 独立请求 / ScriptProcessor 回退） | → #7 第三节 |
| #2 | 预置音频「通路未启用」 | 代码 → PR #9 已修；资源 → #11 |
| #5 | 题库素材 + shadowing | 体系与 Shadowing → PR #9；内容生产 → #12 |

## 排序理由

#11 / #12 是「功能已上线但缺料」，按体验影响排在最前；#3 让自然度结论悬空；#6 需真人操作；#4 / #7 由另一位 Agent 的 PR #8 推进；#10 是等 Schema 接口的阻塞项。

## 同步

```bash
# 预览解析结果，不写 GitHub
node scripts/sync-issues.mjs --dry-run

# 归档旧 issue #1 并创建缺失的 issue
GITHUB_TOKEN=ghp_xxx node scripts/sync-issues.mjs

# 只关闭不删除（GraphQL 删除失败时的自动降级，也可手动指定）
DELETE_OLD=0 GITHUB_TOKEN=ghp_xxx node scripts/sync-issues.mjs

# 跳过旧 issue，只创建新的
OLD_ISSUE=0 GITHUB_TOKEN=ghp_xxx node scripts/sync-issues.mjs
```

脚本幂等：标题已存在的跳过；标签不存在先创建（422 视为已存在）。

> GitHub REST 没有删除 issue 的接口，删除走 GraphQL `deleteIssue`（需要仓库 admin 权限）。
> 失败时自动降级为「关闭 + 标题加 `[已归档]` + 正文加归档说明」，不会丢历史。
