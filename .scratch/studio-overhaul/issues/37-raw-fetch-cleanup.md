# 37 — 裸 fetch 收编进 api 层（F1）

Type: task
Status: open
Labels: enhancement, ready-for-agent
Blocked by: 22

## Question

将 apps/web 残余裸 fetch 调用收编进 api/ adapter 层并补鉴权头：AuditLogsPage、CreateToolStdModal（若工单 22 未随 ToolsStdPage 一并删除）、DeleteButton、IronLawsSection 等（以工单 22 完成后的实际存活清单为准，先 grep `fetch(` 全量盘点）。验收：grep 无 api 层外裸 fetch（正当理由的例外加注释），typecheck+test 全绿，独立 commit。
