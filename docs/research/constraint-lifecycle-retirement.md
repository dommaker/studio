# 约束生命周期管理调研（issue #139）

> 研究票：issue #139（dommaker/studio，OPEN）。调研日期 2026-08-15。
> 口径：harness 侧行号对 master HEAD `2bc46cc`（Merge PR #22 release-0.17.1）；studio 侧行号对 master HEAD `65581758`（#143 蒸馏主链路最小闭环）。
> 一手来源仅限 harness 仓库、studio 仓库、GitHub issues（gh CLI）、studio SDD 与 architecture/decisions 文档。`harness constraints retire` 对 custom 约束的落盘行为已用 harness `dist/` 编译产物实测验证（见问题 4）。

## 数据源与方法

| 数据源 | 路径 | 体量 / 口径 |
|--------|------|------|
| retire 执行层 | `harness/src/cli/commands/constraints-retire.ts`（443 行） | 全量精读 |
| report 展示层 | `harness/src/cli/commands/constraints-report.ts`（234 行） | 全量精读 |
| 候选诊断/统计 | `harness/src/core/constraints/usage-report.ts`（254 行） | 全量精读 |
| 生效集合并 | `harness/src/core/effective-constraints.ts`、`src/core/project-config-loader.ts` | 全量精读 |
| 注入渲染 | `harness/src/core/constraints/injection-renderer.ts`、`definitions.ts`、`definitions/iron-laws.ts` | 全量精读 |
| checker 注册表 | `harness/src/core/constraints/checker.ts`、`checkers/index.ts`、`checkers/types.ts` | 全量精读 |
| KnowledgeStore 结构 | `harness/src/knowledge/types.ts`、`store.ts` | 精读关键段 |
| 架构决策 | `harness/docs/adr/0001-constraint-system-rearchitecture.md` | 全量精读 |
| studio 现状 | `studio/.harness/custom-constraints.yml`、`studio/CLAUDE.md` 注入段 | 全量精读 |
| studio 钩子面 | `studio/apps/api/src/modules/harness/constraints.routes.ts`、`studio/apps/api/src/modules/evolution/{applier.ts,CONTEXT.md}` | 全量精读 |
| issues | #139、#82、#83、#129、#130（`gh issue view -R dommaker/studio`） | 正文 + 全部 comments |
| SDD | `grep -rn "约束\|constraint\|retire" studio/docs/sdd/*/requirement.md` | 无 retire 相关当前决策命中（见问题 1） |
| 实测 | harness `dist/` 产物 + node 脚本（临时目录） | 3 个场景：custom retire / builtin retire / CLAUDE.md 注入同步 |

---

## 问题 1：审计触发形态（定期巡检 vs 事件触发）

**结论：#83 已裁决「挂蒸馏事件，不另设 cron」；#130 巡检单是事件触发且默认定时关闭；ADR-0001 明确不做定时快照 cron。推荐事件触发，复用 harness report 的候选诊断作数据层。**

一手证据：

- **#83 D3 已直接回答本问题**：「统一事件：一次蒸馏运行 = 三出口同开——①消费矿石归档 ②GC 产淘汰候选清单（人确认）③新约束入库顺带审存量约束（回答 #139 悬而未决的审计触发形态：不另设 cron，挂蒸馏事件）」（#83 正文 Decisions so far · D3）。#83 收尾评论：「Spec 已出 #141（D1-D5 collapse 为可构建计划）」，即蒸馏事件已进入实现线（#141/#143）。
- **ADR-0001 明确不做定时 cron**：「明确不做：定时快照 cron（趋势数据）：待快照机制跑过几个发版周期后评估」（`harness/docs/adr/0001-constraint-system-rearchitecture.md:78`）。
- **#130 巡检单是事件触发、默认定时关闭**：「触发=bug 复盘/交付里程碑（N 可配可关）/手动频道入口；默认定时关闭」（#130 正文）。故 #130 不能作为「定期 cron 巡检」载体——它本身也是事件触发。
- **现有可挂载的钩子点（两处，均在 harness/studio 已有代码内）**：
  1. harness 侧数据层已就绪：`buildConstraintsUsageReport`（`usage-report.ts:231-254`）只读产出 check 层统计 + 四类退役候选（`diagnoseRetireCandidates`，`usage-report.ts:174-226`），`constraints report --export` 输出脱敏 markdown 摘要（`constraints-report.ts:153-234`、`renderExportMarkdown` L67-111）。这是「agent 提建议」的数据源，已存在，无需新造。
  2. studio 侧只读/回滚面已就绪：`GET /constraints/retired`（读 `config.yml` 的 `constraints.<id>.retired`，`constraints.routes.ts:89-104`）与 `POST /constraints/:id/rollback`（删 `config.yml` `constraints.<id>` 段，`constraints.routes.ts:130-160`）。注意这两处均只认 `config.yml`，不认 `custom-constraints.yml`（见问题 4）。
  3. studio E1 applier 已具备「人确认后写 custom-constraints.yml」落地通道（`applier.ts:240-258`），但当前 action 只有 amend/new-entry/exception，**没有 retire action**（`applier.ts:117-173`），与 #82 D6 的「新增/override/retire 的具体 diff」存在缺口。
- SDD 检索 `约束|constraint|retire` 无 retire 相关的当前决策文档命中（命中的都是各需求里的通用「约束」章节或无关字段），即 SDD 目前无本议题的既有 requirement 可引。

---

## 问题 2：退役判定谁执行

**结论：机制上「建议层全自动 + 执行层一次人确认」已在 harness CLI 落地；但 `retire <id>` 非交互直达路径没有任何人确认（仅 iron 打印警告）。E1 提案同样强制人确认后生效。推荐：agent 提建议（report 候选）→ 人确认执行，且自动化审计必须走交互/人审通道，不得走直达路径。**

一手证据：

- ADR-0001 决策 2：「新增 `harness constraints retire`：建议层全自动（统计、候选筛选、交互选择器），执行层保留一次人确认；确认后落盘 + 知识沉淀全自动」（`0001-constraint-system-rearchitecture.md:26`）。文件头注释同述（`constraints-retire.ts:2-19`）。
- 交互模式确有确认链：候选列表 → 编号多选 → 逐条收集 reason + iron 二次确认（`constraints-retire.ts:378-395`）→ 变更摘要 → 最终 `确认执行？(y/N)`（`constraints-retire.ts:402-414`）→ 执行。
- **但直达路径无确认**：`constraintsRetire(id)` 非交互分支直接调 `retireConstraint`，iron 只打印 `⚠️ 已通过命令行直接退役（交互模式会要求二次确认）`（`constraints-retire.ts:432-439`）。即 `harness constraints retire <custom-id>` 一行命令即可退役，无任何 y/N 闸门。issue 所称「执行层本就保留一次人确认」对**交互模式成立，对直达路径不成立**。
- E1 侧同样「人确认才生效」：「提案必须经人确认后才由 applier 生效，不做自动落地」（`evolution/CONTEXT.md:27`）；applier 仅在 `EvolutionService.decide('approve')` 后调用（`applier.ts:4`）。且 `/api/v1/evolution` 挂载级 `requireAuth()+requireAdmin()`（`evolution/CONTEXT.md:28`）。
- #83 D3 词汇定案也含「人确认闸门」：「语义 = 可恢复退出 + 元数据留痕 + 人确认闸门」（#83 · D3）。

---

## 问题 3：与 checker 的联动

**结论：当前 custom 约束全部 `kind='prompt'`（无 checker），不存在「规则退役 → checker 同步退役」的即时问题——checker 按约束 id 注册，退役内置 check 约束即自然停调用。但 #82 D5 规划的「custom-constraints.yml 扩展 checker 配置段」落地后，退役需同时清理同文件内的 checker 配置段（一处真相）。合规率（长期零违规）不可单独作为退役信号——它是歧义信号，必须叠加「作用对象是否仍存在」判据。**

一手证据：

- **custom 约束无 checker**：`ProjectConfigLoader.toConstraint` 硬编码 `kind: 'prompt'`（「自定义约束没有注册表中的 checker，统一归为 kind='prompt'（不执行 checker，check() 短路通过）」），`project-config-loader.ts:286-307`。`checker.ts` 对 `kind==='prompt'` 入口即短路返回 satisfied（`checker.ts:190-199`）。实测 studio 的 7 条 custom 约束全部 prompt-only（`.harness/custom-constraints.yml` 全文，无 checker 字段、无 enabled 字段）。
- **checker 按约束 id 注册，无独立生命周期**：注册表 `CHECKS` 是 9 条内置 check 的静态表，`Map<id, ConstraintCheck>`，加载期做闭环校验（`checkers/index.ts:26-64`）；`checkPrecondition` 用 `getConstraintCheck(constraint.id)` 查找（`checker.ts:312-339`）。因此**退役一条 check 约束 = 它从生效集移除 → `findApplicableConstraints`/`getConstraints` 不再对其布线 → checker 自然不再被调用**，无需单独「退役 checker」。checker 定义不在 `definitions/` 里（`iron-laws.ts` 只含规则文案，`enforcement` 字段是动作标签而非 checker 引用）。
- **#82 D5 规划 checker 配置进 custom-constraints.yml**：「项目级配置（启用开关、契约路径、commit 必带字段）落各项目 .harness/custom-constraints.yml 的扩展 checker 配置段」「yml 现有 prompt-only 规矩（no_redis 等）是配置段扩成后的第二批 checker 候选」（#82 · D5）。即未来 custom 约束会长出 checker，且 checker 配置与约束同文件。此规划尚未实现（当前 applier 只写 prompt 条目，`applier.ts:117-173` 无 checker 配置段动作）。
- **合规率数据（#129 软模式）是观测/升级依据，不是退役依据**：#129 软模式「违反→hint 纠偏+台账，产『契约首轮合规率』指标」（#129 正文）；#82 D3「升级条件是数据触发而非时间触发：合规率报告跑一个周期后按违规率/误报率裁门槛」——即合规率服务于「软→硬升级」，非「退役」。
- **零违规是歧义信号，ADR-0001 已明确此坑**：「拦截率信号语义错误：零拦截分不清"约束过时"与"威慑有效"，不适合自动化」（`0001-constraint-system-rearchitecture.md:12`）。harness 现诊断已区分四类候选：`zero_trigger`（从未出现在 trace）/`unevaluable`（全 skip）/`high_noise`（fail 率高）/`zero_intercept`（样本充足但零 fail），`usage-report.ts:57-62,174-226`。`zero_intercept` 正是「长期零违规」，其诊断文案只标「样本充足但从未 fail」并交给 retire 的人确认环节（`usage-report.ts:215-222`），不自动判死。
- issue #139 已给出统一判据，恰好补齐「零违规歧义」的判定维度：「统一判据：该约束是否还有『可被违反的未来场景』」（#139 · Notes），并把 `prisma_schema_needs_migration`（作用对象 schema.prisma 已消失）与 `no_redis_import`（防再引入，风险未消失）分为两类。实测 studio 确无 `schema.prisma`（`find . -name schema.prisma` 零命中），`ioredis/redis` 仅在两处 evolution 测试文件提及（非依赖）。

---

## 问题 4：retired 落盘形态（对源码实测，与 issue 断言对比）

**结论（核心差异）：issue 断言「retire 已覆盖 custom-constraints.yml」只对了一半——retire 能「找到 custom 约束 + 写 config.yml + 写 KnowledgeStore」，但不能把 custom 约束从生效集/CLAUDE.md 注入段移除。实测：retire 一个 custom 约束后，它仍在 `getEffectiveConstraints` 里、仍被注入 CLAUDE.md。根因是 `mergeConstraints` 的处理顺序 + `getEffectiveConstraints` 不过滤 disabled 列表。**

### 4.1 实测验证（harness dist/ 产物，临时目录）

| 场景 | 结果 |
|------|------|
| retire 内置 `no_hardcoded_credentials` | ✅ 生效集移除（`getEffectiveConstraints` 不再含该 id） |
| retire custom `no_redis_import` | ⚠️ 写 config.yml + KnowledgeStore 成功、`status:'retired'`，**但生效集仍含该 id**（`kind:'prompt'` 条目原样保留，`enabled:true`） |
| custom retire 后同步 CLAUDE.md | ⚠️ `claudeMdSynced:true`，重渲染后 **`no_redis_import` 仍在 Iron Laws 段** |
| 重复 retire 同 custom id | `status:'already_retired'`（幂等保护命中 config.yml `enabled:false`） |

### 4.2 根因（源码）

- `writeRetireConfig` 落盘 `config.yml` 的 `constraints.<id> = { enabled:false, retired:{at,reason,stats} }`（`constraints-retire.ts:126-152`），对内置与 custom 一视同仁。
- `findRetireTarget` 确能从 `ProjectConfigLoader.getCustomConstraints()[id]` 找到 custom 约束（`constraints-retire.ts:92-104`），故不报 `unknown_id`；且 custom 恒 `isIronLaw:false`（kind='prompt' 无 check 层 iron，L98）。
- **失效根因**：`mergeConstraints` 分三步——step 1 处理 `config.yml constraints.<id>.enabled:false`（加入 `disabled` 并 `delete` 各桶内项，`project-config-loader.ts:182-202`），**但此时 custom 约束还没进桶（它们在 step 2 才被追加）**；step 2 `for (const [id, customDef] of Object.entries(this.customConstraints))` **无条件**把全部 custom 约束加回 `ironLaws/guidelines/prompts`，不检查 `disabled` 列表、不检查 `config.constraints[id].enabled`（`project-config-loader.ts:204-256`）；step 3 只做 scenes 过滤。`getEffectiveConstraints` 最终只是拼接四个桶，**从不按 `disabled` 列表过滤**（`effective-constraints.ts:24-34`）。因此 `config.yml` 里的 `enabled:false` 对 custom 约束不生效——retire 写下的退役段对 custom 约束是「留痕不生效」。
- 附带差异：custom 约束的 `findRetireTarget` 返回不含 `promptInjection`（`constraints-retire.ts:92-104`），导致其 KnowledgeStore 退役记录的「规则原文」段缺 `promptInjection` 行（对比内置记录含该行，`constraints-retire.ts:166-187`）。

### 4.3 与 issue 断言逐条对照

| issue 断言 | 实测 | 判定 |
|------|------|------|
| 落盘 `config.yml enabled:false` + retired 元数据 | ✅ 对内置与 custom 均写入 | 属实 |
| 写 KnowledgeStore 记录（consumptionMode: signal） | ✅ `constraint-retired-<id>`，`consumptionMode:'signal'`、`origin:'human'`、`maturity:'verified'`（`constraints-retire.ts:189-211`；`knowledge/types.ts:22` 定义四态） | 属实 |
| 同步 CLAUDE.md 注入段 | ⚠️ 对 custom 约束同步后仍保留该条目（见 4.1） | **不符**（仅内置有效） |
| 可恢复（删 `constraints.<id>` 段即恢复） | ✅ 对内置成立；studio `POST /constraints/:id/rollback` 同语义删段（`constraints.routes.ts:130-160`）；对 custom 因本就不退出，删除段无意义 | 部分属实 |
| 「已覆盖 custom-constraints.yml（ProjectConfigLoader.getCustomConstraints）」 | ⚠️ 覆盖到「查找 + 写 config.yml + 写知识」，未覆盖「从生效集/注入移除」 | **不符（半失效）** |

### 4.4 既有裁决方向（#82 D6，重要）

#82 D6（E1 裁决，已定稿）明确否决「拆 config.yml 第二处」：

> 「退役落点统一为 custom-constraints.yml 内的 retired 元数据段（一处真相，不拆 config.yml 第二处——**harness CLI retire 的落盘行为需相应适配**）」（#82 · D6，comment `Ob6ujw` 与正文一致）。

即：Q4 的正确答案不是「照抄 config.yml enabled:false」，而是 **custom 约束退役落点应在 custom-constraints.yml 条目自身的 retired 元数据段**（一处真相），且 harness CLI retire 需适配这一落点。这与 issue #139 Notes 的「当前 retire 写 config.yml」及 Not yet specified 的「custom 约束的退役落点待验证」方向一致，但比 issue 的模糊表述更进一步：已有明确裁决。

---

## 结论与建议

**Q1 审计触发形态 → 事件触发（挂蒸馏事件），不另设 cron。** 复用 `harness constraints report` 候选诊断（`usage-report.ts:174-226`）作「agent 提建议」数据层；触发载体挂 #83 D3 的蒸馏事件（「新约束入库顺带审存量约束」）；#130 巡检单只作「人工审计清单→确认→开需求」的派单通道，不作自动退役触发器。依据：ADR-0001 L78（不做定时 cron）、#83 D3（已裁）、#130（默认定时关闭）。**执行前置**：#83 蒸馏事件当前依赖 #141/#143（#143 已合入 master，见 studio HEAD commit message）。

**Q2 退役判定谁执行 → agent 提建议 + 人确认执行。** 保留 harness 交互模式确认链（`constraints-retire.ts:337-424`）或 E1 人审卡（`applier.ts:4`、`evolution/CONTEXT.md:27`）。**必须堵住 `retire <id>` 非交互直达路径无确认的缺口**（`constraints-retire.ts:432-439`）——若未来接自动化审计，不得走直达路径。

**Q3 与 checker 联动 → 退役约束即停调用其 checker（同 id 注册，无独立生命周期）；#82 D5 扩展 checker 配置段落地后，退役条目需在同文件一并清 checker 配置。合规率不可单独作退役信号。** 判据应叠加 issue #139 的「是否还有可被违反的未来场景」：作用对象消失（`zero_trigger` + 对象不存在）→ 退；防再引入（对象清零但风险在）→ 留，除非再引入路径已被其他机制封死。

**Q4 retired 落盘形态 → 不照抄 config.yml enabled:false；对齐 #82 D6，落 custom-constraints.yml 条目内的 retired 元数据段（一处真相）。** 实现前必须先修 harness `mergeConstraints` 的失效 bug（step 2 无条件重加 custom 且 `getEffectiveConstraints` 不过滤 disabled，`project-config-loader.ts:204-256` + `effective-constraints.ts:24-34`），否则任何形式的 custom 退役都不会真正从注入段移除。当前 `GET /constraints/retired`、`POST /constraints/:id/rollback`（studio `constraints.routes.ts`）与 `harness constraints retire` 三处均只认 `config.yml`，落点迁移需三处同步适配。

## 风险与开放问题

1. **custom 退役当前静默失效（P0 风险）**：`harness constraints retire <custom-id>` 返回 `✅ 已退役` 但约束仍注入 CLAUDE.md，会给操作者「已退出」的假象，与 issue 本意（死规矩稀释版面）直接相悖。任何生命周期方案上线前必须先修此 bug 并加回归测试（现 harness 无 custom 退役生效的测试覆盖——`constraints-retire` 仅对内置路径有断言，见 `__tests__`）。
2. **落点双轨风险**：`config.yml`（harness retire/studio rollback/retired 三处）与 `custom-constraints.yml`（E1 applier 落地）两处真相并存。#82 D6 已定「一处真相 = custom-constraints.yml」，但 harness CLI 适配尚未实施——若 studio 先按 D6 落 yml，而 harness 仍写 config.yml，会形成第三条半失效路径。
3. **E1 retire action 缺失**：#82 D6 规划「新增/override/retire 的具体 diff」，当前 `applier.ts` 只有 amend/new-entry/exception（`applier.ts:117-173`），retire action 未实现；且 E1 generator (a) 链路因 harness report 数据层未从包 exports 导出而挂起（`evolution/CONTEXT.md:26`），「报告候选 → 进化提案」闭环尚未接通。
4. **「防再引入 vs 已封死」判定依赖人工**：#139 的「再引入路径是否已被其他机制封死（如依赖审计）」目前无可机读信号，需人工判断或补依赖审计信号；否则防再引入型约束可能被误退。
5. **注入段标注与执行语义错位**：custom 约束 `level:iron_law` 被注入为「Iron Laws (违反将阻断)」（`injection-renderer.ts:38`、studio CLAUDE.md 现状），但其 `kind:'prompt'` 无 checker、`check()` 短路通过（`checker.ts:190-199`），「阻断」是文字而非机制。生命周期治理若只改落盘不改此语义，退役与保留的版面权重判断会被误导。
