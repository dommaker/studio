# dingtalk

> 此文件描述 apps/api/src/modules/dingtalk 目录的职责和上下文

## 职责

处理钉钉机器人交互回调，包括 ActionCard 按钮点击的健康检查和操作忽略提示。当前 Meeting 模块已移除，按钮点击仅返回占位响应。

## 核心导出

| 导出 | 文件 | 说明 |
| default | routes.ts | Express Router 实例，挂载 /api/v1/dingtalk 路径下的 /action 和 /health 路由 |

## 依赖关系

上游：
- `apps/api/src/utils/logger.js`（日志记录）

下游：
- **apps/api/src/route-registry.ts**：注册本路由模块到 Express 应用

## 注意事项

- 路由挂载于 /api/v1/dingtalk 前缀，由 route-registry 统一注册
- ActionCard 按钮点击（/action）仅返回静态 HTML，不再执行实际会议操作
- 健康检查（/health）返回 JSON 格式 { status: 'ok', service: 'dingtalk-callback' }
