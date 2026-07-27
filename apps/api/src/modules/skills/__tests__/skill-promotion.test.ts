/**
 * skill-promotion tests（D11 promote 门禁）
 *
 * 门禁：① SKILL.md 实体存在 ② frontmatter 有 name+description+triggers ③ 引用路径真实存在。
 * 通过 → frontmatter status=published（正文逐字节保留）+ manifest 缓存失效。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Isolated test skills dir（SKILLS_DIR 在模块加载时读取，必须先设再 import）
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-test-'));
process.env.SKILLS_DIR = testSkillsDir;

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  FileStore: vi.fn(),
  recordDecision: vi.fn(),
}));

const { validateSkillForPromotion, promoteSkill, extractReferencedPaths } = await import('../skill-promotion.js');
const { loadManifest, invalidateManifestCache } = await import('../manifest-loader.js');

function writeSkill(dirName: string, content: string) {
  const dir = path.join(testSkillsDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
}

function cleanupSkills() {
  for (const dir of fs.readdirSync(testSkillsDir)) {
    fs.rmSync(path.join(testSkillsDir, dir), { recursive: true, force: true });
  }
}

const GOOD_FRONTMATTER = `---
name: gate-ok
description: "门禁测试 skill"
triggers: [测试, gate]
status: draft
---`;

describe('skill-promotion（D11 门禁）', () => {
  beforeEach(() => {
    invalidateManifestCache();
    cleanupSkills();
  });

  afterEach(() => {
    cleanupSkills();
  });

  describe('validateSkillForPromotion', () => {
    it('① SKILL.md 不存在 → 拒绝并说明', () => {
      const r = validateSkillForPromotion('gate-missing');
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toContain('SKILL.md 不存在');
    });

    it('② frontmatter 缺 description/triggers → 拒绝并列出缺失字段', () => {
      writeSkill('gate-no-fields', `---\nname: gate-no-fields\n---\n\n# body\n`);
      const r = validateSkillForPromotion('gate-no-fields');
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toContain('description');
      expect(r.errors.join(' ')).toContain('triggers');
    });

    it('② 无 frontmatter → 拒绝', () => {
      writeSkill('gate-no-fm', `# 只有正文\n`);
      const r = validateSkillForPromotion('gate-no-fm');
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toContain('frontmatter');
    });

    it('② 多行 triggers 写法（- 列表）也认可', () => {
      writeSkill('gate-multiline', `---\nname: gate-multiline\ndescription: "多行 triggers"\ntriggers:\n  - 测试\n  - gate\n---\n\n# body\n`);
      const r = validateSkillForPromotion('gate-multiline');
      expect(r.ok).toBe(true);
    });

    it('③ 引用不存在的 ~/ 路径 → 拒绝并指出路径', () => {
      writeSkill('gate-bad-ref', `${GOOD_FRONTMATTER}\n\n读 \`~/.studio/definitely-not-exists-promote-gate\` 的数据。\n`);
      const r = validateSkillForPromotion('gate-bad-ref');
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toContain('~/.studio/definitely-not-exists-promote-gate');
    });

    it('③ 引用真实存在的绝对路径 → 通过', () => {
      const realFile = path.join(testSkillsDir, 'fixture-data.json');
      fs.writeFileSync(realFile, '{}', 'utf-8');
      writeSkill('gate-good-ref', `${GOOD_FRONTMATTER}\n\n数据源：\`${realFile}\`。\n`);
      const r = validateSkillForPromotion('gate-good-ref');
      expect(r.ok).toBe(true);
    });

    it('③ glob 引用退化为父目录存在性（父目录存在 → 通过）', () => {
      writeSkill('gate-glob', `${GOOD_FRONTMATTER}\n\n条目在 \`${testSkillsDir}/*.md\`。\n`);
      const r = validateSkillForPromotion('gate-glob');
      expect(r.ok).toBe(true);
    });

    it('③ HTTP 端点与 <placeholder> 路径不参与校验', () => {
      writeSkill('gate-skip', `${GOOD_FRONTMATTER}\n\n调 \`POST /api/v1/requirements\` 创建，挂 \`docs/sdd/<slug>/\`。\n`);
      const r = validateSkillForPromotion('gate-skip');
      expect(r.ok).toBe(true);
    });
  });

  describe('extractReferencedPaths', () => {
    it('提取 ~/ 与绝对路径，跳过 URL/placeholder/HTTP 端点', () => {
      const refs = extractReferencedPaths(
        'a `~/.studio/knowledge/*.md` b https://x.com/a c `/etc/hosts` d `GET /api/v1/skills` e `<dir>/x`'
      );
      const displays = refs.map(r => r.display);
      expect(displays).toContain('~/.studio/knowledge/*.md');
      expect(displays).toContain('/etc/hosts');
      expect(displays).not.toContain('/api/v1/skills');
      expect(refs.find(r => r.display.startsWith('~/'))!.resolved).toBe(
        path.join(os.homedir(), '.studio/knowledge/*.md')
      );
    });
  });

  describe('promoteSkill', () => {
    it('门禁通过 → frontmatter status=published，正文逐字节保留，匹配池立即可见', () => {
      const body = '\n# 正文\n\n保留我。\n';
      writeSkill('gate-ok', `${GOOD_FRONTMATTER}${body}`);

      // promote 前：status=draft 不进匹配池
      expect(loadManifest().find(s => s.name === 'gate-ok')).toBeUndefined();

      const r = promoteSkill('gate-ok');
      expect(r.ok).toBe(true);
      expect(r.errors).toEqual([]);

      const raw = fs.readFileSync(path.join(testSkillsDir, 'gate-ok', 'SKILL.md'), 'utf-8');
      expect(raw).toContain('status: published');
      expect(raw.endsWith(body)).toBe(true); // 正文逐字节保留
      expect(raw).not.toContain('status: draft');

      // promote 后：进匹配池（缓存已失效）
      expect(loadManifest().find(s => s.name === 'gate-ok')).toBeDefined();
    });

    it('门禁拒绝 → 文件不动', () => {
      const content = `---\nname: gate-reject\n---\n\n# body\n`;
      writeSkill('gate-reject', content);
      const r = promoteSkill('gate-reject');
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
      expect(fs.readFileSync(path.join(testSkillsDir, 'gate-reject', 'SKILL.md'), 'utf-8')).toBe(content);
    });
  });
});
