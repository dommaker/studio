# studio-shared

> 此文件描述 packages/studio-shared 目录的职责和上下文

## 职责

跨 apps/packages 的共享层：provider 注册表（agent CLI 定义与 spawn 模板）、FileStore（全部运行时数据的文件存储）、eventBus、共享类型与工具、 harness 运行时。Node-only 能力经 `@dommaker/studio-shared/node` 子路径导出（读 fs，前端不可引）。

## 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `BUILTIN_PROVIDERS` / `ProviderDefinition` | `src/providers.ts` | 内置 4 个 agent CLI 定义（claude/kimi/codex/opencode；openclaw 为 config-only legacy）：binaries、versionArgs、healthProbeArgs、spawn 模板。**codex spawn 模板带 `--dangerously-bypass-hook-trust`（#147 D7：0.147.0 trust 门下非交互 exec 不跑未信任 hook；studio 经 propagateHarnessConfig 自行审查 hook 来源，详见 studio-agent CONTEXT.md「步内前置拦截层」）** |
| `listScanProviders()` / `resolveProviderDefinition()` / `buildArgsFromTemplate()` / `buildHealthProbeCommand()` | `src/providers.ts` | 扫描清单、定义解析（含 GENERIC 兜底）、CLI argv 构建、健康探针命令 |
| `loadProviderRegistry()` / `resetProviderRegistryCache()` | `src/providers.ts` | 内置 + 用户覆盖（`~/.studio/providers.json`）深合并，带缓存；**新增 CLI 扩展点 = 写 providers.json，不改代码** |
| `FileStore` | `src/file-store.ts` | 全部运行时数据的文件存储（原子写 tmp+rename + mkdir 锁 withLock），baseDir 默认 `~/.studio/data`。门面包：类型在 `file-store-types.ts`，JSON/锁原语在 `file-store-base.ts`，WorkUnit 事件溯源在 `file-store-workunit.ts`，channels 编解码在 `channels-codec.ts`，frontmatter 在 `frontmatter.ts`，全部经 file-store.ts re-export。**#170（决策 #65）WorkUnit 锁内复合原语**：`commitSnapshot`（appendEvent+upsertSnapshot 同锁成对）/ `commitRemoval`（墓碑事件+移除同锁；closed+data.deleted=true 墓碑，rebuild 不复活）/ `updateMetadata`（锁内读最新 metadata→mutator→成对落盘，消读-改-写竞态）/ `createSnapshotGuarded`（锁内 check-then-create）/ `reconcileIndex`（events vs index 对账，不一致按事件流重建） |
| `AgentProfileData` / `RuntimeStateData` | `src/file-store.ts` | Agent 身份模型（`{id,name,description,channels(废弃),status,provider,nodeId}`，**无 systemPrompt 字段**）与运行时实例模型 |
| `eventBus` | `src/event-bus*` | 进程内事件总线（agent-profile.created 等触发 AgentLoopRegistry mount） |
| `deriveDisplayState()` / `parseAttestations()` / `withAttestation()` | `src/attestation.ts` | F6 信任证据模型（决策 1）：l1 自动验证 / l2 agent 评审 / l3 人工确认 + 唯一派生口径 |

## 约束

- **F6 派生口径铁律**：WU 状态/证据的所有展示与指标只准调 `deriveDisplayState()`（src/attestation.ts），禁止 UI/API/指标各自读 `metadata.attestations` 自行解释——口径分叉 = 可读性崩坏。改派生规则只能改这一个函数。
- **WorkUnit 写路径铁律（#170，决策 #65）**：events/index 写必须经锁内复合原语——快照写走 `commitSnapshot`（事件+索引同锁成对，禁止锁外分两步），删除走 `commitRemoval`（必须落 closed+deleted 墓碑，否则对账/重建会复活已删 WU），metadata 增量写走 `updateMetadata`（mutator 基于锁内最新值，禁止读时快照全量回写），带前置条件的建单走 `createSnapshotGuarded`。

## 依赖关系

上游：`@dommaker/harness`、`yaml`。
下游：apps/api 各模块、packages/studio-agent、apps/web（仅类型，不可引 `/node` 子路径）。

## 注意事项

- **类型消费走 dist**：package.json `types` 指向 `dist/*.d.ts`（runtime 入口才是 src），改本包类型后须 `pnpm --filter @dommaker/studio-shared build` 重建 dist，否则下游 tsc-gate 报 TS2339（新字段不可见）。
- **FileStore 目录布局**（`~/.studio/data/`）：`agents/{id}/profile.json` + `agents/{id}/state.json`（Agent 身份与运行时实例，永久存在仅可显式 DELETE）；channels/workunits 等同理按域分目录。其他相关路径：`~/.studio/providers.json`（provider 覆盖）、`~/.studio/workspaces/{id}.json`（workspace 记录，内嵌 runtimes）。
- provider 注册表是"装了哪些 CLI"的唯一权威定义：daemon 扫描（`apps/api/src/daemon/cli-scanner.ts`）、本地扫描（`local-workspace.ts`）、spawn（`cli-adapter.ts`）、健康探针（`agent-loop.ts`）全部从这里取定义，新增 CLI 只需 `~/.studio/providers.json`。
- FileStore 写操作全部原子写（tmp+rename），跨进程并发经 `withLock()`（mkdir 锁）。
