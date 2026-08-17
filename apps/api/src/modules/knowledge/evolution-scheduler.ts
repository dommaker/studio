/**
 * Knowledge Evolution Scheduler
 *
 * 定时执行的周期任务：
 * - 每天交互模式挖掘（G-005，启动时立即执行一次）
 * - 每天 eval spring cleaning（Better-Harness，标记饱和 eval cases）
 *
 * #149（2026-08-15）：document-store 退役，原 decay check（归档过期文档）与
 * meso evolution（项目级模式识别）两个定时任务随知识进化引擎一并摘除——
 * 两者的读写目标只有 ~/.studio/data/documents。
 */

import { logger } from '@dommaker/studio-shared';

const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000;    // 24 小时
const PATTERN_INTERVAL_MS = 24 * 60 * 60 * 1000;   // 每天模式挖掘

let patternTimer: NodeJS.Timeout | null = null;
let evalCleanTimer: NodeJS.Timeout | null = null;

async function runPatternMining(): Promise<void> {
  try {
    const { patternMiner } = await import('./pattern-miner.js');
    const count = await patternMiner.analyzeDaily();
    if (count > 0) {
      logger.info('Interaction pattern mining completed', { patterns: count });
      const suggested = await patternMiner.suggestSkillsFromPatterns();
      if (suggested > 0) {
        logger.info('Skill proposals from patterns', { suggested });
      }
    }
  } catch (error) {
    logger.error('Pattern mining failed', { error: String(error) });
  }
}

/**
 * 启动知识进化定时任务
 */
export function startEvolutionScheduler(): void {
  // G-005: 每天执行交互模式挖掘 + 启动时立即执行一次
  runPatternMining();
  patternTimer = setInterval(() => runPatternMining(), PATTERN_INTERVAL_MS);

  // Better-Harness: 每天 eval spring cleaning（标记饱和 eval cases）
  evalCleanTimer = setInterval(async () => {
    try {
      const { evalCaseGenerator } = await import('./eval-case-generator.js');
      const marked = await evalCaseGenerator.markSaturatedEvals();
      if (marked > 0) {
        logger.info('Eval spring cleaning completed', { marked });
      }
    } catch (error) {
      logger.error('Eval spring cleaning failed', { error: String(error) });
    }
  }, DECAY_INTERVAL_MS);

  logger.info('Knowledge evolution scheduler started (pattern: 24h, eval_clean: 24h)');
}

/**
 * 停止知识进化定时任务
 */
export function stopEvolutionScheduler(): void {
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
