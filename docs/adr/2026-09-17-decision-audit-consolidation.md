# 决策审计归并：events:audit 链下线 + 审计数据补齐走 audit-logs 轨（2026-09-17）

> 来源：#588 裁定（triage 会话，事实核查 → 原始意图追溯 → 可行性评估 → 人裁定）；状态：**active**。

## 背景

初始 commit 设计了 `DecisionAudit` 表：记录各 Agent 角色在关键节点的决策
（会议完成/需求生成/约束提案/评审完成等），带 companyId/projectId/actorRole 与四个索引，
定位是「agent 决策可审计」——让系统能回答"这群 agent 干了什么、谁决定的"，消费方为 Auditor 角色。

2026-09-17 核查（#588，随 #562 随核发现）发现该链已侵蚀成摆设：

- **写**：`recordDecision` 全仓唯一生产调用点是 `skill-extraction.service.ts` 的 `skill.auto_published`；
  `recordDecisions` 零生产调用方。设计里的 8 类事件、6 个角色从未接齐。
- **落**：`modules/audit/audit-subscriber.ts` 把一次性决策事件以 `type: 'guideline'` +
  `applicablePhases: []` 借宿进 KnowledgeStore——不进检索注入，也没有第二读方。
- **读**：全仓唯一读者是 `auditor.service.ts` 日报里的一行计数（`审计事件: N`）。

与此同时，「操作级审计」已有真产品面：`audit-logs` 轨（AuditService + FileStore）经
SEC-009 中间件与 SEC-010 auth 路由记录人的 HTTP 关键操作，有查询/统计/导出端点与审计页
（requireAdmin）。且「经人审的 agent 决策」已由 review-proposal 正本（ADR 2026-08-25）完整收集——
distill/gc/audit/memory/skill/knowledge/auditor 七种 kind，append-only JSONL + 墓碑折叠，
含提案作者、全文、终态与时间戳，缺的只是聚合读面。

## 决策

1. **events:audit 链整链下线**：删 `studio-shared/src/harness/audit.ts`
   （recordDecision/recordDecisions/AuditEvent 及 harness/index.ts 导出与测试）、
   `apps/api/src/modules/audit/`（audit-subscriber + 测试 + index.ts 启动接线）、
   `auditor.service.ts` 的审计事件计数项（日报去掉「审计事件: N」行）、
   `skill-extraction.service.ts` 的 recordDecision 调用点。判据同 ADR-0022 灰区裁决：
   一个消费者、只用一个聚合值，消费者不值得这条链的存在。
2. **决策审计数据补齐，统一落 audit-logs 轨**（FileStore + 现有审计页/查询/导出/鉴权）：
   - A 类（经人审决策）：聚合读 7 种 review-proposal `*-proposals.jsonl`
     （折叠逻辑复用共享 `foldJsonlById`），做统一列表/详情端点，审计页加来源维度。
     不加任何新写入点。
   - B 类（自主决策）：在 WU 认领/状态机流转、@mention 派单、trigger 触发 CREATE/EXECUTE、
     auditor 低风险自动应用这 4-5 个决策点补埋点，形状对齐 audit-logs 行并加
     `actorType: agent` 维度（谁决定、对象、依据、结果、traceId）。
   - 埋点前先收敛「什么算决策」的词表，防止埋点泛滥成噪音。
3. **落点原则**：一次性决策事件**禁止写入 KnowledgeStore**（耐久知识库不放事件流）；
   审计数据唯一归宿 = audit-logs 轨。

## 为什么不做成独立第三轨

初始 DecisionAudit 的愿景（agent 决策可审计）仍然成立，但不需要独立管道：A 类数据
review-proposal 正本已在收集（写入侧零新增），B 类决策点全仓仅 4-5 个、事件频率低，
append-only JSONL 足够。audit-logs 轨的页面、查询、导出、鉴权（requireAdmin，涉 PII）
全是现成的；复活 `events:audit` 链等于为一份已存在的数据再造一条平行管道。

## 后果

- 决策事件与操作事件同轨可查：审计页能同时回答"人点了什么"与"agent 决定了什么"。
- 后续新增 agent 自主决策点时，埋点落 audit-logs 轨（`actorType: agent`），
  **不重建 events:audit 链、不写 KnowledgeStore**。
- B 类埋点词表在实现票内收敛定型，词表增删走治理变更流程。
