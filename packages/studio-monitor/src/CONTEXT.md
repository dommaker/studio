# src

> 此文件描述 packages/studio-monitor/src 目录的职责和上下文

## 职责

监控 Agent 健康状态，定时检查任务超时、心跳及僵尸任务，提供启动和停止监控的接口，确保任务运行的稳定性。

## 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `HealthMonitor` | `services/health-monitor.ts` | 健康监控类，管理任务健康检查逻辑 |
| `startHealthMonitor` | `services/health-monitor.ts` | 启动健康监控的函数 |
| `stopHealthMonitor` | `services/health-monitor.ts` | 停止健康监控的函数 |

## 依赖关系

**上游依赖**：
- `@dommaker/studio-task`：使用 `taskQueue` 获取任务统计及运行中任务
- `@dommaker/studio-shared`：提供 `logger`、`memoryStore`、`eventBus` 基础设施

**下游依赖**：
- `apps/api/src/index.ts`：引用了本模块的监控能力

## 注意事项

- 默认任务超时时间为 30 分钟（B57-P6 从 60 分钟缩短），可通过 `HealthMonitorConfig.taskTimeout` 自定义
- 心跳超时默认 10 分钟，检查间隔默认 1 分钟，僵尸检查间隔默认 5 分钟
- `start()` 和 `stop()` 均为异步方法，需 await 确保状态一致性
- 实例化后需手动调用 `start()` 才会开始监控，调用 `stop()` 会清除所有定时器
- `HealthMonitor` 类内部使用 `NodeJS.Timeout` 数组管理定时器，注意避免重复启动导致内存泄漏
