# 冷启动重构复盘根因修复（2026-10-03）

> 状态：已完成（四条根因修复全部提交至 d802402c，见 performance-baseline.md §7.2；状态回写 2026-10-07）。来源：ff546ba9（listen 前移 + CLI 扫描异步化）复盘，用户指示「彻底修复根因」。

## 背景

ff546ba9 治好了启动链两处 sync 全扫并把 listen 前移，复盘发现四条同源/伴生根因：

1. **角色创建请求路径仍走 sync 全扫**：`agent-profile.service.ts:244` → `resolveDefaultProvider()`
   缺省 sync `scanAllProviders()`，真机全扫冷缓存实测 43–55s（#577），运行期用户可触发，
   创建角色时全站事件循环冻结。启动期病灶的同胞，属「sync 扫描链未肃清」残余。
2. **readiness 无对外出口**：两口径分离只在代码/日志层，deploy 健康检查
   （studio-config `studio-deploy-quick` / `auto-deploy.sh` curl `/health` 200）判的是
   liveness；listen 前移后「部署判绿 → 全量就绪」之间有秒级盲窗，隧道入口同步前移放大。
3. **listen 后 exit(1) 路径**：`registerScanHandlers`（bootstrap/handlers.ts）无 try/catch，
   throw → bootstrap catch → `process.exit(1)` 发生在端口可服务之后——deploy 判绿后进程
   死亡、回滚不触发（旧顺序下 exit 在 listen 前，健康检查必失败必回滚）。listen 前移引入
   的语义回归。
4. **warmup 组同步段未审计**：`sessionSummaryService`（execFileSync，#663）、
   `ruleScanner.fullScan` / `verifyConsumptionChain` / `knowledgeCurator.coldStartAll`
   等 fire-and-forget 任务，「不 await」≠「不阻塞」，sync fs/子进程段仍在 listen 后窗口
   冻结事件循环。

## 方案

### A：肃清 sync 扫描链（请求路径）

- `default-provider.ts`：`resolveDefaultProviderAsync`（缺省 `scanAllProvidersAsync`）；
- `agent-profile.service.ts` 角色创建换 async 变体；
- sync `resolveDefaultProvider`/`scanAllProviders` 仅余 CLI 一次性路径（checkPrerequisites、
  run-web）——daemon 进程内零请求路径残留。

### B：readiness 出口

- `apps/api/src/bootstrap/readiness.ts`：进程级 ready 状态（markReady/isReady，可注入 reset 供测试）；
- `app.ts` 挂 `/readyz`（与 `/health` 同级免认证，Lurk Wall 只罩 `/api/v1` 不受影响）：
  未就绪 503 `{ status: 'starting' }`，就绪 200 `{ status: 'ready', timestamp }`；
- `bootstrap/index.ts` 全量初始化链尾（registerScanHandlers 后）`markReady()`；
- studio-config 切换健康检查：`studio-deploy-quick`、`scripts/auto-deploy.sh`、
  `scripts/tools/health-check.sh` 的 curl 目标 `/health` → `/readyz`（/health 保留作
  liveness，agent-ops 判活等消费方不动）。

### C：封死 listen 后 exit(1)

- `handlers.ts` 整体包 try/catch warn（与 startCoreServices/startAgentLoops/initChannels
  同纪律）——bootstrap listen 后各步全部「失败只 log 不拒启」，catch→exit(1) 实际只可能
  在 listen 前（迁移/路由注册）触发，语义回归消除。

### D：warmup 组同步段治理

- `session-summary.service.ts`：`execFileSync` → `core/exec-async.execFileAsync`（关 #663；
  worker_threads 未采用——瓶颈是子进程 wait 而非 CPU，回调式已出事件循环）；
- 审计中发现的同族残留一并修复（根因都是「daemon 内 sync 子进程阻塞事件循环」）：
  - `agent-loop.ts` start() health probe `execSync` → `execAsync`（bootstrap listen 后
    mount 链 + profile.created 事件路径，per-profile 最坏 5s×N 串行）；
  - `knowledge-sync.service.ts detectStaleness` git log 循环 `execFileSync` →
    `execFileAsync`（monitor 周期轮 + `/api/knowledge/sync-status` 路由，#374 纪律漏网）。

#### warmup 组审计结论（2026-10-03，实盘数据区 230 知识条目/25MB）

| 任务 | 结论 |
|------|------|
| SessionSummary git 提取 | **秒级 sync → 已修（本批）** |
| ruleScanner.fullScan | sync 段 = ~63 小 md + 4 配置源 readFileSync + store.list N+1（230 小条目，mtime memo 指纹校验）≈ 数十 ms——非病灶不动 |
| verifyConsumptionChain | async 轮询 + 单条 recordReference——不动 |
| knowledgeCurator.coldStartAll | readdirSync 数个 memory 目录，ms 级——不动 |
| envSnapper | 数个配置文件 readFileSync，ms 级——不动 |
| rotateStudioEvents / rotateStudioLogFiles | 全 async fs——不动 |
| archiveChannelMessages | 全 async fs（fs.promises）——不动 |
| pkill 孤儿 ingest 清理（knowledge-singletons 模块加载期） | 一次性瞬时——不动 |

#### 审计过但 consciously 不动的同族项（非 warmup，改动机不抵风险/频率）

- `devops.tools.ts` publishPackage 链（execFileSync git/npm/gh）：人工触发的 release 路径，
  刻意同步（顺序依赖 + 错误即停），见 mcp/CONTEXT.md 收口记录；
- `frontend-dist.ts ensureFrontendDist`（vite build 120s sync）：仅 monorepo dev 形态
  dist 缺失时的自愈分支；npm 形态不现场构建（critical abort）；
- `knowledge-design-doc.ts` git log 7 天：单次小命令（~100ms），低频 distill 路径；
- `hasDocker`：daemon 运行时无调用方（local-workspace 硬编码 false），仅 CLI 用；
- `cli/*` 全部 execSync：CLI 一次性进程，无事件循环共享问题。

## 不做（consciously deferred）

- `GET /workspaces/runtimes` 缓存 miss 的秒级等待（解耦为「返回上次结果 + 后台重扫」是
  产品设计取舍，非根因）；
- 启动链两次全扫去重（缓存共享已使第二遍大减，收益不抵改动）。

## 测试

- A：default-provider async 变体用例（注入 async scan）；agent-profile.service 既有测试
  mock 出口同步换 async；
- B：readiness 端点 503→200 翻转用例；bootstrap 装配断言 markReady 在链尾；
- C：handlers 注册失败不 throw 用例；
- D：session-summary mock execFile 异步链用例（首跑/增量/checkpoint 回退语义不变）；
  warmup 审计改动各带防回归。

## AC

- [ ] daemon 进程内请求路径零 `scanAllProviders()` sync 调用（grep 验证）
- [ ] `/readyz` 未就绪 503 / 就绪 200；deploy 健康检查以 readiness 为准
- [ ] bootstrap listen 后任一步失败只 warn 不 exit
- [ ] SessionSummary 首跑不再阻塞事件循环（#663 AC 全绿，行为计数语义不变）
- [ ] warmup 组无秒级 sync 段（审计结论落本计划）
