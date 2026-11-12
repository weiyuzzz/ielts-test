# [Infra] 缺少 CI：typecheck / lint / 两套单测 / build / 集成测试全靠人工，PR 冲突只能靠人判断

<!-- labels: infra, enhancement -->

## 背景

这轮三个人并行改同一块代码（main 的倒计时、Phase 1 的音频调度、Phase 2 的语音表现），
三种改动都落在 `exam-runner.tsx` / `speech.ts` / `tts/route.ts` / `exam-service.ts` 上。

合并没有出事故，是因为有人手工做了三轮合并 + 全量回归。**这件事不该依赖人记得做。**

## 现状

- 仓库没有 `.github/workflows/`（已确认目录不存在）。
- 可用的检查其实已经很完整，只是没自动化：

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # eslint .
npx tsx --test tests/unit.test.ts        # 30 项
npx tsx --test tests/audio-perf.test.ts  # 24 项
npm run build
node tests/integration.mjs http://localhost:3100   # 30 项，需要 PostgreSQL
```

- 集成测试需要 DB（`DATABASE_URL`），CI 里用 services 起一个 postgres 即可。
- `next typegen` 必须先跑，否则 `RouteContext` / `PageProps` 这类生成类型会让 `tsc` 报假错（Phase 1 踩过）。

## 建议做法

1. `ci.yml`：Node 20 + postgres service → `npm ci` → `next typegen` → typecheck → lint → 两套单测 → build。
2. 集成测试单独 job：起 postgres → `drizzle-kit push` → `next start` → 跑 `tests/integration.mjs`。
3. PR 保护：以上全绿才允许合入 `main`，避免再次出现「三个分支各改一半」的手工合并。
4. 顺手修一件事：历史提交作者是 `Admin <admin@localhost>`，GitHub 上不关联账号，可改写为
   `weiyuzzz <108586793+weiyuzzz@users.noreply.github.com>`（需 force push，趁远程刚建风险最低）。

## 验收

- PR 上能看到 typecheck / lint / 单测 / build / 集成五个检查
- 故意提交一个类型错误，CI 必须变红
- `main` 开启 required checks
