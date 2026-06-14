import type { SkillDefinition } from './types.js';

/**
 * Match task text against skill name/description.
 * Returns skill ids sorted by match count (descending).
 */
export function matchIntent(taskText: string, skills: SkillDefinition[]): string[] {
  if (!taskText || !skills.length) return [];
  const lower = taskText.toLowerCase();
  const words = lower.split(/\s+/).filter(w => w.length > 2);
  const scored: Array<{ id: string; count: number }> = [];
  for (const skill of skills) {
    const skillText = `${skill.name} ${skill.description}`.toLowerCase();
    let count = 0;
    for (const word of words) {
      if (skillText.includes(word)) count++;
    }
    if (count > 0) scored.push({ id: skill.id, count });
  }
  scored.sort((a, b) => b.count - a.count);
  return scored.map(s => s.id);
}
