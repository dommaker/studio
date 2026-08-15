---
status: "done"
version: "1.0"
---

# 任务规划：Goal 与 Agent Network 彻底分离

## 1. 契约测试规划

### AC Group 1：Goal 系统回退到 Goal + GoalExecution 表

| AC | 测试文件 | 测试用例 |
|----|---------|---------|
| AC-1.1 | `goal-crud.test.ts` | 创建 Goal → 验证写入 Goal 表；读取 Goal → 验证从 Goal 表读取；更新 Goal → 验证更新 Goal 表；删除 Goal → 验证删除 Goal 表 |
| AC-1.2 | `goal-lifecycle.test.ts` | 创建 GoalExecution → 验证写入 GoalExecution 表；更新 Execution 状态 → 验证更新 GoalExecution 表；检查完成 → 验证查询 GoalExecution 表 |
| AC-1.3 | `goal-review.test.ts` | 提交审查 → 验证查询 GoalExecution 表；审查通过 → 验证更新 GoalExecution 表；审查拒绝 → 验证更新 GoalExecution 表 |
| AC-1.4 | `scheduler-integration.test.ts` | Scheduler 轮询 → 验证只查询 Goal 表；调度 Goal → 验证查询 GoalExecution 表；检查状态 → 验证查询 GoalExecution 表 |

**测试文件 mock 修改**（10 个文件，42 处 mock 定义）：

| 文件 | mock 引用数 | 测试内容 |
|------|------------|---------|
| `goal-lifecycle.test.ts` | 15 | goal 状态流转：创建执行、完成聚合、阻塞检测、级联状态更新 |
| `pipeline-contract.test.ts` | 14 | scheduler-dispatch 契约：workUnitFeedback 成功/失败路径 |
| `handle-goal-failed-failure-type.test.ts` | 3 | goal 失败时分类 failure type + retryGoalExecution 状态转换 |
| `goal-retry.test.ts` | 2 | 重试逻辑：workUnitService.update 调用 retryCount + metadata |
| `executor-fast-only.test.ts` | 2 | executor fast-only 模式 + workUnitFeedback mock |
| `role-skill-binding.test.ts` | 2 | role-skill 绑定逻辑 + workUnitFeedback mock |
| `blocked-status.test.ts` | 1 | goal blocked 状态处理 |
| `scheduler-dispatch-failure-type.test.ts` | 1 | scheduler dispatch 失败类型分类 |
| `scheduler-dispatch-retry-prompt.test.ts` | 1 | scheduler dispatch 重试提示 |
| `stale-recovery.test.ts` | 1 | stale execution 恢复逻辑 |

### AC Group 2：Agent Network 使用 WorkUnit 表

| AC | 测试文件 | 测试用例 |
|----|---------|---------|
| AC-2.1 | `agent-loop.test.ts` | 扫描 WorkUnit → 验证查询 WorkUnit 表；claim WorkUnit → 验证更新 WorkUnit 表；执行 WorkUnit → 验证更新 WorkUnit 表 |
| AC-2.2 | `workunit.service.test.ts` | 创建 WorkUnit → 验证写入 WorkUnit 表；更新状态 → 验证更新 WorkUnit 表；审查 → 验证更新 WorkUnit 表 |

### AC Group 3：跨模块隔离

| AC | 测试文件 | 测试用例 |
|----|---------|---------|
| AC-3.1 | `monitor-agent.test.ts` | 检查 Goal 状态 → 验证只查询 Goal 表；检查 Execution 状态 → 验证只查询 GoalExecution 表 |
| AC-3.2 | `okr.service.test.ts` | 计算指标 → 验证只查询 Goal 表；聚合数据 → 验证只查询 GoalExecution 表 |
| AC-3.3 | `goalStore.test.ts` | 加载 Goal → 验证使用 Goal API；加载 Execution → 验证使用 GoalExecution API |

### AC Group 4：数据隔离验证

| AC | 测试文件 | 测试用例 |
|----|---------|---------|
| AC-4.1 | `data-isolation.test.ts` | Goal 操作 → 验证 WorkUnit 表不变；WorkUnit 操作 → 验证 Goal 表不变 |
| AC-4.2 | `data-isolation.test.ts` | 并发操作 → 验证数据一致性 |

## 2. 执行顺序

### Phase 1：Goal 系统回退（并行）

**依赖关系**：无，可并行执行

| 任务 | 文件 | 依赖 |
|------|------|------|
| 1.1 | goal-crud.ts | 无 |
| 1.2 | goal-lifecycle.ts | 无 |
| 1.3 | goal-review.ts | 无 |
| 1.4 | scheduler-integration.ts | 无 |
| 1.5 | scheduler-prompt.ts | 无 |
| 1.6 | routes.ts | 无 |
| 1.7 | event-handler.ts | 无 |
| 1.8 | stale-recovery.ts | 无 |
| 1.9 | execution-alarm.ts | 无 |
| 1.10 | integration-rollback.ts | 无 |

### Phase 2：跨模块隔离（串行）

**依赖关系**：Phase 1 完成后执行

| 任务 | 文件 | 依赖 | 改动 |
|------|------|------|------|
| 2.1 | monitor-agent.service.ts | Phase 1 | 19 处查询改为 Goal + GoalExecution |
| 2.2 | okr.service.ts | Phase 1 | 28 处查询改为 Goal + GoalExecution |
| 2.3 | goalStore.ts | Phase 1 | 10 处引用改为 Goal + GoalExecution API |
| 2.4 | session-manager.ts | Phase 1 | 6 处引用改为 GoalExecution |
| 2.5 | agent-runner.ts | Phase 1 | 2 处引用改为 Goal |
| 2.6 | pipeline-dashboard.routes.ts | Phase 1 | 5 处查询改为 Goal + GoalExecution |
| 2.7 | pmo/routes.ts | Phase 1 | 2 处查询改为 Goal + GoalExecution |

### Phase 3：测试更新（并行）

**依赖关系**：Phase 2 完成后执行

| 任务 | 文件 | mock 数量 | 依赖 |
|------|------|----------|------|
| 3.1 | goal-lifecycle.test.ts | 15 | Phase 2 |
| 3.2 | pipeline-contract.test.ts | 14 | Phase 2 |
| 3.3 | handle-goal-failed-failure-type.test.ts | 3 | Phase 2 |
| 3.4 | goal-retry.test.ts | 2 | Phase 2 |
| 3.5 | executor-fast-only.test.ts | 2 | Phase 2 |
| 3.6 | role-skill-binding.test.ts | 2 | Phase 2 |
| 3.7 | blocked-status.test.ts | 1 | Phase 2 |
| 3.8 | scheduler-dispatch-failure-type.test.ts | 1 | Phase 2 |
| 3.9 | scheduler-dispatch-retry-prompt.test.ts | 1 | Phase 2 |
| 3.10 | stale-recovery.test.ts | 1 | Phase 2 |

## 3. 里程碑节点

### M1：Goal 系统回退完成
- **验证**：Goal 系统正常使用 Goal + GoalExecution 表
- **测试**：Phase 1 所有测试通过
- **范围**：10 个源文件，85 处查询

### M2：跨模块隔离完成
- **验证**：跨模块只查询 Goal + GoalExecution 表
- **测试**：Phase 2 所有测试通过
- **范围**：7 个源文件，72 处查询

### M3：测试更新完成
- **验证**：所有测试 mock 从 workUnit 改为 goal/goalExecution
- **测试**：Phase 3 所有测试通过
- **范围**：10 个测试文件，42 处 mock 定义

### M4：彻底分离完成
- **验证**：所有测试通过，系统正常运行
- **测试**：全量测试通过
- **总计**：27 个源文件 + 10 个测试文件 = 37 个文件，~200 处改动

## 4. 风险和缓解措施

### 风险 1：引入新 bug
- **缓解措施**：每阶段完成后运行全量测试
- **回滚方案**：保留旧代码，可快速回退

### 风险 2：数据一致性问题
- **缓解措施**：数据隔离验证测试
- **回滚方案**：数据备份，可恢复

### 风险 3：性能问题
- **缓解措施**：性能测试，监控查询性能
- **优化方案**：索引优化，查询优化
