# UI 样式规范 — 方向 A「Mission Control」

> 版本：2026-08-03（文字 token 对比度提升 + 全站页面/组件统一收敛）；2026-08-29 按 map #377 / #380 决议预更新视觉基线目标值，#392 已落地（字体角色、字号阶梯、muted 对比度、`--border-strong`、`--space-*`），细节见 `docs/specs/ui/redesign-2026-08.md` §3；2026-09-01 #431 新增共享类 `u-page-bg` / `u-page-head` / `u-btn-reset`，`.mc-ws button` 全局重置 `:where()` 降权，`.mc-bubble` 圆角归档到卡片档；2026-09-09 批次 C：Tailwind `text-*` 档位经 `@theme` 重映射到 token 阶梯（index.css），`.mc-status-running` 全局统一 accent，删死族 `tag-*`/`nav-tab`/`list-item`/`table-*`/`hero-*`/`feature-*`/`card-glow`/`animate-*`/`stagger-*` 与 animations.css 整文件；2026-09-10 批次 D-0：§2.5「不动效」放宽为「克制动效白名单」（治理人闸当场过）；新增 `icon-btn` / `theme-option` 类，主题切换控件去 emoji 改 SVG（ui/icons 补 IconSun/IconMoon/IconMonitor），删死代码 ThemeToggle；@media print 硬编码色 token 化（--print-*）；批次 D-1.1–1.4：背景档整体上抬至可感知档（d-fresh 截图实证明度差失效）、卡片 1px 顶部内高光（深色）/shadow-sm（浅色）、新增 `--fs-page(20)` 页面标题档、新增 `nav-item`/`conn-chip`/`brand-link` 类、§4.8 accent 品牌时刻策略、顶栏 ⚡ emoji → IconZap SVG；批次 D-2：行动中心 reply 深链/闸门审批就地化/下一个待办、/workunits 标题搜索（后端 additive q）、PMO 需求 tab、频道工作条 1 击闸门、RoleCard 抽屉化、Cmd/Ctrl+K 全局搜索（CommandPalette + useGlobalShortcuts）；批次 D-2.x：动效 token（--motion-fast/--motion-base/--ease-standard）落地 4 类白名单场景；批次 D-3：空态=说明+主行动模式（agents/pmo）、术语白话 7 处；批次 D-4：内联审计 5 文件 67→21 处（新增 mc-error-banner/u-mb-3 类）；2026-09-10 批次 E（`docs/plans/2026-09-ui-polish-batch-e.md`）：E-1 token 合规清扫（workunits.css/responsive.css 硬编码 transition 归 `--motion-*`，BackButton/ProjectDetailPage/ProjectMap 内联间距字号归 token）；E-3 治理决策变更——toast 允许 opacity 进出场 fade（`--motion-base`，`data-closing` 幂等守卫），**推翻批次 C「toast 无进出场动效」决策**（当场批准，commit `11483225` 带 `Governance-Approved: session`；归入 §2.5 场景②语义扩展）；新内容进场渐隐高亮（`.wu-row-new`/`.mc-msg-new` accent-dim 底色 2s 渐隐、`.mc-msg-highlight` outline 渐隐）按 §2.5 白名单场景③「状态色切换」解释落地，仅颜色属性过渡、无 transform/位移；新增 `.skeleton`/`.skeleton-text`/`.wu-row-new`/`.mc-msg-new` 组件类（§4.4）；2026-09-11 批次 H-1（治理人闸当场过）规范根部修正四项：① §2.5 动效白名单 4 类扩 5 类——新增场景⑤「加载与进度反馈」（spinner 旋转、忙碌状态点 pulse、进度条宽度/填充过渡，历史遗留白名单外动效收编）；② §4.8 补豁免——统计卡大数字（`--fs-stat` 档）数据强调允许 accent；③ §2.3 补豁免——长文阅读正文（markdown 渲染、文档阅读页）允许 `lineHeight: 1.8`；④ §4.2 label 写法根治——原四属性内联示例与规则 2「禁内联布局样式」自相矛盾，新增 `.form-label` 组件类（§4.4 登记），代码迁移 4 处｜ 状态：**现行有效，唯一权威来源**
> 2026-09-16 批次 I-1（治理人闸当场过）：全局视觉走查（全仓静态审计）落规范——§2 新增规则 7「class 体系分层归属」/ 规则 8「焦点可见性」/ 规则 9「响应式断点统一 Tailwind 档」/ 规则 10「z-index 阶梯 token」；§4.1 增补按钮归属（`ui/Button` / `.btn` / `.icon-btn` 三档，禁 Tailwind 拼凑自造按钮）；§4.3 弹窗正本改 `components/ui/Modal`（手写 `modal-overlay` 结构降为豁免）；**本文档自本批次起豁免 `.gitignore` 入 git**（原「Spec source 忽略」只落本地盘，规范无法评审/回溯，批次 F-5/G-3/G-4 的类登记曾全留本地）。留痕 commit 带 `Governance-Approved: session`。
> 2026-09-16 批次 I-5a：z-index 阶梯 token 落地（11 档 `--z-below..--z-toast`，存量字面量全量归队、堆叠行为零变化，§3 层叠行定档）；新增 `--shadow-popover`（小型浮层轻投影）与 `--overlay-modal`（modal 同档 0.7 遮罩第二消费方）两 token；4 处 `u-tab` 裸 `transition` 收窄 `transition-colors`（白名单场景①③）；`theme.css` 重复 import 清理（唯一入口 App.tsx）；✓✗⚠ 字形扫尾按 #474 口径转 SVG（ui/icons 新增 `IconX`）。
> 2026-09-16 频道视觉层次批次（`docs/plans/2026-09-channel-visual-hierarchy.md`）：channel 消息流 6 项可读性改造——agent 消息升 panel 形态（`--bg-elevated` 底 + 4px 圆角 + 全向内距，线程容器/主流双语境可辨）；头像 20→24px；时间戳 mono 化；`.mc-collapse-toggle` 虚线 chip → 行级条（实底实边左对齐 + focus-visible，规则 8）；`.mc-thread-replies` 裸缩进 → `--bg-secondary` 背景容器成组；`MarkdownBody` PRE_STYLE 升档（bg-secondary→bg-tertiary、border-subtle→border-default）+ 频道 `.mc-md pre` 320px 封顶内滚动；工作条站点点径 9→11px、连线 2px、新增 `.mc-workbar-wu` stepper 归属 chip（§4.4 登记）。增量二（线程归属走查）：`.mc-thread-replies` 容器顶新增 `.mc-thread-context` 锚点摘要头（muted `--fs-xs` 单行截断，回答「这个容器回复谁」）；折叠条文案带作者归属（`▸ N 条过程消息 · @名`，多作者前 2 名 + 等）。组内 quote 不动——主流回复必然挂线程内，抑制 anchor quote 会砍掉 AC1 quote 定位契约的主要出现面。增量三（折叠组模块感）：折叠条左边线 2px 与 agent panel 同位（读作序列中的一行）；展开态包 `.mc-proc-group` 模块盒（收起条=模块头、消息组=模块体）。增量四（角色消息链）：单作者折叠组 + 紧随同作者消息渲染为 `.mc-reply-chain` 单一模块（折叠条=模块头虚线分隔、组内 panel 拍平共享外壳）——折叠的 N 条与下方结论是同一角色连续输出，必须读作一个模块；多作者/卡片/他作者紧随不合并。零新 token、零新 accent 消费位（§4.8）、零新动效。增量五（vc6 角色分框走查）：消息框升「完整盒子」——`.mc-msg-agent` 底 elevated→tertiary + 全周 1px `--border-default` + 左 3px 角色色条（`--mc-agent-color` 由组件内联注入 = 该 agent identicon 同号 `--chart-*` 类别色，§4.8 类别色不占 accent，与头像同源同色，compact 无头消息也可辨角色）；`.mc-bubble` 人类侧加右 3px `--border-emphasis` 边条（与 agent 左条方位对称：右+青绿=我，左+角色色=agent）；`.mc-reply-chain` 外壳同档升档（tertiary + 全周 default 边 + 左 3px 角色色条，ChannelStreamBody 注入）；`.mc-proc-group` 边 subtle→default。零新 token（色值全走既有 `--chart-*`/`--border-*` 档）。增量六（vc7 「谁回复谁」走查）：线程内「父消息 = anchor」的逐条 quote 抑制（原形态每条回复重复同一行 anchor 引用，归属被噪音淹没；ChannelMessageItem 新增结构 prop `threadAnchorId`，StreamMessageExtra 封闭集 6→7 键）；AC1 定位契约由 `.mc-thread-context` 归属头 button 化承接（点击定位 anchor，focus-visible 规则 8，缺 Provider 退化纯展示）；组内回复非 anchor 消息时 quote 照常保留可点。契约测试 `ChannelDetailPage-quote-locate.test.tsx` AC1 用例同步重写。增量七（vc8 组内重复头走查）：折叠组/回复链内同作者相邻消息 compact 合并（一个头像 + 多条消息，ChannelStreamBody 渲染层计算，`sameAuthorOf`；反转 #277 D2 原「组内不合并各自带头」决策——逐条印头像正是「看不出同属一个角色」的噪音源），merge 契约测试同步反转。
> 依据：`docs/plans/2026-07-ui-visual-directions.md`（方向 A 已定稿并落地）
> 实现：`apps/web/src/styles/theme.css`（token + 组件类）、`apps/web/src/styles/mission-control.css`（三栏布局 mc-*）、`apps/web/src/styles/utilities.css`（语义工具类 u-*，批次 I-4 自 mission-control.css 迁出）
> 范例实现：`apps/web/src/components/ui/Modal.tsx`（弹窗正本组件，§4.3）

本规范约束 apps/web 全部页面与组件的样式写法。新增/修改 UI 时先查本文档；token 或组件类变更必须同步更新本文档。

---

## 1. 视觉基调

| 轴 | 取值 |
|---|---|
| 底色 | 近纯黑 `#050507`，层级靠明度微差（不用投影堆层级） |
| 字体 | 正文/标题/UI chrome 比例 sans（`--font-sans` 栈）；等宽 `--font-mono` 限定代码、ID、时间戳、日志、统计数字 |
| 密度 | 紧：13px 基准、行高 1.4、卡片 padding 8–12px、单行截断、数据对齐成列（密度靠行高+间距回收，不压字号） |
| 动效 | **克制白名单**：「执行中」状态点 `pulse` + 批次 D-0 起 5 类过渡场景（§2.5，批次 H-1 由 4 类扩为 5 类）；其余零动效 |
| accent | 磷光青绿 `#2ee6a8`（终端感）；告警用终端黄 `#e6c85c` |
| 气质 | Linear 风克制高密度；终端感由近黑底 + accent + 零动效承载（全等宽品牌路线已放弃，#380） |

浅色主题（`[data-theme="light"]`）机制保留，同一份代码通过 CSS 变量自动适配 —— 这正是「禁止写死颜色」的原因。

## 2. 硬性规则（Code Review 必查）

1. **禁止写死颜色**。不允许出现 `#fff`、`white`、`rgba(0,0,0,…)`、Tailwind 浅色类（`bg-white`、`text-gray-*`、`border-gray-*` 等）。颜色一律 `var(--*)` token 或 `u-*` 语义类。
2. **禁止内联布局样式能走类的走类**。组件结构类（`modal-*`、`btn`、`input`、`card`…）已存在就必须用；内联 `style` 只允许承载组件特有参数（如弹框 `maxWidth`、宽 100%）。
3. **字号只取 token**：`--fs-xs(11)` / `--fs-sm(12)` / `--fs-base(13)` / `--fs-title(16)` / `--fs-page(20)` / `--fs-stat(22)`；行高统一 `--lh-base`(1.4)。不要自造 px 字号。`--fs-page` 仅用于页面标题（`.page-title`，批次 D-1.3 新增档）；`--fs-stat` 仅用于统计卡大数字（数据展示，非标题），标题仍用 `--fs-page`/`--fs-title`。Tailwind 工具类已对齐：`text-xs/sm/base/lg/xl` 经 `index.css` `@theme` 重映射到该阶梯（2026-09 批次 C），直接用类即可；`text-2xl` 及以上保留 Tailwind 默认值，仅限装饰图标/着陆页，正文禁用。**长文阅读正文豁免**（2026-09-11 批次 H-1，人闸当场过）：markdown 渲染正文、文档阅读页允许 `lineHeight: 1.8`（长文可读性优先于密度；`MarkdownBody.tsx` / `LibraryDocPage.tsx` 为正本消费）。
4. **圆角按档位**：按钮/输入 `3px`、卡片 `4px`、模态框 `6px`、tag 全圆角 `999px`。不自造圆角值。
5. **克制动效白名单**（2026-09-10 批次 D-0 治理变更，原「不动效」条款放宽，人闸当场过）：默认仍零动画；仅以下 5 类场景允许 transition/进出场/循环动画（token `--motion-fast:100ms` / `--motion-base:150ms` / `--ease-standard`，D-2.x 已落地 theme.css + `.mc-drawer`）：① hover/focus 底色与描边过渡；② 抽屉/弹窗进出场（transform+opacity）；③ 状态色切换；④ 主题切换过渡；⑤ **加载与进度反馈**（2026-09-11 批次 H-1 收编历史遗留，人闸当场过）：spinner 旋转、忙碌状态点 pulse、进度条宽度/填充过渡——token 沿用 `--motion-*`（spinner 旋转周期 0.8s 系循环动画既有值；进度条 Tailwind `transition-all` 150ms 默认值语义在本场景内，不必改代码）。`prefers-reduced-motion: reduce` 下全禁（theme.css 既有段）。白名单外新增动效场景须再过人闸。「执行中」状态点 `pulse`（`status-pending`）不受此限。
6. **主题感知**：所有颜色经变量解析，深色/浅色自动切换；新增硬编码色 = 破坏浅色主题，视为 bug。
7. **class 体系分层归属**（2026-09-16 批次 I-1）：同一元素混用多套 class 体系时按层取舍——布局/间距/flex 走 Tailwind 工具类（`flex`/`gap-*`/`px-*`…）；颜色与语义态走 `u-*` 语义类或 `var(--*)` token（规则 1）；页面/组件结构走 BEM 页面类（`mc-*`/`wu-*`/`pmo-*`…）或 theme.css 组件类；内联 `style` 仅组件特有参数（规则 2）。新增代码不得用 Tailwind 重新发明已有 `u-*`/组件类能力（hover 底色已有 `u-hover-bg`、tab 形态已有 `u-tab`、卡片已有 `.card`）。
8. **焦点可见性**（2026-09-16 批次 I-1）：所有可交互元素（按钮、tab、可点卡片、导航项、自绘控件）必须有 `:focus-visible` 可见焦点。`.btn`/`.icon-btn`/`.select-trigger`/`u-hover-bg` 已内置；新增可交互样式必须自带焦点态（`--accent-primary` 描边或等效 box-shadow）。全局兜底环随批次 I 落地 `index.css`，组件类不得与之冲突（WCAG 2.4.7）。
9. **响应式断点统一 Tailwind 档**（2026-09-16 批次 I-1）：只取 640 / 768 / 1024（`sm`/`md`/`lg`）；废弃 639 自定义档（`responsive.css` 存量随批次 I 归并），JS 侧 `useMediaQuery` 同档对齐。移动端覆盖不得违反 §2.3/§2.4 档位（`responsive.css` 的 `.card` 12px 圆角 + 纵向 margin 覆盖系违规，批次 I 删除）。
10. **z-index 走阶梯 token**（2026-09-16 批次 I-1；批次 I-5a 已落地 theme.css）：新增层叠一律 `var(--z-*)`；存量字面量已全量归队（堆叠行为零变化），不再新增字面量。阶梯见 §3 层叠行。

## 3. 设计 Token 速查（theme.css `:root`）

| 类别 | 变量 | 深色系值 | 用途 |
|---|---|---|---|
| 背景 | `--bg-primary` | `#050507` | 页面底 |
| | `--bg-secondary` | `#0a0a0e` | 顶栏/侧边栏/次级底 |
| | `--bg-tertiary` | `#131318` | 输入框、悬浮层底 |
| | `--bg-elevated` | `#101016` | 卡片、模态框 |
| | `--bg-hover` / `--bg-active` | `#1a1a21` / `#163026` | 行 hover / 选中 |
| 文字 | `--text-primary` | `#d7dde3` | 主文字 |
| | `--text-secondary` | `#8b949f` | 说明文字 |
| | `--text-tertiary` / `--text-muted` | `#7a838e` / `#767e87` | 占位、弱化（muted 深色 ≥4.5:1 / 浅色 `#59636e` ≥4.6:1，AA 达标线，#380） |
| 品牌 | `--accent-primary` / `--accent-secondary` | `#2ee6a8` / `#1fbf87` | 主操作、链接、聚焦 |
| | `--accent-dim` / `--accent-border` / `--accent-glow` | 青绿 8%/25%/25% 透明 | 强调底色、边框、辉光 |
| 功能 | `--success` = accent、`--warning` `#e6c85c`、`--error` `#ef4444`、`--info` `#3b82f6`、`--anomaly` `#f0883e`（异常橙，与待评审黄解耦，#397/redesign §6.5；浅色 `#bc4c00`）（各配 `-dim` / `-border`） | | 状态语义 |
| 图表 | `--chart-1`…`--chart-9` | 蓝/紫/绿/灰/琥珀/红/青/粉/黄绿 | 数据可视化分类色（知识图谱节点类型等）；仅代表类别不表状态，浅色主题压暗一档保证白底可读 |
| 边框 | `--border-subtle` / `--border-default` / `--border-emphasis` | 白 7% / 白 14% / 青绿 30% | 分隔 / 常规 / 强调 |
| | `--border-strong` | 白 35%（复合 ≈`#5d5d5e`，对页底/输入底 ≥3.1:1；浅色 `#858585`，≥3.16:1——#392 色对校验定值） | 交互边界（`.input` / `.select-trigger` / 可点卡片——`.card.cursor-pointer` 或行卡 `.card:has(> .cursor-pointer)`，hover 不掉档，WCAG 1.4.11，#380） |
| 阴影/遮罩 | `--shadow-sm/md/lg/popover`、`--shadow-glow`；`--overlay-sidebar`(0.5) / `--overlay-modal`(0.7) | | 模态框用 `--shadow-lg`；`--shadow-popover`（批次 I-5a）= 小型浮层轻投影档（0 2px 8px）；遮罩两档 = sidebar 背衬 0.5 / modal 同档 0.7（`.modal-overlay` 内置 0.7 系规范豁免不走 token，`.mc-act-overlay-backdrop` 经 `--overlay-modal` 对齐） |
| 字体/密度 | `--font-sans`（正文/UI）、`--font-mono`（代码/ID/时间戳/日志/统计数字限定）、`--fs-*`（含 `--fs-page` 页面标题档、 `--fs-stat` 统计大数字专用）、`--lh-base` | | 见 §2.3 |
| 间距 | `--space-1..6` | 4/8/12/16/24/32px | 卡片 padding、列表行高、区块间距指档（#380） |
| 层叠 | `--z-below`(-1) / `--z-base`(1) / `--z-sticky`(5) / `--z-dropdown`(30) / `--z-overlay`(50) / `--z-popover`(100) / `--z-sidebar`(200) / `--z-act-overlay`(250) / `--z-drawer`(300) / `--z-modal-above`(400) / `--z-toast`(9999) | — | 规则 10（批次 I-5a 落地：值 = 存量字面量命名归队，堆叠行为不变）；新增 z-index 只取档 |

## 4. 组件规范（全部已在 theme.css 实现，直接用类）

### 4.1 按钮 `.btn` + 变体

| 类 | 场景 |
|---|---|
| `btn-primary` | 主操作（每视图最多 1 个），青绿底黑字 |
| `btn-secondary` | 次操作、取消，灰底边框 |
| `btn-ghost` | 三级操作、工具栏图标钮 |
| `btn-danger` / `btn-warning` | 危险 / 警示操作 |
| `btn-sm` | 紧凑区（表格行内、卡片操作） |

- disabled：**统一 `opacity .45` + `cursor: not-allowed`**（`.btn:disabled` 已内置，含各变体 hover 复位），不要再写行内 disabled 配色。
- focus-visible 统一青绿 glow 描边（内置）。
- **按钮归属**（2026-09-16 批次 I-1）：动作/表单按钮一律 `.btn` 体系；需要 loading 态时用 `components/ui/Button`（包装 `.btn`，含 `aria-busy` + spinner + `type="button"` 默认值）。纯图标按钮用 `.icon-btn`。禁止用 Tailwind 工具类拼凑自造按钮（无 disabled/focus 内置规则的按钮 = 违规）；存量原生 `<button>`（约 200 处）随批次 I 归队。

### 4.2 表单 `.input`

`input` / `textarea` 通用：深灰底 `--bg-tertiary`、`--border-strong` 交互边框；hover 转 `--border-emphasis`，focus 转 `--accent-primary`；placeholder 自动 `--text-tertiary`。
下拉选择不用原生 `<select>`（已弃用，见 §4.6 `Select` 组件）。
label 一律 `.form-label` 类（theme.css；批次 H-1 抽类根治——原条文给的四属性内联示例与规则 2「禁内联布局样式」自相矛盾，已废除）。

### 4.3 模态框（弹窗唯一合法结构）

弹窗一律用 `components/ui/Modal` 组件（2026-09-16 批次 I-1 起为正本）——内部渲染下述 `modal-*` 组件类结构，自带 a11y 基座：Escape 关闭（Select 面板在岗时让路防一按双关）、`role="dialog"`/`aria-modal`、焦点进出管理（打开聚焦首个可聚焦元素、关闭还焦触发元素）、点遮罩关闭。

```tsx
<Modal
  onClose={onClose}
  maxWidth="400px"            // 可选，默认 600px
  title="标题"                // 可选：渲染 modal-header + 关闭钮
  footer={<>…按钮…</>}        // 可选：渲染 modal-footer
>
  …内容…
</Modal>
```

- 遮罩/容器视觉仍由 theme.css `.modal-overlay`/`.modal` 承载（`rgba(0,0,0,.7)` + `blur(4px)` + `z-index: var(--z-overlay)`(50)），切组件零视觉变化。
- 宽度经 `maxWidth` prop 调整，其余一律类。footer 按钮顺序：次操作在左，主操作在右。
- **手写 `.modal-overlay` 结构降为豁免**：仅 `ui/Modal` 无法承载的特殊场景允许，须在注释中说明原因；存量手写弹窗（13 处）随批次 I 收编。
- 参考实现：`components/ui/Modal.tsx`。

### 4.4 其余常用类

| 类 | 用途 |
|---|---|
| `card` | 卡片容器，hover 边框提亮；可点卡片（`card` + `cursor-pointer` 组合）自动走 `--border-strong` 交互边界。批次 D-1.1：深色带 1px 顶部内高光（材质感），浅色用 `--shadow-sm` 承载分离（elevated=页底同为白） |
| `nav-item` / `nav-item-active`（批次 D-1.2） | 主导航项（SidebarNew）；active = `--accent-dim` 底 + `inset 2px 0 0` accent 左边线 + accent 文字，取代原描边盒 |
| `conn-chip`（批次 D-1.2） | 顶栏连接状态 chip（999px 圆角 pill + status-dot） |
| `brand-link` / `hamburger-btn` / `hamburger-line`（批次 D-1.2） | 顶栏品牌链接 / 移动端汉堡按钮（内联收敛） |
| `mc-error-banner`（批次 D-4） | mc-status-error 语义色的块级错误横幅（弹窗内表单错误用；ConvertToTaskDialog 正本） |
| `form-label`（批次 H-1） | 表单 label 唯一合法写法：`display:block` + `margin-bottom:4px` + `--fs-sm` + `font-weight:500` + `--text-primary`（吸收原 §4.2 四属性内联示例；FirstRoleSetupModal/StudioRoleSetupModal 正本消费） |
| `u-mb-3`（批次 D-4） | `margin-bottom: var(--space-3)` 覆盖工具类——theme/mission-control 未分层，Tailwind 工具类压不过 mc-* 类自带 margin 时用（utilities.css 有注释留痕，批次 I-4 迁址） |
| `mc-block-label-flush` / `-gap-2` / `-gap-3`（批次 G-3） | `mc-block-label` margin 覆盖变体：flush = `margin:0`（flex 行内标题），gap-2/gap-3 = `margin:0 0 var(--space-2/3)`（卡内首行标题 + 下间距）；收敛同构内联覆盖 |
| `mc-workbar-wu`（2026-09 频道视觉层次批次，mission-control.css） | 频道工作条 stepper 归属标识 chip：mono `--fs-xs` WU 短 id（`--bg-elevated` 底 + `--border-subtle` 边），点击开 WU 抽屉；ChannelWorkBar 唯一消费 |
| `icon-btn`（批次 D-0） | 顶栏/工具栏图标按钮（32px 方，bg-tertiary + border-default，hover 提亮）；ThemeToggleButton 正本消费 |
| `theme-option` / `theme-option-active`（批次 D-0） | 设置页主题选择卡（2px 边框卡片，选中态 accent 边框 + shadow-glow）；ThemeSettings 正本消费 |
| `status-dot` + `status-online` / `status-offline` / `status-pending` | 状态点（pending 带唯一允许的 pulse 动效） |
| `page-title` / `page-subtitle` | 页面标题区 |
| `empty-state`、`loading-spinner` | 见 theme.css |
| `mc-msg-skeleton`（mission-control.css） | #326 频道骨架占位行：数据层降级消息水合前的固定占位（虚线边框 `--border-subtle`、`--text-muted`、`--fs-xs`、4px 圆角），保留 `data-message-id` 供锚点定位 |
| `skeleton` / `skeleton-text`（批次 E-2，theme.css「加载状态」区） | 静态骨架占位（`ui/Skeleton` 的 SkeletonText/SkeletonCard 消费）：加载态替代「加载中...」纯文字；**静态零动画——禁止 shimmer/pulse，§2.5 白名单不覆盖** |
| `wu-row-new`（批次 E-3，workunits.css） / `mc-msg-new`（mission-control.css） | 新内容进场渐隐高亮：`--accent-dim` 底色，页面 2s 后移类、经基类 `background-color` 过渡渐隐；按 §2.5 场景③「状态色切换」语义，仅颜色属性过渡 |

### 4.5 语义工具类 `u-*`（utilities.css，批次 I-4 自 mission-control.css 迁出）

 Tailwind 布局类（flex/gap/mb-*）照常用；**颜色必须走 `u-*`**：`u-text` / `u-text-2` / `u-text-3`、`u-accent` / `u-ok` / `u-warn` / `u-err`（各配 `-dim` / `-bg`；`-border` 档例外：`u-err-border` 零引用已于 #431 退役，其余三色 `-border` 保留，需要时按档补回）、`u-anomaly` / `u-anomaly-dim`（异常橙，#397/redesign §6.5）、`u-surface-0` / `u-surface` / `u-surface-2`（档位 = `--bg-secondary` / `--bg-elevated` / `--bg-tertiary`，-0 为 #431 补全的「父级下一档」分层）、`u-hover-bg`（hover 与 focus-visible 双态同高亮，键盘可达） / `u-hover-accent`、`u-dimmed`（整卡置灰弱化，如不可认领任务单）等。

共享结构类（#431，逐字重复收敛）：`u-page-bg`（页面骨架底 = `background: var(--bg-primary)`，全站页面根/壳容器用）、`u-page-head`（页头条 = `--space-5/--space-6` padding + `--border-subtle` 底 hairline，§4.7 标准页头）、`u-page-px`（批次 F-5 新增，页面级水平 padding 正本 = `--space-6` 左右 padding（= 原 `px-8`），供内容区/tab 条/整页状态复用；`<640px` 窄屏与 `u-page-head` 同步收缩一档至 `--space-4`，断点档对齐 responsive.css）、`u-btn-reset`（裸按钮重置 = `background/border` 清零 + `cursor:pointer` + `padding:0`；字体/颜色继承由 Tailwind preflight 兜底，类上再叠 `u-accent`/`u-text-*` 等排类）、`u-tab` / `u-tab-active`（E5 新增，tab 形态正本 = 批次 D-4 定的 Knowledge border-b 形态：透明底线占位 + `margin-bottom:-1px` 压容器 hairline，激活态底线 `var(--accent-primary)`；激活态禁止再写内联 borderBottom）。

### 4.6 下拉选择 `Select`（`components/ui/Select.tsx`）

原生 `<select>` **弃用**：弹出面板由 OS 绘制，无法适配深色/浅色主题。下拉一律用 `Select` 组件（原生 select 的 drop-in 替代）：

```tsx
<Select
  value={type}
  onChange={setType}
  options={[{ value: 'rnd', label: '研发', disabled: false }, …]}
  placeholder="请选择"          // 可选：value 为空时触发器占位（--text-tertiary）
  disabled={creating}           // 可选：opacity .45 + not-allowed
  className="…"                 // 可选：叠加到触发器
  style={{ width: '100%' }}     // 可选：组件特有尺寸
/>
```

- 触发器 `.select-trigger` 视觉 = `.input`（`--bg-tertiary` 底、`--border-strong` 交互边框、3px 圆角、`--fs-base`），右侧 `▾` 指示（`--text-tertiary`）；`data-testid` / `aria-label` / `title` 经 props 透传。
- 选项面板 `.select-panel`：**portal 到 `document.body`**、fixed 定位（贴触发器下方、宽度对齐），`max-height: 240px` 可滚动，`z-index: var(--z-popover)`(100)（须高于 `.modal-overlay` 的 `--z-overlay`(50)），不被 modal-body 等 overflow 容器裁剪。
- 选项行 `.select-option`：hover / 键盘高亮 `--bg-hover`；选中项 `.is-selected` = `--bg-active` + `--accent-primary` ✓；禁用项 `.is-disabled` = `--text-muted`、不可点、无 hover。
- 关闭：点外部 / Escape / resize / 滚动。键盘：Enter/Space/↑↓ 打开与高亮移动，Enter 选中；ARIA：触发器 `aria-haspopup="listbox"` + `aria-expanded`，面板 `role="listbox"`，项 `role="option"` + `aria-selected`。
- 零动画、零硬编码颜色（全部 `var(--*)` token）。

### 4.7 页面骨架（所有列表/详情页统一）

```tsx
<div className="h-full flex flex-col u-page-bg">
  <div className="u-page-head">
    <div className="flex items-center justify-between">
      <div>
        <h1 className="page-title">页面标题</h1>
        <p className="page-subtitle">一句话说明</p>
      </div>
      <div className="flex gap-2">…右侧操作（btn 体系）…</div>
    </div>
  </div>
  <div className="flex-1 overflow-auto px-8 pb-8">
    <div className="max-w-5xl">…内容…</div>
  </div>
</div>
```

- 页面底 / 页头条禁止再写内联 `background: 'var(--bg-primary)'` / `px-8 py-6` + 内联 borderBottom，一律 `u-page-bg` / `u-page-head`（#431）；其余分隔线 hairline 走 `border-b u-border` / `border-t u-border` 组合，不新建类。
- 标题禁止 `text-2xl font-bold` + 内联颜色；一律 `page-title` / `page-subtitle`。
- 卡片容器一律 `.card`（`--bg-elevated` 底 + `--border-subtle` 边 + 4px 圆角），禁止 `rounded-lg` + 内联 background/border 自造卡片。**不存在 `--bg-card` token**，卡片底 = `--bg-elevated`。
- 区块标题用 `.mc-block-label`（小字大写风）或 `u-text-2`；不要 `text-lg font-semibold` + 内联颜色。
- 文字色三档：`u-text`（正文）/ `u-text-2`（说明）/ `u-text-3`（弱化）；不存在 `u-text-1`。
- 裸按钮（只要文字/图标、无 btn 体系的边框底色）：`u-btn-reset` + 排类组合，不再逐字内联 `background:'none', border:'none', …`。

### 4.8 accent 品牌时刻（批次 D-1.4）

accent 磷光青绿是全站最稀缺资源，只许出现在 4 个位置：**主导航 active 态 / 主行动按钮（btn-primary）/ 当前执行站（stepper 当前站、运行中状态点）/ 关键告警锚点**。其他场景（装饰、次要徽标着色）禁用 accent——看到青绿 = 可行动或正在发生。类别区分用 `--chart-*`，状态语义用功能色，都不许借 accent。豁免（2026-09-11 批次 H-1，人闸当场过）：统计卡大数字（`--fs-stat` 档）的数据强调允许 accent（AgentDetailPage / MonitoringPage / AuditLogsPage 等统计卡现状收编，语义 = 关键数据强调）。

## 5. 与 Design Lab 的关系
- `/design-lab`（`apps/web/src/pages/design-lab/`）是 2026-07 方向决策阶段的 **A/B 原型**，使命已完成：方向 A 被选定并落地为 `theme.css` + `mission-control.css`。
- Design Lab 目录已随全量重构删除（2026-08 工单 22，零导航入口、全 mock）；决策回溯材料见 `docs/plans/design-lab/` 截图。
- **本文档是唯一持续维护的样式规范**；token/组件类变更流程：改 `theme.css`（或 `mission-control.css` / `utilities.css`）→ 更新本文档 → 在 PR 描述中注明。

## 6. 反例（修复前实录）

`FirstRoleSetupModal` 曾全量内联写死浅色样式（`background:'white'`、`border:'1px solid #ccc'`、`background:'#2563eb'`），在深色主题下为全白刺眼弹框。已按 §4.3 重写：结构走 `modal-*`，输入走 `.input`，按钮走 `.btn btn-primary/secondary`，disabled 交给内置规则。改造即本规范的最小应用示例。

`StudioRoleSetupModal` 曾犯同样问题（2026-07-29 修复）：内联 `background:'white'`、`color:'#666'`、`background:'#2563eb'`。已按 §4.3 重写，与 `FirstRoleSetupModal` 同构。

2026-08-03 全站统一收敛：① 深色文字 token 提对比度（`--text-secondary/tertiary/muted` 原值在近黑底上仅 2.5–5.3:1，"看不清"的主因）；② `/knowledge`、`/wiki`、`/settings`、`/skills`、`/audit-logs`、`/pmo` 及各详情页从「内联 style + `text-2xl`」收敛到 §4.7 页面骨架；③ `RolesSetup` 整页硬编码浅色 hex 重写；④ 共享组件（Modal/DeleteConfirmModal/StanceBadge/KnowledgeGraphView 等）硬编码色全部 token 化；⑤ 修复引用不存在 token 的 bug（`--bg-card` ×6、`u-text-1`、`--accent-danger`、`--danger`）。

2026-08-04 收尾：⑥ 新增 `--chart-1…9` 图表分类色（浅色压暗一档），`KnowledgeGraphView` 节点色板消费 token，`colorMode` 改为跟随 `ThemeContext`（原写死 `"dark"`，浅色主题下图谱 canvas/MiniMap 仍按深色渲染）；⑦ 新增 `--fs-stat(18)` 统计大数字专用，全站 21 处 `text-2xl/text-lg font-bold` 统计数字统一替换；⑧ 补 `--info-dim/border`（§3 宣称各功能色配 `-dim/-border`，info 实际缺失）；⑨ 修复 `.btn-primary` 写死 `color:#050507`（浅色主题下蓝底近黑字，真 bug）；⑩ `TaskCard`/`Timeline`/`CheckpointTimeline`/`ReviewPanel`/`SidebarNew`/`FilePreview`/`LoginModal` 的 rgba 状态底色（emerald/cyan/indigo 散色）全部收敛到 `--success/--error/--info/--accent` 的 `-dim/-border` token；⑪ `WorkspacePage`/`WorkUnitListPage`/`Onboarding`/`LoginModal` 自写 `bg-black/NN` 遮罩收敛到 §4.3 `modal-overlay` 标准结构；⑫ 删除无消费方的 `.u-on-bright`。
