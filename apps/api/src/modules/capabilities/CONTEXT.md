# capabilities

> 此文件描述 apps/api/src/modules/capabilities 目录的职责和上下文

## 职责

提供能力注册表的读取与 API 暴露，包括从文件系统加载工具/技能定义，并通过 Express 路由对外提供服务。同时定义能力类型（Capability）和注册表（Registry）接口，支持缓存与阶段（Stage）识别。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router` (默认导出) | routes.ts | Express 路由对象，挂载能力注册表相关 API |
| `Capability` (interface) | routes.ts | 能力项类型，包含名称、类型、分类、描述、路径 |
| `Registry` (interface) | routes.ts | 注册表容器，包含工具列表 |
| `Stage` (type) | routes.ts | 责任链阶段类型（plan/develop/verify/deploy/fix/govern） |
| `loadRegistry()` | routes.ts | 加载并缓存能力注册表的函数 |

## 依赖关系

**上游依赖**：
- express（路由框架）
- @dommaker/harness（获取注册表路径与工具目录）
- @dommaker/studio-capability（CapabilityService）
- @dommaker/studio-shared（FileStore、logger）
- ../../middleware/auth.js（requireNotGuest、requireRole 中间件）
- ../../utils/services.js（createLazyService）

**下游引用**：
- apps/api/src/app.ts（挂载路由）
- apps/api/src/modules/llm/intent-analyzer.ts（可能使用能力信息分析意图）
- apps/api/src/route-registry.ts（注册路由路径）

## 注意事项

- 注册表通过 `loadRegistry()` 同步读取文件系统，缓存 TTL 为 1 分钟，需注意文件变更未及时更新的情况。
- 使用 `createLazyService` 延迟初始化 `CapabilityService`，避免启动时加载无关资源。
- 所有能力 API 均需经过 `requireNotGuest` 和 `requireRole` 中间件鉴权（符合 SEC-001 / SEC-002）。
- `getStageFromYaml` 目前仅定义但未在已有代码片段中调用，需确认实际使用场景。
- 缓存变量 `cachedRegistry` 和 `lastLoadTime` 为模块级，多请求共享，需注意并发访问安全性（当前为同步读取，无锁）.
- **鉴权（2026-07-24 收紧）**：5 条写端点（POST /registry/refresh、/sync、/、/batch、PUT /:capabilityId）已收 requireAuth+requireNotGuest（requireNotGuest 从"仅 import 未使用"变为实际使用）；DELETE 原有 requireRole('Admin') 不变。GET /stages、/registry 响应含工具定义相对路径，属低危信息泄露（未修）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ 2026-07-24: 写端点收 requireAuth+requireNotGuest
- ✅ `008912d6`: db-removal): complete Spec 1 AC-2/3/6 — dead table cleanup
