/**
 * ResolutionService — writeCanonicalToDisk + scheduleVectorDbSync 测试
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// resolution.service.ts 在模块加载时就以 os.homedir() 固化 KNOWLEDGE_DIR，
// 而 ESM import 先于模块体执行 —— 靠 `process.env.HOME = tmpDir` 改向既依赖
// import 顺序，又依赖 worker 形态（threads 池下 process.env 修改不会同步到
// libuv getenv，forks 池下则会），在根 workspace（forks）下会出现「写入 tmp、
// 读取真实 home」的路径分裂。这里直接 mock os.homedir()，让 import 时与调用时
// 解析到同一个 tmp 目录，任何 pool 下行为一致。
const { tmpDir } = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolution-test-'));
  fs.mkdirSync(path.join(tmpDir, '.studio', 'knowledge'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.studio', 'logs'), { recursive: true });
  return { tmpDir };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => tmpDir;
  return {
    ...actual,
    homedir,
    default: { ...(actual as any).default ?? actual, homedir },
  };
});

vi.mock('../knowledge-bus.service.js', () => ({
  scheduleVectorDbSync: vi.fn(),
}));

import { resolutionService } from '../resolution.service.js';
import { scheduleVectorDbSync } from '../knowledge-bus.service.js';

// os.homedir() 已被 mock 指向 tmpDir —— resolution.service 的 KNOWLEDGE_DIR
// 与本测试的写入/清理路径都落在 tmpDir/.studio/knowledge，不触碰真实 ~/.studio。

async function writeTestResolution(overrides: {
  id?: string; pattern?: string; errorClass?: string; layer?: string;
  title?: string; fix?: string; status?: string; verifyCount?: number;
  tags?: string[];
} = {}) {
  const id = overrides.id || `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const tags = overrides.tags || ['test'];
  const frontmatter = [
    '---',
    'type: resolution',
    `pattern: "${overrides.pattern || 'test.*error'}"`,
    `errorClass: "${overrides.errorClass || 'test_error'}"`,
    `layer: "${overrides.layer || 'L3_tool_behavior'}"`,
    `title: "${overrides.title || 'Test Resolution'}"`,
    `maturity: "${overrides.status || 'canonical'}"`,
    `verifyCount: ${overrides.verifyCount ?? 3}`,
    `tags: [${tags.map(t => `"${t}"`).join(', ')}]`,
    '---',
    '',
    `# ${overrides.title || 'Test Resolution'}`,
    '',
    '## Solution',
    '',
    overrides.fix || 'Fix the test error by doing X',
  ].join('\n');
  const knowledgeDir = path.join(os.homedir(), '.studio', 'knowledge');
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(path.join(knowledgeDir, `resolution-${id}.md`), frontmatter);
}

function cleanupResolutions() {
  const knowledgeDir = path.join(os.homedir(), '.studio', 'knowledge');
  try {
    const files = fs.readdirSync(knowledgeDir);
    for (const f of files) {
      if (f.startsWith('resolution-')) fs.unlinkSync(path.join(knowledgeDir, f));
    }
  } catch {}
}

describe('ResolutionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupResolutions();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('writeCanonicalToDisk', () => {
    it('should complete without throwing', async () => {
      await writeTestResolution({ status: 'canonical', verifyCount: 3 });
      await expect(resolutionService.writeCanonicalToDisk()).resolves.not.toThrow();
    });

    it('should handle empty canonical set gracefully', async () => {
      await expect(resolutionService.writeCanonicalToDisk()).resolves.not.toThrow();
    });
  });

  describe('verifyResolution triggers scheduleVectorDbSync', () => {
    it('should call scheduleVectorDbSync when resolution becomes canonical', async () => {
      const id = `test-verify-${Date.now()}`;
      await writeTestResolution({ id, status: 'verified', verifyCount: 2 });
      await resolutionService.verifyResolution(id);
      expect(scheduleVectorDbSync).toHaveBeenCalled();
    });

    it('should NOT call scheduleVectorDbSync when resolution stays verified', async () => {
      const id = `test-no-sync-${Date.now()}`;
      await writeTestResolution({ id, status: 'pending', verifyCount: 0 });
      await resolutionService.verifyResolution(id);
      expect(scheduleVectorDbSync).not.toHaveBeenCalled();
    });
  });
});
