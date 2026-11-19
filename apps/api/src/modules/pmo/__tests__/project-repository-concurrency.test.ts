import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const tsxCli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const repositoryModule = path.join(repoRoot, 'apps/api/src/modules/pmo/project-repository.ts');

let studioHome: string;
let previousStudioHome: string | undefined;
let previousDataDir: string | undefined;
let projectRepository: typeof import('../project-repository.js').projectRepository;

beforeAll(async () => {
  previousStudioHome = process.env.STUDIO_HOME;
  previousDataDir = process.env.STUDIO_DATA_DIR;
  studioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-repository-'));
  process.env.STUDIO_HOME = studioHome;
  process.env.STUDIO_DATA_DIR = path.join(studioHome, 'data');
  ({ projectRepository } = await import('../project-repository.js'));
});

afterAll(() => {
  fs.rmSync(studioHome, { recursive: true, force: true });
  if (previousStudioHome === undefined) delete process.env.STUDIO_HOME;
  else process.env.STUDIO_HOME = previousStudioHome;
  if (previousDataDir === undefined) delete process.env.STUDIO_DATA_DIR;
  else process.env.STUDIO_DATA_DIR = previousDataDir;
});

function runWorker(worker: number, operation: string): Promise<Record<string, unknown>> {
  const outputPath = path.join(studioHome, `worker-${worker}.json`);
  const script = `
    void (async () => {
      const imported = await import(${JSON.stringify(repositoryModule)});
      const { projectRepository } = imported.default ?? imported;
      const result = await projectRepository.${operation};
      (await import('node:fs')).writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(result));
    })().catch(error => { console.error(error); process.exit(1); });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, '-e', script], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        STUDIO_HOME: studioHome,
        STUDIO_DATA_DIR: path.join(studioHome, 'data'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) {
        reject(new Error(`PMO worker ${worker} exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(fs.readFileSync(outputPath, 'utf8')));
    });
  });
}

describe('projectRepository 跨进程并发（#702）', () => {
  it('并发创建分配唯一 PMO 编号和 REQ 别名', { timeout: 30_000 }, async () => {
    const created = await Promise.all(Array.from({ length: 6 }, (_, worker) =>
      runWorker(worker, `create({ title: '并发项目 ${worker}' })`)));

    expect(new Set(created.map(project => project.pmoNumber)).size).toBe(created.length);
    expect(new Set(created.map(project => project.reqAlias)).size).toBe(created.length);
    expect(await projectRepository.list({ limit: 20 })).toHaveLength(created.length);
  });

  it('并发更新同一项目的不同字段不互相覆盖', { timeout: 30_000 }, async () => {
    const project = await projectRepository.create({ title: '待并发更新' });
    const updates = [
      `title: '新标题'`,
      `description: '新描述'`,
      `requirement: '新需求'`,
      `priority: 'high'`,
      `progress: 40`,
      `requirementsDocId: 'REQ-DOC-1'`,
    ];

    await Promise.all(updates.map((update, worker) =>
      runWorker(worker, `update(${JSON.stringify(project.id)}, { ${update} })`)));

    expect(await projectRepository.get(project.id)).toMatchObject({
      title: '新标题',
      description: '新描述',
      requirement: '新需求',
      priority: 'high',
      progress: 40,
      requirementsDocId: 'REQ-DOC-1',
    });
  });
});
