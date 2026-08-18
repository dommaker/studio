# Mock Architecture Document

## 1. WorkUnit（工作单元）

WorkUnit 是系统中的基本执行单元。每个 WorkUnit 代表一个需要完成的任务。

### 数据结构

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 唯一标识 |
| type | enum | task/goal/decision |
| status | enum | pending/running/completed/failed |
| createdAt | timestamp | 创建时间 |
| completedAt | timestamp | 完成时间 |

### 生命周期

创建(pending) → 执行(running) → 完成(completed) / 失败(failed)

### API

| 操作 | 方法 | 路径 |
|------|------|------|
| 创建 | POST | /work-units |
| 查询 | GET | /work-units/:id |
| 列表 | GET | /work-units |
| 更新状态 | PATCH | /work-units/:id/status |

## 2. AgentProfile（Agent 身份）

AgentProfile 是 Agent 的静态身份定义。

### 数据结构

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 唯一标识 |
| name | string | Agent 名称 |
| capabilities | string[] | 能力列表 |
| status | enum | active/deactivated |

### 生命周期

创建 → 激活(active) → 停用(deactivated)

### API

| 操作 | 方法 | 路径 |
|------|------|------|
| 创建 | POST | /agents |
| 查询 | GET | /agents/:id |
| 停用 | POST | /agents/:id/deactivate |

### 事件

| 事件 | 触发条件 | 消费方 |
|------|---------|--------|
| agent.created | AgentProfile 创建 | Monitor |
| agent.deactivated | Agent 被停用 | Monitor, KnowledgeAgent |

## 3. DiscussionSpace（讨论空间）

DiscussionSpace 是 Agent 之间协调讨论的异步空间。

### 数据结构

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 唯一标识 |
| workUnitId | string | 关联的 WorkUnit |
| messages | Message[] | 消息列表 |

### 验证场景

#### 场景 D1：消息创建

| 类别 | 内容 |
|------|------|
| 正向 | Agent 发送消息，其他 Agent 可见 |
| 边界 | 并发发送多条消息，顺序正确 |
| 异常 | 非参与方 Agent 尝试发送，拒绝 |
