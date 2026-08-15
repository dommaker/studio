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
import { applySimpleLayout } from './knowledge/graphUtils';
import type { KnowledgeGraph } from './knowledge/graphUtils';
import { useTheme } from '../contexts/ThemeContext';

// 图谱数据类型与纯函数（布局/diff 分析/构建）已抽至 components/knowledge/graphUtils（工单 34-E5）；
// 此处仅保留类型 re-export 门面（图谱视图唯一消费方 WikiPage 已随 #155 阅览室改造退役，组件暂留备用）；
// buildKnowledgeGraphFromAnalysis / analyzeDiffImpact 无经本文件的 import 方，请直接从 graphUtils 导入。
export type { KnowledgeNode, KnowledgeEdge, Layer, KnowledgeGraph } from './knowledge/graphUtils';

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
 * 节点颜色映射（分类色板 → theme.css `--chart-1…9`，深/浅主题各自取值）
 */
const NODE_COLORS: Record<string, string> = {
  function: 'var(--chart-1)', // blue
  class: 'var(--chart-2)',    // purple
  module: 'var(--chart-3)',   // green
  file: 'var(--chart-4)',     // gray
  concept: 'var(--chart-5)',  // amber
  config: 'var(--chart-6)',   // red
  service: 'var(--chart-7)',  // cyan
  endpoint: 'var(--chart-8)', // pink
  table: 'var(--chart-9)',    // lime
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
interface CustomKnowledgeNodeData {
  label: string;
  nodeType: string;
  summary: string;
  complexity: string;
  isSelected: boolean;
  isHighlighted: boolean;
  isDiffChanged: boolean;
  isDiffAffected: boolean;
  isDiffFaded: boolean;
}

function CustomKnowledgeNode({ data }: { data: CustomKnowledgeNodeData }) {
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
  const { resolvedTheme } = useTheme();

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
  }, [initialNodes, initialEdges, setNodes, setEdges]);

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
        colorMode={resolvedTheme}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls />
        <MiniMap
          maskColor={resolvedTheme === 'dark' ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.7)'}
          style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-default)' }}
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
      <div className="h-full w-full flex items-center justify-center rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
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
