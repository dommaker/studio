/**
 * RoleConfig Service — 可进化角色配置的 CRUD + 初始化
 *
 * 5 个 LLM 角色的配置存储。进化系统通过此服务读写角色配置。
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger, type ModelTier } from '@dommaker/studio-shared';

// ── 类型 ──

export type RoleType = 'analyst' | 'executor' | 'reviewer' | 'knowledge_keeper' | 'auditor' | 'triage' | 'deploy';

export interface StanceConfig {
  id: string;
  name: string;
  prompt: string;
  analystFocus?: string;
  reviewerFocus?: string;
  group: 'proponent' | 'opponent' | 'neutral';
}

export interface EvolutionHooks {
  allowPromptTuning: boolean;
  allowSkillBinding: boolean;
  allowConstraintBinding: boolean;
  allowParamTuning: boolean;
  allowStanceTuning: boolean;
  autoApplyMaturity: 'candidate' | 'validated' | 'canonical';
}

export interface RoleConfigData {
  roleType: RoleType;
  companyId: string;
  systemPrompt: string;
  stances?: StanceConfig[];
  modelTier: ModelTier;
  modelRouting?: { upgradeKeywords?: string[]; upgradeTo?: ModelTier };
  boundSkills: string[];
  boundMcps: string[];
  boundTools: string[];
  boundConstraints: string[];
  executionParams?: { maxSessions?: number; sessionTimeoutMinutes?: number; maxFixAttempts?: number; fixCooldownMs?: number; maxTriageTimeMs?: number };
  evolutionHooks: EvolutionHooks;
}

// ── 默认立场定义 ──

const DEFAULT_STANCES: StanceConfig[] = [
  {
    id: 'advocate',
    name: '倡导者',
    prompt: '你是方案的倡导者，你需要论证方案的可行性，提供证据和例子。',
    analystFocus: '关注方案可行性、战略价值',
    reviewerFocus: '关注代码是否实现了设计意图',
    group: 'proponent',
  },
  {
    id: 'skeptic',
    name: '质疑者',
    prompt: '你是方案的质疑者，你需要找出潜在问题，提出替代方案或改进建议。',
    analystFocus: '关注潜在风险、边界条件、替代方案',
    reviewerFocus: '关注逻辑错误、边界缺失、错误处理、并发时序',
    group: 'opponent',
  },
  {
    id: 'neutral',
    name: '中立观察者',
    prompt: '你是中立的观察者，你需要客观分析各方观点，指出关键假设和风险。',
    analystFocus: '关注假设验证、风险识别',
    group: 'neutral',
  },
  {
    id: 'pragmatist',
    name: '实用主义者',
    prompt: '你是实用主义者，你关注实施成本、时间线和可行性。',
    analystFocus: '关注成本、排期、实施难度',
    reviewerFocus: '关注过度设计、YAGNI、复杂度',
    group: 'proponent',
  },
  {
    id: 'visionary',
    name: '远见者',
    prompt: '你是远见者，你关注长期影响、战略价值和未来可能性。',
    analystFocus: '关注长期战略影响',
    group: 'proponent',
  },
  {
    id: 'executor',
    name: '执行者',
    prompt: '你是执行者，你关注具体任务、责任分配和验收标准。',
    analystFocus: '关注任务拆解、AC 可验证性',
    reviewerFocus: '关注可维护性、可运行性、代码导航',
    group: 'proponent',
  },
  {
    id: 'reviewer',
    name: '审查者',
    prompt: '你是审查者，你需要确保质量和合规性。',
    analystFocus: '关注质量标准、合规要求',
    group: 'opponent',
  },
  {
    id: 'architect',
    name: '架构师',
    prompt: '你是架构师，你需要评估技术方案的架构影响。',
    analystFocus: '关注架构影响、模块耦合、技术债务',
    reviewerFocus: '关注架构越界、模块耦合、安全风险',
    group: 'opponent',
  },
];

// ── 默认角色配置 ──

const ANALYST_SYSTEM_PROMPT = `你是一个需求分析专家，主持多角色辩论会议。
你需要从公司知识库中获取历史经验，组织多方立场进行辩论。

## 你的职责
1. 主持赞成方与反对方的辩论，确保观点多样性
2. 从 Knowledge Keeper 获取公司历史经验（类似需求、已知坑位）
3. 产出结构化的 decisions
4. 将 decisions 聚合为 RequirementsDoc（含 acGroups + dependencies + constraints）

## 争议检查
如果连续 2 轮无反对意见，注入魔鬼代言人或通知用户。`;

const EXECUTOR_SYSTEM_PROMPT = `你是一个代码执行者。在隔离的 worktree 中工作，严格遵守 TDD 循环。

## 工作流
1. 读 REQUIREMENTS.md 了解任务和验收标准
2. 写失败的测试 → 运行确认失败 → 最小实现 → 重构
3. 重复直到所有 AC 满足
4. 运行 npm test + type check + lint
5. 更新 .progress.json

## 完成前自检
在设置 allComplete 前，切换为维护者视角：
- 每个 AC 是否被代码逻辑覆盖（不只是测试覆盖）？
- 有没有遗漏的错误处理、空值检查、边界条件？
- 如果发现任何问题，先修复再标记完成

## 行为约束
- 禁止模糊声明完成（"差不多""应该没问题"）
- 每完成一步后立即更新 .progress.json
- 全部完成后才设置 allComplete: true`;

const REVIEWER_SYSTEM_PROMPT = `你是一个代码审查者。你的任务是验证 Executor 的代码是否正确、完整、安全。

## 多立场审查
按以下顺序切换视角，每个视角关注不同问题域：
- skeptic（质疑者）：逻辑错误、边界缺失、错误处理、并发时序
- architect（架构师）：架构越界、模块耦合、安全风险
- executor（执行者）：可维护性、可运行性、代码导航
- pragmatist（实用主义者）：过度设计、YAGNI、复杂度

## 审查流程
1. 读 git diff 和变更文件完整内容
2. 运行 Executor 的测试，确认通过
3. 审计测试质量（是否只测了 happy path？）
4. 写补充边界测试，尝试打破代码
5. 逐条 AC 验证：代码逻辑是否真的满足 AC？

## 输出
写入 .review-report.json，overallApproved 仅当所有 AC 通过且无 error 级别问题。`;

const KNOWLEDGE_KEEPER_SYSTEM_PROMPT = `你是一个知识库守护者。你负责编译、维护和查询公司的 Wiki 知识库。

## Wiki 结构
- wiki/projects/PMO-xxx.md — 每个项目的完整档案（需求+决策+产出+坑位）
- wiki/skills/ — 可复用的 prompt 模板
- wiki/pitfalls/ — 已知坑位
- wiki/concepts/ — 跨项目模式
- wiki/decisions/ — 关键选型记录
- wiki/INDEX.md — 总目录

## 你的职责
1. 接收 RequirementsDoc → 创建 wiki 项目页初稿
2. Executor/Reviewer 完成后 → Ingest 更新项目页 + 提取 skill/pitfall/concept
3. 回答其他角色的查询（"做过类似需求吗？"）
4. 消费 Auditor 报告 → 更新 RoleConfig（按 evolutionHooks 权限）

## 操作原则
- Wiki 页面为 Markdown 格式，支持 [[wikilink]] 双向链接
- 新增知识默认 maturity: draft，随引用次数和验证推进
- 高置信度 Skill (≥0.8) 可自动 published`;

const AUDITOR_SYSTEM_PROMPT = `你是一个审计分析师。你扫描决策事件记录，产出带证据的洞察报告。

## 你的职责

### Daily
- 扫描昨日审计事件 → 识别异常模式
- 写入 wiki/audit/daily-{date}.md

### Weekly
- 聚合分析：Skill 效果、约束效果、决策质量、立场效果
- 验证因果关系（用 skeptic 立场对抗自己的结论）
- 产出 verified/observed/anomaly 三级结论
- 推送建议 → Knowledge Keeper（RoleConfig 优化）和 ConstraintEvolver（保留/回滚/继续）

### 报告格式
- verified: 因果证据充分，可直接执行
- observed: 相关但未证明因果，需 Knowledge Keeper 二次判断
- anomaly: 异常信号，需 Monitor 关注但不自动操作`;

const TRIAGE_SYSTEM_PROMPT = `你是一个故障分诊专家。当 WorkUnit 失败或系统出现异常时，你负责诊断根因并决定处理策略。

## 你的职责

### 诊断 (diagnose)
- 分析失败日志、错误消息、execution context
- 归类根因：代码缺陷 / 环境问题 / 超时 / 资源不足 / 外部依赖

### 分诊 (classify)
- minor: 可自动重试（如超时、临时资源不足）
- moderate: 需修复后重试（如类型错误、lint 失败）
- critical: 需人工介入（如数据丢失、安全漏洞、schema 冲突）
- blocker: 阻塞管线，立即升级

### 行动 (act)
- minor → 自动重试（最多 3 次，30s 冷却）
- moderate → 重置 execution 为 pending，注入 fixContext
- critical/blocker → 升级到 #系统 Channel + Discord 通知

### 升级 (escalate)
- 3 次重试仍失败 → 升级
- 同类错误 5 分钟内出现 3 次 → 升级
- 标记项目状态为 blocked`;

const DEPLOY_SYSTEM_PROMPT = `你是一个部署就绪检查者。在代码审查通过后、PR 合并前，验证部署条件是否满足。

## 你的职责

### 检查项
- AC 完成度：所有验收标准是否已实现
- SQL 变更检测：schema/migration 变更需 DBA 审批
- 依赖变更检测：package.json/lockfile 变更需重新安装
- 测试通过：npm test 全部通过
- 类型检查：tsc --noEmit 无错误

### 环境路由
- vps: 单机部署 → docker build + push + compose up
- company_frontend: 前端部署 → 构建产物 + 冒烟测试
- company_backend: 后端部署 → 数据库迁移 + 回归测试

### 阻塞条件
- AC 未全部完成 → blocker
- 有 SQL 变更但无 DBA 审批 → blocker (company 环境)
- 测试未通过 → blocker`;

// ── Service ──

export class RoleConfigService {
  /**
   * 获取角色的当前配置
   */
  async get(roleType: RoleType, companyId: string): Promise<RoleConfigData | null> {
    const row = await prisma.roleConfig.findFirst({
      where: { roleType, companyId },
      orderBy: { version: 'desc' },
    });
    if (!row) return null;
    return this.rowToData(row);
  }

  /**
   * 获取或创建（幂等）
   */
  async getOrCreate(roleType: RoleType, companyId: string): Promise<RoleConfigData> {
    const existing = await this.get(roleType, companyId);
    if (existing) return existing;

    const defaults = this.getDefaults(roleType, companyId);
    await this.create(defaults);
    return defaults;
  }

  /**
   * 创建新配置
   */
  async create(data: RoleConfigData): Promise<void> {
    await prisma.roleConfig.create({ data: this.dataToRow(data) });
    logger.info(`[RoleConfig] Created ${data.roleType} for ${data.companyId}`);
  }

  /**
   * 更新配置（记录修改者 + 原因）
   */
  async update(
    roleType: RoleType,
    companyId: string,
    updates: Partial<RoleConfigData>,
    updatedBy: string,
    reason: string,
  ): Promise<void> {
    const current = await prisma.roleConfig.findFirst({
      where: { roleType, companyId },
      orderBy: { version: 'desc' },
    });
    if (!current) throw new Error(`RoleConfig not found: ${roleType}`);

    const merged = { ...this.rowToData(current), ...updates };

    await prisma.roleConfig.update({
      where: { id: current.id },
      data: {
        ...this.dataToRow(merged),
        version: current.version + 1,
        updatedBy,
        updatedReason: reason,
      },
    });

    logger.info(`[RoleConfig] Updated ${roleType} (v${current.version + 1}): ${reason}`);
  }

  /**
   * 为公司的所有 5 个角色初始化默认配置
   */
  async initDefaults(companyId: string): Promise<void> {
    for (const roleType of ['analyst', 'executor', 'reviewer', 'knowledge_keeper', 'auditor', 'triage', 'deploy'] as RoleType[]) {
      const existing = await this.get(roleType, companyId);
      if (!existing) {
        await this.create(this.getDefaults(roleType, companyId));
      }
    }
    logger.info(`[RoleConfig] Initialized defaults for ${companyId}`);
  }

  /**
   * 列出公司的所有角色配置
   */
  async listByCompany(companyId: string): Promise<RoleConfigData[]> {
    const rows = await prisma.roleConfig.findMany({ where: { companyId } });
    return rows.map(r => this.rowToData(r));
  }

  // ── Private ──

  private getDefaults(roleType: RoleType, companyId: string): RoleConfigData {
    const base: Omit<RoleConfigData, 'roleType' | 'companyId' | 'systemPrompt'> = {
      modelTier: 'standard',
      boundSkills: [],
      boundMcps: [],
      boundTools: [],
      boundConstraints: [],
      executionParams: undefined,
      evolutionHooks: {
        allowPromptTuning: true,
        allowSkillBinding: true,
        allowConstraintBinding: false,
        allowParamTuning: false,
        allowStanceTuning: false,
        autoApplyMaturity: 'validated',
      },
    };

    switch (roleType) {
      case 'analyst':
        return {
          ...base,
          roleType: 'analyst',
          companyId,
          systemPrompt: ANALYST_SYSTEM_PROMPT,
          stances: DEFAULT_STANCES,
          modelTier: 'premium',
          modelRouting: { upgradeKeywords: [], upgradeTo: undefined },
        };
      case 'executor':
        return {
          ...base,
          roleType: 'executor',
          companyId,
          systemPrompt: EXECUTOR_SYSTEM_PROMPT,
          modelRouting: { upgradeKeywords: ['架构', '重构', '安全', '迁移', 'auth', '性能优化', '数据库迁移'], upgradeTo: 'premium' },
          executionParams: { maxSessions: 5, sessionTimeoutMinutes: 30 },
          boundConstraints: [
            'no_fuzzy_completion_claim',
            'no_completion_without_verification',
            'no_test_simplification',
            'incremental_progress',
            'prefer_worktree',
            'no_performative_agreement',
          ],
        };
      case 'reviewer':
        return {
          ...base,
          roleType: 'reviewer',
          companyId,
          systemPrompt: REVIEWER_SYSTEM_PROMPT,
          stances: DEFAULT_STANCES.filter(s => ['skeptic', 'architect', 'executor', 'pragmatist'].includes(s.id)),
          modelTier: 'premium',
          boundConstraints: ['no_self_approval', 'two_stage_review_required'],
          evolutionHooks: { ...base.evolutionHooks, allowConstraintBinding: true },
        };
      case 'knowledge_keeper':
        return {
          ...base,
          roleType: 'knowledge_keeper',
          companyId,
          systemPrompt: KNOWLEDGE_KEEPER_SYSTEM_PROMPT,
          evolutionHooks: { ...base.evolutionHooks, allowPromptTuning: true, allowSkillBinding: true, allowConstraintBinding: false },
        };
      case 'auditor':
        return {
          ...base,
          roleType: 'auditor',
          companyId,
          systemPrompt: AUDITOR_SYSTEM_PROMPT,
          evolutionHooks: { ...base.evolutionHooks, allowPromptTuning: false, allowSkillBinding: false, allowParamTuning: false },
        };
      case 'triage':
        return {
          ...base,
          roleType: 'triage',
          companyId,
          systemPrompt: TRIAGE_SYSTEM_PROMPT,
          modelRouting: { upgradeKeywords: ['critical', 'blocker', 'data_loss', 'security_breach'], upgradeTo: 'premium' },
          executionParams: { maxFixAttempts: 3, fixCooldownMs: 30000, maxTriageTimeMs: 600000 },
          evolutionHooks: { ...base.evolutionHooks, allowPromptTuning: false, allowSkillBinding: false },
        };
      case 'deploy':
        return {
          ...base,
          roleType: 'deploy',
          companyId,
          systemPrompt: DEPLOY_SYSTEM_PROMPT,
          boundConstraints: ['deploy_readiness_check_required'],
          evolutionHooks: { ...base.evolutionHooks, allowPromptTuning: false, allowSkillBinding: false, allowParamTuning: false },
        };
    }
  }

  private rowToData(row: any): RoleConfigData {
    return {
      roleType: row.roleType as RoleType,
      companyId: row.companyId,
      systemPrompt: row.systemPrompt,
      stances: row.stances as StanceConfig[] | undefined,
      modelTier: row.modelTier as 'fast' | 'standard' | 'premium',
      modelRouting: row.modelRouting as any,
      boundSkills: (row.boundSkills as string[]) || [],
      boundMcps: (row.boundMcps as string[]) || [],
      boundTools: (row.boundTools as string[]) || [],
      boundConstraints: (row.boundConstraints as string[]) || [],
      executionParams: row.executionParams as any,
      evolutionHooks: row.evolutionHooks as EvolutionHooks,
    };
  }

  private dataToRow(data: RoleConfigData): any {
    const json = (v: any) => v !== undefined && v !== null ? JSON.stringify(v) : undefined;
    return {
      roleType: data.roleType,
      companyId: data.companyId,
      systemPrompt: data.systemPrompt,
      stances: json(data.stances),
      modelTier: data.modelTier,
      modelRouting: json(data.modelRouting),
      boundSkills: json(data.boundSkills),
      boundMcps: json(data.boundMcps),
      boundTools: json(data.boundTools),
      boundConstraints: json(data.boundConstraints),
      executionParams: json(data.executionParams),
      evolutionHooks: json(data.evolutionHooks),
    };
  }
}

export const roleConfigService = new RoleConfigService();
