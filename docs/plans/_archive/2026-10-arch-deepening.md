# 架构深化：strict 类型根基 + 契约收口 + 巨型文件治理 + 性能自动化

> 状态：Phase 1 已完成（2026-10-07，commit 62e48e90/95a31ca9/ac00fd34）；Phase 2–4 已起票（2026-10-08，见下）
> 前置：docs/plans/2026-09-arch-refactor.md（首轮架构重构，已收官）；目标架构正本 docs/architecture/target-architecture.md

## 定位

首轮「前后端分离 + 契约驱动 + 明确性能目标」已收官，本计划是**深化**，不新建方向、不换框架、不动数据区契约。

## 剩余缺口（2026-10-07 探针实测）

1. **类型根基**：全仓 tsconfig `strict: false`，z.infer 退化（字段全可选、判别联合失 narrowing），靠手写 interface + parity 测试兜底。探针实测全仓仅 ~60 个 strict 错误（contract/audit/notification/skill/shared = 0，spec = 1，agent = 3，api = 19，web = 37）。
2. **契约收口**：5 个 raw Express 路由未走 defineRoute（harness/discord/deploy-webhook/events-sse/knowledge）；SSE 事件负载无契约（web 本地解析器，ADR 2026-08-24 待落地核查）；typecheck 门只覆盖 4/8 包。
3. **巨型文件**：agent-loop.ts 1881 行、knowledge-service.ts 1228、file-store-messages.ts 1111、prompt-composer.ts 859、workunit.service.ts 780。
4. **性能自动化**：基线测量手工流程、无 CI 回归门；前端无 bundle 预算；已认证主应用 LCP 未测；warmup SessionSummary 首启 10.9s 阻塞事件循环。
5. **文档/现实缺口**：target-architecture.md 宣称循环依赖 lint 显形但 eslint 无 no-cycle 规则；根 package.json 依赖与 apps/api 重复且 express 版本漂移（^4 vs ^5.2.1）。

## 阶段划分

### Phase 1：类型根基 strict 化 + 门禁补齐（本轮）

- 全仓 tsconfig 翻 `strict: true`（根 + apps/api + apps/web + 7 包），删除 api 的逐项 false 覆写。
- 修 ~60 个 strict 错误，修法 = 补精确类型，禁止撒 `any`/`as` 压制。
- typecheck 门（bin/tsc-gate.js + 根 typecheck script）扩到全部 8 个目标（补 studio-contract 等 4 包）。
- 根 package.json 依赖收敛（与 apps/api 去重，消除 express ^4/^5 漂移；验证 build-npm 产物）。
- 文档同步：target-architecture.md 落地状态、studio-contract CONTEXT.md 口径、两份滞后计划文档状态回写。

### Phase 2：契约收口（后续票）

- 5 个 raw 路由：knowledge 收编进 defineRoute；harness/discord/deploy-webhook/sse 属协议面例外，复核并在 route-registry 注释固化例外清单。
- SSE 事件负载契约化：ADR 2026-08-24-sse-event-payload-contract 落地状态核查；web `types/workunit.ts` 本地解析器搬入 studio-contract。
- 循环依赖 lint 规则补建并接 CI，兑现 target-architecture.md 的承诺。

### Phase 3：巨型文件拆深模块（后续票）

- agent-loop.ts / knowledge-service.ts / file-store-messages.ts / prompt-composer.ts / workunit.service.ts 按域拆分，深模块标准（codebase-design），每刀独立 commit + 测试。

### Phase 4：性能自动化（后续票）

- bench 脚本化（复用 performance-baseline.md 方法论：隔离 STUDIO_HOME、50 发串行、p50/p95/max）+ CI/ship 前自动对比，回归 > 20% 红。
- 前端 bundle 预算 + 已认证主应用 LCP 测量落地。
- warmup SessionSummary 10.9s 阻塞根治（既有票收口）。

## 工单映射（2026-10-08 起票，全部 ready-for-agent）

| Phase | 工单 | 主题 | 顺序约束 |
|---|---|---|---|
| 2 | #664 | knowledge 路由收编 defineRoute + 协议面例外清单固化 | 独立 |
| 2 | #665 | SSE 事件负载契约化（ADR 2026-08-24 落地） | 独立 |
| 2 | #666 | 循环依赖检测接 CI | 独立 |
| 2 | #667 | WorkUnit 写路径单口（ADR 2026-09-15 补票） | 先于 #672 |
| 3 | #668 | agent-loop.ts 1885 行拆分 | Phase 2 后；先于 #671 |
| 3 | #669 | knowledge-service.ts 1228 行拆分 | #664 后 |
| 3 | #670 | FileStore 门面治理（file-store*.ts） | 独立（引擎语义冻结） |
| 3 | #671 | prompt-composer.ts 859 行拆分 | #668 后 |
| 3 | #672 | workunit.service.ts 780 行拆分 | #667 后 |
| 4 | #673 | bench 脚本化 + 回归门 | 独立 |
| 4 | #674 | 前端 bundle 预算 + 已认证 LCP | 独立 |
| 4 | #675 | warmup SessionSummary 10.9s 阻塞根治 | 独立 |

执行口径：单票会话或 `ticket-loop` 批量均可；建议首批 = Phase 2 四张（#664–#667）。

## 验收线（Phase 1）

- `pnpm typecheck` 全 8 包 0 errors（baseline 保持 0）。
- `pnpm build` 绿；受影响测试绿（`vitest run --changed origin/master`）。
- `pnpm build:npm` 产物可构建。
