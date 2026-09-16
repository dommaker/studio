# 数据目录契约（`~/.studio`）

日期：2026-09-16　状态：冻结（方案 §7 人审通过，2026-09-16）　来源：#570（设计定稿），依据 `docs/plans/2026-09-npm-local-form.md` §3.2–3.4 + `docs/research/2026-09-npm-local-form-survey.md` 摸底事实。

本文是 `~/.studio` 数据区的唯一权威契约：位置、内容清单、可改纪律、变更纪律、版本迁移框架、网络面与首启/端口策略。`packages/studio-shared/src/file-store.ts` 头注释与根 `AGENTS.md` 仅挂指针，不再各自维护布局描述。

适用范围：systemd 服务器形态与 npm 本地形态**共用同一份代码与本契约**；本地形态特化只走配置/环境变量，不分叉代码路径。dev 形态先例：`STUDIO_HOME=~/.studio-dev`（`apps/api/package.json:9`、`scripts/dev/start.sh:29`）。

---

## 1. 位置与解析入口

- 数据根：`STUDIO_HOME || ~/.studio`。
- 唯一解析入口：`studioDir()` / `studioPath()`（`packages/studio-shared/src/config/studio-dir.ts`）。
- 纪律（成文，现状即纪律）：新代码禁止 `path.join(os.homedir(), '.studio', ...)` 直拼。已知例外全部登记在 §8 漂移清单；新增例外 = 契约违规。
- 多实例：同一数据根只允许一个实例挂 agent loop（`STUDIO_AGENT_LOOP_ENABLED=false` standby 机制，`apps/api/src/index.ts:254-268`）。

## 2. 内容清单（三类）

### ① `data/` —— FileStore 正本子树

baseDir = `STUDIO_DATA_DIR || studioPath('data')`（`file-store-base.ts:88`）。四段正主（布局自 file-store.ts 原头注释迁入）：

```
data/
  agents/{id}/
    profile.json     # AgentProfile
    state.json       # RuntimeState
  channels/{id}/
    config.json      # Channel
    messages.jsonl   # ChannelMessage（append-only + tombstone；#319 写侧压实清死行）
    messages.lock    # 消息写/压实/归档互斥锁目录（#319/#327）
    archive/messages-YYYY-MM.jsonl  # 超龄消息冷文件（#327，按消息 createdAt 归月）
  workunits/
    lock             # flock 文件锁目录
    events.jsonl     # 事件流 (append-only)
    index.json       # 当前状态快照
  requirements/      # REQ 需求编号体系 (vision §5.3)
    lock             # seq 分配 flock 锁目录
    index.json       # { nextSeq } 序号计数器
    REQ-0042.json    # RequirementData（每需求一个文件）
```

现行扩展段（代码在用，同样属契约内）：`companies/`（companies/routes.ts、mcp/tool-store.ts）、`evolution/`（file-store.ts SeqEntryStore，E1 提案）、`resolutions/`、`trends/`（knowledge-data-layer.ts，按日 md）、`tasks/`（executions 遗留接口仍活）、`spec-reviews/`（mcp/spec.tools.ts）、`users/`（ops.service/notification 写读）、`skills/`（skill-demotion.ts）、`attachments/`（channels/attachments.ts）。

### ② 根级配置、索引与程序数据

- 用户配置：`config.env`、`providers.json`（provider 覆盖，深合并语义，`packages/studio-shared/src/providers.ts:242`；可选，用户创建）。
- 认证与密钥：`users.json`、`sessions.json`（auth session 数组）、`.daemon/`（`jwt-secret`、`encryption-key`、`admin-token` 等，CLI 自举，`apps/api/src/cli/server.ts:39-61`）。
- 索引与状态：`skills-index.json`、`mcp-permissions.json`、`projects.json`（CLI 工程注册清单，与 `projects/` 目录是两回事）、`session-checkpoint.json`、`active-project`（CLI 当前项目指针）。
- 程序数据目录：`agents-registry/`、`auditor/`（daily-snapshots.jsonl append-only）、`data/` 见①、`distill/`（提案与 runs jsonl）、`knowledge/`（FileKnowledgeStore 唯一库 + resolution md）、`okr/`（含 kr-history.jsonl append-only）、`projects/`（PMO 项目逐文件 JSON）、`skills/`（每 skill 一子目录，hash 升级机制）、`snapshots/`（环境快照）、`transcripts/`（按 WU 会话原文）、`triggers/`、`workspaces/`（`{id}.json`，内嵌 runtimes）、`.analyst/`（CLI analyst 工作目录）。
- 事件流：`mcp-audit-logs.jsonl`（append-only）。
- 契约新增（本票冻结，实现票落地）：`harness-knowledge/`（KNOWLEDGE_DIR 归数据根，见 §8）、`tunnel-url`（TUNNEL_URL_FILE 归数据根，见 §8）、`data/manifest.json`（版本标记，见 §5）。

### ③ 可再生产物

`logs/`（统一事件流 `studio-events.jsonl`、`audit.jsonl`、`notifications.jsonl`、`incidents.jsonl`、`tasks-*.jsonl` 及轮转归档）、`worktrees/`（sub-agent git worktree）、`events/`（语义迁移中，见 §8）、各 `*.bak-*` / `*-backup-*` 备份。迁移备份（§5）不覆盖本类。

## 3. 可改纪律

- **用户可改**：`config.env`、`providers.json`（深合并）、`skills/*/SKILL.md`（hash 升级机制容忍手改）。
- **程序独占**：`data/` 全树、各 `*.jsonl` 事件流、`.daemon/` 密钥、`users.json` / `sessions.json`、各索引文件、①②中其余程序数据目录。
- 用户手改程序独占区 = **未定义行为**（读取端容错不保证兜住）。

## 4. 变更纪律

- 布局新增/改名/删条目 = **契约文档先行修订** + 版本标记（§5）配套抬升；契约修订走 review，迁移代码与契约同 commit 落地。
- 新代码向数据根写入契约外条目而未先修订本契约 = 违规。
- 遗产条目只登记不归位（§8）；清理由专门工单执行，不夹带在功能票里。

## 5. 版本标记与迁移框架（冻结：方案 A，人审 2026-09-16）

- **标记位置**：`data/manifest.json`，记数据区 schema 版本（`{ schemaVersion: number, ... }`）。无 manifest = v0（现存全部数据区）。
- **迁移链**：`packages/studio-shared/src/migrations/`（新模块，纯函数迁移链 + runner），`v1→v2→…` 顺序执行；接入点 `apps/api/src/index.ts` 启动链 `reconcileIndex()` 之前。
- **迁移器四性质**（设计契约，实现票照此验收）：
  - 幂等：同一迁移重复执行结果不变；每条迁移执行前先探针判断是否已应用。
  - 可重入：迁移中断（进程被杀）后重跑能续；单条迁移内部原子（写临时文件 + `rename`，不原地改写）。
  - 失败拒启：迁移前对受影响文件做 `*.bak-<YYYYMMDD-HHMMSS>` 备份（沿用数据区既有备份命名先例）；任一迁移失败 → 拒绝启动，打错误 + 备份路径 + 回滚指引，不留半迁移态带病运行。（决策：备份 + 拒启，方案 §7.2）
  - 备份范围：只备 `data/` 与根级 JSON/jsonl；`logs/`、`worktrees/` 等可再生产物不备。
- **骨架先行**：首个迁移 = 空迁移（v0 无标记 → v1 写 manifest），机制跑通；真实迁移随首次布局变更进。
- 实现票：#572。

## 6. 网络面（回环纪律）

`resolveListenHost()`（`apps/api/src/utils/listen-host.ts`）现状即正确设计，**不做代码改动**，纪律成文：

- 默认绑 `127.0.0.1`；`STUDIO_AUTH=none` 下绑非回环直接拒启（硬守卫）。
- 本地形态永远回环；对外暴露 = 显式 `HOST=0.0.0.0` + 开认证，守卫保持拒启语义。

## 7. 首启检测与端口（冻结，人审 2026-09-16）

- **首启检测块**：`studio run web` 首启打印——Node 版本（对 engines `>=20`）、agent CLI 探测结果（复用 `cli-scanner.scanAllProviders()` 现成输出：provider/path/version，覆盖注册表全部 provider）、数据根位置、实际监听地址。缺失 CLI 不阻断（对齐 checkPrerequisites 现有警告语义），但标注「至少需要一个 agent CLI 才能跑执行」。
- **端口动态顺延**：默认 3001，占用则顺次探测 3002…（上限 +100，即 3101）；顺延结果在面板/日志标明实际端口。
- **显式指定语义**：`--port` / `PORT` 显式指定时占用即拒启报错——显式意图不被顺延覆盖。
- **双口径收口**（摸底冲突 4）：`apps/api/src/index.ts:471-478` 的 EADDRINUSE 3s 无限重试**删除**；`ops.service.ts:114-127` preflight lsof 占用即 abort 的语义**收编为动态顺延的一条分支**；顺延耗尽（> +100）报错拒启。全系统只此一套口径。
- 实现票：#573（首启面板 + 顺延）；`studio run web` 总入口：#571。

## 8. 根级条目逐条归类与已知漂移

实测口径：2026-09-16 `ls -A` 共 **45 条**（42 可见 + `.analyst`、`.daemon`、`.harness` 三个隐藏目录）。摸底报告「41 条」为当时快照（隐藏目录未计入、`sessions.json` 的 `.bak` 实为 1 个），本表以复测为准。**只归类，不归位。**

### 契约内（现行，25 条）

| 条目 | 代码出处（写/读） |
|------|------|
| `active-project` | cli/admin.ts:35 写，cli/shared.ts:17 读 |
| `agents-registry/` | studio-agent/agent-registry.ts:40（逐文件 JSON） |
| `auditor/` | agents/auditor/auditor-reports.ts:140（append-only 快照流） |
| `config.env` | studio-shared/config/index.ts:21 读；cli/config.ts:9 写 |
| `data/` | file-store-base.ts:88（FileStore 主数据根，§2①） |
| `distill/` | distill/distill-runtime.ts:23（append-only jsonl） |
| `knowledge/` | knowledge/knowledge-singletons.ts:35（FileKnowledgeStore 唯一库） |
| `logs/` | studio-shared/log-path.ts:44（统一事件流 + 轮转，§2③） |
| `mcp-audit-logs.jsonl` | mcp/permission.service.ts:15（append-only） |
| `mcp-permissions.json` | mcp/permission.service.ts:12 |
| `okr/` | pmo/okr.service.ts:9（含 kr-history.jsonl append-only） |
| `projects/` | pmo/project.service.ts:17 |
| `projects.json` | cli/admin.ts:13,23（CLI 工程注册清单） |
| `session-checkpoint.json` | agents/session-summary.service.ts:19 |
| `sessions.json` | auth/service.ts:85、middleware/auth.ts:20 |
| `skills/` | studio-skill/loader.ts:25、seed.ts:54（每 skill 一子目录） |
| `skills-index.json` | skills/skill-store.ts:98 |
| `snapshots/` | knowledge/env-snapper.ts:31 |
| `transcripts/` | transcripts/transcript-archive.ts:17 |
| `triggers/` | triggers/trigger-store.ts:73 |
| `users.json` | auth/service.ts:84、middleware/auth.ts:19 |
| `workspaces/` | workspaces/workspace-store.ts:13（`{id}.json`，根级非 data/ 级） |
| `worktrees/` | index.ts:37 注入 `WORKTREES_DIR`（漂移见下） |
| `.analyst/` | cli/server.ts:28（CLI analyst 工作目录） |
| `.daemon/` | cli/server.ts:29,39-61（jwt-secret/encryption-key/admin-token 自举） |

### 待归位（语义漂移/双口径，归位动作在实现票或专门工单）

| 条目 | 漂移事实 | 冻结结论 |
|------|---------|---------|
| `events/` | 统一事件流正本已迁 `logs/studio-events.jsonl`（D18 收敛）；此处仅剩 ensureDir（index.ts:38、cli/server.ts:31-36）、evolution/signals.ts:44 默认读径与一次性死文件清理（studio-log-rotation.ts:242） | 收编：默认读径改指 `logs/`，ensureDir 移除；实现票执行后降级为遗产。**已执行（#571，2026-09-16）**：signals 缺省指 `studioPath('logs')`、index.ts/cli server.ts 的 EVENTS_DIR 注入与 ensureDir 移除 |
| `worktrees/` | API 进程内经 env 注入写 `<studioDir>/worktrees`；但 7 处模块 fallback 直拼 `~/worktrees`（agent-loop-parsers.ts:35、merge-on-review-pass.ts:53、monitor-system-probes.ts:30、system-health.ts:257、discord/routes.ts:141、studio-shared/config/index.ts:80、agent-runner.ts:58），双口径 | 目录本身契约内；fallback 全部改走 `studioPath('worktrees')`，实现票统一。**#571 声明留待后续工单**（超出本票边界，未动） |
| `KNOWLEDGE_DIR`（index.ts:5，未落盘为条目时） | 缺省硬编码 `__dirname/../.harness/knowledge`（monorepo 相对路径） | 缺省改 `studioPath('harness-knowledge')`（新根级条目，§2②已登记），env 可覆盖；实现票执行。**已执行（#571）**：缺省收敛到 `apps/api/src/utils/runtime-paths.ts` defaultKnowledgeDir() |
| `TUNNEL_URL_FILE`（index.ts:488，当前落在 `~/.claude/`） | studioDir() 之外的路径例外，写第三方 CLI 目录 | 改 `studioPath('tunnel-url')`（§2②已登记）；实现票核实是否有外部读取方。**已执行（#571）**：迁 `studioPath('tunnel-url')`（runtime-paths.ts tunnelUrlFile()，env 可覆盖）；核实全仓无代码读取方（scripts/tunnel-url.sh 读 /tmp/cloudflared.log），纯人工查看文件 |
| `~/.studio/.harness`（空目录） | 零代码引用（仓内 `.harness` 引用均为 repo/worktree 级） | 疑似手工产物；首启若不需则归遗产，实现票核实 bootstrapHarness 行为后定性 |

### 遗产（零引用或代码内已声明死亡，18 条，只登记不清理）

| 条目 | 判据 |
|------|------|
| `backup-acceptedTypes-70-20260816-012135`、`backup-knowledge-pollution-20260729-145707`、`backups/` | 零引用，手工迁移备份 |
| `mcp-audit-logs.jsonl.test-polluted.bak` | 零引用，测试污染清理残留 |
| `notify-config.json` | outbound-notify/routes.ts:8 注释明言「不再读写」 |
| `proposals.json` | skills/review-adapter.ts:13 注释：旧自持存储，#354 已迁 review-proposal jsonl |
| `raft/`、`research-scratch/`、`tools/` | 零代码引用 |
| `sessions/`（根级） | 仅读/GC（monitor-lifecycle.ts:86、system-health.ts:281），**无写入方**，旧 session 日志 |
| `sessions.json` 的 `.bak-visual-audit`、`users.json` 两个 `.bak-*`、`skills-backup-20260612183804` | 零引用，手工/e2e 备份 |
| `sessions.jsonl` | 零写入；auth/service.ts:5 头注释提及与实现不符（注释漂移，随实现票修正） |
| `spec-reviews/`（根级） | 零引用；现行在 `data/spec-reviews/` |
| `workspace-runtimes/`、`workspace-tokens/`（根级） | 零引用；runtimes 已并入 `workspaces/{id}.json`，tokens 随 #481 退役 |

### 其他已知漂移（登记，不修）

- `log-path.ts:46-48` 生产分支直拼 `STUDIO_HOME/logs`（有意不走 studioDir() 防测试 env 泄漏，注释已注明）——语义等价的重复实现，登记为已知例外。
- scripts/bench 直拼数据根路径（`scripts/normalize-archive-maturity.ts:132`、`cleanup-stuck-in-review-no-channel.ts:194`、`setup-config.sh:8`、`apps/api/bench/*`）——脚本/bench-only，登记；新脚本禁止新增。
- `data/` 内遗产：`sessions/`、`workspaces/`、`workspace-runtimes/`、`workspace-tokens/`、`req-pmo-map.json`、三个 knowledge-synthesis/audit md、`documents.retired-20260815.tar.gz`——零引用或已退役 trigger 产出，只登记。

## 9. 摸底冲突处置结论（10 条逐条）

| # | 冲突 | 处置结论 |
|---|------|---------|
| 1 | `studio run` 动词冲突（现状 = 提交需求到 #研发） | 按方案 §7.5：`studio run web` = 一体起服务总入口；旧 `studio run`（legacy，`@Analyst` 角色已不存在）删除让位，chore 票 #569 已开，本票不重复开 |
| 2 | 非 private 包是 4 个不是 2 个 | #571 scope 校准：`studio-audit`、`studio-notification` 一并处理（补 `private: true` 或明确不发布） |
| 3 | tsx 在根 `dependencies`（生产依赖语义） | #571 scope 校准：tsx 退场范围含根包 dependencies 整改 |
| 4 | 端口双口径（preflight abort vs EADDRINUSE 无限重试） | §7 冻结：删无限重试，preflight abort 收编为顺延分支，全系统单口径；#573 执行 |
| 5 | cloudflared 默认自启 + tunnel-url 写 `~/.claude` | **默认关**：仅显式 `CLOUDFLARED_ENABLED=true` 拉起（现有服务器形态部署需在 config.env 显式开启，#571 发布说明标注）；tunnel-url 归数据根 `studioPath('tunnel-url')`（§8 待归位） |
| 6 | KNOWLEDGE_DIR 硬编码 monorepo 相对路径 | 缺省归数据根 `studioPath('harness-knowledge')`，env 可覆盖（§8 待归位）；#571 执行并核实 bootstrapHarness 无 `.harness` 时行为 |
| 7 | Linux-only 探测面的平台支持范围 | **首版支持 Linux + macOS**：核心路径（服务启动、FileStore、agent CLI 探测、端口顺延）跨平台；Linux-only 探测面（`/proc` 直读、`ss`、`systemctl`、`lsof`）属服务器运维面，macOS 下降级为跳过 + 提示，不阻断核心启动；Windows 不在支持范围（worktree/shell 语义未验证） |
| 8 | preflight 前端 auto-build 在 npm 形态必然失败 | npm 形态：包内 `frontend/dist` 缺失 = 包损坏，报错退出并提示重装；monorepo dev 形态（`apps/web` 源码存在）保留 auto-build 分支；#571 执行 |
| 9 | file-store.ts 头注释「数据留 DB」过时表述 | 本票执行：头注释布局段整段重写为指向本契约的指针，「留 DB」表述删除（DB 已随 Spec 4 Phase 4 移除） |
| 10 | 根级条目数量与归类工作量 | §8 复测 45 条逐条归类（票面 41 为快照）；只归类不归位 |

## 10. 未查实项（移交实现票）

- `pnpm pack` 对 `workspace:*` 协议的重写行为与发布包体积（摸底未查实，#571 实测收口）。**已查实（#571）**：单包走 esbuild bundle 内嵌全部 workspace 代码，根 dependencies 零 `workspace:*`，重写问题不适用；发布包（tgz）≈ 0.9 MB。
- `bootstrapHarness()` 缺 `.harness/config.yml` 时的行为（代码 try/catch 倾向容错，未实跑；#571 随 KNOWLEDGE_DIR 归位一并核实）。**已查实（#571）**：从无 `.harness` 的 cwd 起服务实测——bootstrap 正常完成（hooks: 7 注册成功），容错成立，无副作用。

---

脱敏自查：全篇无凭证、主机名、内网域名、内部部署路径；`127.0.0.1` 为回环保留地址，用户 HOME 路径以 `~` 表示。
