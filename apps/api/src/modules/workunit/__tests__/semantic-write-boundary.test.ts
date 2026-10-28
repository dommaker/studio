import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { findSemanticWriteViolations } from './semantic-write-boundary-scanner.js';

const API_SRC = path.resolve(__dirname, '../../..');

function productionFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : productionFiles(file);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [file] : [];
  });
}

describe('ARCH-03 写口检测夹具', () => {
  it.each([
    ['任意变量', 'store.updateMetadata(id, latest => latest)', 'updateMetadata'],
    ['可选调用', 'store?.updateMetadata?.(id, latest => latest)', 'updateMetadata'],
    ['解构别名', 'const { updateMetadata } = store; updateMetadata(id, latest => latest)', 'updateMetadata'],
    ['赋值别名', 'const write = store.updateMetadata; write(id, latest => latest)', 'updateMetadata'],
    ['解构重命名', 'const { updateMetadata: write } = store; write(id, latest => latest)', 'updateMetadata'],
    ['任意 mutator 变量', 'anything.updateMetadata(id, mutator)', 'updateMetadata'],
    ['断言后的 mutator', 'anything.updateMetadata(id, mutator as Mutator)', 'updateMetadata'],
    ['直接 repository.mutate', 'repository.mutate(id, latest => latest)', 'repository.mutate'],
    ['解构 mutate', 'const { mutate } = repository; mutate(id, latest => latest)', 'repository.mutate'],
    ['解构重命名 mutate', 'const { mutate: write } = repository; write(id, latest => latest)', 'repository.mutate'],
  ] as const)('%s 必须被检测', (_name, source, kind) => {
    expect(findSemanticWriteViolations(source, 'modules/channels/fake.ts')).toEqual([{ kind, line: 1 }]);
  });

  it.each([
    'svc.updateMetadata(id, { priority: "high" })',
    'getWorkUnitService().updateMetadata(id, { resumeAfterRetry: true })',
    'workUnitService.updateMetadata(id, patch)',
    'getWorkUnitService().updateMetadata(id, metadata as WorkUnitMetadata)',
    'const serviceAlias = getWorkUnitService(); serviceAlias.updateMetadata(id, patch)',
    'const { updateMetadata } = getWorkUnitService(); updateMetadata(id, patch)',
  ])('WorkUnitService 语义 patch 不误报：%s', source => {
    expect(findSemanticWriteViolations(source, 'modules/discord/fake.ts')).toEqual([]);
  });

  it.each([
    'execution-journal.ts',
    'derivation-ledger.ts',
    'trace-link.ts',
    'waiting-gate.ts',
  ])('仅语义命令允许 repository.mutate：%s', file => {
    const fileName = `modules/workunit/${file}`;
    expect(findSemanticWriteViolations('this.repository.mutate(id, latest => latest)', fileName)).toEqual([]);
  });
});

describe('ARCH-03 WorkUnit 语义写口边界', () => {
  it('普通生产流程不直接调用物理 updateMetadata 或 repository.mutate', () => {
    const violations = productionFiles(API_SRC).flatMap(file => {
      const relative = path.relative(API_SRC, file).replaceAll('\\', '/');
      return findSemanticWriteViolations(fs.readFileSync(file, 'utf8'), relative)
        .map(violation => `${relative}:${violation.line} ${violation.kind}`);
    });
    expect(violations).toEqual([]);
  });
});
