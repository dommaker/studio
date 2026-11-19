/**
 * logger-node 测试（P2.5 logger 双轨统一）
 *
 * 锁定 pino 正本的合同：
 * 1. 是 Logger & pino.Logger 交集——console 版调用形态 (msg, meta) 与
 *    pino 结构化形态 (obj, msg) 都接受（类型层 + 运行时不抛）
 * 2. 级别方法齐全，level 随 LOG_LEVEL（缺省 info）
 * 3. 运行时是裸 pino 实例（pino 版本无关断言：有 child/level 等 pino 特征）
 */
import { describe, it, expect } from 'vitest';
import { logger } from '../logger-node';
import type { Logger } from '../logger';

describe('logger-node（pino 正本）', () => {
  it('满足 console 版 Logger 接口（编译期 + 运行期）', () => {
    const l: Logger = logger;
    expect(typeof l.info).toBe('function');
    expect(typeof l.warn).toBe('function');
    expect(typeof l.error).toBe('function');
    expect(typeof l.debug).toBe('function');
  });

  it('两种调用形态均合法（msg,meta）与（obj,msg）', () => {
    expect(() => {
      logger.info('[test] msg-meta 形态', { meta: 1 });
      logger.info({ structured: true }, '[test] obj-msg 形态');
      logger.warn('[test] warn', { meta: 1 });
      logger.error('[test] error', { meta: 1 });
    }).not.toThrow();
  });

  it('level 随 LOG_LEVEL（缺省 info），具备 pino 实例特征', () => {
    expect(logger.level).toBe(process.env.LOG_LEVEL || 'info');
    expect(typeof logger.child).toBe('function');
    expect(typeof logger.isLevelEnabled).toBe('function');
  });
});
