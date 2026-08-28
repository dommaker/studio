# 研究：深色工具型界面（Linear 风）可读性基线

- 票：#378（Wayfinder map #377「Studio Web UI/UX 改版」research 子票）
- 日期：2026-08-28
- 现状对照：`apps/web/src/styles/theme.css`（:root 深色 `#050507`、全等宽、`--fs-base: 12.5px`、字号阶梯在 71–76 行）、`docs/specs/ui/style-guide.md`
- 用途：为后续「视觉基线 token 定值」票提供事实输入。本报告只给事实清单 + 建议取值区间，不做定值决策。

---

## 1. 字号阶梯：主流深色工具 UI 参考值

### 1.1 一手数据

**GitHub Primer（开源，token 级一手）**

字号 token（`@primer/primitives`，rem 基 16px）：

| 角色 | token | 值 |
|------|-------|-----|
| body.large | base.text.size.md | 16px |
| body.medium（默认正文） | base.text.size.sm | 14px |
| body.small / caption | base.text.size.xs | 12px |
| title small/medium/large | md/lg/xl | 16 / 20 / 32px |
| subtitle | lg | 20px |
| display | 2xl | 40px |
| codeBlock | 固定值 | 13px（mono） |
| codeInline | 0.9285em | ≈13px（mono） |

行高 token：tight 1.25 / snug 1.375 / normal 1.5 / relaxed 1.625 / loose 1.75；正文用 normal(1.5)，caption 用 tight(1.25)。

来源：[primer/primitives `src/tokens/base/typography/typography.json5`](https://github.com/primer/primitives/blob/main/src/tokens/base/typography/typography.json5)、[`src/tokens/functional/typography/typography.json5`](https://github.com/primer/primitives/blob/main/src/tokens/functional/typography/typography.json5)、[Primer primitives size 文档](https://primer.style/foundations/primitives/size)

**VS Code（开源，源码级一手）**

- Workbench（UI chrome：侧栏、面板、菜单）：固定 `font-size: 13px`，`line-height: 1.4em`（`src/vs/workbench/browser/media/style.css` 的 `.monaco-workbench`）
- 编辑器正文：默认 14px，macOS 默认 12px（`src/vs/editor/common/config/fontInfo.ts` 的 `EDITOR_FONT_DEFAULTS.fontSize: platform.isMacintosh ? 12 : 14`）
- 行高缺省 = `GOLDEN_LINE_HEIGHT_RATIO (≈1.35) * fontSize`（同文件）
- UI 用系统比例字体（Windows Segoe UI / macOS -apple-system / Linux system-ui），mono 栈（`--monaco-monospace-font`）只给编辑器等代码区

来源：[microsoft/vscode `src/vs/workbench/browser/media/style.css`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/media/style.css)、[`src/vs/editor/common/config/fontInfo.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/config/fontInfo.ts)

**Linear（生产 CSS 一手 + 社区快照二手）**

从 `static.linear.app` 生产 CSS 提取的真实 token（html font-size:100%，rem=16px）：

| token | rem | px |
|-------|-----|----|
| text-tiny | .625 | 10 |
| font-size-micro / text-micro | .6875 / .75 | 11 / 12 |
| font-size-mini / text-mini | .8125 | 13 |
| font-size-small / text-small | .875 | 14 |
| font-size-regular / text-regular | .9375 | 15 |
| font-size-large / text-large | 1.125 / 1.0625 | 18 / 17 |

行高 1.4–1.6，正文带负字距（-0.011em ~ -0.015em）。字体栈 `--font-regular: "Inter Variable", "SF Pro Display", ...`（sans）；`--font-monospace: "Berkeley Mono", ...` 只用于代码。字重阶梯 300/400/510/590/680。

注意：以上为 linear.app 公开站点 CSS（与应用同设计语言）；应用本体在登录墙后。应用内 UI 文本 13px 的说法来自逆向快照（[Refero Styles 的 Linear 快照](https://styles.refero.design/style/90ce5883-bb24-4466-93f7-801cd617b0d1)：Inter 13px / weight 400 / #8a8f98），标记为二手。

**Raycast / macOS 原生系**

Raycast 是 macOS 原生应用，跟随 Apple HIG：macOS 系统 UI 正文 = SF Pro 13pt Regular。多个设计快照（[Lumina-Note DESIGN.md](https://github.com/blueberrycongee/Lumina-Note/blob/main/DESIGN.md)「13px Rule」：Apple/Linear/OpenAI/Raycast 桌面控件文字都落在 13px；<12px 禁用）佐证这一点，均标记为二手。

**JetBrains IDE（New UI，官方文档一手）**

New UI 全平台统一用 Inter 做 UI 字体（[New UI | IntelliJ IDEA 官方文档](https://www.jetbrains.com/help/idea/new-ui.html)）。

### 1.2 区间汇总

| 层级 | 主流区间 | studio 现状 | 差距 |
|------|---------|------------|------|
| base（正文） | **13–15px**（工具型集中在 13–14） | 12.5px | 偏低 0.5–1.5px |
| sm（次要） | 12–14px | 11.5px | 偏低 |
| xs（辅助/标签） | 11–13px；**<11px 基本绝迹**（VSCode/Primer 最小 12，Linear micro 11 仅用于极少量标签） | 10.5px | 明显低于主流下限 |
| title（面板/卡片标题） | 15–20px | 13.5px | 偏低，层级拉不开 |
| 行高 | 正文 1.4–1.5，小字 1.25–1.4 | 1.45 | 正常 |

结论：**"字小看不清"的反馈与事实一致**——studio 全阶梯比主流低约 1–2px，且 xs=10.5px 已低于所有调研对象的最小值。

## 2. WCAG 对比度与近黑底色值组织

### 2.1 规范基线（一手：[WCAG 2.2](https://www.w3.org/TR/WCAG22/)）

- **SC 1.4.3 Contrast (Minimum), AA**：文字 ≥ **4.5:1**；大字（≥24px，或 ≥18.66px 且粗体）≥ 3:1；非活跃组件/纯装饰文字豁免。AAA 级 7:1。
- **SC 1.4.11 Non-text Contrast, AA**：识别 UI 组件和状态所必需的视觉信息 ≥ **3:1**（对相邻色）；非活跃组件、纯装饰豁免。
- 规范不因深色模式降低要求；"边框"是否受 1.4.11 约束取决于它是否是识别组件边界所必需——纯装饰 hairline 可豁免，输入框等交互边界不豁免。

### 2.2 studio 现状实测（WCAG 相对亮度公式，对 #050507）

| token | 色值 | 对比度 | 判定 |
|-------|------|--------|------|
| text-primary | #d7dde3 | 14.9:1 | AAA ✓ |
| text-secondary | #8b949f | 6.6:1 | AA ✓ |
| text-tertiary | #7a838e | 5.3:1 | AA ✓ |
| **text-muted** | #6e7782 | **4.48:1** | **AA 4.5 差 0.02，卡线不达** |
| accent | #2ee6a8 | 12.6:1 | ✓（作为文字色时） |
| border-subtle | rgba(255,255,255,.07) → 复合 #171718 | 1.14:1 | 仅作装饰豁免下可用 |
| border-default | rgba(255,255,255,.14) → 复合 #28282a | 1.38:1 | 同上；若用于输入框等交互边界则远低于 3:1 |

### 2.3 三个参照系的色值组织（实测对比度）

**GitHub dark（底 #0D1117，非近纯黑 ≈7% 明度）**——组织方式 = 单一中性色阶梯 neutral.0–13，语义角色引用阶梯编号，每个主题一组 override：

| 角色 | 取值 | 对比度 |
|------|------|--------|
| fgColor.default | #F0F6FC (neutral.12) | 17.4:1 |
| fgColor.muted | #9198A1 (neutral.9) | 6.5:1 |
| borderColor.default | #3D444D (neutral.7) | 1.9:1 |
| borderColor.emphasis | #656C76 (neutral.8) | 3.6:1（>3:1，供需要识别边界的组件） |
| bgColor.muted | #151B23 (neutral.2) | 层级靠明度微差 |

GitHub 的工程做法（[GitHub Blog: Unlocking inclusive design](https://github.blog/engineering/user-experience/unlocking-inclusive-design-how-primers-color-system-is-making-github-com-more-inclusive/)）：把对比度要求编码成"色对清单"（如默认文字须同时对 default/muted 背景达 4.5:1、对链接色达 3:1），写脚本全主题自动校验，并接成 PR 上的 GitHub Action 卡口；半透明色先与底色调和成实色再算对比度。

**VS Code Dark Modern（编辑器底 #1F1F1F ≈12% 明度）**：fg #CCCCCC 10.3:1；description #9D9D9D 6.1:1；行号等弱化文字 #6E7681 3.6:1（装饰性弱化，低于 4.5）；边框 #2B2B2B/#3C3C3C 仅 1.2–1.5:1。

**Linear（底 #08090a，与 studio 同为近纯黑）**：fg #f7f8f8 18.7:1；secondary #d0d6e0 13.6:1；muted #8a8f98 6.1:1；quiet #62666d 3.45:1（刻意弱化，不达 AA，用于点缀性元信息）；hairline #1c1d1e/#23252a 1.2–1.3:1（装饰）。

### 2.4 结论

- **正文**：近黑底上主流落在 10–18:1（≈ #cccccc–#f7f8f8）；studio primary 已达标。
- **次要文字**：主流 6–6.6:1（#8a8f98 / #9198a1 / #9d9d9d 这一档蓝灰）。studio secondary 6.6:1 已对齐。
- **弱化文字（第三档）**：AA 底线 4.5:1 ≈ #767d86（对 #050507）。studio muted 4.48:1 需微抬（如 #6e7782 → #757d86）；Linear/VSCode 存在刻意低于 4.5 的"quiet 档"（3.4–3.6:1），但那是点缀用途，不能用于正文信息流。
- **边框**：装饰 hairline 1.1–1.4:1 是通行做法（近黑底上 ≈ rgba 白 7–10%）；**需要承担组件边界识别的（输入框、可点卡片）应另设 emphasis 档 ≥3:1**（GitHub 的做法：borderColor.emphasis = 3.6:1；近黑底上 ≈ rgba 白 28%+ 或 #3d444d 档实色）。
- **组织方式参照 GitHub**：一条明度单调的中性阶梯（近黑 → 近白）+ 语义角色 token 指向阶梯编号 + 色对对比度清单脚本化校验。比 studio 现在的"每角色独立 hex + rgba 白边框"更可控。

## 3. 信息密度与可读性的平衡实践

事实观察：

1. **密度用间距调，不用字号压**。JetBrains New UI 的 Compact mode 官方定义即"减工具栏/工具窗口头部高度、缩 padding 和间距、缩小图标按钮"——字号不动（[官方文档](https://www.jetbrains.com/help/idea/new-ui.html)）。主流密度档位（Gmail Default/Comfortable/Compact、Material density 体系同理）都是动行高/padding。
2. **13–14px + 紧行高(1.35–1.45) + 4px 间距网格**是 Linear/Raycast/VSCode 系保持高密度的共同配方；密度来自垂直节奏，不来自缩小字形。
3. **弱化信息用颜色降对比（quiet 档 3.4–3.6:1），不是缩字号**。小字号 + 低对比叠加是最差组合——studio 现状 xs=10.5px × muted 4.48:1 正中此坑。
4. **抬字号不必牺牲密度的手段**：行高从 1.45 → 1.35–1.4（VSCode workbench 即 1.4em）；行间 padding 走 4px 网格压缩；行内次要信息合并为 meta 行；列宽不够时用截断+title 提示而非缩小字号。

## 4. 全局等宽字体用于 UI 正文

**主流做法（全部一手可验）：UI 正文用比例字体，mono 只给代码/ID/数字。**

- VSCode：workbench 用 Segoe UI/-apple-system/system-ui，mono 栈仅编辑器与代码部件（源码见 §1.1）
- Linear：`--font-regular` = Inter Variable（UI），`--font-monospace` = Berkeley Mono（代码）
- GitHub Primer：`fontStack.sansSerif`（UI）与 `fontStack.monospace`（代码块/行内代码）分离（[typography.json5](https://github.com/primer/primitives/blob/main/src/tokens/functional/typography/typography.json5)）

**等宽做 UI 正文的利**：

- 列/表格对齐天然成立；数字纵向对齐（时间戳、ID、指标列）
- "终端感"品牌气质，契合 Mission Control 定位（studio 方向 A 的初衷）

**弊**：

- 词形轮廓被等宽破坏（i/l 撑宽、w/m 压缩），长句扫读速度慢于比例字体；阅读研究指出 mono vs proportional 影响词的整体可辨识度与阅读适应（[SKYbrary 航空系统字体报告 §6.1.3](https://skybrary.aero/sites/default/files/bookshelf/5547.pdf)；[ECEM 2019 眼动会议摘要, Jarosch et al.](https://www.eyemovement.org/pdf/ecem2019_abstracts.pdf)）
- 横向空间利用率低：等宽字均宽偏大，同样字号下每行容纳字符更少——**"全等宽省空间"是反的，它反而更费横向空间**
- CJK 混排时西文 mono 栈与中文全角宽度不成整数倍关系，对齐承诺在中文界面里本来就兑现不了
- 同字号下等宽字形显小（x 高/字面比通常小于 Inter 类 UI sans），12.5px mono 的视觉大小约等于 11.5px sans——"字小"反馈被等宽进一步放大

**两全做法**：正文 sans + `font-variant-numeric: tabular-nums`（比例字体的等宽数字特性）拿表格数字对齐；代码/ID/日志/时间戳保持 mono。这是 GitHub/Linear 的实际分工。

## 5. 建议取值区间（给定值票的事实输入）

> 仅为区间建议，最终定值归「视觉基线 token 定值」票。

**字号阶梯**（对齐主流，保持 1px 级差的紧阶梯）：

| token | 建议区间 | 参照 |
|-------|---------|------|
| fs-base | **13–14px** | Linear app 13 / VSCode 13 / Primer 14 |
| fs-sm | 12–13px | Primer body.small 12 |
| fs-xs | **11–12px，不低于 11** | Linear micro 11 / Primer caption 12 |
| fs-title | 15–17px | Primer title.small 16 |
| fs-stat | 18–24px 保留 | — |
| lh-base | 1.4–1.45（抬字号后可压到 1.35–1.4 换密度） | VSCode 1.4em |

**色值组织**（沿用 #050507 近黑底）：

- text-primary：维持 #d7dde3 档（≥10:1 富余，不必更亮，避免全白刺眼；Linear 用 #f7f8f8、GitHub 用 #f0f6fc，更亮也可选）
- text-secondary：维持 #8b949f（6.6:1 ✓）
- text-tertiary/muted：**抬到 ≥ #757d86（4.5:1 达标线）**；如需"quiet 点缀档"单列，明确只用于非信息性装饰文本
- 边框双轨：装饰 hairline 维持 rgba 白 7–10%；**交互边界（input、卡片可点区、focus 态）新增/改用 ≥3:1 档**（rgba 白 ≥28% 或 #3d444d 级实色）
- 工程化：仿 GitHub 建"色对对比度校验脚本"（对每主题算 token 色对），防止后续改色破对比度

**密度**：抬字号后用行高 1.35–1.4 + padding 4px 网格回收垂直空间；不动密度语义。

**字体**：建议正文/标题改比例 sans 栈（system-ui/Inter 类），mono 限定代码、ID、时间戳、统计数字；表格数字用 `tabular-nums`。若坚持全等宽品牌路线，需同时接受：base 字号要比 sans 再抬 0.5–1px 补偿视觉显小，且长文阅读性能低于主流。

## 附：来源清单

一手：
- [WCAG 2.2 — SC 1.4.3 / 1.4.11](https://www.w3.org/TR/WCAG22/)
- [primer/primitives：base typography / functional typography / dark 色系 token](https://github.com/primer/primitives)（fg/bg/border 的 dark override 与 neutral 阶梯值取自 `src/tokens/` 原始 JSON5）
- [GitHub Blog: Unlocking inclusive design（Primer 对比度工程实践）](https://github.blog/engineering/user-experience/unlocking-inclusive-design-how-primers-color-system-is-making-github-com-more-inclusive/)
- [microsoft/vscode：workbench style.css / editor fontInfo.ts / theme-defaults dark_modern.json](https://github.com/microsoft/vscode)
- [JetBrains: New UI 官方文档（Inter 字体、Compact mode）](https://www.jetbrains.com/help/idea/new-ui.html)
- linear.app 生产 CSS（`static.linear.app/web/_next/static/css/index.*.css`，字体/字号 token 直接提取）

二手（已标注）：
- [Refero Styles Linear 快照（app 内 13px/#8a8f98）](https://styles.refero.design/style/90ce5883-bb24-4466-93f7-801cd617b0d1)
- [Lumina-Note DESIGN.md「13px Rule」](https://github.com/blueberrycongee/Lumina-Note/blob/main/DESIGN.md)
- [SKYbrary 字体报告 §6.1.3](https://skybrary.aero/sites/default/files/bookshelf/5547.pdf)、[ECEM 2019 摘要集](https://www.eyemovement.org/pdf/ecem2019_abstracts.pdf)（mono/proportional 可读性）

测量方法：对比度按 WCAG 2.2 相对亮度公式计算；半透明边框先与底色按 alpha 调和成实色再计算（同 GitHub 做法）。
