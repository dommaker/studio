import type { SkillDefinition } from './types.js';

export function matchIntent(taskText: string, skills: SkillDefinition[]): string[] {
  if (!taskText || !skills.length) return [];
  const lower = taskText.toLowerCase();
  const scored: Array<{ id: string; count: number }> = [];
  for (const skill of skills) {
    if (!skill.intentKeywords || skill.intentKeywords.length === 0) continue;
    let count = 0;
    for (const kw of skill.intentKeywords) {
      if (lower.includes(kw.toLowerCase())) count++;
    }
    if (count > 0) scored.push({ id: skill.id, count });
  }
  scored.sort((a, b) => b.count - a.count);
  return scored.map(s => s.id);
}
