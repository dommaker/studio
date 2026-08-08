// ─── 通用 Markdown / Frontmatter（从 file-store.ts 抽出）───

/**
 * 解析 markdown 文件的 YAML frontmatter。
 * 泛化版 parseSddFrontmatter：meta 使用 Record<string, unknown> 而非 SDD 专用类型。
 */
export function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const yaml = match[1];
  const body = match[2].trim();
  const meta: Record<string, unknown> = {};

  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, val] = kv;

    // 数组：[a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1)
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    // 数字
    else if (/^\d+$/.test(val)) {
      meta[key] = parseInt(val, 10);
    }
    // 字符串（去引号）
    else {
      meta[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  return { meta, body };
}

/**
 * 序列化 meta + body 为 markdown 文件内容（含 YAML frontmatter）。
 */
export function serializeFrontmatter(meta: Record<string, unknown>, body: string): string {
  const lines: string[] = [];

  for (const [key, val] of Object.entries(meta)) {
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      if (val.length > 0) {
        lines.push(`${key}: [${val.map(v => `"${String(v)}"`).join(', ')}]`);
      }
    } else if (typeof val === 'number') {
      lines.push(`${key}: ${val}`);
    } else {
      lines.push(`${key}: "${String(val)}"`);
    }
  }

  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}
