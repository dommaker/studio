# WU 会话簿记双断裂根因调研（续用零命中 + sessionCount 零落盘）

> 前置票：issue #71 调研（`docs/research/wu-session-handoff.md`，2026-08-09）实测两条簿记断裂，
> 本报告定位根因。调研日期 2026-08-09/10。
> 代码行号对 master HEAD（`apps/api/src/modules/agents/loop/agent-loop.ts` 等）；
> 生产数据全部只读（`~/.studio/data/`、`~/.studio/logs/studio-events.jsonl`、
> studio-prod git reflog、journalctl 只读查询），未重启任何服务。

## TL;DR

1. **续用零命中**：直接根因是「首步 120s 超时失败 → `resetUnestablishedSession` 同时抹掉
   `instance.sessionId` 与未落盘的 `metadata.sessionId`」——可观测窗口内每个多步 WU 的非末步
   **全部**精确死于 120s 超时（事件实证 27/28），下一步必然走新会话分支。这是 fed49d2b
   （2026-07-28）引入的**设计内行为**，不是 `agent-loop.ts:559` 守卫本身的 bug。
   但守卫所依赖的 `instance.sessionId` 是**每实例单槽位、跨 WU 共享**，叠加 newest-first 调度
   与「重启即新建 null 实例」，即使超时问题解决，只要同实例并发 >1 个 WU 或发生部署重启，
   续用链照样结构性断裂（代码实证，生产数据无法单独分离此因素）。
2. **sessionCount 零落盘**：不是写入/持久化链路丢字段（链路全程无过滤，已逐环走查）。根因是
   **B5 代码 2026-08-03 20:20 CST 部署后，生产再没发生过一次「成功建立会话」的执行步**：
   65 个有 `sessionId` 的 WU 全部停在 08-03 09:33 CST 之前（B5 部署前 ~11 小时）；部署后唯一
   执行是 PMO-12（08-09）的 3 步，全部 120s 超时失败，`sessionCount` 被
   `resetUnestablishedSession` 按设计从写入增量中删除。**B5 的 MAX_SESSIONS_PER_WU=2
   need_input 防线从未、也不可能曾经触发。**

## 部署与版本基线（先纠正一个事实）

**生产 studio-api.service 跑的是 tsx + 源码，不是 dist。** systemd 单元 ExecStart：

```
node --require .../tsx/dist/preflight.cjs --import .../tsx/dist/loader.mjs src/index.ts
```

（CGroup 实测，PID 3254851，工作目录 `/root/projects/studio-prod`。）因此「dist 构建时间」
（前置报告引为版本证据）与运行版本无关；真实版本锚点是 **studio-prod 的 git reflog +
服务进程启动时间**。studio-prod 是 studio 仓库的 detached worktree，deploy 脚本
（`studio-config/bin/studio-deploy-quick`）= `git reset --hard <commit>` + stop/start 服务，
即**每次 reflog reset ≈ 一次部署+重启**。

关键 commit 与部署时点：

| 时间 (CST) | 事项 | 出处 |
|---|---|---|
| 07-28 09:36 | `fed49d2b` 合入：续用收窄为同 WU 相等判定（guard-and-resume）+ 引入 `resetUnestablishedSession` + claude 续用改 `--resume` | studio git |
| 07-29 18:19 起 | reflog 可见的 checkout（c260b775 等）全部含 fed49d2b（`git merge-base --is-ancestor` 验证） | studio-prod reflog |
| 08-03 19:41 | `2b0859fb` 合入：B5 sessionCount/MAX_SESSIONS_PER_WU + B2 测试守卫 + C3 预算熔断 | studio git |
| 08-03 20:20 | studio-prod checkout `1f6af192`——**首个含 B5 的部署**（此前运行 07-31 的 `6ddc6052`，无 B5、有 guard） | reflog + 祖先验证 |
| 08-08 20:51 | 机器重启，journalctl 更早日志丢失（`--list-boots` 仅余本次 boot） | journalctl |
| 08-09 15:21 | checkout `10e045eb` + 服务重启（当前进程，6 个 role loop 全部新建 sessionId=null 实例） | reflog + journalctl |

## 断裂 1：续用零命中

### instance.sessionId 完整生命周期（代码走查，行号为 master HEAD）

- **创建即 null**：`AgentLoop.start()` 每次都新建 RuntimeInstance（`agent-loop.ts:186-200`），
  `sessionId: null`；旧实例被 stale 清理/单活守卫 terminate（:145-183），进程**从不继承**
  上一实例的 sessionId。→ 每次服务重启/部署，全部在途 WU 的续用链必然孤儿化。
- **写入**：仅在新建会话分支——`fileStore.updateState(instance.id, {sessionId})` + 内存
  `this.instance.sessionId = newSessionId`（:584-587）。**单槽位**：一个实例同时服务多个 WU
  时，任何 WU 的新建会话都覆盖这个槽。
- **读取**：续用守卫 `metadata.sessionId === this.instance.sessionId`（:559-561）。
- **清除路径 A（直接根因）**：`resetUnestablishedSession`（:985-993）——首步失败
  （worktree 创建失败 :652 / CLI success=false :753 / 抛异常 :866）时
  `instance.sessionId=null` 且 `delete metadataUpdates.sessionId/sessionCount`。
- **清除路径 B（死代码）**：`checkSessionTruncation`（:996-1020）解析 `result.outputText`
  找顶层 `{"type":"usage"}` 行——但 `outputText` 是 extractResult 后的纯文本、不含
  stream-json 事件行（同文件 :784-786 注释自述），生产日志与 105 个 transcript 中也
  grep 不到任何 `"type":"usage"` 行。**该防线从未触发过**（SESSION_TOKEN_LIMIT=100K，:64）。
- **隐式清除 C**：同实例另一个 WU 的新建会话直接覆盖槽位（:585-586），无需任何失败。

调度侧放大器：`resolveTarget` 优先 2 取 `myActive` 中**最新创建**的 active WU
（`agent-loop.ts:422-426` 按 createdAt 倒序 + `agent-loop-parsers.ts:62` 取首个）。
批量到单（如 token-burn 事故期每小时 :17 一批）时，同实例在多个 WU 间来回切换，
每个 WU 的第一步都把别的 WU 的续用链打断。

### 生产数据验证

**(a) 事件窗口（08-02 ~ 08-09）逐步时长**：`session:start`/`session:end` 配对的 32 个执行步
中 **27 个时长精确 = 120.0s**（timeoutMs=120_000 硬杀，:703），且全部是所属 WU 的**非末步**；
5 个成功步（21s/73s/80s/91s/92s）全部是所属 WU 的**最后一步**。即：没有任何一个 WU 有过
「成功步之后再走一步」——续用前提（上一步成功且会话仍在）在生产从未成立。

| WU | 步时长序列 (s) | 结局 |
|---|---|---|
| 6613057d（08-02） | 120, 120, 120 | 3 连败 closed |
| d5efbf96（08-02） | 120, 21 | step2 complete |
| 184c7d56（08-02） | 120, 120, 73 | step3 complete |
| 3a86c8c0（PMO-12，08-09） | 120, 120, 120 | consecutiveStuck≥3 blocked |

**(b) d5efbf96 逐步取证**（`studio-events.jsonl` + `workunits/index.json`）：
step1 20:17:47 起、20:19:47 止（=120.0s，超时）→ 重置；step2 20:20:03 走新会话分支，
`workunit:execution_step` 事件自报 `sessionId=7cbebf30…`（新 UUID）；index.json 现存
`metadata.sessionId=7cbebf30-…`、`startedAt=20:20:03`（= step2 起点）、`sessionResumes` 缺省。
与「step1 重置、step2 新建」完全吻合。

**(c) sessionResumes 断点与 fed49d2b 的时间耦合**：`sessionResumes>0` 最后出现在
07-28T01:17Z 执行的 WU（17744996，resumes=2）；07-28T12:34Z 起全部 WU（含多步且最终成功的
aa4180d1/be2056eb/e577d686 等）`sessionResumes` 恒缺省。fed49d2b 恰于 07-28 09:36 CST 合入。
07-18~07-27 批次维护 WU 的 13~16 次 resumes 是**旧语义**（`instance.sessionId` 非空即续用）
下的计数——且按该 commit 自述 Bug B，那些「续用」步拿着 `--session-id` 撞已有 id 确定性报错，
计数本就不代表成功的会话复用。

**(d) 实例状态现状**：`~/.studio/data/agents/` 现存 12 个 state.json（当前进程 6 个 idle +
上一进程 6 个 terminated），`sessionId` **全部 null**。index.json 里 65 个 WU 的 sessionId
全是历史死实例写的（terminated 实例的 state.json 在每次重启时被 `deleteState` 清理，
:145-147），两者已无对象可比——「对不上」本身就是结论的一部分：现行设计下实例槽位
生命周期远短于 WU 簿记，任何重启都制造永久性错位。

### 三个疑似假设的判定

| 前置报告的假设 | 判定 |
|---|---|
| 实例重启/重新部署丢 instance.sessionId | **成立但非窗口主因**：每次部署确实孤儿化全部续用链（生命周期走查 (a)(d)），但 07-31~08-03 无部署的连续运行期内续用同样为零 |
| WU 每步被不同实例认领 | **不成立**：claim 把 assigneeId 钉为 instance.id，myActive 只认本实例；事件显示同 WU 相邻步间隔 2~3 分钟，远低于认领超时，无释放回池痕迹 |
| 首步失败后重置抹掉、从未重建匹配 | **成立，直接根因**：重置由 120s 超时驱动，窗口内非末步 100% 超时 |

## 断裂 2：sessionCount 零落盘

### 写入/落盘链路逐环走查（结论：无过滤、无丢字段）

1. 写入点 `agent-loop.ts:580-581`：`metadataUpdates.sessionId/sessionCount` 同块设置；
2. `recordResult` 单次原子写 `{...metadata, ...result.metadataUpdates, ...}`（:1166-1168），
   对 metadataUpdates 无 key 过滤；
3. `WorkUnitService.update` → `patchSnapshot`：`metadata: JSON.stringify(input.metadata)`
   全量序列化（`workunit.mappers.ts:82`），无白名单；
4. `clearSessionBookkeeping`（`wu-metadata.ts:42-57`，含 sessionCount 的 12 字段清单）
   **唯一调用方是 ReviewDispatcher 创建 review 子 WU**（`review-dispatcher.ts:208`），
   只影响子 WU 的初始 metadata，不碰父 WU 落盘；
5. 唯一删除 sessionCount 的地方是 `resetUnestablishedSession`（:992）——且删的是
   未落盘的写入增量，设计意图为「会话未建立不计预算」。

### 生产数据验证：B5 部署后没有任何「成功建会话」的步

- 65 个有 `metadata.sessionId` 的 WU，`updatedAt` 最大 = **2026-08-03T01:33Z（09:33 CST）**，
  全部早于 B5 首个部署（08-03 20:20 CST）约 11 小时——全部是 B5 前代码写的 sessionId。
- 08-03 20:20 CST 之后，index.json 中仅 3 个 WU 有更新：2 个 08-09 创建后从未被认领
  （unassigned），以及 PMO-12（3a86c8c0）。
- PMO-12 在 08-09 16:59~17:05 CST 跑在当前进程上（含 B5 的 `10e045eb`），3 步全部
  120s 超时 → 每步 `resetUnestablishedSession` 删除 `sessionCount` 增量 → 落盘为零；
  `stepCount=3` 照常累计（recordResult 无条件 +1），`blockReason` 显示 stuck 兜底。
- `session:start/end` 事件流同样佐证：08-03T02:28Z ~ 08-09T08:59Z 之间**零执行步**。

### B5 的 MAX_SESSIONS_PER_WU need_input 防线是否曾经可能触发？

**从未可能。** 触发条件 `sessionsUsed >= 2`（:568-569，MAX=2，:84）要求
`metadata.sessionCount >= 2` 落盘（旧数据回退最多算 1）；而 sessionCount 只在
「新建会话且该步最终走到 recordResult 成功路径」时才会落盘。部署后生产没有任何这样的步。
另外暴露一个**设计漏洞**：被 120s 超时杀掉的会话——恰恰是 token 燃烧事故里烧得最多的形态
（PMO-12 三步合计 input≈100K + cacheRead≈1.56M）——按 :991-992 的口径**不计入会话预算**，
B5 对「反复超时重开」这一最危险场景结构性失明，实际兜底靠的是 consecutiveStuck≥3→blocked。

## 修复点建议（只建议，未实现）

1. **会话槽位 per-WU 化**：`instance.sessionId` 单槽是续用断裂的结构性根源。续用判定可改为
   直接信 `metadata.sessionId` + 执行 cwd（worktreePath）一致性校验（cwd 本就是 claude 会话
   的存储维度），或实例侧改持 `Map<wuId, sessionId>`；至少应在「同实例切 WU」时不覆盖他 WU 的链。
2. **120s timeoutMs（:703）与 glm 路由实测时延严重不匹配**（成功步 21~92s、被杀步整齐 120s），
   这是零命中的放大器：按 provider 配置或放大超时，否则任何续用修复都被超时重置抵消。
3. **B5 计数口径**：失败/超时（已烧 token）的会话建立尝试也应计数（或单列
   `failedSessionCount` 并入 `sessionsUsed`），否则超时烧毁场景永远绕过防线。
4. **清理死代码 `checkSessionTruncation`**：改读 `result.rawOutput` 或删除；
   `extractInputTokens(result.outputText)`（:855）同样读纯文本，疑似同类失效，一并核查。
5. **部署可观测**：ship 流程落一条「deploy: commit + 进程启动时间」到事件流；本次排查因
   journalctl 只余 08-08 后的日志，全靠 studio-prod reflog 才重建出版本时间线。

## 意外发现

1. **生产跑 tsx+src 而非 dist**——前置报告「dist 含 B5 代码」的推理基础需要修正；dist 构建
   时间与运行版本可以完全不相关（实测旧路径 dist 文件停在 08-04，新路径在 08-09）。
2. **`checkSessionTruncation` 是从未生效的死代码**（SESSION_TOKEN_LIMIT 防线名存实亡）。
3. **B5 部署（08-03 20:20 CST）后生产执行近乎停摆 6 天**：B2 测试守卫关闭了测试特征 WU，
   而真实新单直到 08-09 才出现（2 个未被认领 + PMO-12）。「sessionCount 零落盘」与
   「B5 防线未触发」本质都是这段执行真空的副产品。
4. 07-18~07-27 批次维护 WU 的 `sessionResumes=13~16` 是旧语义下的计数，按 fed49d2b 自述
   Bug B，那些「续用」步大概率全部 CLI 报错——**生产从未有过被证实成功的跨步会话复用**。
5. 同实例单槽 sessionId + newest-first 调度：并发 >1 时续用结构性不可达（代码实证，
   因窗口内非末步 100% 超时，生产数据无法单独分离该因素的贡献）。
6. journalctl 仅保留当前 boot（08-08 20:51 起）；studio-prod reflog 是最可靠的部署时间线，
   建议纳入排障手册。
