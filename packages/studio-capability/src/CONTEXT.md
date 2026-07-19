# src

> 此文件描述 packages/studio-capability/src 目录的职责和上下文

## 职责

本目录负责能力管理（CapabilityService）与公司 MCP 资源池管理（company-mcp-pool）。CapabilityService 提供能力的 CRUD、同步、统计，并基于 FileStore JSON 文件存储实现（替代 Prisma）。company-mcp-pool 提供公司级 MCP 资源的增删改查、系统级 MCP 启用/禁用、角色权限控制及敏感信息管理。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| CapabilityService | services/capability.service.ts | 能力管理服务，负责能力的增删改查、同步与市场功能（发布/购买/评价） |
| MCPSource, MCPTransport, MCPStatus, SystemMCP, CompanyMCP 等类型/接口 | services/company-mcp-pool.ts | 公司 MCP 资源池相关的类型定义与导出 |

## 依赖关系

**上游（本目录依赖）**
- `@dommaker/studio-shared`：提供 `FileStore`（JSON 文件存储基础）和 `logger`
- `@dommaker/harness`：提供 `getRegistryPath`（获取注册表路径）
- 标准库：`fs`, `path`, `os`

**下游（依赖本目录）**
- `apps/api/src/modules/capabilities/routes.ts`：API 路由模块，可能使用 CapabilityService 或公司 MCP 资源池能力

## 注意事项

- 能力数据存储在 `~/.studio/capabilities/{name}.json`，文件命名需唯一
- MCP 配置中的 `env` 字段可能包含敏感信息，需注意安全处理
- `allowedRoles` 为空数组表示所有角色均可访问，需与权限服务协同
- 系统级 MCP（`SystemMCP`）不可直接修改公司级配置，通过 `systemMCPId` 关联
- 所有时间戳使用 ISO 字符串格式（`createdAt`/`updatedAt`）
