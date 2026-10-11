# harness 2.0.0 适配（studio 侧）

> 2026-09-30。harness 2.0.0 未发布（本地 master 领先 v1.16.0 共 6 个 commit），本计划让 studio 代码直接按 2.0.0 API 硬切，开发期用 `pnpm.overrides` + `link:../harness` 验证；harness 发布后 `pnpm update @dommaker/harness` 落正式依赖。

## 背景

harness 2.0.0 变更（CHANGELOG `[2.0.0]` + `[Unreleased]` 节）对 studio 的适配面，逐项核实结论：

| 项 | 结论 |
|---|---|
| `KnowledgeIngest.ingestEntry/ingestBatch/ingestExternal` 返回 `KnowledgeEntry` → `IngestResult` 判别联合（`{status:'accepted',entry} \| {status:'rejected',entry,reasons}`），删 `__rejected`/`__rejectReasons` 私有挂字段 | 唯一实质 breaking，3 处生产代码 + 约 6 个测试 mock 要改 |
| `KnowledgeInjector` 删除（消费编排归 studio） | 零改动——studio 已内联本地正本 `knowledge-injector.ts`（6ed740a9） |
| `EXTERNAL_SOURCE_MARKER` 新增包根导出 | 顺势切换：删本地复刻字面量，改 import 正本 |
| `docs_freshness` 降 warning（iron-laws→guidelines 组） | 零改动——`admin/docs-freshness.routes.ts` 同时读 warnings+errors 按 id 过滤，组别移动不影响 |
| `./gates` 子路径删除 / any→unknown 收紧 / 巨型文件拆分 / fail-fast 化 31 处 | 零改动（无子路径导入、无相关字段读取、`dist/pretool-use-hook.js` 路径与 `constraints --json` CLI 面不变） |

## 方案

- 代码硬切新 API，不留双形状兼容层。
- 开发/验证：`pnpm.overrides: {"@dommaker/harness": "link:../harness"}`（**不提交**，lockfile 不留 link 痕迹）。
- 5 个 package.json 依赖声明升 `^2.0.0` 并提交；harness 发布前 lockfile 解析不到 2.0.0 属预期，发布后 `pnpm update` 再生。

## 改动点

生产代码：
1. `apps/api/src/modules/knowledge/knowledge-singletons.ts` — `saved.status === 'rejected'` 窄化；成功取 `saved.entry`；注释同步。
2. `apps/api/src/modules/knowledge/conversation-extractor.ts` — 同上；`saved.entry.id` 去 `as any`。
3. `apps/api/src/modules/knowledge/knowledge-design-doc.ts` — rejected 抛错（旧行为拿未落盘 id 谎报 created，顺势 fail-fast）；成功取 `result.entry.id`。
4. `apps/api/src/modules/knowledge/knowledge-injector.ts` — `EXTERNAL_SOURCE_MARKER` 切 harness 正本 import + re-export；formatEntry/formatSummary 本地复刻保留（harness `formatForPrompt` 简化格式不等价）。

测试 mock 换判别联合形状：`knowledge-service.test.ts`、`knowledge-quality-gate-events.test.ts`、`knowledge-service-extract-conversation.test.ts`、`knowledge-service-retrieval-proactivity.test.ts`、`knowledge-vector-sync.test.ts`、`knowledge-service.routes.test.ts`、`knowledge-service-inject-wiring.test.ts`。

## 验证

- link 2.0.0 下 `pnpm typecheck` 绿 + knowledge/admin/evolution 相关测试全绿。
- `__rejected` 全仓零残留。
- 提交 diff 不含 overrides/lockfile link 痕迹。

## 后续（harness 2.0.0 发布后）

`pnpm update @dommaker/harness` → 切 `.harness/config.yml` 的 `harness.version` → 走 ship。
