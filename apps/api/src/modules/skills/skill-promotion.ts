/**
 * D11 skill promote 门禁（draft → published）。
 *
 * 现状链路：提案 approve（#354 起经 review-proposal 正本 adapter onApprove，skills/review-adapter.ts）→ 磁盘 SKILL.md
 * frontmatter status=draft + 索引 status=draft；promote（routes POST /:id/publish）
 * 是进入匹配池的唯一闸门。匹配池（manifest-loader.loadManifest / skill-selector /
 * skill-loader.loadSkillFromDisk）只认磁盘 frontmatter：status 缺省或 published 才参与。
 *
 * 门禁（任一不满足即拒绝，说明原因）：
 *   ① SKILL.md 实体存在（SKILLS_DIR/<name>/SKILL.md）
 *   ② frontmatter 有 name + description + triggers（缺 triggers 的 skill 无法软绑定）
 *   ③ 文档中引用的文件路径真实存在（~/ 与深度 ≥2 的绝对路径；glob 尾段退化为父目录存在性；
 *      HTTP 端点写法（GET /xxx）、URL、<placeholder>/YYYY-MM-DD 日期模式与相对路径不校验；路径字符集限 ASCII，
 *      含 CJK 的路径会被截断——中文文档中的"做什么/不做什么"类行文因此不会误判）
 *
 * 通过：frontmatter status → published（setSkillFrontmatterStatus，正文逐字节保留）
 *   + invalidateManifestCache（匹配池立即生效）
 *   + 索引（skills-index.json）同名 draft/testing 记录同步 published（best-effort）
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { setSkillFrontmatterStatus } from './skill-demotion.js';
import { invalidateManifestCache } from './manifest-loader.js';
import { skillStore } from './skill-store.js';

const SKILLS_DIR = process.env.SKILLS_DIR || studioPath('skills');

export interface PromotionResult {
  ok: boolean;
  /** 拒绝原因（门禁逐条说明）；ok=true 时为空 */
  errors: string[];
}

// ── ② frontmatter 校验 ──

interface PromotionFrontmatter {
  name: string;
  description: string;
  hasTriggers: boolean;
}

/**
 * 解析 frontmatter 的 name/description/triggers（行内 [a, b] 与多行 `- x` 两种 triggers 写法都认，
 * 比 manifest-loader 的行内解析宽——门禁只关心"有没有"，不关心触发词内容）。
 */
function parsePromotionFrontmatter(content: string): PromotionFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  let name = '';
  let description = '';
  let hasTriggers = false;
  const lines = match[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    const cleaned = val.replace(/^["']|["']$/g, '').trim();
    if (key === 'name') name = cleaned;
    if (key === 'description') description = cleaned;
    if (key === 'triggers') {
      if (cleaned && cleaned !== '[]') hasTriggers = true;
      else {
        // 多行写法：triggers: 后跟 `  - xxx` 列表项
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s+-\s*\S/.test(lines[j])) { hasTriggers = true; break; }
          if (/^\S/.test(lines[j])) break; // 下一个顶层 key，无列表项
        }
      }
    }
  }
  return { name, description, hasTriggers };
}

// ── ③ 引用路径校验 ──

/**
 * 提取文档中引用的可定位文件路径：`~/...` 与 `/...` 绝对路径。
 * 跳过：URL（含 ://）、含 <placeholder> 的参数化路径、相对路径（无定位基准）。
 * 返回 ~ 已展开为 homedir 的路径与原文展示的 token。
 */
export function extractReferencedPaths(content: string): Array<{ display: string; resolved: string }> {
  const results: Array<{ display: string; resolved: string }> = [];
  const seen = new Set<string>();
  // 路径字符集限定 ASCII：中文标点/正文在首个非路径字符处自然截断（CJK 路径会被截断，取舍见模块头注释）。
  // ~/ 分支不限深度；/ 分支要求深度 ≥2（/x/y），避免 "master/main"、URL 路径段一类行文误判。
  const re = /[`"']?(~\/[A-Za-z0-9._~*\/-]*|\/[A-Za-z0-9._~*\/-]*\/[A-Za-z0-9._~*\/-]*)[`"']?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    let token = m[1];
    if (content[m.index - 1] === ':') continue; // URL scheme（https://...）
    // 紧前字符是路径字符 → 是更长相对路径的尾巴（docs/sdd/ → /sdd），不是独立绝对路径
    if (/[A-Za-z0-9._~*/-]/.test(content[m.index - 1] ?? '')) continue;
    // HTTP 端点（`GET /api/v1/xxx` 写法）不是文件路径：同行前缀是 HTTP 动词则跳过
    const lineStart = content.lastIndexOf('\n', m.index) + 1;
    if (/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*[`"']*$/.test(content.slice(lineStart, m.index))) continue;
    if (token.includes('YYYY')) continue; // 日期模式路径（YYYY-MM-DD.md），同 <placeholder> 处理
    token = token.replace(/[?#].*$/, ''); // 查询串/锚点
    token = token.replace(/[.,;/:]+$/, ''); // 句尾标点与结尾斜杠
    if (!token || token === '~') continue;
    const resolved = token.startsWith('~/') ? path.join(os.homedir(), token.slice(2)) : token;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    results.push({ display: token, resolved });
  }
  return results;
}

/** glob 尾段（含 *）退化为首个 * 之前的父目录；否则原样 */
function toCheckablePath(p: string): string {
  const star = p.indexOf('*');
  if (star === -1) return p;
  const head = p.slice(0, star);
  const dir = head.endsWith('/') ? head.slice(0, -1) : path.dirname(head);
  return dir || '/';
}

// ── 门禁 ──

/**
 * 校验 skill 是否可 promote。不修改任何文件。
 */
export function validateSkillForPromotion(skillName: string, skillsDir?: string): PromotionResult {
  const dir = skillsDir ?? SKILLS_DIR;
  const errors: string[] = [];

  // ① SKILL.md 实体存在
  const skillFile = path.join(dir, skillName, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    return { ok: false, errors: [`SKILL.md 不存在: ${skillFile}（先完成提案审批落盘或手工创建）`] };
  }

  const content = fs.readFileSync(skillFile, 'utf-8');

  // ② frontmatter 有 name + description + triggers
  const meta = parsePromotionFrontmatter(content);
  if (!meta) {
    errors.push('SKILL.md 缺少 frontmatter（--- 包裹的元数据块）');
  } else {
    const missing: string[] = [];
    if (!meta.name) missing.push('name');
    if (!meta.description) missing.push('description');
    if (!meta.hasTriggers) missing.push('triggers');
    if (missing.length > 0) {
      errors.push(`frontmatter 缺必填字段: ${missing.join(', ')}（promote 要求 name+description+triggers 齐全）`);
    }
  }

  // ③ 引用的文件路径真实存在
  for (const ref of extractReferencedPaths(content)) {
    if (!fs.existsSync(toCheckablePath(ref.resolved))) {
      errors.push(`引用的路径不存在: ${ref.display}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * promote：门禁全过 → frontmatter status=published + 匹配池缓存失效 + 索引同步。
 * 任一门禁不满足 → 不动任何文件，返回原因。
 */
export function promoteSkill(skillName: string, opts?: { skillsDir?: string }): PromotionResult {
  const dir = opts?.skillsDir ?? SKILLS_DIR;
  const validation = validateSkillForPromotion(skillName, dir);
  if (!validation.ok) {
    logger.warn('[SkillPromotion] Rejected by gate', { skillName, errors: validation.errors });
    return validation;
  }

  setSkillFrontmatterStatus(skillName, 'published', dir);
  invalidateManifestCache();

  // 索引同步（best-effort）：同名 draft/testing 记录 → published
  try {
    for (const record of skillStore.list({ name: skillName })) {
      if (record.status === 'draft' || record.status === 'testing') {
        skillStore.update(record.id, { status: 'published' });
      }
    }
  } catch (e) {
    logger.warn('[SkillPromotion] skills-index sync failed (non-blocking)', { skillName, error: String(e) });
  }

  logger.info('[SkillPromotion] Promoted', { skillName });
  return { ok: true, errors: [] };
}
