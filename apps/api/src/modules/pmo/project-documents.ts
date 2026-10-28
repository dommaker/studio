/** PMO 项目文档查询：读取业务仓 .studio/specs，不参与项目 CRUD/publish。 */
import { parseFrontmatter } from '@dommaker/studio-shared';
import { specsDir } from '@dommaker/studio-shared/studio-dir';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectRepository } from './project-repository.js';

export async function getLinkedSDDs(projectId: string): Promise<{
  sddEntries: Array<{ slug: string; pmoNumber: string; status: string; title: string; tags: string }>;
}> {
  const project = await projectRepository.get(projectId);
  if (!project) throw new Error('Project not found');
  if (!project.gitRepo) return { sddEntries: [] };

  const dir = specsDir(project.gitRepo);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  } catch {
    return { sddEntries: [] };
  }

  const sddEntries = files.map(file => {
    const slug = path.basename(file, '.md');
    let title = slug;
    let status = '';
    try {
      const parsed = parseFrontmatter(fs.readFileSync(path.join(dir, file), 'utf-8'));
      if (parsed) {
        title = (parsed.meta.title as string) || slug;
        status = (parsed.meta.status as string) || '';
      }
    } catch { /* 单文件解析失败不阻断列表 */ }
    return { slug, pmoNumber: project.pmoNumber, status, title, tags: '' };
  });
  return { sddEntries };
}
