# mcp

> MCP（Model Context Protocol）模块 — 将 Studio 系统能力暴露为 MCP tools，供 Agent 和 UI 共享调用。

## 结构

| 文件 | 职责 |
|------|------|
| `tools.ts` | 注册门面：导入各域 tool 数组、组装 allTools、风险级别标注、注册、权限种子、导出 getToolSchemas/executeTool |
| `tool-store.ts` | 共享 FileStore 存取助手（数据目录惰性解析 getTasksDir 等 + 通用 JSON 实体读写） |
| `tool-registry.ts` | MCPToolRegistry：动态注册、健康检查、限流、调用追踪 |
| `server.ts` | MCP Server：JSON-RPC 2.0 协议处理（initialize / tools/list / tools/call） |
| `routes.ts` | HTTP 路由：POST /mcp、SSE transport、tools 列表+调用、health |
| `permission.service.ts` | MCP 权限服务：RBAC 授权 + 审计日志 |
| `admin.routes.ts` | 管理路由（需认证） |
| `*.tools.ts` | 各域 tool 定义（见下表） |

## 域 tool 文件

| 文件 | 数量 | Tools |
|------|------|-------|
| `pmo.tools.ts` | 3 | createProject / listProjects / getProjectStatus |
| `task.tools.ts` | 5 | getTaskBoard / createTask / assignTask / updateTaskStatus / getTaskStats |
| `economy.tools.ts` | 1 | getBalance |
| `spec.tools.ts` | 4 | createSpec / approveSpec / getSpecStatus / listSpecs |
| `safety.tools.ts` | 3 | checkConstraint / checkGuardrail / getSandboxLevel |
| `system.tools.ts` | 2 | systemHealth / emitEvent |
| `devops.tools.ts` | 1 | publishPackage |
| `skill.tools.ts` | 1 | loadSkill |
| `workunit.tools.ts` | 1 | createWorkUnit |
| **合计** | **21** | |

> #149（2026-08-15）：`knowledge.tools.ts`（5 个知识工具，全是 document-store CRUD）随 document-store 退役删除。
> #172（2026-08-15）：`loadSkill` 入参加可选 `workUnitId`（透传 skill-loader，skill_used 事件补 WU 归属，#60 决策 Q2）。

## 核心导出

- `getToolSchemas()` — 获取所有 tool 的 JSON schema（不含 handler）
- `executeTool(name, input, roleId?, traceCtx?)` — 按名称执行 tool（含权限检查 + 限流 + 审计）
- `MCPToolRegistry` / `toolRegistry` — Tool 注册与生命周期管理
- `mcpPermissionService` — 权限与审计

## 依赖关系

- 依赖：`@dommaker/studio-shared`（logger, FileStore）、`@dommaker/studio-skill`（skillLoader）、`../../utils/studio-events.js`（D18 统一事件写入，emitEvent / tool:call traces）
- 依赖：各业务模块（workunit, pmo, knowledge, skills）
- 被依赖：`routes.ts` / `server.ts`（HTTP 与 JSON-RPC 入口）

## 注意事项

- tools.ts 是门面，不包含 tool 定义。新增 tool 在对应域 *.tools.ts 中添加，并在 tools.ts 的 allTools 数组中展开（注册顺序即数组顺序）。
- 风险级别按工具名前缀自动分配（create/store/extract/approve/assign/update 等 → medium，delete/drop/truncate → high，其余 → low）。
- 权限模型默认 executor（本地 Agent）可调用所有 tool。
- **HTTP 端点鉴权分层（2026-07-24 收紧）**：`GET /tools`、`GET /health` 保持公开（Lurk）；`POST /tools/:name` → `requireAuth+requireAdmin`（roleId 自声明 + executor seed 默认全允许，此前在 PUBLIC_API 前缀下匿名可执行任意 tool 含 devops/git）；`POST /messages`、`GET /sse` → `requireLocalhost`（真实客户端为本机 agent，`STUDIO_MCP_URL` 默认 localhost SSE）；`/admin/*` → `requireAuth+requireAdmin`（此前裸奔，注释谎称由 route-registry 提供 requireAuth）。permission.service 的 RBAC 是 agent 角色维度，与 HTTP 用户鉴权是两层。
