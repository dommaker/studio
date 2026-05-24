/**
 * ResolutionService — RKB 匹配/创建/验证
 *
 * L3~L6 运维配置类知识：错误模式 → 已知解法。
 * 供 agent-executor (重试时注入) 和 Auditor (日审自动创建) 使用。
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import type {
  Resolution,
  CreateResolutionInput,
  MatchResolutionInput,
  MatchResolutionResult,
} from '@dommaker/studio-shared';

export class ResolutionService {
  private static instance: ResolutionService;

  static getInstance(): ResolutionService {
    if (!ResolutionService.instance) {
      ResolutionService.instance = new ResolutionService();
    }
    return ResolutionService.instance;
  }

  /**
   * 匹配错误消息 → 已知解法
   *
   * 两层匹配：
   * 1. 精确 regex 匹配 (pattern 是有效 regex 时)
   * 2. 子串包含匹配 (pattern 在 errorMessage 中)
   *
   * 只返回 verified/canonical status 的解法。
   */
  async matchResolutions(input: MatchResolutionInput): Promise<MatchResolutionResult> {
    const { errorMessage, errorClass } = input;

    try {
      const candidates = await prisma.resolution.findMany({
        where: {
          status: { in: ['verified', 'canonical'] },
          ...(errorClass ? { errorClass } : {}),
        },
        orderBy: { verifyCount: 'desc' },
      });

      const matched: Resolution[] = [];
      const lowerMsg = errorMessage.toLowerCase();

      for (const row of candidates) {
        const pattern = row.pattern;
        let isMatch = false;

        // Try regex first
        try {
          const re = new RegExp(pattern, 'i');
          if (re.test(errorMessage)) {
            isMatch = true;
          }
        } catch {
          // Not a valid regex, fall back to substring match
          if (lowerMsg.includes(pattern.toLowerCase())) {
            isMatch = true;
          }
        }

        if (isMatch) {
          matched.push({
            id: row.id,
            pattern: row.pattern,
            errorClass: row.errorClass,
            layer: row.layer as Resolution['layer'],
            title: row.title,
            fix: row.fix,
            status: row.status as Resolution['status'],
            verifyCount: row.verifyCount,
            verifiedAt: row.verifiedAt?.toISOString(),
            sourceGoalId: row.sourceGoalId ?? undefined,
            tags: this.parseTags(row.tags),
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          });
        }
      }

      const promptSnippet = matched.length > 0
        ? matched.map((r, i) =>
            `## 已知解法 #${i + 1}: ${r.title}\n${r.fix}\n(verified ${r.verifyCount}x)`
          ).join('\n\n')
        : '';

      return { matched: matched.length > 0, resolutions: matched, promptSnippet };
    } catch (err) {
      logger.warn('[ResolutionService] match failed', { error: String(err) });
      return { matched: false, resolutions: [], promptSnippet: '' };
    }
  }

  /**
   * 创建 Resolution（Auditor 日审调用）
   */
  async createResolution(input: CreateResolutionInput): Promise<Resolution | null> {
    try {
      // Check for duplicate pattern
      const existing = await prisma.resolution.findFirst({
        where: { pattern: input.pattern },
      });
      if (existing) return null;

      const row = await prisma.resolution.create({
        data: {
          pattern: input.pattern,
          errorClass: input.errorClass,
          layer: input.layer,
          title: input.title,
          fix: input.fix,
          status: 'pending',
          verifyCount: 0,
          sourceGoalId: input.sourceGoalId,
          tags: JSON.stringify(input.tags || []),
        },
      });

      logger.info('[ResolutionService] Created pending resolution', {
        id: row.id,
        title: row.title,
        pattern: row.pattern,
      });

      return {
        id: row.id,
        pattern: row.pattern,
        errorClass: row.errorClass,
        layer: row.layer as Resolution['layer'],
        title: row.title,
        fix: row.fix,
        status: row.status as Resolution['status'],
        verifyCount: row.verifyCount,
        verifiedAt: row.verifiedAt?.toISOString(),
        sourceGoalId: row.sourceGoalId ?? undefined,
        tags: this.parseTags(row.tags),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    } catch (err) {
      logger.warn('[ResolutionService] create failed', { error: String(err) });
      return null;
    }
  }

  /**
   * 验证 Resolution — verifyCount++，累积 3 次 → canonical
   */
  async verifyResolution(id: string): Promise<void> {
    try {
      const row = await prisma.resolution.findUnique({ where: { id } });
      if (!row) return;

      const newCount = row.verifyCount + 1;
      const newStatus = newCount >= 3 ? 'canonical' : (newCount >= 1 ? 'verified' : 'pending');

      await prisma.resolution.update({
        where: { id },
        data: {
          verifyCount: newCount,
          status: newStatus,
          verifiedAt: row.verifiedAt || new Date(),
        },
      });

      logger.info('[ResolutionService] Verified resolution', {
        id,
        verifyCount: newCount,
        status: newStatus,
      });
    } catch (err) {
      logger.warn('[ResolutionService] verify failed', { error: String(err) });
    }
  }

  /**
   * 获取所有 pending 的 Resolution（供人工审核）
   */
  async listPending(): Promise<Resolution[]> {
    try {
      const rows = await prisma.resolution.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });

      return rows.map(row => ({
        id: row.id,
        pattern: row.pattern,
        errorClass: row.errorClass,
        layer: row.layer as Resolution['layer'],
        title: row.title,
        fix: row.fix,
        status: row.status as Resolution['status'],
        verifyCount: row.verifyCount,
        verifiedAt: row.verifiedAt?.toISOString(),
        sourceGoalId: row.sourceGoalId ?? undefined,
        tags: this.parseTags(row.tags),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));
    } catch {
      return [];
    }
  }

  /**
   * 预置已知 Resolution Seed — 服务启动时调用，幂等
   */
  async ensureSeedResolutions(): Promise<void> {
    const seeds: CreateResolutionInput[] = [
      {
        pattern: 'dangerously-skip-permissions.*root|cannot be used with root',
        errorClass: 'permission_error',
        layer: 'L3_tool_behavior',
        title: 'root 用户不能使用 --dangerously-skip-permissions',
        fix: 'CLI flag `--dangerously-skip-permissions` 在 root 下被禁止。改用 settings.json 配置：在工作目录下创建 `.claude/settings.json`，写入 `{"permissions": {"defaultMode": "bypassPermissions"}}`，然后去掉命令中的 `--dangerously-skip-permissions` flag。',
        tags: ['cli', 'root', 'permission', 'claude-code'],
      },
      {
        pattern: 'surgical.*regression|非目标变更|未授权删除|删了不该删|scope.*violation|不该改',
        errorClass: 'scope_violation',
        layer: 'L3_tool_behavior',
        title: 'AC 范围外修改 — 改/删了 AC 未要求的代码导致功能回归',
        fix: '检查 AC 中的 files 列表和 gotchas（红线）。不在 AC 范围内的代码绝对不要碰，尤其是：① shell 重定向参数(2>&1, tee)通常有隐蔽的消费者(audit/log)；② 异常处理代码；③ 未在 AC 中提及的文件。每处改动前问自己：这个改动属于哪个 AC？如果找不到对应的 AC → 不要改。',
        tags: ['pipeline', 'executor', 'surgical', 'scope', 'regression'],
      },
    ];

    for (const seed of seeds) {
      try {
        const existing = await prisma.resolution.findFirst({
          where: { pattern: seed.pattern },
        });
        if (!existing) {
          await prisma.resolution.create({
            data: {
              pattern: seed.pattern,
              errorClass: seed.errorClass,
              layer: seed.layer,
              title: seed.title,
              fix: seed.fix,
              status: 'canonical',
              verifyCount: 3,
              tags: JSON.stringify(seed.tags || []),
              verifiedAt: new Date(),
            },
          });
          logger.info('[ResolutionService] Seeded resolution', { title: seed.title });
        }
      } catch (err) {
        logger.warn('[ResolutionService] Seed failed for pattern', { pattern: seed.pattern, error: String(err) });
      }
    }
  }

  /**
   * B1: 格式化 canonical + verified 的 resolution 为 Executor prompt snippet
   * 主动注入——不只是失败时，每次执行前都提醒已知回归模式
   */
  async formatForPrompt(): Promise<string> {
    try {
      const resolutions = await prisma.resolution.findMany({
        where: { status: { in: ['canonical', 'verified'] } },
        select: { title: true, fix: true, tags: true },
        orderBy: { verifyCount: 'desc' },
        take: 10,
      });
      if (resolutions.length === 0) return '';
      return resolutions.map((r, i) =>
        `### ${i + 1}. ${r.title}\n${r.fix}`
      ).join('\n\n');
    } catch {
      return '';
    }
  }

  private parseTags(tagsJson: string): string[] {
    try { return JSON.parse(tagsJson); } catch { return []; }
  }
}

export const resolutionService = ResolutionService.getInstance();
export const resolutionMatcher = resolutionService; // B1: alias for scheduler import
