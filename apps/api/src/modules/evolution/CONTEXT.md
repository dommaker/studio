# apps/api/src/modules/evolution

### 职责

E1 约束进化（vision §6 / docs/plans/2026-07-flywheel-repair.md §4）：从执行 traces/outcomes 中加载信号，生成约束进化提案，经频道人工审核后生效到 harness 约束配置。

### 核心导出

- `signals.ts` — 路径解析 + 信号加载（traces/outcomes）
- `generator.ts` — 提案生成器（信号 → 约束提案）。三条链路全部在线（#602）：
  (a) harness usage report 退役候选 → retire 提案（buildConstraintsUsageReport，
  需 harness ≥1.10.1 公共导出；每轮上限 3）；(b) 注入知识仍高失败 → prompt-template；
  (c) 角色 caller 高频工具失败 → role-preset。TTL 清扫：pending/approved 超 14d 未审
  惰性转 stale（EVOLUTION_PROPOSAL_TTL_MS），不占 open-exists/duplicate 位（EP-0002 自锁修复）
- `incident-ledger.ts` — 历史事故台账（#602 D5）：append-only incident-ledger.jsonl
  （ci-red/review-reject/incident-commit，kind+ref 去重），runScan scanned.incidents
  只观测不进启发式；Phase 2 违规计数器续写同一格式。回填脚本 scripts/bootstrap-incident-ledger.ts
- `channel-review.ts` — 频道审核（提案卡片 → 人确认），卡片交互模式被其他频道确认流复用
- `applier.ts` — 提案生效器（审核通过后写入生效落点）。约束类（iron-law/guideline）
  落点 = `<repoRoot>/.harness/config.yml`；动作集已收敛（M3.2，2026-09-21）为
  **retire / disable 唯二**（message/exception/new-entry 无生效落点已出词表，存量
  历史提案落笔前抛「落点已退役」）：
  · retire（M3.3）复用 harness `constraints retire <id> --yes` CLI（spawn 本仓
    node_modules 的 bin/harness.js，非 npx）——config.yml 墓碑 +
    `constraint-retired-<id>` 知识条目（飞轮唯一自动入水口）都由 harness 写，
    applier 不自写 config.yml 绕开；频道 approve 即执行层人确认，故直达带 --yes。
    幂等短路只认 retired 墓碑（`constraints.<id>.retired`，落盘形态 =
    `enabled:false + retired:{at,reason,stats}`）：裸 disable（enabled:false 无墓碑）
    不算已退役——harness CLI 的 already_retired 保护只认 enabled:false，直接 spawn
    会被吞掉拿不到墓碑/知识条目，故升级路径先摘除裸 disable 的 enabled 标记再 spawn。
  · disable：enabled:false 无墓碑（harness 无 disable 子命令，无知识条目语义）。
  两者写后 getEffectiveConstraints 验证生效集缩小，失败回滚备份；幂等短路。
  retire 另验证 retired 墓碑已落盘（CLI retired/already_retired/unknown_id 退出码
  同为 0，stdout 文案是脆弱契约，不作判定依据）。
  生效后（M3.5）立即 `git -C <repoRoot> add .harness/config.yml && git commit`
  自动留痕（正文带提案号，trailer `Governance-Approved: EP-XXXX`）；commit 失败
  降级 warn + `ApplyResult.trail.committed=false`（随 evolution.applied 事件暴露），
  不阻断生效；幂等未写文件则无 commit。
  文本手术 retireConstraintEntry 保留——distill 草案渲染复用（amendConstraintMessage/
  appendConstraintEntry/loadCustomConstraints/applyConstraintChange 已随死格式删除）
- `evolution.service.ts` — 聚合服务（扫描 → 生成 → 审核 → 生效编排）。decide 对超期
  pending/approved 拒决策并转 stale（#602 D2）
- `evolution.routes.ts` — E1 约束进化 API

### 依赖关系

- 上游：`@dommaker/studio-shared`（eventBus、FileStore、logger）、channels 模块（审核卡片消息）
- 下游：apps/api 路由挂载；`evolution-daily-scan` trigger（agents/default-triggers）驱动每日扫描

### 注意事项

- 保守策略：信号不足时零提案；`EVOLUTION_ENABLED=false` 可整体关闭
- **harness 0.17.1 适配（2026-08-09，ADR-0001）**：E1 完整保留仅拆弹——存量 source='harness-autoEvolve' 提案仅为兼容保留。harness 侧 /evolve /degrade /schedule 端点已删除（见本文 `apps/api/src/modules/harness` 锚点）
- **#602 Phase 1 全链路打通（2026-09-21）**：四断点全修——(a) 链路改吃 usage report 退役候选（harness 仓 5d0d84a 加公共导出，**ship 前须发布 harness patch 并 bump 本仓 lockfile**）；(b) override 文件接生产读者（knowledge-service injectContext「## 系统约束」段经 renderWithOverride，D3）；EP-0002 自锁修（TTL→stale，D2）；tool:call 埋点写真值（D4，见 agents/loop 锚点）。验收：scratch 环境五步全链路绿（信号→提案→频道人审→override 落盘→injectContext 消费）
- **harness 1.10.0 适配（2026-09-20，ADR-0029 / studio#606）**：applier 的内置定义查表从 IRON_LAWS/GUIDELINES/PROMPTS 三桶改为 CONSTRAINTS 单桶（行为不变）；targetType 'iron-law'/'guideline' 是 studio 提案自有词表，不随 harness 三层命名退役；约束类提案落点（custom-constraints.yml）已随 #606 从本仓退役（#602 D1 新落点 config.yml，见核心导出 applier 条）。
- **约束类提案落点加闸（2026-09-21 上午加闸，同日 #602 D1 裁定新落点后收窄）**：落笔前抛错闸仍对存量历史词表（message/new-entry/exception）生效（无消费端）；M3.2 后词表收敛为 retire/disable，retire 走 harness CLI（M3.3）+ 生效自动 commit 留痕（M3.5，trailer `Governance-Approved: EP-XXXX`）。
- `loadWindowSignals` 对统一事件文件（studioEventsFile）整个窗口扫描只读一次，toolCalls/outcomes 在内存内分两次 filter（#329，2026-08-25）；加信号类型时复用同一 `eventRows`，不要再开新 readJsonl
- **channel-review 回执是异步的**：`service.decide` 落状态后 handler 才异步发回执帖（channel-review.ts），测试/消费方不能只等状态字段。测试的确定性同步点 = 等事件本身：`evolution.applied`（decide 落 applied 后同步 publish，apply 已完成）/ `channel.message_sent`（回执落库后同步 publish）——模式见 channel-review.test.ts 的 `onceEvent`/`waitForAgentReply`（#331）。坑：固定预算轮询赌 fire-and-forget 事件链墙钟耗时，基线高负载下有超时 flake 窗口（曾跑挂）
- 提案必须经人确认后才由 applier 生效，不做自动落地
- **鉴权（2026-07-24 收紧）**：`/api/v1/evolution` 挂载级 `requireAuth()+requireAdmin()` —— approve/reject/run 直接让约束变更生效，此前仅 requireAuth。
