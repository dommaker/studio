// 预置示例工作流
export const exampleWorkflows = [
  {
    id: 'example-hello',
    name: '🚀 Hello World',
    description: '最简单的示例：让 AI 说 Hello',
    category: 'demo',
    nodes: [
      {
        id: 'node-1',
        name: '问候生成器',
        agentType: 'test-agent',
        config: { prompt: '请用友好的语气说 Hello World' },
        position: { x: 200, y: 150 }
      }
    ],
    edges: [],
    parameters: []
  },
  {
    id: 'example-code',
    name: '💻 代码生成器',
    description: '根据需求描述生成代码',
    category: 'demo',
    nodes: [
      {
        id: 'node-1',
        name: '代码生成',
        agentType: 'code-generator',
        config: { prompt: '写一个 TypeScript 函数，计算斐波那契数列', language: 'typescript' },
        position: { x: 200, y: 150 }
      }
    ],
    edges: [],
    parameters: []
  }
];

export const workflowCategories = [
  { id: 'demo', name: '示例', icon: '📚' },
  { id: 'code', name: '代码', icon: '💻' },
  { id: 'test', name: '测试', icon: '🧪' },
];
