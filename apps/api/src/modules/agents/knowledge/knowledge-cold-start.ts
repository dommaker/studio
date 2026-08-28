/**
 * Knowledge Agent — 冷启动子模块
 *
 * 从 knowledge-curator.service.ts 拆分（提取/冷启动/分析分离，零行为变更）。
 * P1b: 四源冷启动导入（docs/code/git/manual）+ Discord 通知。
 */

import { logger } from '@dommaker/studio-shared';
import { ColdStartImporter } from '@dommaker/harness';
import { sharedStore } from '../../knowledge/knowledge-singletons.js';
import * as os from 'os';
import * as path from 'path';

/**
 * P1b: Four-source cold start import
 * 1. Docs: memory/*.md + CLAUDE.md + README.md (layer: 'system', types: architecture/process/decision)
 * 2. Code: package.json + tsconfig.json (layer: 'tech', types: model)
 * 3. Git: recent refactor/fix commits (layer: 'project', types: pitfall/guideline)
 * 4. Manual: agent network flow, agent responsibilities (layer: 'system', types: process)
 */
export async function coldStartAll(): Promise<void> {
  const projectRoot = process.env.REPO_DIR || path.join(os.homedir(), 'projects');
  const memoryDir = path.join(os.homedir(), '.claude', 'projects', '-root-projects', 'memory');

  try {
    const fs = await import('fs');
    const memoryFiles = await getMemoryFiles(memoryDir);
    const docPaths = [
      ...memoryFiles,
      path.join(projectRoot, 'CLAUDE.md'),
      path.join(projectRoot, 'README.md'),
    ].filter(p => {
      try { return fs.existsSync(p); } catch { return false; }
    });

    const importer = new ColdStartImporter({
      projectRoot,
      store: sharedStore,
      sources: ['code', 'git', 'docs', 'manual'],
      docPaths,
      manualEntries: [
        {
          title: 'Agent Network Flow',
          content: 'Trigger→Claim→Execute→Review→Deploy→Audit→Monitor',
          type: 'process',
          tags: ['agent-network', 'architecture'],
        },
        {
          title: '8-Agent System',
          content: 'Executor/Review/Knowledge/Monitor/Triage/Auditor/PostEval/Deploy',
          type: 'model',
          tags: ['agents', 'system'],
        },
      ],
      skipExisting: true,
    });

    const results = await importer.importAll();
    const importedCount = results.reduce((sum, r) => sum + r.entries.length, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

    logger.info('[KnowledgeCurator] Cold start import completed', {
      importedCount,
      totalErrors,
      sources: results.map(r => r.source.type),
    });

    // Discord notify
    try {
      const { discordNotifier } = await import('../../../utils/discord-notifier.js');
      await discordNotifier.sendText(
        '📚 冷启动知识导入完成',
        `导入了 ${importedCount} 条知识 (${totalErrors} 个错误)\n来源: ${results.map(r => `${r.source.type}(${r.entries.length})`).join(', ')}`,
      );
    } catch { /* non-blocking */ }
  } catch (err) {
    logger.error('[KnowledgeCurator] Cold start import failed', { error: String(err) });
  }
}

/**
 * 获取 memory 目录下的 markdown 文件列表
 */
async function getMemoryFiles(memoryDir: string): Promise<string[]> {
  try {
    const fs = await import('fs');
    if (!fs.existsSync(memoryDir)) return [];
    return fs.readdirSync(memoryDir)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(memoryDir, f));
  } catch {
    return [];
  }
}
