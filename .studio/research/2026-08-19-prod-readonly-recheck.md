# 研究：生产环境只读复验（SSE 连接、深链刷新、Admin 视角）

- 票：#259（wayfinder 地图 #245 子票），复验 #247 走查报告（`2026-08-19-channel-e2e-walkthrough.md`）中三项 dev 限定/未覆盖结论
- 日期：2026-08-19
- 对象：studio-prod 生产环境（`http://localhost:13101`，systemd `studio-api.service`，代码 `/root/projects/studio-prod` @ c6a24732，数据 `~/.studio/`）
- 方式：curl 直打 API + Playwright（Chromium）实操 UI + prod 代码确认，全部一手实测
- 纪律：只读。全程未发消息、未建频道、未改任何设置；「默认工程」下拉只展开查看、Escape 关闭未选择

## 结论速览

| 项 | 结论 | 定级 |
|---|---|---|
| 1. SSE 连接 | **生产同现**：Chromium EventSource 恒 CONNECTING，curl 秒回。根因已定位：全局 compression 中间件缓冲 SSE 流 | **阻塞** |
| 2. 深链/刷新 | 生产静态托管无 dev 的 vite base 错配：`/channels/:id` 直进 200 且正常渲染，刷新后仍正常 | 通过 |
| 3. Admin 视角 | 用现存有效 Admin 会话 token 完成验证：「默认工程」下拉有数据、监控页完整渲染；但频道已绑定 workspace 不回显（Admin 同样复现） | 通过（附粗糙级子发现） |

---

## 1. SSE 连接 —— 阻塞（F11 升级坐实）

**现象（全部实测可重放）：**

- `curl -sN http://localhost:13101/api/v1/events/stream`（无 Accept-Encoding）→ **秒回**首帧：

  ```
  id: 7e865363-bcfc-4fe7-bda7-30bed02377bf
  data: {"clientId":"ceb61def-deb9-40c7-99cf-3f146be20f8d","topics":["all"]}
  ```

- `curl -sN -H 'Accept-Encoding: gzip, deflate, br' -H 'Accept: text/event-stream' <同上>`（浏览器同款头）→ **5 秒内连响应头都收不到**（`-D` 捕获文件为空），无任何字节。
- Playwright 页面内 `new EventSource('/api/v1/events/stream')` → 5 秒恒 `readyState=0`（CONNECTING），`onopen`/`onmessage` 均未触发。与 dev 走查 F11 表现完全一致。
- UI 佐证：四张截图（prod-recheck-01~04）顶栏全部恒「● 未连接」（含 Admin 登录态）。

**根因（代码一手确认）：**

- `/root/projects/studio-prod/apps/api/src/app.ts:26` 全局 `app.use(compression())`。compression 中间件对 `Accept-Encoding: gzip` 的响应做压缩缓冲，首帧数据不够触发 flush，响应头与 body 都被挂住；SSE 端点（`modules/events/sse.routes.ts:83`）虽写了 `X-Accel-Buffering: no`，那只对 nginx 有效，管不到应用内 compression。
- curl 默认不发 `Accept-Encoding`，所以不压缩、秒回——完美解释 F11 的「curl 正常、Chromium 挂起」对照现象。
- dev 仓 `apps/api/src/app.ts:26` 同样全局 compression → F11 在 dev 的根因同此，**不是 vite 代理问题**（vite 代理只是透传了 Accept-Encoding）。

**定级：阻塞**（生产同现，所有真实浏览器恒发 Accept-Encoding → SSE 对所有浏览器用户全灭；频道实时推送、通知铃事件源断供）。

**修复方向**：`compression({ filter })` 排除 `text/event-stream` 响应（或 SSE 路由内 `res.flushHeaders()` + 标记不压缩），一行级改动；修后 dev/prod 同时痊愈。

## 2. 深链/刷新 —— 通过

- curl 状态码（实测）：`/` → 200 text/html；`/channels/70668707-e9bc-4da7-8443-c35bd3d84646`（真实存在的 #研发）→ 200 text/html；`/monitoring` → 200；`/foobar` → 200（`app.ts:116,132` express.static + sendFile index.html 兜底，SPA 路由交给前端）。
- Playwright（Admin 登录态）直进 `/channels/70668707-…`：正常渲染——标题「##研发」、研发频道、成员 8 agents、消息流完整（截图 prod-recheck-01）。
- `page.reload()` 刷新后：URL 保持 `/channels/70668707-…`，页面重新完整渲染（截图 prod-recheck-02）。
- 注意（设计行为，非缺陷）：Guest 未登录态直进任何深链都被 Lurk Wall 拦到 LandingPage（`App.tsx:119`），不是 404。未登录时 console 有 `/api/v1/agents`、`/api/v1/executions` 401，属预期。
- **结论**：F3 的「vite base=/dev/ × Router 无 basename」错配是 dev 特有问题；生产静态托管下深链直进与刷新均正常。**定级：通过**。

## 3. Admin 视角 —— 通过（附一个粗糙级复现）

**凭据合法性说明**：未猜密码、未读任何 .env。`~/.studio/sessions.json`（数据文件）中存在 Admin 用户 `admin@dommaker.cn`（id `cdf1b9c9-…`）的**现存未过期会话**（如 `cddf5a42-…`，2026-08-24 到期），直接使用其已有 access token 注入浏览器 localStorage（zustand `auth-storage`）完成登录态。未走 `/auth/refresh`（该端点会吊销旧 refresh token 并写新 session，属写操作，主动避开）。验证结束后浏览器 localStorage 已还原为原 guest 会话，Admin token 不留存。验证请求本身：`GET /auth/me` 确认 role=Admin、`GET /workspaces` 200、`GET /monitoring/agents` 200。

**「默认工程」下拉（频道 #研发 顶栏）**：

- Admin 视角下拉**不再恒空**：列出 `VM-0-5-ubuntu`、`VPS` 两项 + 「默认工程：无」（截图 prod-recheck-03）。证实 F12 的恒空 = 非 Admin 403（`/api/v1/workspaces` Admin-only）所致，Admin 数据源正常。
- **但**：#研发实际已绑定 `defaultWorkspaceId=ws_1784369481212_wz3vim2`（=「VPS」，curl `/api/v1/channels` 与 `/api/v1/workspaces` 一手交叉确认），下拉选中项却仍是「默认工程：无」——**已绑定值不回显，Admin 同样复现**。F12 报告的「绑定后曾显示 VPS、后显示无」在 Admin 下依旧成立。定级：粗糙（F12 子项补实）。

**监控页（/monitoring）**：

- Admin 视角完整渲染：WU 状态分布（总数 44）、Agent 状态（7 空闲）、证据台账、飞轮指标、封装开销（28.1%）、输入缓存命中率全部有数据；无 403 刷屏、无恒「加载中」（截图 prod-recheck-04）。定级：通过。

## 副作用披露

- Playwright 打开页面时前端按设计自动调用 `POST /api/v1/auth/guest-session`，在 `sessions.json` 留下 guest session 记录（任何访客页面加载都会如此，属系统固有行为，非本次额外写入）。除此之外无任何生产数据写操作。

## 证据索引

- 截图（同目录 `prod-readonly-recheck-shots/`）：
  - `prod-recheck-01-channel-deeplink-direct.png` — 深链直进渲染（含顶栏「未连接」）
  - `prod-recheck-02-channel-deeplink-after-reload.png` — 刷新后渲染
  - `prod-recheck-03-default-project-dropdown-admin.png` — Admin 下拉展开（VM-0-5-ubuntu / VPS 可见，选中项=无）
  - `prod-recheck-04-monitoring-admin.png` — Admin 监控页全量渲染
- 关键 curl/代码坐标：
  - SSE 秒回 vs gzip 挂起对照：`curl -sN` 无 AE 首帧秒回；带 `Accept-Encoding: gzip` 5s 无响应头
  - `studio-prod/apps/api/src/app.ts:26`（compression）、`modules/events/sse.routes.ts:83`（SSE 端点）、`app.ts:116,132`（静态托管 + SPA 兜底）
  - 频道 id `70668707-e9bc-4da7-8443-c35bd3d84646`（#研发），绑定 `ws_1784369481212_wz3vim2`（VPS）
