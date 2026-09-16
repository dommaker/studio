# npm 本地形态摸底事实报告（#563）

日期：2026-09-16　类型：analysis 调研产出（零代码改动）　来源方案：`docs/plans/2026-09-npm-local-form.md` §3.1
方法：只读核实（Read/Grep/pnpm lockfile/npm registry 查询），无证据不下结论；命令在本仓工作区执行（Node v22.22.0，pnpm 11.19.0）。

---

## Q1 发布单元：哪些包上 npm

事实：

- 根 `package.json:2-8`：`name: @dommaker/studio`、`private: true`、`bin.studio → ./bin/studio`。
- `apps/api/package.json:2-4`：`private: true`，`bin.studio → src/cli/studio-cli.ts`（TS 源）。
- private 包共 4 个：`apps/api`、`packages/studio-agent`、`packages/studio-capability`、`packages/studio-spec`（各自 package.json `private: true` 行）；`apps/web/package.json:3` 亦 `private: true`。
- **非 private 包实为 4 个**（方案只提到 shared/skill 2 个）：`studio-shared`（`main: src/index.ts`，TS 源直指）、`studio-skill`（`main: src/index.ts`）、`studio-audit`（`main: dist/index.js`）、`studio-notification`（`main: dist/index.js`）。
- npm registry 实测（`npm view`）：`@dommaker/studio` / `studio-shared` / `studio-skill` / `studio-audit` / `studio-notification` 全部 404 未发布；`@dommaker/harness@1.8.0` 已发布（scope 存在）。
- 包间依赖全部 `workspace:*`（apps/api package.json:17-23 等），外部 install 无法解析。
- 结论一成立：**当前没有任何包处于可被外部 `npm install` 消费的状态**。

结论：**证实**推荐 (a) 单包 `@dommaker/studio`。修订点：非 private 包是 4 个不是 2 个，单包策略下 `studio-audit`/`studio-notification` 也需一并处理（补 `private: true` 或明确不发布）。

## Q2 bin entry 形态

事实：

- `bin/studio:1-3`：bash 脚本，`exec npx tsx ../apps/api/src/cli/studio-cli.ts`——依赖 monorepo 相对路径 + tsx。
- `apps/api/src/cli/studio-cli.ts:1`：有 `#!/usr/bin/env node` shebang 但文件是 TS，node 直跑不了。
- 编译路径已存在：`apps/api/tsconfig.json:3-4` `rootDir: src / outDir: dist`；`apps/api/package.json:10-11` `build: tsc`、`start: node dist/index.js`——tsc 编译产物可直接 node 跑，薄入口缺的不是编译能力而是 bin 指向。
- **tsx 在根 `package.json:63-66` 被声明为 `dependencies`（生产依赖语义），不是 devDependencies**；apps/api 的 tsx 才在 devDependencies（package.json:51）。

结论：**证实**推荐 (a) 编译 dist + 薄入口。修订点：方案说"tsx 是 dev 依赖语义"与现状不符——根包已把 tsx 放进生产依赖，整改范围含根 dependencies。

## Q3 apps/web 静态资源随包分发

事实：

- `apps/api/src/app.ts:133-151`：`express.static(<api>/frontend/dist)` + SPA 回退 `sendFile(index.html)`，路径约定为 `__dirname/../frontend/dist`。
- `.gitignore:8-10`：`apps/api/frontend/` 整个目录不入库，注释写明由 prod 部署脚本同步；当前工作区 `apps/api/frontend/dist` 不存在（实测 ls）。
- `ops.service.ts:82-112`：preflight 检查 `frontend/dist/index.html`，缺失时**现场 auto-build**——`execSync('npx vite build', cwd: <REPO_DIR>/apps/web)` 再 `cp -r` 到 frontend/dist。此分支要求用户机器有 apps/web 源码 + 完整 vite 构建链。

结论：**证实**推荐 (a) 预构建打进发布包；(c) postinstall 现场构建排除成立（auto-build 分支在 npm 形态下无 apps/web 源码必然走 catch 报错）。修订点：preflight 的 auto-build 分支语义需改为"包内 dist 缺失 = 包损坏报错"，否则缺失时打出误导性错误。

## Q4 启动命令形态（`studio up` / bin/studio 服务器形态残留逐条）

事实（逐条标注去留）：

1. `bin/studio:3` npx tsx 跑源 → **去**（Q2 薄入口替代）。
2. `studio-cli.ts:19-21` `studio up` 动词；`server.ts:22-145` studioUp 全流程。
3. `server.ts:100-117` REPO_DIR 从 CWD 向上找 `package.json` 的 monorepo 假设 → **去**。
4. `ops.service.ts:87-104` preflight 现场 vite build 前端 → **去**（改包损坏报错，见 Q3）。
5. `server.ts:39-61` JWT_SECRET / ENCRYPTION_KEY 首启自举落 `.daemon/` → **留**（本地形态同样适用）。
6. `server.ts:9-20` checkPrerequisites 检查 git/claude，只打警告不阻断 → **留语义**（硬编码 claude 应改走 cli-scanner 全 provider，见 Q5）。
7. `.env` 加载双实现：`server.ts:63-85`（CLI 侧）与 `index.ts:32-61`（server 侧各一份手写解析）→ **留一**，启动路径归一时去重。
8. `server.ts:119` 端口 `PORT||3001`；`ops.service.ts:114-127` preflight `lsof -ti:<port>` 占用即 critical abort；**同时** `index.ts:471-478` server.on('error') EADDRINUSE 时 3s 后原地重试（无限循环）——同一问题两套矛盾口径。
9. `index.ts:23-26` `resolveListenHost()` 默认回环 + STUDIO_AUTH=none 硬守卫（`listen-host.ts:18-29`）→ **留**，方案 §3.4 已定不动。
10. `index.ts:5` `KNOWLEDGE_DIR` 缺省硬编码 `path.resolve(__dirname, '..', '.harness', 'knowledge')`（monorepo 相对路径，studioDir() 之外的例外）→ **改**（归数据根）。
11. `index.ts:488` `TUNNEL_URL_FILE` 硬编码 `~/.claude/tunnel-url`（studioDir() 之外的第二处例外）。
12. `index.ts:546` cloudflared **默认自启**（`CLOUDFLARED_ENABLED !== 'false'` 即拉起隧道子进程）→ npm 本地形态应**默认关**（外联行为不能默认开）。
13. `server.ts:220-247` studioStop：`lsof -ti` 杀进程 + 杀 `VITE_PORT||13000` vite dev server（dev 残留）；`server.ts:255-277` studioLogs 读 `/tmp/studio-api-*.log` → 前台进程形态下 stop/restart/logs 语义需重定义。
14. `ops.service.ts:360-412` checkProxyHealth：探测 `ss -tnp` SYN-SENT → `systemctl restart ss-local` → **去**（纯服务器运维面，且 Linux/systemd 限定）。
15. `ops-rules.ts:40` `processes_to_clean: ['tsx', 'node.*index', 'cloudflared']` + `proc-probes.ts:1-8` `/proc` 直读（Linux-only）→ 见 Q8 平台风险。
16. `server.ts:280-282` `studio db` 已退化为提示文本（死动词）。
17. **冲突发现**：`workflow.ts:4-50` `studio run <requirement>` 现状语义 = 提交需求到 #研发频道——方案 §7.5 定的 `studio run web`（web 动词一体起服务）与现存 `run` 动词直接冲突。
18. dev 形态先例：`apps/api/package.json:9` dev script `STUDIO_HOME=${STUDIO_HOME:-$HOME/.studio-dev}`；`scripts/dev/start.sh:29` 同。

结论：推荐 (a) `run web` 前台一体起服务方向**证实**，但动词冲突（第 17 条）需方案修订：要么 `studio run` 让位改语义（breaking 现有用法），要么 web 动词换名。

## Q5 外部 agent CLI 依赖声明

事实：

- `daemon/cli-scanner.ts:26-72`：`which` + version 探测，`scanAllProviders()` 返回 provider/path/version。
- provider 注册表正本：`packages/studio-shared/src/providers.ts:90+` `BUILTIN_PROVIDERS` = claude / kimi / codex / opencode，含 binaries/versionArgs/spawn 模板；`providers.ts:242` 用户 `~/.studio/providers.json` 深合并扩展。
- `cli/server.ts:9-20` checkPrerequisites 硬编码检查 git + claude，缺失只 `console.error` 不 exit（警告语义）。
- 全仓 grep `peerDependencies`：零命中。

结论：**证实**推荐 (a)+(b)：npm 无法对任意第三方 CLI 声明 peer；cli-scanner 已是探测正本，checkPrerequisites 的警告语义保留但 provider 清单应复用注册表（现状硬编码 claude 与注册表漂移）。

## Q6 数据根与多实例

事实：

- `packages/studio-shared/src/config/studio-dir.ts:50-59`：`studioDir()` = `STUDIO_HOME || ~/.studio`，`studioPath()` 单入口；`:86-96` 软护栏 `warnIfNonProdUsesProdRoot()`。
- `~/.studio-dev` dev 先例：`apps/api/package.json:9`、`scripts/dev/start.sh:29`。
- 实测 `~/.studio` 根级 **41 条**（ls 实测）：`active-project agents-registry auditor backup-* backups config.env data distill events knowledge logs mcp-audit-logs.jsonl(+bak) mcp-permissions.json notify-config.json okr projects projects.json proposals.json raft research-scratch session-checkpoint.json sessions sessions.json(+2 bak) sessions.jsonl skills skills-backup-* skills-index.json snapshots spec-reviews tools transcripts triggers users.json(+2 bak) workspace-runtimes workspaces workspace-tokens worktrees`。
- `file-store.ts:7-24` 头注释只覆盖 `data/` 子树（agents/channels/workunits/requirements 四段），且 `:4` 仍声称"知识图谱/安全/OKR 等跨模型关联数据留在 DB"——DB 已随 Spec 4 Phase 4 移除，注释漂移比方案描述的更深。
- 数据根解析例外 2 处（不经 studioDir()）：`index.ts:5` KNOWLEDGE_DIR（__dirname 相对）、`index.ts:488` TUNNEL_URL_FILE（~/.claude）。
- 多实例：`index.ts:254-268` `STUDIO_AGENT_LOOP_ENABLED=false` standby 机制——同一数据根多实例只允许一个挂 agent loop，注释（:254-258）明确写了 dev/prod 并存场景。

结论：**证实**"STUDIO_HOME 已就位，确认即可"；补充：单入口纪律已有 2 处已知例外 + 头注释漂移含 DB 残留表述，契约成文（方案 §3.2）时一并收编。

## Q7 Node engines 与发布流水线 Node 版本

事实：

- 根 `package.json:58-61`：`engines.node >=18.0.0`；`.github/workflows/release.yml:14-17`：setup-node `node-version: '22'`。
- 运行时依赖实测 engines（node_modules 直读）：express@4.22.2 `>=0.10`、tsx@4.23.1 `>=18`、esbuild@0.28.1 `>=18`、helmet@8.3.0 `>=18`、prom-client@15.1.3 `^16||^18||>=20`、ws@8.21.1 `>=10`、jsonwebtoken@9.0.3 `>=12`、pino@10.3.1 无声明、bcryptjs/uuid 无声明。
- 代码实际下限：`proc-probes.ts:22-25` 用 `fs.statfsSync`（Node 18.15+ 才提供）。
- 构建链（发布时跑）：pnpm-lock.yaml:3139 `vite@8.1.5 engines: ^20.19.0 || >=22.12.0`；dev 依赖 `@asamuzakjp/*`（jsdom 链）与 `@csstools/*`（tailwind 链）多包 `>=20.19.0`（lockfile:417-539）。

结论：**修订后证实**：运行时依赖链实际下限 ≈ Node 18.15，`>=18` 声明本身不虚；但发布流水线要跑 vite 8 build → 需 `^20.19.0 || >=22.12.0`。建议 engines 对齐 `>=20`（贴依赖链与 @types/node 20）而非维持 `>=18`；release.yml 用 22 不动。

## Q8 原生/平台相关依赖（全依赖树排查）

事实（命令：`grep node-gyp|prebuild-install|node-pre-gyp|bindings pnpm-lock.yaml` → 0 命中；`grep requiresBuild|hasInstallScript pnpm-lock.yaml` → 0 命中）：

- **零 node-gyp / 零原生编译**。唯一 install 脚本：esbuild `postinstall: node install.js`（纯 JS 二进制校验，无编译；`pnpm-workspace.yaml` allowBuilds 白名单仅 esbuild + @prisma/engines）。
- `.node` 预编译二进制仅存在于 dev 工具链平台包：`@esbuild/*`（lockfile 78 处引用）、`@tailwindcss/oxide-*`、`lightningcss-*`、`@rolldown/binding-*`——全部预编译 optionalDependencies，且全部挂在 tsx/vite/tailwind dev 侧；Q2 落地（dist 薄入口、tsx 退场）后运行时树不含这些。
- `bcryptjs@2.4.3` 实测无 `.node`/`.c` 文件 → **纯 JS 证实**。
- 非原生但 OS 相关（npm 本地形态的平台风险面）：`proc-probes.ts` `/proc` 直读（Linux-only，ops 守护/monitor/triage/env-snapper 共用）；`server.ts:224,237`、`ops.service.ts:116` `lsof` 调用；`ops.service.ts:409` `systemctl restart ss-local`；`index.ts:374` `ss -tnp`。macOS 下这些功能面不可用。

结论：**证实**"零原生模块，单包策略不重估"；新增发现：平台风险不在原生模块而在 Linux-only 探测代码，npm 形态若声明支持 macOS 需对 ops/stop/logs 做降级或平台分支（方案未覆盖平台支持范围）。

## Q9 版本号与 tag 策略

事实：

- `git tag` 全仓仅 `v0.1.0` 一个。
- `release.yml:3-5` on push tags `v*` → `:31-33` `pnpm publish --no-git-checks`（env NODE_AUTH_TOKEN）。
- 现状触发必失败：根 `private: true`，pnpm publish 拒绝；且 workspace `workspace:*` 依赖无版本可同步 → 骨架空转证实。
- `@dommaker` scope 已有发布先例（harness@1.8.0 在 registry）；`@dommaker/studio` 名可用（404）。

结论：**证实**推荐 (a) 单包单版本跟随 tag，无多包版本同步问题。

## Q10 发布包内容白名单

事实：

- 全仓 `files` 字段唯一存在处：`packages/studio-skill/package.json:8-11`（`["src","dist","skills"]`）；全仓零 `.npmignore`。
- 单包必须随包的运行资产：api 编译 `dist/`（`__dirname/../frontend/dist` 路径约定 → `frontend/dist` 需同包，`app.ts:133`）；bin 薄入口；**内置 skill 库正本 `packages/studio-skill/skills/`**（10 个 skill 目录实测，`index.ts:87-103` seedBuiltinSkills 启动时从包路径同步进数据根，缺它首启 skill 库为空）。
- 必须排除：tests/ scripts/ .github/ .harness/ apps/web 源码、docs/（可选）、monorepo 治理文件（AGENTS.md/pnpm-workspace.yaml 等）。npm pack 默认带全部非 gitignore 文件 → 无白名单必漏。

结论：**证实**推荐 `files` 白名单；补充：`skills/` 内置库是容易漏掉的必需条目。

---

## 与方案假设的冲突点（汇总，按影响排序）

1. **`studio run` 动词已被占用**（`workflow.ts:4-50`，现状 = 提交需求到 #研发）。方案 §7.5 定 `studio run web` 为一体起服务总入口——命令面与现状直接冲突，需裁决：改 `run` 语义（breaking）或 web 动词换名。
2. **非 private 包是 4 个不是 2 个**：方案 §1/§3.1-Q1 只列 studio-shared/studio-skill；实测 `studio-audit`、`studio-notification` 也无 `private: true`（main 指 dist）。单包策略需多处理两个包。
3. **tsx 已在根 `dependencies`（生产依赖语义）**（根 package.json:63-66）。Q2 候选 (b) 的描述"tsx 是 dev 依赖语义"与仓内现状不符——tsx 退场范围含根包 dependencies 整改。
4. **端口冲突双口径矛盾**：ops preflight 占用即 abort（ops.service.ts:114-127）vs `index.ts:471-478` EADDRINUSE 3s 无限重试。§3.4 端口顺延设计只提了收编 preflight，listen 层重试逻辑同样需要删除/统一，否则顺延改了 preflight 仍被重试循环掩盖。
5. **cloudflared 默认自启**（index.ts:546，`!== 'false'` 即拉起）：npm 本地形态默认发起外联隧道不可接受，需翻转为默认关；且 `index.ts:488` tunnel URL 写 `~/.claude/tunnel-url`——studioDir() 之外的路径例外。§3.4 未覆盖此项。
6. **KNOWLEDGE_DIR 硬编码 monorepo 相对路径**（index.ts:5，`__dirname/../.harness/knowledge`）：单包 dist 形态下指向包内目录（发布包未必含 .harness/knowledge），需归数据根；§3.2 契约"唯一解析入口"已有例外，成文时需收编。
7. **Linux-only 探测面未纳入方案视野**：`/proc` 直读（proc-probes.ts）、lsof、systemctl、ss——npm 本地形态的平台支持范围（Linux-only？含 macOS？）方案未定，ops 守护/stop/logs 的跨平台降级策略缺失。
8. **preflight 前端 auto-build 分支在 npm 形态下必然失败**（ops.service.ts:87-112，需 apps/web 源码）：方案 §3.1-Q3 说"路径约定不动"，但 preflight 检查分支语义必须改（缺失=包损坏报错），非"不动"。
9. **file-store.ts 头注释漂移更深**：除方案已知"只覆盖 data/ 子树"外，`:4` 仍声称跨模型关联数据留 DB（DB 已移除）。§3.2 契约成文时需整段重写而非迁移。
10. **实测根级条目 41 条**（方案按 20+ 估计）：含 `raft/`、`research-scratch/`、`snapshots/`、`session-checkpoint.json`、多个 `*.bak-*`/`skills-backup-*` 遗产，契约三类归类的清单工作量比预期大。

## 未查实项

- **pnpm publish 对 `workspace:*` 协议的具体重写行为**（单包策略下 apps/api 内 7 条 `workspace:*` 依赖会被重写为具体版本还是导致发布失败）——需实操 `pnpm pack`/`pnpm publish --dry-run` 验证，本票只读不执行。单包内嵌方案若走"根包发 dist 不含子包 manifest"则绕开此问题，待设计定稿时验证。
- **`bootstrapHarness()` 缺 `.harness/config.yml` 时的行为**：代码有 try/catch（bootstrap.ts:23-32），倾向容错，但未实跑验证无 .harness 目录时是否完全无副作用。
- **vite build 产物体积 / 发布包总体积**：frontend/dist 当前不存在（gitignore），无实物可量；打包体积风险待实现票 `npm pack` 实测。
