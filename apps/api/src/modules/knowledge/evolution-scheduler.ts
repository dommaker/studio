/**
 * Knowledge Evolution Scheduler
 *
 * 定时执行知识进化任务：
 * - 每天执行 decay check（归档过期文档）
 * - 每周执行 meso evolution（项目级模式识别）
 */

import { FileStore, logger } from '@dommaker/studio-shared';
import { knowledgeEvolution } from './evolution.service.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { studioPath } from '@dommaker/studio-shared/studio-dir';

const fileStore = new FileStore();

const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000;    // 24 小时
const MESO_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 天
const PATTERN_INTERVAL_MS = 24 * 60 * 60 * 1000;   // 每天模式挖掘

let decayTimer: NodeJS.Timeout | null = null;
let mesoTimer: NodeJS.Timeout | null = null;
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
  // 每天执行 decay check
  decayTimer = setInterval(async () => {
    try {
      const results = await knowledgeEvolution.decayCheck();
      if (results.length > 0) {
        logger.info('Knowledge decay check completed', { archived: results.length });
      }
    } catch (error) {
      logger.error('Knowledge decay check failed', { error: String(error) });
    }
  }, DECAY_INTERVAL_MS);

  // 每周执行 meso evolution（对所有活跃项目）
  mesoTimer = setInterval(async () => {
    try {
      const projectsDir = studioPath('projects');
      let activeProjects: { id: string }[] = [];
      try {
        const entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isFile() || !e.name.endsWith('.json')) continue;
          const data = await fileStore.readJson<any>(path.join(projectsDir, e.name));
          if (data && data.status === 'active') activeProjects.push({ id: data.id });
        }
      } catch { /* no projects dir */ }
      const projects = activeProjects.slice(0, 20);

      let totalPatterns = 0;
      for (const project of projects) {
        const results = await knowledgeEvolution.mesoEvolution(project.id);
        totalPatterns += results.length;
      }

      if (totalPatterns > 0) {
        logger.info('Meso evolution completed', { projects: projects.length, patterns: totalPatterns });
      }
    } catch (error) {
      logger.error('Meso evolution failed', { error: String(error) });
    }
  }, MESO_INTERVAL_MS);

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
