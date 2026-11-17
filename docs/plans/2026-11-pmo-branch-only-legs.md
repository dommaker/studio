# 逐腿 branch-only 交付（#721）

## 目标与边界

branch-only 项目通过现有 `POST /project/:id/mark-delivered` 记录每条交付腿的系统外 commit/receipt 与 Operator；多腿必须显式传 `leg`（腿分支名），单腿省略保持兼容。所有有任务腿均落档后才写项目级交付记录，零任务腿沿用现有豁免。人工落档与 auto-merge 继续共用 `loadDeliveryStatus` 的证据/整体评审门禁，以及既有腿锁、未决合并和 Mandate 复核。不新增端点、存储布局或推送行为。

预约定测试 seam（#698 + 本票确认）：`getDeliveryStatus` / `markProjectDelivered`、`mark-delivered` HTTP contract/route、Web `projectApi` / `DeliveryPanel`。

## 实施步骤

1. **逐腿回执红绿**
   - `DeliveryLeg` 与 `LegDeliveryStatus` additive 增加 `deliveredBy`；auto-merge 落腿回执时同步记录操作人并保留已有字段。
   - `mark-delivered` body 增加可选 `leg`；多腿缺失/未知腿明确拒绝，单腿缺省走现有调用形状。
   - `markProjectDelivered` 只写目标腿的 `deliveredAt/deliveredBy/deliverCommit/status`；部分交付不写项目级回执，全部必需腿完成后才写并播报。因 `deliveries` 整组回写，多腿按固定顺序持有全部腿锁，避免不同腿并发覆盖回执。
2. **共用门禁红绿**
   - 人工落档在初次与腿锁内 fresh 复核均检查目标项目交付证据、未决合并、Mandate 和当前候选整体评审；证据不足或整体评审未批准均 `not-ready`，零写入。
   - 保持已落档腿幂等拒绝、auto-merge 项目拒绝和同腿锁超时映射。
3. **Web 逐腿交付红绿**
   - `projectApi.markDelivered` 增加可选腿参数并发送 `{ commit, leg? }`。
   - `DeliveryPanel` 多腿逐行显示分支、交付时间/操作人/commit；未交付且有任务的腿各有独立 commit 输入与落档按钮。单腿现有 UI 与调用保持不变。
4. **文档与验证**
   - 更新 PMO、contract、相关 Web CONTEXT 中已变化的公共行为。
   - 每个垂直切片先跑失败测试再实现；切片后跑对应单测与 typecheck。
   - 收尾运行受影响测试（`vitest run --changed origin/master`）与 `pnpm typecheck`，随后 `/code-review` 双轴审查。

## 完成标准

#721 四项 AC 均有公共接口行为测试；多腿部分交付可见且项目级回执不提前写入，人工/自动路径的证据与整体评审门禁一致；相关测试和 typecheck 新鲜通过，评审发现清零后提交并回写工单。
