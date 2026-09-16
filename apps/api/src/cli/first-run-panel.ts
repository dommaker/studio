/**
 * first-run-panel — studio run web 首启检测块（#571）
 *
 * 冻结内容（docs/architecture/data-directory-contract.md §7）：
 * Node 版本（对 engines >=20）、agent CLI 探测结果（复用 cli-scanner 输出：
 * provider/path/version）、数据根位置、实际监听地址。缺失 CLI 不阻断，
 * 但标注「至少需要一个 agent CLI 才能跑执行」。
 */

import type { DetectedRuntime } from '../daemon/cli-scanner.js';

export interface FirstRunPanelInfo {
  /** process.version（vX.Y.Z） */
  nodeVersion: string;
  /** engines 下限主版本（root package.json engines.node） */
  minNodeMajor: number;
  /** cli-scanner.scanAllProviders() 输出 */
  providers: DetectedRuntime[];
  /** 数据根（studioDir()） */
  dataRoot: string;
  listenHost: string;
  listenPort: number;
  /** 端口顺延前的首选端口；未顺延时为 null */
  shiftedFrom: number | null;
}

export function buildFirstRunPanel(info: FirstRunPanelInfo): string {
  const lines: string[] = [];
  lines.push('Studio — environment check');
  lines.push('──────────────────────────');

  const major = Number(info.nodeVersion.replace(/^v/, '').split('.')[0]);
  const nodeNote = Number.isInteger(major) && major < info.minNodeMajor
    ? `  ⚠️  below engines requirement (>= ${info.minNodeMajor})`
    : '';
  lines.push(`  Node:      ${info.nodeVersion}${nodeNote}`);

  if (info.providers.length > 0) {
    lines.push('  Agent CLIs:');
    for (const p of info.providers) {
      lines.push(`    - ${p.provider}  ${p.path}  ${p.version}`);
    }
  } else {
    lines.push('  Agent CLIs: none detected');
    lines.push('    至少需要一个 agent CLI 才能跑执行（at least one agent CLI is required to run executions）');
  }

  lines.push(`  Data dir:  ${info.dataRoot}`);
  const shiftNote = info.shiftedFrom !== null ? `  (port ${info.shiftedFrom} in use, shifted / 顺延)` : '';
  lines.push(`  Listen:    http://${info.listenHost}:${info.listenPort}${shiftNote}`);
  return lines.join('\n');
}
