# scripts/visual — 页面截图采集与 diff 工具（#391，#390 半机制）

改版验收用：可重复采集全站 12 页默认态截图 + 逐像素 diff 报告。不进 CI、不设断言；
基线 PNG 本地不入 git，diff 报告入 git 作验收凭据。改版验收后工具可弃。

## 采集

```bash
# 前置：dev 栈在跑（API + vite），环境变量给 refresh token（dev 数据根既有 Admin 用户的，
# 注意 refresh 会轮换——每次运行前要取最新的）
VISUAL_REFRESH_TOKEN=<token> npx tsx scripts/visual/capture.ts --name <run>
# 选项：--base-url（默认 http://localhost:13000/dev/） --api-url（默认 http://localhost:13001）
#        --widths 1024,768,640,375 覆盖宽度档（窄屏走查，#395；高度在 config.ts HEIGHTS 登记）
# 缺浏览器二进制时：VISUAL_BROWSER_CHANNEL=chrome 走系统 Chrome
```

输出 `.studio/visual/<run>/<page>-<width>.png`（12 页 × 1920/1440/1280，gitignored）。
带参页（频道/PMO 项目/WU/Agent 详情）目标 id 运行时经列表 API 取第一条，无数据则跳过并告警。

## diff

```bash
npx tsx scripts/visual/diff.ts <runA> <runB> [--out <目录>]
# 默认报告目录：docs/visual-reports/<YYYYMMDD>-<runA>-vs-<runB>/（report.md + 差异页对比图，入 git）
```

差异率分档：0 = clean；<1% = minor（可归因动态组件/抗锯齿）；≥1% = major（人工看对比图）。
对比图为纯差异掩码（透明底 + 红色差异像素，`diffMask: true`）——公开仓脱敏，不含灰底原图；
掩码仍会呈现变化内容的文字形状，提交报告前逐张过目（public_repo_sanitization）。
入库报告的 non-clean 条目须在报告末尾人工补「归因」段（本目录首份报告有例）。

## 稳定化（#390 决议）

`reducedMotion` + 截图 `animations:'disabled'` + `page.clock.setFixedTime` 假时钟
（config.ts `FIXED_TIME`）+ 拍前注入 `[data-visual-ignore]{visibility:hidden}` 隐藏已知动态组件
（NotificationBell 角标/时刻、TriageBanner、RoleCard/AgentDetailPage 相对时间戳）
+ 拍前等「加载中/Loading」文案消失（4s 兜底）。

已知不可消除 diff（可归因，不追零）：频道消息流 SSE 新消息插入导致滚动窗口移动
（#系统 频道 Monitor 告警洪水尤甚）。

## 交互态扩展位（§10.4）

`capture.ts` 的 `PREPARE` 表：按页面名注册 `[状态名, prepare(page)]`，默认态拍完后执行交互
加拍 `<page>-<state>-<width>.png`。按 implement 票需要逐个加（modal 族/Select/NotificationBell
下拉/数据变体，清单见 spec §10.4），不一次写全。

## 基线

改版前基线：`.studio/visual/baseline-pre-redesign/`（2026-08-29 拍，本机，不入 git）。
工具自证报告（同栈两轮 diff）：`docs/visual-reports/20260829-baseline-pre-redesign-vs-stability-check/`。
