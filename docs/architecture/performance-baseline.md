# 性能基线（架构重构 Phase 0 锚点）

日期：2026-09-30　状态：基线已冻结　基线 commit：`cb42edf3`

本文记录架构重构前的 API 性能基线，作为重构前后对比的锚点。测量对象：`apps/api`（Express 4 + tsx 4.23.1 运行时转译，数据全走 FileStore）。

---

## 1. 环境

- Node.js v22.22.0，Linux x86_64。
- 机器：4 vCPU / 3.7 GB RAM（+8 GB swap，测量时 swap 已用约 4 GB）的资源受限开发机，机上同时驻留一个生产实例（127.0.0.1:3001）。**本机内存压力是冷启动数据的重要背景，换机重测需重记环境行。**
- 运行形态：与生产一致——生产 systemd 服务同样以 tsx 运行时转译启动（非构建产物），故本基线对生产形态有代表性。

## 2. 方法

- 隔离数据区：`STUDIO_HOME=$(mktemp -d)`，全程未触碰默认数据根；测量后临时目录已删除。
- 监听：`PORT=3917`（39xx 段，启动前经 `ss` 确认空闲，非 3001/13001），默认绑 127.0.0.1；`STUDIO_AUTH=none`（免登录注入 Admin，仅回环，符合 `listen-host.ts` 守卫）。
- 启动命令：`STUDIO_HOME=<tmp> PORT=3917 STUDIO_AUTH=none npx tsx apps/api/src/index.ts`（仓库根执行）。
- 冷启动：从进程启动到 `GET /health` 首次返回 200 的耗时（50ms 轮询）。run1 为全新数据区（含首启 seed/迁移），run2/run3 为同一数据区上的重启。
- 端点延迟：每端点 3 发 warmup + 50 发串行（本机回环 fetch），记录状态码分布与 p50/p95/max。数据区为空（除系统 seed 的内置 skills/默认频道外无业务数据）。
- 未测项：SSE 端到端延迟（需造事件，成本不匹配，留待 Phase 4）；写端点（本基线只覆盖只读路径）。

## 3. 冷启动

| 轮次 | 数据区 | 耗时 |
|------|--------|------|
| run1 | 全新（含首启 seed） | 24.1 s |
| run2 | 重启 | 39.2 s |
| run3 | 重启 | 47.6 s |

观察：三次测量逐轮变慢，方差大，与本机内存/swap 压力一致。启动日志显示时间主要消耗在路由注册前的串行初始化链（数据迁移 → WorkUnit 对账 → skill seed → harness bootstrap → 各后台服务动态 import），叠加 tsx 运行时转译整个模块图的开销。`/health` 要到 `server.listen` 才可用，而 listen 排在几乎全部初始化之后——冷启动耗时 ≈ 全量初始化耗时，不只框架启动。

## 4. 端点延迟（只读，空数据区，50 发串行）

| 端点 | 路径 | 状态码 | p50 | p95 | max |
|------|------|--------|-----|-----|-----|
| health | `GET /api/v1/health` | 200×50 | 9.0 ms | 15.3 ms | 16.2 ms |
| agents 列表 | `GET /api/v1/agents` | 200×50 | 1.7 ms | 4.0 ms | 5.5 ms |
| channels 列表 | `GET /api/v1/channels` | 200×50 | 2.0 ms | 5.1 ms | 9.0 ms |
| workunits 列表 | `GET /api/v1/workunits` | 200×50 | 1.8 ms | 4.2 ms | 10.0 ms |
| pmo 项目列表 | `GET /api/v1/pmo/project` | 200×50 | 1.9 ms | 4.4 ms | 8.3 ms |
| skills 列表 | `GET /api/v1/skills` | 200×50 | 2.0 ms | 5.3 ms | 11.7 ms |
| monitoring 汇总 | `GET /api/v1/monitoring/stats` | 200×50 | 2.7 ms | 9.7 ms | 16.8 ms |
| notifications | `GET /api/v1/notifications` | 200×50 | 1.9 ms | 4.1 ms | 6.9 ms |

空数据区下全部端点返回 200（列表类返回空集/seed 数据），无 404/5xx。

## 5. 结论与目标值校验

对计划中的建议目标逐条校验：

- **读 p95 < 100ms：达标，目标合理。** 实测最差端点（health）p95 = 15.3ms，列表类 p95 ≤ 9.7ms，余量 6 倍以上。注意本基线是空数据区，数据量增长后 FileStore 全量扫描类端点会退化，100ms 作为重构后验收线仍有约束力。
- **写 p95 < 300ms：本基线未测写路径，无法直接校验。** 但读路径余量大、FileStore 写为本地文件追加/重写，300ms 量级不离谱，保留为目标，Phase 4 补测写路径再复核。
- **冷启动 < 3s：远不达标，目标离谱。** 实测 24–48s（tsx 运行时转译 + 串行初始化链 + 内存受限机器）。当前形态（生产也用 tsx 直跑）下 3s 不现实。建议二选一：(a) 目标改为"构建产物（node dist）冷启动 < 3s"，把转译移出运行时，并在构建形态下重测；(b) 维持 tsx 形态则定为"冷启动不劣于基线（< 60s 上限）"。重构（Phase 2 bootstrap 拆分/延迟初始化）若把非关键初始化挪到 listen 之后，`/health` 可用时间可大幅先于全量初始化完成，届时应区分"端口可服务时间"与"全量就绪时间"两个口径。

对比纪律：重构后（Phase 4）复测须用同一方法（隔离 STUDIO_HOME、同端点清单、同发数），并在文档中记录新 commit 与环境差异。
