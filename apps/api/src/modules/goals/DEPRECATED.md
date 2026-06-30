# goals/ 模块废弃声明

**状态**：@deprecated（Phase 3）
**替代方案**：Agent Network（WorkUnit 系统）
**删除阶段**：Phase 4（触发条件满足后执行）

## 废弃原因

Pipeline（Goal 系统）已被 Agent Network（WorkUnit 系统）替代：
- Pipeline = Push/中央调度模型（Goal + GoalPlan + GoalExecution 表）
- Agent Network = Pull/claim 模型（WorkUnit 表）

Phase 1 已将所有外部消费方从 Pipeline 表迁移到 WorkUnit 表。
Phase 2 已提取可复用组件到 `@dommaker/studio-shared` 和知识条目。
本文件标注所有内部文件为 @deprecated。

## 废弃进度

| Phase | 状态 | 内容 |
|-------|------|------|
| Phase 1 | ✅ 完成 | MonitorAgent/OKR 查询迁移到 WorkUnit 表 |
| Phase 2 | ✅ 完成 | 3 工具函数提取到 studio-shared + 3 知识条目 |
| Phase 3 | ✅ 完成 | 全部 18 个 .ts 文件标注 @deprecated + 本文件 |
| Phase 4 | ⏳ 待执行 | 删除整个 goals/ 目录 |

## Phase 4 删除触发条件

全部满足才执行：
1. Phase 1-3 全部完成 ✅
2. GoalScheduler 禁用后 30 天观察期无回滚需求
3. OKR 历史数据迁移方案已确认（历史指标查询不依赖 Goal 表）

## 删除范围

- `apps/api/src/modules/goals/` 整个目录（含 18 个 .ts + __tests__/）
- `apps/api/src/modules/pipeline-dashboard/`
- `route-registry.ts` 中 `/api/v1/goals` 路由注册

## 注意事项

- 不删除 Pipeline 数据库表（保留历史数据）
- boundary test 保留到 Phase 4 执行时一并删除
- 外部唯一引用：`knowledge-sync.service.ts` 仅以字符串形式引用文件路径（无运行时依赖）
