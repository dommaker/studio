# 34 — KnowledgePage + KnowledgeGraphView 拆分（E2+E5）

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

E2：拆分 apps/web/src/pages/KnowledgePage.tsx（519 行），底部 6 个纯展示卡片组件抽出。E5：拆分 components/KnowledgeGraphView.tsx（488 行），布局算法/diff 计算抽为纯函数模块。注意 KnowledgeGraphView 主链路存活，只拆不删。按 research/02 标出的缝。验收：typecheck+test 全绿，每个文件独立 commit。

## Answer

已解决，3 个 commit（`7b076487`/`9a66088a`/`3c8de563`）。KnowledgePage 519→368 行（抽 components/knowledge/GapCards.tsx 154 行六类 Gap 卡片）；KnowledgeGraphView 488→283 行（抽 graphUtils.ts 190 行布局/diff 纯函数，原导出面 re-export 保留）。typecheck 每票前 exit 0，test 3957 passed / 0 failed。
