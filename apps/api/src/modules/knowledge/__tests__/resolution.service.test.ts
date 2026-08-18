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
const { tmpDir, setupStudioHome } = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolution-test-'));
  fs.mkdirSync(path.join(tmpDir, '.studio', 'knowledge'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.studio', 'logs'), { recursive: true });
  // #219：setup 把 STUDIO_HOME 钉到进程级隔离根，studioPath() 优先读它、
  // 旁路下面的 os.homedir() mock。在模块 import 前把 STUDIO_HOME 指到本测试
  // 的 tmp home，让 import 期冻结的 KNOWLEDGE_DIR 与写入/断言路径一致。
  const setupStudioHome = process.env.STUDIO_HOME;
  process.env.STUDIO_HOME = path.join(tmpDir, '.studio');
  return { tmpDir, setupStudioHome };
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

// os.homedir() 已被 mock 指向 tmpDir，STUDIO_HOME 也在 hoisted 块钉到 tmpDir/.studio
// —— resolution.service 的 KNOWLEDGE_DIR 与本测试的写入/清理路径都落在
// tmpDir/.studio/knowledge，不触碰真实 ~/.studio。

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
    // 恢复 setup 的隔离根，避免泄漏到同 worker 的后继测试文件
    if (setupStudioHome === undefined) delete process.env.STUDIO_HOME;
    else process.env.STUDIO_HOME = setupStudioHome;
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

  describe('R3: listByMaturity / listPending 口径', () => {
    it('listByMaturity([pending, canonical]) 返回两档，listPending 仍只回 pending', async () => {
      await writeTestResolution({ id: `t-pending-${Date.now()}`, status: 'pending', verifyCount: 0, title: 'Pending One' });
      await writeTestResolution({ id: `t-canonical-${Date.now()}`, status: 'canonical', verifyCount: 3, title: 'Canonical One' });
      await writeTestResolution({ id: `t-verified-${Date.now()}`, status: 'verified', verifyCount: 1, title: 'Verified One' });

      const browse = await resolutionService.listByMaturity(['pending', 'canonical']);
      const statuses = browse.map(r => r.status).sort();
      expect(statuses).toEqual(['canonical', 'pending']);

      const pendingOnly = await resolutionService.listPending();
      expect(pendingOnly.map(r => r.status)).toEqual(['pending']);
    });

    it('scan 不依赖 _index.md：索引缺失/滞后也能看到存量（生产 UI 显示 0 的根因）', async () => {
      await writeTestResolution({ id: `t-idx-${Date.now()}`, status: 'canonical', title: 'Indexed Blind' });
      // 写一个不含任何 resolution 条目的 stale _index.md（生产形状）
      const knowledgeDir = path.join(os.homedir(), '.studio', 'knowledge');
      const indexPath = path.join(knowledgeDir, '_index.md');
      fs.writeFileSync(indexPath, '# Directory Index\n# Total: 0 entries\n#\n# filename|id|type|title|maturity|tags\n');
      try {
        const browse = await resolutionService.listByMaturity(['pending', 'canonical']);
        expect(browse.map(r => r.title)).toContain('Indexed Blind');
      } finally {
        fs.rmSync(indexPath, { force: true });
      }
    });
  });

  describe('R5: ensureSeedResolutions 启动幂等（title+内容 hash 判重）', () => {
    function countSeedFiles(): number {
      const knowledgeDir = path.join(os.homedir(), '.studio', 'knowledge');
      return fs.readdirSync(knowledgeDir).filter(f => f.startsWith('resolution-') && f.endsWith('.md')).length;
    }

    it('首次写 2 条 seed；再次运行一条不写', async () => {
      await resolutionService.ensureSeedResolutions();
      expect(countSeedFiles()).toBe(2);

      await resolutionService.ensureSeedResolutions();
      expect(countSeedFiles()).toBe(2);
    });

    it('stale _index.md 遮蔽存量时仍不重复写（生产 730 条事故形状）', async () => {
      await resolutionService.ensureSeedResolutions();
      expect(countSeedFiles()).toBe(2);

      // _index.md 不含 resolution 条目（生产事故根因：listDocs 读索引 → 扫描失明）
      const knowledgeDir = path.join(os.homedir(), '.studio', 'knowledge');
      const indexPath = path.join(knowledgeDir, '_index.md');
      fs.writeFileSync(indexPath, '# Directory Index\n# Total: 0 entries\n#\n# filename|id|type|title|maturity|tags\n');
      try {
        await resolutionService.ensureSeedResolutions();
        expect(countSeedFiles()).toBe(2);
      } finally {
        fs.rmSync(indexPath, { force: true });
      }
    });
  });
});
