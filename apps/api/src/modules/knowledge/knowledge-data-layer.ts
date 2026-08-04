/**
 * knowledge-data-layer — KnowledgeService 的数据层（文件系统存取）
 *
 * 自 knowledge-service.ts 整块抽出（纯代码移动）：data/trends/ 趋势写入、
 * resolution 影子库 FileStore helpers、共享 FileStore 实例与
 * studio-events.jsonl 路径常量。
 * knowledge-service.ts 以 re-export 保持 writeTrendData 导出面不变。
 */

import { FileStore } from '@dommaker/studio-shared';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Data layer: trends directory ──

const DATA_TRENDS_DIR = path.join(os.homedir(), '.studio', 'data', 'trends');
const STUDIO_EVENTS_JSONL = resolveStudioLogFile('studio-events.jsonl');
const fileStore = new FileStore();

/**
 * 写入趋势数据到 data/trends/ 目录。
 * 替代原 recordTrend 写入 knowledge/ 的行为。
 * 被 knowledgeService.recordTrend/recordAnalystAccuracy、
 * monitorService.precipitateRouting、signalAggregator.upsertTrend 共用。
 */
export function writeTrendData(filename: string, content: string): void {
  fs.mkdirSync(DATA_TRENDS_DIR, { recursive: true });
  const filePath = path.join(DATA_TRENDS_DIR, filename);
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    fs.writeFileSync(filePath, existing + '\n\n---\n\n' + content, 'utf-8');
  } else {
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

// ── Resolution FileStore helpers ──
// 注意：~/.studio/data/resolutions 为影子库（legacy）。R3 起 createResolution 改写
// resolutionService 主存储（~/.studio/knowledge/resolution-*.md）；
// matchResolutions/verifyResolution 仍读影子库，存量数据合并由 γ 轨道清洗脚本完成。

const RESOLUTIONS_DIR = path.join(os.homedir(), '.studio', 'data', 'resolutions');

async function listResolutions(): Promise<any[]> {
  try {
    const entries = await fs.promises.readdir(RESOLUTIONS_DIR, { withFileTypes: true });
    const files = entries.filter(e => e.isFile() && e.name.endsWith('.json'));
    const results: any[] = [];
    for (const f of files) {
      const data = await fileStore.readJson<any>(path.join(RESOLUTIONS_DIR, f.name));
      if (data) results.push(data);
    }
    return results;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export { STUDIO_EVENTS_JSONL, fileStore, RESOLUTIONS_DIR, listResolutions };
