# src

> 此文件描述 packages/studio-capability/src 目录的职责和上下文

## 职责

本目录负责能力管理（CapabilityService）。CapabilityService 提供能力的 CRUD、同步、统计，并基于 FileStore JSON 文件存储实现（替代 Prisma）。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| CapabilityService | services/capability.service.ts | 能力管理服务，负责能力的增删改查、同步与市场功能（发布/购买/评价） |

## 依赖关系

**上游（本目录依赖）**
- `@dommaker/studio-shared`：提供 `FileStore`（JSON 文件存储基础）和 `logger`
- `@dommaker/harness`：提供 `getRegistryPath`（获取注册表路径）
- 标准库：`fs`, `path`, `os`

**下游（依赖本目录）**
- `apps/api/src/modules/capabilities/routes.ts`：API 路由模块，使用 CapabilityService

## 注意事项

- 能力数据存储在 `~/.studio/capabilities/{name}.json`，文件命名需唯一
- 所有时间戳使用 ISO 字符串格式（`createdAt`/`updatedAt`）
