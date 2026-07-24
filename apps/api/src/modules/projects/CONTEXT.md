# projects

> 此文件描述 apps/api/src/modules/projects 目录的职责和上下文

## 职责

Project Discovery（AC-D1 + AC-D3）：发现已注册的工程（repo）信息并对外提供查询 API，供频道默认工程、WorkUnit 工程绑定等流程使用。

## 核心导出

- `project-discovery.service.ts` — Project Discovery Service（AC-D1+D3）
- `project.routes.ts` — Project Discovery API（AC-D3）

## 依赖关系

- 上游：workspaces 模块的工程注册数据（FileStore）
- 下游：apps/api 路由挂载；UI/频道派发流程查询工程列表

## 注意事项

- 只读发现层，不负责工程注册（注册在 workspaces 模块）
- **鉴权（2026-07-24 收紧）**：/api/v1/projects 挂载层已收 requireAuth+requireAdmin（GET /discover 会扫描服务器目录、回显绝对路径）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ 2026-07-24: 挂载收 requireAuth+requireAdmin
