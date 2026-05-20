// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { parseArgs, parseJsonArg, parseKeyValueArg } from '../parser';

/**
 * AC-001: 参数解析支持 -c --company --format=json
 * 
 * 测试覆盖：
 * - 正常情况：短参数、长参数、JSON格式
 * - 边界情况：无参数、混合参数
 * - 错误情况：未知参数、JSON格式错误
 */
describe('AC-001: 参数解析', () => {
  describe('正常情况', () => {
    test('AC-001-1: 支持短参数 -c', () => {
      const result = parseArgs(['-c', '1']);
      expect(result.options.c).toBe('1');
    });

    test('AC-001-2: 支持长参数 --company', () => {
      const result = parseArgs(['--company', '1']);
      expect(result.options.company).toBe('1');
    });

    test('AC-001-3: 支持 key=value 格式 --company=1', () => {
      const result = parseArgs(['--company=1']);
      expect(result.options.company).toBe('1');
    });

    test('AC-001-4: 支持 JSON 格式 --format={"type":"table"}', () => {
      const result = parseArgs(['--format={"type":"table"}']);
      expect(result.options.format.type).toBe('table');
    });

    test('AC-001-5: 支持混合参数', () => {
      const result = parseArgs(['balance', '-c', '1', '--format=json', '--user=admin']);
      expect(result.command).toBe('balance');
      expect(result.options.c).toBe('1');
      expect(result.options.format).toBe('json');
      expect(result.options.user).toBe('admin');
    });
  });

  describe('边界情况', () => {
    test('AC-001-6: 无参数时返回空 options', () => {
      const result = parseArgs(['balance']);
      expect(result.command).toBe('balance');
      expect(result.options).toEqual({});
    });

    test('AC-001-7: 只有位置参数', () => {
      const result = parseArgs(['cmd', 'arg1', 'arg2']);
      expect(result.command).toBe('cmd');
      expect(result.positional).toEqual(['arg1', 'arg2']);
      expect(result.options).toEqual({});
    });

    test('AC-001-8: 参数值为空字符串', () => {
      const result = parseArgs(['--company', '']);
      expect(result.options.company).toBe('');
    });

    test('AC-001-9: 多次使用同一参数（后者覆盖前者）', () => {
      const result = parseArgs(['--company', '1', '--company', '2']);
      expect(result.options.company).toBe('2');
    });
  });

  describe('错误情况', () => {
    test('AC-001-10: 未知参数抛出错误', () => {
      expect(() => parseArgs(['--unknown', 'value'])).toThrow();
    });

    test('AC-001-11: JSON 格式错误抛出错误', () => {
      expect(() => parseArgs(['--format={invalid}'])).toThrow();
    });

    test('AC-001-12: 参数值缺失抛出错误', () => {
      expect(() => parseArgs(['--company'])).toThrow();
    });
  });
});

describe('parseJsonArg', () => {
  test('解析有效 JSON', () => {
    const result = parseJsonArg('{"type":"table","limit":10}');
    expect(result.type).toBe('table');
    expect(result.limit).toBe(10);
  });

  test('解析无效 JSON 抛出错误', () => {
    expect(() => parseJsonArg('{invalid}')).toThrow();
  });
});

describe('parseKeyValueArg', () => {
  test('解析 key=value 格式', () => {
    const result = parseKeyValueArg('company=1');
    expect(result.company).toBe('1');
  });

  test('解析多个 key=value 格式', () => {
    const result = parseKeyValueArg('company=1,user=admin');
    expect(result.company).toBe('1');
    expect(result.user).toBe('admin');
  });

  test('无效格式返回空对象', () => {
    const result = parseKeyValueArg('invalid');
    expect(result).toEqual({});
  });
});