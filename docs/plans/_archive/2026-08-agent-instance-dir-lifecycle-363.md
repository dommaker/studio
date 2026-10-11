# 2026-08 agent 实例目录生命周期闭环（#363）

来源：2026-08-25 架构评审（性能第二轮）候选 B1；grilling 决策树 Q1-Q6 已当场确认。本计划是决策的执行分解，不再含开放决策。

## 改动清单

1. `packages/studio-shared/src/file-store.ts`
   - `deleteState`：unlink state.json 后判空删目录——目录为空才 rmdir；有 profile.json 或任何其他文件绝不碰（agents/<id>/ 是 profile 与 state 共享 namespace）。rmdir 的 ENOENT/ENOTEMPTY 竞态容错。
   - 新增 `sweepEmptyAgentDirs()`：一次性存量清扫，同判空条件，幂等；返回 `{ removed }`。
2. `apps/api/src/modules/agents/instance-timeout-scan.ts`
   - scan 统一回收 terminated 实例（跨角色）：`deleteState`（连带判空删目录）。结果新增 `reclaimed` 计数。
3. `apps/api/src/modules/agents/loop/agent-loop.ts`
   - 拆除 :188-194 的同角色启动清理（2026-07-30 防累积修复），回收职责归 scan。F2 error→terminated 恢复块保留。
4. `apps/api/src/index.ts`
   - 启动时跑一次 `sweepEmptyAgentDirs()`（幂等，每启动重跑无副作用）。
5. `apps/api/bench/loop-read-worker.ts`
   - 驱动循环前跑一次 sweep（模拟 API 启动），让合成数据集反映闭环后形态。

## 测试（先行）

- file-store：deleteState 空删 / 有 profile 不删 / 有其他文件不删；sweep 删空保满、幂等、目录缺失。
- instance-timeout-scan：跨角色回收 terminated（state.json 与空目录均消失）、非终态不动。
- agent-loop 旧「启动清理」测试（:668-起）随拆除删除，覆盖由 scan 测试承接。

## 验证

- `pnpm typecheck`；改动文件相关测试；收尾全量一次。
- bench 复测（`apps/api/bench/loop-read-metrics.ts`）：agent-timeout 50x 档每轮读次数 37301 → ~存活实例数量级，报告落 `report-loop-read-metrics-363-rerun.md`（保留原基线报告）。

## 否决路线（留痕）

负结果缓存不做；聚合 memo / 派生快照文件 / 布局迁移均否决（见工单 #363 正文）。
