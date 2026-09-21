# E1 约束进化飞轮 Phase 1 实施计划（studio#602）

> 2026-09-21 立。依据：issue studio#602（Phase 1 全链路打通）+ docs/plans/2026-08-flywheel-repair-e1.md（三断点立项）+ 2026-09-21 现状勘察。
> 范围 = 修四个断点 + bootstrap 回填 + 全链路验收。Phase 2（违规代理计数）与 harness 约束 channel schema 不在本票。

## 现状勘察结论（2026-09-21）

- harness 已 0.17.1 → **1.10.0**，usage-report（`buildConstraintsUsageReport` / `diagnoseRetireCandidates`）存在于 `dist/core/constraints/usage-report.*` 但仍**未公共导出**（exports map 仅 `.`/`./core`/`./presets`/`./context`/`./gates`）
- `custom-constraints.yml` 已随 #606 整文件退役；applier 约束分支已加抛错闸（`applier.ts:270-279`，d7f8d9e3）——(a) 修复**必须先裁定新落点**
- `renderWithOverride` 生产调用点仍为 0；`prompt-overrides.ts` 头部注释声称 6 个 templateId 已接线，实际只有 `knowledge.extract-from-text` 一处（注释漂移）
- 实盘 pending 自锁两个：EP-0002（prompt-template，07-20）+ EP-0001（iron-law 测试残留，07-22）
- tool:call 埋点两处硬伤：`agent-loop-events.ts:182-209` `success:true`/`caller:'agent-loop'` 硬编码；`studio-agent/output-capture.ts:157` payload 无 success/caller。实盘 studio-events.jsonl 中 tool:call / knowledge:outcome 均为 0 条（叠加 rotation 把 debug 事件短保留）
- role-preset 链路（生成→审核→生效→prompt-composer 消费）当前是通的，可作验收参照模板

## 设计决策

### D1 — (a) 链路：harness 导通 + 新落点 = `.harness/config.yml`

1. harness 仓（/root/projects/harness）`src/core/index.ts` 显式清单加 `buildConstraintsUsageReport` / `diagnoseRetireCandidates` 及类型导出（纯增量，无行为变更）。**发布走 `harness-ship release patch`，由用户触发**（治理：agent 不主动发布）
2. studio `generator.ts` `constraintProposals()`：吃 `report.candidates`（zero_trigger / zero_intercept / high_noise / unevaluable），映射为 `modify_message` / `add_exception` / `retire` 类提案，evidence 带候选的 stats + reason
3. applier 约束分支新落点：写 `<repoRoot>/.harness/config.yml`（harness 约束真实生效形态，`getEffectiveConstraints()` 读它覆盖内置集）。retire 语义对齐 `harness constraints retire`；modify_message/add_exception 落 config.yml 对应字段。替换现有抛错闸
4. channel: gate/workflow/discipline schema 字段**不做**（issue 明确归 Phase 2 配套）

### D2 — pending 自锁：TTL 转 stale（不选 amend）

- 理由：amend 会在人审前静默改提案内容，与频道已发卡片不一致；TTL 改动面小（generator `openTargets` 构造 + store 类型 + list 过滤）
- status 词表加 `stale`；`openTargets` 构造处排除「pending/approved 且 createdAt 超龄」的提案；`listEvolutionProposals` 默认仍返回 stale（标注），频道审核指令对 stale 提案报已过期
- **TTL = 14 天**。实盘 EP-0001（07-22）/ EP-0002（07-20）由 TTL 自然转 stale，即为本修复的实盘验证样本
- 超龄判定在 generator 读提案时惰性计算（不开定时器扫库），stale 状态在 decide/list 路径同样惰性生效

### D3 — (b) 链路：renderWithOverride 接进知识注入构建处

- 落点：`knowledge-service.ts:556-560` 区段组装，仅 `## 系统约束` 段接 `renderWithOverride('knowledge.rules-section', '## 系统约束\n{content}', { content })`
- token 计量（:566-596）按**渲染后文本**计长，避免 override 前缀使 2K 预算截断口径漂移
- 顺手修 `prompt-overrides.ts:8-14` 漂移注释（实际接线清单）
- 「砍掉 (b)」选项否决理由：#602 验收要求一条真实规则走全链路，(b) 是最短闭环（role-preset 虽通但信号链路不同）

### D4 — 信号断流：修埋点 + transcripts 兜底

1. `agent-loop-events.ts:182-209`：success 取真实步结果（WU 步成败），caller 取 WU `assigneeRole`（无则回退 'agent-loop'）
2. `studio-agent/output-capture.ts:157` emitToolCall：payload 补 `success`（stream-json tool_result 的 `is_error` 取反）与 `caller`（roleId 经 runner 透传）；`durationMs` 有则填
3. outcome 链路（`agent-loop.ts:1441 recordOutcomeEvent`）已通，不动
4. rotation 把 `tool:call` 归 debug 短保留的问题：提级为 info 或在 rotation 白名单保留 `tool:call`/`knowledge:outcome:*`（信号源不可被 noise 策略吞掉）
5. transcripts 归档（`~/.studio/transcripts/<wuId>.jsonl`，per-WU stream-json 全量）作为**回填数据源**（D5 用），不进实时信号路径

### D5 — bootstrap 历史事故台账

- 落盘 `~/.studio/data/evolution/incident-ledger.jsonl`（append-only），条目：`{ date, kind, ref, summary }`，kind ∈ `ci-red / review-reject / incident-commit` 等
- 来源：issue 点名的 1b047ccc、review 打回记录、CI 红记录——用 `git log` + GitHub CI 历史 + 频道打回记录离线整理，**逐条人工核对后写入**（不编数据）
- generator 的 evidence 计数 = 窗口信号 + 台账基线（台账只作计数与引用，不伪造时间戳混进实时事件流）
- 台账 schema 与 Phase 2 违规计数器复用同一文件格式，Phase 2 直接续写

### D6 — 验收（一条真实规则走全链路）

选 **(b) 链路**（最短闭环，信号→提案→频道人审→生效→被消费五步全真实）：

1. 信号：恢复后的 outcome 事件流（或手工构造一条真实 WU 失败 outcome）
2. 提案：`POST /api/v1/evolution/run`（或 trigger）生成 prompt-template 提案，evidence 非空
3. 频道人审：`#系统` 频道卡片 + `approve EP-XXXX` 回执
4. 生效：`~/.studio/prompt-overrides/knowledge.rules-section.md` 落盘
5. 被消费（2026-09-21 M4 加固；原口径「构造一次 injectContext 调用验证输出」属 mock 级，判假绿作废）：走**真实 injectContext 路径**——经运行中的 API 实例执行一条真实 WU，由 agent-loop `agentStep` → `composeStepPrompt`（`prompt-composer.ts:364`，injectContext 唯一真实流量调用方）触发注入，验证该 WU 的实际 prompt 中 `## 系统约束` 段按 override 渲染。前置条件（M2 诊断结论）：OpsService 看门狗探针假阴性修复须已上线（否则生产进程每 5 分钟自杀，真实流量物理不可达），验收开始前确认进程 uptime 已超两个看门狗周期；且有真实 WU 流量（pending 人闸已确认放行的单）
6. 消费事件判据（2026-09-21 M4 新增）：验收后事件流 `knowledge:consumption` 事件 > 0——必须由 `recordReference` → `sharedLifecycle.onReference` 真实链路产生；`knowledge:probe` 是自检路径直写事件、不经 recordReference，probe 计数不构成消费证据。次日 `.consumption-stats.json`（事件流日聚合，monitor-reports 写）dailyEvents > 0——消费命中率脱离 0%

## 实施顺序（TDD，每步先行测试）

1. D2 自锁修复（最小、解锁实盘）
2. D3 (b) 消费端接线
3. D4 埋点修复
4. D1 (a) 链路（依赖 harness 导出，单测 mock 模块；真实接通待 harness patch 发布后 bump 依赖）
5. D5 bootstrap 台账（脚本 + 真实数据整理）
6. D6 验收（生产 studio-prod 或本地 API 实例跑一次全链路）
7. 收尾：CONTEXT.md 同步（evolution / knowledge / prompt-overrides 相关）、code-review、commit、关 issue

## 风险

- harness patch 未发布前，(a) 链路只能靠单测验证，真实提案生成待依赖 bump——验收用 (b) 兜底，不阻塞本票收尾
- D4 改埋点影响事件量，rotation 提级需控制 studio-events.jsonl 增速（tool:call 高频，白名单保留时确认轮转上限生效）
- override 文本进 token 预算后，`## 系统约束` 段长度变化可能影响既有注入快照测试
