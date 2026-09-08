// #436 C9：阅览室文档页标题去重——页头恒渲染 doc.title，正文首个 ATX H1
// 与标题重复时剥除（仅首个内容行；mid-doc 同名 H1 不动，那是正文结构）。
// 纯函数抽出以便单测。只认 ATX `# ` 形态；Setext（=== 下划线）不处理。

/**
 * 正文首个内容行是与 title 重复的 H1 时剥掉该行（含紧跟的空行）；否则原文返回。
 * title 为空或 content 为空时原样返回。
 */
export function stripDuplicateH1(content: string, title: string): string {
  const t = title.trim();
  if (!content || !t) return content;
  const m = content.match(/^\s*#[ \t]+([^\n]+?)[ \t]*(?:\n|$)(?:[ \t]*\n)*/);
  if (!m || m[1].trim() !== t) return content;
  return content.slice(m[0].length);
}
