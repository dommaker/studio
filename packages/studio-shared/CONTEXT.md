# packages/studio-shared

### 职责

跨 apps/packages 的共享层：provider 注册表（agent CLI 定义与 spawn 模板）、FileStore（全部运行时数据的文件存储）、eventBus、共享类型与工具、 harness 运行时。Node-only 能力经 `@dommaker/studio-shared/node` 子路径导出（读 fs，前端不可引）。

### 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `BUILTIN_PROVIDERS` / `ProviderDefinition` | `src/providers.ts` | 内置 4 个 agent CLI 定义（claude/kimi/codex/opencode；openclaw 为 config-only legacy）：binaries、versionArgs、healthProbeArgs、spawn 模板。**codex spawn 模板带 `--dangerously-bypass-hook-trust`（#147 D7：0.147.0 trust 门下非交互 exec 不跑未信任 hook；studio 经 propagateHarnessConfig 自行审查 hook 来源，详见本文 `packages/studio-agent` 锚点「步内前置拦截层」）** |
| `listScanProviders()` / `resolveProviderDefinition()` / `buildArgsFromTemplate()` / `buildHealthProbeCommand()` | `src/providers.ts` | 扫描清单、定义解析（含 GENERIC 兜底）、CLI argv 构建、健康探针命令 |
| `loadProviderRegistry()` / `resetProviderRegistryCache()` | `src/providers.ts` | 内置 + 用户覆盖（`~/.studio/providers.json`）深合并，带缓存；**新增 CLI 扩展点 = 写 providers.json，不改代码** |
| `FileStore` | `src/file-store.ts` | 全部运行时数据的文件存储（原子写 tmp+rename + mkdir 锁 withLock），baseDir 默认 `~/.studio/data`。门面包：类型在 `file-store-types.ts`，JSON/锁原语在 `file-store-base.ts`，WorkUnit 事件溯源在 `file-store-workunit.ts`，channels 编解码在 `channels-codec.ts`，frontmatter 在 `frontmatter.ts`，全部经 file-store.ts re-export。**#170（决策 #65）WorkUnit 锁内复合原语**：`commitSnapshot`（appendEvent+upsertSnapshot 同锁成对）/ `commitRemoval`（墓碑事件+移除同锁；closed+data.deleted=true 墓碑，rebuild 不复活）/ `updateMetadata`（锁内读最新 metadata→mutator→成对落盘，消读-改-写竞态）/ `createSnapshotGuarded`（锁内 check-then-create）/ `reconcileIndex`（events vs index 对账，不一致按事件流重建）。**#210 锁语义**：withLock 获锁窗口内 owner.json 写入 ENOENT = 锁目录被并发回收，自动重试获取（非致命错）；已知缺口：释放锁（finally rm）无属主校验，超时被回收方可能误删新持有者目录（待单） |
| `AgentProfileData` / `RuntimeStateData` | `src/file-store.ts` | Agent 身份模型（`{id,name,description,channels(废弃),status,provider,nodeId}`，**无 systemPrompt 字段**）与运行时实例模型 |
| `eventBus` | `src/event-bus*` | 进程内事件总线（agent-profile.created 等触发 AgentLoopRegistry mount）。`publish` 同步 emit，async 订阅 handler 为 fire-and-forget——await 发布方（如 createHumanMessage）不等待订阅链完成，消费方需自己的确定性同步点（等业务事件或轮询） |
| `extractProviderUsage()` / `ProviderUsage` | `src/harness/provider-usage.ts` | #134 per-provider usage 提取器（harness 子路径导出）：claude modelUsage 优先 / opencode step_finish.part.tokens / codex turn.completed.usage / kimi stdout 无出口 → null；未知 provider 按 claude schema 兜底 |
| `deriveDisplayState()` / `parseAttestations()` / `withAttestation()` | `src/attestation.ts` | F6 信任证据模型（决策 1）：l1 自动验证 / l2 agent 评审 / l3 人工确认 + 唯一派生口径 |
| `STAGE_TYPES` / `normalizeToStage()` | `src/domain-vocab.ts` | 决策 8 阶段词表单一事实源（8 词；#337 删除死词 `test`——无任何模块创建 type=test WU，移除对 normalizeToStage 小写输入行为中性）。legacy 归一化 feature/bug→implement、task→general；未知值原样通过。词表增删 = 治理变更 |

### 约束

- **F6 派生口径铁律**：WU 状态/证据的所有展示与指标只准调 `deriveDisplayState()`（src/attestation.ts），禁止 UI/API/指标各自读 `metadata.attestations` 自行解释——口径分叉 = 可读性崩坏。改派生规则只能改这一个函数。
- **WorkUnit 写路径铁律（#170，决策 #65）**：events/index 写必须经锁内复合原语——快照写走 `commitSnapshot`（事件+索引同锁成对，禁止锁外分两步），删除走 `commitRemoval`（必须落 closed+deleted 墓碑，否则对账/重建会复活已删 WU），metadata 增量写走 `updateMetadata`（mutator 基于锁内最新值，禁止读时快照全量回写），带前置条件的建单走 `createSnapshotGuarded`。

### 依赖关系

上游：`@dommaker/harness`、`yaml`。
下游：apps/api 各模块、packages/studio-agent、apps/web（仅类型，不可引 `/node` 子路径）。

### 注意事项

- **类型消费走 dist**：package.json `types` 指向 `dist/*.d.ts`（runtime 入口才是 src），改本包类型后须 `pnpm --filter @dommaker/studio-shared build` 重建 dist，否则下游 tsc-gate 报 TS2339（新字段不可见）。
- **FileStore 目录布局**（`~/.studio/data/`）：`agents/{id}/profile.json` + `agents/{id}/state.json`（Agent 身份与运行时实例，共享同一目录 namespace）；channels/workunits 等同理按域分目录。其他相关路径：`~/.studio/providers.json`（provider 覆盖）、`~/.studio/workspaces/{id}.json`（workspace 记录，内嵌 runtimes）。
- **实例目录生命周期闭环（#363，2026-08-26）**：历史死实例只删 state.json 不删目录 → `agents/` 下空目录无界累积（实测 753 目录里 735 是空的，`listStates`/`listProfiles` 每轮空扫全部目录）。闭环三件：① `deleteState` 删 state.json 后判空删目录——目录为空才 rmdir，有 profile.json 或任何其他文件绝不碰（共享 namespace）；② `sweepEmptyAgentDirs()` 一次性存量清扫（同判空条件，幂等，挂载点 = apps/api index.ts 启动段）；③ terminated 实例回收统一归 instance-timeout-scan（apps/api 侧，每 5min 跨角色），agent-loop 的同角色启动清理已拆除。
- provider 注册表是"装了哪些 CLI"的唯一权威定义：daemon 扫描（`apps/api/src/daemon/cli-scanner.ts`）、本地扫描（`local-workspace.ts`）、spawn（`cli-adapter.ts`）、健康探针（`agent-loop.ts`）全部从这里取定义，新增 CLI 只需 `~/.studio/providers.json`。
- FileStore 写操作全部原子写（tmp+rename），跨进程并发经 `withLock()`（mkdir 锁）。
- **读穿缓存 seam（工单 26 A1 + #321 扩展）**：`jsonCache`/`jsonlCache`/`dirCache`/`mdCache` 四个模块级缓存（按绝对路径 key，mtimeMs 校验，跨进程外部写靠 mtime 兜底失效；命中返回结构克隆）。`readDoc`/`readDocWithMtime`（#321：markdown frontmatter+body，后者带校验用 mtimeMs 供调用方兜底链复用同一次 stat）与公开 `readdir`（目录 mtime 校验，ENOENT 抛错语义同 fs）都住这个 seam——聚合只读层（library、sdd-legacy）读外部仓走这里，不得再裸 `fs`。写路径（`writeJson`/`writeDoc`/`appendJsonl` 等）经 `invalidateFileKey` 精确失效 + 清 dirCache。**例外：锁内读保持裸读（#314 D1，ADR 2026-08-24-cache-seam-decision-rules 例外条款），给锁外路径加缓存时不得顺手换掉锁内读。**
- **频道消息存储（#319，2026-08-24）**：`channels/{id}/messages.jsonl` append-only + tombstone，编辑 = 同 id 追加新版。写侧压实：`appendMessage`/`softDeleteMessage` 走 per-channel `messages.lock` 互斥（防压实重写与并发写竞争丢行），每 500 次写评估一次，总行数 ≥5000 且死行占比 ≥30% 时把活消息（每 id 最新版、首现位置序，口径同 `resolveActiveMessages`）原子重写回文件——只清死行不动活消息，阈值可经 `FileStoreOptions.messageCompaction` 注入（测试用小阈值）。新鲜度契约（§4.2）以消息 id 为锚：`getChannelVersion()` 只返回 `lastMessageId`（行号口径已退役——压实会压缩行数），`getMessagesSince(channelId, messageId)` 取锚点后增量；锚点行被压实抹除时保守返回全部活消息（有界误报，绝不漏报）。分页下沉：`queryMessagesPage(channelId, { before: 消息id, limit })` 在存储层切片，`before` 锚点不存在时返回空页不整页错发。
- **频道消息生命周期归档（#327，2026-08-25）**：热/冷两层——热 = `messages.jsonl`，冷 = `archive/messages-YYYY-MM.jsonl`（超龄消息按消息 createdAt 归月，纯 `ChannelMessageData` 行无 tombstone、月内升序）。`archiveChannelMessages()` sweep（挂载点 = apps/api index.ts 轮转调度：启动一次 + 每 24h）：逐频道 `messages.lock` 锁内裸读热文件 → `mergeActiveRows` 归并（顺带压实，同口径）→ 按计龄锚点分区：有 workUnitId 看所属 WU `closedAt` + 30 天（遗产 closedAt 缺失回退 `updatedAt`；WU 悬空回退 createdAt 规则；WU 非 closed 一律保留），无 workUnitId 看自身 `createdAt` + 30 天；写序先冷后热（冷侧追加前按 id 去重吸收崩溃残留，热原子重写）；无超龄不重写热文件；配置 `FileStoreOptions.messageArchive = { maxAgeDays?, now? }`（仿 messageCompaction 注入模式）。`thawWorkUnitMessages(workUnitId)` reopen 解冻：全频道扫 archive/，该 WU 冷行 append 回热（保留原 id/createdAt，热侧已有同 id 不重复）→ 冷文件原子重写剔除；无 archive 目录/无匹配行零成本短路。查询面：`queryAllMessages`/`getMessageById`/`listByWorkUnitId`/`countMessages`/observe 全部热只读（冷数据默认不可见）；仅 `queryMessagesPage` 穿透冷热——遍历链 = 热（新→旧）接冷（月新→旧、月内 createdAt 新→旧），无 before 时热页不足 limit 从冷链补满（热全空时首页直接出冷，滚动穿透历史永远在）、锚在热不足余量从冷续、锚在冷整页从冷出、冷热都没有 → 空页 + hasMore=false（#319 契约不动），跨冷热同 id 新→旧先见为准（热遮蔽冷侧 thaw/崩溃残留）。`WorkUnitSnapshot.closedAt?` 是计龄锚点字段（可选，旧快照兼容；关闭路径写入、reopen 清除，写入点见 workunit 模块 CONTEXT.md）。
