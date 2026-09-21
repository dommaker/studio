# E1 飞轮 Phase 1 复盘修正计划

> 2026-09-21 立。依据：`2026-09-flywheel-e1-phase1.md` 实施后复盘 + 当日交叉验证（结论台账见文末附录）。
> 范围 = 修 D1 与 harness 现状冲突的落点 + 验收可信度前置修复 + 消费链路断点诊断。Phase 2（违规代理计数、channel schema）仍不在本批。

## 背景：交叉验证结论（一句话版）

- 复盘主要论点**成立**：`config.yml` 的 constraints 条目只有 `enabled` 一个字段（`harness/src/types/project-config.ts:218`），modify_message 无落点（ADR-0029 关停文本注入层）、add_exception 机制已物理删除（ADR-0005），且已知 id 下的未知字段**静默忽略、不进任何诊断**——D1.3 原写法必然假绿。
- 复盘两处过时/错误：`renderWithOverride` 生产调用已为 2 处（D3 今日接入）；`.consumption-stats.json` 不是独立计数器，是 studio 事件流 `knowledge:consumption` 的每日聚合（`monitor-reports.ts:300-305`），真实问题是**生产上注入/检索从未触发**（`knowledge:probe`×1723 vs `knowledge:consumption`×0）。
- D2/D3/D4/D5 与现状无冲突，其中 D2/D3 已落地，不在本计划重做。

## 设计决策

### M1 — 知识库 schema 闸（harness 仓，最先做）

- 理由：飞轮指标的分母是这批条目；实盘 228 条活跃条目里 maturity 未声明值 12 条（`pending`×10、`canonical`×2），layer 未声明值 27 条（`undefined`×15、`L3_tool_behavior`×12），另有 `process`×3 是 subsystem 值串进 layer 字段。写入路径（`harness/src/knowledge/store.ts` save/update）零运行时校验，`lint.ts:264 validateEntry` 不碰这两个字段。
- 动作：
  1. save/update 写入路径加 maturity/layer 枚举校验，未声明值**拒写并报错**（不静默降级——降级又是另一种假绿）；
  2. `validateEntry` 同步覆盖 maturity/layer，lint 能报出存量脏条目；
  3. 存量清洗：先查每个未声明值的来源（哪条写入路径放进去的），再逐条裁定映射（如 `pending`→`draft`），**逐条人工核对，不写批量脚本硬转**。
- 先行测试：脏值拒写测试 + 存量 lint 报告测试。

### M2 — 消费链路诊断：为什么注入从未发生（诊断票）

- 事实：回调注册链路通（probe×1723 自检成功），但生产上 `injectContext` / 检索从未触发 `recordReference` → `knowledge:consumption` 为 0 → 消费命中率恒 0%。
- 动作：定位 injectContext 的生产调用方（谁、在什么时机应该调它），找出"接了自检没接流量"的断点。
- 产出：根因报告 + 修复方案。修复本身按根因大小裁定本票做还是另开——**本票只承诺诊断结论**。

### M3 — D1 (a) 链路修正

1. **--json bug 修复（harness）**：父命令 `constraints` 与子命令 `report` 同名 `--json` 相撞（`definitions.ts:312` vs `:322`），commander 把 flag 消费在父命令上，子命令 JSON 分支（`constraints-report.ts:121`）不可达。修法二选一：删父命令 `--json`（父 action 的 `options.json` 一并处理）或子命令换名。先行测试复现父子同名场景。
2. **动作集收敛**：`generator.ts constraintProposals()` 只映射 **retire / disable** 两类（config.yml 装得下的唯二动作）；modify_message / add_exception 从本票删除。未来若需要，另开 harness 票扩生效集（新字段 + 校验 + 诊断一起加），禁止再走"写进去没人读"的假绿路径。
3. **retire 复用知识沉淀**：`retireConstraint()`（`constraints-retire.ts:193`）除写 config 外还写 `constraint-retired-<id>` 知识条目（`consumptionMode: 'signal'`）。applier 必须复用该函数（或抽出共用层），禁止自写 config.yml 落盘——否则飞轮唯一的自动入水口被绕开。
4. **barrel 导出重新裁定**：往 `src/core/index.ts` 加导出撞 public-value-surface 冻结闸，属公共面 breaking（`gates/CONTEXT.md:31`）。**M3.1 修好后 `--json` 取数路径即通，studio spawn CLI 取数是备选方案**——先做 M3.1，再裁定：CLI 通则不加导出（优选，零公共面变更）；确需导出则补 ADR 记名（消费者、为什么不走 CLI），否则下次清账会被当死面砍掉。
5. **config.yml 生效留痕口径（已定，2026-09-21 会话当场人闸通过）**：studio `.harness/config.yml` 是 git 跟踪文件，飞轮自动生效后由 **applier 立即自动 commit 直落 master**（符合 studio「提交直落本地 master」纪律，不留工作区脏改动）；commit message 正文带提案号，trailer 写 **`Governance-Approved: EP-XXXX`**（提案号）。注意：现有 trailer 词表原为 `session` / `#<单号>`，纳入 EP 号属词表小扩展——本次会话确认即为人闸留痕，词表扩展已落 studio/AGENTS.md 治理段并注明出处与日期（2026-09-21）。频道 approve 本身是审批人闸，commit 只是其留痕出口，不构成绕过。

### M4 — D6 验收加固

- 第 5 步"被消费"改为走**真实 injectContext 路径**（经 API 实例，非 mock 单测）。
- 加第 6 步判据：验收后 `knowledge:consumption` 事件 > 0、次日 `.consumption-stats.json` dailyEvents > 0——消费命中率脱离 0%。
- 依赖 M2：若 M2 发现注入入口本身未接生产流量，验收口径按根因修复后的真实路径调整。

### M5 — 检索质量评测（记 Phase 2 候选，本批不做）

- 实盘 2508 条里 2273 条是归档尸体、活跃仅 228 条；无任何"该找到的找没找到"的评测。Phase 2 排期时优先考虑，仍属信号侧之外的知识面缺口。

## 实施顺序（每步先行测试）

1. M1 schema 闸（决定一切指标的可信度）
2. M3.1 --json 修复（小；且是 M3.4 裁定的前置）
3. M2 消费链路诊断
4. M3.2 + M3.3 动作集收敛与 retire 复用
5. M3.4 barrel 导出裁定（依 M3.1 结果）
6. M3.5 留痕落地（口径已定：自动 commit + `Governance-Approved: EP-XXXX`）
7. M4 验收加固
8. 收尾：相关 CONTEXT.md 同步（knowledge / evolution / harness 侧对应目录）、code-review、commit

## 风险

- M1 清洗映射判错会改坏历史条目 → 逐条人工核对；harness 写入路径加拒写后，存量脏值的写入方（若有自动化在跑）会开始报错——先查来源再上闸。
- M2 可能牵出大范围（注入入口未接生产流量）→ 本票只做诊断，修复范围另行裁定，防止 scope 蔓延。
- M3.4 若 CLI 取数通却仍加导出，属无消费者支撑的公共面扩张，review 应打回。

## 附录：交叉验证台账（2026-09-21，两路 explore 实测）

| 复盘断言 | 结论 | 关键证据 |
|---------|------|---------|
| constraints 条目只有 enabled 字段 | 成立 | `project-config.ts:218` |
| ADR-0029 关停文本注入 / ADR-0005 删例外 | 成立 | `docs/adr/0029`、`docs/adr/0005`（明文"静默忽略"） |
| 未知字段静默假绿 | 成立 | `effective-set.ts:30-37` 只收 unknownIds；loader 无 schema 校验 |
| --json 父子同名相撞 | 成立（根因复现） | commander 12.1.0 实测；`definitions.ts:312/322` |
| 实盘仅 1 条候选（capability_sync 零拦截） | 成立 | 262 次评估从未 fail；23%/26% fail 率够不到高噪 80% 阈值 |
| barrel 三道冻结闸 / ADR-0022 零消费者即删 | 成立 | `gates/CONTEXT.md:31`；`./core` 29 键逐字冻结 |
| retire 写 KnowledgeStore 沉淀 | 成立 | `constraints-retire.ts:132-193` |
| studio `.harness/config.yml` git 跟踪 | 成立 | `git ls-files` 确认 |
| 知识条目脏值、无运行时校验 | 成立 | 数字分毫不差（pending×10 / canonical×2 / undefined×15 / L3×12） |
| 事件流 tool:call / knowledge:outcome 为 0 | 成立 | 近 9 天 3837 条事件三类全 0，源头未写 |
| 提案自锁两个 | 成立（已修复） | EP-0001/EP-0002；TTL→stale 今日落地，惰性触发 |
| renderWithOverride 生产调用 0 处 | **过时** | D3 今日接入，`knowledge-service.ts:560,566` 两处 |
| `.consumption-stats.json` 是独立计数器 | **错误** | 写入者是 `monitor-reports.ts:300-305`，数据源同一事件流 |
| 无检索质量评测 | 成立 | 活跃 228 条；recall 评测零命中 |
