# projects

> 此文件描述 apps/api/src/modules/projects 目录的职责和上下文

<!-- STALE_SINCE: 2026-07-30 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/projects/CONTEXT.md, apps/api/src/modules/projects/project-discovery.service.ts

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
- **工程即叶子（2026-07-29）**：命中标记（CLAUDE.md / package.json / .git）的目录不再递归内部 —— monorepo 只列根目录，子包不重复出现；非工程中间目录（分组目录、无标记 packages/）仍继续下钻
- **D6 排除清单（第一层，2026-07-27）**：env `STUDIO_PROJECTS_EXCLUDE`（冒号分隔）或构造参数 `exclude` —— 规则命中目录名（精确）或绝对路径（目录边界前缀，不误伤同名前缀目录）即跳过且不递归
- **鉴权（2026-07-29 放宽）**：/api/v1/projects 挂载层为 requireAuth（登录即可；PMO 新建表单的工程下拉依赖 GET /discover）。曾收 requireAuth+requireAdmin（2026-07-24，顾虑：扫描服务器目录、回显绝对路径），但非 admin 部署下 PMO 新建不可用，故放宽。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `280a7329`: PMO 走查修复 — agent 执行可靠性 + 多实例单活 + 链路优化
- ✅ `c3b1aab8`: channel-an): resolve 7 code review warnings
- ✅ 2026-07-29: 工程即叶子（命中标记即剪枝，monorepo 子包不再重复列出）；/api/v1/projects 挂载 admin→auth
- ✅ 2026-07-27: D6 排除清单第一层 — STUDIO_PROJECTS_EXCLUDE / options.exclude（目录名 / 绝对路径边界前缀），命中即跳过不递归
- ✅ 2026-07-24: 挂载收 requireAuth+requireAdmin
