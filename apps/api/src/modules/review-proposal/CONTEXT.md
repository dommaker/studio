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
- `registry.ts` -- adapter 注册表：`registerReviewProposalAdapter` / `getReviewProposalAdapter` / `ApproveOutcome`
- `service.ts` -- 生命周期：`submitProposal`（建卡+card-failed 降级）/ `approveProposal` / `rejectProposal` / `getProposalStatus`
- `routes.ts` -- 通用端点 `/api/v1/review-proposals/:kind/:id/{approve,reject,status}`，kind 走注册表分发

### 依赖关系

**上游**: `@dommaker/studio-shared`（FileStore/logger）、`channels/channel-message.service.ts`（发卡，动态 import）、`middleware/auth.js`

**下游**: modules/distill（distill/GC/审计三 adapter，kind: distill/gc/audit）；后续 role-memory/skills/knowledge/auditor（#353–#356）

### 运行时约定

- adapter 在运行时装配时注册（如 distill-runtime `getDistillService`）；同 kind 重复注册后者生效。
- `ApproveOutcome` 四态：executed（落墓碑+data 透传）/ failed（落墓碑+500）/ pending+skipped（熔断不落墓碑，提案可重试）/ aborted（前置条件不可用，不落墓碑+500，装配修复后可重试）。
- 去重（pending 不重复发卡）归业务触发侧，正本只管生命周期一致。
- 中间态规矩（ADR 决策 8）：新提案类型必须走本正本，禁止再抄第 N+1 份。
