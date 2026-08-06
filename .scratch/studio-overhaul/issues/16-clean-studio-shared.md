# 16 — studio-shared 死代码清理

Type: task
Status: open
Labels: enhancement, ready-for-agent

## Question

清理 packages/studio-shared 约 1500 行死代码：6 个死工具、2 个死常量、llm-client、FileStore 4 个死方法（逐项以 research/03 零引用清单 + research/04 为准，删前逐项 grep 复扫）。注意：本工单只做删除，file-store 的复制段合并与缓存属工单 26。验收：grep 零残留，typecheck+test 全绿，独立 commit。
