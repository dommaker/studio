# 02 — Web 前端源码调研

Type: research
Status: resolved

## Question

apps/web（131 个源文件）的结构与现实：页面/组件/stores/hooks/api 层组织方式、大文件（PMOPage.tsx 929 行、ProjectDetailPage.tsx 558 行、KnowledgePage.tsx 519 行、PrototypeShell.tsx 504 行等）内部结构、交互断点与卡点候选（多步繁琐链路、raw fetch 绕过 adapter、状态不同步、无效确认弹窗等）、样式与 i18n 组织、疑似死组件。产出可供 UI 交互重构直接消费的调研报告。

## Answer

已解决（subagent 调研）。报告：`../research/02-web-frontend.md`。

要点：①21 页面 + 61 组件 + 5 Zustand store 组织盘点，api 层有 axios seam 约定但 5 处裸 fetch 漏洞（多数丢鉴权头）；②6 个大文件拆分缝定位（PMOPage 抽 3 弹窗+纯函数削 40% 等）；③6 类交互卡点清单（alert/confirm 残留 3 处、整页跳转 4 处、/projects/:id 死路由、失败静默、表单无 loading、通知配置重启丢失）；④样式四层混用 + responsive.css 覆写 Tailwind 高风险；⑤i18n 形同虚设（locale 仅 19 key vs 171 处 t() 调用，87 文件硬编码中文）需二选一；⑥约 20 个死文件 2500+ 行。
