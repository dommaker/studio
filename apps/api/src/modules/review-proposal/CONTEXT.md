# apps/api/src/modules/review-proposal

### 职责

人审提案卡生命周期唯一正本（#351，docs/adr/2026-08-25-review-proposal-lifecycle-module.md）：
「pending 提案 → 发审核卡到 #系统 → 人审 approve/reject → 墓碑终态」。提案存取（append-only
JSONL + 状态墓碑折叠）、发卡（含 #系统频道解析与 card-failed 降级落墓碑）、approve/reject、
状态查询全部收在本模块；业务方只做 adapter，注册配置对象
`{ kind, cardType, storeNamespace, dataDir, fileStore, renderCardContent, onApprove, onReject? }`。
状态词表唯一口径 = `pending | executed | rejected | failed | card-failed`。

### 核心导出

- `store.ts` -- `ReviewProposalStore<P>`：append-only JSONL 提案行 + 墓碑折叠（`ReviewProposalRecord<P>`）
- `card.ts` -- `postReviewProposalCard`：#系统 频道解析 + 发卡；失败静默 false 不抛
- `registry.ts` -- adapter 注册表：`registerReviewProposalAdapter` / `getReviewProposalAdapter` / `ApproveOutcome`（config.store 可选注入自定义存取——仅供 #353 per-role draft.jsonl 存储形态例外，缺省正本物化单文件）
- `service.ts` -- 生命周期：`submitProposal`（建卡+card-failed 降级）/ `approveProposal` / `rejectProposal` / `getProposalStatus`
- `routes.ts` -- 通用端点 `/api/v1/review-proposals/:kind/:id/{approve,reject,status}`，kind 走注册表分发

### 依赖关系

**上游**: `@dommaker/studio-shared`（FileStore/logger）、`channels/channel-message.service.ts`（发卡，动态 import）、`middleware/auth.js`

**下游**: modules/distill（distill/GC/审计三 adapter，kind: distill/gc/audit）；role-memory（#353，kind: memory，自定义 store 落 per-role draft.jsonl，旧 promoted 读侧归一）；skills（#354，kind: skill，默认物化 skill-proposals.jsonl，onApprove 生成 SKILL.md）；knowledge（#355，kind: knowledge，默认物化 knowledge-proposals.jsonl，onApprove 逐条目 promote / onReject 逐条目 demote，knowledge-service 模块加载即注册）；agents/auditor（#356，kind: auditor，默认物化 auditor-proposals.jsonl，onApprove 建未指派 task 工单——自旧 channels/card-decision.service 搬入，卡片作者经 payload.author 透传保持 Auditor，auditor.service 模块加载即注册）

### 运行时约定

- adapter 在运行时装配时注册（如 distill-runtime `getDistillService`）；同 kind 重复注册后者生效。
- `ApproveOutcome` 四态：executed（落墓碑+data 透传）/ failed（落墓碑+500）/ pending+skipped（熔断不落墓碑，提案可重试）/ aborted（前置条件不可用，不落墓碑+500，装配修复后可重试）。
- 去重（pending 不重复发卡）归业务触发侧，正本只管生命周期一致。
- 中间态规矩（ADR 决策 8）：新提案类型必须走本正本，禁止再抄第 N+1 份。
