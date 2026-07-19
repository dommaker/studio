# pmo

> 此文件描述 apps/api/src/modules/pmo 目录的职责和上下文

## 职责

项目管理办公室（PMO）模块，负责 OKR（目标与关键结果）管理与项目管理（项目 CRUD、PMO 号自动生成），并提供 REST API 路由。同时包含已停用的 OKR 异常检测功能（默认不启用）。

## 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `getCurrentQuarter` | `okr.service.ts` | 获取当前季度字符串（如 2025-Q2） |
| `OKRService` 类 | `okr.service.ts` | OKR 核心服务类 |
| `okrService` 实例 | `okr.service.ts` | OKRService 的单例 |
| `projectService` 实例 | `project.service.ts` | 项目服务单例 |
| `parsePmoNumberFromCommand` | `project.service.ts` | 从命令中解析 PMO 号 |
| `PROJECT_STATUS` 常量 | `project.service.ts` | 项目状态枚举 |
| `detectAnomalies` | `okr-anomaly-detector.ts` | OKR 异常检测（默认停用） |
| 默认导出 Express Router | `routes.ts` | 提供 `/project`、`/objective`、`/key-result` 等 REST 路由 |

## 依赖关系

**上游（本目录依赖）**
- `@dommaker/studio-shared`（FileStore、logger、parseFrontmatter 等）
- `../../utils/logger.js`
- `../../middleware/auth.js`（requireNotGuest、requireRole）
- `../../middleware/api-cache.js`（apiCache）
- `../channels/channel-message.service.ts`
- `../workunit/workunit.service.ts`
- Node.js 内置 `os`、`path`、`fs`

**下游（依赖本目录）**
- `agents` 模块（`auditor-rules.ts`）
- `channels` 模块（`channel.routes.ts`）
- `mcp` 模块（`pmo.tools.ts`）
- 路由注册（`route-registry.ts`）

## 注意事项

- OKR 异常检测默认禁用，需设置环境变量 `OKR_ANOMALY_DETECTOR_ENABLED=true` 才能启用。
- 项目数据存储在 `~/.studio/projects/{id}.json`，OKR 数据存储在 `~/.studio/okr/` 目录下的 JSONL 文件中。
- 项目路由已应用 `requireNotGuest` 和 `requireRole` 中间件进行权限控制。
- 项目创建时自动生成 PMO 号（格式为 PMO-{序号}）。
- 所有服务都基于 FileStore（JSON 文件）而非数据库。
- 测试中使用了 mock，注意 mock 目录与测试数据的路径约定。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `0d1ef570`: ci): resolve type errors found by package-level tsc build
- ✅ `1ac014a8`: ci): resolve type errors in worktree-resolver + okr.service
- ✅ `13f60e68`: db-removal): migrate 9 more files from Prisma → FileStore (Round 2)
- ✅ `3de4f489`: ops): code review fixes — Infinity filtering + studioEvent write
- ✅ `c013381b`: pmo): AC-10 column index off-by-one + AC-6 test matcher
- ✅ `9f5c871d`: okr): querySkillUsageRate count skills from disk (B59-003)
- ✅ `a1eb8a3d`: OKR queries — rollback_rate N/A + goal_cost use StudioEvent.costUsd
- ✅ `13cf6b7e`: deploy failure event enrichment + metricType registration
- ✅ `36a91ee2`: O2-KR1 注入命中率接线 — consumption 事件 + metric query
- ✅ `bf4ad33d`: LLM architecture debt — 3-key routing + P0-P2 fixes
- ✅ `f80cfeae`: 203 TypeScript 错误全部清零
- ✅ `78c6856d`: Prisma SQLite auto-parses JSON String fields — handle both string and object
- ✅ `403d82df`: B8 cacheHitRate 公式修正 — cacheHit/(cacheHit+input) 替代 cacheHit/input
