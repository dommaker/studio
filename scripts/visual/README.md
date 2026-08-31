# scripts/visual — 页面截图采集与 diff 工具（#391，#390 半机制）

改版验收用：可重复采集全站 12 页默认态截图 + 逐像素 diff 报告。不进 CI、不设断言；
基线 PNG 本地不入 git，diff 报告入 git 作验收凭据。改版验收后工具可弃。

## 采集

```bash
# 前置：dev 栈在跑（API + vite），环境变量给 refresh token（dev 数据根既有 Admin 用户的，
# 注意 refresh 会轮换——每次运行前要取最新的；/audit-logs、/workspaces/:id、/setup/roles 需 Admin）
VISUAL_REFRESH_TOKEN=<token> npx tsx scripts/visual/capture.ts --name <run>
# 选项：--base-url（默认 http://localhost:13000/dev/） --api-url（默认 http://localhost:13001）
#        --widths 1024,768,640,375 覆盖宽度档（窄屏走查，#395；高度在 config.ts HEIGHTS 登记）
#        --tier B  未认证 B 档页（spec §10.2：landing/forgot/reset/auth-callback，
#                  默认 1920/1440 两档；不种 auth、不需要 token）
# 缺浏览器二进制时：VISUAL_BROWSER_CHANNEL=chrome 走系统 Chrome
```

输出 `.studio/visual/<run>/<page>-<width>.png`（A 档 17 页 × 1920/1440/1280，gitignored）。
带参页（频道/PMO 项目/WU/Agent 详情/library 文档/workspace）目标 id 运行时经列表 API 取第一条，
无数据则跳过并告警；id 含 `/`、`:` 的（libraryDocId）经 encodeURIComponent 填路径。

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

`capture.ts` 的 `buildPrepare(params)` 工厂：按页面名注册 `[状态名, prepare(page)]`，默认态拍完后执行交互
加拍 `<page>-<state>-<width>.png`。prepare 返回 false 跳拍（数据前置不满足/入口隐藏）。
#400 已注册点名清单：modal 族（workspace 创建角色 24rem / workunits 拒绝原因 24rem + 确认分析结论 28rem /
workunit-detail 拒绝原因 / audit-logs 日志详情 672px / settings StudioRoleSetupModal 400px /
landing AuthModal 24rem）、Select 下拉（audit-logs）、NotificationBell 下拉+未读角标（settings，
拍前揭开 data-visual-ignore）、MoreDropdown（settings）；数据变体：audit-logs 空态（route 拦截）、
workunits 超长 scope truncate（真实响应改长第一行）。注意：
- StudioRoleSetupModal 态会把 studio 角色 provider 翻牌为 null 再 reload 触发，紧随的
  `restore-studio-provider` 态（返回 false 不拍）负责还原——勿拆散这对。
- 交互态截图前不再重复注入 HIDE_DYNAMIC_CSS（否则盖掉 prepare 里的角标揭开）。
- 未覆盖：FirstRoleSetupModal（400px 同构，触发需清空全部角色 provider，不动共享 dev 数据）、
  ConfirmDialog 强制停止（420px，需运行中实例；不在 §10.4 点名清单）、OAuthCallback（无参裸访问
  立即重定向 landing，无稳定帧，B 档以 landing 画面兜底）。

## 基线

改版前基线：`.studio/visual/baseline-pre-redesign/`（2026-08-29 拍，本机，不入 git）。
工具自证报告（同栈两轮 diff）：`docs/visual-reports/20260829-baseline-pre-redesign-vs-stability-check/`。
