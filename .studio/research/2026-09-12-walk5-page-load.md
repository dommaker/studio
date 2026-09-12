# 走查⑤ 页面加载：消息分页与读路径成本（#510）

- 日期：2026-09-12 ｜ 分支：research/walk5-page-load ｜ 方法：代码走查 + bench 实测
- bench：`apps/api/bench/walk5-page-load.ts`（本分支新增），`cd apps/api && node_modules/.bin/tsx bench/walk5-page-load.ts` 可复跑
- 测量纪律：~/.studio 全程只读；合成规模（5k/20k/50k 行热层、12 冷月×1000 行）在 tmp 目录生成；读口耗时拆分走 #323 read-metrics 埋点（stat/readParse/clone 三段）
- 现实规模基线（2026-09-12 实测 ~/.studio）：3 频道共 496K；最大频道 sys = 热 492 行/272KB + 冷 1 月 79 行/87KB；19 agents / 8 profiles；studio-events.jsonl 250KB；knowledge 18MB

## 结论先行

1. **四个嫌疑点在现实数据规模下全部不构成问题**。消息分页 store 层 warm p50 = 3.2ms（热 492 行）；monitoring 四端点 warm 全部 ≤ 11ms；SSE 兜底轮询每页面每分钟 6 次 × ~3ms，CPU 占比 <0.1%。
2. **嫌疑点①（全热读+clone+sort）是真实的线性增长隐患，当前无感**：warm 成本随热层行数近似线性——492 行 3.2ms → 5k 行 27ms → 20k 行 90ms → 50k 行 252ms。structuredClone 占 55-60%，merge+全量 sort 占其余大头。热层按 30 天归档有界（`file-store.ts:219` MESSAGE_ARCHIVE_MAX_AGE_DAYS=30），当前节奏约 500 行/30 天，要 10 倍以上活跃度才到 5k 行档。
3. **嫌疑点②（countColdLines 扫冷月算 total）是纯粹的浪费型代码，但现实成本微小**：每请求不缓存字节扫全部冷月，只为算前端不消费的 `total`（`file-store.ts:866-868` 注释自述）。实测 12 月×1000 行（~6.3MB）≈ 12-16ms/请求；现实 1 月 87KB → 亚毫秒。
4. **消息端点不该挂 apiCache**：现实规模无收益（warm 3ms 级），且与 SSE 断线兜底轮询的语义直接冲突——兜底轮询存在的意义就是拿新消息，TTL 缓存会在窗口内喂陈旧首页（见下「apiCache 判定」）。
5. 附带发现：**深冷页成本与锚深成正比**（符合 `file-store.ts:918-919` 设计注释）：锚在最老冷月时 12 月×1000 行 warm 69ms/页，每请求对全部 12 个冷月做 cache-hit 全量 clone。前端 loadMore 逐页翻历史时逐页付此价；现实冷数据 1 月 79 行，无感。

## 分嫌疑点发现

### ① queryMessagesPage 全热文件读入 + 全量 sort 再切 50 条（`packages/studio-shared/src/file-store.ts:870-938`）

机制确认：

- `file-store.ts:871` resolveActiveMessages → readJsonl 全热文件读入；**cache hit 也全量 structuredClone**（`file-store.ts:334-337` cloneCached）
- `file-store.ts:873` 全量 sort，比较器 `new Date(a.createdAt).getTime()` 每次比较 2 次 Date 解析（O(n·log n) 次解析）
- 切片只取最后 50 条（`file-store.ts:881`）

实测（read-metrics 三段拆分，warm = jsonlCache 命中）：

| 热层行数 | cold 首调 | warm p50 | warm mean | 其中 clone/次 | 残余（merge+sort 等）/次 |
|---|---|---|---|---|---|
| 492（真实 1x，含 1 冷月） | 20.6ms | 3.2ms | 4.3ms | 1.25ms | ~1.1ms |
| 5,000 | 43.5ms | 26.9ms | 29.2ms | 16.3ms | ~10ms |
| 20,000 | 159.1ms | 90.5ms | 92.0ms | 52.7ms | ~37ms |
| 50,000 | 407.4ms | 252.3ms | 262.1ms | 160.5ms | ~91ms |

- 生产端 HTTP 端到端实测（systemd studio-api，sys 频道）：warm 13-21ms，偶发 96ms（事件循环共享，agent loop 同进程）；store 层占其中 ~3ms
- **判定：真问题（条件性）**。当前 1x 可忽略；增长是线性的且无分页内化（尾读）兜底，热层行数 = 30 天消息量，活跃度上一个量级即进 5k 行档（27ms/请求）

### ② countColdLines 每请求字节扫全部冷月算 total（`file-store.ts:959-965`，调用点 `:876-877`）

- 机制确认：`queryMessagesPage` 每请求无条件调 countColdLines（`:876`），逐月 countFileLines 64KB 块字节扫数 LF（`:985-1010`），**结果不缓存**；`total = 热 + 冷原始行数` 仅作响应字段，前端不消费（`:866-868` 注释自述「前端不消费 total」）
- 实测隔离（同热层、冷 12 月×1000 行 ~6.3MB vs 无冷，warm p50 之差）：5k 热 43.2−26.9 ≈ **16ms/请求**；20k 热 102.9−90.5 ≈ **12ms/请求**。真实 1x（1 冷月 87KB）：亚毫秒（含在 A1 的 3.2ms 内）
- **判定：真问题但当前成本微小**。属于「为无人消费的字段每请求付全量冷历史扫描」，冷月累积后线性变贵，且是最容易消除的一类（total 惰性化或缓存）

### ④ SSE 断线 10s 兜底轮询叠加全热扫（`apps/web/src/hooks/useChannelEvents.ts:95`）

- 机制确认：`useGatedPoll(fetchMessages, 10000)`，门禁 = 页面 visible ∧ SSE status ≠ 'connected'（`useGatedPoll.ts:35`），每次轮询 = 一次首页全量拉取（`channelApi.listMessages`，走嫌疑点①路径）
- 成本核算：单页面 6 次/分钟 × warm p50 3.2ms（store 层，真实 1x）≈ 19ms/分钟，单核占比 <0.1%；即便 20k 行档也就 90ms×6 = 0.54s/分钟 ≈ 单核 0.9%
- **判定：可忽略**。兜底语义正确（只在 SSE 断开时启用），成本完全继承①，①不修它不贵、①修了它更便宜

### ⑤ monitoring 四端点无缓存每请求重聚合（`apps/api/src/modules/monitoring/monitoring.routes.ts:12-53`）

机制确认：四端点确实无 apiCache；但底层 FileStore 读穿缓存（readJson/readJsonl mtime 校验）+ knowledge MtimeMemoKnowledgeStore（#343）已承担「不重复读盘」。每请求重付的是 clone + 聚合 + （/overhead、/flywheel 的）窗口事件尾读。

实测（真实 1x，warm = 进程内缓存热）：

| 端点 | cold 首调 | warm p50 | 说明 |
|---|---|---|---|
| /agents（getAgentSummary） | 17.3ms | 1.6ms | 19 state + 8 profile + WU 上下文，全走 FileStore 缓存 |
| /stats（getStats） | 3.5ms | 1.0ms | listStates + WU index，全缓存 |
| /overhead（getOverheadStats） | 23.2ms | 4.9ms | 窗口尾读 studio-events（250KB）**不缓存**，每请求重扫 30d 窗口 |
| /flywheel ≈ store.list 1.7ms + scanKnowledgeEvents 4.5ms + computeOutcomeMetrics 4.5ms | 46.2+6.1+5.6ms | **~11ms** | memo 指纹校验 1.7ms；两次窗口事件扫描不缓存，各 ~4.5ms |

（/flywheel 未直接测 knowledgeService 单例——`knowledge-singletons.ts:43-46` 装载期有 `pkill mcp-local-rag ingest` 副作用，bench 进程不可引入；改为实测其两个成本组件后相加，组件实现路径：`knowledge-service.ts:1012-1027, 1043-1071` → `knowledge-metrics.ts:265, 327`。/agents 的 listProjects 用等价直读 stub 替代 lazy import project.service，读量一致。）

- **判定：可忽略（现实规模）**。监控页低频访问，warm 全部 ≤ 11ms；同文件 /overview、/efficiency 已有 60s 缓存先例（`monitoring.routes.ts:59-85` 注释），若要省也是照抄既有口径而非新机制

### 附带：深冷页成本（`file-store.ts:918-937`）

锚在最老冷月时 iterateColdMessages 须先扫过全部较新冷月才到锚点：合成 12 月×1000 行，warm 69ms/页（每请求 15 个读口事件、cache-hit 全量 clone 27ms/次 + 12k 行 merge/sort 残余 ~40ms）。符合候选 8 注释「成本与页深成正比」（`:943`）的设计口径，非 bug；现实冷数据量下无感。

## 消息端点该不该挂 apiCache —— 不该（当前）

1. **无收益**：真实规模 store 层 warm 3.2ms、HTTP 端到端 13-21ms；缓存省的是个位数 ms
2. **语义冲突**：10s 兜底轮询（④）的存在意义是 SSE 断线时拿到**新**消息；apiCache 按 TTL 喂陈旧首页（`api-cache.ts:19-47`，无写时失效除非逐路由接 clearCache），等于在兜底路径上自相矛盾地降低新鲜度
3. **正确修点在存储层不在响应层**：若热层长大到咬人，该做的是首页尾读/省 total/排序快照（下表），响应缓存会把这些真正修复的必要性掩盖掉

## 候选优化手段清单（只列，不评判优先级）

- queryMessagesPage 首页（无 before）改走 readJsonlTail 尾部倒读：热行数 > limit 时只读尾部 limit+1 行即可出页 + 判 hasMore，省全量读/clone/sort；同模式先例已有 getChannelVersion（`file-store.ts:776-783`）与 getMessagesSince（`:795-821`）
- 热层排序快照缓存：mtime 不变时复用 merge+sort 后的有序数组，每请求只 clone 切出的 50 条（消除嫌疑点①的 clone+sort 双大头）
- total 惰性化：路由/存储层加 includeTotal 开关，默认跳过 countColdLines（前端本就不消费）
- 冷行数随归档写路径落账（archive 写入时维护 count 元数据），countColdLines 变 O(1) 读
- countColdLines 结果按文件 mtime 走 jsonlCache 同 seam 缓存
- iterateColdMessages 月内改尾部倒读 + 锚查找早停（降低深冷页逐页成本）
- /overhead、/flywheel 的窗口事件扫描加短 TTL memo（照抄 /overview、/efficiency 60s 缓存口径，`monitoring.routes.ts:57,73`）

## 复跑与原始数据

- bench 脚本：`apps/api/bench/walk5-page-load.ts`（本分支）
- 合成数据 tmp 根：`/tmp/walk5-bench-*`（跑完保留，手工清理）
- 生产 HTTP 计时：`curl -w '%{time_total}' http://localhost:13101/api/v1/channels/<id>/messages`（systemd studio-api，PORT=13101）
