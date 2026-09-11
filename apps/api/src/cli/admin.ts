// ── 管理域（2026-07-20 自 studio-cli.ts 按命令域拆分）──
// studio project add / list, workon
// （`studio daemon start` 已随远程节点方向放弃删除，见 bdaf0dd3 2026-08-04）

import * as fs from 'fs';
import * as path from 'path';
import { STUDIO_DIR, ensureDir } from './shared.js';

export function studioProject(subArgs: string[]) {
  if (subArgs[0] === 'add') {
    const projectPath = path.resolve(subArgs[1] || process.cwd());
    ensureDir(STUDIO_DIR);
    const projectsFile = path.join(STUDIO_DIR, 'projects.json');
    const existing: string[] = fs.existsSync(projectsFile)
      ? JSON.parse(fs.readFileSync(projectsFile, 'utf-8'))
      : [];
    if (!existing.includes(projectPath)) {
      existing.push(projectPath);
      fs.writeFileSync(projectsFile, JSON.stringify(existing, null, 2));
    }
    console.log(`Project added: ${projectPath}`);
  } else if (subArgs[0] === 'list') {
    const projectsFile = path.join(STUDIO_DIR, 'projects.json');
    const projects: string[] = fs.existsSync(projectsFile)
      ? JSON.parse(fs.readFileSync(projectsFile, 'utf-8'))
      : [];
    console.log(projects.length ? projects.join('\n') : 'No projects registered.');
  }
}

export function studioWorkon(name: string | undefined) {
  if (!name) { console.error('Usage: studio workon <name>'); process.exit(1); }
  // Set active project by writing to .studio/active-project
  ensureDir(STUDIO_DIR);
  const activeFile = path.join(STUDIO_DIR, 'active-project');
  fs.writeFileSync(activeFile, name);
  console.log(`Active project: ${name}`);
}
