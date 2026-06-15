"use strict";
/**
 * Agent Executor - Facade
 *
 * Session Loop 执行模型 (daemon async spawn)
 *
 * P11-02: Split into sub-modules:
 *   worktree-resolver.ts — git worktree 创建 + harness 配置传播 + 文件桥
 *   output-capture.ts — 进度读取 + 输出文件收集 + session 指标记录
 *   session-manager.ts — AgentExecutor 类 + session loop + prompt 构建
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConstraintMeta = exports.recordExecutionError = exports.emitFileChange = exports.emitToolCall = exports.emitSessionEnd = exports.emitSessionStart = exports.recordSessionMetrics = exports.parseJsonEnvelope = exports.collectOutputFiles = exports.readProgress = exports.ensureDeps = exports.writeContractTests = exports.writeRequirementsMd = exports.buildCachePrefix = exports.propagateHarnessConfig = exports.createWorktree = exports.agentRunner = exports.AgentRunner = exports.agentExecutor = exports.AgentExecutor = void 0;
// Re-export AgentExecutor class and singleton
var session_manager_js_1 = require("./session-manager.js");
Object.defineProperty(exports, "AgentExecutor", { enumerable: true, get: function () { return session_manager_js_1.AgentExecutor; } });
Object.defineProperty(exports, "agentExecutor", { enumerable: true, get: function () { return session_manager_js_1.agentExecutor; } });
// Re-export AgentRunner (unified executor)
var agent_runner_js_1 = require("./agent-runner.js");
Object.defineProperty(exports, "AgentRunner", { enumerable: true, get: function () { return agent_runner_js_1.AgentRunner; } });
Object.defineProperty(exports, "agentRunner", { enumerable: true, get: function () { return agent_runner_js_1.agentRunner; } });
// Re-export worktree-resolver functions
var worktree_resolver_js_1 = require("./worktree-resolver.js");
Object.defineProperty(exports, "createWorktree", { enumerable: true, get: function () { return worktree_resolver_js_1.createWorktree; } });
Object.defineProperty(exports, "propagateHarnessConfig", { enumerable: true, get: function () { return worktree_resolver_js_1.propagateHarnessConfig; } });
Object.defineProperty(exports, "buildCachePrefix", { enumerable: true, get: function () { return worktree_resolver_js_1.buildCachePrefix; } });
Object.defineProperty(exports, "writeRequirementsMd", { enumerable: true, get: function () { return worktree_resolver_js_1.writeRequirementsMd; } });
Object.defineProperty(exports, "writeContractTests", { enumerable: true, get: function () { return worktree_resolver_js_1.writeContractTests; } });
Object.defineProperty(exports, "ensureDeps", { enumerable: true, get: function () { return worktree_resolver_js_1.ensureDeps; } });
// Re-export output-capture functions
var output_capture_js_1 = require("./output-capture.js");
Object.defineProperty(exports, "readProgress", { enumerable: true, get: function () { return output_capture_js_1.readProgress; } });
Object.defineProperty(exports, "collectOutputFiles", { enumerable: true, get: function () { return output_capture_js_1.collectOutputFiles; } });
Object.defineProperty(exports, "parseJsonEnvelope", { enumerable: true, get: function () { return output_capture_js_1.parseJsonEnvelope; } });
Object.defineProperty(exports, "recordSessionMetrics", { enumerable: true, get: function () { return output_capture_js_1.recordSessionMetrics; } });
Object.defineProperty(exports, "emitSessionStart", { enumerable: true, get: function () { return output_capture_js_1.emitSessionStart; } });
Object.defineProperty(exports, "emitSessionEnd", { enumerable: true, get: function () { return output_capture_js_1.emitSessionEnd; } });
Object.defineProperty(exports, "emitToolCall", { enumerable: true, get: function () { return output_capture_js_1.emitToolCall; } });
Object.defineProperty(exports, "emitFileChange", { enumerable: true, get: function () { return output_capture_js_1.emitFileChange; } });
Object.defineProperty(exports, "recordExecutionError", { enumerable: true, get: function () { return output_capture_js_1.recordExecutionError; } });
Object.defineProperty(exports, "getConstraintMeta", { enumerable: true, get: function () { return output_capture_js_1.getConstraintMeta; } });
