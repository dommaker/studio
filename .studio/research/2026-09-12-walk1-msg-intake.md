# 走查① 消息进：`POST /:id/messages` 全路径性能与流程嫌疑

- 工单：#506（Part of #504）
- 日期：2026-09-12
- 方法：读代码为主 + 本地 bench（脚本 `bench-msg-intake.mts`，随本报告同分支；运行方式 `/root/projects/studio/node_modules/.bin/tsx bench-msg-intake.mts`，真实 `~/.studio` 只读、写测全在 tmp）
- 机器口径：本机 Linux，studio 仓 `git ls-files` 2099 条，真实数据 = 3 频道（最大 492 行/272KB）、workunits index 49 快照、sessions.json 592KB/966 条

## 结论先行

1. **嫌疑点⑧成立但量级小**：`git ls-files` 缓存 miss 确实发生在发消息请求路径上（`validateFileRefs` 在 `routeMessage` 内、201 响应前被 await，`message-routing.ts:142`），实测 miss 比命中慢约 **4.4ms**（cold 5.34ms vs warm p50 0.96ms），其中子进程本身 p50 **3.42ms**。当前规模（单候选仓、2099 文件）不构成瓶颈；风险在缓存 60s TTL 过期后的首发、多候选仓串行 miss 叠加、大仓场景。
2. **请求路径无同步重 IO**：FileStore 全部读口走 mtime 校验读穿缓存（`file-store.ts:271`/`:324`/`:404`），唯一子进程就是⑧的 `git ls-files`（`file-ref-vocabulary.ts:130-141`）。热路径各环均为毫秒级个位数。
3. **最重的单点是写侧锁**：`appendMessage` p50 **4.52ms**（mkdir flock + owner.json + append + rm，`file-store.ts:739-744`）；`commitSnapshot` 建单 p50 **7.75ms**（flock + appendEvent + **全量 index 重写 + fsync**，`file-store-workunit.ts:254-259`、`:215-225`）。@mention 路径把多次写串行 await，估算整条 30-60ms。
4. **附件上传有事件循环同步阻塞但可接受**：8MB JSON body 的 `JSON.parse` p50 **5.97ms** 同步阻塞（express json，`channel.routes.ts:223`），base64 解码 5MB p50 **0.90ms**（`attachments.ts:70`）。
5. **流程多余环节（小）**：路由层与 routeMessage 重复读 channel；`linkWorkUnit` 已知 channelId 却走全频道扫描的 `getMessageById`；每条消息双发 eventBus 两个频道 + fire-and-forget 动态 import。
6. **鉴权每请求成本随 sessions.json 无界增长**：`requireAuth` 每请求 readJson sessions.json（592KB/966 条，其中 947 条已过期未清理），缓存命中也要 structuredClone 全量，p50 **1.91ms**（`middleware/auth.ts:50-58`、`file-store.ts:283`）。

## 分环节发现（带行号与实测数字）

### 1. 鉴权（`middleware/auth.ts`）

- `requireAuth()` → `verifyToken`（JWT 纯计算）→ `findSessionWithUser`（`auth.ts:50-58`）：每请求 `readJson(sessions.json)` + `readJson(users.json)` 两次存储读。
- 走 FileStore 读穿缓存（mtime 校验），但命中路径仍 `structuredClone` 整个数组（`file-store.ts:283`）：sessions.json 实测 warm p50 **1.91ms**/请求，users.json 0.03ms。cold（mtime 变化后首读）7.23ms。
- 数据观察：966 条 session 中 947 条已过期，文件只涨不清——每请求克隆成本随之线性增长。
- `STUDIO_AUTH=none`（本机缺省）直接短路（`auth.ts:180-183`），上述成本仅生产开启认证时存在。

### 2. 路由入口（`channel.routes.ts:176-218`）

- body 形状校验纯内存；`fileStore.getChannel`（`:193`）走缓存，warm <1ms。
- 多余环节：`getChannel` 在路由层读一次，`routeMessage` 内 mention 路径（`message-routing.ts:239`）与决策 12 路径（`:426`）又各读一次。缓存兜底下每次 <1ms，属冗余非瓶颈。

### 3. routeMessage 各分支（`message-routing.ts`）

- **文件引用校验（嫌疑点⑧入口）**：`:140-158`，`validateFileRefs` await 在响应关键路径上。详见下节。
- **Priority 1 线程回复**：`getMessageById(replyToId)`（`:190`）= 扫全部频道 messages.jsonl（`file-store.ts:1244-1261`，Promise.all 并发读 + mergeActiveRows）。实测 cold **6.10ms** / warm p50 **1.78ms**（3 频道）。频道数与消息量增长会线性放大。随后 `appendMessage`（p50 4.52ms）+ 可能的 `resumeWaitingWorkUnit`。
- **Priority 2 @mention**：串行 await 链 —— `validateFileRefs`（可省时无）→ `listProfiles`+`getChannel`（`:238-239`，两次独立 await 可并行）→ `resolveReqIdForDispatch`（`:285`，最差情况自动新建 REQ = 序号锁 + writeJson）→ `resolveWorkspaceForWU`（`:299`，REQ→PMO 多次缓存读）→ `createHumanMessage`（`:315`，appendMessage ≈4.5ms）→ `wuService.create`（`:322`，commitSnapshot ≈7.8ms）→ `linkWorkUnit`（`:372`，又一次全频道 `getMessageById` + `appendMessage` ≈6-11ms）→ 可能 1-3 条 `postWuSystemMessage`（各一次 appendMessage）。全串行，估 30-60ms/条。
- **Priority 3 合并窗口**：`findMergeTargetWorkUnit`（`:65-83`）→ `queryMessages(human, limit=20)` 实测 warm p50 **1.35ms**（`resolveActiveMessages` 全量归并后过滤，`file-store.ts:828-851`）+ `getById` 读 index（缓存）。
- **Priority 4 纯存储**：仅一次 `appendMessage` ≈4.5ms，整条路径最干净。

### 4. 嫌疑点⑧：file-ref-vocabulary 词表（`file-ref-vocabulary.ts`）

- 机制：`vocabCache` 进程内存 Map，TTL 60s（`:122`、`:146-148`）；miss → `execFile('git', ['ls-files'])`（`:130-141`）在请求路径同步 await（`:151`、`:284`）；失败（非 git 仓）空词表且**失败同样入缓存**防反复 spawn（`:152-158`）。
- 实测（#研发频道，候选集 = `/root/projects/studio`，2099 个被跟踪文件）：
  - `git ls-files` 子进程：p50 **3.42ms**，p95 7.23ms，max 8.69ms（n=30）
  - `validateFileRefs` cold（清缓存 → 请求路径 spawn）：**5.34ms**；warm（TTL 内）：p50 **0.96ms**
  - `computeCandidateRepos` cold 13.18ms（首批 FileStore 读未暖）/ warm p50 0.97ms
- 判定：**属实但当前量级小**。缓解因素：composer 打开 @ 选择器时 `GET /:id/file-vocabulary`（`channel.routes.ts:162-173`）与发送共用同一缓存，正常 UX 下发送时缓存多已被暖；单仓 miss 仅 +4.4ms。放大因素：TTL 仅 60s（静默 1 分钟后首发必 miss）；多候选仓时 `validateFileRefs` 按 ref 串行 `getRepoFiles`（`:278-289`）、`getChannelFileVocabulary` 按仓串行（`:258-260`），N 仓全 miss = N×3.4ms 叠加；大仓（十万级文件）ls-files 输出变大、parse 变重。
- 附带观察：`files.includes(ref.path)`（`:285`）是 O(词表) 线性扫，每 ref 一次；多 ref 同仓重复扫描，词表大时可改 Set（当前 2099 条下无感）。

### 5. 落库（`channel-message.service.ts` + `file-store.ts`）

- `createHumanMessage`：`appendMessage`（`:105`）= per-channel mkdir flock + owner.json 写 + append + rm（`file-store.ts:739-744`、`file-store-base.ts:195-253`），实测 p50 **4.52ms** / p95 10.13ms（n=200）。每 500 次 append 触发一次压实评估（`file-store.ts:750-765`），阈值内均摊可忽略。
- SSE 发布：`eventBus.publish('channel.message_sent')` + `publishSSE` 同事件再发 `'events'` 频道（`channel-message.service.ts:108-109`）——双平面订阅者不同（agent-loop/evolution vs SSE 广播 `sse.routes.ts:60-77`），属设计内双发，但每消息构造两只信封；eventBus 全内存，成本微秒级。
- 每消息 fire-and-forget 动态 `import('../knowledge/preference-observer.js')`（`:112-114`、`:148-150`）：ESM 模块缓存后仅微任务开销，非瓶颈。
- WU 建单 `commitSnapshot`：flock 内 appendEvent + `upsertSnapshotLocked` **全量 index.json 重写 + fsync**（`file-store-workunit.ts:215-225`、`file-store-base.ts:118-134`），实测 index=49 快照时 p50 **7.75ms** / p95 12.63ms。index 增长则线性变差。

### 6. SSE 发布面（`events/sse.routes.ts`）

- 内存订阅 → replay buffer → 按 topic 广播，慢客户端背压断开（`:79-99`）。无 IO、无子进程，非嫌疑。

### 7. 附件上传（`attachments.ts` + `channel.routes.ts:223-240`）

- 上传：JSON base64 体（不引 multipart）。8MB body 的 express `JSON.parse` 实测 p50 **5.97ms** 同步占事件循环；`Buffer.from(base64)` 5MB 解码 p50 **0.90ms**（`attachments.ts:70`）；落盘 `fsp.writeFile` 异步。单图上限 5MB 有 base64 长度预拒（`:67`）。结论：有同步 CPU 段，量级个位数 ms，单用户场景可接受。
- 取图：`fs.existsSync` 同步 stat（`:98`，微秒级）+ `createReadStream` 流式响应 + immutable 缓存头，无问题。

## 候选优化手段清单（只列，不评判优先级）

1. ⑧：`validateFileRefs` 的多仓 `getRepoFiles` 串行改并行（`file-ref-vocabulary.ts:278-289`）；`getChannelFileVocabulary` 同理（`:258-260`）。
2. ⑧：词表结果从 `string[]` 改 `Set`（或配套建 Set 缓存），消 `files.includes` 线性扫（`:285`）。
3. ⑧：发送路径预热——`POST /:id/messages` 带 files 时若 cache miss，可accept 旧值 + 后台刷新（stale-while-revalidate），或把 TTL 与 composer 拉取联动延长。
4. `linkWorkUnit` 增 channelId 直读路径，免全频道扫描（`channel-message.service.ts:223-242` → `file-store.ts:1244-1261`）；调用方本就持有 channelId。
5. @mention 链可并行的环节并行：`listProfiles` ∥ `getChannel`（`message-routing.ts:238-239`）；`reportDroppedRefs` 与后续系统播报目前顺序 await，可收拢。
6. sessions 清理：过期 session 定期 prune 或 readJson 命中路径避免全量 structuredClone（`middleware/auth.ts:50-58`、`file-store.ts:283`）。
7. `getMessageById` 支持 channelId 限定查询（reply 路径 `message-routing.ts:190` 已知 channelId）。
8. 附件上传：8MB JSON.parse 同步段可改流式/multipart 或 worker 解码（`channel.routes.ts:223`、`attachments.ts:70`）。
9. `commitSnapshot` 全量 index 重写 + fsync 随 WU 数线性增长，大 index 时可考虑增量落盘（`file-store-workunit.ts:215-225`）。
10. 路由层与 routeMessage 重复 `getChannel` 可传参消一次（`channel.routes.ts:193` vs `message-routing.ts:239`/`:426`）。
11. 每消息双发 eventBus 两频道（`channel-message.service.ts:108-109`）可评估收敛订阅面；动态 import preference-observer 可上提为模块级。
