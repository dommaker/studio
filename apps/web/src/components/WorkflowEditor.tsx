// WorkflowEditor.tsx - 工作流编辑器主组件（重构版）
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node,
  type NodeTypes,
  type ReactFlowInstance,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { CustomNode } from './CustomNode';
import { ToolStdPanel } from './ToolStdPanel';
import { WorkflowConfigPanel } from './WorkflowConfigPanel';
import { useWorkflowEditorStore, type Step } from '../stores/workflowEditorStore';
import '../styles/theme.css';

// 自定义节点类型 - default 和 custom 都使用 CustomNode
const nodeTypes: NodeTypes = {
  default: CustomNode,
  custom: CustomNode,
  input: CustomNode,
  output: CustomNode,
};

export function WorkflowEditor() {
  const { id } = useParams();
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [_reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);

  const { nodes: storeNodes, edges: storeEdges, loadSteps, loadWorkflow } = useWorkflowEditorStore();

  // 使用 React Flow 的状态管理
  const [nodes, setNodes, onNodesChange] = useNodesState(storeNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(storeEdges);

  // 同步 store 节点到本地状态
  useEffect(() => {
    if (storeNodes.length > 0) {
      setNodes(storeNodes);
    }
  }, [storeNodes, setNodes]);

  useEffect(() => {
    if (storeEdges.length > 0) {
      setEdges(storeEdges);
    }
  }, [storeEdges, setEdges]);

  // 加载步骤列表和工作流数据
  useEffect(() => {
    loadSteps();
    // 如果有工作流 ID，加载工作流数据
    if (id && id !== 'new') {
      loadWorkflow(id);
    }
  }, [loadSteps, loadWorkflow, id]);

  // 连接节点
  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
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

  // 拖拽放置（简化版：点击添加）
  const onAddNode = useCallback((step: Step) => {
    // 居中显示，垂直排列
    const centerX = 300;
    const startY = 50;
    const stepHeight = 120;
    const nodeCount = nodes.length;

    const newNode: Node = {
      id: `${step.id}-${Date.now()}`,
      type: 'custom',
      position: { x: centerX, y: startY + nodeCount * stepHeight },
      data: {
        label: step.skill || step.step || step.id,
        step: step,
      },
    };

    setNodes((nds) => [...nds, newNode]);
  }, [nodes.length]);

  // 更新节点数据
  const onUpdateNode = useCallback((nodeId: string, data: Partial<Node['data']>) => {
    setNodes((nds) =>
      nds.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node
      )
    );
    
    setSelectedNode((prev) =>
      prev && prev.id === nodeId
        ? { ...prev, data: { ...prev.data, ...data } }
        : prev
    );
  }, [setNodes]);

  return (
    <div className="flex h-[calc(100vh-120px)] w-full">
      {/* 左侧步骤面板 */}
      <div 
        className="w-64 overflow-y-auto" 
        style={{ borderRight: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)' }}
      >
        <ToolStdPanel onAddNode={onAddNode} />
      </div>

      {/* 中间画布 */}
      <div 
        ref={reactFlowWrapper}
        className="flex-1"
        style={{ background: 'var(--bg-primary)' }}
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
        <WorkflowConfigPanel 
          selectedNode={selectedNode}
          onUpdateNode={onUpdateNode}
        />
      </div>
    </div>
  );
}

export default WorkflowEditor;
