# 2026-07 知识审核闭环设计

> 依据：`docs/vision-2026.md` §4（提取 → 成熟度 = proposal 待审核 → 审核通过才参与注入）、§6（提案 → 人在频道审核后生效，复用双向沟通机制）。
> 状态：设计待评审。前置事实：2026-07-20 审计确认飞轮断在审核一环（见 §1）。
> 执行轨道：**β（知识服务）**。为避免同文件并行冲突，本轨道同时承担：`2026-07-flywheel-wireups.md` 的 ②③（injectContext 区）、`2026-07-knowledge-type-repair.md` 的 R1（`ingestConversationEntry` 补 decision tags）与 R3 的 `createResolution` 改写。独占 `knowledge-service.ts`。接口契约：定义 `cardType: 'knowledge_proposal'` 与 handleAction 分发规范；decision 条目 tag 约定 `['decision', <category>]`。

## 1. 现状（全部已查证，含证据）

链路现状：

```
任务 COMPLETE → extractFromConversation（真 LLM，knowledge-service.ts:493-565）
  → ingestConversationEntry 入库 maturity:'draft'（形态门禁 + linter，:1399-1450）  ✅ 真实
  → injectContext 双层排除 draft（unified-query.ts:159 + knowledge-service.ts:1370-1374）  ✅ 真实
  → promote：POST /api/v1/knowledge-service/promote（knowledge-service.routes.ts:251-261）  ⚠️ 裸 API
      · web 端零调用方；频道确认卡按钮 no-op（ChannelDetailPage.tsx:107 只处理 'converted'）
      · signal 档永不自动 promote（harness lifecycle.ts:124），而提取产物全是 signal 档
  ⇒ 结论：提取产物实际永远进不了注入，飞轮断在最后一环。
```

附带事实：监控页已有"proposal 待审"计数（MonitoringPage.tsx:112-114）；`knowledge_confirm` 卡片推送随 2026-07-20 清理批的死代码一并删除，当前 COMPLETE 链路入库后**无任何通知**。

可复用资产：promote API、`AuditorSuggestionCard` 卡片模式（auditor-execution.ts:100）、约束进化频道审核（evolution/channel-review.ts:57，vision §6 钦定模式）、`ensureDefaultChannels` 播种的 #系统 频道（channel-init.ts:7-13）、`KnowledgeConfirmCard` 渲染组件（ChannelMessageItem.tsx:36-38，可改造）。

## 2. 闭环设计

```
提取 → draft 入库 ──▶ #系统 频道提案卡（一次提取多条合并一卡，防刷屏）
                          │ 人在频道点 通过/拒绝（双向沟通机制复用）
                approve ──┴── reject
                  │            │
        promote API      draft → archived
        draft→verified   （新增 demote 端点）
                  │
        参与后续任务注入（gate 已就位）
                  │
        度量：审核延迟 / 通过率 / 通过条目的注入命中率与任务成功率
```

决策点（按 vision 与薄编排原则收敛）：

- **审核入口放频道，不做独立审核页**。vision §6 已定"人在频道审核后生效"；监控页只保留计数与跳转链接。
- **卡片聚合**：一次提取产出 N 条合并为一张卡（列标题+类型+来源 WorkUnit 链接），避免刷屏；同日可再聚合为 digest。
- **不开放自动 promote**（保守）：signal 档维持人工审核；decay 机制继续清理长期无人理的 draft（reference 档 6 月降 draft、3 月 archived，harness 现有配置）——即"不审也不污染注入，久了自然归档"。
- **reject 语义 = archived**（不是删除）：保留追溯，decay/lint 不再管它。
- **统一卡片 action 路由**：`handleAction` 从只认 `'converted'` 改为按 cardType 分发，`knowledge_proposal` 与 auditor_suggestion、evolution 提案走同一交互规范。

## 3. 落地步骤（文件级）

1. **入库即发卡**：`ingestConversationEntry` 成功入库后（knowledge-service.ts:1438 附近），聚合本次提取条目发 `knowledge_proposal` 卡片到 #系统（频道获取参考 auditor-reports `postToSystemChannel`；注意该函数在频道缺失时是丢弃——发卡前确保 `ensureDefaultChannels` 已播种，启动序列已有）。
2. **reject 端点**：`knowledge-service.routes.ts` 新增 `POST /demote`（draft→archived），与现有 `/promote` 对称。
3. **前端卡片**：新增 `KnowledgeProposalCard`（仿 `AuditorSuggestionCard`）；`ChannelDetailPage.handleAction`（:107）接通 `knowledge_proposal` 的 approve/reject → 调 `/promote`、`/demote`；点击后卡片状态更新（已审核标记）。
4. **监控页**：待审区从计数升级为列表（标题/年龄/一键 approve）；审核度量（平均审核延迟、通过率）进飞轮看板区；通过条目的后续命中用已实算的 hitRate（knowledge-service.ts:1469-1518）交叉呈现。
5. **验收（e2e）**：完成一个任务 → #系统 出现提案卡 → 频道点"通过" → 条目 verified → 下次同类任务 injectContext 命中该条目 → `getFlywheelMetrics` hitRate 实算上升。拒绝路径：reject → archived → 永不注入。

## 4. 明确不做

- 不做 signal 档自动 promote（数据不足时自动通道风险大于收益；后续如有"同 pattern 人工通过 ≥3 次"信号再议）。
- 不做独立审核 Web 页（违反薄编排定位；频道即审核界面）。
- 不恢复已删的 `knowledge_confirm` 旧链路（其推送只挂在已删的内部路由上；新卡片由 COMPLETE 链路直接产出）。
