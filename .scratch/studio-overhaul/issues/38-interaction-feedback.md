# 38 — 失败反馈 / loading / 防抖（F3）

Type: task
Status: open
Labels: enhancement, ready-for-agent
Blocked by: 36

## Question

修复交互反馈断点（证据 research/02 §3）：PMOPage loadData 与 KnowledgePage 新建条目的失败静默补错误提示；ChannelListPage 创建频道等表单加 loading 态防重复提交（用工单 36 的 Button）；Settings 公司名逐击键自动保存加防抖。验收：typecheck+test 全绿，每类修复独立 commit。
