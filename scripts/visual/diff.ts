// 截图 diff CLI（#391）：pixelmatch 逐像素比对两轮 run，产 markdown 报告 + 差异页对比图
// 用法：npx tsx scripts/visual/diff.ts <runA> <runB> [--out <报告目录>]
//   runA/runB：RUNS_DIR 下的 run 名，或绝对/相对路径
//   默认报告目录：docs/visual-reports/<YYYYMMDD>-<runA>-vs-<runB>/（入 git 作验收凭据）
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { pathToFileURL } from 'node:url';
import { RUNS_DIR, REPORTS_DIR } from './config';
import { pairShots, classify, renderMarkdown, type DiffEntry, type DiffReport } from './report';

function resolveRunDir(nameOrPath: string): string {
  const asPath = resolve(nameOrPath);
  if (existsSync(asPath)) return asPath;
  const underRuns = resolve(RUNS_DIR, nameOrPath);
  if (existsSync(underRuns)) return underRuns;
  throw new Error(`run 不存在：${nameOrPath}（试过 ${asPath} 与 ${underRuns}）`);
}

function listPngs(dir: string): string[] {
  return readdirSync(dir).filter(f => f.endsWith('.png') && !f.endsWith('.diff.png'));
}

/** 从 <page>-<width>.png 拆出页面名与宽度 */
export function parseShotName(name: string): { page: string; width: number } {
  const m = /^(.*)-(\d+)\.png$/.exec(name);
  if (!m) throw new Error(`截图文件名不符 <page>-<width>.png：${name}`);
  return { page: m[1], width: Number(m[2]) };
}

function diffOne(dirA: string, dirB: string, name: string, outDir: string): DiffEntry {
  const { page, width } = parseShotName(name);
  const imgA = PNG.sync.read(readFileSync(join(dirA, name)));
  const imgB = PNG.sync.read(readFileSync(join(dirB, name)));

  // 尺寸不一致 = 布局级变化，无法逐像素比对：直接判 major 全量差异，不出对比图
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    return {
      file: name, page, width,
      diffRatio: 1, diffPixels: -1, totalPixels: imgA.width * imgA.height,
      status: 'major',
    };
  }

  const totalPixels = imgA.width * imgA.height;
  const diff = new PNG({ width: imgA.width, height: imgA.height });
  const diffPixels = pixelmatch(imgA.data, imgB.data, diff.data, imgA.width, imgA.height, { threshold: 0.1 });
  const diffRatio = diffPixels / totalPixels;
  const entry: DiffEntry = { file: name, page, width, diffRatio, diffPixels, totalPixels, status: classify(diffRatio) };
  if (diffPixels > 0) {
    const diffImage = name.replace('.png', '.diff.png');
    writeFileSync(join(outDir, diffImage), PNG.sync.write(diff));
    entry.diffImage = diffImage;
  }
  return entry;
}

function main(): void {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const [runA, runB] = args.filter((_, i) => i !== outIdx && i !== outIdx + 1);
  if (!runA || !runB) {
    console.error('用法：npx tsx scripts/visual/diff.ts <runA> <runB> [--out <报告目录>]');
    process.exit(1);
  }

  const dirA = resolveRunDir(runA);
  const dirB = resolveRunDir(runB);
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const outDir = outIdx >= 0 ? resolve(args[outIdx + 1]) : resolve(REPORTS_DIR, `${date}-${runA}-vs-${runB}`);
  mkdirSync(outDir, { recursive: true });

  const entries: DiffEntry[] = [];
  for (const pair of pairShots(listPngs(dirA), listPngs(dirB))) {
    if (pair.missing) {
      const { page, width } = parseShotName(pair.name);
      entries.push({
        file: pair.name, page, width,
        diffRatio: 0, diffPixels: 0, totalPixels: 0,
        status: pair.missing === 'a' ? 'missing-a' : 'missing-b',
      });
      continue;
    }
    entries.push(diffOne(dirA, dirB, pair.name, outDir));
  }

  const report: DiffReport = {
    runA, runB,
    generatedAt: new Date().toISOString(),
    entries,
  };
  writeFileSync(join(outDir, 'report.md'), renderMarkdown(report));

  const summary = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`报告：${join(outDir, 'report.md')}`);
  console.log(`结果：${JSON.stringify(summary)}`);
}

if (!!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
