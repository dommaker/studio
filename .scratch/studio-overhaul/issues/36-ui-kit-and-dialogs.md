# 36 — ui 通用件 + 确认/跳转改造（F4+F2）

Type: task
Status: resolved
Labels: enhancement, ready-for-agent
Blocked by: 21, 22

## Question

F4：apps/web/src/components/ui/ 补三件通用件——Modal、ConfirmDialog、Button（loading 态），风格对齐现有 ui/ 三组件。F2：alert/window.confirm 残留 3 处改用 ConfirmDialog；window.location.href 整页跳转 4 处改 SPA 路由导航（证据 research/02 §3 清单）。验收：typecheck+test 全绿；通用件一个 commit，替换改造一个 commit。

## Answer

已解决，两个 commit：`fddecbab`（ui/ 新增 Button loading 态 + ConfirmDialog，复用既有 Modal；各 5 条测试）、`a3d521c1`（替换：2 处 window.confirm→ConfirmDialog、1 处 alert→单按钮弹窗、5 处 location.href→useNavigate；甄别保留 OAuth 站外授权跳转并加注释）。typecheck 每票前 exit 0，test 3968 passed / 0 failed（+11 新用例）。
