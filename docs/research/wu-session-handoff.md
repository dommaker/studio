# WU 易主/复活时的会话 handoff 调研（issue #71）

> 研究票：issue #71。调研日期 2026-08-09。
> 代码侧以 `apps/api/src` 为准（行号对 master HEAD）；数据侧只读生产数据
> （`~/.studio/logs/studio-events.jsonl`、`~/.studio/data/workunits/index.json`、
> `/root/.claude/projects/` 的 claude 会话 transcript），transcript 只做结构化统计，未引用对话正文。

## 数据源与方法

| 数据源 | 路径 | 体量 / 口径 |
|--------|------|------|
| prompt 组装 | `apps/api/src/modules/agents/loop/prompt-composer.ts`、`agent-loop-parsers.ts` | 全量精读 |
| 会话管理/簿记 | `apps/api/src/modules/agents/loop/agent-loop.ts`、`workunit/waiting-input.ts`、`workunit.types.ts` | 全量精读 |
| 业务事件流 | `~/.studio/logs/studio-events.jsonl` | 10,830 行（2026-08-02 ~ 08-09 窗口） |
| WU 索引 | `~/.studio/data/workunits/index.json` | 150 WU（2026-07-13 ~ 08-09） |
| claude 会话 transcript | `/root/.claude/projects/<cwd-slug>/<sessionId>.jsonl` | 指纹 `## 本次任务 Skills` 命中 105 个文件 |
| 知识引擎沉淀会话 | `~/.studio/data/sessions/*.jsonl.done` | 19 个文件（仅 1 个含 studio 指纹，且 0 步 prompt） |
| 决策记录 | GitHub issue #57（复活决议）、#63（易主 fencing）、#68（测量方法与口径） | `gh issue view` |

步边界口径：transcript 中 `type=user` 且 `message.content` 为字符串、含 `## 当前工作` 的行 = 一个真实执行步 prompt（`buildContinuePrompt`/`buildReplyPrompt` 的固定头，见 `agent-loop-parsers.ts:191,207`）。注意 `queue-operation` 行会回声 prompt 文本，不计入。

---

## 问题 1：易主/复活路径上实际丢失什么

会话不可续用（`resumeSessionId` 判定不命中，`agent-loop.ts:559-561`）时，新实例首个 step 的 prompt 由 `composeStepPrompt` 重组（`prompt-composer.ts:75-183`）。逐项清点：

| 信息 | 是否进入新会话 prompt | 机制与出处 |
|------|----------------------|-----------|
| 任务原文 `wu.scope` | ✅ | base prompt 固定头（`agent-loop-parsers.ts:191-193`） |
| 人类回复（pendingReplies / newReplies） | ✅ 一次性 | 优先级最高的 base prompt 分支（`prompt-composer.ts:82-84,101-105`），注入后即清除（:165-168） |
| commitGuardHint（COMPLETE 被提交守卫打回） | ✅ 一次性 | `prompt-composer.ts:87-89,107`，注入后清除 |
| verifyFailHint（自动验证失败打回：失败命令+输出尾部） | ✅ 一次性 | `prompt-composer.ts:92-94,108`，注入后清除 |
| childGuardHint（子任务未完结打回） | ✅ 一次性 | `prompt-composer.ts:97-99,109`，注入后清除 |
| **PROGRESS 步摘要（前序每步结论）** | ❌ | 只发频道（`agent-loop.ts:1223,1231` `postToDiscussionSpace`），不落 metadata、不进 prompt |
| **blockReason（最近 blocked 原因）** | ❌ | 写 metadata（`agent-loop.ts:1151-1161`）但 `composeStepPrompt` 从不读取；复活时还被清除（`waiting-input.ts:69`）。唯一消费方是频道 CTA 文案（#57 D3） |
| **errorType/errorDetail（最近执行失败详情，如 120s 超时）** | ❌ | 落 metadata（`agent-loop.ts:757-762`），不注入；成功执行后清除 |
| waitingQuestion（挂起时 agent 的提问） | ❌ | 复活后只有人类回答进 prompt，问题本身不进（`waiting-input.ts:63-74`） |
| 证据台账 attestations / verifyReport | ❌（不注入） | 落 metadata（`workunit.types.ts:66-70,122`），消费方是 COMPLETE 守卫与展示层 `deriveDisplayState`，不是 prompt |
| 频道消息上下文 | ❌ | prompt 只注入「新人类回复」正文；历史频道线程（含自己此前发的 PROGRESS）不在 prompt 内，agent 也无频道读取工具 |
| skills 索引 / persona / 花名册 / 知识库 | ✅（静态信息） | 2K 共享预算（`prompt-composer.ts:33,115-156`），全是能力/通识信息，**零任务进展信息** |
| worktree 工作区（文件改动 + git 提交） | ✅（隐式，最有分量） | 每 WU 专属 worktree 跨 step/跨实例复用（`agent-loop.ts:626-647`），是真正穿越会话边界的状态载体 |

**结论**：新实例拿到的是「任务原文 + 最后一次打回/回复原因（若存在）」，拿不到「做过什么、试过什么、为什么失败」。hint 体系是最接近 handoff 的机制，但它是一次性的、只覆盖「最近一次打回」这一个场景；连续多步的进展轨迹完全不在重组 prompt 里。能不能「接着干」而非「重新看懂」，全押在两样东西上：worktree 里的现场（代码改动、git log），以及前序 agent 是否遵守 prompt 里的纪律性提示把进展落盘（SDD 文档、`~/.studio/knowledge/decision-*.md`，见 `agent-loop-parsers.ts:197-202`）——这两者都是约定俗成而非机制保证。

## 问题 2：新会话首步的实测 token 成本

### 2.1 重大前置发现：可观测窗口内「续用步」样本为零

对 105 个 studio 指纹 transcript 全量扫描（07-21 ~ 08-09）：

- **92 个文件含恰好 1 个步 prompt，13 个含 0 个（指纹出现在正文而非 prompt）——没有任何 transcript 含 ≥2 个步 prompt。**
- 105/105 文件的首个 user 行 `parentUuid=null`，即全部为全新会话起点，无 fork/resume 痕迹。
- 佐证：executor 侧 `agent_session` 事件（n=5）全部 `isContinued: false, sessionCount: 1`；08-02/03 执行的 5 个多步 WU（stepCount 2~3，`sessionResumes` 字段缺省）各自的 transcript 也都是单步文件。

即在可观测数据里，**每个执行步都跑在全新 CLI 会话里**——不只是易主/复活路径，连同实例连续 step 也如此。`agent-loop.ts:559` 的续用判定在生产为何系统性不命中（daemon 运行构建版本、实例重启丢 `instance.sessionId`、或更早构建无 fix/guard-and-resume 逻辑），本调研未能定位，需单独排查（07 月那批 `sessionResumes=15` 的维护 WU 簿记上走过 resume 分支，但其 transcript 位于 GAP-2 时代已拆除的 per-agent HOME，无法核对）。

因此「新会话首步 vs 续用步」的放大倍数**没有对照组可直接测量**——这本身就是问题 2 最重要的答案：现状下几乎所有步都付的是「新会话价」。

### 2.2 新会话首步成本分布（n=92，全部即首步）

| 指标 | p50 | p90 | max |
|------|-----|-----|-----|
| input tokens（非 cache） | 27.2K | 64.6K | — |
| output tokens | 3.9K | 14.0K | — |
| assistant 消息数（≈轮次） | 34 | 82 | — |
| billed-ish（in+out+cacheRead+cacheWrite） | 636K | 2.06M | 6.64M |

口径警告：08-02/03 的生产执行 model 为 `glm-5.2[1m]`（claude 兼容层路由），usage 的 cache 字段语义可疑（92 个首步 `cacheWrite` 恒 0、`cacheRead` p50=602K），billed-ish 行仅供参考量级。`workunit:tokens` 事件流本窗口 646 条中 `cli-usage` 真实仅 17 条，其中 12 条还属测试 id `wu-cumul`——该事件流仍须先清洗才可作数据源（与 #68 的结论一致）。

### 2.3 案例：PMO-12（WU `3a86c8c0`）——重复「重新看懂」三次

每步失败后 `resetUnestablishedSession` 重置会话，3 步 × 3 个全新会话，每步都被 120s 硬顶杀掉（`agent-loop.ts:703`），零产出：

| 步 | transcript | input | output | cacheRead | 探索动作 |
|----|-----------|-------|--------|-----------|---------|
| 1 | `d31fc56f` | 55.9K | 8.6K | 484K | Grep×8, Read×6, Bash×1 |
| 2 | `3643099d` | 21.9K | 14.9K | 344K | Read×4, Agent×2, Grep×2 |
| 3 | `626508fe` | 22.6K | 12.9K | 733K | Grep×13, Read×8 |

三步合计 input≈100K / output≈36K / cacheRead≈1.56M。`workunit:execution_step` 事件显示第 2、3 步开头 thinking 均为 "Let me understand the task…"——**新会话把「读懂任务」的探索成本完整重付一遍**，且因为没有任何前序进展注入（问题 1），三步之间几乎零积累。这给了放大倍数一个具象下界：若第 2、3 步能续用，其「重新看懂」部分（每步 20K+ input、十几轮工具调用）基本可以省掉；按 2.2 分布粗估，首步相对「有上下文的继续步」的额外探索成本在 **2 万~6 万 input token + 数十轮工具调用**量级，任务越重越大。

### 2.4 样本量声明

- 「续用步」对照样本 n=0，放大倍数无法直接测量，§2.3 为案例下界 + §2.2 分布外推。
- 首步分布 n=92，但混含测试污染期会话（08-01 49 个、08-03 30 个文件与 B2 测试事故窗口重叠），口径偏「轻任务」。
- 与 #68 数字差异说明：#68 报「106 会话 144 步」，其步边界为任意 user/string 行；按本报告严格口径（studio prompt 行）为 105 会话 92 步，差异来自非 prompt 的 user 字符串行。

## 问题 3：handoff 摘要的必要性与形态建议

**必要性成立，且比 issue 预设的更紧迫。** 问题 1 证明重组 prompt 里任务进展信息为零（除一次性 hint）；问题 2 证明生产上每个步都在付全新探索价、PMO-12 式重复探索真实发生。即使 §2.1 的续用失效根因被修好，易主/复活/失败重置三条路径仍然结构性需要 handoff——它们正是续用判定设计上就不覆盖的场景。

**方案 A：metadata 簿记前序步摘要，新会话首步注入（推荐，改动最小）**
- 形态：`recordResult` 把每步 `stepResult.summary`（PROGRESS/COMPLETE/失败原因）追加进 `metadata.progressLog`（环形，封顶如 10 条 × 200 字符）；`composeStepPrompt` 在 `resumeSessionId` 判定不命中且 `stepCount>0` 时注入 `## 前序进展` 段（含 blockReason/errorDetail 尾部）。
- 改动面：`agent-loop.ts` recordResult 一处追加 + `prompt-composer.ts` 一个注入段 + `workunit.types.ts` 一个字段。不动事件流、不动 CLI 层。
- 风险：metadata 膨胀（有截断即可控）；summary 质量取决于 agent 的 ACTION 行质量；注入预算需与 2K 红线（skills>persona>roster>knowledge）明确关系——建议 handoff 段独立于 2K 或排在 knowledge 之前，否则挤压知识注入。

**方案 B：从 `workunit:execution_step` 事件合成摘要注入**
- 形态：新会话首步时按 workUnitId 读 `studio-events.jsonl` 尾部事件，把各步的 `action`/`text`/toolCalls 摘要拼成 handoff 段（事件 schema 见 `execution-step-events.ts:48-64`，每步已有 thinking≤3×500 字符、text≤500 字符的现成摘要）。
- 改动面：`prompt-composer.ts` 增加事件读取依赖；簿记零改动。
- 风险：该事件 2026-08 才上线，生产仅 5 条，历史 WU 无数据；截断字段信息密度低；按 WU 过滤需扫事件文件尾部，热路径读放大需缓存。适合作方案 A 的补充数据源而非替代。

**方案 C（前置排查，非 handoff 本身）：先修续用链路**
- §2.1 显示续用判定在生产系统性不命中。若属 daemon 构建/部署问题，修好后同实例跨 step 的大部分重放成本消失，handoff 摘要退化为只覆盖易主/复活/失败重置——方案 A 的注入频率和收益预期都应据此重估。建议把「为什么 `sessionResumes` 在生产不增长」列为本票或独立票的第一个动作。
- 顺带修正簿记断裂：`sessionCount` 字段在全部 150 个生产 WU 中零落盘，而 `studio-prod` dist 含该代码（B5）——`sessionId`（同批写入）在 65 个 WU 中存在，说明不是「没走到新会话分支」，而是字段在写入/持久化链路上丢了，或 daemon 实际运行构建与 dist 不符。B5 的「≥2 会话转人工」防线在生产可能从未生效。

## 意外事实附录

1. **跨 step 续用零成功样本**（§2.1）：issue 前提「同一 WU 内跨 step 默认续用」是代码意图，不是生产现实。
2. **B5 sessionCount 簿记零落盘**（§3 方案 C）：token 防烧上限防线可能从未在生产生效。
3. **生产执行 model 为 `glm-5.2[1m]`**（`agent_session` 事件），usage cache 字段语义异常，B6 真实记账口径受路由层影响。
4. **`workunit:tokens` 事件流持续被测试 id 污染**（本窗口 `wu-cumul` 占 cli-usage 的 12/17），B2 测试守卫之后仍有漏网。
5. **`workunit:execution_step` 事件覆盖率极低**（上线以来仅 5 条），作为 handoff 数据源（方案 B）暂不可用。
6. 易主/复活时 `waitingQuestion`（agent 自己的提问）不进 prompt——人类回答被注入但问题上下文丢失，答非所问风险（`waiting-input.ts:63-74` vs `prompt-composer.ts:101-105`）。
