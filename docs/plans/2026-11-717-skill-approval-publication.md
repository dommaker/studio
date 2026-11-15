# #717 打通 Skill 审批到发布

## 目标与边界

把 `#系统` 频道的 Skill 人审卡接回 Web，并让一次「通过并发布」完成：持久化已审意图 → 生成完整 `SKILL.md` → 确定性质量门 → `published` → 注入候选。发布失败保持可重试；进程在审批/发布中间崩溃后，启动恢复沿用原 Skill 和 proposal，不新增第二个人工发布流程、第二套提案存储或通用工作流。

## 已确认测试接缝

1. **API 公共生命周期缝**：`approveProposal('skill', id)` + Skill 启动恢复入口。观察 proposal 状态、真实临时目录中的 `SKILL.md`、`loadManifest()` / `selectSkillsForInjection()`；覆盖审批成功、质量门失败、发布前后崩溃恢复和重复执行。
2. **Web 人审卡缝**：`ChannelMessageItem` → `ReviewProposalCard` → `useChannelCardActions` → `skillsApi`。用真实卡片交互和 mock HTTP 适配层验证名称/来源展示、「通过并发布/拒绝」、已审态及通用端点参数。

## 实施步骤（逐片 RED → GREEN）

1. 先改 `apps/api/src/modules/skills/__tests__/review-adapter.test.ts`：审批后不再停留 draft，生成的 frontmatter 含 name/description/triggers，发布后可被注入选择器按 `+skill` 发现。
2. 修改 `apps/api/src/modules/skills/review-adapter.ts` 与 `skill-promotion.ts`：approve 先在原 Skill metadata 写入 `approvalProposalId` 并把状态置为 `approved`，再幂等生成/复用文档并调用现有 `promoteSkill`；正文取现有 pattern/prompt/提案内容，不写 TBD 占位。索引同步接纳 `approved`。只有磁盘已 published 才返回 executed；生成异常或质量门拒绝返回 aborted，proposal 保持 pending 并向前端返回真实错误。
3. 增加 Skill 发布恢复测试：构造 pending proposal + 已写 approvalProposalId 的 Skill，分别模拟「已审未落盘」和「磁盘已 published、proposal 尚未 executed」，调用恢复入口后均收敛到 published + executed，proposal/文件数量不增加。实现恢复入口并从 `apps/api/src/modules/skills/index.ts` 导出，在 `bootstrap/bridges.ts` 增加 soft step；更新 `bootstrap/__tests__/bridges.test.ts`。
4. 先补 Web RED：在 `ReviewProposalCard.test.tsx` / `proposalCardConfigs.test.tsx` 覆盖 `skill_review_request` 的渲染、点击、状态派生和通用端点调用，在 `ChannelMessageItem` 相关测试覆盖卡片分发，在 `api/__tests__/skills.test.ts` 覆盖 approve/reject/status URL。
5. 修改 `apps/web/src/api/skills.ts`，新增 `proposalCardConfigs/skill.tsx` 并注册，给后端 cardData 补上审核所需的 name/description/category/confidence/source 字段（保留 proposalId/skillId）；在 `ChannelMessageItem.tsx` 将 `skill_review_request` 接入现有 `ReviewProposalCard`。按钮明确命名为「通过并发布」，成功终态显示「已通过并发布」。
6. 更新 `apps/api/src/modules/skills/CONTEXT.md`、`apps/api/src/modules/distill/CONTEXT.md` 及相关注释，消除旧的「approve 后仅 draft / 文件生成失败非阻断」描述。无需修改数据目录布局或 contract schema。

## 验证与收尾

- 每个行为片先跑对应单文件 RED，再实现 GREEN，并定期跑 `pnpm typecheck`。
- 收尾运行受影响测试（skills/review-adapter、skill-promotion、bootstrap/bridges、distill-landings，以及 Web ReviewProposalCard/proposalCardConfigs/ChannelMessageItem/skills API 测试）和 `pnpm typecheck`；不跑全量套件。
- 使用 `/code-review` 按 #717 AC 与仓内规范审查，修复发现的问题后重新验证。
- 提交到当前 `master`（不 push、不部署），按实现票收尾规则关闭 #717 并报告验证证据与文档沉淀。
