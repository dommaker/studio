import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { issueAgentServiceIdentity, revokeAgentServiceIdentity } from './agent-identity';
import { resolveProviderDefinition } from '../providers';

export interface AgentEgressRule {
  host: string;
  ports: number[];
}

export interface AgentSandboxOptions {
  command: string;
  worktree: string;
  provider: string;
  executionId: string;
  env: NodeJS.ProcessEnv;
  egress?: AgentEgressRule[];
  ttlMs?: number;
  platform?: NodeJS.Platform;
  /** Deterministic failure seam for rollback tests; production callers omit it. */
  faultInjector?: (stage: 'after-identity' | 'broker-listen' | 'broker-chmod' | 'after-broker') => void;
}

export interface AgentSandboxHandle {
  command: string;
  env: NodeJS.ProcessEnv;
  dispose: () => Promise<void>;
}

const AGENT_UID = 65534;
const AGENT_GID = 65534;
const DEFAULT_PROVIDER_HOSTS: Readonly<Record<string, string[]>> = {
  claude: ['api.anthropic.com'],
  kimi: ['api.moonshot.cn', 'api.moonshot.ai'],
  codex: ['api.openai.com'],
  opencode: ['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'api.deepseek.com', 'api.moonshot.cn', 'openrouter.ai'],
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

function ruleMap(rules: AgentEgressRule[]): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const rule of rules) {
    const host = normalizeHost(rule.host);
    if (!host) continue;
    const ports = result.get(host) ?? new Set<number>();
    for (const port of rule.ports) {
      if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
    }
    result.set(host, ports);
  }
  return result;
}

function addUrlRule(rules: AgentEgressRule[], raw: string | undefined, defaultPort = 443): void {
  if (!raw) return;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    rules.push({ host: url.hostname, ports: [url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : defaultPort] });
  } catch { /* malformed operator config is not an allow rule */ }
}

export function resolveAgentEgress(provider: string, source: NodeJS.ProcessEnv = process.env): AgentEgressRule[] {
  const rules: AgentEgressRule[] = [
    { host: 'registry.npmjs.org', ports: [443] },
    { host: 'github.com', ports: [443] },
    { host: 'api.github.com', ports: [443] },
    ...(DEFAULT_PROVIDER_HOSTS[provider] ?? []).map(host => ({ host, ports: [443] })),
  ];
  const providerUrls = provider === 'claude'
    ? [source.ANTHROPIC_BASE_URL]
    : provider === 'kimi'
      ? [source.KIMI_BASE_URL, source.MOONSHOT_BASE_URL]
      : provider === 'codex'
        ? [source.OPENAI_BASE_URL]
        : provider === 'opencode'
          ? [source.OPENAI_BASE_URL, source.ANTHROPIC_BASE_URL, source.DEEPSEEK_BASE_URL, source.MOONSHOT_BASE_URL]
          : [];
  for (const url of providerUrls) addUrlRule(rules, url);
  const callback = source.STUDIO_AGENT_CALLBACK_URL ?? source.STUDIO_MCP_URL ?? 'http://localhost:13101';
  addUrlRule(rules, callback, 80);
  for (const entry of (source.STUDIO_AGENT_EGRESS_HOSTS ?? '').split(',')) addUrlRule(rules, entry.trim());
  return [...ruleMap(rules)].map(([host, ports]) => ({ host, ports: [...ports] }));
}

interface PermissionSnapshot {
  target: string;
  uid: number;
  gid: number;
  mode: number;
}

/**
 * Temporarily grant only gid 65534 write access. Pre-existing ownership/mode is
 * restored on every exit; Agent-created files deliberately remain owned by gid 65534.
 */
function prepareWorktreePermissions(worktree: string): () => void {
  const snapshots: PermissionSnapshot[] = [];
  const restore = (): void => {
    const errors: unknown[] = [];
    for (const original of snapshots.reverse()) {
      try {
        const current = fs.lstatSync(original.target);
        if (current.isSymbolicLink()) continue;
        fs.chownSync(original.target, original.uid, original.gid);
        fs.chmodSync(original.target, original.mode);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'failed to restore Agent worktree permissions');
  };
  const walk = (target: string): void => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return;
    snapshots.push({ target, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 });
    if (stat.isDirectory()) {
      fs.chownSync(target, stat.uid, AGENT_GID);
      fs.chmodSync(target, (stat.mode & 0o7777) | 0o2770);
      for (const entry of fs.readdirSync(target)) walk(path.join(target, entry));
      return;
    }
    const groupExecute = (stat.mode & 0o100) >> 3;
    fs.chownSync(target, stat.uid, AGENT_GID);
    fs.chmodSync(target, (stat.mode & 0o7777) | 0o660 | groupExecute);
  };
  try {
    walk(worktree);
  } catch (error) {
    try { restore(); } catch { /* preserve the preparation failure */ }
    throw error;
  }
  return restore;
}

function assertSupported(opts: AgentSandboxOptions): string {
  if ((opts.platform ?? process.platform) !== 'linux') {
    throw new Error(`unsupported Agent sandbox platform: ${opts.platform ?? process.platform}; refusing unsandboxed spawn`);
  }
  if (process.getuid?.() !== 0) {
    throw new Error('Linux Agent sandbox requires root to establish an independent OS identity; refusing unsandboxed spawn');
  }
  const worktree = fs.realpathSync(opts.worktree);
  if (!fs.statSync(worktree).isDirectory() || worktree === path.parse(worktree).root || worktree === os.homedir() || worktree === '/tmp') {
    throw new Error(`unsafe Agent worktree: ${worktree}`);
  }
  return worktree;
}

function findExecutable(binary: string, pathEnv: string | undefined): string | null {
  if (binary.includes('/')) return fs.existsSync(binary) ? fs.realpathSync(binary) : null;
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch { /* try the next PATH entry */ }
  }
  return null;
}

function addExecutableMounts(args: string[], provider: string, sourcePath: string | undefined, worktree: string): void {
  const seen = new Set<string>();
  const mount = (source: string): void => {
    if (seen.has(source) || source.startsWith('/usr/') || source === '/usr') return;
    seen.add(source);
    if (!source.startsWith(worktree + path.sep)) addParentAccess(args, source);
    args.push('--ro-bind', source, source);
  };
  const def = resolveProviderDefinition(provider);
  const binary = def.binaries.map(candidate => findExecutable(candidate, sourcePath)).find(Boolean);
  if (binary) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const index = binary.indexOf(marker);
    if (index < 0) {
      mount(binary);
    } else {
      const after = binary.slice(index + marker.length).split(path.sep);
      const packageParts = after[0]?.startsWith('@') ? 2 : 1;
      mount(binary.slice(0, index + marker.length) + after.slice(0, packageParts).join(path.sep));
    }
  }
  const node = fs.realpathSync(process.execPath);
  if (node.includes(`${path.sep}.nvm${path.sep}`)) {
    const versionBin = path.dirname(node);
    mount(path.dirname(versionBin));
  } else {
    mount(node);
  }
}

function nodeModulesPackageRoot(file: string): string | null {
  const marker = `${path.sep}node_modules${path.sep}`;
  const index = file.lastIndexOf(marker);
  if (index < 0) return null;
  const parts = file.slice(index + marker.length).split(path.sep);
  const packageParts = parts[0]?.startsWith('@') ? 2 : 1;
  if (parts.length < packageParts) return null;
  return file.slice(0, index + marker.length) + parts.slice(0, packageParts).join(path.sep);
}

/** Mount the actual provider-hook shim and only its production dependency closure. */
function addHarnessMounts(args: string[], worktree: string): void {
  const seen = new Set<string>();
  const mountPackage = (packageRoot: string): void => {
    if (seen.has(packageRoot)) return;
    seen.add(packageRoot);
    if (!packageRoot.startsWith(worktree + path.sep)) addParentAccess(args, packageRoot);
    args.push('--ro-bind', packageRoot, packageRoot);
    const manifest = path.join(packageRoot, 'package.json');
    let dependencies: string[] = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string> };
      dependencies = Object.keys(parsed.dependencies ?? {});
    } catch { return; }
    const requireFromPackage = createRequire(manifest);
    for (const dependency of dependencies) {
      try {
        const dependencyRoot = nodeModulesPackageRoot(fs.realpathSync(requireFromPackage.resolve(dependency)));
        if (dependencyRoot) mountPackage(dependencyRoot);
      } catch { /* optional runtime paths fail when the shim actually loads them */ }
    }
  };
  const harnessEntry = require.resolve('@dommaker/harness');
  const harnessRoot = nodeModulesPackageRoot(fs.realpathSync(harnessEntry));
  if (!harnessRoot) throw new Error('cannot resolve @dommaker/harness package root for Agent sandbox');
  mountPackage(harnessRoot);
}

function addParentAccess(args: string[], destination: string): void {
  const skipped = new Set(['/', '/tmp', '/usr', '/bin', '/etc', '/lib', '/lib64', '/proc', '/dev', '/run']);
  for (let parent = path.dirname(destination); parent !== path.dirname(parent); parent = path.dirname(parent)) {
    if (skipped.has(parent)) continue;
    args.push('--dir', parent, '--chmod', '755', parent);
  }
}

function addCredentialMounts(args: string[], provider: string, home: string, sandboxHome: string): void {
  const workspace = path.dirname(path.dirname(sandboxHome));
  const mount = (source: string, destination: string): void => {
    if (!destination.startsWith(workspace + path.sep)) addParentAccess(args, destination);
    args.push('--ro-bind-try', source, destination);
  };
  if (provider === 'claude') {
    mount(path.join(home, '.claude/.credentials.json'), path.join(sandboxHome, '.claude/.credentials.json'));
    mount(path.join(home, '.claude.json'), path.join(sandboxHome, '.claude.json'));
  } else if (provider === 'codex') {
    mount(path.join(home, '.codex/auth.json'), path.join(sandboxHome, '.codex/auth.json'));
    mount(path.join(home, '.codex/config.toml'), path.join(sandboxHome, '.codex/config.toml'));
  } else if (provider === 'kimi') {
    // Per-worktree config links only these provider-auth directories to the host.
    mount(path.join(home, '.kimi-code/credentials'), path.join(home, '.kimi-code/credentials'));
    mount(path.join(home, '.kimi-code/oauth'), path.join(home, '.kimi-code/oauth'));
  } else if (provider === 'opencode') {
    mount(path.join(home, '.local/share/opencode/auth.json'), path.join(sandboxHome, '.local/share/opencode/auth.json'));
  }
}

interface Broker {
  socketPath: string;
  directory: string;
  close: () => Promise<void>;
}

async function startEgressBroker(rules: AgentEgressRule[], brokerMarker: string, deniedConnectHosts: string[], faultInjector?: AgentSandboxOptions['faultInjector']): Promise<Broker> {
  const allowed = ruleMap(rules);
  const connectDenied = new Set(deniedConnectHosts.map(normalizeHost));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-agent-broker-'));
  const socketPath = path.join(directory, 'egress.sock');
  const sockets = new Set<net.Socket>();
  const isAllowed = (host: string, port: number): boolean => allowed.get(normalizeHost(host))?.has(port) === true;
  const server = net.createServer(client => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    let header = '';
    const onData = (chunk: Buffer): void => {
      header += chunk.toString('latin1');
      if (header.length > 16_384) {
        client.destroy();
        return;
      }
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.off('data', onData);
      const text = header.slice(0, end);
      const [requestLine, ...lines] = text.split('\r\n');
      const [method, target] = requestLine.split(' ');
      let host = '';
      let port = 0;
      let upstreamHead: string | null = null;
      if (method === 'CONNECT') {
        try {
          const url = new URL(`https://${target}`);
          host = url.hostname;
          port = url.port ? Number(url.port) : 443;
        } catch {
          client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
          return;
        }
      } else {
        try {
          const url = new URL(target);
          if (url.protocol !== 'http:') throw new Error('plain HTTP proxy requires http URL');
          host = url.hostname;
          port = url.port ? Number(url.port) : 80;
          const rest = [
            ...lines.filter(line => !line.toLowerCase().startsWith('x-studio-agent-broker:')),
            ...(isLoopbackHost(host) || connectDenied.has(normalizeHost(host))
              ? [`X-Studio-Agent-Broker: ${brokerMarker}`]
              : []),
          ].join('\r\n');
          upstreamHead = `${method} ${url.pathname}${url.search} HTTP/1.1\r\n${rest}\r\n\r\n`;
        } catch {
          client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
          return;
        }
      }
      if (!isAllowed(host, port) || (method === 'CONNECT' && (isLoopbackHost(host) || connectDenied.has(normalizeHost(host))))) {
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      const upstream = net.connect({ host, port });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      upstream.once('connect', () => {
        if (method === 'CONNECT') client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        else if (upstreamHead) upstream.write(upstreamHead);
        const remainder = header.slice(end + 4);
        if (remainder.length) upstream.write(remainder, 'latin1');
        client.pipe(upstream).pipe(client);
      });
    };
    client.on('data', onData);
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    let failure: unknown;
    if (server.listening) {
      try {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      } catch (error) { failure = error; }
    }
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  };
  try {
    faultInjector?.('broker-listen');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
    faultInjector?.('broker-chmod');
    fs.chmodSync(directory, 0o711);
    fs.chmodSync(socketPath, 0o666);
  } catch (error) {
    try { await close(); } catch { /* preserve initialization failure */ }
    throw error;
  }
  return { socketPath, directory, close };
}

const FORWARDER_SOURCE = String.raw`
const net=require('net'),fs=require('fs');
const server=net.createServer(client=>{
  const upstream=net.connect(process.argv[1]);
  upstream.on('error',()=>client.destroy()); client.on('error',()=>upstream.destroy());
  client.pipe(upstream).pipe(client);
});
server.listen(Number(process.argv[3]),'127.0.0.1',()=>fs.writeFileSync(process.argv[2],''));
`;

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

export async function prepareAgentSandbox(opts: AgentSandboxOptions): Promise<AgentSandboxHandle> {
  const worktree = assertSupported(opts);
  const sandboxHome = path.join(worktree, '.daemon', 'home');
  fs.mkdirSync(sandboxHome, { recursive: true });
  const restorePermissions = prepareWorktreePermissions(worktree);
  let identity: ReturnType<typeof issueAgentServiceIdentity> | undefined;
  let broker: Broker | undefined;
  try {
    identity = issueAgentServiceIdentity({ executionId: opts.executionId, ttlMs: opts.ttlMs ?? 35 * 60_000 });
    opts.faultInjector?.('after-identity');
    const callback = process.env.STUDIO_AGENT_CALLBACK_URL ?? 'http://localhost:13101/api/v1/executions/events';
    const callbackHost = new URL(callback).hostname;
    broker = await startEgressBroker(opts.egress ?? resolveAgentEgress(opts.provider), identity.brokerMarker, [callbackHost], opts.faultInjector);
    opts.faultInjector?.('after-broker');
    const proxyPort = await availablePort();
    const env: NodeJS.ProcessEnv = {
    ...opts.env,
    HOME: sandboxHome,
    USER: 'studio-agent',
    LOGNAME: 'studio-agent',
    XDG_CONFIG_HOME: path.join(sandboxHome, '.config'),
    XDG_CACHE_HOME: path.join(sandboxHome, '.cache'),
    XDG_DATA_HOME: path.join(sandboxHome, '.local/share'),
    NPM_CONFIG_CACHE: path.join(sandboxHome, '.npm'),
    STUDIO_AGENT_TOKEN: identity.token,
    STUDIO_AGENT_CALLBACK_URL: callback,
    HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
    HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    ALL_PROXY: `http://127.0.0.1:${proxyPort}`,
    http_proxy: `http://127.0.0.1:${proxyPort}`,
    https_proxy: `http://127.0.0.1:${proxyPort}`,
    all_proxy: `http://127.0.0.1:${proxyPort}`,
    NO_PROXY: '',
    no_proxy: '',
    NODE_USE_ENV_PROXY: '1',
    NODE_NO_WARNINGS: '1',
  };
  const args: string[] = [
    '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
    '--dir', '/etc', '--chmod', '755', '/etc',
    '--ro-bind-try', '/etc/ssl', '/etc/ssl', '--ro-bind-try', '/etc/ca-certificates', '/etc/ca-certificates',
    '--ro-bind-try', '/etc/localtime', '/etc/localtime',
    '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--chmod', '1777', '/tmp',
    '--dir', '/run', '--bind', broker.socketPath, '/run/studio-agent-egress.sock',
    '--bind', worktree, worktree, '--chdir', worktree,
  ];
  addParentAccess(args, worktree);
  addExecutableMounts(args, opts.provider, opts.env.PATH, worktree);
  addHarnessMounts(args, worktree);
  addCredentialMounts(args, opts.provider, os.homedir(), sandboxHome);
  const ready = path.join('/tmp', `broker-ready-${randomBytes(6).toString('hex')}`);
  const privilege = `/usr/bin/setpriv --reuid=${AGENT_UID} --regid=${AGENT_GID} --groups=${AGENT_GID} --no-new-privs`;
  const forwarder = `${privilege} ${shellQuote(fs.realpathSync(process.execPath))} -e ${shellQuote(FORWARDER_SOURCE)} /run/studio-agent-egress.sock ${shellQuote(ready)} ${proxyPort}`;
  const launcher = [
    `${forwarder} &`, 'forwarder_pid=$!',
    `trap 'kill "$forwarder_pid" 2>/dev/null || true' EXIT`,
    `for i in $(seq 1 100); do [ -f ${shellQuote(ready)} ] && break; sleep 0.05; done`,
    `[ -f ${shellQuote(ready)} ] || exit 125`,
    `exec ${privilege} /bin/bash -c ${shellQuote(opts.command)}`,
  ].join('\n');
  let disposed = false;
  return {
    command: `bwrap ${args.map(shellQuote).join(' ')} -- /bin/bash -c ${shellQuote(launcher)}`,
    env,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      revokeAgentServiceIdentity(identity!.token);
      let failure: unknown;
      try { await broker!.close(); } catch (error) { failure = error; }
      try { restorePermissions(); } catch (error) { failure ??= error; }
      if (failure) throw failure;
    },
  };
  } catch (error) {
    if (identity) revokeAgentServiceIdentity(identity.token);
    if (broker) {
      try { await broker.close(); } catch { /* preserve initialization failure */ }
    }
    try { restorePermissions(); } catch { /* preserve initialization failure */ }
    throw error;
  }
}
