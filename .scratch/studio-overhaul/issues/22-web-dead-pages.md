# 22 — web 废弃页面与死资产清理

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

删除 apps/web：ToolsStdPage（无导航入口，连带其路由与 CreateToolStdModal 等独占子件）、pages/design-lab/ 整目录（PrototypeShell 等 4 文件，有路由无导航全 mock，连带 App.tsx:130-132 路由）、useCapabilities/useCompanyId/useAppStore/superpowersApi、animations/mission-control.css 死样式、hero.png/react.svg/vite.svg 死静态资源。连带孤儿常量/类型/测试。证据 research/02、03。验收：grep 零残留，typecheck+test 全绿，独立 commit。

## Answer

已解决，两个 commit：`aa9ec3f1`（ToolsStdPage + /skills 路由 + CreateToolStdModal + design-lab 整目录 4 页面/mock/css/5 测试 + App.tsx lazy 与 guest 旁路，−2217 行）、`6549416c`（useCapabilities/useCompanyId/useAppStore/capabilitiesStageApi + 孤儿 listSteps/listSkills + hero.png/react.svg/vite.svg，−157 行）。

复扫纠正证据误判：animations.css/mission-control.css 经 theme.css @import 且 mc-*/u-* 类被大量活组件消费，**为活样式已保留**（research/03 §2 结论有误）。typecheck exit 0，test 3924 passed / 0 failed。

备注：apps/api knowledge-bus-sync.test.ts 存在计时器 flake（与本工单无关，单跑及复跑均绿）→ 移交工单 43 巡检时评估。
