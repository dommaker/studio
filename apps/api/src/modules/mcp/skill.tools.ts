/**
 * MCP Tools — Skill 按需加载
 *
 * T3 拆分：自 tools.ts 原样提取（loadSkill）。
 */

import type { RegisteredTool } from './tool-registry.js';

// ─── Skill 按需加载 ───

const loadSkill: RegisteredTool = {
  name: 'loadSkill',
  description: '按需加载 Skill 完整内容。Agent 看到 skill 索引后，调用此工具获取具体工作流指令。',
  inputSchema: {
    type: 'object',
    properties: {
      skillName: { type: 'string', description: 'Skill 名称（从索引中获取）' },
      workUnitId: { type: 'string', description: '当前 WorkUnit ID（可选；用于 skill_used 事件归属）' },
    },
    required: ['skillName'],
  },
  handler: async (input) => {
    const { skillName } = input;

    // [Skill Discovery] Log Agent's skill selection
    const { logger: log } = await import('@dommaker/studio-shared');
    log.info(`[SkillDiscovery] Agent selected skill: ${skillName}`);

    // 1. Try package SkillLoader (sync, cached, includes hardcoded + DB skills)
    const { skillLoader } = await import('@dommaker/studio-skill');
    const fullPrompt = skillLoader.getFullPrompt(skillName);
    if (fullPrompt) {
      return { skillName, content: fullPrompt, source: 'cache' };
    }

    // 2. Try file-based loading via SkillLoaderService
    const { skillLoaderService } = await import('../skills/skill-loader.js');
    const loaded = await skillLoaderService.loadSkill({
      sessionId: `mcp-${Date.now()}`,
      skillName,
      // #172: skill_used 事件补 WU 归属（调用方已知时）
      ...(typeof input.workUnitId === 'string' && input.workUnitId ? { workUnitId: input.workUnitId } : {}),
    });
    if (loaded) {
      return { skillName, content: loaded.prompt, source: 'file' };
    }

    return { skillName, error: `Skill "${skillName}" not found` };
  },
};

export const skillTools: RegisteredTool[] = [
  loadSkill,
];
