/**
 * 事件系统
 *
 * 通用 EventEmitter 封装，从 agent-platform/runtime 提取。
 * 适用于所有需要事件驱动的模块。
 */
export type EventHandler = (event: Event) => void;
export interface Event {
    type: string;
    data?: any;
    timestamp: Date;
}
export declare class EventEmitter {
    private emitter;
    on(event: string, handler: EventHandler): this;
    once(event: string, handler: EventHandler): this;
    off(event: string, handler?: EventHandler): this;
    emit(type: string, data?: any): void;
    removeAllListeners(): void;
}
export declare const Events: {
    readonly STEP_STARTED: "step.started";
    readonly STEP_PROGRESS: "step.progress";
    readonly STEP_COMPLETED: "step.completed";
    readonly STEP_FAILED: "step.failed";
    readonly STEP_SKIPPED: "step.skipped";
    readonly TOOL_STARTED: "tool.started";
    readonly TOOL_COMPLETED: "tool.completed";
    readonly TOOL_FAILED: "tool.failed";
    readonly AGENT_STARTED: "agent.started";
    readonly AGENT_PROGRESS: "agent.progress";
    readonly AGENT_COMPLETED: "agent.completed";
    readonly AGENT_FAILED: "agent.failed";
};
//# sourceMappingURL=event-emitter.d.ts.map