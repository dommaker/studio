/**
 * ARCH-04：Requirements 只经 ProjectReadPort 读取 PMO。
 * 静态、type-only、动态 import 都算出边；不得重新引入 PMO barrel/service。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REQUIREMENTS_DIR = path.resolve(__dirname, '..');
const PMO_EDGE_RE = /(?:from|import\()\s*['"]\.\.\/pmo\//;

function productionFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : productionFiles(file);
    return /\.ts$/.test(entry.name) ? [file] : [];
  });
}

describe('ARCH-04 Requirements 依赖方向', () => {
  it('生产代码没有指向 PMO 的静态、类型或动态 import', () => {
    const violations = productionFiles(REQUIREMENTS_DIR).flatMap(file => {
      const content = fs.readFileSync(file, 'utf8');
      return PMO_EDGE_RE.test(content) ? [path.relative(REQUIREMENTS_DIR, file)] : [];
    });
    expect(violations).toEqual([]);
  });
});
