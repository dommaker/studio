/**
 * Knowledge Evolution Scheduler
 *
 * 定时执行知识进化任务：
 * - 每天执行 decay check（归档过期文档）
 * - 每周执行 meso evolution（项目级模式识别）
 */

import { logger } from '@dommaker/studio-shared';
import { knowledgeEvolution } from './evolution.service.js';
import { prisma } from '@dommaker/studio-prisma';

const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000;    // 24 小时
const MESO_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 天
const PATTERN_INTERVAL_MS = 24 * 60 * 60 * 1000;   // 每天模式挖掘

let decayTimer: NodeJS.Timeout | null = null;
let mesoTimer: NodeJS.Timeout | null = null;
let patternTimer: NodeJS.Timeout | null = null;
let evalCleanTimer: NodeJS.Timeout | null = null;

/**
 * 启动知识进化定时任务
 */
export function startEvolutionScheduler(): void {
  // 每天执行 decay check
  decayTimer = setInterval(async () => {
    try {
      const results = await knowledgeEvolution.decayCheck();
      if (results.length > 0) {
        logger.info({ archived: results.length }, 'Knowledge decay check completed');
      }
    } catch (error) {
      logger.error({ error: String(error) }, 'Knowledge decay check failed');
    }
  }, DECAY_INTERVAL_MS);

  // 每周执行 meso evolution（对所有活跃项目）
  mesoTimer = setInterval(async () => {
    try {
      const projects = await prisma.project.findMany({
        where: { status: 'active' },
        select: { id: true },
        take: 20,
      });

      let totalPatterns = 0;
      for (const project of projects) {
        const results = await knowledgeEvolution.mesoEvolution(project.id);
        totalPatterns += results.length;
      }

      if (totalPatterns > 0) {
        logger.info({ projects: projects.length, patterns: totalPatterns }, 'Meso evolution completed');
      }
    } catch (error) {
      logger.error({ error: String(error) }, 'Meso evolution failed');
    }
  }, MESO_INTERVAL_MS);

  // G-005: 每天执行交互模式挖掘
  patternTimer = setInterval(async () => {
    try {
      const { patternMiner } = await import('./pattern-miner.js');
      const count = await patternMiner.analyzeDaily();
      if (count > 0) {
        logger.info({ patterns: count }, 'Interaction pattern mining completed');
      }
    } catch (error) {
      logger.error({ error: String(error) }, 'Pattern mining failed');
    }
  }, PATTERN_INTERVAL_MS);

  // Better-Harness: 每天 eval spring cleaning（标记饱和 eval cases）
  evalCleanTimer = setInterval(async () => {
    try {
      const { evalCaseGenerator } = await import('./eval-case-generator.js');
      const marked = await evalCaseGenerator.markSaturatedEvals();
      if (marked > 0) {
        logger.info({ marked }, 'Eval spring cleaning completed');
      }
    } catch (error) {
      logger.error({ error: String(error) }, 'Eval spring cleaning failed');
    }
  }, DECAY_INTERVAL_MS);

  logger.info('Knowledge evolution scheduler started (decay: 24h, meso: 7d, pattern: 24h, eval_clean: 24h)');
}

/**
 * 停止知识进化定时任务
 */
export function stopEvolutionScheduler(): void {
  if (decayTimer) {
    clearInterval(decayTimer);
    decayTimer = null;
  }
  if (mesoTimer) {
    clearInterval(mesoTimer);
    mesoTimer = null;
  }
  if (patternTimer) {
    clearInterval(patternTimer);
    patternTimer = null;
  }
  if (evalCleanTimer) {
    clearInterval(evalCleanTimer);
    evalCleanTimer = null;
  }
  logger.info('Knowledge evolution scheduler stopped');
}
