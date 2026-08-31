# apps/api/src/modules/audit

### 职责

将 EventBus 中的审计事件（`events:audit`）持久化到 KnowledgeStore，提供启动和停止订阅控制，确保每条事件以 `guideline` 类型存储，并记录错误日志。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `startAuditSubscriber` | `audit-subscriber.ts` | 启动审计事件订阅，将事件持久化到 KnowledgeStore，只生效一次 |
| `stopAuditSubscriber` | `audit-subscriber.ts` | 停止审计事件订阅（通过标志位控制） |

### 依赖关系

**上游依赖**
- `@dommaker/studio-shared`：提供 `eventBus`（`eventBus.subscribe` 直订 `events:audit`，对象 payload）与日志工具 `logger`
- `apps/api/src/modules/knowledge/knowledge-singletons.ts`：动态导入获取 `sharedStore` 以保存审计事件

**下游依赖**
- `apps/api/src/index.ts`：启动时调用本模块的 `startAuditSubscriber`

### 注意事项

- `started` 标志确保订阅只注册一次，重复调用不生效
- 审计事件解析失败时仅记录错误，不抛出，防止影响其他流程
- 知识总线服务使用动态 `import()` 延迟加载，避免循环依赖或初始化顺序问题
- 存储的 `id` 使用时间戳 + 随机字符串保证唯一性
