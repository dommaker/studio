/**
 * MCP Server - Model Context Protocol 服务器
 *
 * 将 Studio 系统能力暴露为 MCP tools，供 Agent 和 UI 共享调用。
 * 支持两种传输方式：
 * 1. stdio: 用于本地 Agent（如 Claude Code）
 * 2. HTTP/SSE: 用于远程 Agent 和 UI
 */

import { getToolSchemas, executeTool } from './tools.js';
import { logger } from '@dommaker/studio-shared';

// ─── MCP 协议类型 ───

interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, any>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface MCPToolCall {
  name: string;
  arguments: Record<string, any>;
}

// ─── MCP 错误码 ───

const MCPErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

// ─── MCP Server ───

export class MCPServer {
  private name: string;
  private version: string;

  constructor(name = 'agent-studio', version = '1.0.0') {
    this.name = name;
    this.version = version;
  }

  /**
   * 处理 MCP 请求
   */
  async handleRequest(request: MCPRequest): Promise<MCPResponse> {
    try {
      switch (request.method) {
        case 'initialize':
          return this.handleInitialize(request);
        case 'tools/list':
          return this.handleToolsList(request);
        case 'tools/call':
          return this.handleToolsCall(request);
        default:
          return {
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: MCPErrorCode.MethodNotFound,
              message: `Method not found: ${request.method}`,
            },
          };
      }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: MCPErrorCode.InternalError,
          message: String(error),
        },
      };
    }
  }

  /**
   * initialize - 返回服务器信息和能力
   */
  private handleInitialize(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: this.name,
          version: this.version,
        },
      },
    };
  }

  /**
   * tools/list - 返回所有可用 tools
   */
  private handleToolsList(request: MCPRequest): MCPResponse {
    const tools = getToolSchemas();
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { tools },
    };
  }

  /**
   * tools/call - 执行指定 tool
   */
  private async handleToolsCall(request: MCPRequest): Promise<MCPResponse> {
    const { name, arguments: args } = request.params as MCPToolCall || {};

    if (!name) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: MCPErrorCode.InvalidParams,
          message: 'Missing tool name',
        },
      };
    }

    const result = await executeTool(name, args || {}, (request.params as any)?.roleId);

    if (!result.success) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [
            {
              type: 'text',
              text: `Error: ${(result as unknown as { error?: string }).error}`,
            },
          ],
          isError: true,
        },
      };
    }

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result.result, null, 2),
          },
        ],
      },
    };
  }

  /**
   * 处理 stdio 输入（逐行 JSON-RPC）
   */
  async handleStdio(): Promise<void> {
    const readline = await import('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    logger.info('MCP server started on stdio');

    rl.on('line', async (line: string) => {
      try {
        const request = JSON.parse(line) as MCPRequest;
        const response = await this.handleRequest(request);
        process.stdout.write(JSON.stringify(response) + '\n');
      } catch (error) {
        const errorResponse: MCPResponse = {
          jsonrpc: '2.0',
          id: 0,
          error: {
            code: MCPErrorCode.ParseError,
            message: `Parse error: ${error}`,
          },
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
      }
    });

    rl.on('close', () => {
      logger.info('MCP server stdio closed');
      process.exit(0);
    });
  }
}

// 单例
export const mcpServer = new MCPServer();
