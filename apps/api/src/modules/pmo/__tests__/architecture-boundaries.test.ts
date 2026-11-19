/** ARCH-04：项目模型、存储、只读、发布与文档职责必须分居独立模块。 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PMO_DIR = path.resolve(__dirname, '..');

function read(file: string): string {
  return fs.readFileSync(path.join(PMO_DIR, file), 'utf8');
}

describe('ARCH-04 PMO 项目边界', () => {
  it('五个职责模块存在，兼容 facade 不再持有跨域编排或物理存储实现', () => {
    for (const file of ['model.ts', 'project-repository.ts', 'project-read.ts', 'publish-project.ts', 'project-documents.ts']) {
      expect(fs.existsSync(path.join(PMO_DIR, file)), file).toBe(true);
    }
    const facade = read('project.service.ts');
    expect(facade).not.toMatch(/from ['"]\.\.\/(?:channels|workunit)\//);
    expect(facade).not.toMatch(/from ['"]node:fs['"]/);
    expect(facade).not.toMatch(/getStore\(\)|parseFrontmatter/);
  });

  it('只读实现不加载频道或 WorkUnit 链', () => {
    expect(read('project-read.ts')).not.toMatch(/from ['"]\.\.\/(?:channels|workunit)\//);
  });
});
