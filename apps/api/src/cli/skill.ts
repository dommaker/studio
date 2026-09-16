/**
 * studio skill validate/export/install — skill 流动三件套（#568）
 *
 * 纯本地文件操作，不依赖 daemon 在线（与走 HTTP API 的 `studio skill list` 本质区别）。
 * 方案正本：docs/plans/2026-09-skill-export-import.md。
 *
 * 与 seed 机制的隔离规则（§3.4）：
 * - install 与内置正本同名 → 硬拒绝（占名会堵死 seed hash 升级通道），提示改名；
 * - install/export/validate 对 <SKILLS_DIR>/.builtin-hashes.json 只字不碰；
 * - install 不写 skills-index.json（与 seed 对齐：目录即注册）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { validateSkillDir } from './skill-validate.js';

export async function studioSkill(args: string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case 'validate':
      return skillValidateCmd(args.slice(1));
    default:
      console.error('Usage: studio skill <validate <dir>>');
      return 1;
  }
}

function skillValidateCmd(args: string[]): number {
  const dir = args[0];
  if (!dir) {
    console.error('Usage: studio skill validate <dir>');
    return 1;
  }
  const abs = path.resolve(dir);
  const { errors, warnings } = validateSkillDir(abs);
  for (const e of errors) console.error(`error: ${e}`);
  for (const w of warnings) console.log(`warning: ${w}`);
  if (errors.length > 0) {
    console.error(`validate ${abs}: ${errors.length} error(s), ${warnings.length} warning(s)`);
    return 1;
  }
  console.log(`validate ${abs}: ok (${warnings.length} warning(s))`);
  return 0;
}
