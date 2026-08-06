# 门控基线报告（studio 全量重构前）

- 采集时间：2026-08-06（UTC）
- 环境：node v22.22.0，pnpm 11.19.0
- 基线提交（`git log --oneline -3`）：
  - `46a2cf8f` refactor(web): 删除 DeployApprovalCard 整条不可达死链
  - `c9e56b77` refactor(web): 剩余 raw API 调用点全部收编进 *Api adapter 模块
  - `59bb9130` refactor(agents): 删除旧 review 栈（review.service/review-report//review/diff 端点）

## 三个问题的明确回答

1. **typecheck 当前是否全绿？是。** 退出码 0，`tsc-gate: no new errors detected`。
2. **test 当前是否全绿？是。** 退出码 0，无失败用例，无存量失败清单。
3. **lint 告警量级？无法统计（门控本身损坏）。** `pnpm lint` 在第一个包 `packages/studio-capability` 即失败：`eslint: not found`（该包有 lint 脚本但未声明 eslint 依赖），`pnpm -r` 遇错即停，其余包未执行。因此告警/错误数量为 0 条已采集 / 不可知。

## typecheck

- 命令：`pnpm typecheck` → `node bin/tsc-gate.js --check --baseline .tsc-baseline.json --packages apps/api,apps/web,packages/studio-shared,packages/studio-agent`
- 退出码：0
- 结果：`✅ tsc-gate: no new errors detected`（对 4 个包，相对 `.tsc-baseline.json` 无新增错误）

## test

- 命令：`pnpm test` → `vitest run`
- 退出码：0
- 统计：**Test Files 446 passed | 7 skipped (453)；Tests 4246 passed | 19 skipped | 3 todo (4268)**
- 失败项清单：无。
- 总耗时约 4.5 分钟（Duration 270.65s），未触及 20 分钟截断上限。
- 备注（非失败，仅供后续重构者参考）：
  - 进程退出前提示 `close timed out after 10000ms` / `something prevents the main process from exiting`（vitest 已知悬挂句柄告警，不影响退出码）。
  - 日志中存在大量测试内预期告警（如 `[ResolutionService] create failed`、`[KnowledgeService] extractFromConversation failed`），均为用例注入的 mock 失败路径，属正常输出。

## lint

- 命令：`pnpm lint` → `ESLINT_USE_FLAT_CONFIG=false pnpm -r lint`
- 退出码：1
- 失败原因：`packages/studio-capability` 的 lint 脚本 `eslint src/**/*.ts` 报错 `sh: 1: eslint: not found`（该包未安装 eslint，workspace 中仅 `apps/web` 声明了 `eslint@^9.39.4`）；`pnpm -r` 首个包失败即终止。
- 有 lint 脚本的包共 5 个：`apps/web`、`packages/studio-agent`、`packages/studio-capability`、`packages/studio-monitor`、`packages/studio-spec`。
- 结论：lint 门控当前处于**基础设施性失败**状态，未产生任何告警数据。重构期间若要以 lint 为门控，需先修复该依赖缺失问题（本次基线任务按只读约束未做修复）。
