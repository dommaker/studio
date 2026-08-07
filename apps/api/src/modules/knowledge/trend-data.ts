/**
 * trend-data — 趋势数据层（~/.studio/data/trends/ 目录写入）。
 *
 * 从 knowledge-service.ts 抽出（工单 29，纯搬运不改逻辑）。
 * 被 knowledgeService.recordTrend/recordAnalystAccuracy、
 * monitorService.precipitateRouting、signalAggregator.upsertTrend 共用。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DATA_TRENDS_DIR = path.join(os.homedir(), '.studio', 'data', 'trends');

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
