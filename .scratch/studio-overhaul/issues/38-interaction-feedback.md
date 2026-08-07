# 38 — 失败反馈 / loading / 防抖（F3）

Type: task
Status: resolved
Labels: enhancement, ready-for-agent
Blocked by: 36

## Question

修复交互反馈断点（证据 research/02 §3）：PMOPage loadData 与 KnowledgePage 新建条目的失败静默补错误提示；ChannelListPage 创建频道等表单加 loading 态防重复提交（用工单 36 的 Button）；Settings 公司名逐击键自动保存加防抖。验收：typecheck+test 全绿，每类修复独立 commit。

## Answer

已解决，3 个 commit：`3c8e4200`（失败提示：PMOPage loadError 错误条+重试、KnowledgePage toast.error，+新测试）、`159d3e83`（loading 防重：ChannelListPage/ChannelRail/KnowledgePage/CreateOkrDialog 四处补 ui/Button loading + 重入守卫，其余表单盘点已有未动）、`7a15bd3b`（CompanySection 500ms 防抖 + draft 即时回显 + 空名不落库，+假计时器测试）。typecheck 每票前 exit 0，test 3984 passed / 0 failed（+11 新用例）。
