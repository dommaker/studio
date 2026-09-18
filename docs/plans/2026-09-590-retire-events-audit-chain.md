# #590 events:audit 决策审计链整链下线

出处：#588 裁定 + `docs/adr/2026-09-17-decision-audit-consolidation.md` 决策 1。判据同 ADR-0022 灰区裁决：一个消费者、只用一个聚合值，消费者不值得这条链的存在。

## 链的形状（2026-09-18 grep 复核）

一条写点 → 一个借宿落点 → 一个只数个数的读点，与设计愿景（8 类事件 / 6 个角色的 agent 决策可审计）已脱节：

| 环节 | 位置 | 实况 |
|------|------|------|
| 写 | `packages/studio-shared/src/harness/audit.ts` | `recordDecision()` 加盖 id/timestamp 后 `eventBus.publish('events:audit')`；`recordDecisions()` 零生产调用方 |
| 唯一生产写点 | `apps/api/src/modules/skills/skill-extraction.service.ts:206` | 仅 `skill.auto_published` 一种事件 |
| 落 | `apps/api/src/modules/audit/audit-subscriber.ts` | 以 `type: 'guideline'` + `applicablePhases: []` + `tags: ['audit', entityType]` 借宿 KnowledgeStore；不进检索注入 |
| 读 | `apps/api/src/modules/agents/auditor/auditor.service.ts:84-89,119` | 全仓唯一读者 = 日报一行 `- 审计事件: N` 计数 |

## 票面之外的四处连带（复核补入）

1. **`apps/api/src/index.ts` 有三处接线，不是一处**：import（L15）、启动 `startAuditSubscriber()`（L242）、优雅停机 `stopAuditSubscriber()`（L586）。票面只写「启动接线」——漏删 L586 会留下指向已删模块的 import 报错。
2. **`apps/api/src/modules/knowledge/CONTEXT.md:82`** 把 audit-subscriber 列为「绕过门面直调 `sharedStore.save` 的机器流」四例之一，并用它论证「store 层 chokepoint 广播会造成事件风暴」的有意排除。删模块后该例指向不存在的东西 → 从枚举里去掉、把论证改写成不依赖该例的说法（**保留有意排除这条规则本身**，另三例 pattern-miner/rule-scanner/decision-chain-extractor 仍活）。
3. **`apps/api/src/modules/audit/CONTEXT.md`** 随目录整体删除（票面「整目录」已含，此处标明它是该目录第三个文件）。
4. **`packages/studio-shared/CONTEXT.md`** 的 `recordDecision()` 核心导出行删除后，该行原承载的「落点原则」（ADR 决策 3）需要新家，否则下一个人想在 harness 层加事件发布器时无从得知 → 并入相邻的「harness 运行时初始化」行。

### 实施中按沉淀规则撤回的两处

`~/.studio/skills/exploration-sediment` 维护规则「不留已删符号的残影」「修复叙事的家是 git log」——两处初版写法违规，已撤回：

- `auditor.service.ts` 头注释曾加 `2026-09-18:` 删除叙事两行 → 撤回，改由 commit message + ADR 承载。保留 `2026-05-09: 初始实现。每日扫描审计事件…` 原句：它是日期限定的历史 changelog 条目，不是当前行为声明。
- `knowledge/CONTEXT.md` 曾写「原列第四例已随 #590 删除」→ 撤掉该从句，只留通用化的规则表述。

步骤注释编号不重排：该函数注释序为 `1,2,3,4,5,7,8,8,9`（原本就缺 6、双 8），删 3 后留缺口与文件既有状态一致，重排反而把无关注释行拉进 diff。


## AC 第 1 条的 grep 口径

票面「全仓零命中（历史文档/ADR/本票引用除外）」需先划例外集，否则字面不可达。复核后确认的例外，逐条给理由：

- `docs/adr/2026-09-17-decision-audit-consolidation.md`、`docs/plans/2026-09-587-clear-562-orphans.md`、本计划 —— ADR / 历史计划 / 本票引用。
- `docs/specs/`、`docs/issues/`、`docs/_archive/`、`.analyst/output-*.json` —— 冻结的历史分析与归档产出物，改它们等于改史。其中 `.analyst` 命中的 `recordDecision` 是 **KnowledgeBus 同名方法**（另一条链，写知识库不写审计），与本次删的 `harness/audit.ts:recordDecision` 仅重名；该重名风险当年已记在 `.analyst/output-1780761772261-d22l.json:161`。
- `**/dist/`、`.scratch/`、`.analyst/` —— 实测 gitignore 命中（`.gitignore:74` `.scratch/`、`:86` `.analyst/`），构建产物与一次性分析/抓取目录，不入库。`apps/api/tsconfig.tsbuildinfo` 属同类例外但**例外理由不同**：它确实被 tracked，是 tsc 增量缓存里残留的已删文件名（tsc-gate 用 baseline 模式不重写它）。清理需先把它 gitignore 掉，与本票无关，另票处理。
- `.studio/legacy-sdd/`、`.studio/research/` —— 入库的历史 SDD 与带日期的调研报告（如 `2026-09-12-walk4-receipt-fanout.md`），改它们等于改史。
- **`apps/api/CAPABILITIES.md` 走手工删单行，未跑整文件重生成**：`harness sync-docs -p apps/api` 实测产 243 insertions / 10 deletions——该文件自 2026-08-25 起没人重生成，一次性会扫进 #587/#562 等多票遗留的其他已删模块行。把 24 天无关漂移拉进一条删除票违反 `surgical_changes_only`。该文件不在根 CI 漂移校验范围内（`harness sync-docs --check --agents` 实测只报根 `CAPABILITIES.md` 与 `AGENTS.md`），正式重生成归文档腐化清扫另票（#587 票面已把「文档腐化清理与 `check-doc-sync.sh`」列为自身 out of scope）。

**执法口径 = 源码 + 活文档零命中**：`apps/*/src`、`packages/*/src`、`tests/`、`scripts/`、`bin/`、`*.md` 活文档（CONTEXT.md / CAPABILITIES.md / AGENTS.md）。

## 执行步骤

每步一个 checkpoint，可独立回滚。

1. **studio-shared 发布器**：删 `src/harness/audit.ts` + `src/harness/__tests__/audit.test.ts`；`src/harness/index.ts` 删两行导出与上方注释（L22-24）。checkpoint：`packages/studio-shared` typecheck。
2. **audit-subscriber 模块**：`git rm -r apps/api/src/modules/audit/`（三文件）；`index.ts` 删 L15 import、L242 启动、L586 停机。checkpoint：全仓 grep `AuditSubscriber` 零命中。
3. **auditor 日报计数项**：删 `auditor.service.ts` L84-89 的 `auditStore.list({ tags: ['audit'] })` 段与 L119 日报行；`summary` 其余行逐字不动。`yesterday` 不因此成孤儿（L106 WorkUnit 分组段仍在用），保留。checkpoint：auditor 测试绿。
4. **skills 写点**：`skill-extraction.service.ts` 删 `// Audit: Skill auto-publish` 整个 try/catch 块与 import 里的 `recordDecision`；`skill-extraction-events.test.ts:43`、`skill-promotion.test.ts:25` 删 `recordDecision: vi.fn()` mock 行。checkpoint：两测试文件绿。
5. **文档随动**：`packages/studio-shared/CONTEXT.md`（删 `recordDecision()` 核心导出行，其承载的落点原则并入相邻「harness 运行时初始化」行）、`apps/api/src/modules/skills/CONTEXT.md:35`（依赖行去 `recordDecision`）、`apps/api/src/modules/knowledge/CONTEXT.md:82`（去已删模块那一例 + 通用化论证）；`CAPABILITIES.md` 两份——根文件由生成器重生成、`apps/api/` 文件手工删单行（理由见上节）。→ `pnpm agents-md:sync` 重建模块索引（实测：audit 行消失、CONTEXT 计数 46→45、`sync-docs --check --agents` 转绿）。
6. **验证**：AC grep（口径见上）→ `pnpm typecheck` → `vitest run --changed origin/master` → code-review → commit。

## 边界（不动的东西）

- `audit-logs` 模块（FileStore 轨）行为零改动：`AuditService`、`middleware/audit-logger`、`tests/security/audit-log.test.ts` 均不碰。**注意 `apps/api/src/modules/agents/auditor/` 与 `audit/` 是两个东西**——只删后者。
- SEC-009 中间件、SEC-010 auth 路由的审计写入不碰。
- KnowledgeStore 存量 `tags: ['audit']` 借宿数据不迁移清理（不进检索，随库生命周期自然消亡）。
- 决策 2（A/B 类审计数据补齐落 audit-logs 轨）不在本票，另票。
- 同名字面量 `审计事件` 在 `role-memory/completion-extraction.ts`（指 `knowledge:extraction` 事件）与 `distill/distill-service.ts:434`（指约束审计）属另一语义，不改。

## 落点原则（本票起生效，写给未来读代码的人）

一次性决策事件**禁止写入 KnowledgeStore**（耐久知识库不放事件流）；审计数据唯一归宿 = audit-logs 轨（`actorType: agent`）。不重建 events:audit 链。依据 ADR 2026-09-17 决策 3。
