# [Infra] 缺少 CI，并行开发靠人工合并；顺带处理提交身份与部署约束

<!-- labels: infra, enhancement -->

## 背景

这轮三个人并行改同一批文件（`exam-runner.tsx` / `speech.ts` / `tts/route.ts` / `exam-service.ts`），
合并没出事，是因为有人手工做了三次合并 + 全量回归。**这件事不该依赖人记得做。**

## 一、CI（主任务）

- 仓库没有 `.github/workflows/`（已确认不存在）。
- 检查项其实已经齐了，只是没自动化：

```bash
npm run typecheck                        # tsc --noEmit
npm run lint                             # eslint .
npx tsx --test tests/unit.test.ts        # 30
npx tsx --test tests/audio-perf.test.ts  # 24
npm run build
node tests/integration.mjs http://localhost:3100   # 30，需要 PostgreSQL
```

- 坑：必须先 `next typegen`，否则 `RouteContext` / `PageProps` 这类生成类型会让 `tsc` 报假错。
- 建议两个 job：静态+单测+build（快）；集成测试（postgres service → `drizzle-kit push` → `next start` → 跑脚本）。
- `main` 开启 required checks，从根上避免「三个分支各改一半」再手工合。

## 二、提交身份未关联 GitHub

历史提交作者是 `Admin <admin@localhost>`，GitHub 上看不到头像/归属。
可改写为 `weiyuzzz <108586793+weiyuzzz@users.noreply.github.com>`（需 force push，趁远程刚建、只有一人在用，风险最低）。
不做也不影响功能，属可选。

## 三、部署相关的已知约束（记录，不急着改）

| 约束 | 现状 | 影响 |
|---|---|---|
| 服务端 TTS 缓存是**进程内 LRU** | `src/lib/server/tts-cache.ts` | 多实例部署不共享，热门句会被重复合成 |
| `finish` 仍是独立请求 | 每题已省 2 次往返，最后一步保留 1 次 | 可接受，除非要压尾延迟 |
| Safari < 14.1 回退 `ScriptProcessorNode` | `recording-session.ts` 有降级 | 能用但非最优，已废弃 API |
| 无对象存储 | 音频落 `storage/` 本地盘 | 容器化/多实例时需要换 S3 兼容存储 |

## 验收

- PR 上出现 typecheck / lint / 两套单测 / build / 集成 五个检查
- 故意提交一个类型错误，CI 必须变红
- `main` 开启 required checks
- （可选）提交身份改写完成

## 来源

本 issue 承接已归档的 Phase 1 跟踪 issue 第六节与「设计权衡」部分。
