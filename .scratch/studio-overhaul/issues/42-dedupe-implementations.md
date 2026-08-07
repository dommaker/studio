# 42 — 重复实现收敛（J）

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

收敛重复实现（证据 research/04）：frontmatter 解析 3 份 → 统一为 studio-shared 一份，调用点逐一切换；ID 生成同一模式 6 处 → 统一工具函数。行为不变。验收：typecheck+test 全绿，每项收敛独立 commit。

## Answer

已解决，两个 commit：`0323a350`（frontmatter 收敛：studio-skill 删私有实现改用 shared parseFrontmatter + 类型适配，补 workspace 依赖；盘点修正为 2 份独立实现而非 3 份）、`14f61310`（新增 shared utils/id.ts generateId + 3 单测，20 处同格式调用点全切换；格式不同的 8 处 ID 生成点逐一记录并跳过——切换会改变 ID 形态违反行为不变）。typecheck 每票前 exit 0，test 全绿。

遗留移交：studio-shared dist/ 被 git 部分跟踪且存在前序未重建的存量漂移 → 移交工单 43 评估处置。
