/**
 * AC-D1+D3: Project Discovery Service
 *
 * Scans local directories for projects (CLAUDE.md / package.json / .git/).
 * Pure service — no database persistence. In-memory caching.
 *
 * 工程即叶子（2026-07-29）：命中标记的目录不再递归内部 —— monorepo 只列根，
 * 子包（apps/web 等）不重复出现；非工程中间目录（分组目录、无标记的 packages/）
 * 仍会继续下钻，嵌套工程可被找到。
 *
 * D6 排除清单（第一层）：env STUDIO_PROJECTS_EXCLUDE（冒号分隔）或 options.exclude，
 * 规则命中目录名（精确）或绝对路径（目录边界前缀）即跳过，不递归进入。
 */
import { readdir, stat, access } from 'node:fs/promises';
import { join, sep, basename } from 'node:path';
import { homedir } from 'node:os';

export interface LocalProject {
  name: string;
  path: string;
  hasClaudeMd: boolean;
  language?: string;
}

/** #265（决策 #258）：归属问答分层匹配结果 — 唯一命中 / 候选列表 */
export type ProjectMatchResult =
  | { kind: 'hit'; project: LocalProject }
  | { kind: 'candidates'; projects: LocalProject[] };

/**
 * #265（决策 #258）归属问答分层匹配原语（纯函数，可脱离 FileStore 单测），命中即停：
 * ① name 或 path 精确等值（大小写不敏感）唯一 → 直接命中，不看其他候选
 *    （多命中不误绑，下潜候选——同名工程存在时由人选）；
 * ② 路径尾段边界匹配唯一（query 是 path 末尾的完整段序列：'studio' 命中
 *    '/root/projects/studio'，不命中 'studio-config'；'g/tool' 命中 '/a/g/tool'）；
 * ③ 以上落空 → 子串匹配产出候选列表。
 */
export function matchProjectByReply(query: string, projects: LocalProject[]): ProjectMatchResult {
  const q = query.trim().toLowerCase();
  if (!q) return { kind: 'candidates', projects: [] };
  const exact = projects.filter(
    p => p.name.toLowerCase() === q || p.path.toLowerCase() === q,
  );
  if (exact.length === 1) return { kind: 'hit', project: exact[0] };
  const tail = projects.filter(p => p.path.toLowerCase().endsWith(`/${q}`));
  if (tail.length === 1) return { kind: 'hit', project: tail[0] };
  const subs = projects.filter(
    p => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
  );
  return { kind: 'candidates', projects: subs };
}

interface ProjectDiscoveryOptions {
  roots?: string[];
  cacheTtl?: number;
  /** D6: 排除规则（目录名或绝对路径前缀）；缺省读 env STUDIO_PROJECTS_EXCLUDE */
  exclude?: string[];
}

export class ProjectDiscoveryService {
  private cache: LocalProject[] | null = null;
  private cacheTime = 0;
  private readonly cacheTtl: number;
  private readonly roots: string[];
  private readonly exclude: string[];

  constructor(options?: ProjectDiscoveryOptions) {
    const rootEnv = process.env.STUDIO_PROJECTS_ROOT;
    this.roots = options?.roots ?? (rootEnv ? rootEnv.split(':') : [join(homedir(), 'projects')]);
    this.cacheTtl = options?.cacheTtl ?? 60_000;
    const excludeEnv = process.env.STUDIO_PROJECTS_EXCLUDE;
    this.exclude = options?.exclude
      ?? (excludeEnv ? excludeEnv.split(':').map(s => s.trim()).filter(Boolean) : []);
  }

  async discover(): Promise<LocalProject[]> {
    const now = Date.now();
    if (this.cache && now - this.cacheTime < this.cacheTtl) {
      return this.cache;
    }

    const projects: LocalProject[] = [];
    for (const root of this.roots) {
      const expanded = root.startsWith('~') ? join(homedir(), root.slice(1)) : root;
      try {
        const found = await this.scanDirectory(expanded, 0);
        projects.push(...found);
      } catch {
        // Root doesn't exist or not accessible → skip
      }
    }

    this.cache = projects;
    this.cacheTime = now;
    return projects;
  }

  async search(query: string): Promise<LocalProject[]> {
    const projects = await this.discover();
    const q = query.toLowerCase();
    return projects.filter(
      p => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    );
  }

  /**
   * #265（决策 #258）：绝对路径直连校验 —— stat + isProject 合法即返回工程，否则 null。
   * 归属问答中「/」开头的回复不走 search，绕过一切歧义直接绑定。
   * 不读 discovery 缓存/候选集：root 之外的合法工程路径同样可绑。
   */
  async validateProjectPath(absPath: string): Promise<LocalProject | null> {
    try {
      const s = await stat(absPath);
      if (!s.isDirectory()) return null;
      const info = await this.isProject(absPath);
      if (!info.isProject) return null;
      return {
        name: basename(absPath),
        path: absPath,
        hasClaudeMd: info.hasClaudeMd,
        language: info.language,
      };
    } catch {
      return null;
    }
  }

  invalidateCache(): void {
    this.cache = null;
    this.cacheTime = 0;
  }

  /**
   * D6: 排除规则匹配 — 目录名精确匹配，或绝对路径按目录边界前缀匹配
   * （`/data/secret` 命中 `/data/secret` 与 `/data/secret/x`，不误伤 `/data/secret2`）。
   */
  private isExcluded(name: string, fullPath: string): boolean {
    return this.exclude.some(rule => {
      if (name === rule || fullPath === rule) return true;
      const prefix = rule.endsWith(sep) ? rule : rule + sep;
      return fullPath.startsWith(prefix);
    });
  }

  private async scanDirectory(dir: string, depth: number): Promise<LocalProject[]> {
    if (depth > 2) return []; // Max depth: root + 2 levels (monorepo/packages/project)

    const results: LocalProject[] = [];
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let isDir: boolean;
      try {
        const s = await stat(fullPath);
        isDir = s.isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      // Skip hidden directories and node_modules
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      // D6: 排除清单命中（目录名 / 绝对路径前缀）→ 跳过且不递归
      if (this.isExcluded(entry, fullPath)) continue;

      const projectInfo = await this.isProject(fullPath);
      if (projectInfo.isProject) {
        results.push({
          name: entry,
          path: fullPath,
          hasClaudeMd: projectInfo.hasClaudeMd,
          language: projectInfo.language,
        });
        // 工程即叶子：命中后不再递归内部，避免 monorepo 子包被重复列出
        continue;
      }
      // 仅对非工程目录递归（如分组目录、无标记的 packages/），以发现嵌套工程
      if (depth < 2) {
        const subResults = await this.scanDirectory(fullPath, depth + 1);
        results.push(...subResults);
      }
    }

    return results;
  }

  private async isProject(dir: string): Promise<{ isProject: boolean; hasClaudeMd: boolean; language?: string }> {
    const markers = [
      { file: 'CLAUDE.md', isMarker: true },
      { file: 'package.json', detectLang: true },
      { file: '.git', isDir: true },
    ];

    let found = false;
    let hasClaudeMd = false;
    let language: string | undefined;

    for (const marker of markers) {
      try {
        await access(join(dir, marker.file));
        found = true;
        if (marker.isMarker && marker.file === 'CLAUDE.md') {
          hasClaudeMd = true;
        }
        if (marker.detectLang) {
          language = await this.detectLanguage(dir);
        }
      } catch {
        // Marker not found, continue
      }
    }

    if (!found) return { isProject: false, hasClaudeMd: false, language };
    return { isProject: true, hasClaudeMd, language };
  }

  private async detectLanguage(dir: string): Promise<string | undefined> {
    // Check package.json
    try {
      const pkgPath = join(dir, 'package.json');
      const pkgRaw = await import('node:fs/promises').then(fs =>
        fs.readFile(pkgPath, 'utf-8'),
      );
      const pkg = JSON.parse(pkgRaw);
      if (pkg.dependencies?.typescript || pkg.devDependencies?.typescript) return 'typescript';
      return 'javascript';
    } catch { /* no package.json */ }

    // Check go.mod
    try {
      await access(join(dir, 'go.mod'));
      return 'go';
    } catch { /* no go.mod */ }

    // Check Cargo.toml
    try {
      await access(join(dir, 'Cargo.toml'));
      return 'rust';
    } catch { /* no Cargo.toml */ }

    return undefined;
  }
}
