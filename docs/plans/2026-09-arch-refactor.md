# 架构重构：前后端分离 + 契约驱动 + 明确性能目标

日期：2026-09-30　状态：已批准，实施中　类型：架构重构（多阶段）

## 1. 背景与根因

摸底结论：api 6.2 万行（325 源文件）、web 2.9 万行、shared 1.7 万行。所有坏味道归到 4 条根因：

| # | 根因 | 症状 |
|---|------|------|
| R1 | **同一事实写两份**（契约无正本） | 前端 `api/*.ts` 手抄 70+ interface，后端改字段前端编译不报错；`/api/docs` 指向不存在的 openapi.yaml（死链） |
| R2 | **HTTP 边界无强制** | 响应格式三套并存（`{data}` / `{success,data}` / 裸实体，289 处 `res.json`）；零校验库，手写 `if (!title) return 400` 散落；错误格式 4 种变体 |
| R3 | **模块无边界** | 20+ 个模块级循环依赖环，agents（15,290 行超级域）和 workunit 是两个引力中心，跨模块直接 import 内部文件，route-registry 靠动态 import 压环 |
| R4 | **存储无边界** | 88 个文件直接 `new FileStore()`（29 处模块级单例），十余个模块绕过 FileStore 直接 fs 读写数据区 |

框架（Express）不是根因。换框架 = 重抄 6 万行代码而边界问题原样保留。**不换框架，Express 4 → 5**（原生兜 async 错误，拆掉 `index.ts:451` 的 monkey-patch）。

## 2. 目标架构

```
apps/web ──────────────┐
   React 19 + zustand  │  import 类型 + zod schema（编译期保证）
   api client（薄）     │
                       ▼
        packages/studio-contract  ← 唯一契约正本
          zod schema（请求/响应/错误/分页 envelope）
          ├─ 推 TS 类型 → 前后端共用
          ├─ 后端中间件做运行时校验
          └─ 可导出 OpenAPI 文档（派生物，非正本）
                       ▲
apps/api ──────────────┘
   Express 5
   bootstrap/     启动编排从 index.ts 拆出（按域一个文件）
   modules/<域>/  每域强制三段式：
     ├─ index.ts     公共出口（唯一允许被跨模块 import 的文件）
     ├─ routes.ts    只做 HTTP 翻译：契约校验 → 调 service → 统一 envelope
     └─ service.ts   业务逻辑
   core/
     ├─ http.ts      统一 envelope / 错误映射 / zod 校验中间件（唯一出口）
     └─ store.ts     FileStore 唯一获取口（注入，禁模块级单例）
```

硬规则（用 lint 固化，不靠自律）：

- 跨模块只允许 import 对方 `index.ts`；禁深路径 import → 循环依赖环显形并逐个拆除
- `new FileStore()` 只允许出现在 `core/store.ts`；禁模块直接 fs 写数据区
- routes.ts 禁出现业务逻辑（只允许：校验 → service → envelope）
- 前端禁手抄 API 响应类型

agents 超级域拆法：loop / monitor / auditor / ops / knowledge 五个子系统各自提升为独立模块，各自定义 `index.ts` 公共面，环从圆心开始拆。

## 3. 性能目标

基线先行：Phase 0 跑基线落 `docs/architecture/performance-baseline.md`，再签收目标。建议目标（基线出来后校准）：

- API 读端点 p95 < 100ms，写端点 p95 < 300ms
- SSE 事件从产生到推送 p95 < 200ms
- 冷启动：tsx 形态实测基线 24–48s（见 performance-baseline.md），< 3s 对 tsx 不现实。口径改为两档——「端口可服务时间」与「全量就绪时间」（Phase 2 bootstrap 拆分后分别度量）；目标：端口可服务 < 10s，构建产物（node dist）全量就绪 < 3s
- 前端首屏 LCP < 2s；单页面 JS chunk < 500KB（gzip）
- ship 前跑基线对比，回归 > 20% 报警

## 4. 分阶段实施

### Phase 0：基线与目标文档

- 跑性能基线 → `docs/architecture/performance-baseline.md`
- 目标架构落字 → `docs/architecture/target-architecture.md`，更新 CONTEXT.md
- 删除死物：`apps/api/data.db` 残骸、`/api/docs` 死链、`app.ts:131` 失效 SPA 路径、`apps/web/src/types.ts`（226 行零引用死代码）

### Phase 1：契约层 packages/studio-contract（核心，~40% 工作量）

1. 建包 `packages/studio-contract`：按域一个文件，zod schema 定义请求/响应；`envelope.ts` 统一响应壳 `{ data } | { error: { code, message } }` + 分页壳
2. 后端 `apps/api/src/core/http.ts` 提供 `defineRoute(schema, handler)`：校验 req、包 envelope、统一错误映射（消灭 `msg.includes('not found')` 字符串嗅探）
3. 域迁移顺序（先引力中心，每域一个 commit）：workunit → channels → agents → pmo → requirements → 其余域。每域：写 contract schema → routes 改走 `defineRoute` → 删手抄校验 → 前端 `api/<域>.ts` 删本地 interface 改 import contract 类型
4. Express 4 → 5 升级随 Phase 1 做（删 monkey-patch）
5. 验证：每域迁移后跑该域测试 + 路由级测试；前端 typecheck

### Phase 2：后端边界收口（~35%）

1. `core/store.ts` FileStore 注入口，88 处直连逐个收口
2. 每模块补 `index.ts` 公共出口；eslint 边界规则禁深 import → 环逐个拆（agents↔channels、agents↔workunit 等 10 组互耦对优先）
3. 拆 agents 超级域：loop/monitor/auditor/ops/knowledge 提升为顶层模块
4. `index.ts` 590 行 → `bootstrap/` 目录
5. 直用 fs 写数据区的模块（evolution/skills/triggers 等）收进 FileStore 或显式 store 模块
6. 鉴权统一走 route-registry 声明式，删路由内自行 `requireAuth()`

### Phase 3：前端收口（~20%）

1. `api/index.ts` 杂物间拆分：axios 实例/拦截器独立成 `client.ts`
2. `api/*.ts` 70+ 手抄 interface 全部换成 contract import；lint 防回潮
3. 数据获取双轨统一：KnowledgePage/MonitoringPage/ProjectDetailPage 收进 SSE→store 范式或明确的"拉取页"模式（二选一，写进 CONTEXT.md）
4. 拆 ChannelDetailPage（703 行 + 45 个测试文件）
5. E2E 配置三份合一，删孤儿 `tests/e2e/gen-005.spec.ts`

### Phase 4：性能验证与文档（~5%）

- 性能基线对比，确认达标
- 从 contract 导出 OpenAPI 文档挂 `/api/docs`（死链复活成真的）
- 更新 CONTEXT.md / CAPABILITIES.md / AGENTS.md 涉及条目

## 5. 关键决策

1. **契约 = zod 共享包**，不是 OpenAPI-first：前后端同语言同仓，契约正本就应是一份两边 import 的 TS 代码；OpenAPI 只做派生物
2. **留 Express 升 5**：框架不是根因，边界才是
3. **硬规则用 lint 固化**：现状 20+ 循环依赖环就是自律失败的证据
4. **分阶段**，每 Phase 独立可交付、测试保持绿；域迁移按引力中心优先

## 6. 非目标

- 不换后端框架、不引入 tRPC/ts-rest、不重写前端框架
- 不动 `~/.studio` 数据区布局（冻结契约）和 FileStore 存储引擎本身
- 不动 packages 六包划分（studio-contract 是唯一新增包）
- 不追求一次消灭所有巨型文件（agent-loop.ts 1880 行等留到边界清晰后按域单独治理）
