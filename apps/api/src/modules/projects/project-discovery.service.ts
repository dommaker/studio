/**
 * AC-D1+D3: Project Discovery Service
 *
 * Scans local directories for projects (CLAUDE.md / package.json / .git/).
 * Pure service — no database persistence. In-memory caching.
 */
import { readdir, stat, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export interface LocalProject {
  name: string;
  path: string;
  hasClaudeMd: boolean;
  language?: string;
}

interface ProjectDiscoveryOptions {
  roots?: string[];
  cacheTtl?: number;
}

export class ProjectDiscoveryService {
  private cache: LocalProject[] | null = null;
  private cacheTime = 0;
  private readonly cacheTtl: number;
  private readonly roots: string[];

  constructor(options?: ProjectDiscoveryOptions) {
    const rootEnv = process.env.STUDIO_PROJECTS_ROOT;
    this.roots = options?.roots ?? (rootEnv ? rootEnv.split(':') : [join(homedir(), 'projects')]);
    this.cacheTtl = options?.cacheTtl ?? 60_000;
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

  invalidateCache(): void {
    this.cache = null;
    this.cacheTime = 0;
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

      const projectInfo = await this.isProject(fullPath);
      if (projectInfo.isProject) {
        results.push({
          name: entry,
          path: fullPath,
          hasClaudeMd: projectInfo.hasClaudeMd,
          language: projectInfo.language,
        });
      }
      // Always recurse into subdirectories (except at max depth)
      // to find projects inside non-project intermediate dirs (e.g. packages/)
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

    let hasClaudeMd = false;
    let language: string | undefined;

    for (const marker of markers) {
      try {
        await access(join(dir, marker.file));
        if (marker.isMarker && marker.file === 'CLAUDE.md') {
          hasClaudeMd = true;
        }
        if (marker.detectLang) {
          language = await this.detectLanguage(dir);
        }
        return { isProject: true, hasClaudeMd, language };
      } catch {
        // Marker not found, continue
      }
    }

    return { isProject: false, hasClaudeMd: false, language };
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
