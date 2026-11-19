import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const workflowsDir = join(process.cwd(), '.github/workflows');
type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | number>;
};
type Workflow = {
  jobs?: Record<
    string,
    { if?: string; permissions?: Record<string, string>; steps?: Step[] }
  >;
};

function loadWorkflow(filename: string): Workflow {
  return yaml.load(readFileSync(join(workflowsDir, filename), 'utf8')) as Workflow;
}

function runAutoMerge(pullRequests: Array<Record<string, unknown>>) {
  const workflow = loadWorkflow('auto-merge.yml');
  const step = workflow.jobs?.['enable-auto-merge']?.steps?.[0];
  if (!step?.run) throw new Error('auto-merge run step missing');

  const binDir = mkdtempSync(join(tmpdir(), 'auto-merge-gh-'));
  try {
    const log = join(binDir, 'gh.log');
    const gh = join(binDir, 'gh');
    writeFileSync(log, '');
    writeFileSync(
      gh,
      `#!/bin/bash
printf '%s\\n' "$*" >> "$GH_LOG"
if [[ " $* " == *" list "* ]]; then
  if [[ " $* " == *" --jq "* ]]; then
    node -e 'const prs = JSON.parse(process.env.PRS_JSON); console.log(prs[0]?.number ?? "")'
  else
    printf '%s' "$PRS_JSON"
  fi
fi
`,
    );
    chmodSync(gh, 0o755);
    const renderedRun = step.run.replaceAll('${{ github.repository }}', '"$REPOSITORY"');
    const result = spawnSync('bash', ['-c', renderedRun], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GH_LOG: log,
        GH_TOKEN: 'test-token',
        HEAD_BRANCH: 'feature',
        HEAD_SHA: 'a'.repeat(40),
        REPOSITORY: 'dommaker/studio',
        PRS_JSON: JSON.stringify(pullRequests),
      },
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return readFileSync(log, 'utf8').trim().split('\n');
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

describe('workflow 静态安全门', () => {
  it('run 不直接插值 github.event.*', () => {
    for (const filename of readdirSync(workflowsDir).filter((name) => name.endsWith('.yml'))) {
      const workflow = loadWorkflow(filename);
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        for (const [index, step] of (job.steps ?? []).entries()) {
          expect(step.run ?? '', `${filename}:${jobName}:steps[${index}]`).not.toMatch(
            /\$\{\{\s*github\.event\./,
          );
        }
      }
    }
  });

  it('所有第三方 Actions 固定到完整 commit SHA', () => {
    for (const filename of readdirSync(workflowsDir).filter((name) => name.endsWith('.yml'))) {
      const workflow = loadWorkflow(filename);
      for (const job of Object.values(workflow.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (step.uses) expect(step.uses, `${filename}:${step.uses}`).toMatch(/^[^@]+@[0-9a-f]{40}$/);
        }
      }
    }
  });

  it.each(['ci.yml', 'release.yml', 'perf-gate.yml'])('%s 使用 corepack、固定 pnpm 和 frozen lockfile', (filename) => {
    const rootManifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { packageManager?: string };
    expect(rootManifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    const workflow = loadWorkflow(filename);
    const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
    const commands = steps.map((step) => step.run ?? '');
    expect(commands.some((command) => command.includes('corepack enable'))).toBe(true);
    expect(commands.join('\n')).not.toContain('npm install -g pnpm');
    const installs = commands.flatMap((command) => command.split('\n').filter((line) => line.includes('pnpm install')));
    expect(installs.length).toBeGreaterThan(0);
    for (const install of installs) expect(install).toContain('--frozen-lockfile');
  });

  it.each(['ci.yml', 'release.yml'])('%s 保留生产依赖 audit 和全历史 secret scan', (filename) => {
    const workflow = loadWorkflow(filename);
    const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(steps.some((step) => step.uses?.startsWith('gitleaks/gitleaks-action@'))).toBe(true);
    expect(steps.some((step) => step.run?.includes(
      'pnpm audit --prod --audit-level high --registry=https://registry.npmjs.org',
    ))).toBe(true);
  });

  it('Dependabot 每周持续更新 npm 与 GitHub Actions', () => {
    const config = yaml.load(readFileSync(join(process.cwd(), '.github/dependabot.yml'), 'utf8')) as {
      updates?: Array<{ 'package-ecosystem'?: string; schedule?: { interval?: string } }>;
    };
    for (const ecosystem of ['npm', 'github-actions']) {
      expect(config.updates?.some((update) =>
        update['package-ecosystem'] === ecosystem && update.schedule?.interval === 'weekly',
      )).toBe(true);
    }
  });

  it('auto-merge 校验 PR 事件来源、字面传参且不使用 PAT', () => {
    const workflow = loadWorkflow('auto-merge.yml');
    const job = workflow.jobs?.['enable-auto-merge'];
    const step = job?.steps?.[0];
    expect(job?.if).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(job?.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(job?.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' });
    expect(step?.env?.HEAD_BRANCH).toBe('${{ github.event.workflow_run.head_branch }}');
    expect(step?.env?.HEAD_SHA).toBe('${{ github.event.workflow_run.head_sha }}');
    expect(step?.run).toContain('"$HEAD_BRANCH"');
    expect(step?.env?.GH_TOKEN).toBe('${{ github.token }}');
  });
});

describe('auto-merge 副作用门', () => {
  it('fork PR 不触发 merge', () => {
    const calls = runAutoMerge([
      {
        number: 42,
        state: 'OPEN',
        headRefOid: 'a'.repeat(40),
        headRepository: { nameWithOwner: 'attacker/studio' },
        isCrossRepository: true,
      },
    ]);
    expect(calls.some((call) => call.startsWith('pr list '))).toBe(true);
    expect(calls.some((call) => call.startsWith('pr merge '))).toBe(false);
  });

  it('同名分支的 PR head SHA 不匹配时不触发 merge', () => {
    const calls = runAutoMerge([
      {
        number: 43,
        state: 'OPEN',
        headRefOid: 'b'.repeat(40),
        headRepository: { nameWithOwner: 'dommaker/studio' },
        isCrossRepository: false,
      },
    ]);
    expect(calls.some((call) => call.startsWith('pr merge '))).toBe(false);
  });

  it('已关闭 PR 不触发 merge', () => {
    const calls = runAutoMerge([
      {
        number: 44,
        state: 'CLOSED',
        headRefOid: 'a'.repeat(40),
        headRepository: { nameWithOwner: 'dommaker/studio' },
        isCrossRepository: false,
      },
    ]);
    expect(calls.some((call) => call.startsWith('pr merge '))).toBe(false);
  });

  it('无关联 PR 不触发 merge', () => {
    const calls = runAutoMerge([]);
    expect(calls.some((call) => call.startsWith('pr merge '))).toBe(false);
  });

  it('同 SHA 仍关联多个开放 PR 时不触发 merge', () => {
    const pr = {
      state: 'OPEN',
      headRefOid: 'a'.repeat(40),
      headRepository: { nameWithOwner: 'dommaker/studio' },
      isCrossRepository: false,
    };
    const calls = runAutoMerge([
      { ...pr, number: 45 },
      { ...pr, number: 46 },
    ]);
    expect(calls.some((call) => call.startsWith('pr merge '))).toBe(false);
  });

  it('同仓同 SHA 的唯一开放 PR 精确触发 merge', () => {
    const calls = runAutoMerge([
      {
        number: 45,
        state: 'OPEN',
        headRefOid: 'a'.repeat(40),
        headRepository: { nameWithOwner: 'dommaker/studio' },
        isCrossRepository: false,
      },
    ]);
    expect(calls.some((call) => call.startsWith('pr merge 45 '))).toBe(true);
  });
});
