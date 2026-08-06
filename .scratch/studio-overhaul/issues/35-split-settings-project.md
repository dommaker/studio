# 35 — Settings + ProjectDetailPage 拆分（E3+E4）

Type: task
Status: open
Labels: enhancement, ready-for-agent
Blocked by: 25

## Question

E3：拆分 apps/web/src/pages/Settings.tsx（482 行），8 个 section 组件化。E4：拆分 apps/web/src/pages/ProjectDetailPage.tsx（558 行），IDE 指南弹窗/知识网格/进展卡抽出；消除 :58,64 硬编码生产 IP（走项目既有配置通道，不新增配置框架）。按 research/02 标出的缝。验收：typecheck+test 全绿，每个文件独立 commit。
