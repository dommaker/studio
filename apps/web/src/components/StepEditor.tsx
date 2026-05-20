// StepEditor.tsx - 步骤编辑器主组件（节点选择 + 保存功能）
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type Node,
  type NodeTypes,
  type ReactFlowInstance,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { CustomNode } from './CustomNode';
import { Toolbox } from './Toolbox';
import { ConfigPanel } from './ConfigPanel';
import { useStepEditorStore } from '../stores/stepEditorStore';
import '../styles/theme.css';

// 自定义节点类型 - 所有类型都使用 CustomNode
const nodeTypes: NodeTypes = {
  default: CustomNode,
  custom: CustomNode,
  input: CustomNode,
  output: CustomNode,
};

// 初始节点和边
const initialNodes: Node[] = [
  {
    id: 'start',
    type: 'custom',
    data: { label: '开始', icon: '▶️' },
    position: { x: 250, y: 25 },
  },
];

const initialEdges: Edge[] = [];

interface StepEditorProps {
  stepId?: string; // 编辑模式时传入步骤 ID
}

export function StepEditor({ stepId }: StepEditorProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);

  const { 
    nodes: storeNodes, 
    edges: storeEdges, 
    loadTools, 
    loadStep,
  } = useStepEditorStore();

  // 使用 React Flow 的状态管理
  const [nodes, setLocalNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setLocalEdges, onEdgesChange] = useEdgesState(initialEdges);

  // 加载工具列表
  useEffect(() => {
    loadTools();
  }, [loadTools]);

  // 编辑模式：加载步骤详情
  useEffect(() => {
    if (stepId) {
      loadStep(stepId);
    }
  }, [stepId, loadStep]);

  // 同步 store 节点到本地状态
  useEffect(() => {
    if (storeNodes.length > 0) {
      setLocalNodes(storeNodes);
    }
  }, [storeNodes, setLocalNodes]);

  useEffect(() => {
    if (storeEdges.length > 0) {
      setLocalEdges(storeEdges);
    }
  }, [storeEdges, setLocalEdges]);

  // 连接节点
  const onConnect = useCallback(
    (params: Connection) => setLocalEdges(addEdge(params, edges)),
    [setLocalEdges, edges]
  );

  // 选择节点
  const onSelectionChange = useCallback(
    (params: OnSelectionChangeParams) => {
      if (params.nodes.length > 0) {
        setSelectedNode(params.nodes[0]);
      } else {
        setSelectedNode(null);
      }
    },
    []
  );

  // 拖拽放置
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const data = event.dataTransfer.getData('application/reactflow');
      if (!data) return;

      const { type, tool } = JSON.parse(data);
      if (type !== 'tool' || !tool) return;

      // 获取画布位置
      if (!reactFlowInstance || !reactFlowWrapper.current) return;

      const bounds = reactFlowWrapper.current.getBoundingClientRect();
      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });

      // 创建新节点
      const newNode: Node = {
        id: `${tool.id}-${Date.now()}`,
        type: 'custom',
        position,
        data: { 
          label: tool.name,
          tool: tool,
        },
      };

      setLocalNodes([...nodes, newNode]);
    },
    [reactFlowInstance, nodes, setLocalNodes]
  );

  // 更新节点数据
  const onUpdateNode = useCallback((nodeId: string, data: Partial<Node['data']>) => {
    const updatedNodes = nodes.map((node) =>
      node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node
    );
    setLocalNodes(updatedNodes);
    
    // 更新选中的节点
    setSelectedNode((prev) =>
      prev && prev.id === nodeId
        ? { ...prev, data: { ...prev.data, ...data } }
        : prev
    );
  }, [nodes, setLocalNodes]);

  return (
    <div className="flex h-[calc(100vh-120px)] w-full">
      {/* 左侧工具箱 */}
      <div 
        className="w-64 overflow-y-auto"
        style={{ borderRight: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)' }}
      >
        <Toolbox />
      </div>

      {/* 中间画布 */}
      <div 
        ref={reactFlowWrapper}
        className="flex-1"
        style={{ background: 'var(--bg-primary)' }}
        onDrop={onDrop}
        onDragOver={onDragOver}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onInit={setReactFlowInstance}
          onSelectionChange={onSelectionChange}
          nodeTypes={nodeTypes}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>

      {/* 右侧配置面板 */}
      <div 
        className="w-80 overflow-y-auto"
        style={{ borderLeft: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)' }}
      >
        <ConfigPanel 
          selectedNode={selectedNode}
          onUpdateNode={onUpdateNode}
        />
      </div>
    </div>
  );
}

export default StepEditor;
