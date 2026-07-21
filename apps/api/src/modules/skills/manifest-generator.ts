/**
 * manifest-generator
 *
 * 从 SKILL.md frontmatter 重新生成 SKILLS_DIR/MANIFEST.md。
 * MANIFEST.md 是 GENERATED 文件——要改内容请改各 skill 的 frontmatter，不要手改清单。
 *
 * 数据源：loadManifest()（active skills）+ _deprecated/ 目录扫描。
 * best-effort：任何失败只 log，不 throw。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '@dommaker/studio-shared';
import { loadManifest, invalidateManifestCache } from './manifest-loader.js';

const SKILLS_DIR = process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'skills');

/** 表格单元格转义（| 会破坏 markdown 表格） */
function cell(text: string | undefined): string {
  return (text ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

/** 列出 _deprecated/ 下的废弃 skill（目录名 + frontmatter description） */
function listDeprecated(): Array<{ name: string; description: string }> {
  const depDir = path.join(SKILLS_DIR, '_deprecated');
  const result: Array<{ name: string; description: string }> = [];
  try {
    if (!fs.existsSync(depDir)) return result;
    for (const dir of fs.readdirSync(depDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      let description = '';
      const skillFile = path.join(depDir, dir.name, 'SKILL.md');
      try {
        if (fs.existsSync(skillFile)) {
          const content = fs.readFileSync(skillFile, 'utf-8');
          const descMatch = content.match(/^description:\s*["']?(.+?)["']?\s*$/m);
          if (descMatch) description = descMatch[1];
        }
      } catch {
        // 单个文件读取失败不阻塞清单生成
      }
      result.push({ name: dir.name, description });
    }
  } catch (err) {
    logger.warn('[manifest-generator] Failed to scan _deprecated', { error: String(err) });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 重新生成 MANIFEST.md。扫描当前 SKILLS_DIR，覆盖写入清单文件。
 * best-effort：失败只 log warn，不 throw（调用方无需 try/catch）。
 */
export function generateManifest(): void {
  try {
    invalidateManifestCache();
    const skills = [...loadManifest()].sort((a, b) => a.name.localeCompare(b.name));
    const deprecated = listDeprecated();

    const lines: string[] = [
      '# Skill 索引',
      '',
      '<!-- GENERATED FILE — 由 manifest-generator 从各 SKILL.md frontmatter 生成。 -->',
      '<!-- 要修改本文件内容，请编辑对应 skill 的 SKILL.md frontmatter，然后重新生成。 -->',
      '',
      '`~/.studio/skills/` 下每个目录是一个 Skill（SKILL.md）。Agent 读此清单 → 自选 Skill。',
      '',
      '## 开发流程链（Skill Chain）',
      '',
      // 硬编码开发链：链顺序是流程约定，无法从 frontmatter 推导，调整时请同步改这里
      'design-analyst → spec-review-skill → task-planner → sdd-review-skill → tdd-implement → code-review',
      '',
      '## Active Skills',
      '',
      '| Skill | 描述 | agentTypes | triggers |',
      '|-------|------|------------|----------|',
    ];

    for (const s of skills) {
      lines.push(
        `| \`${s.name}/SKILL.md\` | ${cell(s.description)} | ${cell(s.agentTypes?.join(', ') || '—')} | ${cell(s.triggers?.join(', ') || '—')} |`,
      );
    }

    lines.push(
      '',
      '## 废弃 Skill（_deprecated/）',
      '',
      '以下 Skill 已移到 `_deprecated/` 目录，不参与 Skill Discovery。保留文件供历史参考。',
      '',
      '| Skill | 描述 |',
      '|-------|------|',
    );

    for (const d of deprecated) {
      lines.push(`| \`_deprecated/${d.name}\` | ${cell(d.description) || '—'} |`);
    }

    lines.push('');

    fs.writeFileSync(path.join(SKILLS_DIR, 'MANIFEST.md'), lines.join('\n'), 'utf-8');
    logger.info('[manifest-generator] MANIFEST.md regenerated', { skills: skills.length, deprecated: deprecated.length });
  } catch (err) {
    logger.warn('[manifest-generator] Failed to regenerate MANIFEST.md', { error: String(err) });
  }
}
