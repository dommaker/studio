/**
 * MCP Tools — Skill 按需加载
 *
 * T3 拆分：自 tools.ts 原样提取（loadSkill）。
 */

import type { RegisteredTool } from './tool-registry.js';

// ─── Skill 按需加载 ───

const loadSkill: RegisteredTool = {
  name: 'loadSkill',
  exposure: 'external',
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
      // skill 度量地基票 A：cache 命中是 loadSkill 常态路径（包级 loader 预热后覆盖全部
      // 磁盘 skill），此前只有路径 2 发射 skill_used → 事件结构性为 0。发射点上移到
      // 工具边界：cache 路径在本层补发射（level=info 提为 signal，不归噪声 7 天滚）；
      // 路径 2 维持 skill-loader.ts 既有发射，每调用恰好一次。
      const { writeStudioEvent } = await import('@dommaker/studio-shared');
      void writeStudioEvent('knowledge:skill_used', {
        skillName,
        ...(typeof input.workUnitId === 'string' && input.workUnitId ? { workUnitId: input.workUnitId } : {}),
        channel: 'loadSkill',
      }, { source: 'skill-tools', level: 'info' }).catch(() => {});
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
