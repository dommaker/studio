# apps/api/src/modules/evolution

### 职责

E1 约束进化（vision §6 / docs/plans/2026-07-flywheel-repair.md §4）：从执行 traces/outcomes 中加载信号，生成约束进化提案，经人审提案卡（review-proposal 正本，#623）审核后生效到 harness 约束配置。

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
- `review-adapter.ts` — review-proposal 正本 adapter（kind='evolution'，#623：频道文本
  审核退役、归位正本卡片）：renderCardContent（当前/提案/理由/证据窗口）、onApprove/
  onReject 调 EvolutionService.decide（apply/幂等/APPLY_FAILED 重试语义复用）；
  EvolutionProposalStore 包现有 FileStore 读写（EP-XXXX.json 单提案文件零迁移），
  读侧归一 applied→executed / approved→pending（保重试通道）/ stale→stale，
  appendStatus no-op（状态唯一写入点 = decide）
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
  退休生效后另有两个跟进动作（ADR-0032 决策 6.1/6.2，票 02 断点 1/2）：spawn CLI
  显式传 `KNOWLEDGE_BASE_DIR=UNIFIED_KNOWLEDGE_DIR`（退休沉淀落唯一正本
  ~/.studio/knowledge，harness 侧 legacy 目录兼容已随 ADR-0034 收编退役；旧版
  harness pre-#177 写口硬编码 repoRoot 会忽略此 env，无害降级）+ 成功后
  `scheduleVectorDbSync()` 触发向量同步（沉淀由 CLI 子进程直写，不经
  ingestWithQualityGate，不等入库事件顺风车；fire-and-forget 失败不阻断）。
  文本手术 retireConstraintEntry 已随 #617 拆除（唯一消费方 distill 存量约束审计
  子通道同票拆除；amendConstraintMessage/appendConstraintEntry/loadCustomConstraints/
  applyConstraintChange 早前已随死格式删除）
- `evolution.service.ts` — 聚合服务（扫描 → 生成 → 发卡 → 审核 → 生效编排）。构造即注册
  review-proposal adapter（kind='evolution'）；runScan 新提案发 evolution_proposal 卡到
  #系统（正本 postReviewProposalCard，替代旧频道文本消息）；decide 对超期
  pending/approved 拒决策并转 stale（#602 D2）
- `evolution.routes.ts` — E1 约束进化 API

### 依赖关系

- 上游：`@dommaker/studio-shared`（eventBus、FileStore、logger）、review-proposal 正本（adapter 注册/发卡/通用审批端点）
- 下游：apps/api 路由挂载；`evolution-daily-scan` trigger（agents/default-triggers）驱动每日扫描

### 注意事项

- 保守策略：信号不足时零提案；`EVOLUTION_ENABLED=false` 关闭每日扫描 trigger（agents/default-triggers），不影响提案卡审批与 admin API
- **harness 0.17.1 适配（2026-08-09，ADR-0001）**：E1 完整保留仅拆弹——存量 source='harness-autoEvolve' 提案仅为兼容保留。harness 侧 /evolve /degrade /schedule 端点已删除（见本文 `apps/api/src/modules/harness` 锚点）
- **#602 Phase 1 全链路打通（2026-09-21）**：四断点全修——(a) 链路改吃 usage report 退役候选（harness 仓 5d0d84a 加公共导出，**ship 前须发布 harness patch 并 bump 本仓 lockfile**）；(b) override 文件接生产读者（knowledge-service injectContext「## 系统约束」段经 renderWithOverride，D3）；EP-0002 自锁修（TTL→stale，D2）；tool:call 埋点写真值（D4，见 agents/loop 锚点）。验收：scratch 环境五步全链路绿（信号→提案→人审→override 落盘→injectContext 消费；当时人审走频道，#623 起走正本卡片）
- **#623 归位正本卡片（2026-09-22）**：频道文本审核通道（人类回复 approve/reject + EP 编号的文本解析）整体退役，提案改发 review-proposal 正本卡（cardType `evolution_proposal`）到 #系统，审批走通用端点 `/api/v1/review-proposals/evolution/:id/{approve,reject,status}`；存量 `evolution/` 数据零迁移（EP 编号体系保留，admin API decide 路径不动）
- **harness 1.10.0 适配（2026-09-20，ADR-0029 / studio#606）**：applier 的内置定义查表从 IRON_LAWS/GUIDELINES/PROMPTS 三桶改为 CONSTRAINTS 单桶（行为不变）；targetType 'iron-law'/'guideline' 是 studio 提案自有词表，不随 harness 三层命名退役；约束类提案落点（custom-constraints.yml）已随 #606 从本仓退役（#602 D1 新落点 config.yml，见核心导出 applier 条）。
- **约束类提案落点加闸（2026-09-21 上午加闸，同日 #602 D1 裁定新落点后收窄）**：落笔前抛错闸仍对存量历史词表（message/new-entry/exception）生效（无消费端）；M3.2 后词表收敛为 retire/disable，retire 走 harness CLI（M3.3）+ 生效自动 commit 留痕（M3.5，trailer `Governance-Approved: EP-XXXX`）。
- `loadWindowSignals` 对统一事件文件（studioEventsFile）整个窗口扫描只读一次，toolCalls/outcomes 在内存内分两次 filter（#329，2026-08-25）；加信号类型时复用同一 `eventRows`，不要再开新 readJsonl
- 信号面无外部输入口：`loadWindowSignals` 只读三个固定文件源（traces.log + studio-events.jsonl 的 tool:call / knowledge:outcome:*），外部语义信号（如 distill 判出的「疑似过时约束」）要进飞轮须新建摄入机制，不是接线（#622 查实，2026-09-22）
- 提案必须经人确认后才由 applier 生效，不做自动落地
- **鉴权（2026-07-24 收紧）**：`/api/v1/evolution` 挂载级 `requireAuth()+requireAdmin()` —— approve/reject/run 直接让约束变更生效，此前仅 requireAuth。
