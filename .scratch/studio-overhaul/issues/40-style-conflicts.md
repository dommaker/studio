# 40 — 样式冲突清理（H）

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

消除 apps/web responsive.css 在媒体查询中覆写 Tailwind 同名工具类的冲突项（逐项列出冲突点，以 Tailwind 为准调整或删除覆写）；死样式已在工单 22 删除。不做全面样式统一。证据 research/02。验收：typecheck+test 全绿，冲突清单写入工单 Answer，独立 commit。

## Answer

已解决，commit `c38445a7`。媒体查询中覆写 Tailwind 同名工具类的 8 处冲突全部以 Tailwind 为准删除（.p-8/.px-8/.py-6/.text-xl/.text-lg/.grid-cols-3/.grid-cols-4 ×2），清空后的 640-1023px 查询整段移除；独有响应式自定义类全部保留；原位置注释说明改用 Tailwind 断点变体。typecheck exit 0，test 全绿。
