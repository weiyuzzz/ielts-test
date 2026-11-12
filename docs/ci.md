# CI（GitHub Actions）

> 对应 issue **#7**。文件：`.github/workflows/ci.yml`。

## 1. 触发

- `push` 到 `main`
- 任何 `pull_request`
- 手动 `workflow_dispatch`

同一分支的新提交会取消上一次运行（`concurrency.cancel-in-progress`）。

## 2. Job A — Static / Unit / Build

不依赖数据库，几十秒到一两分钟出结果：

```bash
npm ci
npx next typegen            # 必须先跑，见下
npm run typecheck           # tsc --noEmit
npm run lint                # eslint .
npx tsx --test tests/unit.test.ts          # 30
npx tsx --test tests/audio-perf.test.ts    # 24
npx tsx --test tests/scoring-rubric.test.ts # 14
npm run build
```

### 为什么必须先 `next typegen`

`RouteContext` / `PageProps` 是 Next 16 **生成**的全局类型（`.next/types`）。
不生成就跑 `tsc`，会看到 7 个「Cannot find name」假错误 —— 这不是代码问题。
`next build` 内部会生成，但 `npm run typecheck` 不会，所以 CI 显式先跑一次。

### 为什么 build 需要 `DATABASE_URL`

`src/db/index.ts` 在模块加载时就 `throw new Error("DATABASE_URL is required")`（只是检查变量存在，
`new Pool()` 是惰性的，不会连接）。生产构建会 import 所有路由模块，因此必须让变量存在。

Job A 里给的是一个**占位 URL**：

```yaml
env:
  DATABASE_URL: postgresql://build:build@127.0.0.1:5432/build
```

这样做是安全的：所有会查库的页面都标了 `export const dynamic = "force-dynamic"`，
构建期不会真的建立连接；只有 `listening` / `reading` / `writing` 三个静态页不碰数据库。

> 如果将来新增了在构建期查询数据库的页面，Job A 会失败 —— 这是有意的信号，
> 此时应该把该页面标成 dynamic，而不是在 CI 里塞一个真数据库。

## 3. Job B — Integration (PostgreSQL 16)

真实数据库 + 生产服务 + 端到端脚本：

```yaml
services:
  postgres:
    image: postgres:16
    env: { POSTGRES_USER: ci, POSTGRES_PASSWORD: ci, POSTGRES_DB: ielts_test }
    ports: ["5432:5432"]
    options: --health-cmd "pg_isready -U ci -d ielts_test" ...
```

步骤：

```bash
npm ci
npx next typegen
npx drizzle-kit push --url="$DATABASE_URL" --force   # 建表
npm run build
npx next start -p 3100 &                              # 生产服务
# 轮询 /api/health 直到 200（最多 120s）
node tests/integration.mjs http://localhost:3100      # 30 项
```

### 为什么用 `--url`

`drizzle.config.json` 里硬编码了本地连接串（`postgresql://postgres:postgres@127.0.0.1:5432/ielts_platform`），
**不读 `DATABASE_URL`**。`drizzle-kit push --url=...` 可以覆盖它，
这样 CI 不需要修改共享配置文件。

> 建议后续把 `drizzle.config.json` 换成读取 `process.env.DATABASE_URL` 的 `drizzle.config.ts`，
> 但这属于共享配置，本次未改（见 issue #7 第三节）。

### 为什么不做付费调用

`tests/integration.mjs` 里的 TTS 检查只在 `TTS_PROVIDER=server` 时执行；
CI 不配置任何 API Key，因此自动 `SKIP`。LLM 评分同样不会被调用，
无 AI 时流程落 `unscored`（不伪造分数），这本身也是被测行为。

## 4. 本地复现

```bash
# Job A
npm ci
npx next typegen && npm run typecheck && npm run lint
npx tsx --test tests/unit.test.ts
npx tsx --test tests/audio-perf.test.ts
npx tsx --test tests/scoring-rubric.test.ts
DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build npm run build

# Job B（需要本地 PostgreSQL）
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/ielts_platform
npx drizzle-kit push
npm run build && npx next start -p 3100 &
curl -fsS http://localhost:3100/api/health
node tests/integration.mjs http://localhost:3100
```

## 5. 已知约束 / 后续

- **`main` 需要开启 required checks**，否则 CI 只是「提示」而不是门禁（issue #7 验收项）。
- 提交身份仍是 `Admin <admin@localhost>`，GitHub 上看不到归属；改写需要 force push，
  属可选操作（issue #7 第二节）。
- 本地 `github.com` 的 git-over-HTTPS 在部分网络下被代理拦截（CONNECT 502），
  但 GitHub Actions 运行在 GitHub 内网，不受影响。
- 本次工作环境**没有 PostgreSQL**，因此 Job B 的 30 项集成检查**未能在本地跑通**；
  只有 Job A 的全部检查在本地验证过。首次 PR 的 Actions 结果才是 Job B 的真实结论。
