/**
 * Tests for patch-sdd-changelog.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_SDD = join(__dirname, '.test-sdd-patch-changelog');

// Must set SDD_DIR before importing the module under test
const origSddDir = process.env.SDD_DIR;

function writeRequirement(slug: string, fields: Record<string, string>) {
  const dir = join(TEST_SDD, slug);
  mkdirSync(dir, { recursive: true });
  const fm = Object.entries(fields).map(([k, v]) => `${k}: "${v}"`).join('\n');
  writeFileSync(join(dir, 'requirement.md'), `---\n${fm}\n---\n\n# ${slug}\n`);
}

beforeEach(() => {
  process.env.SDD_DIR = TEST_SDD;
  mkdirSync(TEST_SDD, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_SDD, { recursive: true, force: true });
  if (origSddDir === undefined) {
    delete process.env.SDD_DIR;
  } else {
    process.env.SDD_DIR = origSddDir;
  }
});

// Dynamic import so SDD_DIR is set before module loads
async function loadPatcher() {
  const mod = await import('../patch-sdd-changelog');
  return mod.patchSddChangelogs;
}

describe('patch-sdd-changelog', () => {
  it('creates CHANGELOG for non-historical dirs without one', async () => {
    writeRequirement('my-feature', {
      id: 'id1',
      slug: 'my-feature',
      title: 'My Feature',
      status: 'confirmed',
      sourceChannelId: 'ch-123',
      createdAt: '2026-06-10T02:22:37.888Z',
    });

    const patch = await loadPatcher();
    const results = await patch(true, TEST_SDD);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('created');
    expect(results[0].slug).toBe('my-feature');
  });

  it('skips historical-* dirs', async () => {
    writeRequirement('historical-architecture', {
      id: 'id-hist',
      slug: 'historical-architecture',
      title: 'Historical',
      status: 'done',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const patch = await loadPatcher();
    const results = await patch(true, TEST_SDD);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('skipped-historical');
  });

  it('skips dirs that already have CHANGELOG.md', async () => {
    writeRequirement('existing-changelog', {
      id: 'id2',
      slug: 'existing-changelog',
      title: 'Existing',
      status: 'draft',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    writeFileSync(join(TEST_SDD, 'existing-changelog', 'CHANGELOG.md'), '# CHANGELOG\n');

    const patch = await loadPatcher();
    const results = await patch(true, TEST_SDD);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('skipped-exists');
  });

  it('skips dirs without requirement.md', async () => {
    mkdirSync(join(TEST_SDD, 'no-req'), { recursive: true });

    const patch = await loadPatcher();
    const results = await patch(true, TEST_SDD);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('skipped-no-requirement');
  });

  it('dry-run does not create files', async () => {
    writeRequirement('dry-test', {
      id: 'id3',
      slug: 'dry-test',
      title: 'Dry Test',
      status: 'confirmed',
      sourceChannelId: 'ch-456',
      createdAt: '2026-06-10T02:22:37.888Z',
    });

    const patch = await loadPatcher();
    await patch(true, TEST_SDD);

    expect(existsSync(join(TEST_SDD, 'dry-test', 'CHANGELOG.md'))).toBe(false);
  });

  it('execute creates files with correct content', async () => {
    writeRequirement('exec-test', {
      id: 'id4',
      slug: 'exec-test',
      title: 'Exec Test',
      status: 'done',
      sourceChannelId: 'ch-789',
      createdAt: '2026-06-10T02:22:37.888Z',
    });

    const patch = await loadPatcher();
    const results = await patch(false, TEST_SDD);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('created');

    const content = readFileSync(join(TEST_SDD, 'exec-test', 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('# CHANGELOG');
    expect(content).toContain('Migrated from RequirementsDoc DB table');
    expect(content).toContain('Status**: done');
    expect(content).toContain('Source**: ch-789');
    expect(content).toContain('2026-06-10T02:22:37.888Z');
  });

  it('execute is idempotent — second run skips already-created', async () => {
    writeRequirement('idempotent-test', {
      id: 'id5',
      slug: 'idempotent-test',
      title: 'Idempotent',
      status: 'draft',
      createdAt: '2026-06-10T02:22:37.888Z',
    });

    const patch = await loadPatcher();
    await patch(false, TEST_SDD);
    const results2 = await patch(false, TEST_SDD);

    expect(results2[0].action).toBe('skipped-exists');
  });

  it('handles mixed batch: some need CHANGELOG, some skip', async () => {
    writeRequirement('needs-changelog', {
      id: 'id6',
      slug: 'needs-changelog',
      title: 'Needs',
      status: 'confirmed',
      createdAt: '2026-06-10T02:22:37.888Z',
    });
    writeRequirement('historical-pitfall', {
      id: 'id7',
      slug: 'historical-pitfall',
      title: 'Historical',
      status: 'done',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    writeRequirement('already-has', {
      id: 'id8',
      slug: 'already-has',
      title: 'Already',
      status: 'draft',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    writeFileSync(join(TEST_SDD, 'already-has', 'CHANGELOG.md'), '# CHANGELOG\n');

    const patch = await loadPatcher();
    const results = await patch(true, TEST_SDD);

    expect(results).toHaveLength(3);
    expect(results.find(r => r.slug === 'needs-changelog')!.action).toBe('created');
    expect(results.find(r => r.slug === 'historical-pitfall')!.action).toBe('skipped-historical');
    expect(results.find(r => r.slug === 'already-has')!.action).toBe('skipped-exists');
  });
});
