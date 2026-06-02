// Studio Event Bus — 内存 pub/sub
// 单进程 EventEmitter，零外部依赖
// 支持通配符匹配（events:* 匹配 events:task）

import { EventEmitter } from 'events';

type EventHandler = (payload: any) => void | Promise<void>;

class StudioEventBus {
  private emitter = new EventEmitter();
  private listeners = new Map<string, Set<EventHandler>>();

  // 发布事件
  publish(channel: string, payload: any) {
    // 精确匹配
    this.emitter.emit(channel, payload);
    // 通配符匹配
    for (const [pattern, handlers] of this.listeners) {
      if (this.matchPattern(pattern, channel)) {
        for (const handler of handlers) {
          try { handler(payload); } catch (e) { console.error(`[EventBus] handler error for ${channel}:`, e); }
        }
      }
    }
  }

  // 订阅事件
  subscribe(channel: string, handler: EventHandler) {
    if (channel.includes('*')) {
      if (!this.listeners.has(channel)) {
        this.listeners.set(channel, new Set());
      }
      this.listeners.get(channel)!.add(handler);
    } else {
      this.emitter.on(channel, handler);
    }
  }

  // 取消订阅
  unsubscribe(channel: string, handler: EventHandler) {
    if (channel.includes('*')) {
      this.listeners.get(channel)?.delete(handler);
    } else {
      this.emitter.off(channel, handler);
    }
  }

  // 一次性订阅
  once(channel: string, handler: EventHandler) {
    this.emitter.once(channel, handler);
  }

  // 通配符匹配：events:* 匹配 events:task
  private matchPattern(pattern: string, channel: string): boolean {
    if (pattern === channel) return true;
    if (pattern.endsWith('*')) {
      return channel.startsWith(pattern.slice(0, -1));
    }
    return false;
  }

  // 清空所有监听器（用于测试）
  clear() {
    this.emitter.removeAllListeners();
    this.listeners.clear();
  }
}

// 全局单例
export const eventBus = new StudioEventBus();
export { StudioEventBus };
