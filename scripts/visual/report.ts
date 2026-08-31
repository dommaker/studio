// diff 报告纯逻辑（#391）：配对两轮截图、差异率分档、渲染 markdown 摘要
// IO（读 PNG、pixelmatch）在 diff.ts；本文件纯函数可单测

export interface ShotPair {
  name: string;
  missing?: 'a' | 'b';
}

/** 按文件名配对两轮截图清单（排序后稳定输出），缺失侧标 missing */
export function pairShots(filesA: string[], filesB: string[]): ShotPair[] {
  const all = [...new Set([...filesA, ...filesB])].sort();
  return all.map(name => ({
    name,
    missing: !filesA.includes(name) ? 'a' : !filesB.includes(name) ? 'b' : undefined,
  }));
}

export type DiffStatus = 'clean' | 'minor' | 'major' | 'missing-a' | 'missing-b';

/** 差异率分档：0 = clean；<1% = minor（可归因动态组件/抗锯齿级）；>=1% = major（需人工看对比图） */
export function classify(ratio: number): DiffStatus {
  if (ratio === 0) return 'clean';
  if (ratio < 0.01) return 'minor';
  return 'major';
}

export interface DiffEntry {
  file: string;
  page: string;
  width: number;
  diffRatio: number;
  diffPixels: number;
  totalPixels: number;
  status: DiffStatus;
  /** 差异对比图文件名（有像素差异时产出，与 report.md 同目录） */
  diffImage?: string;
}

export interface DiffReport {
  runA: string;
  runB: string;
  generatedAt: string;
  entries: DiffEntry[];
}

export function renderMarkdown(report: DiffReport): string {
  const { runA, runB, generatedAt, entries } = report;
  const counts = { clean: 0, minor: 0, major: 0, missing: 0 };
  for (const e of entries) {
    if (e.status.startsWith('missing')) counts.missing++;
    else counts[e.status as 'clean' | 'minor' | 'major']++;
  }

  const lines: string[] = [
    '# 截图 diff 报告',
    '',
    `- 比对：\`${runA}\` vs \`${runB}\``,
    `- 生成时间：${generatedAt}`,
    `- 总计：${entries.length} 张 —— clean ${counts.clean} / minor ${counts.minor} / major ${counts.major} / missing ${counts.missing}`,
    '',
    '| 页面 | 宽度 | 差异率 | 像素数 | 状态 |',
    '|------|------|--------|--------|------|',
  ];
  for (const e of entries) {
    lines.push(`| ${e.page} | ${e.width} | ${(e.diffRatio * 100).toFixed(2)}% | ${e.diffPixels} | ${e.status} |`);
  }

  const withImage = entries.filter(e => e.diffImage);
  if (withImage.length > 0) {
    lines.push('', '## 差异页对比图');
    for (const e of withImage) {
      lines.push('', `### ${e.file}（${(e.diffRatio * 100).toFixed(2)}%）`, '', `![${e.file.replace('.png', '')}](${e.diffImage})`);
    }
  }
  return lines.join('\n') + '\n';
}
