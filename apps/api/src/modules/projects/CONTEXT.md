# projects

> 此文件描述 apps/api/src/modules/projects 目录的职责和上下文

<!-- STALE_SINCE: 2026-07-28 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/projects/CONTEXT.md, apps/api/src/modules/projects/project-discovery.service.ts, apps/api/src/modules/projects/project.routes.ts

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
- **D6 排除清单（第一层，2026-07-27）**：env `STUDIO_PROJECTS_EXCLUDE`（冒号分隔）或构造参数 `exclude` —— 规则命中目录名（精确）或绝对路径（目录边界前缀，不误伤同名前缀目录）即跳过且不递归
- **鉴权（2026-07-24 收紧）**：/api/v1/projects 挂载层已收 requireAuth+requireAdmin（GET /discover 会扫描服务器目录、回显绝对路径）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `c3b1aab8`: channel-an): resolve 7 code review warnings
- ✅ 2026-07-27: D6 排除清单第一层 — STUDIO_PROJECTS_EXCLUDE / options.exclude（目录名 / 绝对路径边界前缀），命中即跳过不递归
- ✅ 2026-07-24: 挂载收 requireAuth+requireAdmin
