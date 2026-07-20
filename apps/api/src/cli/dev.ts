// ── 开发域（2026-07-20 自 studio-cli.ts 按命令域拆分）──
// studio build / test

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { STUDIO_DIR, ensureDir } from './shared.js';

/**
 * Get admin token for authenticated API calls.
 * 1. Try reading from ~/.studio/.daemon/admin-token
 * 2. Fallback: login via POST /api/v1/auth/login and cache the token
 */
let _cachedAdminToken: string | null = null;
export async function getAdminToken(baseUrl: string): Promise<string> {
  if (_cachedAdminToken) return _cachedAdminToken;

  const tokenFile = path.join(STUDIO_DIR, '.daemon', 'admin-token');
  if (fs.existsSync(tokenFile)) {
    _cachedAdminToken = fs.readFileSync(tokenFile, 'utf-8').trim();
    return _cachedAdminToken;
  }

  // Fallback: login with admin credentials
  const email = process.env.ADMIN_EMAIL || 'admin@agent-studio.local';
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.error('  Warning: ADMIN_PASSWORD not set, harness tests may fail auth');
    return '';
  }

  try {
    const resp = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!resp.ok) {
      console.error(`  Warning: Admin login failed (${resp.status}), harness tests may fail auth`);
      return '';
    }
    const data = await resp.json() as { token?: string };
    if (data.token) {
      _cachedAdminToken = data.token;
      // Persist for next run
      try {
        ensureDir(path.join(STUDIO_DIR, '.daemon'));
        fs.writeFileSync(tokenFile, data.token, 'utf-8');
      } catch { /* ignore write errors */ }
      return _cachedAdminToken;
    }
  } catch (e: any) {
    console.error(`  Warning: Admin login error: ${e.message?.slice(0, 60)}`);
  }
  return '';
}

export async function studioTest() {
  const port = parseInt(process.env.PORT || '3001');
  const baseUrl = `http://localhost:${port}/api/v1`;
  let failures = 0;
  let passes = 0;

  console.log('Studio E2E Test');
  console.log('━━━━━━━━━━━━━━');

  const check = async (name: string, fn: () => Promise<boolean>) => {
    try {
      const ok = await fn();
      if (ok) { passes++; console.log(`  ✅ ${name}`); }
      else { failures++; console.log(`  ❌ ${name}`); }
    } catch (e: any) {
      failures++;
      console.log(`  ❌ ${name}: ${e.message?.slice(0, 60) || String(e).slice(0, 60)}`);
    }
  };

  // Server reachable
  await check('Server reachable', async () => {
    const r = await fetch(`${baseUrl}/health`);
    return r.ok;
  });

  // Channels accessible
  await check('Channels accessible', async () => {
    const r = await fetch(`${baseUrl}/channels`);
    return r.ok;
  });

  // 研发 channel exists
  await check('研发 channel exists', async () => {
    const r = await fetch(`${baseUrl}/channels`);
    const { data } = await r.json() as { data: Array<{ type: string }> };
    return data.some((c: any) => c.type === 'rnd');
  });

  // Can send message
  await check('Can send message', async () => {
    const chResp = await fetch(`${baseUrl}/channels`);
    const { data: channels } = await chResp.json() as { data: Array<{ id: string; type: string }> };
    const rnd = channels.find((c: any) => c.type === 'rnd');
    if (!rnd) return false;
    const resp = await fetch(`${baseUrl}/channels/${rnd.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `[E2E Test ${Date.now()}] Studio pipeline check` }),
    });
    return resp.ok;
  });

  // Quality gate endpoint
  await check('Quality gate endpoint (M2)', async () => {
    const token = await getAdminToken(baseUrl);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(`${baseUrl}/harness/check-constraints`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ operation: 'goal_creation', hasRequirement: true, hasRequirementReview: true }),
    });
    return r.ok;
  });

  // Knowledge endpoint
  await check('Knowledge endpoint', async () => {
    const token = await getAdminToken(baseUrl);
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(`${baseUrl}/harness/knowledge?limit=1`, { headers });
    return r.ok;
  });

  // RequirementsDoc endpoint
  await check('RequirementsDoc endpoint', async () => {
    const r = await fetch(`${baseUrl}/requirements-docs`);
    return r.ok || r.status === 404;
  });

  console.log(`\n  Results: ${passes} pass, ${failures} fail`);
  if (failures > 0) process.exit(1);
}

export function studioBuild() {
  const repoDir = process.env.REPO_DIR || process.cwd();
  console.log('Building all packages...');
  try {
    execSync('pnpm -r build', { cwd: repoDir, stdio: 'inherit', timeout: 120_000 });
    console.log('Build complete');
  } catch (err: any) {
    console.error('Build failed:', err.message?.slice(0, 200));
    process.exit(1);
  }
}
