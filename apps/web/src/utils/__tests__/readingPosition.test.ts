// readingPosition 单元测试 — #290（清单 #27）频道阅读位置持久化：序列化/解析纯函数
import { describe, it, expect, beforeEach } from 'vitest';
import {
  serializeReadingPosition,
  parseReadingPosition,
  saveReadingPosition,
  loadReadingPosition,
} from '../readingPosition';

describe('serializeReadingPosition / parseReadingPosition 往返', () => {
  it('锚点存档往返', () => {
    const pos = { mid: 'msg-1', top: -12.5 };
    expect(parseReadingPosition(serializeReadingPosition(pos))).toEqual(pos);
  });

  it('钉底（null）存档往返', () => {
    expect(parseReadingPosition(serializeReadingPosition(null))).toBeNull();
  });
});

describe('parseReadingPosition — 三态语义', () => {
  it('raw 为 null（从未写过）→ undefined（无存档，定位底部）', () => {
    expect(parseReadingPosition(null)).toBeUndefined();
  });

  it('合法锚点 JSON → {mid, top}', () => {
    expect(parseReadingPosition('{"mid":"m9","top":33}')).toEqual({ mid: 'm9', top: 33 });
  });

  it('JSON null → null（钉底存档）', () => {
    expect(parseReadingPosition('null')).toBeNull();
  });

  it('腐化 JSON → undefined（不阻断进入频道）', () => {
    expect(parseReadingPosition('{oops')).toBeUndefined();
  });

  it('形状不符（缺 mid/top、类型错、空 mid、非有限 top）→ undefined', () => {
    expect(parseReadingPosition('{"top":3}')).toBeUndefined();
    expect(parseReadingPosition('{"mid":1,"top":3}')).toBeUndefined();
    expect(parseReadingPosition('{"mid":"","top":3}')).toBeUndefined();
    expect(parseReadingPosition('{"mid":"m","top":"3"}')).toBeUndefined();
    expect(parseReadingPosition('42')).toBeUndefined();
  });
});

describe('粗锚（#326 数据层降级：骨架锚行存档/恢复不做像素级精校正）', () => {
  it('粗锚存档往返（coarse: true 保留）', () => {
    const pos = { mid: 'msg-1', top: -12.5, coarse: true as const };
    expect(parseReadingPosition(serializeReadingPosition(pos))).toEqual(pos);
  });

  it('旧存档无 coarse 字段 → 精锚（coarse 缺省，向后兼容）', () => {
    expect(parseReadingPosition('{"mid":"m9","top":33}')).toEqual({ mid: 'm9', top: 33 });
  });

  it('coarse 非布尔 → 按精锚处理（字段忽略，不阻断）', () => {
    expect(parseReadingPosition('{"mid":"m9","top":33,"coarse":"yes"}')).toEqual({ mid: 'm9', top: 33 });
  });

  it('粗锚 localStorage 写读往返', () => {
    window.localStorage.clear();
    saveReadingPosition('ch-a', { mid: 'm1', top: 8, coarse: true });
    expect(loadReadingPosition('ch-a')).toEqual({ mid: 'm1', top: 8, coarse: true });
  });
});

describe('saveReadingPosition / loadReadingPosition — localStorage 直调（按频道隔离）', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('写读往返', () => {
    saveReadingPosition('ch-a', { mid: 'm1', top: 8 });
    expect(loadReadingPosition('ch-a')).toEqual({ mid: 'm1', top: 8 });
  });

  it('按频道 key 隔离：A 频道存档不影响 B 频道', () => {
    saveReadingPosition('ch-a', { mid: 'm1', top: 8 });
    expect(loadReadingPosition('ch-b')).toBeUndefined();
  });

  it('钉底存 null', () => {
    saveReadingPosition('ch-a', null);
    expect(loadReadingPosition('ch-a')).toBeNull();
  });

  it('覆盖写：后写覆盖先写', () => {
    saveReadingPosition('ch-a', { mid: 'm1', top: 8 });
    saveReadingPosition('ch-a', null);
    expect(loadReadingPosition('ch-a')).toBeNull();
  });
});
