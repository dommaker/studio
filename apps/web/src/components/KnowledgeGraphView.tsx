import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  useReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
} from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

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

interface KnowledgeGraphViewProps {
  graph: KnowledgeGraph;
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string | null) => void;
  highlightNodeIds?: string[];
  diffMode?: boolean;
  changedNodeIds?: Set<string>;
  affectedNodeIds?: Set<string>;
}

/**
 * 节点颜色映射
 */
const NODE_COLORS: Record<string, string> = {
  function: '#3b82f6', // blue
  class: '#8b5cf6',    // purple
  module: '#10b981',   // green
  file: '#6b7280',     // gray
  concept: '#f59e0b',  // amber
  config: '#ef4444',   // red
  service: '#06b6d4',  // cyan
  endpoint: '#ec4899', // pink
  table: '#84cc16',    // lime
};

/**
 * 复杂度颜色映射
 */
const COMPLEXITY_COLORS: Record<string, string> = {
  simple: 'var(--success)',
  moderate: 'var(--warning)',
  complex: 'var(--error)',
};

/**
 * 自定义节点组件
 */
function CustomKnowledgeNode({ data }: { data: any }) {
  const {
    label,
    nodeType,
    summary,
    complexity,
    isSelected,
    isHighlighted,
    isDiffChanged,
    isDiffAffected,
    isDiffFaded,
  } = data;

  let borderColor = NODE_COLORS[nodeType] || 'var(--text-muted)';
  let bgColor = 'var(--bg-elevated)';
  let opacity = 1;

  if (isDiffChanged) {
    borderColor = 'var(--error)';
    bgColor = 'var(--error-dim)';
  } else if (isDiffAffected) {
    borderColor = 'var(--warning)';
    bgColor = 'var(--warning-dim)';
  } else if (isDiffFaded) {
    opacity = 0.3;
  }

  if (isSelected) {
    borderColor = 'var(--accent-primary)';
  }

  if (isHighlighted) {
    bgColor = 'var(--accent-dim)';
  }

  return (
    <div
      style={{
        padding: '8px 12px',
        borderRadius: '8px',
        border: `2px solid ${borderColor}`,
        background: bgColor,
        opacity,
        minWidth: '120px',
        maxWidth: '200px',
        fontSize: '12px',
      }}
    >
      <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
        {label}
      </div>
      <div style={{ color: 'var(--text-secondary)', fontSize: '10px', marginBottom: '4px' }}>
        {nodeType}
      </div>
      <div style={{ color: 'var(--text-tertiary)', fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {summary}
      </div>
      <div style={{ marginTop: '4px', display: 'flex', gap: '4px' }}>
        <span
          style={{
            fontSize: '9px',
            padding: '2px 4px',
            borderRadius: '4px',
            background: COMPLEXITY_COLORS[complexity] || 'var(--text-muted)',
            color: 'var(--bg-primary)',
          }}
        >
          {complexity}
        </span>
      </div>
    </div>
  );
}

const nodeTypes = {
  custom: CustomKnowledgeNode,
};

/**
 * 布局算法（简化的 dagre）
 */
function applySimpleLayout(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
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
 * 内部视图组件
 */
function KnowledgeGraphViewInner({
  graph,
  selectedNodeId,
  onNodeSelect,
  highlightNodeIds = [],
  diffMode = false,
  changedNodeIds = new Set(),
  affectedNodeIds = new Set(),
}: KnowledgeGraphViewProps) {
  const { fitView } = useReactFlow();

  // 构建节点和边
  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => {
    const flowNodes: Node[] = graph.nodes.map((node) => ({
      id: node.id,
      type: 'custom',
      position: { x: 0, y: 0 },
      data: {
        label: node.name,
        nodeType: node.type,
        summary: node.summary,
        complexity: node.complexity,
        isSelected: selectedNodeId === node.id,
        isHighlighted: highlightNodeIds.includes(node.id),
        isDiffChanged: diffMode && changedNodeIds.has(node.id),
        isDiffAffected: diffMode && affectedNodeIds.has(node.id),
        isDiffFaded: diffMode && !changedNodeIds.has(node.id) && !affectedNodeIds.has(node.id),
      },
    }));

    const flowEdges: Edge[] = graph.edges.map((edge, i) => ({
      id: `e-${i}`,
      source: edge.source,
      target: edge.target,
      label: edge.type,
      animated: edge.type === 'calls',
      style: {
        stroke: 'var(--border-default)',
        strokeWidth: 1 + edge.weight,
      },
      labelStyle: { fill: 'var(--text-tertiary)', fontSize: 10 },
    }));

    return applySimpleLayout(flowNodes, flowEdges);
  }, [graph, selectedNodeId, highlightNodeIds, diffMode, changedNodeIds, affectedNodeIds]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const prevNodesJson = useRef<string>('');
  const prevEdgesJson = useRef<string>('');

  useEffect(() => {
    const nodesJson = JSON.stringify(initialNodes);
    const edgesJson = JSON.stringify(initialEdges);
    if (nodesJson !== prevNodesJson.current) {
      prevNodesJson.current = nodesJson;
      setNodes(initialNodes);
    }
    if (edgesJson !== prevEdgesJson.current) {
      prevEdgesJson.current = edgesJson;
      setEdges(initialEdges);
    }
  }, [initialNodes, initialEdges]);

  // 选中节点时聚焦
  useEffect(() => {
    if (selectedNodeId) {
      requestAnimationFrame(() => {
        fitView({
          nodes: [{ id: selectedNodeId }],
          duration: 500,
          padding: 0.3,
          maxZoom: 1.2,
        });
      });
    }
  }, [selectedNodeId, fitView]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: { id: string }) => {
      onNodeSelect?.(node.id);
    },
    [onNodeSelect],
  );

  const onPaneClick = useCallback(() => {
    onNodeSelect?.(null);
  }, [onNodeSelect]);

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ minZoom: 0.01, padding: 0.1 }}
        minZoom={0.01}
        maxZoom={2}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} color="#333" gap={20} size={1} />
        <Controls />
        <MiniMap
          nodeColor="#1e293b"
          maskColor="rgba(0, 0, 0, 0.8)"
          className="!bg-slate-900 !border !border-slate-700"
        />
      </ReactFlow>
    </div>
  );
}

/**
 * 知识图谱视图组件
 * 
 * 复用 understand-anything 的 GraphView 逻辑，
 * 用于 Agent-Studio 的代码可视化。
 */
export default function KnowledgeGraphView(props: KnowledgeGraphViewProps) {
  if (!props.graph) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-slate-900 rounded-lg">
        <p className="u-text-2 text-sm">No knowledge graph loaded</p>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <KnowledgeGraphViewInner {...props} />
    </ReactFlowProvider>
  );
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
