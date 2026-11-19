# 批次 I：全局视觉规范落地与收敛路线

> 2026-09-16。批次 I-1（规范条文）已随本文件同 commit 落地（治理人闸当场过，`Governance-Approved: session`）。
> 走查方式：全仓静态分析（未跑 dev server 截图核实）；死 CSS 判定基于全量 grep，删除前对 `.show-*` 类做运行时抽查。

## 背景：走查结论

技术栈 = Tailwind CSS v4（`@tailwindcss/postcss` + `index.css` `@import "tailwindcss"`）+ 手写 CSS 类体系。token 体系（双主题、对比度、动效白名单）质量高，TSX 零硬编码 hex。问题在组织与执行：

| 发现 | 数据 |
|---|---|
| class 三体系并存 | Tailwind 工具类 785 处 / `u-*` 847 处 / 页面 BEM 867 处 / 内联 style 133 处（59 文件） |
| ui 组件库被绕行 | `ui/Button` 仅 4 业务文件 vs 原生 `<button>` 250 处（其中挂 `.btn` 仅 44）；`ui/Modal` 仅 5 处 vs 手写弹窗 13 处（全缺 Escape/焦点管理） |
| focus-visible 缺口 | 有焦点样式仅 7 处；`.u-tab`/`.nav-item`/可点卡片/Tailwind 拼凑按钮全无 |
| 断点双轨 | `responsive.css` 全套 639px vs 频道/WU 体系 768；640–767 行为不一 |
| 死 CSS | 约 30 类零引用，`responsive.css`（475 行）约一半是上一代设计残留 |
| 其他 | z-index 九档散落；裸 `transition`/`transition-all` 12+ 处绕白名单；Modal 宽度三口径（560/600/400）；`u-*` 38 个全局工具类错放 mission-control.css |

## 批次 I-1：规范条文（已落地）

style-guide.md（`docs/specs/ui/style-guide.md`，自本批入 git）：

- §2 规则 7 class 分层归属：布局/间距→Tailwind；颜色/语义→`u-*`/token；结构→BEM/组件类；内联仅组件特有参数
- §2 规则 8 焦点可见性：可交互元素必带 `:focus-visible`
- §2 规则 9 断点统一 640/768/1024，废 639
- §2 规则 10 z-index 阶梯 `--z-*` token
- §4.1 按钮归属：`ui/Button`（需 loading）/ `.btn` / `.icon-btn`，禁 Tailwind 拼凑
- §4.3 弹窗正本 = `ui/Modal`，手写 `.modal-overlay` 降为注释豁免
- 流程：style-guide.md 豁免 `.gitignore` 入库

## 后续批次（按性价比排序，逐批独立 commit）

### I-2 弹窗收编 ui/Modal（P0）
13 处手写 `.modal-overlay` 弹窗逐个替换（`AuthModal.tsx:42`、`FirstRoleSetupModal.tsx:117,150`、`StudioRoleSetupModal.tsx:50`、`WuGateActions.tsx`、7 个 pmo 对话框、`ConvertToTaskDialog.tsx`）。白捡 a11y 基座；同时单源化 maxWidth（560/600/400 三口径归并）。

### I-3 焦点兜底 + 断点/`.card` 修正（P1）
- `index.css` 全局 `:focus-visible` 兜底环；`.u-tab`/`.nav-item`/`.card.cursor-pointer` 补焦点态
- 删 `responsive.css:93-98` 移动端 `.card` 12px 圆角 + 纵向 margin 覆盖；断点 639→640 归并，`useMediaQuery` 同档对齐

### I-4 死 CSS 清理 + `u-*` 迁址（P2，零视觉变化）
- 删约 30 个死类（清单见走查记录：responsive.css 的 office-grid/role-card/mobile-menu 等残留族、theme.css 的 container-main/divider/nav-link、mission-control.css 的 mc-livebars/mc-progress 等）
- 38 个 `u-*` 工具类从 mission-control.css 抽 `styles/utilities.css`，`index.css` 显式 import
- responsive.css 存活规则间距归 `--space-*`

### I-5 打磨项（P2，可拆可并）
z-index 阶梯 token 落地 + 归队；裸 `transition`/`transition-all` 收窄；阴影/遮罩 rgba 归 `--shadow-*`/overlay token；`theme.css` 重复 import 清理（7 处）；✓✗⚠ 字形按 #474 口径扫尾（8 处）；原生 `<button>` 归队（约 200 处，量大，按页面分批）。
