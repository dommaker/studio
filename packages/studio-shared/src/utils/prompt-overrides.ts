/**
 * E1 约束进化（vision §6）：prompt 模板文件覆盖机制。
 *
 * Studio 的 prompt 模板是 TS 源码内联字符串，进化提案生效时**不改写源码**，
 * 而是写覆盖文件 `~/.studio/prompt-overrides/<templateId>.md`，prompt 构建时
 * 优先读覆盖文件。覆盖目录可用 `STUDIO_PROMPT_OVERRIDES_DIR` 覆盖（测试注入）。
 *
 * 当前支持的 templateId（prompt-builder / knowledge-curator 内的接线处）：
 *   - knowledge.rules-section      注入区段「## 系统约束」（{content} = 动态条目行）
 *   - knowledge.context-section    注入区段「## 上下文」（{content} = 动态条目行）
 *   - knowledge.signals-section    注入区段「## 近期信号」（{content} = 动态信号行）
 *   - knowledge.reference-hint     参考库提示行（{count} = 条目数）
 *   - knowledge.skills-section     已激活 Skills 区段（{content} = skill 索引）
 *   - knowledge.extract-from-text  EXTRACT_FROM_TEXT_SYSTEM_PROMPT 全量替换（无占位符）
 *
 * 覆盖文件语义：文本中 `{content}`/`{count}` 占位符被替换为动态内容；
 * 没有占位符时覆盖文本整体替换静态部分（动态内容追加其后，extract-from-text 除外）。
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { studioPath } from '../config/studio-dir';

/** 覆盖目录解析（每次调用现算，支持测试中途改 env）。 */
export function resolvePromptOverridesDir(): string {
  return process.env.STUDIO_PROMPT_OVERRIDES_DIR || studioPath('prompt-overrides');
}

/**
 * 读取模板覆盖文本。不存在/读取失败 → null（回退默认模板）。
 * templateId 净化：拒绝路径分隔符，防目录穿越。
 */
export function readPromptOverride(templateId: string): string | null {
  if (!templateId || /[/\\]/.test(templateId) || templateId.includes('..')) return null;
  try {
    const file = join(resolvePromptOverridesDir(), `${templateId}.md`);
    if (!existsSync(file)) return null;
    const text = readFileSync(file, 'utf-8');
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * 用覆盖文件渲染模板：无覆盖 → 原样返回 fallback（默认行为零变化）。
 * 有覆盖 → 替换 {content}/{count} 占位符；覆盖文本无 {content} 且提供了 content
 * 时，动态内容追加到覆盖文本之后（保证动态条目不丢）。
 */
export function renderWithOverride(
  templateId: string,
  fallback: string,
  vars?: { content?: string; count?: number },
): string {
  const override = readPromptOverride(templateId);
  if (override === null) return fallback;
  let out = override;
  let substituted = false;
  if (vars?.content !== undefined && out.includes('{content}')) {
    out = out.split('{content}').join(vars.content);
    substituted = true;
  }
  if (vars?.count !== undefined) {
    out = out.split('{count}').join(String(vars.count));
  }
  if (vars?.content && !substituted) {
    out = `${out.replace(/\s+$/, '')}\n${vars.content}`;
  }
  return out;
}
