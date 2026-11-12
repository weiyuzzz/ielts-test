# Issue 清单与同步

这里的正文与仓库代码一一对应，改代码时顺手改这里，随 PR 一起审阅。

GitHub 上原本只有 1 个 issue（Phase 1 音频改造跟踪），它把「已修复 / 未验证 / 并行冲突 / 验收清单」
混在一条里。并行冲突已经解决、代码已合入 `main`，所以**旧 issue 已删除，按「一件事一条」拆成 6 条**。

## 当前状态（2026-11-12 已同步）

旧 #1 已通过 GraphQL `deleteIssue` 删除（访问返回 410），新 issue 编号 **#2–#7**：

| # | 标题 | 标签 | 文件 |
|---|---|---|---|
| 2 | [Voice] 预置考官音频通路实际未启用（题库无 audio 字段） | voice, bug | `new-01-preset-audio-path.md` |
| 3 | [Voice] Azure / OpenAI 未实机验证，默认音色未定 | voice, help wanted | `new-02-provider-verification.md` |
| 4 | [Scoring] 0–9 分档描述符缺失，AI 评分只有关键指标 | scoring, help wanted | `new-03-band-descriptors.md` |
| 5 | [Content] 题库素材未导入 + shadowing 缺失 | content, enhancement | `new-04-bank-media.md` |
| 6 | [Speaking][Phase 1] 浏览器手工验收与真实设备回归 | voice, test, help wanted | `new-05-phase1-browser.md` |
| 7 | [Infra] 缺少 CI；提交身份与部署约束 | infra, enhancement | `new-06-ci.md` |

## 旧 issue 的去向

| 旧 | 内容 | 去向 |
|---|---|---|
| #1 [Speaking][Phase 1] 音频性能改造 | 已修复（调度器 / 生命周期 / 录音会话 / complete-answer / metrics） | 已合并进 `main`（`80d58a2`），记录见 `docs/phase2-examiner-voice.md` |
| 同上 | 并行冲突（`exam-runner` / `exam-service` / `architecture`） | **已解决**，三个文件全部合入 |
| 同上 | 浏览器 BROWSER-ONLY 待验证 | → #6 |
| 同上 | 设计权衡（LRU 单进程 / finish 独立请求 / ScriptProcessor 回退） | → #7 第三节 |

## 排序理由

编号越小越接近「功能实际不可用」：#2 是死代码，#3 让自然度结论悬空；#4–#5 是能力缺口；
#6–#7 更偏工程质量。

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
