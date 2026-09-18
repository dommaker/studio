/**
 * skill-validate — skill 目录布局 + frontmatter 离线校验（#568）
 *
 * 纯函数，零 I/O 副作用（只读）。规则出处 docs/plans/2026-09-skill-export-import.md §3.2：
 * - error：目录不存在或无 SKILL.md；frontmatter 不可解析；name 缺失/为空；
 *   name ≠ 目录名（loader 按目录名寻址、id 取 meta.name，不一致会索引错乱）；
 *   status 显式存在但不在词表。
 * - warning：description 缺失（SkillStore 生成的 draft 本就无 description，不能是 error）；
 *   status 非 published（不会被注入，仅提示）；无 triggers（selector 匹配弱）。
 *
 * 解析口径复用 studio-shared parseFrontmatter（与 loader 同源）；
 * triggers/consumers 仅 manifest-loader 多认，此处对 triggers 做宽松存在性检查。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '@dommaker/studio-shared';

export interface SkillValidation {
  errors: string[];
  warnings: string[];
}

const STATUS_VOCAB = ['published', 'draft', 'deprecated'];

export function validateSkillDir(dir: string): SkillValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const skillFile = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory() || !fs.existsSync(skillFile)) {
    errors.push(`skill 目录不存在或缺少 SKILL.md：${dir}`);
    return { errors, warnings };
  }

  const parsed = parseFrontmatter(fs.readFileSync(skillFile, 'utf-8'));
  if (!parsed) {
    errors.push('SKILL.md frontmatter 不可解析（缺 --- 围栏）');
    return { errors, warnings };
  }

  const meta = parsed.meta;
  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  if (!name) {
    errors.push('frontmatter name 缺失或为空');
  } else {
    const dirName = path.basename(path.resolve(dir));
    if (name !== dirName) {
      errors.push(`frontmatter name (${name}) 与目录名 (${dirName}) 不一致`);
    }
  }

  if (meta.status !== undefined) {
    const status = String(meta.status);
    if (!STATUS_VOCAB.includes(status)) {
      errors.push(`status 越界：${status}（词表：${STATUS_VOCAB.join('/')}）`);
    } else if (status !== 'published') {
      warnings.push(`status=${status}：不会被 loader 注入，仅提示`);
    }
  }

  if (!meta.description) {
    warnings.push('description 缺失（索引进 prompt 的主信号）');
  }

  const triggers = meta.triggers;
  if (!triggers || (Array.isArray(triggers) && triggers.length === 0)) {
    warnings.push('无 triggers（selector 匹配弱）');
  }

  return { errors, warnings };
}
