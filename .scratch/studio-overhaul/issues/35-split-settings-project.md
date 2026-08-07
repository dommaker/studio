# 35 — Settings + ProjectDetailPage 拆分（E3+E4）

Type: task
Status: resolved
Labels: enhancement, ready-for-agent
Blocked by: 25

## Question

E3：拆分 apps/web/src/pages/Settings.tsx（482 行），8 个 section 组件化。E4：拆分 apps/web/src/pages/ProjectDetailPage.tsx（558 行），IDE 指南弹窗/知识网格/进展卡抽出；消除 :58,64 硬编码生产 IP（走项目既有配置通道，不新增配置框架）。按 research/02 标出的缝。验收：typecheck+test 全绿，每个文件独立 commit。

## Answer

已解决，3 个 commit（`8dd0b363`/`14437d5a`/`964ccb61`）。Settings 482→244 行（抽 components/settings/ 七件：ComputeSection/NotifyChannelSection/NotifySyncStatusHint/CompanySection/KnowledgeEntrySection/LanguageSettings/ThemeSettings）；ProjectDetailPage 558→381 行（抽 IdeGuideDialogs/KnowledgeDocGrid/ProjectProgressCard）。硬编码生产 IP 消除：沿用 vite env 通道（VITE_IDE_SSH_HOST/VITE_IDE_CLOUD_IDE_URL，缺省按 window.location.hostname 推导），全仓 grep 无残留。typecheck 每票前 exit 0，test 全绿（唯一失败为既有 knowledge-bus-sync flake，单跑复验通过）。
