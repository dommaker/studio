/**
 * runtime-paths.ts 单元测试（#571：KNOWLEDGE_DIR / TUNNEL_URL_FILE 归数据根）。
 *
 * 冻结结论（data-directory-contract.md §8 待归位）：
 * - KNOWLEDGE_DIR 缺省 = studioPath('harness-knowledge')，env 可覆盖；
 * - TUNNEL_URL_FILE 缺省 = studioPath('tunnel-url')（自 ~/.claude/tunnel-url 迁入），env 可覆盖。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

let prevStudioHome: string | undefined;
let prevKnowledgeDir: string | undefined;
let prevTunnelFile: string | undefined;
const TEST_HOME = path.join(__dirname, '.tmp-runtime-paths-home');

beforeEach(() => {
  prevStudioHome = process.env.STUDIO_HOME;
  prevKnowledgeDir = process.env.KNOWLEDGE_DIR;
  prevTunnelFile = process.env.TUNNEL_URL_FILE;
  process.env.STUDIO_HOME = TEST_HOME;
  delete process.env.KNOWLEDGE_DIR;
  delete process.env.TUNNEL_URL_FILE;
});

afterEach(() => {
  if (prevStudioHome === undefined) delete process.env.STUDIO_HOME; else process.env.STUDIO_HOME = prevStudioHome;
  if (prevKnowledgeDir === undefined) delete process.env.KNOWLEDGE_DIR; else process.env.KNOWLEDGE_DIR = prevKnowledgeDir;
  if (prevTunnelFile === undefined) delete process.env.TUNNEL_URL_FILE; else process.env.TUNNEL_URL_FILE = prevTunnelFile;
});

describe('defaultKnowledgeDir', () => {
  it('KNOWLEDGE_DIR 未设 → studioPath(harness-knowledge)', async () => {
    const { defaultKnowledgeDir } = await import('../runtime-paths.js');
    expect(defaultKnowledgeDir()).toBe(path.join(TEST_HOME, 'harness-knowledge'));
  });

  it('KNOWLEDGE_DIR 显式设置 → env 优先', async () => {
    process.env.KNOWLEDGE_DIR = '/custom/knowledge';
    const { defaultKnowledgeDir } = await import('../runtime-paths.js');
    expect(defaultKnowledgeDir()).toBe('/custom/knowledge');
  });
});

describe('tunnelUrlFile', () => {
  it('TUNNEL_URL_FILE 未设 → studioPath(tunnel-url)，不再落 ~/.claude', async () => {
    const { tunnelUrlFile } = await import('../runtime-paths.js');
    const p = tunnelUrlFile();
    expect(p).toBe(path.join(TEST_HOME, 'tunnel-url'));
    expect(p).not.toContain('.claude');
  });

  it('TUNNEL_URL_FILE 显式设置 → env 优先', async () => {
    process.env.TUNNEL_URL_FILE = '/custom/tunnel-url';
    const { tunnelUrlFile } = await import('../runtime-paths.js');
    expect(tunnelUrlFile()).toBe('/custom/tunnel-url');
  });
});
