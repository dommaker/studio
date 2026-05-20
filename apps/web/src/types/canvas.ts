/**
 * 共享画布类型（xyflow 兼容，避免直接导入 xyflow 打包）
 */

export interface Position {
  x: number;
  y: number;
}

export interface Node<T = any> {
  id: string;
  position: Position;
  data: T;
  type?: string;
}

export interface Edge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  animated?: boolean;
  type?: string;
}
