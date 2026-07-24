# admin

> 此文件描述 apps/api/src/modules/admin 目录的职责和上下文

## 职责

提供 REST API 端点检查 CLAUDE.md 和 CAPABILITIES.md 的文档新鲜度，包括文件是否存在、最近修改时间、harness 约束检查结果，用于监控文档同步状态。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router` | `docs-freshness.routes.ts` | Express Router，挂载 `GET /` 路由，返回文档新鲜度检查结果（`FreshnessResult` 对象）。 |

## 依赖关系

**上游**：`@dommaker/studio-shared`（logger）、`@dommaker/harness`（checkConstraints）、Node.js 内置 `fs/promises`（readFile、stat）和 `path`（join）。
**下游**：`apps/api/src/route-registry.ts` 导入本目录的 `router` 并注册到主应用路由。

## 注意事项

- 端点路由为 `GET /`，挂载路径在 `route-registry.ts` 中决定（通常为 `/api/v1/admin/docs-freshness`）。
- `CLAUDE.md` 路径硬编码为 `process.cwd() + '/CLAUDE.md'`，部署时需确保工作目录正确。
- harness 约束检查失败时仅记录警告，不中断正常响应。
- 返回的 `harnessCheck` 字段在 harness 不可用时可能缺失，客户端需做可选处理。
- 若 `CLAUDE.md` 不存在，返回 `status: 'missing'` 和创建建议。
- **鉴权（2026-07-24 收紧）**：/api/v1/admin/docs-freshness 挂载层已收 requireAuth+requireAdmin（响应含服务器文件路径存在性/mtime）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ 2026-07-24: 挂载收 requireAuth+requireAdmin
- ✅ `5b274644`: admin): docs-freshness capability_sync filter now matches
