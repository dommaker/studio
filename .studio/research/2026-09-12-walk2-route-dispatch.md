# 走查②路由派单：routeMessage 链路的性能与流程嫌疑（#507）

- 日期：2026-09-12 ・ 票：#507（Part of #504）・ 分支：research/walk2-route-dispatch
- 方法：读码 + 本地 bench（`apps/api/bench/route-dispatch-merge-window.ts`，只读复制真实 `~/.studio/data` → tmp 放大 1x/10x/50x/…/1000x；Node v22.22.0，median of 20-50 rounds）
- 前置状态：#494（派单原子性，方案 c anchorMessageId）、#495（合并窗口）均已 CLOSED（2026-09-11）并落地，本走查针对落地后现状。

## 结论先行

1. **嫌疑点③成立但当前无害，是增长型风险**。`findMergeTargetWorkUnit`（`apps/api/src/modules/channels/message-routing.ts:70`）经 `queryMessages` 全量物化本频道热文件（`packages/studio-shared/src/file-store.ts:828-851` → `:824-826` → `readJsonl :324-362`）。`readJsonl` 有 mtime 读穿缓存，但**稳态每条消息必 miss**：上一条消息（含本频道任何 agent/系统消息）的 `appendMessage` 都精确失效缓存（`file-store.ts:313-316`）。实测 miss 路径成本随行数线性：492 行 3.4ms → 4,920 行 34ms → 24,600 行 222ms（median）。
2. **合并窗口查询可以避免全热读**，且有现成原语：尾部倒扫（`jsonl-tail.ts`，`getChannelVersion`/`getMessagesSince` 已用，file-store.ts:778/803）。实测「倒扫至首条（去重）human+workUnitId 即停」在全部规模档持平 **0.3-0.4ms**，24,000 行时对比现状 276ms ≈ **约 700 倍**；人类消息稀疏的最坏档退化为全文件逐行 parse（131ms vs 222ms，省掉 clone/归并/排序），可用窗口时间早停再降。
3. **更大的隐藏嫌疑在 P1 replyTo 与 P2 linkWorkUnit**：`getMessageById` 扫**全部频道**热文件（`file-store.ts:1244-1261`）。每条线程回复（`message-routing.ts:190`）和每次派单回填（`channel-message.service.ts:224`）各付一次 O(Σ所有频道热文件)——实测暖命中也随总量线性（24K 行时 108ms），而 routeMessage 本来就持有 channelId，父消息/派发消息必在本频道，全频道扇出是浪费。
4. **生产现状：P3 合并窗口路径当前休眠**。3 个频道均无 `defaultProfileId`（`~/.studio/data/channels/*/config.json`），最大频道（sys，492 行）**0 条人类消息**（纯 agent 流量），最后一条人类消息 2026-08-17。即嫌疑点③的实际触发频率目前为零；成本分析是配置启用后的前瞻。
5. **流程优先级本身无需简化**：4 级各有不可替代语义，无冗余读取（P2 return 后才走 P3，`getChannel` 不重复）。可简化的是各环节的**实现方式**（见候选清单），不是链的顺序。
6. **各环节成本（真实 1x 数据，median）**：P1 replyTo ≈ 7-10ms；P2 mention 派单 ≈ 20ms+（其中建 WU `commitSnapshot` 9.4ms、两次 append 7.4ms、linkWorkUnit 内全频道查 1.7ms）；P3 合并 ≈ 6-9ms（查询仅占 0.5-3.4ms）；P4 纯存储 = 一次 append 3.7ms。当前规模全部健康，瓶颈全在「随热文件线性增长」的读口上。

## 分环节发现（成本与必要性）

### P1：replyTo 线程回复（message-routing.ts:189-233）

- 读取：`resolvedFs.getMessageById(replyToId)`（`:190`）→ `file-store.ts:1244-1261`：`readdirCached` 列频道 + **逐频道** `readJsonl` 热文件（Promise.all 并行，取首个命中）。每个文件的命中路径仍要 structuredClone 全量行（`file-store.ts:336`, `cloneCached :168-170`）。
- 实测：真实 1x（3 频道/总 522 行）1.7ms；人类频道放大 1000x（本频道 24K 行）后 afterWrite 109ms / warmHit 108ms——**暖命中也不省**，因为克隆税照付。
- 必要性：线程继承 workUnitId 必要；**全频道扇出不必要**——replyToId 来自本频道 UI，父消息必在本频道（`:1248-1253` 的跨频道查找对路由层是纯浪费）。
- 附带：`resumeWaitingWorkUnit`（`:210`）= WU 点读 0.9ms（`getIndex({id})` filter 下推，file-store.ts:404-429）+ 锁内 metadata 合并写（`waiting-input.ts:83-86`/:131-142），量级数 ms，不随频道消息量增长。

### P2：@mention 派单（message-routing.ts:236-423）

- 读取：`listProfiles({status:'active'})`（`:238`）cold 5.2ms / warm 0.67ms（8 profiles）；`getChannel`（`:239`）warm 0.06ms；REQ 绑定 `resolveReqIdForDispatch`（`:285`）与归属解析 `resolveWorkspaceForWU`（`:299`，`ownership-resolver.ts:60-114`：getRequirement + projectService.get + getChannel，均为缓存 JSON 点读，各步独立容错）。
- 写入：`createHumanMessage`（`:315`）append 3.7ms → `wuService.create`（`:322`）= `commitSnapshot`（`file-store-workunit.ts:254-259`，锁内 appendEvent + 全量索引重写）9.4ms + `publishCreated` 同步触发 loop observe（`workunit-crud.ts:285-295` → `agent-loop.ts:267-282`）→ `linkWorkUnit`（`:372`）= **又一次 getMessageById 全频道扫**（`channel-message.service.ts:224`）+ 第二次 append 3.7ms。
- 必要性：建 WU 与事件发布必要；**linkWorkUnit 的查找不必要**——派发消息记录刚刚由 `:315` 返回（id、channelId、全字段在手），`channel-message.service.ts:223-228` 却重新全频道查一遍再 append。
- #494 原子性现状：方案 c 已落地——先落派发消息、WU metadata 显式携带 `anchorMessageId`（`:312-336`，决策12 路径同构 `:466-486`），认领播报锚点竞态已消，无遗留动作。

### P3：决策12 默认角色 + #495 合并窗口（message-routing.ts:426-500）

- 合并目标查找 `findMergeTargetWorkUnit`（`:65-83`）：`queryMessages(channelId, {authorType:'human', limit:20})`（`:70`）→ **全热文件物化**（readJsonl miss = readFile + 逐行 parse + structuredClone 全量；命中 = stat + structuredClone 全量）→ `mergeActiveRows` 归并 + filter + sort（`file-store.ts:824-851`），最后才 slice(-20)。
- **稳态必 miss 的因果**：频道内任何消息落库（人类闲聊、agent 回复、系统播报）都经 `appendMessage`（`file-store.ts:739-744`）→ `appendJsonl` → `invalidateFileKey`（`:313-316`）。默认角色频道里每条无 @ 消息到达时，上一条消息的写入刚把缓存失效 → miss 全读。实测对照：afterWrite(miss) vs warmHit，24K 行时 276ms vs 122ms（人类频道 1000x 档）。
- 实测线性增长（median）：

  | 规模（sys 频道模板） | B 合并查询(写后) | C 对照(暖) |
  |---|---|---|
  | 1x = 492 行 / 266KB | 3.4ms | 1.4ms |
  | 10x = 4,920 行 / 2.6MB | 34ms | 16.7ms |
  | 50x = 24,600 行 / 13.1MB | 222ms | 88ms |

- 命中后的第二步 WU 点读（`:74`）0.9ms，不随消息量增长，无问题。
- 必要性：合并窗口本身必要（#495 AC：连发闲聊不建 WU 风暴）；**全热读实现不必要**——语义只要「最近一条带 workUnitId 的人类消息」+ 窗口判定（`:71-73`），尾部倒扫 O(窗口内行数) 即可回答。

### P4：纯文本存储（message-routing.ts:502-505）

- 一次 `appendMessage` ≈ 3.7ms（含 per-channel flock + 每 100 次 append 的压实评估，file-store.ts:750-758），O(1) 成本，无嫌疑。

## 嫌疑点③专项：合并窗口查询能否避免全热读——实测对照

候选 = 尾部倒扫（复用 `iterateJsonlLinesBackward`，jsonl-tail.ts；file-store.ts:778/803 已有两个消费先例）。两种停法：

- **D（对齐现语义）**：倒扫收集 20 条（去重）人类消息即停 → 与现 `limit:20` 口径逐字等价。
- **D2（语义收敛）**：倒扫遇第一条（去重）`human+workUnitId` 即停——`:71-72` 本来就只用最后一条。

实测（人类频道 706… 模板，24 行含 3 human / 1 human+wu、距尾 7 行，放大保持分布；median）：

| 规模 | B 现状(写后) | D | D2 |
|---|---|---|---|
| 1x = 24 行 | 0.46ms | 0.31ms | 0.27ms |
| 50x = 1,200 行 | 9.5ms | 0.74ms | 0.37ms |
| 200x = 4,800 行 | 35ms | 1.1ms | 0.39ms |
| 1000x = 24,000 行 / 12.3MB | 276ms | 0.86ms | 0.43ms |

D/D2 全档位持平亚毫秒（扫 20/37 行），24K 行时 ≈ 300-700 倍差距。

**最坏档 caveat（实测）**：频道无（或稀疏）human+workUnitId 消息时，倒扫凑不满即扫到文件头——sys 频道（0 人类消息）50x 档 D=131ms vs B=222ms。仍省掉全量 clone+归并+排序，但逐行 parse 逃不掉。补救：扫到 `createdAt` 超出合并窗口（默认 5 分钟，`:55-58`）的人类消息即可判 null 早停——注意 `#317` 起更新副本（linkWorkUnit/meta 更新）append 在尾而 `createdAt` 不变（`channel-message.service.ts:165-170`），严格 createdAt 序被打破，早停需过量扫描缓冲或接受有界语义偏差。

**语义偏差说明**：现行为「按 createdAt 排序后最后 20 条人类消息中取最后一条带 workUnitId 的」；倒扫首例 = 「append 序最后一条带 workUnitId 的」。两者在更新副本存在时有界偏差（旧消息的更新副本位置靠前但 createdAt 旧）；D 方案保留 20 条上限后与现语义仅差此类副本的排序，方向安全（副本 updatedAt 更近、createdAt 相同，窗口判定不受影响）。

## 流程优先级可否简化

链顺序（replyTo → @mention → 决策12 → 纯存储，`:4-9` 头注 / `:189/:236/:426/:502`）四级语义正交，无可删级：

- replyTo 优先于 @mention：回复里的 @ 不触发派单，是语义决策（线程内对话不新建单），非性能问题，不动。
- P2 return 后才走 P3，`getChannel` 每条消息只调一次（`:239` 与 `:426` 互斥），无重复读。
- `detectMention`（`:38-42`）单次正则，O(内容长度)，可忽略。
- 可简化的在实现层不在链层：P1 的全频道父消息查找、P2 的 linkWorkUnit 重查、P3 的全热读，三处都是「用 O(全量) 的通用读口回答 O(增量) 的问题」。

## 候选优化手段清单（只列，不评判优先级）

1. `findMergeTargetWorkUnit` 改尾部倒扫：复用 `iterateJsonlLinesBackward`，首条（去重）human+workUnitId 即停 + 窗口判定（D2 实测全档位 ~0.4ms）；保留 20 条人类上限对齐现语义（D 方案）。先例：file-store.ts:778/803。
2. 倒扫加窗口时间早停：`createdAt` 超窗的人类消息出现即判 null，稀疏频道最坏档从全文件 parse 降到 O(尾部)；需处理更新副本乱序（过扫缓冲或有界偏差声明）。
3. P1 父消息查找限定本频道：`routeMessage` 已持 channelId，改走本频道查找（新增 `getMessageByIdInChannel` 或 `queryMessages(channelId)` 内 find），把 O(Σ全部频道热文件) 降到 O(本频道)；跨频道 reply 场景需先确认不存在（UI 不产出）。
4. `linkWorkUnit` 免重查：调用方已持完整消息记录时直接 append 更新版，跳过 `getMessageById`（channel-message.service.ts:223-228）；P2 每次派单省一次全频道扫。
5. `queryMessages` 加 tail 快径：`limit` 且无 `since`/`workUnitId` 过滤时走倒扫切片，惠及全部调用方（路由、分页、wu-messenger 等），不只本链路。
6. 合并目标指针化：决策12 建单/合并时把 lastDispatch 消息/WU 指针落频道 config 或独立小文件，查询 O(1)；代价是多写入点一致性维护。
7. WU 索引推导合并目标：`getIndex` 按 channelId+在途状态+defaultProfileId 取最新——锚点语义是消息时间（滑动窗口，`:63` 注释明确），WU.updatedAt 被簿记推进（#493/#499 已踩过同类坑），语义不等价，仅在改窗口语义为「WU 最后活动」时可用。
8. append 侧维护 per-channel 轻量索引（如 human 消息尾部游标）：写入时更新，读取 O(1)；属存储层变更，blast radius 最大，仅在其他手段不足时考虑。

## 附：bench 产物

- 脚本：`apps/api/bench/route-dispatch-merge-window.ts`（本分支；只读 `~/.studio/data` → tmp 合成，不碰生产数据）。
- 原始结果：`/tmp/route-dispatch-bench-mO5z6g/route-dispatch-bench-results.json`（sys 频道 1x/10x/50x）、`/tmp/route-dispatch-bench-cKhIOZ/route-dispatch-bench-results.json`（人类频道 1x/50x/200x/1000x，含 D/D2）。
- 生产数据快照事实：3 频道均无 defaultProfileId；sys 频道 492 行 0 人类消息；WU 索引 49 条；最后人类消息 2026-08-17。
