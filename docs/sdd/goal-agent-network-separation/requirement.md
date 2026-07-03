---
status: done
version: "1.0"
---

# Goal 与 Agent Network 彻底分离

## 背景

Goal 系统（Pipeline 架构）和 Agent Network 共用 work_unit 表，导致：
- Scheduler 把 AgentLoop 的 WorkUnit 当作 Goal 处理
- Agent 执行失败（Goal has no executions）
- 两个架构的语义和生命周期不同，不应融合

## 目标

- Goal 系统保留原来的 Goal + GoalExecution 表
- Agent Network 使用 WorkUnit 表
- 两个系统互不干扰

## AC Group 1：Goal 系统回退到 Goal + GoalExecution 表

### AC-1.1：Goal CRUD 使用 Goal 表
- **触发条件**：创建、读取、更新、删除 Goal
- **预期行为**：所有 Goal CRUD 操作使用 Goal 表，不使用 WorkUnit 表
- **边界情况**：Goal 状态变更、Goal 元数据更新
- **不做**：不修改 Goal 表结构

### AC-1.2：GoalExecution CRUD 使用 GoalExecution 表
- **触发条件**：创建、读取、更新、删除 GoalExecution
- **预期行为**：所有 GoalExecution CRUD 操作使用 GoalExecution 表，不使用 WorkUnit 表
- **边界情况**：Execution 状态变更、重试、超时
- **不做**：不修改 GoalExecution 表结构

### AC-1.3：Goal 生命周期管理使用 Goal + GoalExecution 表
- **触发条件**：Goal 状态变更、Execution 状态变更、完成检查
- **预期行为**：所有生命周期管理操作使用 Goal + GoalExecution 表
- **边界情况**：级联失败、阻塞、解锁
- **不做**：不修改生命周期逻辑

### AC-1.4：Goal 调度使用 Goal + GoalExecution 表
- **触发条件**：Scheduler 调度 Goal、检查 Goal 状态
- **预期行为**：Scheduler 只处理 Goal 表中的记录，不处理 WorkUnit 表
- **边界情况**：Scheduler 轮询、恢复、超时
- **不做**：不修改调度逻辑

## AC Group 2：Agent Network 使用 WorkUnit 表

### AC-2.1：AgentLoop 使用 WorkUnit 表
- **触发条件**：AgentLoop 扫描、claim、执行 WorkUnit
- **预期行为**：AgentLoop 只操作 WorkUnit 表，不操作 Goal + GoalExecution 表
- **边界情况**：claim 竞争、执行失败、超时
- **不做**：不修改 AgentLoop 逻辑

### AC-2.2：WorkUnitService 使用 WorkUnit 表
- **触发条件**：WorkUnit CRUD、状态变更、审查
- **预期行为**：WorkUnitService 只操作 WorkUnit 表
- **边界情况**：乐观锁、文件冲突检查
- **不做**：不修改 WorkUnitService 逻辑

## AC Group 3：跨模块隔离

### AC-3.1：MonitorAgent 只查询 Goal 表
- **触发条件**：MonitorAgent 检查 Goal 状态
- **预期行为**：MonitorAgent 只查询 Goal + GoalExecution 表，不查询 WorkUnit 表
- **边界情况**：监控指标、告警
- **不做**：不修改监控逻辑

### AC-3.2：OKR 服务只查询 Goal 表
- **触发条件**：OKR 计算指标
- **预期行为**：OKR 服务只查询 Goal + GoalExecution 表，不查询 WorkUnit 表
- **边界情况**：指标计算、聚合
- **不做**：不修改 OKR 逻辑

### AC-3.3：前端 GoalStore 只使用 Goal 表
- **触发条件**：前端加载 Goal 数据
- **预期行为**：GoalStore 只使用 Goal + GoalExecution 表，不使用 WorkUnit 表
- **边界情况**：状态同步、UI 更新
- **不做**：不修改前端逻辑

### AC-3.4：Dashboard 只查询 Goal 表
- **触发条件**：Dashboard 显示 Goal 统计
- **预期行为**：Dashboard 只查询 Goal + GoalExecution 表，不查询 WorkUnit 表
- **边界情况**：统计计算、UI 更新
- **不做**：不修改 Dashboard 逻辑

### AC-3.5：PMO 健康检查只查询 Goal 表
- **触发条件**：PMO 健康检查端点
- **预期行为**：PMO 只查询 Goal + GoalExecution 表，不查询 WorkUnit 表
- **边界情况**：健康检查指标
- **不做**：不修改 PMO 逻辑

## AC Group 4：数据隔离验证

### AC-4.1：Goal 系统不影响 Agent Network
- **触发条件**：Goal 系统执行任何操作
- **预期行为**：Goal 系统操作不影响 WorkUnit 表中的 Agent Network 数据
- **边界情况**：并发操作、状态变更
- **不做**：不修改数据隔离逻辑

### AC-4.2：Agent Network 不影响 Goal 系统
- **触发条件**：Agent Network 执行任何操作
- **预期行为**：Agent Network 操作不影响 Goal + GoalExecution 表中的数据
- **边界情况**：并发操作、状态变更
- **不做**：不修改数据隔离逻辑

## 不做

- 不修改 Goal 表结构
- 不修改 GoalExecution 表结构
- 不修改 WorkUnit 表结构
- 不修改 AgentLoop 逻辑
- 不修改 WorkUnitService 逻辑
- 不删除 Goal 表或 GoalExecution 表
