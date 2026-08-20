/**
 * 尾斜杠/反斜杠归一（纯函数，无 Node 依赖 —— 前后端共用）。
 * PMO gitRepo、workspaceRoot、project-discovery 扫描路径的写法差
 * （尾斜杠有无、Windows 反斜杠）不对齐比较/去重键。
 */
export function stripTrailingSlashes(p: string): string {
  return p.replace(/[/\\]+$/, '');
}
