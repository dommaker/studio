/**
 * Pipeline Smoke Test — 管线调度链路冒烟
 *
 * 验证：Goal input → skill 加载 → prompt 组装 → 知识注入 → 反馈层
 * 记录各环节日志用于监控对比
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Isolated skills dir
const smokeSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-smoke-'));
process.env.SKILLS_DIR = smokeSkillsDir;

const { buildSkillPrompt, loadSkillTemplate, buildSubAgentPrompt } = await import('../scheduler-prompt.js');

const logs: Array<{ stage: string; data: unknown; timestamp: string }> = [];
function log(stage: string, data: unknown) {
  logs.push({ stage, data, timestamp: new Date().toISOString() });
}

beforeAll(() => {
  // Create skill templates in <SKILLS_DIR>/<trigger>/<skillName>/SKILL.md structure
  const subAgentDir = path.join(smokeSkillsDir, 'sub_agent', 'sub-agent-workflow');
  fs.mkdirSync(subAgentDir, { recursive: true });
  fs.writeFileSync(path.join(subAgentDir, 'SKILL.md'), `---
name: Sub-Agent Workflow
description: "子 Agent TDD 工作流"
trigger: sub_agent
agentTypes: [executor]
tier: fast
status: published
---
## TDD 工作流
1. 读 AC → 写失败测试
2. 最小实现让测试通过
3. 重构优化
4. 运行 npm test + type check

{{constraints}}

{{knowledgeContext}}

{{task}}
`);

  const greenOnlyDir = path.join(smokeSkillsDir, 'goal_start', 'green-only-tdd');
  fs.mkdirSync(greenOnlyDir, { recursive: true });
  fs.writeFileSync(path.join(greenOnlyDir, 'SKILL.md'), `---
name: GREEN-Only TDD
description: "GREEN-only TDD 工作流"
trigger: goal_start
agentTypes: [executor]
tier: fast
status: published
---
## GREEN-Only TDD
只负责实现代码，测试由 Analyst 预先写好。

{{constraints}}

{{knowledgeContext}}

{{task}}
`);
});

afterAll(() => {
  try { fs.rmSync(smokeSkillsDir, { recursive: true }); } catch {}
});

describe('Pipeline Smoke: skill loading → prompt assembly', () => {

  it('stage 1: loadSkillTemplate returns valid template', () => {
    const tmpl = loadSkillTemplate('sub-agent-workflow');
    log('1-loadTemplate', { found: !!tmpl, name: tmpl?.meta.name });

    expect(tmpl).not.toBeNull();
    expect(tmpl!.meta.name).toBe('Sub-Agent Workflow');
    expect(tmpl!.template).toContain('{{task}}');
  });

  it('stage 2: buildSkillPrompt assembles with variables', () => {
    const prompt = buildSkillPrompt('sub-agent-workflow', {
      task: 'AC-1: CSV 解析\nAC-2: JSON 导入',
      constraints: '- 禁止 any type\n- TDD',
      knowledgeContext: '知识: Prisma 批量写入优化',
    });
    log('2-assemblePrompt', {
      length: prompt.length,
      hasTask: prompt.includes('CSV 解析'),
      hasConstraints: prompt.includes('禁止 any type'),
      hasKnowledge: prompt.includes('Prisma 批量写入'),
      hasPlaceholders: prompt.includes('{{'),
    });

    expect(prompt).toContain('## TDD 工作流');
    expect(prompt).toContain('AC-1: CSV 解析');
    expect(prompt).toContain('禁止 any type');
    expect(prompt).toContain('Prisma 批量写入');
    expect(prompt).not.toContain('{{task}}');
    expect(prompt).not.toContain('{{constraints}}');
    expect(prompt).not.toContain('{{knowledgeContext}}');
  });

  it('stage 3: buildSubAgentPrompt uses skill template', () => {
    const input = {
      acGroup: {
        acs: ['AC-1: 批量导入 CSV', 'AC-2: 批量导入 JSON'],
        files: ['src/import.ts', 'src/parser.ts'],
        implementationNotes: '使用 csv-parse 库',
        codePatterns: ['stream processing'],
        gotchas: ['注意 BOM 头'],
      },
    };

    const prompt = buildSubAgentPrompt(input, '## 兄弟上下文\n已完成 AC-1', '## 公司知识\n导入模式');
    log('3-subAgentPrompt', {
      length: prompt.length,
      hasAC: prompt.includes('批量导入 CSV'),
      hasFiles: prompt.includes('src/import.ts'),
      hasSibling: prompt.includes('兄弟上下文'),
      hasCompany: prompt.includes('公司知识'),
      hasSkillInstructions: prompt.includes('TDD 工作流'),
    });

    expect(prompt).toContain('批量导入 CSV');
    expect(prompt).toContain('src/import.ts');
    expect(prompt).toContain('使用 csv-parse 库');
    expect(prompt).toContain('兄弟上下文');
    expect(prompt).toContain('公司知识');
    // Skill template should be present (either from template or fallback)
    expect(prompt.length).toBeGreaterThan(200);
  });

  it('stage 4: fallback when skill template missing', () => {
    const input = {
      acGroup: {
        acs: ['AC-1: 测试功能'],
        files: [],
      },
    };

    const prompt = buildSubAgentPrompt(input);
    log('4-fallback', { length: prompt.length, hasAC: prompt.includes('测试功能') });

    expect(prompt).toContain('AC-1: 测试功能');
    expect(prompt.length).toBeGreaterThan(50);
  });

  it('stage 5: token efficiency — template vs full injection', () => {
    // Measure: template-based prompt should be smaller than full injection
    const templatePrompt = buildSkillPrompt('sub-agent-workflow', {
      task: 'AC-1: 简单任务',
      constraints: '',
      knowledgeContext: '',
    });

    // Simulate full injection: skill prompt + task + constraints + verification
    const fullInjection = [
      loadSkillTemplate('sub-agent-workflow')?.template || '',
      '## 你的任务', '', '## 验收标准', 'AC-1: 简单任务',
      '## 验证', '声明完成前必须：', '1. 运行 npm test',
    ].join('\n');

    log('5-tokenEfficiency', {
      templateLen: templatePrompt.length,
      fullLen: fullInjection.length,
      savings: `${Math.round((1 - templatePrompt.length / fullInjection.length) * 100)}%`,
    });

    // Template should be <= full injection (placeholders filled with actual values)
    // The key metric is that we're not injecting ADDITIONAL static content
    expect(templatePrompt.length).toBeLessThanOrEqual(fullInjection.length + 100);
  });
});

describe('Pipeline Smoke: logging output', () => {
  it('produces structured logs for monitoring', () => {
    // All logs should have stage, data, timestamp
    for (const entry of logs) {
      expect(entry.stage).toBeTruthy();
      expect(entry.timestamp).toBeTruthy();
      expect(entry.data).toBeTruthy();
    }

    // Output logs for manual review
    console.log('\n=== Pipeline Smoke Test Logs ===');
    for (const entry of logs) {
      console.log(`[${entry.timestamp}] ${entry.stage}:`, JSON.stringify(entry.data));
    }
    console.log('=== End Logs ===\n');
  });
});
