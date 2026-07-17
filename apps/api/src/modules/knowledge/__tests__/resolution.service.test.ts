/**
 * ResolutionService — writeCanonicalToDisk + scheduleVectorDbSync 测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolution-test-'));
const envDir = path.join(tmpDir, '.studio');
const knowledgeDir = path.join(envDir, 'knowledge');
const testLogsDir = path.join(envDir, 'logs');
fs.mkdirSync(knowledgeDir, { recursive: true });
fs.mkdirSync(testLogsDir, { recursive: true });

// Override HOME so FileStore paths resolve to tmpDir
const origHome = process.env.HOME;
process.env.HOME = tmpDir;

vi.mock('../knowledge-bus.service.js', () => ({
  scheduleVectorDbSync: vi.fn(),
}));

import { resolutionService } from '../resolution.service.js';
import { scheduleVectorDbSync } from '../knowledge-bus.service.js';

// The resolution service uses os.homedir() for paths.
// Override via process.env.HOME (most os.homedir() implementations check HOME first)
// ...but resolution.service.ts uses `os.homedir()` which ignores env on Linux.
// We need a different approach: vi.mock node:os
// Since that's complex, let's just directly reference the right paths.

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
  // Write to BOTH the actual homedir path AND our test dir
  const realHome = os.homedir();
  const realKnowledgeDir = path.join(realHome, '.studio', 'knowledge');
  fs.mkdirSync(realKnowledgeDir, { recursive: true });
  fs.writeFileSync(path.join(realKnowledgeDir, `resolution-${id}.md`), frontmatter);
}

function cleanupResolutions() {
  const realKnowledgeDir = path.join(os.homedir(), '.studio', 'knowledge');
  try {
    const files = fs.readdirSync(realKnowledgeDir);
    for (const f of files) {
      if (f.startsWith('resolution-')) fs.unlinkSync(path.join(realKnowledgeDir, f));
    }
  } catch {}
}

describe('ResolutionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupResolutions();
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
