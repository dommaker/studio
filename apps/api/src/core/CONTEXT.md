# apps/api/src/core

### 职责

API 内核横切层：HTTP 契约装配（http.ts defineRoute）+ 进程级 FileStore 唯一获取口（store.ts）。目标架构（docs/architecture/target-architecture.md）：`core/` 承载路由契约与存储边界两条硬规则的落点。

### 核心导出

- `http.ts` — `defineRoute`（契约驱动路由：zod 入参校验 / response 推导 handler 返回类型 / 测试与开发响应校验 / envelope `{ data }` / `{ error }` / 分页壳）、`withStatus`（非默认成功分支，配 RouteOptions.responses 校验并进 OpenAPI）、`HttpError`、`paginated`、`makePagination`（P2.3：paginated() 配套元信息助手，收敛全仓手搓 `Math.ceil(total/limit)`；纯委托不 clamp，limit=0 原样透出 Infinity——skills 域未校验 NaN/0 系契约注释明言保留的旧行为）、`requireHuman`、`ROUTE_SCHEMA_META`（defineRoute 挂在返回 handler 上的 schema 元数据 Symbol 键，含 response，OpenAPI 派生用，见 ../openapi/）
- `system-role.ts` — `STUDIO_ROLE_NAME` / `isSystemRole()`（P2-c 自 agents 下沉：agents/channels 双方消费的系统角色身份断言纯原语；2026-10-16 批次 F 三轨归一——agents 侧 re-export 壳与 agent-profile.service 二次 re-export 均已删，agents 内部与 agents barrel 全直引本文件）
- `proc-probes.ts` — /proc 系统探测单出口（P2-c 自 agents/ops 下沉：零子进程 statfs/meminfo/loadavg/cmdline 原语，agents 与 knowledge/env-snapper 双方消费；agents 内经 `modules/agents/ops/proc-probes.ts` 门面转介）
- `exec-async.ts` — 轮内异步子进程包装（P2-d 自 agents/monitor 下沉：回调式 exec/execFile 的 Promise 版 + #411 exec 段计时；loop/monitor/triage 消费，SEC-03 起 pmo/delivery 与 workunit/merge-on-review-pass 的 Git 也统一经 `execFileAsync` 参数数组，禁同步 exec 阻塞事件循环）
- `host-execution-policy.ts` — SEC-01 WorkUnit/Spec 共用宿主执行边界：服务端固定检查 ID → argv（`test`/`typecheck`/`lint` 分别直调 `pnpm exec vitest run` / `pnpm exec tsc --noEmit` / `pnpm exec eslint .`），经 shared `execFile` 无 shell 执行，不经过 package.json scripts；另有 WU worktree 词法+realpath 归属校验、Spec 文件路径项目根约束、白名单 env/10min 超时/1MiB stdout+stderr 合计 UTF-8 字节上限。HTTP、项目文件与 metadata 均不能提供命令文本/参数/cwd/env；package.json 只凭 scripts 键是否存在决定启用哪项检查，脚本体与 lockfile 不改变 argv。SEC-04 起 `runHostCheck` 只接受已校验目录 capability 并直接使用其 cwd，不再 realpath 回原路径；`runWuVerification` 在断言后持有 capability 完成 package.json 读取、模板选择和执行，合并场景复用已有 capability。
- `wu-verification.ts` — ARCH-02 自 agent-loop 下沉的独立 WU 验证能力：`CODE_WORKTREE_TYPES` / `resolveVerifyCommands` / `runWuVerification`；AgentLoop 经兼容出口复用，WorkUnit 经 verification 端口装配。SEC-01/04 的固定 argv、worktree provenance 与目录 capability 边界不变；新验证报告记录检查 ID（`test`/`typecheck`/`lint`），不再保存 shell 命令串。
- `store.ts` — `initStore(root?)` / `getStore()` / `resetStoreForTesting()`（P2-b）：apps/api 进程级 FileStore 唯一获取口；`initStore()` 由 bootstrap 在 initConfig 后、迁移前调一次钉定（并同步钉定 packages 持有器，生产态 api 与 packages 共享同一实例），`getStore()` 为消费方唯一入口。构造必须经本模块对 `@dommaker/studio-shared` 的 import 发生——37 个测试 vi.mock 该 specifier 换 mock FileStore，委托包内持有器构造会让 mock 全灭；packages 消费方走 studio-shared `file-store-default.ts` 的 `getDefaultFileStore()`
- `replay-guard.ts` — SEC-09 webhook 持久重放台账：`ReplayGuard.claim/complete/release` 共用 `data/webhook-replays.lock` 跨进程锁，锁内 `readJsonUncached` 裸读 `data/webhook-replays.json`；同批 key 原子 claim。delivery/interaction 完成记录 24h TTL，新 claim 时清理过期项；deploy commit 完成记录永久保留。processing 无 TTL、跨重启不自动重新执行；release 只准用于调用方已证明零业务副作用的路径。complete 失败或可能部分成功时保留 processing/完成记录，防止自动重试；副作用后崩溃在 complete 前也会留下 processing，须人工核对实际结果后处理台账。

### 注意事项

- **FileStore 硬规则（P2-b，2026-09-30）**：生产代码禁止无参 `new FileStore()`（eslint `no-restricted-syntax` error 级固化，显式 root 构造与测试豁免）；消费方一律函数内 `getStore()` 调用时获取——**禁止模块级捕获**（`const s = getStore()` 顶格声明会冻结实例，import 时机早于 initStore 钉定时虽因 env 缓存同根不漂，但属于被禁模式）；历史模块级单例已全部惰性化，仅 2 处例外保留导出形态 = 测试 vi.mock 锚点（`mcp/tool-store.ts` 的 `fileStore`、`agents/loop/agent-loop-events.ts` 的 `metricsFileStore`，实例均来自 getStore() 同一进程级单例）
- **initStore 无参 = 复用 env 解析根的缓存实例**（STUDIO_DATA_DIR ?? STUDIO_HOME/data），保证 import 期已发生的 getStore() 与钉定后是同一实例；未 init 时 getStore() 惰性兜底，语义与历史 `new FileStore()` 等价（vitest 隔离 setup / 动态 env 测试依赖）
- **SEC-09 生产全量 5xx 脱敏**：未处理异常、显式 HttpError(5xx)、映射 5xx 均只回 `Internal server error + requestId`，保留各自 HTTP status/code；requestId 复用认证/审计已落 req 的值或 `x-request-id`，缺省生成并回填 req，详细 error 与该 id 仅写服务端 logger。非生产仍回原始诊断 message；所有 4xx（HttpError、映射业务错误、Zod）契约不变。
- **ARCH-01 响应契约接回真实路由**：`defineRoute({ response })` 接收完整成功壳，普通响应推导 handler 返回 `data`、分页响应推导完整 `paginated()` 形状；`withStatus` 非默认分支由 `RouteOptions.responses` 提供契约（WorkUnit verify 422 已覆盖）。测试/开发环境在写回前校验，失败按 500 处理，生产保持原有序列化与 5xx 脱敏。OpenAPI 优先消费同一 route meta；Auth/WorkUnit 已迁移，其他域暂由 response-map 兜底，未声明端点只准落入显式覆盖清单。
- **SEC-07 Operator 人工动作边界**：`requireHuman` 只认认证投影 `req.user.actorType === 'Operator'`；body/header 的 `authorType` 仅保留为展示与路由元数据，不参与授权。Admin 与本地免登录身份映射 Operator；真实内部无转发头回环调用由 `requireLocalhost` 投影 `system:localhost`，Agent 由 SEC-05 callback 投影，二者即使伪造或省略 `authorType` 也在 handler 前 403。WU verify/review/status 与 PMO deliver/mark-delivered 均经此同一守卫。
