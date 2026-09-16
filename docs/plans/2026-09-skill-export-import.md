# skill 导出/校验/安装（进化成果的流动）

日期：2026-09-16　状态：设计提案（未实施，待评审）

## 1. 背景与现状

studio 的 skill 立场是「进化出来的」：skill-extraction 从 WU 提取 → 人审（review-proposal 正本）→ 入库，不做应用市场。但进化成果没有流动路径：数据区 `~/.studio/skills/` 的 skill 无法规范地导出给别的团队/机器，也没有回馈内置库正本（`packages/studio-skill/skills/`，17 个内置，随 npm 包分发）的通路。本方案补齐这条流动路径：导出/校验/安装三件套，只做流动、不做市场。

已核实的现状事实：

- **磁盘布局**：`<SKILLS_DIR>/<name>/SKILL.md`，SKILLS_DIR = `SKILLS_DIR` 环境变量或 `studioPath('skills')`（默认 `~/.studio/skills/`）。内置 skill 目录可带子目录（如 `tdd-implement/evals/`），无强制 references/assets 约定。
- **frontmatter 字段**：`name`（必填）、`description`、`agentTypes`、`status`（缺省=published 语义，显式非 published 被 loader/manifest 跳过）、`tier`、`version`（number，SkillStore 写入）、`tools`、`required`、`triggers`、`consumers`。解析器有两份口径：`@dommaker/studio-shared` 的 `parseFrontmatter`（packages/studio-skill/src/loader.ts 用）与 manifest-loader.ts 自解析（多认 triggers/consumers）。
- **seed 升级机制**（packages/studio-skill/src/seed.ts，`seedBuiltinSkills()`）：启动时把内置正本同步进数据区，中央 hash 台账 `<SKILLS_DIR>/.builtin-hashes.json`。关键语义——目标目录存在但无台账记录且与正本不一致 → `skippedLegacy` **永不动**；磁盘内容与台账记录不符（用户改过）→ `skippedUserModified` 永不动。hash 覆盖整个目录树（`hashSkillDir()`）。seed 只拷目录 + 写台账，**不写** `skills-index.json`（SkillStore 的 CRUD 索引）。
- **SkillStore / 提取来源**：`skill-store.ts` 的 SkillRecord 有 `source`（如 `auto_extracted`）、`version`、`metadata`（JSON，skill-extraction 写入 `sourceGoalIds`/`confidence`，skill-extraction.service.ts:144）；落 `~/.studio/skills-index.json`，与 SKILL.md 目录双写。注意 `writeSkillMd()` 生成的 frontmatter **不含 description/triggers**。
- **CLI**：`apps/api/src/cli/studio-cli.ts` switch 分发，按域拆子模块（server/dev/workflow/data/config/admin）；`studio skill list` 已存在，走 `apiCommand('skills')`（HTTP API，需 daemon 在线）。

## 2. 目标与非目标

目标：

1. `studio skill export <name>`：从数据区打包 skill 为可搬运产物。
2. `studio skill validate <dir>`：离线校验 skill 目录布局 + frontmatter。
3. `studio skill install <dir>`：把 skill 装进数据区，冲突处理明确，与 seed 机制不打架。
4. 给出数据区 skill 回馈 `packages/studio-skill/skills/` 正本的最简流程。

非目标：marketplace UI、版本升级链、远程 registry、scaffold（skill 由提取/人审产生，不需要脚手架）、inputs 参数化、capabilities 权限声明（后两项 YAGNI）。

## 3. 方案

### 3.1 打包格式

- **产物 = 目录拷贝**，不打 tgz。export 将整个 skill 目录树（SKILL.md + 子目录，与 `hashSkillDir()` 同一口径）复制到 `<outDir>/<name>/`。跨团队流动走 git/共享盘/任意文件传输，目录形态可直接 diff、可直接进对方仓库——这正是回馈内置库的场景。tgz 作为单文件传输便利列开放问题 Q1。
- **来源信息**：export 时在产物根写边车文件 `PROVENANCE.json`（不污染 SKILL.md frontmatter，loader/manifest 天然忽略未知文件）：`{ name, version, exportedAt, source, sourceWorkUnits?, contentHash }`。`source`/`sourceWorkUnits` 从 `skills-index.json` 的 SkillRecord（`source`/`metadata.sourceGoalIds`）取，取不到则 `source: 'unknown'`（内置 skill 的数据区副本即此情形）。`contentHash` 复用 `hashSkillDir()`。version 取 frontmatter `version`，缺省 1。
- **版本标识**：frontmatter `version`（整数）+ 内容 hash 双标，不做升级链——install 只用 hash 判「内容是否相同」。

### 3.2 三条命令

落点：`apps/api/src/cli/skill.ts`（新文件，纯本地文件操作，不依赖 daemon 在线——这是与 `studio skill list` 走 HTTP 的本质区别）；`studio-cli.ts` 的 `case 'skill'` 分流：`export|validate|install` → 本地实现，其余维持 `apiCommand('skills')`。`docs/cli-reference.md` 补三条。

校验逻辑（validate 的核心，export/install 复用）抽为 `apps/api/src/cli/skill-validate.ts` 纯函数，规则：

- error：目录不存在或无 SKILL.md；frontmatter 不可解析；`name` 缺失/为空；`name` 与目录名不一致（loader 按目录名寻址、id 取 meta.name，不一致会索引错乱）；`status` 显式存在但不在词表（published/draft/deprecated）。
- warning：`description` 缺失（索引进 prompt 的主信号）；`status` 非 published（不会被注入，仅提示）；无 `triggers`（selector 匹配弱）。SkillStore 生成的 draft SKILL.md 无 description——故 description 缺失只能是 warning 不能是 error。

命令语义：

- `studio skill export <name> [outDir]`：validate 数据区目录（error 即拒）→ 拷贝到 `<outDir>/<name>/`（默认 cwd）→ 写 PROVENANCE.json。outDir 已存在同名 → 报错，给 `--force`。
- `studio skill validate <dir>`：跑上述规则，人读报告，退出码 0/1。
- `studio skill install <dir>`：validate（error 即拒）→ 查冲突 → 拷入 `<SKILLS_DIR>/<name>/`。冲突处理：
  - **与内置正本同名**（读 `packages/studio-skill/skills/` 目录列表判定）→ **永远拒绝**，提示改名。理由见 §3.4。
  - 数据区同名、内容 hash 相同 → no-op 提示。
  - 数据区同名、内容不同 → 拒绝，给 `--force`（覆盖整目录，与 seed `copyTree` 同语义）。
  - install **不写** `skills-index.json`（与 seed 对齐：目录即注册，loader/manifest 只读目录）；**不写** `.builtin-hashes.json`（seed 私有台账，染指即破坏升级判据）。

### 3.3 回馈内置库的路径（最简方案）

**不加辅助命令**。流程 = 现有命令的组合 + 人工 PR：

1. `studio skill export <name> <studio-repo>/packages/studio-skill/skills/` —— outDir 直指本地仓库 checkout，产物即落在正本目录。
2. 人工审查：删 `PROVENANCE.json`（正本不带实例来源信息），按需补 `description`/`triggers`，`status: published`。
3. `studio skill validate packages/studio-skill/skills/<name>` 过检 → 提 PR → 合并后随 npm 包分发，各机 seed 播种。

回馈质量门 = validate + 人审 PR，与 skill 入库一贯的人审立场一致。

### 3.4 与 seed 机制的隔离规则

冲突点（读 seed.ts 后的结论）：若 install 一个与内置同名的 skill，因无台账记录且内容与正本不一致，seed 判 `skippedLegacy` 永不动——表面无害，实则**该机的内置同名 skill 从此收不到升级**（hash 升级通道被占名堵死）；内容碰巧与正本一致则被 `adopted`，下次升级被覆盖，用户内容静默丢失。两条路都是坑。

隔离规则（两条，实现于 install）：

1. install 拒绝与内置正本同名（内置清单 = `packages/studio-skill/skills/` 目录名，经 studio-skill 包路径解析；数据区已有同名 legacy 占位的，报错信息里点名该目录，由人决定改名或删除）。
2. install/export/validate 对 `.builtin-hashes.json` 只字不碰；export 拷贝时排除该文件（它在数据区 skill 目录的父级，按目录树拷贝天然不含，仅作显式断言）。

反向（export 数据区里的内置副本）允许——它出得了这台机器，进不了对方内置库同名的数据区（规则 1 拦），语义自洽。

### 3.5 阶段划分

- **P1 — validate**：`skill-validate.ts` 纯函数 + `studio skill validate` + CLI 分流骨架。独立交付，是 P2 的前置。测试：规则矩阵（每个 error/warning 一例）+ CLI 退出码。
- **P2 — export + install + seed 隔离**：`skill.ts` 两命令 + 内置同名拒绝 + 冲突/--force 语义。测试：tmp 目录隔离（`SKILLS_DIR` 环境变量，现有测试同做法）覆盖 export 产物结构/PROVENANCE.json 字段、install 三类冲突、内置同名拒绝、hash no-op。
- **P3 — 回馈流程落地**：§3.3 流程写进 `packages/studio-skill/CONTEXT.md`（或 docs/ 开发文档）+ `docs/cli-reference.md` 三条命令 + skills 模块 CONTEXT.md 补条目。零代码，可与 P2 同批或独立。

每阶段独立 checkpoint：P1 只增不改，P2 不动 P1 规则集（复用 import），P3 纯文档；任一阶段回滚不影响既有 `studio skill list` 与 seed。

## 4. 验收标准（AC）

1. `studio skill validate` 对合法内置 skill（如 `packages/studio-skill/skills/research/`）退出码 0；对缺 SKILL.md、name 缺失、name≠目录名、status 越界各报对应 error，退出码 1。
2. `studio skill export <name> <out>` 产出 `<out>/<name>/` 目录树与数据区逐字节一致（SKILL.md 及子目录），含 PROVENANCE.json 且 `contentHash` 与 `hashSkillDir()` 一致；提取来源 skill 的 `sourceWorkUnits` 来自 skills-index.json。
3. `studio skill install <dir>` 后 `skillLoader.loadSingle(<name>)` 可加载（SKILLS_DIR 隔离测试断言）。
4. install 与内置正本同名 → 拒绝且不写任何文件；数据区同名同 hash → no-op；同名不同 hash → 无 --force 拒绝、有 --force 覆盖。
5. install 后 `<SKILLS_DIR>/.builtin-hashes.json` 与 `skills-index.json` 内容不变。
6. 三条命令在 daemon 离线时可用（纯本地文件操作）；`studio skill list` 行为不变。
7. 全量受影响测试 + typecheck + lint 通过；新代码带测试（cli `__tests__`）。

## 5. 风险与边界

- **frontmatter 解析口径分裂**：loader（studio-shared parseFrontmatter）与 manifest-loader（自解析，多认 triggers/consumers）字段集不同。validate 复用 studio-shared 版并对 triggers/consumers 做宽松兼容；两口径统一是另一笔债，不在本方案。
- **数据区双写面**：SkillStore（skills-index.json）与目录双写，install 只落目录 → REST CRUD 面看不到 install 来的 skill（内置 skill 本就如此，语义一致）；若未来要管，走 SkillStore 另行收养，不属本期。
- **公开仓库脱敏**：PROVENANCE.json 只含 skill 名/WU id/hash，不含路径与机器信息；export 实现不得把绝对路径写入产物。
- 实施时核查项：① studio-shared `parseFrontmatter` 对行内数组/引号的兼容口径与 manifest-loader 是否完全对齐；② `studio-cli.ts` 的 `extractConfigFlag`/前置逻辑不会在本地命令路径上触发 daemon 连接；③ 内置正本目录列表在 npm 安装形态下的解析路径（seed.ts `defaultSourceDir()` 的上溯一级逻辑可复用）。

## 6. 不做清单

- marketplace UI、skill 浏览/搜索面。
- 版本升级链（install 不做版本比较，只有 hash 相同/不同两态）。
- 远程 registry / 发布通道。
- scaffold（skill 从 WU 提取产生，不需要空模板脚手架）。
- inputs 参数化、capabilities 权限声明（YAGNI）。
- 改动 seed.ts 升级语义、改动 SkillStore/manifest-loader 现有行为。

## 7. 开放问题（待拍板）

- **Q1 export 要不要同时产出 tgz？** 选项：A 只目录（推荐——回馈内置库场景要 diff 形态，单文件传输用户自行 `tar czf`）；B 加 `--tgz` flag。推荐 A，YAGNI。
- **Q2 install 来源是否接受 tgz？** 选项：A 只接受目录（推荐，与 Q1-A 对称）；B 同时接受 `.tgz`（多一个解压依赖与校验面）。推荐 A。
- **Q3 install 与内置同名是硬拒绝还是允许改名安装？** 选项：A 硬拒绝 + 报错提示人工改名（推荐，最简）；B 提供 `--as <newName>` 一键改名落盘（便利但多一个语义面：frontmatter name 需同步改写）。推荐 A。
- **Q4 PROVENANCE.json 的归宿**：边车文件（推荐，loader 天然忽略）vs 写进 frontmatter 扩展字段（随 SKILL.md 进 PR 正本，污染正本）。推荐边车。
