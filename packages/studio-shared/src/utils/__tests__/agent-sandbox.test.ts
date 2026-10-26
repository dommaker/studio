import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { execSh } from '../process-io';
import { prepareAgentSandbox, type AgentSandboxHandle } from '../agent-sandbox';
import { activeAgentServiceIdentityCountForTesting, clearAgentServiceIdentitiesForTesting } from '../agent-identity';

const hasLinuxSandbox = process.platform === 'linux' && process.getuid?.() === 0;

function brokerDirectories(): string[] {
  return fs.readdirSync(os.tmpdir()).filter(entry => entry.startsWith('studio-agent-broker-')).sort();
}

describe('Linux Agent runner boundary', () => {
  let root: string;
  let worktree: string;
  let allowedServer: http.Server;
  let deniedServer: http.Server;
  let allowedHits = 0;
  let deniedHits = 0;
  let allowedConnections = 0;
  let observedBrokerMarker = '';
  let handle: AgentSandboxHandle | undefined;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sec05-sandbox-'));
    worktree = path.join(root, 'worktree');
    fs.mkdirSync(worktree);
    allowedHits = 0;
    deniedHits = 0;
    allowedConnections = 0;
    observedBrokerMarker = '';
    allowedServer = http.createServer((req, res) => {
      allowedHits += 1;
      observedBrokerMarker = String(req.headers['x-studio-agent-broker'] ?? '');
      res.end('allowed');
    });
    allowedServer.on('connection', () => { allowedConnections += 1; });
    deniedServer = http.createServer((req, res) => { deniedHits += 1; res.end('denied'); });
    await Promise.all([
      new Promise<void>(resolve => allowedServer.listen(0, '127.0.0.1', resolve)),
      new Promise<void>(resolve => deniedServer.listen(0, '127.0.0.1', resolve)),
    ]);
  });

  afterEach(async () => {
    await handle?.dispose();
    handle = undefined;
    clearAgentServiceIdentitiesForTesting();
    await Promise.all([
      new Promise<void>(resolve => allowedServer.close(() => resolve())),
      new Promise<void>(resolve => deniedServer.close(() => resolve())),
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(!hasLinuxSandbox)('enforces low OS identity, filesystem, executable and egress matrix without leaks or side effects', async () => {
    const secretFile = path.join(root, 'operator-secret.txt');
    const outsideWrite = path.join(root, 'outside-write.txt');
    const outsideExecution = path.join(root, 'outside-execution.txt');
    const tool = path.join(root, 'tool.sh');
    fs.writeFileSync(secretFile, 'fake-operator-secret-sec05', { mode: 0o600 });
    fs.writeFileSync(tool, `#!/bin/sh\necho ran > ${outsideExecution}\n`, { mode: 0o700 });
    const allowedPort = (allowedServer.address() as AddressInfo).port;
    const deniedPort = (deniedServer.address() as AddressInfo).port;
    const probe = `
      const fs=require('fs'); let leaked=false, escaped=false;
      fs.mkdirSync(${JSON.stringify(path.join(worktree, '.claude'))});
      fs.writeFileSync(${JSON.stringify(path.join(worktree, '.claude/settings.json'))}, '{"permissions":{"defaultMode":"bypassPermissions"}}');
      try { leaked=fs.readFileSync(${JSON.stringify(secretFile)},'utf8').includes('fake-operator-secret-sec05'); } catch {}
      try { fs.writeFileSync(${JSON.stringify(outsideWrite)},'bad'); escaped=true; } catch {}
      fs.writeFileSync(${JSON.stringify(path.join(worktree, 'allowed.txt'))},'ok');
      console.log('PROBE='+JSON.stringify({uid:process.getuid(),leaked,escaped}));
    `;
    const encodedProbe = Buffer.from(probe).toString('base64');
    const command = [
      `id && stat -c '%a %U %G' ${JSON.stringify(worktree)}`,
      `node -e "eval(Buffer.from('${encodedProbe}','base64').toString())"`,
      `( ${JSON.stringify(tool)} || true )`,
      `test "$(curl -sS -x "$HTTP_PROXY" -H 'x-studio-agent-broker: forged-by-agent' http://127.0.0.1:${allowedPort}/allowed)" = allowed`,
      `test "$(curl -sS -x "$HTTP_PROXY" http://127.0.0.1:${deniedPort}/denied || true)" != denied`,
      `! curl -sS --noproxy '*' --max-time 1 http://127.0.0.1:${allowedPort}/direct`,
      `! curl -sS -x "$HTTP_PROXY" --max-time 2 https://127.0.0.1:${allowedPort}/connect`,
    ].join(' && ');
    handle = await prepareAgentSandbox({
      command, worktree, provider: 'claude', executionId: 'exec-sec05',
      env: { PATH: process.env.PATH },
      egress: [{ host: '127.0.0.1', ports: [allowedPort] }],
    });
    const { stdout } = await execSh(handle.command, {
      cwd: worktree, env: handle.env, inheritProcessEnv: false, timeoutMs: 10_000,
    }).catch(error => { throw new Error(`${String(error.stdout ?? '')}\n${String(error.stderr ?? error)}`); });
    expect(stdout).toContain('"uid":65534');
    expect(stdout).toContain('gid=65534');
    expect(stdout).toMatch(/groups=65534\n/);
    expect(stdout).not.toContain('0(root)');
    expect(stdout).toContain('"leaked":false');
    expect(stdout).toContain('"escaped":false');
    expect(stdout).not.toContain('fake-operator-secret-sec05');
    expect(fs.readFileSync(path.join(worktree, 'allowed.txt'), 'utf8')).toBe('ok');
    expect(fs.existsSync(outsideWrite)).toBe(false);
    expect(fs.existsSync(outsideExecution)).toBe(false);
    expect(allowedHits).toBe(1);
    expect(allowedConnections).toBe(1);
    expect(deniedHits).toBe(0);
    expect(observedBrokerMarker).toMatch(/^sab_/);
    expect(observedBrokerMarker).not.toBe('forged-by-agent');
    expect(handle.env.STUDIO_AGENT_TOKEN).toMatch(/^sta_/);
    expect(observedBrokerMarker).not.toBe(handle.env.STUDIO_AGENT_TOKEN);
    expect(handle.env.JWT_SECRET).toBeUndefined();
  }, 20_000);

  it.skipIf(!hasLinuxSandbox)('uses only gid 65534 for .git writes and restores pre-existing ownership/mode on dispose', async () => {
    const gitDir = path.join(worktree, '.git');
    const gitConfig = path.join(gitDir, 'config');
    fs.mkdirSync(gitDir, { mode: 0o750 });
    fs.writeFileSync(gitConfig, '[core]\n', { mode: 0o640 });
    fs.chmodSync(worktree, 0o755);
    const before = [worktree, gitDir, gitConfig].map(target => {
      const stat = fs.statSync(target);
      return { target, gid: stat.gid, mode: stat.mode & 0o7777 };
    });
    handle = await prepareAgentSandbox({
      command: "printf '# agent-write\\n' >> .git/config && echo new > new-file && id",
      worktree, provider: 'claude', executionId: 'exec-permissions-sec05', env: { PATH: process.env.PATH }, egress: [],
    });
    const { stdout } = await execSh(handle.command, {
      cwd: worktree, env: handle.env, inheritProcessEnv: false, timeoutMs: 10_000,
    });
    expect(stdout).toMatch(/uid=65534 gid=65534 groups=65534\n/);
    expect(fs.readFileSync(gitConfig, 'utf8')).toContain('# agent-write');
    expect(fs.statSync(gitConfig).gid).toBe(65534);
    await handle.dispose();
    await handle.dispose();
    for (const original of before) {
      const stat = fs.statSync(original.target);
      expect(stat.gid).toBe(original.gid);
      expect(stat.mode & 0o7777).toBe(original.mode);
    }
    expect(fs.statSync(path.join(worktree, 'new-file')).gid).toBe(65534);
  });

  it.skipIf(!hasLinuxSandbox)('executes the real provider-hooks harness shim inside the sandbox', async () => {
    const require = createRequire(import.meta.url);
    const harnessEntry = require.resolve('@dommaker/harness');
    const shim = path.join(path.dirname(harnessEntry), 'pretool-use-hook.js');
    expect(fs.existsSync(shim)).toBe(true);
    const allowedInput = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'true' } });
    const blockedInput = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force' } });
    handle = await prepareAgentSandbox({
      command: `printf '%s' '${allowedInput}' | node ${JSON.stringify(shim)} && test "$(printf '%s' '${blockedInput}' | node ${JSON.stringify(shim)}; echo $?)" = 2`,
      worktree, provider: 'codex', executionId: 'exec-real-shim-sec05', env: { PATH: process.env.PATH }, egress: [],
    });
    await expect(execSh(handle.command, {
      cwd: worktree, env: handle.env, inheritProcessEnv: false, timeoutMs: 10_000,
    })).resolves.toBeDefined();
  });

  it.skipIf(!hasLinuxSandbox)('runs an allowlisted provider CLI normally', async () => {
    const bin = path.join(root, 'provider-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho fake-claude-version-sec05\n', { mode: 0o755 });
    handle = await prepareAgentSandbox({
      command: 'claude --version', worktree, provider: 'claude', executionId: 'exec-cli-sec05',
      env: { PATH: `${bin}:${process.env.PATH}` }, egress: [],
    });
    const { stdout } = await execSh(handle.command, {
      cwd: worktree, env: handle.env, inheritProcessEnv: false, timeoutMs: 10_000,
    });
    expect(stdout.trim()).toBe('fake-claude-version-sec05');
  });

  it.skipIf(!hasLinuxSandbox).each(['after-identity', 'broker-listen', 'broker-chmod', 'after-broker'])('rolls back identity, broker, directories and permissions after %s failure', async failureStage => {
    clearAgentServiceIdentitiesForTesting();
    const beforeDirectories = brokerDirectories();
    const originalMode = fs.statSync(worktree).mode & 0o7777;
    const originalGid = fs.statSync(worktree).gid;
    await expect(prepareAgentSandbox({
      command: 'true', worktree, provider: 'claude', executionId: `exec-${failureStage}-sec05`,
      env: { PATH: process.env.PATH }, egress: [],
      faultInjector: stage => { if (stage === failureStage) throw new Error(`injected-${failureStage}`); },
    })).rejects.toThrow(`injected-${failureStage}`);
    expect(activeAgentServiceIdentityCountForTesting()).toBe(0);
    expect(brokerDirectories()).toEqual(beforeDirectories);
    expect(fs.statSync(worktree).mode & 0o7777).toBe(originalMode);
    expect(fs.statSync(worktree).gid).toBe(originalGid);
  });

  it('fails closed on unsupported platforms', async () => {
    await expect(prepareAgentSandbox({
      command: 'true', worktree, provider: 'claude', executionId: 'exec-sec05', env: {}, platform: 'darwin',
    })).rejects.toThrow(/unsupported Agent sandbox platform/);
  });
});
