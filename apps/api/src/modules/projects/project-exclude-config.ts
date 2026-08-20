/**
 * #266（决策 #258）：归属问答候选集排除清单 —— ~/.studio 数据区配置文件读写
 *
 * 持久化 <STUDIO_HOME>/projects-exclude.json（studioPath 拼接，禁止硬编码 home）。
 * 读写形态仿 outbound-notify 的 notify-config：load 失败（不存在/非法 JSON/形状不符）
 * 记日志降级为空清单；写前 mkdir -p。
 * env STUDIO_PROJECTS_EXCLUDE 保留为部署级覆盖（在 ProjectDiscoveryService 层优先于本文件）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';

export function projectExcludeConfigPath(): string {
  return studioPath('projects-exclude.json');
}

/** 读排除清单：文件不存在/损坏/形状不符 → 记日志降级为空（候选集不受损） */
export function loadProjectExcludeConfig(): string[] {
  try {
    const file = projectExcludeConfigPath();
    if (!fs.existsSync(file)) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const exclude = (parsed as { exclude?: unknown })?.exclude;
    if (!Array.isArray(exclude)) return [];
    return exclude.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  } catch (error) {
    logger.error('[Projects] Failed to load exclude config (fallback to empty)', { error: String(error) });
    return [];
  }
}

/** 写排除清单（全量替换；写前 mkdir -p） */
export function saveProjectExcludeConfig(exclude: string[]): void {
  const file = projectExcludeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ exclude }, null, 2), 'utf-8');
}
