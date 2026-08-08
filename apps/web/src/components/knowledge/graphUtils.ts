// 知识图谱纯函数模块（2026-08 工单 34 从 components/KnowledgeGraphView.tsx 抽出，逻辑零变更）
// 承载图谱数据类型、简化 dagre 布局算法、diff 影响分析与图谱构建工具；视图组件只负责渲染。

import type { Edge, Node } from '@xyflow/react';

/**
 * 知识图谱节点数据
 */
export interface KnowledgeNode {
  id: string;
  type: 'function' | 'class' | 'module' | 'file' | 'concept' | 'config' | 'service' | 'endpoint' | 'table';
  name: string;
  filePath?: string;
  lineRange?: [number, number];
  summary: string;
  tags: string[];
  complexity: 'simple' | 'moderate' | 'complex';
}

/**
 * 知识图谱边数据
 */
export interface KnowledgeEdge {
  source: string;
  target: string;
  type: 'calls' | 'imports' | 'contains' | 'inherits' | 'depends_on' | 'related';
  weight: number;
}

/**
 * 架构层级
 */
export interface Layer {
  id: string;
  name: string;
  description: string;
  nodeIds: string[];
}

/**
 * 知识图谱数据
 */
export interface KnowledgeGraph {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  layers: Layer[];
}

/**
 * 布局算法（简化的 dagre）
 */
export function applySimpleLayout(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const nodeWidth = 160;
  const nodeHeight = 80;
  const horizontalGap = 50;
  const verticalGap = 30;

  // 构建邻接表
  const adjList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  nodes.forEach((n) => {
    adjList.set(n.id, []);
    inDegree.set(n.id, 0);
  });

  edges.forEach((e) => {
    adjList.get(e.source)?.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
  });

  // 拓扑排序层级
  const levels: string[][] = [];
  const visited = new Set<string>();
  const queue: string[] = [];

  // 找到所有入度为 0 的节点
  nodes.forEach((n) => {
    if ((inDegree.get(n.id) || 0) === 0) {
      queue.push(n.id);
    }
  });

  while (queue.length > 0 || visited.size < nodes.length) {
    const level: string[] = [];
    const nextQueue: string[] = [];

    queue.forEach((id) => {
      if (!visited.has(id)) {
        visited.add(id);
        level.push(id);

        adjList.get(id)?.forEach((target) => {
          const newInDegree = (inDegree.get(target) || 1) - 1;
          inDegree.set(target, newInDegree);
          if (newInDegree === 0 && !visited.has(target)) {
            nextQueue.push(target);
          }
        });
      }
    });

    if (level.length > 0) {
      levels.push(level);
    }

    queue.length = 0;
    queue.push(...nextQueue);

    // 处理孤立节点
    if (queue.length === 0 && visited.size < nodes.length) {
      nodes.forEach((n) => {
        if (!visited.has(n.id)) {
          visited.add(n.id);
          if (levels.length === 0) {
            levels.push([n.id]);
          } else {
            levels[levels.length - 1].push(n.id);
          }
        }
      });
    }
  }

  // 分配位置
  const positionedNodes = nodes.map((node) => {
    let levelIndex = 0;
    let posInLevel = 0;

    for (let i = 0; i < levels.length; i++) {
      const idx = levels[i].indexOf(node.id);
      if (idx !== -1) {
        levelIndex = i;
        posInLevel = idx;
        break;
      }
    }

    const levelSize = levels[levelIndex]?.length || 1;
    const levelWidth = levelSize * (nodeWidth + horizontalGap);
    const startX = -levelWidth / 2;

    return {
      ...node,
      position: {
        x: startX + posInLevel * (nodeWidth + horizontalGap),
        y: levelIndex * (nodeHeight + verticalGap),
      },
    };
  });

  return { nodes: positionedNodes, edges };
}

/**
 * 构建知识图谱的工具函数
 */
export function buildKnowledgeGraphFromAnalysis(analysis: {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  layers?: Layer[];
}): KnowledgeGraph {
  return {
    nodes: analysis.nodes,
    edges: analysis.edges,
    layers: analysis.layers || [],
  };
}

/**
 * 分析 Git diff 影响范围
 */
export function analyzeDiffImpact(
  graph: KnowledgeGraph,
  changedFiles: string[],
): {
  changedNodes: KnowledgeNode[];
  affectedNodes: KnowledgeNode[];
  impactedEdges: KnowledgeEdge[];
} {
  const changedNodeIds = new Set<string>();

  // 映射变更文件到节点
  for (const file of changedFiles) {
    for (const node of graph.nodes) {
      if (node.filePath === file) {
        changedNodeIds.add(node.id);
      }
    }
  }

  const changedNodes = graph.nodes.filter((n) => changedNodeIds.has(n.id));

  // 查找受影响节点
  const affectedNodeIds = new Set<string>();
  const impactedEdges: KnowledgeEdge[] = [];

  for (const edge of graph.edges) {
    const sourceChanged = changedNodeIds.has(edge.source);
    const targetChanged = changedNodeIds.has(edge.target);

    if (sourceChanged || targetChanged) {
      impactedEdges.push(edge);
      if (sourceChanged && !changedNodeIds.has(edge.target)) {
        affectedNodeIds.add(edge.target);
      }
      if (targetChanged && !changedNodeIds.has(edge.source)) {
        affectedNodeIds.add(edge.source);
      }
    }
  }

  const affectedNodes = graph.nodes.filter((n) => affectedNodeIds.has(n.id));

  return { changedNodes, affectedNodes, impactedEdges };
}
