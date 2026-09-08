// per-agent 确定性头像图样（#440 Phase 4）— identicon 式：
// name 双 hash → 调色板序号（--chart-1..9）+ 5x5 网格左 3 列点亮位（右两列镜像成对称图形）。
// 纯函数、零依赖，频道消息气泡与 agent profile 页共用（同 agent 名恒同图）。
// 前身是 AuthorAvatar 内嵌的 nameHue（hsl 色块+首字），#440 抽出并升级为图形化。

export interface AvatarPattern {
  /** 调色板序号 0..8 → CSS var(--chart-(n+1)) */
  paletteIndex: number;
  /** 5 行 × 左 3 列的点亮位（右两列由 avatarCellAt 镜像得出） */
  cells: boolean[];
}

/** 简单散列（同名跨会话恒定）；seed 区分两路用途（选色 / 点阵） */
function hash(name: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

export function avatarPattern(name: string): AvatarPattern {
  const paletteIndex = hash(name, 0) % 9;
  const bits = hash(name, 0x9e3779b9);
  const cells: boolean[] = [];
  for (let i = 0; i < 15; i++) cells.push(((bits >> i) & 1) === 1);
  // 兜底：全空 → 点亮中心格（不出现纯空头像）
  if (!cells.some(Boolean)) cells[7] = true;
  return { paletteIndex, cells };
}

/** 5x5 网格取格：右两列镜像左两列（col 3←1, col 4←0），identicon 对称形态由此保证 */
export function avatarCellAt(pattern: AvatarPattern, row: number, col: number): boolean {
  const c = col < 3 ? col : 4 - col;
  return pattern.cells[row * 3 + c];
}
