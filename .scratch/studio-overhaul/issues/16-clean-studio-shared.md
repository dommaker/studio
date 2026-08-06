# 16 — studio-shared 死代码清理

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

清理 packages/studio-shared 约 1500 行死代码：6 个死工具、2 个死常量、llm-client、FileStore 4 个死方法（逐项以 research/03 零引用清单 + research/04 为准，删前逐项 grep 复扫）。注意：本工单只做删除，file-store 的复制段合并与缓存属工单 26。验收：grep 零残留，typecheck+test 全绿，独立 commit。

## Answer

已解决，3 个 commit：`7f8aa9e4`（死工具 7 件 + 死常量 2 件 + 死类型 6 项 + eventemitter3 死依赖，−1640 行）、`b8448779`（llm-client，−224 行）、`014140a6`（FileStore 4 死方法 rebuildIndex/queryIndex/findByField/bumpVersion，−150 行）。27 个符号逐项复扫零引用；buildIndex/appendChangelog 有活调用保留。typecheck 每票前通过，test 最终 4095 passed / 0 failed（−58 为随删测试）。

执行发现移交：stance.ts 与 user-behavior.ts 两个整文件复扫发现实际零消费（原不在证据清单）→ 新开工单 44 处置。
