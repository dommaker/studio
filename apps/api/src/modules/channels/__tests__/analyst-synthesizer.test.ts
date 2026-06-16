/**
 * Analyst Synthesizer — prompt builder tests
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    formatConstraintsForPrompt: (_role: string) => '## Constraints\nMock constraints section',
  };
});

vi.mock('@dommaker/studio-skill', () => ({
  skillLoader: {
    load: () => [],
    formatForPrompt: () => '',
  },
}));

import { buildSynthesizerPrompt } from '../analyst-synthesizer.js';
import type { ScoutScope } from '../analyst-prescan.js';
import type { ScoutReport } from '../analyst-scout.js';

describe('analyst-synthesizer: buildSynthesizerPrompt', () => {
  const scope: ScoutScope = {
    modules: ['channel'],
    keyFiles: ['channel.routes.ts'],
    concerns: ['code', 'knowledge'],
    directoryMap: {},
  };

  const requirement = '添加 channel 消息过滤';
  const outputFile = '.analyst/output-123.json';

  const successReport: ScoutReport = {
    type: 'code',
    success: true,
    content: '{"affectedFiles":["channel.routes.ts"],"functionSignatures":["handleMessage() @ L10"]}',
    durationMs: 5000,
  };

  const failReport: ScoutReport = {
    type: 'knowledge',
    success: false,
    content: '',
    durationMs: 3000,
    error: 'timeout',
  };

  it('includes requirement text in prompt', () => {
    const prompt = buildSynthesizerPrompt(requirement, scope, [successReport], outputFile);
    expect(prompt).toContain(requirement);
  });

  it('includes scout report content', () => {
    const prompt = buildSynthesizerPrompt(requirement, scope, [successReport], outputFile);
    expect(prompt).toContain('handleMessage() @ L10');
    expect(prompt).toContain('channel.routes.ts');
  });

  it('marks failed scouts with error info', () => {
    const prompt = buildSynthesizerPrompt(requirement, scope, [successReport, failReport], outputFile);
    expect(prompt).toContain('FAILED');
    expect(prompt).toContain('timeout');
  });

  it('includes failure note when scouts fail', () => {
    const prompt = buildSynthesizerPrompt(requirement, scope, [successReport, failReport], outputFile);
    expect(prompt).toContain('Scout 失败');
    expect(prompt).toContain('knowledge');
  });

  it('no failure note when all scouts succeed', () => {
    const prompt = buildSynthesizerPrompt(requirement, scope, [successReport], outputFile);
    expect(prompt).not.toContain('Scout 失败');
  });

  it('includes output file path', () => {
    const prompt = buildSynthesizerPrompt(requirement, scope, [successReport], outputFile);
    expect(prompt).toContain(outputFile);
  });

  it('includes RequirementsDoc JSON format specification', () => {
    const prompt = buildSynthesizerPrompt(requirement, scope, [successReport], outputFile);
    expect(prompt).toContain('"requirement"');
    expect(prompt).toContain('"design"');
    expect(prompt).toContain('"task"');
    expect(prompt).toContain('"acGroups"');
  });

  it('includes scope metadata (modules, files, concerns)', () => {
    const prompt = buildSynthesizerPrompt(requirement, scope, [successReport], outputFile);
    expect(prompt).toContain('channel');
    expect(prompt).toContain('channel.routes.ts');
    expect(prompt).toContain('code');
  });

  it('instructs not to re-explore codebase', () => {
    const prompt = buildSynthesizerPrompt(requirement, scope, [successReport], outputFile);
    expect(prompt).toContain('不需要再探索代码库');
  });

  it('includes DONE instruction', () => {
    const prompt = buildSynthesizerPrompt(requirement, scope, [successReport], outputFile);
    expect(prompt).toContain('DONE');
  });
});
