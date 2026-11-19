# #524 实现包 P1：读口倒扫 + index append-only + replay buffer 过滤

- 票：#524（Parent #504，ADR docs/adr/2026-09-12-channel-mainline-optimization.md）
- 决议权威：#514 / #517 项 1 / #516 项⑥ 的 resolution comment
- 日期：2026-09-12

## AC（票体三点细化）

1. **读口倒扫**：2.46 万行测试数据重跑走查②基准（`apps/api/bench/route-dispatch-merge-window.ts`，50x 档），合并窗口查询与 getMessageById 读口 ≤1ms 量级（median）。
2. **写侧 append-only**：commitSnapshot 改「append 一行 upsert/tombstone + 定期压实」，bench 加 WU 数扫档（1x/100x/500x），写侧耗时 median 不随 WU 数线性增长。
3. **replay buffer 过滤**：`workunit.execution.stream` 不进 500 条共享 replay buffer（sse.routes.ts 入队处一处过滤），直播照常；高 stream 负载后重连，关键事件补发齐全（测试锁定）。

## 设计要点

### P1-1 读口（file-store.ts）

- 新增 `readMessagesTail(channelId, { limit, match? })` → `{ messages（新→旧）, exhausted }`：
  复用 `iterateJsonlLinesBackward`；去重/tombstone 口径 = 同 id 先见（最新）为准、`deleted` 行作废整条并占位防复活；**不按 createdAt 早停**（更新-append 使文件序≠时间序，#514 已坐实）。
- `findMergeTargetWorkUnit`：`queryMessages(human,20)` 全热读 → `readMessagesTail(human, 20)`，取首条带 workUnitId（D 方案，#514 定案口径）。
- `getMessageById(messageId, channelId?)`：有 channelId → 本频道倒扫首见定夺（tombstone → null）；无 → 保留全频道扇出（冷路径兼容）。调用点迁移：replyTo（message-routing）、convert-to-task suggest（channel.routes）、convert（convert-to-task.service）、createFromMessage（workunit-crud，路由 body 加 channelId 透传）。
- `linkWorkUnit(messageId, workUnitId, channelId)`：签名加 channelId（必填），调用点全部迁移（message-routing×2、workunit-crud、convert-to-task、测试）。
- `queryMessages` 尾部快径：`limit` 且无 workUnitId/authorType/since 过滤 → 倒扫切片（页内按 createdAt 升序）。
- `queryMessagesPage` 首页（无 before）快径：倒扫 limit+1 条；热未穷举 → hasMore 恒真、不补冷、total 热部走字节快扫行数（方向安全偏多，口径同冷侧）；热穷举 → 行为与原逐条一致。before 深页路径不动。

### P1-2 index append-only（file-store-workunit.ts）

- index.json 改 JSONL：upsert 追加快照行、remove 追加 `{id, deleted:true}` 墓碑行；读侧 fold（同 id 后行覆盖前行、墓碑删除、首现位置序）。
- 旧格式（JSON 数组）兼容：读侧首字符 `[` 走旧解析（严格抛错保留）；写侧首个 append 前锁内迁移重写为 JSONL。
- 定期压实：`indexCompaction` 选项（checkInterval 500 / minLines 5000 / deadRatio 0.3，同 #319 messages 先例），锁内评估，命中 → writeJsonl 全量压实。
- fsync：append 路径本就不 fsync（appendJsonl），全量重写随每写取消——崩溃撕裂行读侧跳过，启动 reconcileIndex（events 正本）重建兜底。
- claimWorkUnit / flushWorkUnitLeases / updateMetadata / createSnapshotGuarded 全部走 append；rebuildIndex / reconcileIndex 的重建写 = 压实写（writeJsonl）。
- 导出 `parseWorkUnitIndexContent`（legacy 数组 + JSONL fold 双格式）供 bench/脚本直读方迁移：route-dispatch-merge-window、mainline-align、loop-read-worker、synthesize-dataset。

### P1-3 replay buffer（sse.routes.ts）

- 入队处过滤 `workunit.execution.stream`：不 push 进 buffer（不占 seq），直播广播照常（id 用 currentSeq，游标语义不变）。

## 验证

- 各阶段 TDD：先 FAIL 测试后实现；相关 vitest 包全绿。
- `pnpm typecheck` + `pnpm lint` 无新错。
- 走查② bench 复跑（50x=24.6K 行 + wuscales 扫档）出验收数字。

## 提交批次

1. P1-1 存储层 + 调用点迁移（含本计划文档）
2. P1-2 index append-only（含直读方迁移）
3. P1-3 replay 过滤
4. bench 更新 + 验收数据 + CONTEXT.md 同步
