# apps/api/src/core

### 职责

API 内核横切层：HTTP 契约装配（http.ts defineRoute）+ 进程级 FileStore 唯一获取口（store.ts）。目标架构（docs/architecture/target-architecture.md）：`core/` 承载路由契约与存储边界两条硬规则的落点。

### 核心导出

- `http.ts` — `defineRoute`（契约驱动路由：zod 校验 / envelope `{ data }` / `{ error }` / 分页壳）、`HttpError`、`paginated`、`requireHuman`
- `system-role.ts` — `STUDIO_ROLE_NAME` / `isSystemRole()`（P2-c 自 agents 下沉：agents/channels 双方消费的系统角色身份断言纯原语；agents 内经 `modules/agents/system-role.ts` 门面转介）
- `proc-probes.ts` — /proc 系统探测单出口（P2-c 自 agents/ops 下沉：零子进程 statfs/meminfo/loadavg/cmdline 原语，agents 与 knowledge/env-snapper 双方消费；agents 内经 `modules/agents/ops/proc-probes.ts` 门面转介）
- `store.ts` — `initStore(root?)` / `getStore()` / `resetStoreForTesting()`（P2-b）：apps/api 进程级 FileStore 唯一获取口；`initStore()` 由 bootstrap 在 initConfig 后、迁移前调一次钉定（并同步钉定 packages 持有器，生产态 api 与 packages 共享同一实例），`getStore()` 为消费方唯一入口。构造必须经本模块对 `@dommaker/studio-shared` 的 import 发生——37 个测试 vi.mock 该 specifier 换 mock FileStore，委托包内持有器构造会让 mock 全灭；packages 消费方走 studio-shared `file-store-default.ts` 的 `getDefaultFileStore()`

### 注意事项

- **FileStore 硬规则（P2-b，2026-09-30）**：生产代码禁止无参 `new FileStore()`（eslint `no-restricted-syntax` error 级固化，显式 root 构造与测试豁免）；消费方一律函数内 `getStore()` 调用时获取——**禁止模块级捕获**（`const s = getStore()` 顶格声明会冻结实例，import 时机早于 initStore 钉定时虽因 env 缓存同根不漂，但属于被禁模式）；历史模块级单例已全部惰性化，仅 2 处例外保留导出形态 = 测试 vi.mock 锚点（`mcp/tool-store.ts` 的 `fileStore`、`agents/loop/agent-loop-events.ts` 的 `metricsFileStore`，实例均来自 getStore() 同一进程级单例）
- **initStore 无参 = 复用 env 解析根的缓存实例**（STUDIO_DATA_DIR ?? STUDIO_HOME/data），保证 import 期已发生的 getStore() 与钉定后是同一实例；未 init 时 getStore() 惰性兜底，语义与历史 `new FileStore()` 等价（vitest 隔离 setup / 动态 env 测试依赖）
