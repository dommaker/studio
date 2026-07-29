/**
 * 事件系统
 *
 * 通用 EventEmitter 封装，从 agent-platform/runtime 提取。
 * 适用于所有需要事件驱动的模块。
 */
import { EventEmitter as EE } from 'eventemitter3';
export class EventEmitter {
    emitter = new EE();
    on(event, handler) {
        this.emitter.on(event, handler);
        return this;
    }
    once(event, handler) {
        this.emitter.once(event, handler);
        return this;
    }
    off(event, handler) {
        this.emitter.off(event, handler);
        return this;
    }
    emit(type, data) {
        const event = {
            type,
            data,
            timestamp: new Date()
        };
        this.emitter.emit(type, event);
        this.emitter.emit('*', event);
    }
    removeAllListeners() {
        this.emitter.removeAllListeners();
    }
}
// 事件类型常量
export const Events = {
    STEP_STARTED: 'step.started',
    STEP_PROGRESS: 'step.progress',
    STEP_COMPLETED: 'step.completed',
    STEP_FAILED: 'step.failed',
    STEP_SKIPPED: 'step.skipped',
    TOOL_STARTED: 'tool.started',
    TOOL_COMPLETED: 'tool.completed',
    TOOL_FAILED: 'tool.failed',
    AGENT_STARTED: 'agent.started',
    AGENT_PROGRESS: 'agent.progress',
    AGENT_COMPLETED: 'agent.completed',
    AGENT_FAILED: 'agent.failed',
};
//# sourceMappingURL=event-emitter.js.map