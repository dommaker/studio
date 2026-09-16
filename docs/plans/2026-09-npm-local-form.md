# npm 本地形态摸底 + 数据区迁移框架设计

日期：2026-09-16　状态：设计提案（待评审，未实施）　类型：调研 + 设计两阶段票

## 1. 背景与现状

studio 规划两种交付形态：(a) 部署在用户自己的服务器（现有形态，systemd 托管）；(b) 用户 `npm install` 后本地起服务（本地优先 daemon 形态：服务跑在用户机器前台，数据落在用户 HOME 下）。`.github/workflows/release.yml` 已有 tag 触发 `pnpm publish --no-git-checks` 的骨架，但核实下来骨架是空转：根 `package.json` `private: true`，`apps/api` 与 `packages/studio-agent|studio-capability|studio-spec` 均 `private: true`；非 private 的 `studio-shared`/`studio-skill` 的 `main` 指向 `src/index.ts` TS 源码，`apps/api` 的 `bin` 也指向 `src/cli/studio-cli.ts`——当前没有任何一个包处于"可被外部 `npm install` 消费"的状态。

存储面是纯文件 FileStore，数据根 `STUDIO_HOME || ~/.studio`（`packages/studio-shared/src/config/studio-dir.ts`，`studioDir()`/`studioPath()` 单入口已就位）。数据区布局的"正本"目前散在 `packages/studio-shared/src/file-store.ts` 头注释里，且只覆盖 `data/` 子树；实测生产数据根还有 20+ 个根级条目（`config.env`、`users.json`、`sessions.json(l)`、`skills/`、`skills-index.json`、`skill-proposals.jsonl`、`knowledge/`、`transcripts/`、`triggers/`、`events/`、`logs/`、`worktrees/`、`.daemon/`（jwt-secret/encryption-key）等），头注释与实况已漂移。数据区**没有任何版本标记**，升级兼容性目前靠读取端容错（如 `parseWorkUnitIndexContent`）个案处理。

监听面已有安全收口：`apps/api/src/utils/listen-host.ts` 的 `resolveListenHost()` 默认绑 `127.0.0.1`，`STUDIO_AUTH=none` 下绑非回环直接拒启（硬守卫，头注释已写明两种形态动机）。端口默认 `PORT||3001`；`ops.service.ts` preflight 用 `lsof -ti:<port>` 检查，占用即 abort 提示 `studio stop`——无动态分配。外部 agent CLI（claude/kimi/codex/opencode）由 `daemon/cli-scanner.ts` 运行时 `which`+version 探测；`cli/server.ts checkPrerequisites()` 检查 git/claude 但只打警告不阻断。

## 2. 目标与非目标

目标：
1. 产出 npm 形态摸底事实报告，把"装完在用户机器上跑起来"需要回答的问题全部回答掉。
2. `~/.studio` 数据目录契约独立成文 + 变更纪律落字。
3. 数据区版本标记 + 启动时迁移框架的方案定稿（本方案给推荐，评审拍板）。
4. 首启体验与端口策略定稿。

非目标：本票不写实现代码（阶段三/四的实现另开 implement 票）；不改 release.yml 真实发布流程；不动现有 systemd 形态。

## 3. 方案

分两阶段，顺序执行。**阶段一为调研**（产出事实报告，不改代码），**阶段二为设计定稿**（本方案 §3.2–3.4 即设计草案，评审 + 摸底事实修订后冻结，实现另开票）。

### 3.1 阶段一：摸底（analysis 票，产出事实报告）

产出：`docs/research/2026-09-npm-local-form-survey.md`，逐问题给事实 + 结论。触及：无生产代码；只新增一份 research 文档。

摸底清单（每问题附候选答案与当前推荐，事实报告负责证实/证伪）：

| # | 问题 | 候选 | 当前推荐 |
|---|------|------|---------|
| Q1 | 发布单元：哪些包上 npm？ | (a) 单包 `@dommaker/studio` 内嵌全部；(b) 多包 publish（api+shared+agent+…） | (a)。消费者只要一个能跑的命令，多包把 workspace 协议解析、`workspace:*` 版本同步等复杂度甩给发布流水线，违反最简 |
| Q2 | bin entry 形态 | (a) 编译 `dist/` + `#!/usr/bin/env node` 薄入口；(b) 继续 `npx tsx` 跑 TS 源 | (a)。tsx 是 dev 依赖语义，不该出现在用户机器的关键路径；`bin/studio`（bash 脚本）与 `apps/api` bin 指 `.ts` 源都需重做 |
| Q3 | `apps/web` 静态资源怎么随包分发 | (a) web dist 预构建打进发布包 `files`（api 包内 `frontend/dist`）；(b) 独立 `@dommaker/studio-web-static` 包；(c) postinstall 现场 vite build | (a)。`app.ts:133` 已 `express.static(<api>/frontend/dist)`，路径约定不动，只是把"部署时构建拷贝"（ops.service auto-build）前移为"发布时打包"；(c) 要求用户机器有完整构建链，排除 |
| Q4 | 启动命令形态 | (a) `npx studio run web` 前台进程（web 动词即总入口：API + 托管 web dist 一体起服务）；(b) `studio up` 沿用；(c) 后台 daemon 自管理 | (a)。单命令体验，本地优先形态用户对前台进程 + Ctrl-C 的预期最强；不单设 `start` 动词。`studio up` 里 REPO_DIR 从 CWD 向上找 package.json 的 monorepo 假设、preflight 现场 build 前端等服务器形态残留需逐条标注去留 |
| Q5 | 外部 agent CLI 依赖怎么声明 | (a) 不声明，运行时探测 + 首启呈现（现状 cli-scanner）；(b) 文档要求 + `studio doctor` 校验命令 | (a)+(b) 文档。npm 无法对任意第三方 CLI 声明 peerDependency；cli-scanner 已是探测正本，首启直接复用其输出 |
| Q6 | 数据根与多实例 | STUDIO_HOME 已就位 | 确认即可：`studioDir()` 单入口，开发形态 `~/.studio-dev` 先例（apps/api dev script） |
| Q7 | Node engines 与发布流水线 Node 版本 | 根 engines `>=18`，release.yml 用 Node 22 | 对齐到 `>=20` 或 `>=22`（摸底确认依赖链实际下限） |
| Q8 | 原生/平台相关依赖 | bcryptjs 纯 JS、无 node-gyp（待核） | 摸底全依赖树确认零原生模块，否则单包策略要重估 |
| Q9 | 版本号与 tag 策略 | (a) 单包单版本跟随 tag；(b) changesets | (a)。单包无多包版本同步问题 |
| Q10 | 发布包内容白名单 | `files` 字段白名单 vs `.npmignore` 黑名单 | `files` 白名单（公开仓脱敏纪律的物理兜底：tests/scripts/monorepo 治理文件不进包） |

### 3.2 阶段二-1：数据目录契约成文

产出：`docs/architecture/data-directory-contract.md`（新文档）+ `file-store.ts` 头注释收敛为指针 + 根 `AGENTS.md` `PRESERVE:*` 段挂一行指针（治理变更，走人闸，带 `Governance-Approved` trailer）。数据目录契约需要单点权威落点：本仓 AGENTS.md 机器生成，等价落点是 PRESERVE 段指针 + 独立契约文档正本。

契约内容骨架：
- **位置**：`STUDIO_HOME || ~/.studio`；唯一解析入口 `studioDir()`/`studioPath()`，新代码禁止 `path.join(os.homedir(), '.studio', ...)` 直拼（现状已是纪律，成文）。
- **内容清单**：按实测布局分三类成文——① `data/` FileStore 正本子树（file-store.ts 头注释既有内容迁入）；② 根级配置与索引（`config.env`、`providers.json`、`users.json`、`skills/`、`skills-index.json`、`mcp-permissions.json`、`.daemon/` 密钥等）；③ 可再生产物（`logs/`、`worktrees/`、`events/`、各 `*.bak-*`）。
- **可改纪律**：用户可改 = `config.env`、`providers.json`（深合并语义）、`skills/*/SKILL.md`（hash 升级机制容忍）；程序独占 = `data/` 子树、各 `*.jsonl` 事件流、`.daemon/` 密钥；用户手改程序独占区 = 未定义行为。
- **变更纪律**：布局新增/改名/删条目 = 契约文档先行修订 + 版本标记（§3.3）配套；契约修订走 PR review，迁移代码与契约同 commit 落地。

### 3.3 阶段二-2：数据区版本标记 + 迁移框架（核心设计）

问题：`npm update` 后新版本代码读旧版 `~/.studio` 的 jsonl/json，结构漂移怎么升级。三方案：

| 方案 | 做法 | 取舍 |
|------|------|------|
| A. manifest 版本号文件 + 启动时迁移器 | `~/.studio/data/manifest.json`（或 `VERSION` 文件）记数据区 schema 版本；代码内迁移链 `v1→v2→v3` 顺序执行 | 升级路径单点可见、可测试；迁移逻辑集中。缺点：要求每次布局变更记得抬版本（用契约纪律 + 测试兜底） |
| B. 每文件 schema 版本 | 每条 jsonl 记录/每个 json 文件头带 `v` 字段，读取端按版本升级 | 无启动阻塞，渐进式。缺点：升级逻辑散在所有读取端，与"读取端容错个案处理"现状同构——正是要摆脱的状态；append-only 文件改写成本高 |
| C. 无版本，容错读取 | 现状延续：parse 时默认值兜底 | 零机制成本。缺点：silent drift 无台账，哪天兜不住就是数据损坏；历史已有教训型先例（启动对账 reconcileIndex 就是为兜分叉补的） |

**推荐 A**（启动时 migrator + 版本号标记）。迁移器性质（设计契约，实现票照此验收）：

- **幂等**：同一迁移重复执行结果不变；每条迁移执行前先探针判断是否已应用。
- **可重入**：迁移中断（进程被杀）后重跑能续；单条迁移内部原子（写临时文件 + `rename`，不原地改写）。
- **失败行为**：迁移前对受影响文件做 `*.bak-<YYYYMMDD-HHMMSS>` 备份（沿用数据区既有备份命名先例）；任一迁移失败 → **拒绝启动**，打错误 + 备份路径 + 回滚指引，不留半迁移态带病运行。
- **备份范围**：只备 `data/` 与根级 JSON/jsonl；`logs/`、`worktrees/` 等可再生产物不备。
- **骨架先行**：首个迁移是空迁移（v0 无标记 → v1 写 manifest），先把机制跑通，真实迁移随首次布局变更进。

实现落点（实现票 scope，本方案只定点）：`packages/studio-shared/src/migrations/`（新模块，纯函数迁移链 + runner）；接入点在 `apps/api/src/index.ts` 启动链 `reconcileIndex()` 之前；全部新代码带测试（Iron Law）。

### 3.4 阶段二-3：首启体验与端口

- **首启面板**：`studio run web` 首启打印环境检测块——Node 版本、agent CLI 探测结果（复用 `cli-scanner.scanAllProviders()` 现成输出：provider/path/version）、数据根位置、监听地址。缺失 CLI 不阻断（对齐 checkPrerequisites 现有语义），但标注"至少需要一个 agent CLI 才能跑执行"。
- **端口**：动态分配 + 显式指定——默认 3001，占用则顺次探测 3002…（上限 +100）；`--port` / `PORT` 显式指定时占用即拒启报错（显式意图不覆盖）。现状 ops.service preflight 的 lsof 检查 abort 语义改为动态分配的一条分支。
- **绑定纪律成文**：`resolveListenHost()` 现状即正确设计（默认回环、`STUDIO_AUTH=none` 禁非回环），不做代码改动，把纪律写进契约文档 §网络面：本地形态永远回环；对外暴露 = 显式 `HOST=0.0.0.0` + 开认证，守卫保持拒启语义。

## 4. 验收标准（AC）

- AC1：`docs/research/2026-09-npm-local-form-survey.md` 存在，摸底清单 Q1–Q10 每问有事实（带文件/字段出处）+ 结论，候选推荐被证实或修订。
- AC2：`docs/architecture/data-directory-contract.md` 覆盖位置/内容三类清单/可改纪律/变更纪律；`file-store.ts` 头注释布局段收敛为指向契约的指针。
- AC3：迁移框架设计在契约文档或 ADR 冻结：版本标记位置、迁移器四性质（幂等/可重入/失败拒启/备份范围）、接入点。
- AC4：首启体验与端口策略定稿文字化（检测块内容、动态分配规则、显式指定语义、回环纪律），resolveListenHost 纪律有文档落点。
- AC5：全篇公开仓脱敏自查通过（无主机名/IP/内部路径）。
- AC6：本票不含任何生产代码改动；实现票从冻结后的 AC2–AC4 拆出。

## 5. 风险与边界

- 摸底可能推翻推荐（如依赖树藏原生模块 → Q1/Q8 重估）；推荐只是先验，事实报告说了算。
- 契约成文会暴露根级散文件与头注释的漂移（已确认存在）：漂移条目的归类（契约内/待归位/遗产）在 AC2 交付物里给清单，**不在本票做归位**。
- AGENTS.md 挂指针 = 治理变更，需人闸批准；若人不在场，契约文档先行，指针留待批准。
- npm 形态与 systemd 形态共用同一份代码与契约，任何"本地形态特化"都走配置/环境变量，不分叉代码路径。

## 6. 不做清单

- 不实现迁移框架代码、不改 release.yml、不真发 npm 包。
- 不重建后台 daemon 自管理（start/stop/restart 本地服务管理）——前台进程起步。
- 不做自动更新/更新提醒机制。
- 不动 `resolveListenHost`、cli-scanner、providers 深合并任何现有代码。
- 不清理数据区遗产条目（`*.bak-*`、`.retired/` 等），只归类。

## 7. 开放问题决策记录（2026-09-16 人审全部通过）

1. **发布单元**：单包 `@dommaker/studio`（推荐）vs 多包 publish——影响 Q1/Q9 全部下游。→ 已定：单包 `@dommaker/studio`（API + web dist + bin 一体）。
2. **迁移失败语义**：备份 + 拒启（推荐）vs 备份 + 降级继续跑——拒启更安全，继续跑更不打断用户。→ 已定：备份 + 拒绝启动。
3. **端口冲突默认行为**：动态顺延（推荐）vs 维持拒启 + 提示——动态顺延对新手友好，但"我以为起在 3001"的困惑成本存在。→ 已定：默认动态顺延（上限 +100）；显式 `--port` 冲突即拒启。
4. **契约指针挂 AGENTS.md PRESERVE 段**（推荐，治理变更）vs 只留独立文档——前者让契约在 agent 入口文档有强制可见性，但要过人闸。→ 已定：独立文档 + AGENTS.md PRESERVE 段挂指针（治理人闸当场通过，2026-09-16）。
5. **bin 命令名**：`studio start` 新动词（推荐）vs 沿用 `studio up` 改语义——沿用省一个词表项，但 `up` 现有语义里 monorepo 假设太多，改名比改语义干净。→ 已定（2026-09-16 二次确认修订）：命令面只要 web 动词 `studio run web` = 一体起服务总入口（API + 托管已构建 web dist + 首启检测/迁移/端口顺延）；**不新增** `studio start`，web 也不单设独立进程命令——web 静态 dist 随 API 一体托管，开发形态沿用 `pnpm dev` / `pnpm dev:start`。
