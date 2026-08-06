# 34 — KnowledgePage + KnowledgeGraphView 拆分（E2+E5）

Type: task
Status: open
Labels: enhancement, ready-for-agent

## Question

E2：拆分 apps/web/src/pages/KnowledgePage.tsx（519 行），底部 6 个纯展示卡片组件抽出。E5：拆分 components/KnowledgeGraphView.tsx（488 行），布局算法/diff 计算抽为纯函数模块。注意 KnowledgeGraphView 主链路存活，只拆不删。按 research/02 标出的缝。验收：typecheck+test 全绿，每个文件独立 commit。
