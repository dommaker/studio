# spec-reviews

> 此文件描述 apps/api/src/modules/spec-reviews 目录的职责和上下文

## 职责

该模块提供 Spec 审查相关的 API 路由和后端服务，包括创建审查、查询审查、获取详情、提交审批等核心功能，支持绕过审批操作，并触发通知。数据持久化使用 FileStore（文件存储）替代原有 Prisma 依赖。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router`（默认导出） | `routes.ts` | Express Router，注册 `/api/v1/spec-reviews` 相关 REST 接口（GET 列表/详情、POST 创建） |
| `specReviewService` | `spec-review.service.ts` | 业务服务对象，封装审查的 CRUD 逻辑及审批提交、通知触发 |

## 依赖关系

**上游（本目录依赖）**
- `@dommaker/studio-shared` 提供 `FileStore`（文件存储）和 `logger`（日志）
- `@dommaker/studio-notification` 提供 `notificationService`（通知服务）
- Node.js 标准库 `node:path`、`node:os`、`node:fs`

**下游（依赖本目录）**
- `apps/api/src/route-registry.ts`：使用本目录的 `routes.ts` 注册到主路由

## 注意事项

- 审查数据存储在 `~/.studio/data/spec-reviews/` 目录下，以 JSON 文件形式持久化，部署时需确保该目录可写
- 使用 `ensureDir` 异步创建目录，写操作前均需保证目录存在
- 路由层做参数校验（如 `title`、`changes` 必填），业务层通过 `specReviewService` 处理逻辑，错误统一以 HTTP 500 返回
- 迁移自 Prisma，旧数据需手动迁移或重建；当前不兼容外部数据库
- **鉴权（2026-07-24 收紧）**：POST /、PATCH /:id、POST /:id/approve 已收 requireAuth+requireNotGuest。approve 的 role/reviewerId 为 body 自声明、不与 req.user 绑定，属已知局限（未修）。
