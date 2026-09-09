// #462：GET /api/v1/skills/manifest 路由测试 —— 角色编辑 UI 的 skill 多选数据源
// 源 = loadManifest()（SKILL.md frontmatter）；loop-consumer（hub 专用，不参与注入）不进候选。
// 风格对齐 retract-decide.test.ts：真 express app + fetch。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// SKILLS_DIR 在 manifest-loader 模块加载时读取 —— 必须先设再 import 路由
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-manifest-route-'));
process.env.SKILLS_DIR = testSkillsDir;
// 显式清理：`import * as fs` 走原生命名空间，mkdtemp-cleanup 补丁登记不到（见其头注）
afterAll(() => { fs.rmSync(testSkillsDir, { recursive: true, force: true }); });

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return { ...orig, logger: mockLogger };
});

function writeSkill(dirName: string, frontmatterLines: string[]) {
  const dir = path.join(testSkillsDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\n${frontmatterLines.join('\n')}\n---\n\n# ${dirName}\n`,
    'utf-8',
  );
}

writeSkill('tdd-implement', [
  'name: tdd-implement',
  'description: "测试先行实现"',
  'agentTypes: [implement]',
  'triggers: [实现, 开发]',
  'status: published',
]);
writeSkill('hub-service', [
  'name: hub-service',
  'description: "hub 专用"',
  'consumers: [loop]',
  'status: published',
]);
writeSkill('draft-skill', [
  'name: draft-skill',
  'description: "草稿"',
  'status: draft',
]);

// 动态 import：保证 process.env.SKILLS_DIR 赋值先于 manifest-loader 模块加载（静态 import 会被 ESM 提升）
const { default: skillsRouter } = await import('../routes.js');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/skills', skillsRouter);
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('GET /api/v1/skills/manifest (#462)', () => {
  it('返回 published 非 loop-consumer 的 name/description/agentTypes/triggers', async () => {
    const res = await fetch(`${baseUrl}/api/v1/skills/manifest`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };

    const names = body.data.map(s => s.name);
    expect(names).toContain('tdd-implement');
    // loop-consumer（hub 专用，不参与注入）与 draft（manifest-loader 已过滤）不进候选
    expect(names).not.toContain('hub-service');
    expect(names).not.toContain('draft-skill');

    const tdd = body.data.find(s => s.name === 'tdd-implement')!;
    expect(tdd.description).toBe('测试先行实现');
    expect(tdd.agentTypes).toEqual(['implement']);
    expect(tdd.triggers).toEqual(['实现', '开发']);
  });

  it('不被 /:id 路由吞掉（manifest 字面量优先于参数路由）', async () => {
    const res = await fetch(`${baseUrl}/api/v1/skills/manifest`);
    const body = await res.json() as Record<string, unknown>;
    // /:id 命中时返回形状是 { data: {...skill} } 或 404；manifest 命中时是 { data: [...] }
    expect(Array.isArray(body.data)).toBe(true);
  });
});
