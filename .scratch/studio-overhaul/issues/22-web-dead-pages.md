# 22 — web 废弃页面与死资产清理

Type: task
Status: open
Labels: enhancement, ready-for-agent

## Question

删除 apps/web：ToolsStdPage（无导航入口，连带其路由与 CreateToolStdModal 等独占子件）、pages/design-lab/ 整目录（PrototypeShell 等 4 文件，有路由无导航全 mock，连带 App.tsx:130-132 路由）、useCapabilities/useCompanyId/useAppStore/superpowersApi、animations/mission-control.css 死样式、hero.png/react.svg/vite.svg 死静态资源。连带孤儿常量/类型/测试。证据 research/02、03。验收：grep 零残留，typecheck+test 全绿，独立 commit。
