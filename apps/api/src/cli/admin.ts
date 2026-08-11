// ── 管理域（2026-07-20 自 studio-cli.ts 按命令域拆分）──
// studio daemon start / status, project add / list, workon

import * as fs from 'fs';
import * as path from 'path';
import { STUDIO_DIR, ensureDir } from './shared.js';

export async function studioDaemonStart() {
  const rawArgs = process.argv.slice(3);
  const serverUrlIdx = rawArgs.indexOf('--server-url');
  const tokenIdx = rawArgs.indexOf('--token');
  const rootIdx = rawArgs.indexOf('--workspace-root');
  const nameIdx = rawArgs.indexOf('--name');

  const serverUrl = serverUrlIdx >= 0 ? rawArgs[serverUrlIdx + 1] : undefined;
  const token = tokenIdx >= 0 ? rawArgs[tokenIdx + 1] : undefined;
  const workspaceRoot = rootIdx >= 0 ? rawArgs[rootIdx + 1] : undefined;
  const name = nameIdx >= 0 ? rawArgs[nameIdx + 1] : undefined;

  if (!serverUrl || !token) {
    console.error('Usage: studio daemon start --server-url <url> --token <token> [--workspace-root <path>] [--name <name>]');
    process.exit(1);
  }

  // Dynamic imports to avoid loading daemon modules on every CLI invocation
  const { scanAllProviders, hasDocker, KNOWN_PROVIDERS } = await import('../daemon/cli-scanner.js');
  const { generateWorkspaceConfig, writeWorkspaceConfig } = await import('../daemon/workspace-config.js');
  const { registerWorkspace } = await import('../daemon/registration.js');

  // 1. Scan for available CLIs
  console.log('Scanning for agent CLIs...');
  const runtimes = scanAllProviders();
  if (runtimes.length === 0) {
    console.warn(`Warning: No agent CLIs detected (${KNOWN_PROVIDERS.join(', ')})`);
  } else {
    for (const r of runtimes) {
      console.log(`  Found: ${r.provider} (${r.version}) at ${r.path}`);
    }
  }

  const dockerAvailable = hasDocker();

  // 2. Generate workspace config
  const config = generateWorkspaceConfig({
    serverUrl,
    token,
    runtimes: runtimes.map(r => r.provider),
    hasDocker: dockerAvailable,
    workspaceRoot,
    name,
  });

  // 3. Scan for git repos in workspaceRoot
  const { handleDiscoverRecursive } = await import('../daemon/discover-handler.js');
  let repos: Array<{ path: string; name: string; category?: string; defaultBranch: string; remoteUrl?: string }> = [];
  try {
    const discovered = await handleDiscoverRecursive(config.workspaceRoot, 3);
    repos = discovered.map(r => ({
      path: r.path,
      name: r.name,
      category: r.category,
      defaultBranch: 'main', // Will be enriched server-side if needed
    }));
    if (repos.length > 0) {
      console.log(`  Repos: ${repos.length} git repos found`);
    }
  } catch (err) {
    console.warn(`  Warning: Repo scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Write workspace.json
  writeWorkspaceConfig(config);
  console.log(`Workspace config written to ${path.join(STUDIO_DIR, 'workspace.json')}`);
  console.log(`  Name: ${config.name}`);
  console.log(`  Server: ${config.serverUrl}`);
  console.log(`  Root: ${config.workspaceRoot}`);
  console.log(`  Runtimes: ${config.runtimes.join(', ') || 'none'}`);
  console.log(`  Docker: ${config.hasDocker}`);
  console.log(`  OS/Arch: ${config.os}/${config.arch}`);

  // 5. Register with server
  console.log('Registering workspace with server...');
  const result = await registerWorkspace(config, runtimes.map(r => ({ provider: r.provider, version: r.version })), repos);

  if (result.success) {
    console.log(`Registered successfully. Workspace ID: ${result.workspaceId || '(pending)'}`);
    if (result.workspaceId) {
      // Persist workspaceId
      const { updateWorkspaceConfig } = await import('../daemon/workspace-config.js');
      updateWorkspaceConfig({ workspaceId: result.workspaceId });
    }
  } else {
    console.error(`Registration failed: ${result.error}`);
    console.error('Workspace config saved locally. Retry registration later.');
    process.exit(1);
  }
}

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
