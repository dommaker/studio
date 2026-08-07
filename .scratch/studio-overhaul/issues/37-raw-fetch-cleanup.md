# 37 — 裸 fetch 收编进 api 层（F1）

Type: task
Status: resolved
Labels: enhancement, ready-for-agent
Blocked by: 22

## Question

将 apps/web 残余裸 fetch 调用收编进 api/ adapter 层并补鉴权头：AuditLogsPage、CreateToolStdModal（若工单 22 未随 ToolsStdPage 一并删除）、DeleteButton、IronLawsSection 等（以工单 22 完成后的实际存活清单为准，先 grep `fetch(` 全量盘点）。验收：grep 无 api 层外裸 fetch（正当理由的例外加注释），typecheck+test 全绿，独立 commit。

## Answer

已解决，commit `0c263ec8`。存活裸 fetch 仅 AuditLogsPage 4 处（全部无鉴权头）：新建 api/auditLogs.ts adapter（axios 实例统一注入鉴权），页面改调 adapter；孤儿 utils/api.ts（getApiBase/apiFetch 等）连带删除；新增 5 条契约测试。保留项：导出用 window.open（下载无法带 Authorization 头，同源 cookie 会话兜底，已注释）。typecheck exit 0，test 3973 passed / 0 failed。
