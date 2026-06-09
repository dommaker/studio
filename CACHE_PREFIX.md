<!-- SHARED_CACHE_PREFIX — DO NOT EDIT — identical across all worktrees -->

# Project Context (shared)

## Output Style

Terse like caveman. Technical substance exact. Only fluff die.
Drop: articles, filler (just/really/basically), pleasantries (sure/certainly/happy to), hedging.
Fragments OK. Short synonyms. Code blocks unchanged. Error messages quoted exact.
Pattern: [thing] [action] [reason]. [next step].
No sycophantic openers/closing fluff. No emojis or em-dashes.
Read existing files before writing. Don't re-read unless changed.
Skip files over 100KB unless required.
Don't guess APIs, versions, flags, commit SHAs, or package names. Verify before asserting.

## Governance Rules
<!-- HARNESS_CONSTRAINTS_START -->
<!-- version: 0.13.3 -->
### Iron Laws (违反将阻断)
- **no_bypass_checkpoint**: 每个关键步骤后有 checkpoint 验证点，必须通过才能继续。通过标准：测试通过、类型检查无错误、lint 无新增警告。未通过时回退修复，不得跳过。
- **no_self_approval**: 声明任务完成时，必须提供可验证的测试证据（测试报告、覆盖率数据、CI 通过记录），不得仅凭自己的判断声称完成。
- **no_completion_without_verification**: 在声明任务完成前，必须重新运行完整的验证命令（npm test、npm run build、type check），使用新鲜的输出作为完成证据，不得复用旧结果。
- **no_test_simplification**: 编写测试时遇到困难（mock、异步、环境），不得删除用例或跳过断言。正确做法：分析问题 → 查阅文档 → 尝试解决 → 仍不行则向用户说明困难请求指示。不得降低覆盖率要求。
- **incremental_progress**: 一次只处理一个任务。改动涉及多个模块、超过 100 行、或影响多个文件时，必须拆分为小步骤分步执行，每步有独立 checkpoint 可回滚。不要试图一次性完成所有改动。
- **verify_external_capability**: 实现方案依赖外部 API/服务未确认的能力时，必须先查阅官方文档确认能力存在，再发送最小测试验证可行性，记录限制作为设计约束。不要假设外部系统支持某种能力就直接开发。
- **no_implementation_without_requirement_review**: 实现完成后，必须逐条对比原始需求文档（Spec/Issue/Roadmap）中的验收标准(AC)，确认每条 AC 已实现且边界情况已覆盖，输出验证清单。不得仅凭"功能能跑"就认为完成。
- **no_implementation_without_requirement**: 开始编写代码前，必须确认：需求来源明确（Spec/Issue/Roadmap/用户指令）、验收标准(AC)已定义、边界情况已明确。不要凭假设或猜测开始实现。
- **no_fuzzy_completion_claim**: 声明任务完成时，禁止使用模糊词语。必须提供具体的测试通过数量、覆盖率数据和验证命令输出来证明任务真的完成了。声明"已删除"前必须用 ls 确认文件不存在。声明 spec 完成前必须逐 AC 对照。
- **no_performative_agreement**: 先思后码。明确声明前提假设。遇不确定先提问而非猜测。存在歧义时列出多种理解路径。若存在更简方案应果断提出异议。收到需求时：①复述理解 ②提出疑问 ③说明方案 ④确认一致。
- **two_stage_review_required**: 代码审查必须分两阶段：① 规范合规审查 — 逐条对照验收标准(AC)验证实现是否满足需求，重新运行测试，审计测试质量并补写边界用例；② 代码质量审查 — 仅在 Stage 1 全部通过后，检查安全性、可读性、类型安全。Stage 1 不通过则不得进入 Stage 2。
- **docs_freshness**: CAPABILITIES.md 必须与源码同步。新增/删除模块后运行 harness sync-docs 更新，不提交过期引用。

### Guidelines (应遵循)
- **no_fix_without_root_cause**: 修复问题时必须先定位根因。不绕过问题、不遮掩症状、不用临时方案代替根本修复。在分析文档中记录根因分析过程。
- **no_code_without_test**: 新代码必须同时编写测试。实现功能前先写测试用例（RED），然后实现让测试通过（GREEN）。不得提交无测试覆盖的实现代码。
- **no_any_type**: 禁止使用 TypeScript any 类型。使用具体类型、泛型或 unknown 代替。any 绕过类型检查带来运行时风险。
- **simplest_solution_first**: 简单至上：仅用最少代码解决问题。不添加"以防万一"的冗余功能。不为仅用一次的代码强行设计抽象。自检：资深工程师是否会认为此实现过度复杂？若是，立即简化。
- **no_creation_without_reuse_check**: 创建新模块/文件前，先检查项目中是否已有类似实现可以复用。优先扩展现有模块，避免引入重复代码和功能。
- **capability_sync**: 核心模块变更（新增/修改/删除/扩展）必须同步更新 CAPABILITIES.md。内部重构和 bug fix 不需要。
- **no_simplification_without_approval**: 不得擅自简化或删除测试、lint 规则、类型检查或约束。如需降低检查标准，必须先提案并获明确批准。
- **no_skill_without_test**: 新创建的 Skill 模块必须有对应的测试文件。测试应覆盖正常路径、边界情况和错误处理。
- **test_coverage_required**: 提交前确认测试覆盖率达标（默认 80%）。新代码必须有对应测试覆盖。
- **design_decision_requires_discussion**: 涉及架构变更、新增依赖、API 设计等重大决策时，必须先提出讨论获得确认，再开始实现。不要凭单方面判断做架构决策。
- **no_coverage_decrease**: 代码覆盖率不得下降。新增代码必须有对应的测试覆盖。运行 npm test -- --coverage 验证覆盖率。
- **context_doc_sync**: 关键目录应有 CONTEXT.md。新增模块时同步创建，运行 harness sync-docs 可自动生成模板。
- **no_excuse_patterns**: 遇到困难时，禁止使用借口搪塞（稍后修复、小问题、不影响功能、以后再说、先这样、临时方案）。必须给出：① 问题的具体影响；② 修复的时间点或版本；③ 如果是临时方案，说明正式方案的计划。
- **yagni_check**: 遵循 YAGNI 原则（You Aren't Gonna Need It）。不要为"未来可能需要"的需求添加抽象层、接口、配置项或插件系统。如果一个 interface/abstract class 只有一个实现者，删除这个抽象。只实现当前明确需要的功能。
- **no_claim_without_evidence**: 声称任务"完成"前，必须提供可复现的验证证据：test 输出数字、ls 文件确认、grep 文档确认、spec AC 逐项对照。禁止"我记得""之前说""大部分"等无验证声明。
- **no_delete_without_context**: 删除任何代码包或模块前，必须先查 CLAUDE.md 和相关设计文档，分析是否有可吸收的功能，并记录分析结论。
- **surgical_changes_only**: 外科手术式修改：仅改动绝对必要的部分。不顺手"优化"相邻代码、注释或格式。未出问题的代码不重构。
- **no_model_for_deterministic**: 模型只做判断不做决策：路由、重试、状态码处理→用代码，不调 LLM。若常规代码能给出答案，就由代码处理。
- **no_conflict_blending**: 暴露冲突不折中：若两种模式冲突→选其一（优先更经测试的版本）+说明理由+标记另一种为待清理。
- **read_before_write**: 先读后写：加代码前读 imports/callers/工具函数。"看似互不干涉"是最危险的判断。不理解现有结构时先提问。
- **follow_conventions**: 约定胜于新奇：规范一致性 > 技术偏好。项目用 snake_case 就用 snake_case。有异议显式提出，不暗中另起范式。
- **first_principles_first**: 第一性优先: 分析设计问题从本质出发，不从当前代码推导。正确设计是什么→当前实现匹配吗→差距决定行动。禁止"代码就是这样"作为理由。
- **fix_the_problem_not_the_gate**: 质量门禁阻断时修复代码，不修复门禁。不降阈值、不删测试、不关 lint、不改断言让 CI 通过。
- **no_fallback_without_root_cause**: 改动前先问: 数据从哪来？为什么是空的？fix upstream first, fallback second。连续 2+ 次相同错误 → 停止修下游,追踪源头。
- **diagnosis_to_fix_gate**: 诊断→修复闸门: 读代码定位根因后，必须先查设计原型（为什么这么写？CLAUDE.md/类型定义/commit message），呈现确认的根因+方案草案，然后才能 Edit。禁止 Read→Edit 直跳，禁止对现有设计做未经原型对照的语义变更。
- **analysis_verification_gate**: 分析闸门: 从数据到结论必须验证关键假设。一个异常数字≠根因——先确认含义（累积/单次？量纲？正常范围？同类对比？），再推断因果。禁止"数字A太大→一定是B导致的→应该改C"这种跳级推理。
- **no_hardcoded_credentials**: 禁止在代码中硬编码密码、API 密钥、Token 等凭证。使用环境变量或安全的凭证管理方案存储敏感信息。
- **prefer_worktree**: 高风险改动（新功能、跨模块>3文件、基础设施）应在隔离的 worktree 中进行。配置修改、单文件 fix、外科手术式修复可直接编辑。

### Tips
- **readme_required**: 创建新模块时，同时创建 README.md 说明模块用途、使用方法和 API 文档，帮助其他开发者快速了解模块。
- **doc_required_for_public_api**: 公共 API（导出的函数、类、接口）必须有 JSDoc 文档注释，说明参数、返回值和用法示例。
<!-- HARNESS_CONSTRAINTS_END -->





